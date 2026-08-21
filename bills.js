// bills.js
//
// The "Bills" mini-app: a recurring-expense matrix (items × months) with a
// fast month-entry grid — the replacement for the Excel "Bills" tab where
// amounts were typed down a month column across ~30 recurring payables.
//
// Architecture follows the payqr.js precedent deliberately: an isolated
// module with FIXED table identity ("expense_items" / "expense_entries"),
// its own routes, and one mount line in server.js. The front-end is a
// single page with its own client script (public/js/bills.js) talking to
// the two JSON endpoints below — "separate project" ergonomics for the UI,
// but same process, same session, same db.js layer, so permissions, audit,
// trash, atomic writes, and backups all cover this data with zero glue.
//
// The two tables are REAL schema entities (created on first boot by
// ensureBillsTables below), not private storage — so Admin field editing,
// CSV import/export, per-user permissions, and the normal list/detail
// screens all work on them too. This module only OWNS the pivot view and
// the batch month-save; everything else is the app's existing machinery.

const express = require('express');
const schemaLib = require('./schema');
const db = require('./db');
const usersLib = require('./users');
const audit = require('./audit');

const router = express.Router();

const ITEMS = 'expense_items';
const ENTRIES = 'expense_entries';

// Categories seeded from the real Excel workbook's section headers. Just a
// picklist default — admins can edit the option list under Admin → Fields
// like any other picklist, and the matrix groups by whatever values exist.
const DEFAULT_CATEGORIES = 'Electricity, Water, Club, Taxes, Credit Cards, Subscriptions, Salaries, Insurance, Vehicle, Renewals, Other';

// ---- First-boot table creation --------------------------------------------
// Idempotent: runs at every server start, does nothing once the tables
// exist. Creates them through the SAME addEntity/addField functions the
// Admin UI uses, so the field shapes can't drift from what the rest of the
// app expects. If an admin later deletes one of these tables on purpose,
// it will be recreated (empty) on next restart — that's intentional: the
// /bills routes assume these tables exist and should fail loudly in Admin
// terms ("the table came back empty") rather than crash in route terms.
function ensureBillsTables() {
  const schema = schemaLib.load();
  let changed = false;

  if (!schema.entities[ITEMS]) {
    addItemsTable(schema);
    changed = true;
  }
  if (!schema.entities[ENTRIES]) {
    addEntriesTable(schema);
    changed = true;
  }
  // Runs every boot, not just at first creation — addEntriesTable's own
  // removeNav call only ever fires the moment the table is first made, so
  // an install where expense_entries already existed before this specific
  // line was added (or existed before ensureBillsTables ever ran at all)
  // would otherwise keep a stale nav entry forever. removeNav is a no-op
  // if the key's already gone, so this is safe to repeat unconditionally.
  if (schemaLib.removeNav(schema, ENTRIES)) changed = true;
  // One-time migration: EI_Status (a picklist with an 'Archived' option
  // whose exact wording the archiving logic used to depend on directly —
  // see the backlog item this closes out) is replaced by a real boolean,
  // EI_Archived, which can't have this problem since there's no text to
  // rename. Runs once, only while the old field is still there — reads
  // each existing item's actual current status before the field
  // disappears, so real archived/active state carries over correctly
  // rather than every item silently resetting to "not archived."
  const itemsEntity = schema.entities[ITEMS];
  if (itemsEntity && itemsEntity.fields.some(f => f.name === 'EI_Status')) {
    if (!itemsEntity.fields.some(f => f.name === 'EI_Archived')) {
      schemaLib.addField(schema, ITEMS, { name: 'EI_Archived', label: 'Archived', type: 'bool', inList: true, hint: 'Archived items keep their history but leave the entry grid.' });
    }
    db.getAll(ITEMS).forEach(row => {
      db.update(ITEMS, itemsEntity.pk, row[itemsEntity.pk], { EI_Archived: row.EI_Status === 'Archived' });
    });
    schemaLib.deleteField(schema, ITEMS, 'EI_Status');
    itemsEntity.listColumns = ['EI_Code', 'EI_Item', 'EI_Category', 'EI_PaidFrom', 'EI_DueDay', 'EI_Mode', 'EI_Archived'];
    itemsEntity.filterFields = ['EI_Category', 'EI_Archived'];
    changed = true;
  }
  // One-time migration: add the frequency model (EI_Frequency + optional
  // EI_AnchorMonth) to an items table that predates it. Existing items are
  // backfilled to 'Monthly', which reproduces the exact pre-frequency due
  // logic (due unless there's an entry for the current month) — so nothing a
  // user sees changes on upgrade until they reclassify their non-monthly
  // bills. Same careful, state-preserving shape as the EI_Status migration
  // above. Runs after that block, so its listColumns/filterFields win.
  if (itemsEntity && !itemsEntity.fields.some(f => f.name === 'EI_Frequency')) {
    schemaLib.addField(schema, ITEMS, { name: 'EI_Frequency', label: 'Frequency', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv(FREQUENCY_OPTIONS), required: true, inList: true, defaultMode: 'static', defaultValue: 'Monthly', hint: 'How often this bill recurs. Drives whether it shows as due on the Home screen. Irregular = never auto-flagged (record it when it happens).' });
    if (!itemsEntity.fields.some(f => f.name === 'EI_AnchorMonth')) {
      schemaLib.addField(schema, ITEMS, { name: 'EI_AnchorMonth', label: 'Cycle Anchor Month', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv(MONTH_OPTIONS), hint: 'Optional, for Quarterly/Half-Yearly/Annual: the month the cycle is pinned to (e.g. Annual anchored to April). Leave blank to make it "due once it has been N months since the last payment." Ignored for Monthly and Irregular.' });
    }
    db.getAll(ITEMS).forEach(row => {
      if (row.EI_Frequency == null || String(row.EI_Frequency).trim() === '') {
        db.update(ITEMS, itemsEntity.pk, row[itemsEntity.pk], { EI_Frequency: 'Monthly' });
      }
    });
    itemsEntity.listColumns = ['EI_Code', 'EI_Item', 'EI_Category', 'EI_Frequency', 'EI_PaidFrom', 'EI_DueDay', 'EI_Mode', 'EI_Archived'];
    itemsEntity.filterFields = ['EI_Category', 'EI_Frequency', 'EI_Archived'];
    changed = true;
  }
  if (changed) schemaLib.persist(schema);
  return changed;
}

function addItemsTable(schema) {
  schemaLib.addEntity(schema, { key: ITEMS, label: 'Expense Items', singular: 'Expense Item', pkName: 'EI_Code', pkLabel: 'Item Code' });
  const add = (spec) => schemaLib.addField(schema, ITEMS, spec);
  add({ name: 'EI_Item', label: 'Item', type: 'text', required: true, inList: true });
  add({ name: 'EI_Category', label: 'Category', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv(DEFAULT_CATEGORIES), required: true, inList: true });
  add({ name: 'EI_Frequency', label: 'Frequency', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv(FREQUENCY_OPTIONS), required: true, inList: true, defaultMode: 'static', defaultValue: 'Monthly', hint: 'How often this bill recurs. Drives whether it shows as due on the Home screen. Irregular = never auto-flagged (record it when it happens).' });
  add({ name: 'EI_AnchorMonth', label: 'Cycle Anchor Month', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv(MONTH_OPTIONS), hint: 'Optional, for Quarterly/Half-Yearly/Annual: the month the cycle is pinned to (e.g. Annual anchored to April). Leave blank to make it "due once it has been N months since the last payment." Ignored for Monthly and Irregular.' });
  add({ name: 'EI_Details', label: 'Details', type: 'textarea', rows: 2, hint: 'Account numbers, consumer IDs, policy numbers — whatever identifies this bill.' });
  add({ name: 'EI_PaidFrom', label: 'Paid From', type: 'text', inList: true, hint: 'Account / card / instrument this is usually paid from.' });
  add({ name: 'EI_DueDay', label: 'Due Day', type: 'number', inList: true, hint: 'Day of the month this bill is usually due (1–31).' });
  add({ name: 'EI_Mode', label: 'Mode', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv('Manual, Auto'), inList: true, hint: 'Auto = standing instruction / auto-debit; Manual = you pay it.' });
  add({ name: 'EI_Archived', label: 'Archived', type: 'bool', inList: true, hint: 'Archived items keep their history but leave the entry grid.' });
  add({ name: 'EI_Notes', label: 'Notes', type: 'textarea', rows: 2 });
  const e = schema.entities[ITEMS];
  e.displayField = 'EI_Item';
  e.listColumns = ['EI_Code', 'EI_Item', 'EI_Category', 'EI_Frequency', 'EI_PaidFrom', 'EI_DueDay', 'EI_Mode', 'EI_Archived'];
  e.filterFields = ['EI_Category', 'EI_Frequency', 'EI_Archived'];
  e.sortField = 'EI_Category';
  e.auditEnabled = true;
}

function addEntriesTable(schema) {
  schemaLib.addEntity(schema, { key: ENTRIES, label: 'Expense Entries', singular: 'Expense Entry', pkName: 'EE_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, ENTRIES, spec);
  add({ name: 'EE_Item', label: 'Expense Item', type: 'fk', ref: ITEMS, required: true, inList: true });
  add({ name: 'EE_Month', label: 'Month', type: 'text', required: true, inList: true, hint: 'Format YYYY-MM, e.g. 2026-07.' });
  add({ name: 'EE_Amount', label: 'Amount', type: 'currency', required: true, inList: true });
  add({ name: 'EE_Note', label: 'Note', type: 'text', inList: true });
  const e = schema.entities[ENTRIES];
  e.listColumns = ['EE_RowID', 'EE_Item', 'EE_Month', 'EE_Amount', 'EE_Note'];
  e.filterFields = ['EE_Item', 'EE_Month'];
  e.sortField = 'EE_Month';
  e.sortDir = 'desc';
  e.auditEnabled = true;
  // The grid IS the way into this table — a nav tab for raw entry rows
  // would just be clutter next to the Bills tab. Still fully reachable
  // (list screen, Admin, CSV import) via URL; an admin who wants the tab
  // back can re-add it under Admin → Navigation.
  schemaLib.removeNav(schema, ENTRIES);
}

// ---- Pure helpers (exported for tests) ------------------------------------

// "2026-27" → ['2026-04', '2026-05', ..., '2027-03'] (Indian FY: Apr–Mar).
// Throws on anything that isn't a well-formed FY string — routes convert
// that to a 400 rather than silently building a nonsense matrix.
function fyMonths(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || '').trim());
  if (!m) throw new Error('Financial year must look like "2026-27".');
  const startYear = Number(m[1]);
  if ((startYear + 1) % 100 !== Number(m[2])) throw new Error(`"${fy}" is not a valid financial year — the second part must be the year after the first (e.g. "2026-27").`);
  const months = [];
  for (let i = 0; i < 12; i++) {
    const mm = ((3 + i) % 12) + 1;              // 4..12 then 1..3
    const yy = mm >= 4 ? startYear : startYear + 1;
    months.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return months;
}

// The FY a given Date falls in, as the same "2026-27" string.
function fyOf(date) {
  const y = date.getFullYear();
  const startYear = (date.getMonth() + 1) >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// items + entries → the matrix the page renders. Grouping is by the
// category values actually present (Archived items only appear if they
// have entries within these months — history stays visible, dead rows
// don't). Cell values are SUMS: two entries for the same item+month (rare,
// but possible via CSV import or the raw table) display as their total
// here, while the month-entry grid deliberately refuses to edit such
// months inline (see splitCell below) instead of silently collapsing two
// rows into one.
function buildMatrix(items, entries, months) {
  const monthSet = new Set(months);
  const byItem = {};
  entries.forEach(en => {
    if (!monthSet.has(en.EE_Month)) return;
    const cell = (byItem[en.EE_Item] = byItem[en.EE_Item] || {});
    const c = (cell[en.EE_Month] = cell[en.EE_Month] || { amount: 0, count: 0 });
    c.amount += Number(en.EE_Amount) || 0;
    c.count += 1;
  });

  const visible = items.filter(it =>
    !it.EI_Archived || Object.keys(byItem[it.EI_Code] || {}).length > 0
  );

  const categories = [];
  const catIndex = {};
  visible.forEach(it => {
    const cat = it.EI_Category || 'Other';
    if (!(cat in catIndex)) {
      catIndex[cat] = categories.length;
      categories.push({ name: cat, items: [], subtotals: zeroRow(months) });
    }
    const cells = {};
    let total = 0;
    months.forEach(mn => {
      const c = (byItem[it.EI_Code] || {})[mn];
      cells[mn] = c ? { amount: c.amount, split: c.count > 1 } : null;
      if (c) total += c.amount;
    });
    const group = categories[catIndex[cat]];
    group.items.push({
      code: it.EI_Code, item: it.EI_Item, paidFrom: it.EI_PaidFrom || '',
      dueDay: it.EI_DueDay || '', mode: it.EI_Mode || '',
      archived: !!it.EI_Archived, cells, total,
    });
    months.forEach(mn => { if (cells[mn]) group.subtotals[mn] += cells[mn].amount; });
  });

  const grand = zeroRow(months);
  let grandTotal = 0;
  categories.forEach(g => {
    g.total = months.reduce((s, mn) => s + g.subtotals[mn], 0);
    months.forEach(mn => { grand[mn] += g.subtotals[mn]; });
    grandTotal += g.total;
  });

  return { months, categories, grand, grandTotal };
}

function zeroRow(months) {
  const row = {};
  months.forEach(mn => { row[mn] = 0; });
  return row;
}

// ---- Frequency / due-cadence logic (pure, exported for tests) -------------
//
// Bills carry a frequency and (optionally) a fixed calendar anchor. Two
// modes, decided per item:
//   Floating  — no anchor month set: "due again once it's been >= N months
//               since the last recorded entry." Self-anchors to your actual
//               payment rhythm; right for utilities with no fixed date.
//   Anchored  — an anchor month set: the schedule is pinned to the calendar
//               (the anchor month, then every N months) and a payment
//               SATISFIES the current cycle rather than moving it — so
//               paying early or late never drifts the next due date. Right
//               for statutory / anniversary bills. Mirrors the Reminders
//               module's "advance from the scheduled date, not the done
//               date" rule.
// Everything is month-grained (entries store EE_Month = YYYY-MM, no day), so
// due-state is computed in whole months, exactly matching the matrix. A bill
// with no EI_Frequency set behaves as Monthly — identical to the logic that
// existed before frequency, so nothing changes for an item until it's
// reclassified.

const FREQUENCY_OPTIONS = 'Monthly, Quarterly, Half-Yearly, Annual, Irregular';
const MONTH_OPTIONS = 'January, February, March, April, May, June, July, August, September, October, November, December';
const MONTH_NAMES = MONTH_OPTIONS.split(',').map(s => s.trim());
// N months per frequency. Irregular -> null (never auto-due). Anything
// unrecognized (including blank) -> 1, preserving pre-frequency behavior.
const FREQUENCY_MONTHS = { Monthly: 1, Quarterly: 3, 'Half-Yearly': 6, Annual: 12, Irregular: null };

function freqMonthsOf(item) {
  const f = String(item.EI_Frequency || 'Monthly');
  return (f in FREQUENCY_MONTHS) ? FREQUENCY_MONTHS[f] : 1;
}
function monthIndexOfYm(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '').trim());
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}
function ymFromMonthIndex(idx) {
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
function monthIndexOfDate(date) {
  return date.getFullYear() * 12 + date.getMonth();
}
function anchorMonthOf(item) {
  const i = MONTH_NAMES.indexOf(String(item.EI_AnchorMonth || '').trim());
  return i === -1 ? null : i + 1; // 1..12, or null when unset -> floating
}
function prettyYm(ym) {
  const idx = monthIndexOfYm(ym);
  if (idx === null) return ym;
  return `${MONTH_NAMES[idx % 12].slice(0, 3)} ${Math.floor(idx / 12)}`;
}

// item + its own entry months (array of 'YYYY-MM') + today -> due-state.
// Returns { frequency, freqMonths, mode, due, reason, lastPaidMonth?,
// scheduledMonth?, detail }. Archived and Irregular are never due.
function billDueInfo(item, itemEntryMonths, today) {
  const frequency = String(item.EI_Frequency || 'Monthly');
  const n = freqMonthsOf(item);
  const nowIdx = monthIndexOfDate(today);

  if (item.EI_Archived) return { frequency, freqMonths: n, mode: 'archived', due: false, reason: 'archived', detail: 'Archived' };
  if (n === null) return { frequency, freqMonths: null, mode: 'irregular', due: false, reason: 'irregular', detail: 'Irregular \u00b7 recorded when it happens' };

  const idxs = (itemEntryMonths || []).map(monthIndexOfYm).filter(v => v !== null);
  const anchorM = anchorMonthOf(item);

  // Monthly is anchor-agnostic (every month is a scheduled month), so it
  // always uses the floating path with N=1 — which reduces to the exact
  // pre-frequency rule: due unless there's an entry for the current month.
  if (n === 1 || anchorM === null) {
    const past = idxs.filter(v => v <= nowIdx);
    if (past.length === 0) {
      // No entries in the past: due if there are none at all; if the only
      // entries are in the future, it's paid ahead and not due yet.
      const neverLogged = idxs.length === 0;
      return {
        frequency, freqMonths: n, mode: 'floating',
        due: neverLogged, reason: neverLogged ? 'never-logged' : 'paid-ahead',
        lastPaidMonth: null,
        detail: neverLogged ? `${frequency} \u00b7 no payment recorded yet` : `${frequency} \u00b7 recorded ahead`,
      };
    }
    const lastIdx = Math.max(...past);
    const monthsSince = nowIdx - lastIdx;
    const due = monthsSince >= n;
    const lastYm = ymFromMonthIndex(lastIdx);
    const detail = n === 1
      ? `Monthly \u00b7 ${due ? 'nothing recorded for' : 'recorded for'} ${prettyYm(ymFromMonthIndex(nowIdx))}`
      : `${frequency} \u00b7 last paid ${prettyYm(lastYm)}${due ? ` (${monthsSince} mo ago)` : ''}`;
    return { frequency, freqMonths: n, mode: 'floating', due, reason: due ? 'elapsed' : 'recent', lastPaidMonth: lastYm, detail };
  }

  // Anchored: the current scheduled month is the latest scheduled month
  // (anchor month + k*N) that is <= today. A payment anywhere in the cycle
  // window [current, next) satisfies it; the schedule itself never moves.
  const nowMo = today.getMonth() + 1;               // 1..12
  const back = (((nowMo - anchorM) % n) + n) % n;    // months since last scheduled month
  const curSchedIdx = nowIdx - back;
  const nextSchedIdx = curSchedIdx + n;
  const satisfied = idxs.some(v => v >= curSchedIdx && v < nextSchedIdx);
  const schedYm = ymFromMonthIndex(curSchedIdx);
  return {
    frequency, freqMonths: n, mode: 'anchored',
    due: !satisfied, reason: satisfied ? 'cycle-paid' : 'cycle-unpaid',
    scheduledMonth: schedYm,
    detail: `${frequency} \u00b7 ${satisfied ? `${prettyYm(schedYm)} cycle paid` : `due for ${prettyYm(schedYm)} cycle`}`,
  };
}

// ---- Permission helpers ---------------------------------------------------
// Same permission model as everywhere else, just checked directly since
// these routes aren't behind the /:entity middleware chain. Viewing the
// matrix needs read on BOTH tables; saving a month needs create+update+
// delete on entries (a batch save can do all three).
function canView(user) {
  return usersLib.can(user, ITEMS, 'read') && usersLib.can(user, ENTRIES, 'read');
}
function canEdit(user) {
  return ['create', 'update', 'delete'].every(a => usersLib.can(user, ENTRIES, a));
}

// ---- Routes ---------------------------------------------------------------

// Self-heal: if the tables are missing when any /bills path is hit (a
// pre-Bills backup was restored, or an admin deleted them), recreate them
// on the spot instead of limping along against tables that don't exist.
// Idempotent and near-free once they exist; the restore route also calls
// ensureBillsTables directly so the nav tab reappears immediately, but
// this guard means even a code path we didn't anticipate can't leave
// /bills half-working.
router.use('/bills', (req, res, next) => {
  ensureBillsTables();
  next();
});

router.get('/bills', (req, res) => {
  if (!canView(req.currentUser)) {
    return res.status(403).render('403', { message: "You don't have read permission on Expense Items and Expense Entries. Ask an administrator to grant it under Admin → Users.", activeKey: 'bills' });
  }
  res.render('bills', { activeKey: 'bills', canEdit: canEdit(req.currentUser) });
});

router.get('/bills/api/matrix', (req, res) => {
  if (!canView(req.currentUser)) return res.status(403).json({ error: 'No read permission on the Bills tables.' });
  let months;
  const fy = req.query.fy || fyOf(new Date());
  try { months = fyMonths(fy); } catch (e) { return res.status(400).json({ error: e.message }); }

  const items = db.getAll(ITEMS);
  const entries = db.getAll(ENTRIES);
  const matrix = buildMatrix(items, entries, months);
  res.json({ fy, canEdit: canEdit(req.currentUser), ...matrix });
});

// Batch save for one month: body is { amounts: { "<itemCode>": "1234.50" | "" } }.
// One request = one pass = one atomic db.json write per changed row via the
// normal db layer (insert/update/remove), each audited individually so the
// audit trail reads exactly like hand-edited rows. Blank amount = "no bill
// this month" = the entry row is REMOVED (soft-deleted, so it lands in
// Trash like any other delete — a fat-fingered clear is recoverable).
router.post('/bills/api/month/:month', (req, res) => {
  if (!canEdit(req.currentUser)) return res.status(403).json({ error: 'You need create, update, and delete permission on Expense Entries to save the grid.' });
  const month = String(req.params.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Month must look like "2026-07".' });
  const amounts = (req.body && req.body.amounts) || {};
  if (typeof amounts !== 'object' || Array.isArray(amounts)) return res.status(400).json({ error: 'Body must be { amounts: { itemCode: value } }.' });

  const schema = schemaLib.load();
  const entriesEntity = schema.entities[ENTRIES];
  const items = db.getAll(ITEMS);
  const itemCodes = new Set(items.map(it => it.EI_Code));
  const monthEntries = db.getAll(ENTRIES).filter(en => en.EE_Month === month);
  const byItem = {};
  monthEntries.forEach(en => { (byItem[en.EE_Item] = byItem[en.EE_Item] || []).push(en); });

  const results = { created: 0, updated: 0, removed: 0, unchanged: 0, errors: [] };

  Object.entries(amounts).forEach(([code, raw]) => {
    if (!itemCodes.has(code)) { results.errors.push(`Unknown expense item "${code}".`); return; }
    const existing = byItem[code] || [];
    // A month that already holds MULTIPLE rows for this item can't be
    // edited as one cell without silently destroying a row — the grid
    // shows these cells locked with a link to the raw table instead, and
    // the server enforces the same rule in case of a stale page.
    if (existing.length > 1) { results.errors.push(`"${code}" has ${existing.length} entries for ${month} — edit those rows directly in Expense Entries.`); return; }

    const trimmed = String(raw ?? '').trim();
    const isBlank = trimmed === '';
    const amount = Number(trimmed);
    if (!isBlank && !Number.isFinite(amount)) { results.errors.push(`"${code}": "${trimmed}" is not a number.`); return; }

    const current = existing[0] || null;
    if (isBlank && !current) { results.unchanged++; return; }
    if (isBlank && current) {
      db.softDelete(ENTRIES, entriesEntity.pk, current[entriesEntity.pk], req.currentUser.username);
      audit.log({ entityKey: ENTRIES, recordId: current[entriesEntity.pk], action: 'delete', username: req.currentUser.username, before: current, after: null });
      results.removed++;
      return;
    }
    if (current) {
      if (Number(current.EE_Amount) === amount) { results.unchanged++; return; }
      const updated = { ...current, EE_Amount: amount };
      db.update(ENTRIES, entriesEntity.pk, current[entriesEntity.pk], updated);
      audit.log({ entityKey: ENTRIES, recordId: current[entriesEntity.pk], action: 'update', username: req.currentUser.username, before: current, after: updated });
      results.updated++;
      return;
    }
    const record = { EE_RowID: db.nextAutoId(ENTRIES, entriesEntity.pk), EE_Item: code, EE_Month: month, EE_Amount: amount, EE_Note: '' };
    db.insert(ENTRIES, record);
    audit.log({ entityKey: ENTRIES, recordId: record.EE_RowID, action: 'create', username: req.currentUser.username, before: null, after: record });
    results.created++;
  });

  res.json(results);
});

module.exports = { router, ensureBillsTables, fyMonths, fyOf, buildMatrix, billDueInfo, FREQUENCY_MONTHS, FREQUENCY_OPTIONS, MONTH_OPTIONS, ITEMS, ENTRIES };
