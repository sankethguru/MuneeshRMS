// reminders.js
//
// The "Reminders" mini-app — replacement for the Excel "Reminders" tab,
// which mixed three genuinely different patterns in one sheet:
//
//   Date      — anchored to a document's real expiry (passport, license,
//               vehicle FC). "Due" means the expiry is within LeadDays.
//               Marking done requires the NEW expiry date (you renewed the
//               thing, it now expires later) — or, if none is given, the
//               reminder pauses rather than nagging forever.
//   Recurring — servicing on a cadence (generator annually, emission
//               bi-annually). Marking done advances NextDue by
//               FrequencyMonths FROM THE SCHEDULED DATE, not the done
//               date, so an October service stays an October service even
//               when you actually got to it in November. Missed cycles
//               advance until the next due date is in the future.
//   Monthly   — a checklist that resets every month (send rent invoices).
//               "Due" simply means this month has no completion logged.
//
// Same embedded-module architecture as bills.js (see the header there for
// the full rationale): real schema tables created on first boot, page +
// mark-done routes here, everything flowing through db.js so audit, trash,
// permissions, and backups apply. The due-state logic is pure and exported
// for tests. Unlike Bills there's no rich client script — mark-done is a
// plain form POST, which is all this page needs.

const express = require('express');
const schemaLib = require('./schema');
const db = require('./db');
const usersLib = require('./users');
const audit = require('./audit');

const router = express.Router();

const REMINDERS = 'reminders';
const LOG = 'reminder_log';

const DEFAULT_CATEGORIES = 'Documents, Vehicle, Property, Health, Finance, Compliance, Other';

// ---- First-boot table creation (same idempotent pattern as bills.js) ------
function ensureReminderTables() {
  const schema = schemaLib.load();
  let changed = false;
  if (!schema.entities[REMINDERS]) { addRemindersTable(schema); changed = true; }
  if (!schema.entities[LOG]) { addLogTable(schema); changed = true; }
  // Runs every boot, not just at first creation — see the matching
  // comment in bills.js's ensureBillsTables for why this needs to be
  // unconditional rather than only running inside the "table doesn't
  // exist yet" branches above.
  if (schemaLib.removeNav(schema, REMINDERS)) changed = true;
  // One-time migration, same reasoning and shape as Bills' EI_Status ->
  // EI_Archived migration in bills.js: RM_Status (a picklist whose
  // 'Paused' option the pause logic used to match by exact text) is
  // replaced by a real boolean, RM_Paused. Reads each existing reminder's
  // actual current status before the old field disappears, so real
  // paused/active state carries over rather than resetting.
  const remindersEntity = schema.entities[REMINDERS];
  if (remindersEntity && remindersEntity.fields.some(f => f.name === 'RM_Status')) {
    if (!remindersEntity.fields.some(f => f.name === 'RM_Paused')) {
      schemaLib.addField(schema, REMINDERS, { name: 'RM_Paused', label: 'Paused', type: 'bool', inList: true, hint: 'Paused reminders keep their history but never show as due.' });
    }
    db.getAll(REMINDERS).forEach(row => {
      db.update(REMINDERS, remindersEntity.pk, row[remindersEntity.pk], { RM_Paused: row.RM_Status === 'Paused' });
    });
    schemaLib.deleteField(schema, REMINDERS, 'RM_Status');
    remindersEntity.listColumns = ['RM_RowID', 'RM_Item', 'RM_Category', 'RM_Type', 'RM_NextDue', 'RM_Paused'];
    remindersEntity.filterFields = ['RM_Category', 'RM_Type', 'RM_Paused'];
    changed = true;
  }
  if (schemaLib.removeNav(schema, LOG)) changed = true;
  if (changed) schemaLib.persist(schema);
  return changed;
}

function addRemindersTable(schema) {
  schemaLib.addEntity(schema, { key: REMINDERS, label: 'Reminders', singular: 'Reminder', pkName: 'RM_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, REMINDERS, spec);
  add({ name: 'RM_Item', label: 'Item', type: 'text', required: true, inList: true });
  add({ name: 'RM_Category', label: 'Category', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv(DEFAULT_CATEGORIES), required: true, inList: true });
  add({ name: 'RM_Type', label: 'Type', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv('Date, Recurring, Monthly'), required: true, inList: true, hint: 'Date = fixed expiry (passport). Recurring = cadence in months (servicing). Monthly = tick off every month (send invoices).' });
  add({ name: 'RM_NextDue', label: 'Next Due', type: 'date', inList: true, hint: 'Required for Date and Recurring reminders. Ignored for Monthly.' });
  add({ name: 'RM_FrequencyMonths', label: 'Every N Months', type: 'number', hint: 'Recurring only: how many months between occurrences (12 = yearly, 6 = half-yearly).' });
  add({ name: 'RM_LeadDays', label: 'Lead Days', type: 'number', defaultMode: 'static', defaultValue: '30', hint: 'How many days before the due date this starts showing as due. Renewals with long processes (passport) want a big number here.' });
  add({ name: 'RM_Paused', label: 'Paused', type: 'bool', inList: true, hint: 'Paused reminders keep their history but never show as due.' });
  add({ name: 'RM_Notes', label: 'Notes', type: 'textarea', rows: 2 });
  const e = schema.entities[REMINDERS];
  e.displayField = 'RM_Item';
  e.listColumns = ['RM_RowID', 'RM_Item', 'RM_Category', 'RM_Type', 'RM_NextDue', 'RM_Paused'];
  e.filterFields = ['RM_Category', 'RM_Type', 'RM_Paused'];
  e.sortField = 'RM_NextDue';
  e.auditEnabled = true;
  // The reminders table's own label ("Reminders") is identical to the
  // custom board's nav tab, which nav.ejs adds by hand — leaving this in
  // navOrder produced two visible "Reminders" tabs side by side. The
  // board's own "Manage All" button already routes to the full generic
  // table view (via a ?view=all fallthrough to the standard /:entity
  // route below), so nothing about the raw table becomes less reachable
  // by removing the duplicate tab — only the redundant second entry point
  // goes away.
  schemaLib.removeNav(schema, REMINDERS);
}

function addLogTable(schema) {
  schemaLib.addEntity(schema, { key: LOG, label: 'Reminder Log', singular: 'Reminder Completion', pkName: 'RL_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, LOG, spec);
  add({ name: 'RL_Reminder', label: 'Reminder', type: 'fk', ref: REMINDERS, required: true, inList: true });
  add({ name: 'RL_DoneDate', label: 'Done On', type: 'date', required: true, inList: true });
  add({ name: 'RL_Month', label: 'For Month', type: 'text', inList: true, hint: 'Monthly reminders only: the YYYY-MM this completion ticks off.' });
  add({ name: 'RL_Note', label: 'Note', type: 'text', inList: true });
  const e = schema.entities[LOG];
  e.listColumns = ['RL_RowID', 'RL_Reminder', 'RL_DoneDate', 'RL_Month', 'RL_Note'];
  e.filterFields = ['RL_Reminder'];
  e.sortField = 'RL_DoneDate';
  e.sortDir = 'desc';
  e.auditEnabled = true;
  schemaLib.removeNav(schema, LOG);   // reachable via the Reminders page and by URL; not nav clutter
}

// ---- Pure due-state logic (exported for tests) ----------------------------

function ymOf(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

// Parse a stored YYYY-MM-DD as a LOCAL date at midnight — same
// timezone-safety reasoning as the formula engine's date handling: new
// Date('2026-07-20') is UTC midnight, which is the PREVIOUS evening in
// IST and would make everything look due a day early.
function parseDateLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function addMonths(date, n) {
  // Anchored month math: Jan 31 + 1 month clamps to Feb 28/29 rather than
  // overflowing into March.
  const d = new Date(date.getFullYear(), date.getMonth() + n, 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), lastDay));
  return d;
}

function toIso(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

// One reminder + its log rows + "today" → what the page shows for it.
// state: 'overdue' | 'due' | 'upcoming' | 'done' | 'paused' | 'misconfigured'
function dueState(reminder, logRows, today) {
  if (reminder.RM_Paused) return { state: 'paused' };
  const lead = Number(reminder.RM_LeadDays);
  const leadDays = Number.isFinite(lead) && lead >= 0 ? lead : 30;

  if (reminder.RM_Type === 'Monthly') {
    const month = ymOf(today);
    const done = logRows.some(l => l.RL_Month === month);
    return done
      ? { state: 'done', detail: 'Done for ' + month }
      : { state: 'due', detail: 'Not yet done for ' + month, month };
  }

  // Date and Recurring both hinge on RM_NextDue.
  const due = parseDateLocal(reminder.RM_NextDue);
  if (!due) return { state: 'misconfigured', detail: 'No Next Due date set — edit this reminder and give it one.' };
  const daysLeft = daysBetween(today, due);
  if (daysLeft < 0) return { state: 'overdue', daysLeft, detail: Math.abs(daysLeft) + ' day(s) overdue' };
  if (daysLeft <= leadDays) return { state: 'due', daysLeft, detail: 'Due in ' + daysLeft + ' day(s)' };
  return { state: 'upcoming', daysLeft, detail: 'Due ' + reminder.RM_NextDue };
}

// What marking a reminder done should change, computed purely so tests can
// pin the semantics. Returns { logRow, updates } where updates is the
// patch for the reminder record (or null for no change).
function markDonePlan(reminder, today, opts) {
  const doneDate = toIso(today);
  const base = { RL_Reminder: reminder.RM_RowID, RL_DoneDate: doneDate, RL_Note: (opts && opts.note) || '' };

  if (reminder.RM_Type === 'Monthly') {
    return { logRow: { ...base, RL_Month: ymOf(today) }, updates: null };
  }

  if (reminder.RM_Type === 'Recurring') {
    const freq = Number(reminder.RM_FrequencyMonths);
    if (!Number.isFinite(freq) || freq <= 0) {
      return { error: 'This Recurring reminder has no "Every N Months" set — edit it first.' };
    }
    // Advance FROM the scheduled date, repeatedly if cycles were missed,
    // until the next occurrence is in the future. Falls back to today as
    // the anchor if the stored date is unparseable.
    let next = parseDateLocal(reminder.RM_NextDue) || today;
    do { next = addMonths(next, freq); } while (next <= today);
    return { logRow: { ...base, RL_Month: '' }, updates: { RM_NextDue: toIso(next) } };
  }

  // Date type: the new expiry comes from the renewal itself. Without one,
  // pausing is the honest state — the old date is spent, and leaving it
  // would nag "overdue" forever about a thing that's been handled.
  const newDue = opts && opts.newDue ? String(opts.newDue) : '';
  if (newDue) {
    if (!parseDateLocal(newDue)) return { error: 'The new due date must look like 2027-08-15.' };
    return { logRow: { ...base, RL_Month: '' }, updates: { RM_NextDue: newDue } };
  }
  return { logRow: { ...base, RL_Month: '' }, updates: { RM_Paused: true }, paused: true };
}

// Everything the Reminders page (and the Home panel) needs, in display
// order: overdue first (most overdue at top), then due (soonest first),
// then upcoming, then the rest.
function reminderBoard(reminderRows, logRows, today) {
  const logByReminder = {};
  logRows.forEach(l => { (logByReminder[l.RL_Reminder] = logByReminder[l.RL_Reminder] || []).push(l); });
  const rank = { overdue: 0, due: 1, misconfigured: 2, upcoming: 3, done: 4, paused: 5 };
  return reminderRows
    .map(r => {
      const logs = (logByReminder[r.RM_RowID] || []).slice().sort((a, b) => String(b.RL_DoneDate).localeCompare(String(a.RL_DoneDate)));
      return { reminder: r, status: dueState(r, logs, today), lastDone: logs[0] ? logs[0].RL_DoneDate : '' };
    })
    .sort((a, b) => {
      const d = rank[a.status.state] - rank[b.status.state];
      if (d !== 0) return d;
      const da = a.status.daysLeft, dbb = b.status.daysLeft;
      if (da !== undefined && dbb !== undefined) return da - dbb;
      return String(a.reminder.RM_Item).localeCompare(String(b.reminder.RM_Item));
    });
}

// ---- Permissions ----------------------------------------------------------
function canView(user) {
  return usersLib.can(user, REMINDERS, 'read') && usersLib.can(user, LOG, 'read');
}
function canMarkDone(user) {
  // Marking done writes a log row and may patch the reminder itself.
  return usersLib.can(user, LOG, 'create') && usersLib.can(user, REMINDERS, 'update');
}

// ---- Routes ---------------------------------------------------------------

// Same self-heal guard as bills.js — a pre-Reminders backup restore or a
// deleted table recreates on the next visit instead of breaking the page.
router.use('/reminders', (req, res, next) => { ensureReminderTables(); next(); });

router.get('/reminders', (req, res, next) => {
  // This route shadows the standard /:entity list view for the reminders
  // table (mounted before it, same path shape). ?view=all is the escape
  // hatch: fall through to the normal list applet with its filters,
  // sorting, and CSV export — "Manage All" on the board links there.
  if (req.query.view === 'all') return next();
  if (!canView(req.currentUser)) {
    return res.status(403).render('403', { message: "You don't have read permission on Reminders. Ask an administrator to grant it under Admin → Users.", activeKey: 'reminders' });
  }
  const today = new Date();
  const board = reminderBoard(db.getAll(REMINDERS), db.getAll(LOG), today);
  res.render('reminders', {
    activeKey: 'reminders', board,
    canMarkDone: canMarkDone(req.currentUser),
    notice: req.query.notice, error: req.query.error,
  });
});

router.post('/reminders/:id/done', (req, res) => {
  if (!canMarkDone(req.currentUser)) {
    return res.redirect('/reminders?error=' + encodeURIComponent('You need permission to log completions (create on Reminder Log, update on Reminders).'));
  }
  const schema = schemaLib.load();
  const rmEntity = schema.entities[REMINDERS];
  const logEntity = schema.entities[LOG];
  const reminder = db.getById(REMINDERS, rmEntity.pk, req.params.id);
  if (!reminder) return res.redirect('/reminders?error=' + encodeURIComponent('That reminder no longer exists.'));

  const plan = markDonePlan(reminder, new Date(), { newDue: req.body.newDue, note: req.body.note });
  if (plan.error) return res.redirect('/reminders?error=' + encodeURIComponent(plan.error));

  const logRow = { [logEntity.pk]: db.nextAutoId(LOG, logEntity.pk), ...plan.logRow };
  db.insert(LOG, logRow);
  audit.log({ entityKey: LOG, recordId: logRow[logEntity.pk], action: 'create', username: req.currentUser.username, before: null, after: logRow });

  if (plan.updates) {
    const updated = { ...reminder, ...plan.updates };
    db.update(REMINDERS, rmEntity.pk, reminder[rmEntity.pk], updated);
    audit.log({ entityKey: REMINDERS, recordId: reminder[rmEntity.pk], action: 'update', username: req.currentUser.username, before: reminder, after: updated });
  }

  const msg = plan.paused
    ? `"${reminder.RM_Item}" logged and PAUSED — it had no new due date. Edit it and set one when known, then uncheck Paused.`
    : `"${reminder.RM_Item}" marked done.`;
  res.redirect('/reminders?notice=' + encodeURIComponent(msg));
});

// The Home page's Due Soon panel calls this instead of duplicating logic.
// Returns only items needing attention, capped, or null when the user
// can't read reminders (panel simply doesn't render).
function dueSoonPanel(user, limit) {
  // Absent tables ARE a genuine "nothing to see" state — a fresh install
  // where ensureReminderTables() hasn't run yet, or an admin who deleted
  // them. Return null (same shape as "no permission") so every caller
  // — Home widget, KPI metric, wherever else — treats it uniformly.
  // Guarding at the source is cleaner than every caller repeating the
  // schema.entities check.
  const schema = schemaLib.load();
  if (!schema.entities[REMINDERS] || !schema.entities[LOG]) return null;
  if (!canView(user)) return null;
  const board = reminderBoard(db.getAll(REMINDERS), db.getAll(LOG), new Date());
  const attention = board.filter(b => b.status.state === 'overdue' || b.status.state === 'due' || b.status.state === 'misconfigured');
  return { items: attention.slice(0, limit || 8), more: Math.max(0, attention.length - (limit || 8)) };
}

module.exports = {
  router, ensureReminderTables, dueSoonPanel,
  dueState, markDonePlan, reminderBoard, addMonths, parseDateLocal,
  REMINDERS, LOG,
};
