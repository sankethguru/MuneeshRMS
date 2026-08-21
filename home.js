// home.js
//
// The Home Screen, admin-customizable the same way the Sidebar is: an
// ordered list of widgets (schema.homeWidgets), each a real, predefined
// type with its own data pulled from tables that already exist elsewhere
// in the app — nothing new to track, just a different way of looking at
// data Bills/Reminders/Tax/Invoices already own. Unlike Bills/Reminders/
// Tax, this module doesn't own any tables of its own; it's purely a
// configuration (which widgets, what order, per-widget config) plus a
// computation step that reads from whichever real tables each widget
// actually needs.

const schemaLib = require('./schema');
const db = require('./db');
const usersLib = require('./users');
const remindersMod = require('./reminders');
const taxMod = require('./tax');
const billsMod = require('./bills');
const audit = require('./audit');

// ---- Widget type registry -------------------------------------------------
// hasConfig: true means the widget has its own small settings (which
// tables to shortcut, which KPIs to show) editable from Admin -> Home
// Screen; false means it just shows itself with no choices to make.
const WIDGET_TYPES = {
  'due-soon': { label: 'Due Soon (Reminders)', hasConfig: false },
  'rent-status': { label: "This Month's Rent Status", hasConfig: false },
  'tax-alerts': { label: 'Tax Filing Alerts', hasConfig: false },
  'quick-actions': { label: 'Quick Actions', hasConfig: true },
  'kpi-cards': { label: 'KPI Cards', hasConfig: true },
  'bills-due': { label: 'Bills Due', hasConfig: true, sourceTable: 'expense_items' },
  'uncleared-cheques': { label: 'Uncleared Cheques', hasConfig: true, sourceTable: 'cheques' },
  'cc-bills-due': { label: 'Credit Card Bills Due', hasConfig: true, sourceTable: 'cctracker' },
  'advance-tax-next-due': { label: 'Advance Tax Next-Due', hasConfig: true, sourceTable: 'tax_projections' },
  'recent-activity': { label: 'Recent Activity', hasConfig: false },
  'announcement': { label: 'Announcement / Note', hasConfig: true },
  'report-card': { label: 'Report Card', hasConfig: true },
  'system-health': { label: 'System Health', hasConfig: false },
};

// ---- KPI metric registry --------------------------------------------------
// Each metric is a small, self-contained compute(schema) — added to
// independently of the widget itself, so a new metric later doesn't need
// touching the widget's own rendering logic, just one more registry entry.
const KPI_METRICS = {
  'active-tenants': {
    label: 'Active Tenants',
    compute(schema, currentUser) {
      const t = schema.entities['tenants'];
      if (!t || !t.fields.some(f => f.name === 'T_IsCurrent') || !usersLib.can(currentUser, 'tenants', 'read')) return null;
      return db.getAll('tenants').filter(r => r.T_IsCurrent).length;
    },
  },
  'properties-held': {
    label: 'Properties Held',
    compute(schema, currentUser) {
      if (!schema.entities['property'] || !usersLib.can(currentUser, 'property', 'read')) return null;
      return db.getAll('property').length;
    },
  },
  'landlord-registrations': {
    label: 'Landlord Registrations',
    compute(schema, currentUser) {
      if (!schema.entities['landlords'] || !usersLib.can(currentUser, 'landlords', 'read')) return null;
      return db.getAll('landlords').length;
    },
  },
  'rent-collected-fy': {
    label: 'Rent Collected (This FY, so far)',
    compute(schema, currentUser) {
      const inv = schema.entities['invoices'];
      const settings = schema.taxSettings || {};
      const dateField = settings.invoiceDateField, receivedField = settings.invoiceRentReceivedField;
      if (!inv || !dateField || !receivedField || !usersLib.can(currentUser, 'invoices', 'read')) return null;
      const fy = taxMod.fyOfDateString(new Date().toISOString().slice(0, 10));
      let total = 0;
      db.getAll('invoices').forEach(row => {
        if (taxMod.fyOfDateString(row[dateField]) !== fy) return;
        total += Number(row[receivedField]) || 0;
      });
      return { amount: total, isCurrency: true };
    },
  },
  'pending-invoices': {
    label: "Pending Invoices (This Month, Unreceived)",
    compute(schema, currentUser) {
      const inv = schema.entities['invoices'];
      const settings = schema.taxSettings || {};
      const dateField = settings.invoiceDateField, receivedField = settings.invoiceRentReceivedField;
      if (!inv || !dateField || !receivedField || !usersLib.can(currentUser, 'invoices', 'read')) return null;
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      let pending = 0;
      db.getAll('invoices').forEach(row => {
        if (!String(row[dateField] || '').startsWith(ym)) return;
        if (!(Number(row[receivedField]) > 0)) pending += 1;
      });
      return pending;
    },
  },
  'pending-bills-this-month': {
    label: 'Pending Bills (Due Now)',
    compute(schema, currentUser) {
      const data = computeBillsDue(schema, currentUser);
      return data.available ? data.due.length : null;
    },
  },
  'overdue-reminders': {
    label: 'Overdue Reminders',
    compute(schema, currentUser) {
      // Guard the schema shape locally before calling dueSoonPanel —
      // that helper reads the REAL schema from disk internally (to keep
      // its own callers simple), which is normally correct but means it
      // can't be steered by the schema argument this KPI receives.
      // Checking here keeps this metric honestly driven by its input
      // schema and preserves the "empty schema → null" contract the
      // widget dependency tests enforce.
      if (!schema.entities['reminders'] || !schema.entities['reminder_log']) return null;
      const panel = remindersMod.dueSoonPanel(currentUser, 1000);
      if (!panel) return null;
      return panel.items.filter(b => b.status.state === 'overdue').length;
    },
  },
  'uncleared-cheques-total': {
    label: 'Uncleared Cheques (₹ Total)',
    compute(schema, currentUser) {
      const data = computeUnclearedCheques(schema, currentUser);
      return data.available ? { amount: data.total, isCurrency: true } : null;
    },
  },
  'advance-tax-shortfall-total': {
    label: 'Advance Tax Shortfall (Next Due, ₹ Total)',
    compute(schema, currentUser) {
      const data = computeAdvanceTaxNextDue(schema, currentUser);
      return (data.available && data.total > 0) ? { amount: data.total, isCurrency: true } : null;
    },
  },
  'occupancy-rate': {
    label: 'Occupancy Rate (%)',
    compute(schema, currentUser) {
      const t = schema.entities['tenants'];
      const p = schema.entities['property'];
      if (!t || !p) return null;
      if (!usersLib.can(currentUser, 'tenants', 'read') || !usersLib.can(currentUser, 'property', 'read')) return null;
      const totalUnits = db.getAll('property').filter(r => !r.__deletedAt).length;
      if (totalUnits === 0) return null;
      const activeField = t.fields.find(f => f.name === 'T_Active' || f.name === 'T_IsCurrent');
      const activeTenants = activeField
        ? db.getAll('tenants').filter(r => !r.__deletedAt && r[activeField.name]).length
        : db.getAll('tenants').filter(r => !r.__deletedAt).length;
      return Math.round((activeTenants / totalUnits) * 100) + '%';
    },
  },
  'monthly-revenue': {
    label: 'This Month Revenue (₹)',
    compute(schema, currentUser) {
      const bills = schema.entities['bills'];
      if (!bills || !usersLib.can(currentUser, 'bills', 'read')) return null;
      const now = new Date();
      const thisMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const amountField = bills.fields.find(f => f.type === 'currency' || f.name.match(/amount/i));
      if (!amountField) return null;
      const total = db.getAll('bills').filter(r => !r.__deletedAt)
        .filter(r => { const d = r.BILLS_InvoiceDate || r.BILLS_Date || ''; return d.startsWith(thisMonth); })
        .reduce((sum, r) => sum + (Number(r[amountField.name]) || 0), 0);
      return { amount: total, isCurrency: true };
    },
  },
  'leases-expiring-soon': {
    label: 'Leases Expiring (next 90 days)',
    compute(schema, currentUser) {
      const t = schema.entities['tenants'];
      if (!t || !usersLib.can(currentUser, 'tenants', 'read')) return null;
      if (!t.fields.some(f => f.name === 'T_Expiry')) return null;
      const now = new Date();
      const cutoff = new Date(now.getTime() + 90 * 86400000);
      const expiring = db.getAll('tenants').filter(r => {
        if (r.__deletedAt) return false;
        const active = r.T_Active !== undefined ? r.T_Active : (r.T_IsCurrent !== undefined ? r.T_IsCurrent : true);
        if (!active) return false;
        const exp = r.T_Expiry;
        if (!exp) return false;
        const d = new Date(exp);
        return d >= now && d <= cutoff;
      });
      return expiring.length;
    },
  },
};

function kpiEligibleEntities() {
  // Nothing to configure per-entity here — kept as a function (not a
  // plain constant) so a future metric needing its own dynamic
  // eligibility check has a natural place to plug in later.
  return Object.keys(KPI_METRICS);
}

// ---- schema.homeWidgets: migration + CRUD ---------------------------------

function migrateHomeWidgets(schema) {
  // Matches current behavior exactly for an existing install: today the
  // Home page IS just the Due Soon panel (or a blank box when nothing's
  // due) — so that's the one default widget, not an empty list. Nothing
  // about what a user sees changes on upgrade until they actually visit
  // Admin -> Home Screen and add more.
  return [{ id: 'due-soon-default', type: 'due-soon', config: {} }];
}

function ensureHomeWidgetsMigrated(schema) {
  if (!Array.isArray(schema.homeWidgets)) {
    schema.homeWidgets = migrateHomeWidgets(schema);
    return true;
  }
  return false;
}

function newWidgetId(type) {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function addHomeWidget(schema, type) {
  if (!WIDGET_TYPES[type]) throw new Error(`Unknown widget type "${type}".`);
  const widget = { id: newWidgetId(type), type, config: {} };
  schema.homeWidgets.push(widget);
  return widget;
}

function deleteHomeWidget(schema, id) {
  schema.homeWidgets = schema.homeWidgets.filter(w => w.id !== id);
}

function reorderHomeWidgets(schema, orderedIds) {
  const byId = {};
  schema.homeWidgets.forEach(w => { byId[w.id] = w; });
  schema.homeWidgets = orderedIds.map(id => byId[id]).filter(Boolean);
}

function updateHomeWidgetConfig(schema, id, config) {
  const widget = schema.homeWidgets.find(w => w.id === id);
  if (!widget) throw new Error('Unknown widget.');
  if (widget.type === 'quick-actions') {
    const validKeys = new Set(schema.navOrder.filter(k => schema.entities[k]));
    widget.config = { actions: (config.actions || []).filter(k => validKeys.has(k)) };
  } else if (widget.type === 'kpi-cards') {
    const validKeys = new Set(Object.keys(KPI_METRICS));
    widget.config = { metrics: (config.metrics || []).filter(k => validKeys.has(k)) };
  } else if (widget.type === 'announcement') {
    widget.config = { text: String(config.text || '').slice(0, 2000) };
  } else if (widget.type === 'report-card') {
    const reportDef = schemaLib.reportDefByKey(schema, config.reportKey);
    widget.config = { reportKey: reportDef ? reportDef.key : '' };
  } else if (widget.type === 'advance-tax-next-due' || widget.type === 'cc-bills-due' || widget.type === 'bills-due' || widget.type === 'uncleared-cheques') {
    // Generic column selection for any widget that declares a sourceTable.
    // The admin picks which fields from the underlying table to show;
    // the widget rendering resolves each one through the appropriate
    // formatter (FK → display name, picklist → label, formula → computed
    // value, currency → formatted, etc.). No hardcoded column lists.
    const raw = Array.isArray(config.columns) ? config.columns : (config.columns ? [config.columns] : []);
    const srcTable = WIDGET_TYPES[widget.type] && WIDGET_TYPES[widget.type].sourceTable;
    const srcEntity = srcTable && schema.entities[srcTable];
    const validFields = srcEntity ? new Set(srcEntity.fields.filter(f => !['spacer','section'].includes(f.type)).map(f => f.name)) : new Set();
    widget.config = { columns: raw.filter(c => validFields.has(c)) };
  }
  return widget;
}

// ---- Per-widget data computation -------------------------------------------

function computeDueSoon(schema, currentUser, limit, includeEmpty) {
  // Guard the schema shape BEFORE the permission-level shortcut — an
  // admin (whose permissions.can() short-circuits to true) on a fresh
  // install with no reminders table yet would otherwise reach the panel
  // logic with nothing behind it. Same reasoning as every other
  // schema-dependent widget: no table → widget doesn't exist yet.
  if (!schema.entities['reminders'] || !schema.entities['reminder_log']) return { available: false, reason: 'no reminders table' };
  const panel = remindersMod.dueSoonPanel(currentUser, limit || 8);
  if (!panel) return { available: false, reason: 'no permission' };
  // "Nothing due" and "can't see it" are genuinely different states, and
  // callers want different things. A dashboard widget should not render
  // an empty panel, so the default collapses both to unavailable. The
  // notification engine passes includeEmpty because its admin page needs
  // to report "0 items outstanding" rather than the far more alarming
  // "unavailable" for a family that simply has nothing overdue.
  if (panel.items.length === 0 && !includeEmpty) return { available: false, reason: 'nothing due' };
  return { available: true, panel };
}

function computeRentStatus(schema, currentUser) {
  const inv = schema.entities['invoices'];
  const settings = schema.taxSettings || {};
  const dateField = settings.invoiceDateField, rentField = settings.invoiceRentField, receivedField = settings.invoiceRentReceivedField;
  if (!inv || !dateField || !rentField || !receivedField) {
    return { available: false, reason: 'Rent Received field not mapped — see Admin \u2192 Tax Settings.' };
  }
  if (!usersLib.can(currentUser, 'invoices', 'read')) return { available: false, reason: 'no permission' };
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const needed = new Set([rentField]);
  let total = 0, totalAmount = 0, receivedCount = 0, receivedAmount = 0;
  db.getAll('invoices').forEach(row => {
    if (!String(row[dateField] || '').startsWith(ym)) return;
    const computed = schemaLib.withComputedFieldsSubset(schema, inv, row, needed);
    const amt = Number(computed[rentField]) || 0;
    total += 1;
    totalAmount += amt;
    const recd = Number(row[receivedField]) || 0;
    if (recd > 0) { receivedCount += 1; receivedAmount += recd; }
  });
  return { available: true, ym, total, totalAmount, receivedCount, receivedAmount, pendingCount: total - receivedCount };
}

function computeTaxAlerts(schema, currentUser) {
  const ll = schema.entities['landlords'];
  if (!ll || !schema.entities[taxMod.WORKSHEETS]) return { available: false };
  if (!usersLib.can(currentUser, taxMod.WORKSHEETS, 'read') || !usersLib.can(currentUser, taxMod.PAYMENTS, 'read')) {
    return { available: false, reason: 'no permission' };
  }
  const fy = taxMod.fyOfDateString(new Date().toISOString().slice(0, 10));
  const groupsByRoot = {};
  db.getAll('landlords').forEach(r => {
    const g = taxMod.landlordGroup(schema, r[ll.pk]);
    groupsByRoot[g.root] = g;
  });
  const worksheetsThisFy = db.getAll(taxMod.WORKSHEETS).filter(w => w.TW_FY === fy);
  const groupsWithWorksheet = new Set(worksheetsThisFy.map(w => taxMod.landlordGroup(schema, w.TW_Landlord).root));
  const missingGroups = Object.values(groupsByRoot).filter(g => !groupsWithWorksheet.has(g.root));
  const shortfalls = [];
  worksheetsThisFy.forEach(w => {
    try {
      const result = taxMod.computeWorksheet(schema, w);
      if (result.balance > 0) shortfalls.push({ worksheetId: w.TW_RowID, groupRoot: result.group.root, balance: result.balance });
    } catch (e) {
      // A single worksheet failing to compute (e.g. missing slabs for its
      // FY) shouldn't take the whole Home Screen down with it — the
      // worksheet's own page already surfaces that problem clearly.
    }
  });
  return { available: true, fy, missingGroups, shortfalls };
}

function computeBillsDue(schema, currentUser) {
  const items = schema.entities[billsMod.ITEMS];
  const entries = schema.entities[billsMod.ENTRIES];
  if (!items || !entries) return { available: false };
  if (!usersLib.can(currentUser, billsMod.ITEMS, 'read') || !usersLib.can(currentUser, billsMod.ENTRIES, 'read')) {
    return { available: false, reason: 'no permission' };
  }
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Group each item's recorded entry-months, then let the Bills module's own
  // cadence logic decide whether each item is currently due. Frequency-aware:
  // a quarterly/annual bill no longer shows as pending in the months between
  // its cycles, and Irregular bills never appear here at all. Same source of
  // truth as the Bills page and (via this function) the notification engine.
  const monthsByItem = {};
  db.getAll(billsMod.ENTRIES).forEach(en => {
    (monthsByItem[en.EE_Item] = monthsByItem[en.EE_Item] || []).push(en.EE_Month);
  });
  const due = db.getAll(billsMod.ITEMS)
    .filter(it => !it.EI_Archived)
    .map(it => ({ it, info: billsMod.billDueInfo(it, monthsByItem[it[items.pk]] || [], now) }))
    .filter(x => x.info.due)
    .map(x => {
      const full = schemaLib.withComputedFields(schema, items, x.it);
      return { ...full, _id: x.it[items.pk], _label: schemaLib.display(items, x.it, schema), _category: x.it.EI_Category || 'Other', _detail: x.info.detail };
    });
  return { available: true, ym, due, sourceTable: 'expense_items' };
}

function computeUnclearedCheques(schema, currentUser, limit) {
  const e = schema.entities['cheques'];
  if (!e) return { available: false };
  if (!usersLib.can(currentUser, 'cheques', 'read')) return { available: false, reason: 'no permission' };
  const rows = db.getAll('cheques')
    .filter(r => !r.CHQ_ClearDate)
    .map(r => ({ ...schemaLib.withComputedFields(schema, e, r), _id: r[e.pk] }))
    .sort((a, b) => String(a.CHQ_Date || '').localeCompare(String(b.CHQ_Date || '')));
  const total = rows.reduce((s, r) => s + (Number(r.CHQ_Amt) || 0), 0);
  const cap = limit || 8;
  return { available: true, rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap), total, count: rows.length, sourceTable: 'cheques' };
}

// Field names on the cctracker table this widget reads. Extracted as a
// constant so a schema-tolerant read (fallback to the correctly-cased
// name if a user later fixes their schema) is centralized here, and so a
// future move to a role-mapping pattern (like tax.js's taxSettings) has
// one clear place to hook into. `CCT_BIllAmount` (capital-I typo) is
// the actual field name in the shipped default schema — kept as the
// primary read for compatibility, with a lowercase-i alternative as a
// fallback for schemas that renamed it.
const CC_FIELDS = {
  billed: ['CCT_BIllAmount', 'CCT_BillAmount'],
  paid1: 'CCT_AmtPaid1', paid2: 'CCT_AmtPaid2',
  card: 'CCT_Card', creditCard: 'CCT_CreditCard', billDate: 'CCT_BillDt',
};
function ccBilledAmount(row) {
  for (const name of CC_FIELDS.billed) if (name in row) return Number(row[name]) || 0;
  return 0;
}

function computeCcBillsDue(schema, currentUser, limit) {
  const e = schema.entities['cctracker'];
  if (!e) return { available: false };
  if (!usersLib.can(currentUser, 'cctracker', 'read')) return { available: false, reason: 'no permission' };
  // If none of the alternates are present at all, the widget can't
  // compute anything meaningful — surface that clearly rather than
  // returning "0 bills due" against a schema that just doesn't have the
  // field this widget expects.
  const hasBilledField = e.fields.some(f => CC_FIELDS.billed.includes(f.name));
  if (!hasBilledField) return { available: false, reason: 'cctracker table has no bill-amount field this widget recognizes (expected one of: ' + CC_FIELDS.billed.join(', ') + ')' };
  const rows = db.getAll('cctracker')
    .filter(r => {
      const billed = ccBilledAmount(r);
      const paid = (Number(r[CC_FIELDS.paid1]) || 0) + (Number(r[CC_FIELDS.paid2]) || 0);
      return billed > 0 && paid < billed;
    })
    .map(r => {
      const billed = ccBilledAmount(r);
      const paid = (Number(r[CC_FIELDS.paid1]) || 0) + (Number(r[CC_FIELDS.paid2]) || 0);
      const full = schemaLib.withComputedFields(schema, e, r);
      return { ...full, _id: r[e.pk], _outstanding: billed - paid };
    })
    .sort((a, b) => String(a.billDate || '').localeCompare(String(b.billDate || '')));
  const total = rows.reduce((s, r) => s + r.outstanding, 0);
  const cap = limit || 8;
  return { available: true, rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap), total, count: rows.length };
}

// Across every real Advance Tax Projection, what's due by each one's own
// NEXT unpaid installment date, summed. A projection whose schedule is
// already fully covered by real payments contributes nothing, so this
// stays quiet on a year where nothing's actually owed yet.
function computeAdvanceTaxNextDue(schema, currentUser) {
  if (!schema.entities[taxMod.PROJECTIONS]) return { available: false };
  if (!usersLib.can(currentUser, taxMod.PROJECTIONS, 'read')) return { available: false, reason: 'no permission' };
  const pEntity = schema.entities[taxMod.PROJECTIONS];
  const rows = [];
  let total = 0;
  db.getAll(taxMod.PROJECTIONS).forEach(p => {
    let result;
    try { result = taxMod.computeProjection(schema, p); } catch (e) { return; }
    const nextDue = (result.schedule || []).find(inst => inst.shortfall > 0);
    if (!nextDue) return;
    total += nextDue.shortfall;
    // Resolve the landlord's display name from the fk, not the projection's
    // own PK (which is just an auto-number like "1", "2", "3").
    let landlordLabel = p.TJ_Landlord || '';
    const llEntity = schema.entities.landlords;
    if (llEntity && p.TJ_Landlord) {
      const llRow = db.getByIdActive('landlords', llEntity.pk, p.TJ_Landlord);
      if (llRow) landlordLabel = schemaLib.display(llEntity, llRow, schema);
    }
    const full = schemaLib.withComputedFields(schema, pEntity, p);
    rows.push({ ...full, _id: p[pEntity.pk], _landlordDisplay: landlordLabel, _installment: nextDue.label, _shortfall: nextDue.shortfall });
  });
  return { available: true, rows, total, sourceTable: 'tax_projections' };
}

function computeRecentActivity(schema, currentUser, limit) {
  if (!currentUser || !currentUser.isAdmin) return { available: false, reason: 'no permission' };
  const entries = audit.getRecent(limit || 8);
  // A brand-new install with no history yet is not something worth
  // rendering an empty "Recent Activity" panel for — omit until there's
  // actually activity to show, then it appears on its own.
  if (!entries || entries.length === 0) return { available: false, reason: 'no activity yet' };
  return { available: true, entries };
}

function computeAnnouncement(widget) {
  const text = (widget.config && widget.config.text) || '';
  if (!text.trim()) return { available: false };
  return { available: true, text };
}

// Points at an existing, real Report rather than a widget-specific query
// — reuses the same filter/aggregate engine Reports already has, rather
// than a second, parallel customization system. Runs with no parameter
// values, same as opening the report fresh with no filters entered.
function computeSystemHealth(schema) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  // CPU: load average (1min)
  const load1 = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const cpuPct = Math.min(100, Math.round((load1 / cpuCount) * 100));
  // RAM
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const ramPct = Math.round((usedMem / totalMem) * 100);
  // Storage: size of the data directory
  const dataDir = path.join(__dirname, 'data');
  let dataSizeBytes = 0;
  try {
    fs.readdirSync(dataDir).forEach(f => {
      try { dataSizeBytes += fs.statSync(path.join(dataDir, f)).size; } catch (e) { /* skip */ }
    });
  } catch (e) { /* data dir may not exist yet */ }
  // Data health: count of tables + total rows + any schema.entities with no pk
  const tables = Object.keys(schema.entities || {});
  let totalRows = 0;
  let tablesWithIssues = 0;
  tables.forEach(k => {
    const e = schema.entities[k];
    const rows = db.getAll(k);
    totalRows += rows.length;
    if (!e.pk || !e.fields.some(f => f.key)) tablesWithIssues++;
  });
  return {
    available: true,
    cpu: { pct: cpuPct, load1: load1.toFixed(2), cores: cpuCount },
    ram: { pct: ramPct, usedMB: Math.round(usedMem / 1048576), totalMB: Math.round(totalMem / 1048576) },
    storage: { dataKB: Math.round(dataSizeBytes / 1024) },
    dataHealth: { tables: tables.length, totalRows, tablesWithIssues },
  };
}

function computeReportCard(schema, widget, currentUser) {
  const key = widget.config && widget.config.reportKey;
  if (!key) return { available: false };
  const reportDef = schemaLib.reportDefByKey(schema, key);
  if (!reportDef) return { available: false };
  if (!usersLib.can(currentUser, reportDef.baseTable, 'read')) return { available: false, reason: 'no permission' };
  let result;
  try { result = schemaLib.runReport(schema, reportDef, {}); } catch (e) { return { available: false }; }
  return { available: true, label: reportDef.label, key, result };
}

function computeQuickActions(schema, widget, currentUser) {
  const keys = (widget.config && widget.config.actions) || [];
  const items = keys
    .filter(k => schema.entities[k] && usersLib.can(currentUser, k, 'create'))
    .map(k => ({ key: k, label: schema.entities[k].label }));
  if (items.length === 0) return { available: false };
  return { available: true, items };
}

function computeKpiCards(schema, widget, currentUser) {
  const keys = (widget.config && widget.config.metrics) || [];
  const cards = keys
    .filter(k => KPI_METRICS[k])
    .map(k => ({ key: k, label: KPI_METRICS[k].label, value: KPI_METRICS[k].compute(schema, currentUser) }))
    .filter(c => c.value !== null && c.value !== undefined);
  if (cards.length === 0) return { available: false };
  return { available: true, cards };
}

// The one function views/landing.ejs actually calls: turns
// schema.homeWidgets into a ready-to-render array, each widget's own data
// already computed. A widget type with no read permission on what it
// needs (Reminders, Tax Worksheets) is dropped entirely rather than shown
// broken — same reasoning as the sidebar filtering by permission.
function computeHomeWidgets(schema, currentUser) {
  return schema.homeWidgets
    .map(widget => {
      let data;
      if (widget.type === 'due-soon') data = computeDueSoon(schema, currentUser);
      else if (widget.type === 'rent-status') data = computeRentStatus(schema, currentUser);
      else if (widget.type === 'tax-alerts') data = computeTaxAlerts(schema, currentUser);
      else if (widget.type === 'quick-actions') data = computeQuickActions(schema, widget, currentUser);
      else if (widget.type === 'kpi-cards') data = computeKpiCards(schema, widget, currentUser);
      else if (widget.type === 'bills-due') data = computeBillsDue(schema, currentUser);
      else if (widget.type === 'uncleared-cheques') data = computeUnclearedCheques(schema, currentUser);
      else if (widget.type === 'cc-bills-due') data = computeCcBillsDue(schema, currentUser);
      else if (widget.type === 'advance-tax-next-due') data = computeAdvanceTaxNextDue(schema, currentUser);
      else if (widget.type === 'recent-activity') data = computeRecentActivity(schema, currentUser);
      else if (widget.type === 'announcement') data = computeAnnouncement(widget);
      else if (widget.type === 'report-card') data = computeReportCard(schema, widget, currentUser);
      else if (widget.type === 'system-health') data = computeSystemHealth(schema);
      else data = { available: false };
      return { id: widget.id, type: widget.type, config: widget.config, data };
    })
    .filter(w => w.data && w.data.available);
}

module.exports = {
  WIDGET_TYPES, KPI_METRICS, kpiEligibleEntities,
  ensureHomeWidgetsMigrated, addHomeWidget, deleteHomeWidget, reorderHomeWidgets, updateHomeWidgetConfig,
  computeHomeWidgets,
  // Individual computations are exported so notify.js can drive alerts
  // from the SAME due-logic the dashboard shows. Anything needing "what
  // is outstanding right now" calls these rather than re-deriving it, so
  // a notification can never disagree with the Home screen, and a fix to
  // due-logic lands in both at once. The optional `limit` args exist for
  // the same reason: the widgets cap at 8 rows for layout, but an alert
  // that silently ignored the 9th outstanding item would be a bug.
  computeDueSoon, computeRentStatus, computeTaxAlerts, computeBillsDue,
  computeUnclearedCheques, computeCcBillsDue, computeAdvanceTaxNextDue,
};
