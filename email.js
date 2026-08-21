// email.js
//
// The email feature's orchestration layer (the counterpart to notify.js).
// mailer.js is the raw transport; this module owns:
//   - the email_log table (audit of every send)
//   - resolving an email template against a real record (merge tags ->
//     concrete To/Cc/Bcc/Subject/Body, all still editable in the preview)
//   - the send pipeline: resolve (or take the preview's edited values) ->
//     mailer.sendMail(emailSettings) -> write email_log.
//
// Email templates live in the normal template library (baseKind:'email'),
// so there is no separate "email action" concept — a template bound to an
// entity IS the send unit, and every record of that entity offers a button
// per bound template. Nothing about which fields hold the recipient/subject
// is hardcoded; it all comes from the admin-authored merge tags.

const schemaLib = require('./schema');
const db = require('./db');
const mailer = require('./mailer');
const secrets = require('./secrets');

const LOG = 'email_log';
const DAY_MS = 86400000;

// #3: the table only ever needs creating once per process. A module flag
// makes ensureEmailTables() a no-op after the first success, so it isn't
// doing a schemaLib.load() on every single log write (a hot path).
let tablesEnsured = false;
// #1: throttle so the retention purge runs at most once a day even though
// it's triggered opportunistically from the (frequent) log-write path.
let lastPurgeAt = 0;

function ensureEmailTables() {
  if (tablesEnsured) return false;
  const schema = schemaLib.load();
  if (schema.entities[LOG]) { tablesEnsured = true; return false; }
  schemaLib.addEntity(schema, { key: LOG, label: 'Email Log', singular: 'Email', pkName: 'EM_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, LOG, spec);
  add({ name: 'EM_SentAt', label: 'Sent At', type: 'text', inList: true });
  add({ name: 'EM_To', label: 'To', type: 'text', inList: true });
  add({ name: 'EM_Subject', label: 'Subject', type: 'text', inList: true });
  add({ name: 'EM_Kind', label: 'Kind', type: 'text', inList: true });          // 'template' | 'notification' | 'test'
  add({ name: 'EM_SourceEntity', label: 'Source Table', type: 'text', inList: true });
  add({ name: 'EM_SourceId', label: 'Source Record', type: 'text', inList: true });
  add({ name: 'EM_TemplateKey', label: 'Template', type: 'text' });
  add({ name: 'EM_Status', label: 'Status', type: 'text', inList: true });       // 'sent' | 'failed'
  add({ name: 'EM_Detail', label: 'Detail', type: 'text', inList: true });
  add({ name: 'EM_By', label: 'Sent By', type: 'text', inList: true });
  const e = schema.entities[LOG];
  e.listColumns = ['EM_RowID', 'EM_SentAt', 'EM_To', 'EM_Subject', 'EM_Kind', 'EM_Status', 'EM_Detail'];
  e.filterFields = ['EM_Kind', 'EM_Status', 'EM_SourceEntity'];
  e.sortField = 'EM_SentAt';
  e.sortDir = 'desc';
  schemaLib.removeNav(schema, LOG); // diagnostic, reached from Email Settings / by URL
  schemaLib.persist(schema);
  tablesEnsured = true;
  return true;
}

// #1: retention purge for email_log. Mirrors notify's purge; retention is
// emailSettings.logRetentionDays (default 90). One filtered write via
// db.removeWhere. Callable directly (boot) and via maybePurge (throttled,
// from the write path) so it still runs on a server that never restarts.
function purgeOldLogs(schema) {
  if (!(schema && schema.entities && schema.entities[LOG])) return 0;
  const raw = Number((schema.emailSettings || {}).logRetentionDays);
  const days = Number.isFinite(raw) && raw > 0 ? raw : 90;
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  return db.removeWhere(LOG, r => r.EM_SentAt && r.EM_SentAt < cutoff);
}

function maybePurge() {
  const now = Date.now();
  if (now - lastPurgeAt < DAY_MS) return;   // at most once per day
  lastPurgeAt = now;
  try { purgeOldLogs(schemaLib.load()); } catch (e) { /* never break a send */ }
}

function logEmail(row) {
  try {
    ensureEmailTables();
    db.insert(LOG, {
      EM_SentAt: new Date().toISOString(),
      EM_To: row.to || '',
      EM_Subject: row.subject || '',
      EM_Kind: row.kind || 'template',
      EM_SourceEntity: row.sourceEntity || '',
      EM_SourceId: row.sourceId != null ? String(row.sourceId) : '',
      EM_TemplateKey: row.templateKey || '',
      EM_Status: row.status || '',
      EM_Detail: (row.detail || '').slice(0, 500),
      EM_By: row.by || '',
    });
    maybePurge(); // #1: opportunistic, throttled to once/day
  } catch (e) { /* logging must never break a send path */ }
}

// Resolve an email template against one record -> editable draft.
// Returns { ok, to, cc, bcc, subject, html } or { ok:false, error }.
function resolveDraft(schema, template, record) {
  const entity = schema.entities[template.baseTable];
  if (!entity) return { ok: false, error: `Base table "${template.baseTable}" no longer exists.` };
  const to = schemaLib.mergeFieldTagsPlain(schema, entity, record, template.emailTo || '');
  const cc = schemaLib.mergeFieldTagsPlain(schema, entity, record, template.emailCc || '');
  const bcc = schemaLib.mergeFieldTagsPlain(schema, entity, record, template.emailBcc || '');
  const subject = schemaLib.mergeFieldTagsPlain(schema, entity, record, template.emailSubject || '');
  const rendered = schemaLib.renderBillTemplate(schema, template, record); // HTML body, {{#each}} aware
  if (rendered && rendered.error) return { ok: false, error: rendered.error };
  const html = typeof rendered === 'string' ? rendered : (rendered && rendered.html) || '';
  return { ok: true, to, cc, bcc, subject, html };
}

// Send. `message` is the (possibly preview-edited) { to, cc, bcc, subject,
// html }. Writes email_log either way. deps.transport lets tests inject a
// stub. Returns the mailer result ({ ok, messageId } | { ok:false, error }).
// #4: guard against an accidental duplicate send (double-click that beats the
// client button-disable, a double POST, a network retry). Keyed on the send's
// identity; a repeat within the window is rejected without hitting the
// transport. In-memory only — process-local is enough for a single-node app,
// and losing the guard on restart is harmless.
const DEDUP_WINDOW_MS = 15000;
const recentSends = new Map();
function sendKey(message, meta) {
  const to = Array.isArray(message.to) ? message.to.join(',') : (message.to || '');
  return [meta && meta.kind, meta && meta.sourceEntity, meta && meta.sourceId, meta && meta.templateKey, to, message.subject].join('|');
}
function isDuplicate(key) {
  const now = Date.now();
  // Opportunistic sweep so the map can't grow unbounded.
  for (const [k, ts] of recentSends) { if (now - ts > DEDUP_WINDOW_MS) recentSends.delete(k); }
  const prev = recentSends.get(key);
  recentSends.set(key, now);
  return prev !== undefined && (now - prev) < DEDUP_WINDOW_MS;
}

async function send(schema, message, meta, deps) {
  const settings = schema.emailSettings || {};
  if (isDuplicate(sendKey(message, meta))) {
    return { ok: false, error: new Error('This looks like a duplicate send (the same email was just sent moments ago). Not sent again.') };
  }
  const result = await mailer.sendMail(settings, message, deps);
  logEmail({
    to: Array.isArray(message.to) ? message.to.join(', ') : message.to,
    subject: message.subject,
    kind: (meta && meta.kind) || 'template',
    sourceEntity: meta && meta.sourceEntity,
    sourceId: meta && meta.sourceId,
    templateKey: meta && meta.templateKey,
    status: result.ok ? 'sent' : 'failed',
    detail: result.ok ? (result.response || 'sent') : (result.error && result.error.message) || 'failed',
    by: meta && meta.by,
  });
  return result;
}

// Is email usable at all right now?
function isConfigured(schema) {
  return mailer.isConfigured((schema || {}).emailSettings) ;
}

module.exports = { LOG, ensureEmailTables, logEmail, resolveDraft, send, isConfigured, purgeOldLogs };
