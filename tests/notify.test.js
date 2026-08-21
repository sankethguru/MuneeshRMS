// tests/notify.test.js
// Coverage for the Telegram notification engine. Split in two halves:
//
//   * Pure logic (no db, no network): quiet-hour wrap-around, message
//     splitting/escaping, error classification, digest formatting.
//   * Engine behaviour against a seeded temp database with an injected
//     fake transport: recipient resolution, permission filtering, and
//     the two dedup semantics (digest = once per day, immediate = once
//     per item ever) including the critical property that a FAILED send
//     is never recorded as sent, so the next tick retries it.
//
// Run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const telegram = require('../telegram.js');
const notify = require('../notify.js');

// ---- Pure logic ------------------------------------------------------------

test('isQuietHour handles the wrap-around case (22:00 -> 07:00)', () => {
  // The common configuration wraps midnight; a naive start<=h<end test
  // gets this wrong for exactly the hours people care about.
  assert.strictEqual(notify.isQuietHour(23, 22, 7), true);
  assert.strictEqual(notify.isQuietHour(2, 22, 7), true);
  assert.strictEqual(notify.isQuietHour(6, 22, 7), true);
  assert.strictEqual(notify.isQuietHour(7, 22, 7), false);   // end is exclusive
  assert.strictEqual(notify.isQuietHour(12, 22, 7), false);
  assert.strictEqual(notify.isQuietHour(22, 22, 7), true);   // start is inclusive
});

test('isQuietHour handles the non-wrapping case and the disabled case', () => {
  assert.strictEqual(notify.isQuietHour(3, 1, 5), true);
  assert.strictEqual(notify.isQuietHour(6, 1, 5), false);
  // start === end means "no quiet hours", not "quiet all day" — the
  // latter would silently mute the whole engine.
  assert.strictEqual(notify.isQuietHour(3, 0, 0), false);
  assert.strictEqual(notify.isQuietHour(3, null, undefined), false);
});

test('escapeHtml escapes exactly the three characters Telegram HTML needs', () => {
  assert.strictEqual(telegram.escapeHtml('Tom & Jerry <b>x</b>'), 'Tom &amp; Jerry &lt;b&gt;x&lt;/b&gt;');
  // Characters that MarkdownV2 would require escaping must pass through
  // untouched — that's the whole reason this app uses HTML mode.
  assert.strictEqual(telegram.escapeHtml('Rs.1,20,000 (due 15-Jun) - pay!'), 'Rs.1,20,000 (due 15-Jun) - pay!');
});

test('splitMessage splits on line boundaries and never exceeds the limit', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
  const parts = telegram.splitMessage(lines.join('\n'), 200);
  parts.forEach(p => assert.ok(p.length <= 200, `part too long: ${p.length}`));
  // Nothing lost: every original line still appears somewhere.
  const rejoined = parts.join('\n');
  lines.forEach(l => assert.ok(rejoined.includes(l), `lost line: ${l}`));
});

test('splitMessage hard-splits a single oversize line rather than dropping it', () => {
  const parts = telegram.splitMessage('y'.repeat(500), 100);
  assert.strictEqual(parts.length, 5);
  assert.strictEqual(parts.join('').length, 500);
});

test('classifyError distinguishes the failures a user will actually hit', () => {
  // Bodies here carry `ok`/`description` because that is what a genuine
  // Telegram error response looks like — see the network-blocked test
  // below for why that shape is load-bearing.
  assert.strictEqual(telegram.classifyError(401, { ok: false, description: 'Unauthorized' }).kind, 'bad-token');
  assert.strictEqual(telegram.classifyError(400, { ok: false, description: 'Bad Request: chat not found' }).kind, 'bad-chat');
  assert.strictEqual(telegram.classifyError(403, { ok: false, description: 'bot was blocked' }).kind, 'blocked');
  const rl = telegram.classifyError(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 12 } });
  assert.strictEqual(rl.kind, 'rate-limited');
  assert.strictEqual(rl.retryAfter, 12);
});

test('buildDigest groups by source, ranks critical first, and returns null when empty', () => {
  assert.strictEqual(notify.buildDigest([]), null);
  const items = [
    { sourceKey: 'a', sourceLabel: 'Reminders', urgency: 'info', text: 'low one' },
    { sourceKey: 'a', sourceLabel: 'Reminders', urgency: 'critical', text: 'urgent one' },
    { sourceKey: 'b', sourceLabel: 'Bills', urgency: 'warning', text: 'a bill' },
  ];
  const msg = notify.buildDigest(items, { title: 'Daily summary', dateLabel: '2026-07-26' });
  assert.ok(msg.includes('Daily summary'));
  assert.ok(msg.indexOf('urgent one') < msg.indexOf('low one'), 'critical must sort above info');
  assert.ok(msg.indexOf('Reminders') < msg.indexOf('Bills'));
});

test('buildDigest escapes user-supplied text so a stray < cannot break the message', () => {
  const msg = notify.buildDigest([
    { sourceKey: 'a', sourceLabel: 'A & B', urgency: 'info', text: 'tenant <script>' },
  ], {});
  assert.ok(msg.includes('&lt;script&gt;'));
  assert.ok(msg.includes('A &amp; B'));
});

// ---- Engine against a seeded temp database ---------------------------------
//
// db.js and schema.js resolve their files from __dirname, so these tests
// swap the real data files out and restore them afterwards rather than
// trying to relocate the modules' paths.

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SCHEMA_FILE = path.join(DATA_DIR, 'schema.json');
let backup = {};

function backupReal() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  backup = {
    db: fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : null,
    schema: fs.existsSync(SCHEMA_FILE) ? fs.readFileSync(SCHEMA_FILE) : null,
  };
}
function restoreReal() {
  if (backup.db !== null && backup.db !== undefined) fs.writeFileSync(DB_FILE, backup.db);
  else if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  if (backup.schema !== null && backup.schema !== undefined) fs.writeFileSync(SCHEMA_FILE, backup.schema);
  else if (fs.existsSync(SCHEMA_FILE)) fs.unlinkSync(SCHEMA_FILE);
}
backupReal();
test.after(restoreReal);

// A minimal schema with just the reminders machinery plus the
// notification log, so the reminders-due source has something real to
// collect and everything else reports itself unavailable.
function seed({ sources, groupChats, userChats, digestHour, quietStartHour, quietEndHour, logRows } = {}) {
  const schema = {
    entities: {
      reminders: {
        key: 'reminders', label: 'Reminders', singular: 'Reminder', pk: 'RM_RowID',
        displayField: 'RM_Item', listColumns: ['RM_RowID', 'RM_Item'], fields: [
          { name: 'RM_RowID', type: 'number' }, { name: 'RM_Item', type: 'text' },
          { name: 'RM_Category', type: 'picklist' }, { name: 'RM_Type', type: 'picklist' },
          { name: 'RM_NextDue', type: 'date' }, { name: 'RM_FrequencyMonths', type: 'number' },
          { name: 'RM_LeadDays', type: 'number' }, { name: 'RM_Status', type: 'picklist' },
        ],
      },
      reminder_log: {
        key: 'reminder_log', label: 'Reminder Log', singular: 'Completion', pk: 'RL_RowID',
        listColumns: ['RL_RowID'], fields: [
          { name: 'RL_RowID', type: 'number' }, { name: 'RL_Reminder', type: 'fk', ref: 'reminders' },
          { name: 'RL_DoneDate', type: 'date' }, { name: 'RL_Month', type: 'text' },
        ],
      },
      notification_log: {
        key: 'notification_log', label: 'Notification Log', singular: 'Notification', pk: 'NL_RowID',
        listColumns: ['NL_RowID'], fields: [
          { name: 'NL_RowID', type: 'number' }, { name: 'NL_SentAt', type: 'text' },
          { name: 'NL_Chat', type: 'text' }, { name: 'NL_Recipient', type: 'text' },
          { name: 'NL_Kind', type: 'text' }, { name: 'NL_SourceKey', type: 'text' },
          { name: 'NL_ItemId', type: 'text' }, { name: 'NL_Status', type: 'text' },
          { name: 'NL_Detail', type: 'text' },
        ],
      },
    },
    navOrder: [], adminSubnavOrder: [], reportDefs: [], templates: [], picklists: [],
    homeWidgets: [], screens: [], applets: [], composedViews: [],
    notificationSettings: {
      enabled: true,
      digestHour: digestHour === undefined ? 8 : digestHour,
      quietStartHour: quietStartHour === undefined ? 22 : quietStartHour,
      quietEndHour: quietEndHour === undefined ? 7 : quietEndHour,
      retentionDays: 90,
      groupChats: groupChats || [{ id: 'g1', chatId: '-1001', label: 'Family', asUser: '' }],
      userChats: userChats || {},
      sources: sources || { 'reminders-due': { mode: 'both' } },
    },
  };
  // One overdue reminder so there is always exactly one item to collect.
  const db = {
    reminders: [{
      RM_RowID: 1, RM_Item: 'Passport renewal', RM_Category: 'Documents', RM_Type: 'Date',
      RM_NextDue: '2020-01-01', RM_LeadDays: 30, RM_Status: 'Active',
    }],
    reminder_log: [],
    notification_log: logRows || [],
  };
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2));
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  return { schema, db };
}

// A fake Telegram that records calls and can be told to fail.
function fakeTransport({ failWith } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (failWith) {
        return { ok: false, status: failWith.status, json: async () => failWith.body || {} };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
    },
  };
}

test('engine: a digest goes out at the configured hour and only once that day', async () => {
  seed({ digestHour: 9, sources: { 'reminders-due': { mode: 'digest' } } });
  const t1 = fakeTransport();
  const at9 = new Date(2026, 6, 26, 9, 5);
  const r1 = await notify.runTick({ now: at9, token: 'TESTTOKEN', fetch: t1.fetch });
  assert.strictEqual(r1.sent, 1, 'expected one digest');
  assert.ok(t1.calls[0].body.text.includes('Passport renewal'));

  // Same day, same hour, second tick: dedup must suppress it.
  const t2 = fakeTransport();
  const r2 = await notify.runTick({ now: new Date(2026, 6, 26, 9, 20), token: 'TESTTOKEN', fetch: t2.fetch });
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(t2.calls.length, 0);

  // Next day: a fresh digest is expected — the daily repeat IS the nag.
  const t3 = fakeTransport();
  const r3 = await notify.runTick({ now: new Date(2026, 6, 27, 9, 5), token: 'TESTTOKEN', fetch: t3.fetch });
  assert.strictEqual(r3.sent, 1);
});

test('engine: no digest outside the configured hour', async () => {
  seed({ digestHour: 9, sources: { 'reminders-due': { mode: 'digest' } } });
  const t = fakeTransport();
  const r = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: 'TESTTOKEN', fetch: t.fetch });
  assert.strictEqual(r.sent, 0);
});

test('engine: an immediate alert fires once ever, not once per tick', async () => {
  seed({ digestHour: 9, sources: { 'reminders-due': { mode: 'immediate' } } });
  const t1 = fakeTransport();
  const r1 = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: 'TESTTOKEN', fetch: t1.fetch });
  assert.strictEqual(r1.sent, 1);
  const t2 = fakeTransport();
  const r2 = await notify.runTick({ now: new Date(2026, 6, 26, 14, 15), token: 'TESTTOKEN', fetch: t2.fetch });
  assert.strictEqual(r2.sent, 0, 'the same item must not re-alert');
  // Even days later — an immediate alert is once per item, not per day.
  const t3 = fakeTransport();
  const r3 = await notify.runTick({ now: new Date(2026, 6, 30, 14, 0), token: 'TESTTOKEN', fetch: t3.fetch });
  assert.strictEqual(r3.sent, 0);
});

test('engine: quiet hours suppress immediate alerts but the item is not consumed', async () => {
  seed({ digestHour: 9, quietStartHour: 22, quietEndHour: 7, sources: { 'reminders-due': { mode: 'immediate' } } });
  const t1 = fakeTransport();
  const r1 = await notify.runTick({ now: new Date(2026, 6, 26, 23, 30), token: 'TESTTOKEN', fetch: t1.fetch });
  assert.strictEqual(r1.sent, 0, 'nothing should go out at 23:30');
  // After quiet hours end it must still fire — suppression is a delay,
  // not a silent drop.
  const t2 = fakeTransport();
  const r2 = await notify.runTick({ now: new Date(2026, 6, 27, 8, 0), token: 'TESTTOKEN', fetch: t2.fetch });
  assert.strictEqual(r2.sent, 1);
});

test('engine: a FAILED send is not recorded as sent, so the next tick retries', async () => {
  seed({ digestHour: 9, sources: { 'reminders-due': { mode: 'immediate' } } });
  const bad = fakeTransport({ failWith: { status: 400, body: { description: 'Bad Request: chat not found' } } });
  const r1 = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: 'TESTTOKEN', fetch: bad.fetch });
  assert.strictEqual(r1.sent, 0);
  assert.strictEqual(r1.failed, 1);

  // Chat id fixed / bot re-added: the same item must still be deliverable.
  const good = fakeTransport();
  const r2 = await notify.runTick({ now: new Date(2026, 6, 26, 14, 15), token: 'TESTTOKEN', fetch: good.fetch });
  assert.strictEqual(r2.sent, 1, 'a previously failed item must be retried');
});

test('engine: disabled, or missing token, sends nothing', async () => {
  seed({ sources: { 'reminders-due': { mode: 'immediate' } } });
  const t = fakeTransport();
  const noToken = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: '', fetch: t.fetch });
  assert.strictEqual(noToken.skipped, 'no-transport'); // no Telegram token AND no email channel configured
  assert.strictEqual(t.calls.length, 0);

  const seeded = seed({ sources: { 'reminders-due': { mode: 'immediate' } } });
  seeded.schema.notificationSettings.enabled = false;
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(seeded.schema, null, 2));
  const t2 = fakeTransport();
  const off = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: 'TESTTOKEN', fetch: t2.fetch });
  assert.strictEqual(off.skipped, 'disabled');
  assert.strictEqual(t2.calls.length, 0);
});

test('engine: the email channel delivers to the notify address (email-only, no token)', async () => {
  const s = seed({ sources: { 'reminders-due': { mode: 'immediate' } }, groupChats: [] });
  s.schema.emailSettings = { host: 'smtp.x.com', port: 587, fromAddress: 'billing@x.com', fromName: 'ML', notifyChannel: true, notifyEmailTo: 'owner@x.com' };
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(s.schema, null, 2));
  const box = { calls: [] };
  const stub = { sendMail: async (m) => { box.calls.push(m); return { messageId: 'e' + box.calls.length, accepted: m.to, response: '250 OK' }; } };
  // token:'' => Telegram inactive; the email-only path must still fire.
  const r = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: '', transport: stub });
  assert.strictEqual(r.sent, 1, 'expected one email');
  assert.strictEqual(box.calls.length, 1);
  assert.deepStrictEqual(box.calls[0].to, ['owner@x.com']);
  assert.ok(String(box.calls[0].html).includes('Passport renewal'));
});

test("engine: a source set to 'off' contributes nothing", async () => {
  seed({ digestHour: 9, sources: { 'reminders-due': { mode: 'off' } } });
  const t = fakeTransport();
  const r = await notify.runTick({ now: new Date(2026, 6, 26, 9, 0), token: 'TESTTOKEN', fetch: t.fetch });
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(t.calls.length, 0);
});

test('engine: per-user recipients are dropped when the user no longer exists', async () => {
  // A chat mapped to a deleted user must NOT silently fall back to
  // admin-level visibility — it disappears instead.
  seed({
    groupChats: [],
    userChats: { 'ghost-user-that-does-not-exist': '999' },
    sources: { 'reminders-due': { mode: 'immediate' } },
  });
  const t = fakeTransport();
  const r = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: 'TESTTOKEN', fetch: t.fetch });
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(t.calls.length, 0);
});

test('engine: each recipient is deduped independently', async () => {
  seed({
    groupChats: [
      { id: 'g1', chatId: '-1001', label: 'Family', asUser: '' },
      { id: 'g2', chatId: '-1002', label: 'Accounts', asUser: '' },
    ],
    sources: { 'reminders-due': { mode: 'immediate' } },
  });
  const t = fakeTransport();
  const r = await notify.runTick({ now: new Date(2026, 6, 26, 14, 0), token: 'TESTTOKEN', fetch: t.fetch });
  assert.strictEqual(r.sent, 2, 'both chats get their own copy');
  const chats = t.calls.map(c => String(c.body.chat_id)).sort();
  assert.deepStrictEqual(chats, ['-1001', '-1002']);
});

test('engine: messages are sent with HTML parse mode and previews disabled', async () => {
  seed({ digestHour: 9, sources: { 'reminders-due': { mode: 'digest' } } });
  const t = fakeTransport();
  await notify.runTick({ now: new Date(2026, 6, 26, 9, 0), token: 'TESTTOKEN', fetch: t.fetch });
  assert.strictEqual(t.calls[0].body.parse_mode, 'HTML');
  assert.strictEqual(t.calls[0].body.disable_web_page_preview, true);
});

test('engine: settings migration adds new sources as off, preserving existing choices', () => {
  const schema = { notificationSettings: { enabled: true, sources: { 'reminders-due': { mode: 'both' } } } };
  notify.ensureNotificationSettings(schema);
  const s = schema.notificationSettings;
  // Existing choice untouched...
  assert.strictEqual(s.sources['reminders-due'].mode, 'both');
  // ...every other registered source defaulted to off, so upgrading the
  // app never starts a new stream of messages by surprise.
  Object.keys(notify.SOURCES).forEach(k => {
    assert.ok(s.sources[k], `source ${k} missing after migration`);
    if (k !== 'reminders-due') assert.strictEqual(s.sources[k].mode, 'off', `source ${k} should default to off`);
  });
  // Missing scalars are filled from defaults.
  assert.strictEqual(typeof s.digestHour, 'number');
  assert.strictEqual(typeof s.retentionDays, 'number');
});

test('engine: an invalid stored mode is repaired to off rather than trusted', () => {
  const schema = { notificationSettings: { sources: { 'reminders-due': { mode: 'BOGUS' } } } };
  notify.ensureNotificationSettings(schema);
  assert.strictEqual(schema.notificationSettings.sources['reminders-due'].mode, 'off');
});

test('engine: log retention purges rows older than the cutoff and keeps recent ones', async () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  seed({
    digestHour: 9,
    sources: { 'reminders-due': { mode: 'digest' } },
    logRows: [
      { NL_RowID: 1, NL_SentAt: old, NL_Chat: '-1001', NL_ItemId: 'ancient', NL_Status: 'sent' },
      { NL_RowID: 2, NL_SentAt: recent, NL_Chat: '-1001', NL_ItemId: 'recent', NL_Status: 'sent' },
    ],
  });
  const t = fakeTransport();
  await notify.runTick({ now: new Date(2026, 6, 26, 9, 0), token: 'TESTTOKEN', fetch: t.fetch });
  const after = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).notification_log;
  const ids = after.map(r => r.NL_ItemId);
  assert.ok(!ids.includes('ancient'), 'row past retention should be purged');
  assert.ok(ids.includes('recent'), 'recent row must survive');
});

test('classifyError does not blame Telegram for a proxy/firewall block', () => {
  // An egress proxy returning a bare 403 (no Telegram JSON body) must NOT
  // be reported as "the bot was removed from that chat" — that sends the
  // user to re-add a bot when their real problem is network egress.
  const proxy403 = telegram.classifyError(403, null);
  assert.strictEqual(proxy403.kind, 'network-blocked');
  assert.match(proxy403.message, /proxy, firewall, or DNS/);

  // A genuine Telegram 403 still classifies as a blocked bot.
  const real403 = telegram.classifyError(403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
  assert.strictEqual(real403.kind, 'blocked');

  // Same distinction for 401: a proxy 401 is not a bad token.
  assert.strictEqual(telegram.classifyError(401, null).kind, 'network-blocked');
  assert.strictEqual(telegram.classifyError(401, { ok: false, description: 'Unauthorized' }).kind, 'bad-token');
});
