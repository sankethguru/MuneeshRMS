// notify.js
//
// Configurable notification engine. Everything about WHAT gets sent,
// WHEN, and TO WHOM is admin-configurable (Admin -> Notifications);
// nothing about the event set is hardcoded at the call site.
//
// Two decisions shape this whole module:
//
//  1. It NEVER recomputes "what is due". Every event source delegates to
//     the same compute* function the Home screen widgets already use, so
//     a notification can never disagree with what the dashboard shows,
//     and a fix to due-logic lands in both at once. Those functions are
//     already permission-aware and already degrade to { available:false }
//     on a schema that lacks the tables, which is exactly the contract a
//     notification source needs.
//
//  2. Collection is synchronous and happens INSIDE a request cache;
//     sending is async and happens OUTSIDE it. Holding a data snapshot
//     open across network I/O would mean a tick that takes 30 seconds to
//     deliver is reading 30-second-stale data by the end, and any write
//     during that window (the log rows we write ourselves) would be
//     fighting the snapshot. Collect -> plan -> send -> log is the shape.
//
// Delivery styles, per event source, chosen by the admin:
//   off       - never
//   digest    - included in the once-a-day summary at the configured hour
//   immediate - sent on its own as soon as a tick first sees it
//   both      - both of the above
//
// Dedup semantics differ between the two, deliberately:
//   * A DIGEST is a daily snapshot. It re-lists everything still
//     outstanding every day — that repetition IS the nagging mechanism.
//     Deduped once per recipient per day.
//   * An IMMEDIATE alert fires once per item, ever, per recipient. Its
//     dedup id encodes the period where a fresh alert is wanted (a
//     monthly checklist reminder's id contains the month), so "once
//     ever" doesn't mean "once in your life" for recurring things.

const schemaLib = require('./schema');
const db = require('./db');
const usersLib = require('./users');
const errorlog = require('./errorlog');
const secrets = require('./secrets');
const telegram = require('./telegram');
const mailer = require('./mailer');
const home = require('./home');

const LOG = 'notification_log';

const MODES = ['off', 'digest', 'immediate', 'both'];
const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 min: fine enough for "immediate", cheap enough to ignore
// Home widgets cap their row lists at 8 for layout. Notifications must
// see everything outstanding — an alert that silently skipped the 9th
// overdue item would be worse than no alert at all.
const NO_LIMIT = 100000;

// ---- Settings --------------------------------------------------------------

function defaultSettings() {
  return {
    enabled: false,
    digestHour: 8,
    quietStartHour: 22,
    quietEndHour: 7,
    retentionDays: 90,
    groupChats: [],   // [{ id, chatId, label, asUser }]
    userChats: {},    // { username: chatId }
    sources: {},      // { sourceKey: { mode } }
  };
}

// Idempotent: fills in anything missing without clobbering what's set,
// so a new event source added in a later version defaults to 'off'
// rather than surprising a family with a new stream of messages.
function ensureNotificationSettings(schema) {
  let changed = false;
  if (!schema.notificationSettings) { schema.notificationSettings = defaultSettings(); changed = true; }
  const s = schema.notificationSettings;
  const d = defaultSettings();
  Object.keys(d).forEach(k => {
    if (s[k] === undefined) { s[k] = d[k]; changed = true; }
  });
  if (!s.sources || typeof s.sources !== 'object') { s.sources = {}; changed = true; }
  Object.keys(SOURCES).forEach(key => {
    if (!s.sources[key]) { s.sources[key] = { mode: 'off' }; changed = true; }
    else if (!MODES.includes(s.sources[key].mode)) { s.sources[key].mode = 'off'; changed = true; }
  });
  return changed;
}

function ensureNotificationTables() {
  const schema = schemaLib.load();
  let changed = false;
  if (!schema.entities[LOG]) { addLogTable(schema); changed = true; }
  if (ensureNotificationSettings(schema)) changed = true;
  if (changed) schemaLib.persist(schema);
  return changed;
}

function addLogTable(schema) {
  schemaLib.addEntity(schema, { key: LOG, label: 'Notification Log', singular: 'Notification', pkName: 'NL_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, LOG, spec);
  add({ name: 'NL_SentAt', label: 'Sent At', type: 'text', inList: true });
  add({ name: 'NL_Chat', label: 'Chat ID', type: 'text', inList: true });
  add({ name: 'NL_Recipient', label: 'Recipient', type: 'text', inList: true });
  add({ name: 'NL_Kind', label: 'Kind', type: 'text', inList: true });
  add({ name: 'NL_SourceKey', label: 'Source', type: 'text', inList: true });
  add({ name: 'NL_ItemId', label: 'Item Key', type: 'text' });
  add({ name: 'NL_Status', label: 'Status', type: 'text', inList: true });
  add({ name: 'NL_Detail', label: 'Detail', type: 'text', inList: true });
  const e = schema.entities[LOG];
  e.listColumns = ['NL_RowID', 'NL_SentAt', 'NL_Recipient', 'NL_Kind', 'NL_SourceKey', 'NL_Status', 'NL_Detail'];
  e.filterFields = ['NL_Kind', 'NL_SourceKey', 'NL_Status'];
  e.sortField = 'NL_SentAt';
  e.sortDir = 'desc';
  // Delivery history is a diagnostic, not a nav destination — reachable
  // from the Notifications admin page and by URL, like reminder_log.
  schemaLib.removeNav(schema, LOG);
}

// ---- Event source registry -------------------------------------------------
//
// Each source turns one existing Home-widget computation into a list of
// notification items:
//   { id, urgency, text }
// `id` MUST be stable for "the same real-world situation" and MUST change
// when a fresh alert is warranted — that single property is what makes
// immediate-mode dedup correct without any extra state.
// `urgency` is 'critical' | 'warning' | 'info', used only for the emoji
// and ordering; it deliberately does not gate delivery, because "which
// events matter" is the admin's call, not this file's.

const SOURCES = {
  'reminders-due': {
    label: 'Reminders due or overdue',
    description: 'Passport/licence renewals, servicing, monthly checklists — from the Reminders board.',
    collect(schema, user) {
      // includeEmpty: a family with nothing overdue should read as
      // "0 outstanding", not "unavailable".
      const r = home.computeDueSoon(schema, user, NO_LIMIT, true);
      if (!r.available) return { available: false, reason: r.reason };
      const items = r.panel.items.map(b => ({
        // The due date is part of the identity: rescheduling a reminder
        // legitimately warrants a fresh alert, staying overdue does not.
        id: `reminder:${b.reminder.RM_RowID}:${b.reminder.RM_NextDue || b.status.month || 'na'}:${b.status.state}`,
        urgency: b.status.state === 'overdue' ? 'critical' : 'warning',
        text: `${b.reminder.RM_Item} — ${b.status.detail || b.status.state}`,
      }));
      return { available: true, items };
    },
  },

  'rent-unpaid': {
    label: 'Rent not yet received this month',
    description: 'Count and value of this calendar month\u2019s invoices with no rent recorded against them.',
    collect(schema, user) {
      const r = home.computeRentStatus(schema, user);
      if (!r.available) return { available: false, reason: r.reason };
      if (!r.pendingCount) return { available: true, items: [] };
      const outstanding = r.totalAmount - r.receivedAmount;
      return { available: true, items: [{
        // One item per month: the alert fires once when the month's
        // shortfall first appears, and the daily digest keeps showing
        // the live figure until it clears.
        id: `rent-unpaid:${r.ym}`,
        urgency: 'warning',
        text: `${r.pendingCount} of ${r.total} invoice(s) unpaid for ${r.ym} — ${formatInr(outstanding)} outstanding`,
      }] };
    },
  },

  'bills-due': {
    label: 'Recurring bills with no entry this month',
    description: 'Active expense items from the Bills matrix that have no amount recorded for the current month.',
    collect(schema, user) {
      const r = home.computeBillsDue(schema, user);
      if (!r.available) return { available: false, reason: r.reason };
      const items = (r.due || []).map(d => ({
        id: `bill:${d.label}:${r.ym}`,
        urgency: 'info',
        text: `${d.label} (${d.category}) — nothing recorded for ${r.ym}`,
      }));
      return { available: true, items };
    },
  },

  'cc-bills-due': {
    label: 'Credit card bills outstanding',
    description: 'Statements from the CC tracker where the amount paid is still short of the amount billed.',
    collect(schema, user) {
      const r = home.computeCcBillsDue(schema, user, NO_LIMIT);
      if (!r.available) return { available: false, reason: r.reason };
      const items = (r.rows || []).map(row => ({
        id: `cc:${row.card}:${row.billDate}`,
        urgency: 'warning',
        text: `${row.card || 'Card'} — ${formatInr(row.outstanding)} outstanding (statement ${row.billDate || 'n/a'})`,
      }));
      return { available: true, items };
    },
  },

  'uncleared-cheques': {
    label: 'Cheques issued but not cleared',
    description: 'Cheques still showing uncleared in the cheque register.',
    collect(schema, user) {
      // NO_LIMIT: the widget caps at 8 rows for layout; an alert that
      // silently ignored the 9th uncleared cheque would be a bug.
      const r = home.computeUnclearedCheques(schema, user, NO_LIMIT);
      if (!r.available) return { available: false, reason: r.reason };
      const e = schema.entities['cheques'];
      const pk = e ? e.pk : 'CHQ_RowID';
      // rows are raw cheque records, so read the real field names.
      const items = (r.rows || []).map(row => ({
        id: `cheque:${row[pk]}`,
        urgency: 'info',
        text: `Cheque ${row.CHQ_Number || row[pk]} — ${formatInr(row.CHQ_Amt || 0)}${row.CHQ_Date ? ' dated ' + row.CHQ_Date : ''} still uncleared`,
      }));
      return { available: true, items };
    },
  },

  'advance-tax-due': {
    label: 'Advance tax installment shortfall',
    description: 'Projections whose next s.211 installment is not fully paid.',
    collect(schema, user) {
      const r = home.computeAdvanceTaxNextDue(schema, user);
      if (!r.available) return { available: false, reason: r.reason };
      const items = (r.rows || []).map(row => ({
        // Installment label carries the quarter and year, so each
        // installment alerts once per projection per FY.
        id: `advtax:${row.id}:${row.fy}:${row.installment}`,
        urgency: 'critical',
        text: `${row.landlord} (FY ${row.fy}) — ${row.installment}: ${formatInr(row.shortfall)} short`,
      }));
      return { available: true, items };
    },
  },

  'tax-alerts': {
    label: 'Tax alerts (missing worksheets / balances due)',
    description: 'Landlord groups with no tax worksheet for the current FY, and worksheets with a balance still payable.',
    collect(schema, user) {
      const r = home.computeTaxAlerts(schema, user);
      if (!r.available) return { available: false, reason: r.reason };
      const items = [];
      // Two genuinely different alerts share this source because they
      // share the widget: a group with no worksheet at all for the FY,
      // and a worksheet whose balance is still unpaid. Both ids are
      // scoped by FY, so each recurs once per financial year.
      (r.missingGroups || []).forEach(g => {
        items.push({
          id: `taxalert:missing:${g.root}:${r.fy}`,
          urgency: 'warning',
          text: `${g.root} — no tax worksheet for FY ${r.fy} yet`,
        });
      });
      (r.shortfalls || []).forEach(s => {
        items.push({
          id: `taxalert:balance:${s.worksheetId}:${r.fy}`,
          urgency: 'critical',
          text: `${s.groupRoot} (FY ${r.fy}) — ${formatInr(s.balance)} still payable`,
        });
      });
      return { available: true, items };
    },
  },

  'leases-expiring': {
    label: 'Leases expiring soon',
    description: 'Active tenants whose lease (T_Expiry) is within the next 90 days.',
    collect(schema, user) {
      const t = schema.entities['tenants'];
      if (!t) return { available: false, reason: 'no tenants table' };
      if (!t.fields.some(f => f.name === 'T_Expiry')) return { available: false, reason: 'no T_Expiry field' };
      if (!usersLib.can(user, 'tenants', 'read')) return { available: false, reason: 'no permission' };
      const now = new Date();
      const cutoff = new Date(now.getTime() + 90 * 86400000);
      const items = db.getAll('tenants').filter(r => {
        if (r.__deletedAt) return false;
        const active = r.T_Active !== undefined ? r.T_Active : (r.T_IsCurrent !== undefined ? r.T_IsCurrent : true);
        if (!active) return false;
        const exp = r.T_Expiry;
        if (!exp) return false;
        const d = new Date(exp);
        return d >= now && d <= cutoff;
      }).map(r => {
        const expDate = new Date(r.T_Expiry);
        const daysLeft = Math.ceil((expDate - now) / 86400000);
        const display = schemaLib.display(t, r);
        return {
          id: 'lease:' + r[t.pk],
          urgency: daysLeft <= 30 ? 'critical' : 'warning',
          text: display + ' \u2014 lease expires in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' (' + r.T_Expiry + ')',
        };
      });
      return { available: true, items };
    },
  },
};

function formatInr(n) {
  const v = Math.round(Number(n) || 0);
  return '\u20b9' + Math.abs(v).toLocaleString('en-IN') + (v < 0 ? ' (cr)' : '');
}

// ---- Time helpers ----------------------------------------------------------

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Quiet hours wrap midnight in the common case (22:00 -> 07:00), so a
// naive start <= h < end test is wrong half the time.
function isQuietHour(hour, startHour, endHour) {
  const s = Number(startHour), e = Number(endHour);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e;
}

// ---- Recipients ------------------------------------------------------------
//
// A group chat has no logged-in user, so it needs an explicit identity to
// borrow permissions from. Leaving asUser blank means "show everything"
// — legitimate for a private family group, but the Admin page says so out
// loud rather than letting it be an accident.

function resolveRecipients(schema, settings) {
  const out = [];
  (settings.groupChats || []).forEach(g => {
    if (!g || !g.chatId) return;
    let user = null;
    if (g.asUser) user = usersLib.getByUsername(g.asUser) || null;
    out.push({
      kind: 'group',
      chatId: String(g.chatId),
      label: g.label || `Group ${g.chatId}`,
      user: user || { username: g.asUser || '(group)', isAdmin: !g.asUser, permissions: {} },
      unfiltered: !g.asUser,
    });
  });
  Object.entries(settings.userChats || {}).forEach(([username, chatId]) => {
    if (!chatId) return;
    const user = usersLib.getByUsername(username);
    // A chat mapped to a user who has since been deleted must not fall
    // back to admin-level visibility — skip it entirely.
    if (!user) return;
    out.push({ kind: 'user', chatId: String(chatId), label: username, user, unfiltered: false });
  });
  // Layer 3: email as a channel. When enabled + configured, the notify
  // address is just another recipient — it reuses the same dedup (keyed on
  // this synthetic chatId), digest/immediate planning, and log. Unfiltered
  // like a group: the owner who set it wants all enabled sources.
  const em = schema.emailSettings || {};
  const notifyAddr = String(em.notifyEmailTo || '').trim();
  if (em.notifyChannel && notifyAddr && mailer.isConfigured(em)) {
    out.push({
      kind: 'group', channel: 'email', address: notifyAddr,
      chatId: 'email:' + notifyAddr,
      label: notifyAddr,
      user: { username: '(email)', isAdmin: true, permissions: {} },
      unfiltered: true,
    });
  }
  return out;
}

// ---- Collection ------------------------------------------------------------

// Returns { bySource: { key: { label, mode, available, reason, items } },
//           digestItems: [...], immediateItems: [...] }
// for ONE recipient. Pure w.r.t. the network; must run inside a request
// cache because the compute* functions read the database.
function collectForRecipient(schema, settings, recipient) {
  const bySource = {};
  const digestItems = [];
  const immediateItems = [];
  Object.entries(SOURCES).forEach(([key, source]) => {
    const cfg = (settings.sources || {})[key] || { mode: 'off' };
    if (cfg.mode === 'off') return;
    let result;
    try {
      result = source.collect(schema, recipient.user);
    } catch (err) {
      // A broken source must not take down the whole tick for every
      // other source and recipient.
      result = { available: false, reason: `source error: ${err && err.message ? err.message : err}` };
    }
    bySource[key] = { label: source.label, mode: cfg.mode, available: !!result.available, reason: result.reason, items: result.items || [] };
    if (!result.available || !result.items || result.items.length === 0) return;
    const tagged = result.items.map(it => ({ ...it, sourceKey: key, sourceLabel: source.label }));
    if (cfg.mode === 'digest' || cfg.mode === 'both') digestItems.push(...tagged);
    if (cfg.mode === 'immediate' || cfg.mode === 'both') immediateItems.push(...tagged);
  });
  return { bySource, digestItems, immediateItems };
}

// ---- Dedup log -------------------------------------------------------------

function logEntity(schema) {
  return schema.entities[LOG];
}

function alreadySent(schema, chatId, itemId) {
  const e = logEntity(schema);
  if (!e) return false;
  return db.getAll(LOG).some(r => String(r.NL_Chat) === String(chatId) && r.NL_ItemId === itemId && r.NL_Status === 'sent');
}

function recordLog(schema, { chatId, recipient, kind, sourceKey, itemId, status, detail }) {
  const e = logEntity(schema);
  if (!e) return;
  db.insert(LOG, {
    [e.pk]: db.nextAutoId(LOG, e.pk),
    NL_SentAt: new Date().toISOString(),
    NL_Chat: String(chatId),
    NL_Recipient: recipient || '',
    NL_Kind: kind,
    NL_SourceKey: sourceKey || '',
    NL_ItemId: itemId || '',
    NL_Status: status,
    NL_Detail: detail || '',
  });
}

function purgeOldLogs(schema, retentionDays) {
  const e = logEntity(schema);
  if (!e) return 0;
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  // One filtered write, not a remove()-per-row loop. Hard remove: this is
  // machine-generated telemetry, not user data someone wants back from Trash.
  return db.removeWhere(LOG, r => r.NL_SentAt && r.NL_SentAt < cutoff);
}

// ---- Message building ------------------------------------------------------

const URGENCY_ICON = { critical: '\u{1F534}', warning: '\u{1F7E0}', info: '\u{1F535}' };
const URGENCY_RANK = { critical: 0, warning: 1, info: 2 };

const esc = telegram.escapeHtml;

function buildDigest(items, opts) {
  const o = opts || {};
  const title = o.title || 'Daily summary';
  if (items.length === 0) return null; // nothing to say — say nothing
  const groups = {};
  items.forEach(it => { (groups[it.sourceKey] = groups[it.sourceKey] || { label: it.sourceLabel, items: [] }).items.push(it); });
  const lines = [`<b>${esc(title)}</b>`, `<i>${esc(o.dateLabel || ymd(new Date()))}</i>`, ''];
  Object.values(groups).forEach(g => {
    lines.push(`<b>${esc(g.label)}</b>`);
    g.items
      .slice()
      .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3))
      .forEach(it => lines.push(`${URGENCY_ICON[it.urgency] || '\u2022'} ${esc(it.text)}`));
    lines.push('');
  });
  if (o.footer) lines.push(`<i>${esc(o.footer)}</i>`);
  return lines.join('\n').trim();
}

function buildImmediate(item) {
  return `${URGENCY_ICON[item.urgency] || '\u2022'} <b>${esc(item.sourceLabel)}</b>\n${esc(item.text)}`;
}

// ---- The tick --------------------------------------------------------------
//
// Split into plan (sync, cached, reads data) and deliver (async, network)
// so no snapshot is held open across I/O — see the module header.

function planTick(schema, settings, now) {
  const hour = now.getHours();
  const today = ymd(now);
  const quiet = isQuietHour(hour, settings.quietStartHour, settings.quietEndHour);
  const recipients = resolveRecipients(schema, settings);
  const plan = [];

  recipients.forEach(recipient => {
    const collected = collectForRecipient(schema, settings, recipient);

    // Digest: at the configured hour, once per recipient per day. Quiet
    // hours deliberately do NOT suppress it — the admin picked that hour
    // on purpose, and silently skipping the summary they asked for at
    // 07:00 because quiet hours end at 07:00 would be surprising.
    if (Number(settings.digestHour) === hour) {
      const digestId = `digest:${today}`;
      if (!alreadySent(schema, recipient.chatId, digestId) && collected.digestItems.length > 0) {
        plan.push({
          recipient, kind: 'digest', itemId: digestId, sourceKey: '',
          text: buildDigest(collected.digestItems, {
            title: recipient.kind === 'group' ? `${recipient.label} — daily summary` : 'Daily summary',
            dateLabel: today,
            footer: recipient.unfiltered ? 'This group receives all enabled alerts (no permission filter).' : '',
          }),
          summary: `${collected.digestItems.length} item(s)`,
        });
      }
    }

    // Immediate: any item this chat has never been alerted about.
    if (!quiet) {
      collected.immediateItems.forEach(item => {
        if (alreadySent(schema, recipient.chatId, item.id)) return;
        plan.push({
          recipient, kind: 'immediate', itemId: item.id, sourceKey: item.sourceKey,
          text: buildImmediate(item),
          summary: item.text,
        });
      });
    }
  });

  return { plan, quiet, hour };
}

async function deliverPlan(plan, token, deps, emailSettings) {
  const results = [];
  for (const p of plan) {
    if (!p.text) continue;
    let r;
    if (p.recipient.channel === 'email') {
      // The plan text is Telegram-flavoured HTML (<b>…</b> with \n); adapt
      // it to an email: \n -> <br> for the HTML part, tags stripped for the
      // plain-text alternative. Subject reflects digest vs immediate.
      const html = String(p.text).replace(/\n/g, '<br>');
      const text = String(p.text).replace(/<[^>]+>/g, '');
      const subject = 'Muneesh Legacy \u2014 ' + (p.kind === 'digest' ? 'daily summary' : 'alert');
      r = await mailer.sendMail(emailSettings || {}, { to: p.recipient.address, subject, html, text }, deps);
    } else {
      r = await telegram.sendMessage(token, p.recipient.chatId, p.text, deps);
    }
    results.push({ ...p, ok: r.ok, error: r.ok ? null : r.error });
    if (!r.ok && r.error && r.error.kind === 'rate-limited') {
      break;
    }
  }
  return results;
}

async function runTick(deps) {
  const d = deps || {};
  const now = d.now ? new Date(d.now) : new Date();
  const token = d.token !== undefined ? d.token : secrets.getTelegramToken();

  // Plan inside a cache; nothing is written here.
  const planning = db.runWithRequestCache(() => {
    const schema = schemaLib.load();
    const settings = schema.notificationSettings || defaultSettings();
    if (!settings.enabled) return { skip: 'disabled' };
    // A tick is worth running if EITHER channel can deliver: a Telegram
    // token, or a configured email notify-channel. (Email-only setups have
    // no token but must still fire.)
    const em = schema.emailSettings || {};
    const emailActive = !!(em.notifyChannel && String(em.notifyEmailTo || '').trim() && mailer.isConfigured(em));
    if (!token && !emailActive) return { skip: 'no-transport' };
    if (!schema.entities[LOG]) return { skip: 'no-log-table' };
    return { schemaLoaded: true, settings, emailSettings: em, ...planTick(schema, settings, now) };
  });

  if (planning.skip) return { sent: 0, failed: 0, skipped: planning.skip };

  const results = await deliverPlan(planning.plan, token, d, planning.emailSettings);

  // Log outside the planning snapshot, each write in its own scope so it
  // sees (and contributes to) current data.
  let sent = 0, failed = 0;
  db.runWithRequestCache(() => {
    const schema = schemaLib.load();
    results.forEach(r => {
      const status = r.ok ? 'sent' : 'failed';
      if (r.ok) sent += 1; else failed += 1;
      recordLog(schema, {
        chatId: r.recipient.chatId, recipient: r.recipient.label, kind: r.kind,
        sourceKey: r.sourceKey, itemId: r.itemId, status,
        detail: r.ok ? r.summary : (r.error && r.error.message) || 'send failed',
      });
    });
    purgeOldLogs(schema, planning.settings.retentionDays);
  });

  if (failed > 0) {
    const firstErr = results.find(r => !r.ok);
    errorlog.record({
      method: 'NOTIFY', url: '/notify/tick', user: 'system',
      err: new Error(`Telegram delivery failed for ${failed} message(s): ${(firstErr && firstErr.error && firstErr.error.message) || 'unknown'}`),
    });
  }
  return { sent, failed, skipped: null, planned: planning.plan.length };
}

// ---- Scheduler -------------------------------------------------------------

let timer = null;

function start(deps) {
  if (timer) return;
  const tick = () => {
    runTick(deps).catch(err => {
      errorlog.record({ method: 'NOTIFY', url: '/notify/tick', user: 'system', err });
    });
  };
  // No immediate tick on boot: a container restart loop would otherwise
  // fire a burst of alerts. First check happens one interval in.
  timer = setInterval(tick, TICK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

// ---- Admin helpers ---------------------------------------------------------

// "Send test message" — bypasses every enable/quiet/dedup rule on
// purpose, because its entire job is proving the token + chat id work.
async function sendTest(chatId, deps) {
  const token = (deps && deps.token !== undefined) ? deps.token : secrets.getTelegramToken();
  if (!token) return { ok: false, error: { kind: 'no-token', message: 'No bot token configured.' } };
  const text = `\u2705 <b>Muneesh Legacy</b>\nTest message — notifications are wired up correctly.\n<i>${esc(new Date().toLocaleString())}</i>`;
  const r = await telegram.sendMessage(token, chatId, text, deps);
  db.runWithRequestCache(() => {
    const schema = schemaLib.load();
    recordLog(schema, {
      chatId, recipient: 'test', kind: 'test', sourceKey: '', itemId: `test:${Date.now()}`,
      status: r.ok ? 'sent' : 'failed', detail: r.ok ? 'test message' : (r.error && r.error.message) || 'failed',
    });
  });
  return r;
}

// Dry-run for the Admin page: what WOULD go out right now, without
// sending or logging anything. Makes the config understandable before
// the family starts receiving messages.
function previewForAdmin(schema, settings, now) {
  const s = settings || schema.notificationSettings || defaultSettings();
  const recipients = resolveRecipients(schema, s);
  return recipients.map(recipient => {
    const collected = collectForRecipient(schema, s, recipient);
    return {
      recipient: { kind: recipient.kind, label: recipient.label, chatId: recipient.chatId, unfiltered: recipient.unfiltered },
      bySource: collected.bySource,
      digestPreview: buildDigest(collected.digestItems, { title: 'Daily summary', dateLabel: ymd(now || new Date()) }),
      immediateCount: collected.immediateItems.length,
    };
  });
}

module.exports = {
  LOG, MODES, SOURCES, TICK_INTERVAL_MS,
  defaultSettings, ensureNotificationSettings, ensureNotificationTables,
  isQuietHour, ymd, resolveRecipients, collectForRecipient,
  buildDigest, buildImmediate, planTick, deliverPlan, runTick,
  alreadySent, recordLog, purgeOldLogs,
  start, stop, sendTest, previewForAdmin,
};
