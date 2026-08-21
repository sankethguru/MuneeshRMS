// tax.js
//
// Income-tax / advance-tax computation per landlord per financial year —
// the replacement for the Excel "ITAY / Adv Tax" tab. Design decisions
// (confirmed with the owner before building):
//
//   * BOTH regimes supported, chosen per worksheet (TW_Regime).
//   * Surcharge with FULL marginal relief (not the sheet's flat 10%/15%).
//   * Advance-tax installments recorded in a dedicated child table
//     (tax_payments), one row per challan.
//
// Everything rate-shaped lives in DATA, not code: slab rows (tax_slabs)
// and per-FY-per-regime scalars (tax_config: cess, 87A rebate, surcharge
// tiers) are ordinary tables — a Budget change is an Admin edit, never a
// deploy. Seeded values below cover FY 2025-26 and 2026-27 and MUST be
// verified with the family's auditor; the computation page says so out
// loud. The 30% standard deduction on house property (s.24a) and the
// 15/45/75/100 advance-tax schedule (s.211) are structural law, not
// rates, and live in code.
//
// Rent and TDS are pulled from invoices automatically on ACCRUAL basis
// (invoice date decides the FY), ex-GST — I_BaseRent, matching the
// sheet's rent-roll block. Bank interest, loan interest, municipal taxes
// etc. are manual worksheet inputs.
//
// Same embedded-module pattern as bills.js/reminders.js: real schema
// tables, standard forms for data entry, custom routes only for the
// computation view and its print version.

const express = require('express');
const schemaLib = require('./schema');
const db = require('./db');
const usersLib = require('./users');
const audit = require('./audit');

const router = express.Router();

const INCOME_HEAD_FIELD = 'T_IncomeHead';
const WORKSHEETS = 'tax_worksheets';
const PAYMENTS = 'tax_payments';
const SLABS = 'tax_slabs';
const CONFIG = 'tax_config';
const PROJECTIONS = 'tax_projections';
const PROJECTION_ROWS = 'tax_projection_rows';

// ---- Seeded rates (data, admin-editable, auditor-verifiable) --------------
// Slab rows: [floor, ceiling (null = no ceiling), rate].
const SEED_SLABS = {
  'New': [
    [0, 400000, 0], [400000, 800000, 0.05], [800000, 1200000, 0.10],
    [1200000, 1600000, 0.15], [1600000, 2000000, 0.20],
    [2000000, 2400000, 0.25], [2400000, null, 0.30],
  ],
  'Old': [
    [0, 250000, 0], [250000, 500000, 0.05], [500000, 1000000, 0.20], [1000000, null, 0.30],
  ],
};
// Surcharge tiers as "threshold:rate" pairs, ascending. New regime caps at
// 25% (no 37% tier); old regime keeps it.
const SEED_CONFIG = {
  'New': { cess: 0.04, rebateLimit: 1200000, rebateMax: 60000, surcharge: '5000000:0.10, 10000000:0.15, 20000000:0.25' },
  'Old': { cess: 0.04, rebateLimit: 500000, rebateMax: 12500, surcharge: '5000000:0.10, 10000000:0.15, 20000000:0.25, 50000000:0.37' },
};
const SEED_FYS = ['2025-26', '2026-27'];

// ---- First-boot table creation --------------------------------------------
function ensureTaxTables() {
  const schema = schemaLib.load();
  let changed = false;
  if (!schema.entities[SLABS]) { addSlabsTable(schema); changed = true; }
  if (!schema.entities[CONFIG]) { addConfigTable(schema); changed = true; }
  if (!schema.entities[WORKSHEETS]) { addWorksheetsTable(schema); changed = true; }
  if (!schema.entities[PAYMENTS]) { addPaymentsTable(schema); changed = true; }
  if (!schema.entities[PROJECTIONS]) { addProjectionsTable(schema); changed = true; }
  if (!schema.entities[PROJECTION_ROWS]) { addProjectionRowsTable(schema); changed = true; }
  // One-time migration: guesses the conventional field names for Tax
  // Settings (Admin -> Tax Settings) so an install that already has a
  // real, working Tax module (LL_GroupRoot, I_Date, I_BaseRent, etc.)
  // doesn't suddenly need re-configuring after this setting was
  // introduced. Each guess is validated against the real role's type
  // requirement before being accepted — a name match alone isn't enough,
  // since a same-named field of the wrong type would be a worse outcome
  // than leaving the role unmapped. An install with genuinely different
  // field names correctly ends up with those roles unmapped, and gets
  // the loud "not configured" guard rather than a silently wrong guess.
  // Runs only once — never overwrites settings that already exist, even
  // partially, since an admin may have deliberately cleared one.
  if (!schema.taxSettings) {
    const guesses = {
      landlordGroupField: 'LL_GroupRoot', invoiceDateField: 'I_Date', invoiceRentField: 'I_BaseRent',
      invoiceTdsField: 'I_TDSDep', landlordPanField: 'LL_PAN', landlordGstinField: 'LL_GSTIN',
      landlordAddressField: 'LL_Address', landlordPhoneField: 'LL_Phone', landlordEmailField: 'LL_email',
      invoiceRentReceivedField: 'I_RentRecd',
    };
    const next = {};
    Object.keys(schemaLib.TAX_FIELD_ROLES).forEach(key => {
      const role = schemaLib.TAX_FIELD_ROLES[key];
      const entity = schema.entities[role.entity];
      const guessedName = guesses[key];
      const f = entity && guessedName && entity.fields.find(fl => fl.name === guessedName);
      next[key] = (f && role.types.includes(f.type)) ? guessedName : '';
    });
    schema.taxSettings = next;
    changed = true;
  } else if (!('invoiceRentReceivedField' in schema.taxSettings)) {
    // Additive migration for a schema whose taxSettings already existed
    // before this specific role was added — the "whole object missing"
    // branch above only ever runs once, so an already-migrated install
    // needs this one new key filled in on its own, same guess-and-
    // validate approach, not left silently absent.
    const invEntity = schema.entities['invoices'];
    const f = invEntity && invEntity.fields.find(fl => fl.name === 'I_RentRecd');
    const role = schemaLib.TAX_FIELD_ROLES.invoiceRentReceivedField;
    schema.taxSettings.invoiceRentReceivedField = (f && role.types.includes(f.type)) ? 'I_RentRecd' : '';
    changed = true;
  }
  // Income-head classification lives on the OWNER's tenants table, not on
  // a module table: whether rent is House Property (building) or Other
  // Sources (vacant land, plant & machinery) is a fact about the tenancy,
  // set once per tenant revision. Added here idempotently so existing
  // installs pick it up on upgrade; blank means House Property, so no
  // existing revision needs editing to keep its current treatment.
  const tenants = schema.entities['tenants'];
  if (tenants && !tenants.fields.some(f => f.name === INCOME_HEAD_FIELD)) {
    schemaLib.addField(schema, 'tenants', {
      name: INCOME_HEAD_FIELD, label: 'Income Head', type: 'picklist',
      picklistValues: schemaLib.picklistValuesFromCsv('House Property, Other Sources'),
      hint: 'How this rent is taxed. House Property (default when blank): building rent — gets municipal-tax deduction and the 30% standard deduction. Other Sources: vacant land, plant & machinery etc. — no such deductions.',
    });
    changed = true;
  }
  // Existing installs created TW_BankInterest before incomeoth was pulled
  // automatically — refresh its label/hint so nobody double-enters
  // interest that now arrives on its own. Value semantics unchanged.
  const ws = schema.entities[WORKSHEETS];
  if (ws) {
    const bi = ws.fields.find(f => f.name === 'TW_BankInterest');
    if (bi && bi.label !== 'Additional Interest (₹)') {
      bi.label = 'Additional Interest (₹)';
      bi.hint = 'Interest NOT tracked in Income (Other) — interest logged there per bank account is pulled automatically per head; entering it here again would double-count.';
      changed = true;
    }
  }
  // One-time migration: TP_Worksheet (a required fk straight to one
  // specific worksheet row, which made a payment impossible to record
  // before that worksheet existed) is replaced by TP_Landlord + TP_FY,
  // matched to whichever worksheet covers the same group+FY at
  // computation time instead of being pinned to one row. Reads each
  // existing payment's own worksheet to derive its real landlord/FY
  // before TP_Worksheet disappears, so nothing gets orphaned.
  const paymentsEntity = schema.entities[PAYMENTS];
  if (paymentsEntity && paymentsEntity.fields.some(f => f.name === 'TP_Worksheet')) {
    const hasLandlords = !!schema.entities['landlords'];
    if (!paymentsEntity.fields.some(f => f.name === 'TP_Landlord')) {
      const spec = hasLandlords
        ? { name: 'TP_Landlord', label: 'Landlord / Assessee', type: 'fk', ref: 'landlords', required: true, inList: true }
        : { name: 'TP_Landlord', label: 'Assessee', type: 'text', required: true, inList: true };
      schemaLib.addField(schema, PAYMENTS, spec);
    }
    if (!paymentsEntity.fields.some(f => f.name === 'TP_FY')) {
      schemaLib.addField(schema, PAYMENTS, { name: 'TP_FY', label: 'Financial Year', type: 'text', required: true, inList: true });
    }
    const worksheetsByRowId = {};
    db.getAll(WORKSHEETS).forEach(w => { worksheetsByRowId[w.TW_RowID] = w; });
    db.getAll(PAYMENTS).forEach(row => {
      const w = worksheetsByRowId[row.TP_Worksheet];
      db.update(PAYMENTS, paymentsEntity.pk, row[paymentsEntity.pk], {
        TP_Landlord: w ? w.TW_Landlord : '',
        TP_FY: w ? w.TW_FY : '',
      });
    });
    // Drop the retired field from BOTH the schema AND every row's data —
    // deleteField alone only removes it from the schema, which leaves
    // invisible-but-stale TP_Worksheet properties on every payment row.
    // A future field-add that happened to reuse the same name would then
    // silently resurface those old values. dropFieldFromRows scrubs it
    // from row data first so the schema deletion is genuinely complete.
    db.dropFieldFromRows(PAYMENTS, 'TP_Worksheet');
    schemaLib.deleteField(schema, PAYMENTS, 'TP_Worksheet');
    paymentsEntity.listColumns = ['TP_RowID', 'TP_Landlord', 'TP_FY', 'TP_Date', 'TP_Amount', 'TP_Challan'];
    paymentsEntity.filterFields = ['TP_Landlord', 'TP_FY'];
    changed = true;
  }
  if (changed) schemaLib.persist(schema);
  // Runs every boot, not just at first creation — see the matching
  // comment in bills.js's ensureBillsTables for why this needs to be
  // unconditional rather than only running inside each addXTable's own
  // "table doesn't exist yet" branch above.
  let navChanged = false;
  if (schemaLib.removeNav(schema, SLABS)) navChanged = true;
  if (schemaLib.removeNav(schema, CONFIG)) navChanged = true;
  if (schemaLib.removeNav(schema, PAYMENTS)) navChanged = true;
  if (navChanged) { schemaLib.persist(schema); changed = true; }
  // Seeding is deliberately decoupled from table CREATION: restoring a
  // backup whose schema already has these tables but whose db.json
  // predates the rates leaves both tables present-but-empty — the exact
  // state a fresh seed exists to fix. Only when BOTH are empty, though: a
  // single empty table alongside a populated one means someone is
  // mid-edit, and re-seeding would dump duplicates on them.
  if (schema.entities[SLABS] && schema.entities[CONFIG]
      && db.getAll(SLABS).length === 0 && db.getAll(CONFIG).length === 0) {
    seedRates();
    changed = true;
  }
  return changed;
}

function addSlabsTable(schema) {
  schemaLib.addEntity(schema, { key: SLABS, label: 'Tax Slabs', singular: 'Tax Slab', pkName: 'TS_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, SLABS, spec);
  add({ name: 'TS_FY', label: 'Financial Year', type: 'text', required: true, inList: true, hint: 'Format 2026-27.' });
  add({ name: 'TS_Regime', label: 'Regime', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv('New, Old'), required: true, inList: true });
  add({ name: 'TS_Floor', label: 'From (₹)', type: 'currency', required: true, inList: true });
  add({ name: 'TS_Ceiling', label: 'To (₹)', type: 'currency', inList: true, hint: 'Leave blank for the top slab (no upper limit).' });
  add({ name: 'TS_Rate', label: 'Rate', type: 'number', required: true, inList: true, hint: 'As a fraction: 0.05 for 5%, 0.30 for 30%.' });
  const e = schema.entities[SLABS];
  e.listColumns = ['TS_FY', 'TS_Regime', 'TS_Floor', 'TS_Ceiling', 'TS_Rate'];
  e.filterFields = ['TS_FY', 'TS_Regime'];
  e.sortField = 'TS_Floor';
  e.auditEnabled = true;
  schemaLib.removeNav(schema, SLABS);
}

function addConfigTable(schema) {
  schemaLib.addEntity(schema, { key: CONFIG, label: 'Tax Config', singular: 'Tax Config Row', pkName: 'TC_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, CONFIG, spec);
  add({ name: 'TC_FY', label: 'Financial Year', type: 'text', required: true, inList: true });
  add({ name: 'TC_Regime', label: 'Regime', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv('New, Old'), required: true, inList: true });
  add({ name: 'TC_CessRate', label: 'Cess Rate', type: 'number', required: true, inList: true, hint: '0.04 = 4% health & education cess.' });
  add({ name: 'TC_RebateIncomeLimit', label: '87A Income Limit (₹)', type: 'currency', inList: true, hint: 'Total income at or below this qualifies for the s.87A rebate.' });
  add({ name: 'TC_RebateMax', label: '87A Max Rebate (₹)', type: 'currency', inList: true });
  add({ name: 'TC_Surcharge', label: 'Surcharge Tiers', type: 'text', inList: true, hint: 'Comma-separated "threshold:rate" pairs, ascending. e.g. 5000000:0.10, 10000000:0.15' });
  const e = schema.entities[CONFIG];
  e.listColumns = ['TC_FY', 'TC_Regime', 'TC_CessRate', 'TC_RebateIncomeLimit', 'TC_RebateMax', 'TC_Surcharge'];
  e.filterFields = ['TC_FY', 'TC_Regime'];
  e.sortField = 'TC_FY';
  e.auditEnabled = true;
  schemaLib.removeNav(schema, CONFIG);
}

function addWorksheetsTable(schema) {
  schemaLib.addEntity(schema, { key: WORKSHEETS, label: 'Tax Worksheets', singular: 'Tax Worksheet', pkName: 'TW_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, WORKSHEETS, spec);
  const hasLandlords = !!schema.entities['landlords'];
  // The fk to landlords only exists when the landlords table does — a
  // fresh install without that table still gets a working module with a
  // free-text assessee name.
  if (hasLandlords) add({ name: 'TW_Landlord', label: 'Landlord / Assessee', type: 'fk', ref: 'landlords', required: true, inList: true, hint: 'Pick ANY GST version of the assessee — the computation covers the whole landlord group (all state registrations) automatically.' });
  else add({ name: 'TW_Landlord', label: 'Assessee', type: 'text', required: true, inList: true });
  add({ name: 'TW_FY', label: 'Financial Year', type: 'text', required: true, inList: true, hint: 'Format 2026-27. Rent and TDS are pulled from invoices dated inside this FY.' });
  add({ name: 'TW_Regime', label: 'Regime', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv('New, Old'), required: true, defaultMode: 'static', defaultValue: 'New', inList: true });
  add({ name: 'TW_MunicipalTaxes', label: 'Municipal Taxes Paid (₹)', type: 'currency', hint: 'BBMP etc., actually PAID in the FY, for let-out properties. Deducted from gross rent before the 30% standard deduction.' });
  add({ name: 'TW_LoanInterest', label: 'Housing Loan Interest (₹)', type: 'currency', hint: 's.24(b) interest on let-out property loans.' });
  add({ name: 'TW_BankInterest', label: 'Additional Interest (₹)', type: 'currency', hint: 'Interest NOT tracked in Income (Other) — interest logged there per bank account is pulled automatically per head; entering it here again would double-count.' });
  add({ name: 'TW_OtherIncome', label: 'Other Income (₹)', type: 'currency', hint: 'Any other taxable income: ground rent of vacant land, dividends, etc.' });
  add({ name: 'TW_OtherDeductions', label: 'Other Deductions (₹)', type: 'currency', hint: 'Enter ONLY deductions valid under the chosen regime (e.g. 80C/80D under Old; almost none under New). Verified by your auditor, not this app.' });
  add({ name: 'TW_TDSOther', label: 'Other TDS/TCS Credit (₹)', type: 'currency', hint: 'TDS beyond rent TDS — e.g. banks on FD interest. Rent TDS is pulled from invoices automatically.' });
  add({ name: 'TW_Notes', label: 'Notes', type: 'textarea', rows: 2 });
  const e = schema.entities[WORKSHEETS];
  e.listColumns = ['TW_RowID', 'TW_Landlord', 'TW_FY', 'TW_Regime'];
  e.filterFields = ['TW_FY', 'TW_Regime'];
  e.sortField = 'TW_FY';
  e.sortDir = 'desc';
  e.listTitle = 'Tax Worksheets';
  e.auditEnabled = true;
}

function addPaymentsTable(schema) {
  schemaLib.addEntity(schema, { key: PAYMENTS, label: 'Advance Tax Payments', singular: 'Advance Tax Payment', pkName: 'TP_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, PAYMENTS, spec);
  const hasLandlords = !!schema.entities['landlords'];
  // Same landlord/FY shape as Tax Worksheets, deliberately — a payment is
  // now independent of whether a worksheet already exists, matched to a
  // worksheet later by group+FY (same landlordGroup() every other pull in
  // this module already uses for rent/TDS), not by pointing at one
  // worksheet's own row. Real installments (June/Sept/Dec/March) are
  // naturally paid well before there's necessarily a reason to sit down
  // and build the full worksheet — the old TP_Worksheet fk made that
  // genuinely impossible to record until the worksheet existed first.
  if (hasLandlords) add({ name: 'TP_Landlord', label: 'Landlord / Assessee', type: 'fk', ref: 'landlords', required: true, inList: true, hint: 'Pick ANY GST version of the assessee — matched to the whole landlord group automatically, same as on a Tax Worksheet.' });
  else add({ name: 'TP_Landlord', label: 'Assessee', type: 'text', required: true, inList: true });
  add({ name: 'TP_FY', label: 'Financial Year', type: 'text', required: true, inList: true, hint: 'Format 2026-27 — same FY this installment counts toward, whether or not a worksheet exists yet.' });
  add({ name: 'TP_Date', label: 'Paid On', type: 'date', required: true, inList: true });
  add({ name: 'TP_Amount', label: 'Amount (₹)', type: 'currency', required: true, inList: true });
  add({ name: 'TP_Challan', label: 'Challan / CIN', type: 'text', inList: true });
  add({ name: 'TP_Note', label: 'Note', type: 'text' });
  const e = schema.entities[PAYMENTS];
  e.listColumns = ['TP_RowID', 'TP_Landlord', 'TP_FY', 'TP_Date', 'TP_Amount', 'TP_Challan'];
  e.filterFields = ['TP_Landlord', 'TP_FY'];
  e.sortField = 'TP_Date';
  e.sortDir = 'desc';
  e.auditEnabled = true;
  schemaLib.removeNav(schema, PAYMENTS);
}

// ---- Advance Tax Projections -----------------------------------------
// A separate, clearly-labeled "what if" tool sitting alongside the real
// Tax Worksheet, not a replacement for it: projects a FULL YEAR'S rent
// per tenant (rate x months, the same whole-month approximation the
// user's own working sheet already uses and already tolerates) rather
// than trying to be a precise day-count engine. One row per FY+landlord
// group, revisited and adjusted through the year — see computeProjection
// for how a row's numbers actually turn into an advance-tax figure.
function addProjectionsTable(schema) {
  schemaLib.addEntity(schema, { key: PROJECTIONS, label: 'Advance Tax Projections', singular: 'Advance Tax Projection', pkName: 'TJ_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, PROJECTIONS, spec);
  const hasLandlords = !!schema.entities['landlords'];
  if (hasLandlords) add({ name: 'TJ_Landlord', label: 'Landlord / Assessee', type: 'fk', ref: 'landlords', required: true, inList: true, hint: 'Pick ANY GST version of the assessee — the projection covers the whole landlord group automatically, same as a Tax Worksheet.' });
  else add({ name: 'TJ_Landlord', label: 'Assessee', type: 'text', required: true, inList: true });
  add({ name: 'TJ_FY', label: 'Financial Year', type: 'text', required: true, inList: true, hint: 'Format 2026-27.' });
  add({ name: 'TJ_Regime', label: 'Regime', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv('New, Old'), required: true, defaultMode: 'static', defaultValue: 'New', inList: true });
  add({ name: 'TJ_MunicipalTaxes', label: 'Municipal Taxes (₹, expected)', type: 'currency' });
  add({ name: 'TJ_LoanInterest', label: 'Housing Loan Interest (₹, expected)', type: 'currency' });
  add({ name: 'TJ_OtherIncome', label: 'Other Income (₹, expected — interest, etc.)', type: 'currency' });
  add({ name: 'TJ_OtherDeductions', label: 'Other Deductions (₹, expected)', type: 'currency' });
  add({ name: 'TJ_OtherTds', label: 'Other TDS Credit (₹, expected)', type: 'currency' });
  add({ name: 'TJ_Notes', label: 'Assumptions / Notes', type: 'textarea' });
  const e = schema.entities[PROJECTIONS];
  e.listColumns = ['TJ_RowID', 'TJ_Landlord', 'TJ_FY', 'TJ_Regime'];
  e.filterFields = ['TJ_Landlord', 'TJ_FY'];
  e.sortField = 'TJ_FY';
  e.sortDir = 'desc';
  e.auditEnabled = true;
}

function addProjectionRowsTable(schema) {
  schemaLib.addEntity(schema, { key: PROJECTION_ROWS, label: 'Advance Tax Projection Rows', singular: 'Projection Row', pkName: 'TJR_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, PROJECTION_ROWS, spec);
  add({ name: 'TJR_Projection', label: 'Projection', type: 'fk', ref: PROJECTIONS, required: true, inList: true });
  add({ name: 'TJR_PropType', label: 'Prop Type', type: 'picklist', picklistValues: schemaLib.picklistValuesFromCsv('Building, Land'), inList: true, hint: 'Building = House Property, Land = Other Sources — auto-filled from the linked tenant when one is picked.' });
  const hasTenants = !!schema.entities['tenants'];
  if (hasTenants) add({ name: 'TJR_Tenant', label: 'Tenant', type: 'fk', ref: 'tenants', inList: true, hint: 'Optional — pick a real tenant to auto-fill the row and enable the actual-vs-projected check below. Leave blank for a hypothetical/not-yet-signed lease.' });
  add({ name: 'TJR_Label', label: 'Label', type: 'text', required: true, inList: true, hint: 'Auto-filled from the linked tenant if one is picked; type your own for a hypothetical row.' });
  add({ name: 'TJR_Rental', label: 'Rental (₹/month)', type: 'currency', required: true, inList: true });
  add({ name: 'TJR_TDSDebitor', label: 'TDS Debitor', type: 'bool', inList: true });
  add({ name: 'TJR_TDSPercent', label: 'TDS %', type: 'percent', defaultMode: 'static', defaultValue: '0.10', inList: true });
  add({ name: 'TJR_Months', label: 'Months', type: 'number', required: true, inList: true, hint: 'Auto-suggested from the linked tenant\u2019s own tenancy dates (whole months, not day-counted) — always yours to edit.' });
  add({ name: 'TJR_TotalRent', label: 'Total Rent (₹)', type: 'formula', formula: 'TJR_Rental * TJR_Months', inList: true });
  add({ name: 'TJR_TotalTDS', label: 'Total TDS (₹)', type: 'formula', formula: 'IF(TJR_TDSDebitor, TJR_TotalRent * TJR_TDSPercent, 0)', inList: true });
  const e = schema.entities[PROJECTION_ROWS];
  e.listColumns = ['TJR_RowID', 'TJR_PropType', 'TJR_Label', 'TJR_Rental', 'TJR_TDSDebitor', 'TJR_TDSPercent', 'TJR_Months', 'TJR_TotalRent', 'TJR_TotalTDS'];
  e.filterFields = ['TJR_Projection'];
  e.auditEnabled = true;
  schemaLib.removeNav(schema, PROJECTION_ROWS);
}

function seedRates() {
  const schema = schemaLib.load();
  const slabEntity = schema.entities[SLABS];
  const cfgEntity = schema.entities[CONFIG];
  SEED_FYS.forEach(fy => {
    Object.entries(SEED_SLABS).forEach(([regime, rows]) => {
      rows.forEach(([floor, ceiling, rate]) => {
        db.insert(SLABS, { [slabEntity.pk]: db.nextAutoId(SLABS, slabEntity.pk), TS_FY: fy, TS_Regime: regime, TS_Floor: floor, TS_Ceiling: ceiling === null ? '' : ceiling, TS_Rate: rate });
      });
    });
    Object.entries(SEED_CONFIG).forEach(([regime, c]) => {
      db.insert(CONFIG, { [cfgEntity.pk]: db.nextAutoId(CONFIG, cfgEntity.pk), TC_FY: fy, TC_Regime: regime, TC_CessRate: c.cess, TC_RebateIncomeLimit: c.rebateLimit, TC_RebateMax: c.rebateMax, TC_Surcharge: c.surcharge });
    });
  });
}

// ---- Pure computation engine (exported for tests) -------------------------

// Progressive slab tax on a taxable income, given slab rows shaped like
// the tax_slabs table. Rows are sorted by floor; a blank/null ceiling
// means "no upper limit".
function slabTax(income, slabRows) {
  const rows = slabRows
    .map(r => ({ floor: Number(r.TS_Floor) || 0, ceiling: r.TS_Ceiling === '' || r.TS_Ceiling === null || r.TS_Ceiling === undefined ? Infinity : Number(r.TS_Ceiling), rate: Number(r.TS_Rate) || 0 }))
    .sort((a, b) => a.floor - b.floor);
  let tax = 0;
  rows.forEach(s => {
    if (income <= s.floor) return;
    tax += (Math.min(income, s.ceiling) - s.floor) * s.rate;
  });
  return tax;
}

function parseSurchargeTiers(text) {
  return String(text || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const [t, r] = pair.split(':');
      return { threshold: Number(t), rate: Number(r) };
    })
    .filter(t => Number.isFinite(t.threshold) && Number.isFinite(t.rate))
    .sort((a, b) => a.threshold - b.threshold);
}

// Surcharge with FULL marginal relief. The relief rule: crossing a
// surcharge threshold can never cost more tax+surcharge than the income
// earned above that threshold. Formally, for the applicable tier T:
//   payable = min( tax*(1+rate),  taxAtThreshold*(1+prevRate) + (income - T) )
// where taxAtThreshold is slab tax computed AT the threshold income and
// prevRate is the surcharge rate that applied just below it. Returns the
// surcharge amount (possibly reduced), never negative.
function surchargeWithMarginalRelief(income, tax, tiers, slabRows) {
  let applicable = null, prevRate = 0;
  tiers.forEach(t => {
    if (income > t.threshold) { prevRate = applicable ? applicable.rate : 0; applicable = t; }
  });
  if (!applicable) return { rate: 0, amount: 0, marginalRelief: 0 };
  const raw = tax * applicable.rate;
  const taxAtThreshold = slabTax(applicable.threshold, slabRows);
  const capTotal = taxAtThreshold * (1 + prevRate) + (income - applicable.threshold);
  const total = tax + raw;
  if (total <= capTotal) return { rate: applicable.rate, amount: raw, marginalRelief: 0 };
  const amount = Math.max(0, capTotal - tax);
  return { rate: applicable.rate, amount, marginalRelief: raw - amount };
}

// s.288A: total income rounds to the nearest ₹10.
function roundIncome(n) { return Math.round(n / 10) * 10; }
// s.288B: tax payable rounds to the nearest ₹10.
function roundTax(n) { return Math.round(n / 10) * 10; }

// The full cascade. inputs:
//   { grossRent, otherSourcesRent, municipalTaxes, loanInterest,
//     bankInterest, otherIncome, otherDeductions, rentTds, otherTds }
// grossRent is HOUSE PROPERTY rent only; otherSourcesRent (vacant land,
// plant & machinery) bypasses the s.23/s.24 cascade entirely.
// rates: { slabRows, config: { cess, rebateLimit, rebateMax, surchargeTiers } }
// Returns every intermediate line the computation page prints.
function computeTax(inputs, rates) {
  const n = (x) => Number(x) || 0;
  const gav = n(inputs.grossRent);
  const municipal = Math.min(n(inputs.municipalTaxes), gav);
  const nav = gav - municipal;
  const stdDeduction = nav * 0.30;                       // s.24(a), structural
  const loanInterest = n(inputs.loanInterest);
  const houseProperty = nav - stdDeduction - loanInterest; // may be negative (loss)

  const otherSourcesRent = n(inputs.otherSourcesRent);
  const trackedInterest = n(inputs.trackedInterest);
  const otherSources = otherSourcesRent + trackedInterest + n(inputs.bankInterest) + n(inputs.otherIncome);
  const grossTotal = houseProperty + otherSources;
  const deductions = Math.min(n(inputs.otherDeductions), Math.max(0, grossTotal));
  const totalIncome = roundIncome(Math.max(0, grossTotal - deductions));

  const baseTax = slabTax(totalIncome, rates.slabRows);

  // s.87A rebate: applies only when total income is within the limit.
  const cfg = rates.config;
  let rebate = 0;
  if (cfg.rebateLimit && totalIncome <= cfg.rebateLimit) rebate = Math.min(baseTax, cfg.rebateMax || 0);
  const taxAfterRebate = baseTax - rebate;

  const sur = surchargeWithMarginalRelief(totalIncome, taxAfterRebate, cfg.surchargeTiers || [], rates.slabRows);
  const cess = (taxAfterRebate + sur.amount) * (cfg.cess || 0);
  const totalLiability = roundTax(taxAfterRebate + sur.amount + cess);

  const rentTds = n(inputs.rentTds), otherTds = n(inputs.otherTds);
  const netPayable = totalLiability - rentTds - otherTds;   // negative = refund due

  return {
    gav, municipal, nav, stdDeduction, loanInterest, houseProperty,
    otherSourcesRent, trackedInterest, bankInterest: n(inputs.bankInterest), otherIncome: n(inputs.otherIncome), otherSources,
    grossTotal, deductions, totalIncome,
    baseTax, rebate, taxAfterRebate,
    surchargeRate: sur.rate, surcharge: sur.amount, marginalRelief: sur.marginalRelief,
    cess, totalLiability, rentTds, otherTds, netPayable,
  };
}

// s.211 advance-tax schedule for one FY: cumulative 15/45/75/100% due by
// 15 Jun / 15 Sep / 15 Dec / 15 Mar. "paid" per installment is the
// cumulative sum of payment rows dated on or before that due date.
// Advance tax is due on liability net of TDS (TDS is treated as already
// paid). No 234B/234C interest here — the auditor owns that, on purpose.
function advanceSchedule(fy, netPayable, paymentRows) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || ''));
  if (!m) return [];
  const y = Number(m[1]);
  const base = Math.max(0, netPayable);
  const installments = [
    { label: '1st (15%) — 15 Jun ' + y, dueDate: `${y}-06-15`, pct: 0.15 },
    { label: '2nd (45%) — 15 Sep ' + y, dueDate: `${y}-09-15`, pct: 0.45 },
    { label: '3rd (75%) — 15 Dec ' + y, dueDate: `${y}-12-15`, pct: 0.75 },
    { label: '4th (100%) — 15 Mar ' + (y + 1), dueDate: `${y + 1}-03-15`, pct: 1.00 },
  ];
  const payments = (paymentRows || [])
    .map(p => ({ date: String(p.TP_Date || ''), amount: Number(p.TP_Amount) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return installments.map(inst => {
    const cumulativeDue = Math.round(base * inst.pct);
    const cumulativePaid = payments.filter(p => p.date && p.date <= inst.dueDate).reduce((s, p) => s + p.amount, 0);
    return { ...inst, cumulativeDue, cumulativePaid, shortfall: Math.max(0, cumulativeDue - cumulativePaid) };
  });
}

// ---- Rent & TDS pull from invoices ----------------------------------------
// The income head an invoice's rent falls under, resolved from its tenant
// revision. Blank/missing/unknown values mean House Property — the
// treatment every existing revision had before this field existed, so
// upgrading changes nothing until someone explicitly marks a tenancy as
// Other Sources. Exported for tests.
function incomeHeadOf(tenantRecord) {
  const v = tenantRecord && String(tenantRecord[INCOME_HEAD_FIELD] || '').trim();
  return v === 'Other Sources' ? 'Other Sources' : 'House Property';
}


// ---- Landlord group resolution --------------------------------------------
// A "landlord" record in this schema is one GST registration (one state's
// GSTIN), and the group-root field (Admin -> Tax Settings) ties the
// registrations of one real person/PAN together. Income tax attaches to
// the PAN, so every tax pull here works on the whole GROUP: pass any
// member's code (even a retired one) and get the root plus every member.
// Defensive about conventions — a root may point the group field at
// itself or leave it blank, and a dangling root reference degrades to a
// single-member group rather than throwing. If the group field isn't
// mapped at all (Admin -> Tax Settings), every landlord is simply treated
// as its own one-member group — a reasonable default for an install where
// no landlord is ever registered in more than one state, not an error.
// Exported for tests.
function landlordGroup(schema, anyCode) {
  const ll = schema.entities['landlords'];
  if (!ll) return { root: String(anyCode || ''), codes: [String(anyCode || '')], members: [] };
  const groupField = (schema.taxSettings || {}).landlordGroupField;
  const rows = db.getAll('landlords');
  const byCode = {};
  rows.forEach(r => { byCode[r[ll.pk]] = r; });
  const start = byCode[anyCode];
  const rootOf = (row) => (groupField && row) ? row[groupField] : undefined;
  const root = start && rootOf(start) && byCode[rootOf(start)]
    ? rootOf(start)
    : String(anyCode || '');
  const members = groupField
    ? rows.filter(r => r[ll.pk] === root || rootOf(r) === root)
    : rows.filter(r => r[ll.pk] === root);
  const codes = members.map(r => r[ll.pk]);
  if (!codes.includes(String(anyCode || '')) && start) codes.push(start[ll.pk]);
  return { root, codes, members };
}

// Accrual basis: an invoice belongs to the FY its I_Date falls in. Ex-GST:
// I_BaseRent (a formula field — computed via the subset machinery so only
// what's needed is evaluated). TDS deposited (I_TDSDep) is a stored field.
// Rent is SPLIT by the tenant's income head: building rent (House
// Property) gets the s.23/s.24 treatment downstream; vacant-land and
// plant-&-machinery rent (Other Sources) gets none of it. TDS credits in
// Whichever fk field on Invoices points at Landlords/Tenants — derived
// from the schema's own relationship data, same reasoning as PayQR's own
// payee-link field: no setting needed, since there's nothing to choose
// between if there's exactly one real fk to look at. Returns null (rather
// than guessing) if there's none, so callers can fail loudly.
// A tenant's own group-root if set (and not just pointing at itself),
// else its own code — same reasoning as landlordGroup, extracted here
// since both pullRentAndTds and the Tax Projection module need to
// resolve "which real-world tenant does this revision belong to."
function tenantGroupCode(tenantRow, tenantsEntity) {
  const own = tenantRow[tenantsEntity.pk];
  return String((tenantRow.T_GroupRoot && tenantRow.T_GroupRoot !== own) ? tenantRow.T_GroupRoot : own);
}

// Every revision (past and present) sharing the same group as anyCode.
function tenantGroupMembers(schema, anyCode) {
  const t = schema.entities['tenants'];
  if (!t) return [];
  const rows = db.getAll('tenants');
  const start = rows.find(r => r[t.pk] === anyCode);
  if (!start) return [];
  const root = tenantGroupCode(start, t);
  return rows.filter(r => tenantGroupCode(r, t) === root);
}

function taxInvoiceLandlordFkField(schema) {
  const e = schema.entities['invoices'];
  if (!e) return null;
  const fk = e.fields.find(f => f.type === 'fk' && f.ref === 'landlords');
  return fk ? fk.name : null;
}
function taxInvoiceTenantFkField(schema) {
  const e = schema.entities['invoices'];
  if (!e) return null;
  const fk = e.fields.find(f => f.type === 'fk' && f.ref === 'tenants');
  return fk ? fk.name : null;
}

// full either way — the credit doesn't care which head the income sits
// under. Returns zeros with a flag when the invoices table doesn't exist,
// or the required Tax Settings fields (Admin -> Tax Settings) aren't
// mapped, so the worksheet fails visibly rather than silently computing
// against the wrong (or a nonexistent) field. Also builds byProperty and
// byTenant breakdowns in the same pass — used by the Annexure's detailed
// schedules, not the main computation cascade (which only needs the
// aggregate totals) — so this stays the one place invoices get walked,
// rather than a second pass duplicating the same loop.
function pullRentAndTds(schema, landlordCodes, fy) {
  const codeSet = new Set(landlordCodes);
  const inv = schema.entities['invoices'];
  const settings = schema.taxSettings || {};
  const dateField = settings.invoiceDateField, rentField = settings.invoiceRentField, tdsField = settings.invoiceTdsField;
  const llFkField = taxInvoiceLandlordFkField(schema);
  if (!inv || !dateField || !rentField || !tdsField || !llFkField) {
    return { grossRent: 0, otherSourcesRent: 0, rentTds: 0, count: 0, osCount: 0, available: false, byProperty: [], byTenant: [] };
  }
  const tenantsEntity = schema.entities['tenants'];
  const tenantFkField = taxInvoiceTenantFkField(schema);
  const tenantsById = {};
  if (tenantsEntity) {
    db.getAll('tenants').forEach(t => { tenantsById[t[tenantsEntity.pk]] = t; });
  }
  const propertyEntity = schema.entities['property'];
  const propFkOnTenant = propertyEntity && tenantsEntity
    ? (tenantsEntity.fields.find(f => f.type === 'fk' && f.ref === 'property') || {}).name
    : null;
  const propertiesById = {};
  if (propertyEntity) {
    db.getAll('property').forEach(p => { propertiesById[p[propertyEntity.pk]] = p; });
  }
  const needed = new Set([rentField]);
  let grossRent = 0, otherSourcesRent = 0, rentTds = 0, count = 0, osCount = 0;
  const byPropertyMap = {};   // property code -> { label, rent, count }
  const byTenantMap = {};     // tenant GROUP key -> { label, rent, tds, count, hasCurrentLabel }
  db.getAll('invoices').forEach(row => {
    if (!codeSet.has(row[llFkField])) return;
    if (fyOfDateString(row[dateField]) !== fy) return;
    const computed = schemaLib.withComputedFieldsSubset(schema, inv, row, needed);
    const base = Number(computed[rentField]) || 0;
    const tds = Number(row[tdsField]) || 0;
    const tenantCode = tenantFkField ? row[tenantFkField] : undefined;
    const tenantRow = tenantCode ? tenantsById[tenantCode] : undefined;
    if (incomeHeadOf(tenantRow) === 'Other Sources') {
      otherSourcesRent += base;
      osCount += 1;
    } else {
      grossRent += base;
      count += 1;
    }
    rentTds += tds;

    if (tenantRow) {
      // Group by the tenant's own group-root, not its per-revision code —
      // two revisions of the same tenant (a rent-terms change over time,
      // same real-world tenant) are one row here, not two. Same dangling-
      // root defense as landlordGroup: a blank or self-pointing root just
      // means this revision groups with itself.
      const tGroupKey = tenantGroupCode(tenantRow, tenantsEntity);
      const isCurrentRevision = !!tenantRow.T_IsCurrent;
      if (!byTenantMap[tGroupKey]) {
        byTenantMap[tGroupKey] = { group: tGroupKey, label: schemaLib.display(tenantsEntity, tenantRow), rent: 0, tds: 0, count: 0, hasCurrentLabel: isCurrentRevision };
      } else if (isCurrentRevision && !byTenantMap[tGroupKey].hasCurrentLabel) {
        // An earlier-seen revision's name was used as a placeholder before
        // the current one showed up — swap to the current revision's own
        // name, since that's the one actually worth reading today.
        byTenantMap[tGroupKey].label = schemaLib.display(tenantsEntity, tenantRow);
        byTenantMap[tGroupKey].hasCurrentLabel = true;
      }
      byTenantMap[tGroupKey].rent += base;
      byTenantMap[tGroupKey].tds += tds;
      byTenantMap[tGroupKey].count += 1;

      const propCode = propFkOnTenant ? tenantRow[propFkOnTenant] : undefined;
      const propRow = propCode ? propertiesById[propCode] : undefined;
      const pKey = propCode ? String(propCode) : `(unlinked: ${tGroupKey})`;
      if (!byPropertyMap[pKey]) {
        byPropertyMap[pKey] = { label: propRow ? schemaLib.display(propertyEntity, propRow) : `Unlinked (via ${byTenantMap[tGroupKey].label})`, rent: 0, count: 0 };
      }
      byPropertyMap[pKey].rent += base;
      byPropertyMap[pKey].count += 1;
    }
  });
  const byProperty = Object.values(byPropertyMap).sort((a, b) => b.rent - a.rent);
  const byTenant = Object.values(byTenantMap).sort((a, b) => b.rent - a.rent);
  return { grossRent, otherSourcesRent, rentTds, count, osCount, available: true, byProperty, byTenant };
}

function fyOfDateString(s) {
  const m = /^(\d{4})-(\d{2})/.exec(String(s || ''));
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]);
  const start = mo >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}


// ---- Interest & other tracked income (incomeoth) --------------------------
// The owner's incomeoth table logs interest per bank account (savings, FD,
// ITR-refund interest), keyed to a landlord via OTH_Bank -> banking ->
// B_Landlord. Pulled per GROUP and per FY, summed per OTH_Head so each
// head prints as its own Section B line. The join deliberately reads the
// STORED banking fk rather than computing the OTH_LL formula field — same
// value, none of the formula-evaluation cost. FY comes from OTH_Date via
// the same accrual attribution as invoices. Missing table (or missing
// banking) degrades to an empty pull, flagged so the page can say so.
// Exported for tests via pullTrackedIncomePure.
function pullTrackedIncome(schema, landlordCodes, fy) {
  const oth = schema.entities['incomeoth'];
  const bank = schema.entities['banking'];
  if (!oth || !bank) return { heads: [], total: 0, available: false, byBank: [] };
  return pullTrackedIncomePure(db.getAll('incomeoth'), db.getAll('banking'), bank.pk, landlordCodes, fy, bank);
}

function pullTrackedIncomePure(othRows, bankRows, bankPk, landlordCodes, fy, bankEntity) {
  const codeSet = new Set(landlordCodes);
  const bankLandlord = {};
  const bankRowsById = {};
  bankRows.forEach(b => { bankLandlord[b[bankPk]] = b.B_Landlord; bankRowsById[b[bankPk]] = b; });
  const byHead = {};
  const byBankMap = {}; // bank code -> { label, total }
  let total = 0;
  othRows.forEach(row => {
    if (fyOfDateString(row.OTH_Date) !== fy) return;
    if (!codeSet.has(bankLandlord[row.OTH_Bank])) return;
    const head = String(row.OTH_Head || 'Other tracked income').trim() || 'Other tracked income';
    const v = Number(row.OTH_Value) || 0;
    byHead[head] = (byHead[head] || 0) + v;
    total += v;

    const bKey = String(row.OTH_Bank);
    if (!byBankMap[bKey]) {
      const bRow = bankRowsById[row.OTH_Bank];
      const label = (bRow && bankEntity) ? schemaLib.display(bankEntity, bRow) : bKey;
      byBankMap[bKey] = { label, total: 0 };
    }
    byBankMap[bKey].total += v;
  });
  const heads = Object.entries(byHead)
    .map(([head, amount]) => ({ head, amount }))
    .sort((a, b) => a.head.localeCompare(b.head));
  const byBank = Object.values(byBankMap).sort((a, b) => b.total - a.total);
  return { heads, total, available: true, byBank };
}

// ---- Assembling one worksheet's full computation --------------------------
function computeWorksheet(schema, worksheet) {
  const fy = worksheet.TW_FY;
  const regime = worksheet.TW_Regime || 'New';
  const slabRows = db.getAll(SLABS).filter(s => s.TS_FY === fy && s.TS_Regime === regime);
  const cfgRow = db.getAll(CONFIG).find(c => c.TC_FY === fy && c.TC_Regime === regime);
  const problems = [];
  if (slabRows.length === 0) problems.push(`No tax slabs configured for FY ${fy} (${regime} regime). Add rows in Tax Slabs (/tax_slabs).`);
  if (!cfgRow) problems.push(`No tax config for FY ${fy} (${regime} regime). Add a row in Tax Config (/tax_config).`);

  // Whole-group pull: the worksheet's picked landlord may be ANY GST
  // version of the assessee — rent, TDS, and tracked income aggregate
  // across every registration in the group, because the tax return is
  // per PAN, not per GSTIN.
  const group = landlordGroup(schema, worksheet.TW_Landlord);
  const pulled = pullRentAndTds(schema, group.codes, fy);
  const tracked = pullTrackedIncome(schema, group.codes, fy);
  const payments = db.getAll(PAYMENTS).filter(p => group.codes.includes(p.TP_Landlord) && String(p.TP_FY) === String(fy));

  // Two worksheets covering the same group+FY (e.g. one per GST version,
  // the old habit this change retires) would each pull the FULL group's
  // income — flag it loudly rather than let two "complete" computations
  // both look authoritative.
  const wsEntityAll = db.getAll(WORKSHEETS).filter(w =>
    String(w.TW_RowID) !== String(worksheet.TW_RowID) &&
    w.TW_FY === fy &&
    landlordGroup(schema, w.TW_Landlord).root === group.root);
  if (wsEntityAll.length > 0) {
    problems.push(`Worksheet(s) #${wsEntityAll.map(w => w.TW_RowID).join(', #')} also cover this landlord group for FY ${fy} — each pulls the ENTIRE group's income, so keep only one per group per FY.`);
  }

  const config = cfgRow ? {
    cess: Number(cfgRow.TC_CessRate) || 0,
    rebateLimit: Number(cfgRow.TC_RebateIncomeLimit) || 0,
    rebateMax: Number(cfgRow.TC_RebateMax) || 0,
    surchargeTiers: parseSurchargeTiers(cfgRow.TC_Surcharge),
  } : { cess: 0, rebateLimit: 0, rebateMax: 0, surchargeTiers: [] };

  const calc = computeTax({
    grossRent: pulled.grossRent,
    otherSourcesRent: pulled.otherSourcesRent,
    trackedInterest: tracked.total,
    municipalTaxes: worksheet.TW_MunicipalTaxes,
    loanInterest: worksheet.TW_LoanInterest,
    bankInterest: worksheet.TW_BankInterest,
    otherIncome: worksheet.TW_OtherIncome,
    otherDeductions: worksheet.TW_OtherDeductions,
    rentTds: pulled.rentTds,
    otherTds: worksheet.TW_TDSOther,
  }, { slabRows, config });

  const schedule = advanceSchedule(fy, calc.netPayable, payments);
  const totalPaid = payments.reduce((s, p) => s + (Number(p.TP_Amount) || 0), 0);

  return { fy, regime, group, pulled, tracked, calc, schedule, payments, totalPaid, balance: calc.netPayable - totalPaid, problems };
}

// Suggests how many whole months of the FY a tenant's own tenancy
// covers, using T_Start/T_End across every revision in the group,
// clipped to the FY's own April-March bounds. A starting suggestion
// only, always directly editable on the row itself — an irregular
// lease-start date means a tenant's own rent-for-the-month convention
// can genuinely differ from a clean whole-month count, and that's fine;
// this only saves typing on the rows where nothing unusual is going on.
function suggestProjectedMonths(schema, tenantCode, fy) {
  const m = /^(\d{4})-\d{2}$/.exec(String(fy || ''));
  if (!schema.entities['tenants'] || !tenantCode || !m) return 12;
  const fyStartYear = Number(m[1]);
  const fyStart = new Date(fyStartYear, 3, 1);       // 1 Apr
  const fyEnd = new Date(fyStartYear + 1, 2, 31);    // 31 Mar
  const members = tenantGroupMembers(schema, tenantCode);
  if (members.length === 0) return 12;
  const starts = members.map(r => r.T_Start).filter(Boolean).map(d => new Date(d));
  const ends = members.map(r => r.T_End).filter(Boolean).map(d => new Date(d));
  const start = starts.length ? new Date(Math.max(fyStart, Math.min(...starts))) : fyStart;
  const end = ends.length ? new Date(Math.min(fyEnd, Math.max(...ends))) : fyEnd;
  if (end < start) return 0;
  const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
  return Math.max(0, Math.min(12, months));
}

// The Advance Tax Projection's own computation — same shape and same
// underlying computeTax/advanceSchedule as the real worksheet, just fed
// a blended number: every projection row's own Rental x Months, summed,
// instead of pulling actual invoices. Also builds the actual-vs-
// projected cross-check: for every row linked to a real tenant, how
// much has genuinely already been invoiced this FY for that tenant,
// compared against the row's own full-year projection — flagged when
// they diverge meaningfully, never blocked, since a real mid-year
// change means they're SUPPOSED to differ.
function computeProjection(schema, projection) {
  const fy = projection.TJ_FY;
  const regime = projection.TJ_Regime || 'New';
  const slabRows = db.getAll(SLABS).filter(s => s.TS_FY === fy && s.TS_Regime === regime);
  const cfgRow = db.getAll(CONFIG).find(c => c.TC_FY === fy && c.TC_Regime === regime);
  const problems = [];
  if (slabRows.length === 0) problems.push(`No tax slabs configured for FY ${fy} (${regime} regime). Add rows in Tax Slabs (/tax_slabs).`);
  if (!cfgRow) problems.push(`No tax config for FY ${fy} (${regime} regime). Add a row in Tax Config (/tax_config).`);

  const group = landlordGroup(schema, projection.TJ_Landlord);
  const rowsEntity = schema.entities[PROJECTION_ROWS];
  const needed = new Set(['TJR_TotalRent', 'TJR_TotalTDS']);
  const rawRows = db.getAll(PROJECTION_ROWS).filter(r => String(r.TJR_Projection) === String(projection.TJ_RowID));
  const rows = rawRows.map(r => ({ raw: r, computed: schemaLib.withComputedFieldsSubset(schema, rowsEntity, r, needed) }));

  let grossRent = 0, otherSourcesRent = 0, rentTds = 0;
  const tenantsEntity = schema.entities['tenants'];
  const actualPull = tenantsEntity ? pullRentAndTds(schema, group.codes, fy) : null;
  const actualByGroup = {};
  if (actualPull) actualPull.byTenant.forEach(t => { actualByGroup[t.group] = t; });

  const rowDetails = rows.map(({ raw, computed }) => {
    const total = Number(computed.TJR_TotalRent) || 0;
    const tds = Number(computed.TJR_TotalTDS) || 0;
    if (raw.TJR_PropType === 'Land') otherSourcesRent += total;
    else grossRent += total;
    rentTds += tds;

    let actual = null;
    if (raw.TJR_Tenant && tenantsEntity) {
      // Trash-aware tenant lookup — same reasoning as schema.js's fk
      // resolvers. A projection row pointing at a since-trashed tenant
      // stops being matched against that tenant's group actuals; the
      // row still contributes its own projected numbers as normal (they
      // live on the row itself), but "actual" is left empty rather than
      // filled with values from a deleted tenancy.
      const gKey = tenantGroupCode({ [tenantsEntity.pk]: raw.TJR_Tenant, T_GroupRoot: (db.getByIdActive('tenants', tenantsEntity.pk, raw.TJR_Tenant) || {}).T_GroupRoot }, tenantsEntity);
      actual = actualByGroup[gKey] || { rent: 0, tds: 0, count: 0 };
    }
    // Rate-vs-rate, not total-vs-total: comparing this row's full-YEAR
    // projection against actuals from only however many months have
    // been invoiced SO FAR would mismatch almost every row almost all
    // year, telling the user nothing. What actually matters is whether
    // the row's own assumed monthly rate still matches what's really
    // being invoiced, so the average actual per invoice is the right
    // comparison — flagged only on a genuine, meaningful divergence
    // (>10%, not rounding noise), and only once real invoices actually
    // exist to compare against.
    const actualMonthlyRate = actual && actual.count > 0 ? actual.rent / actual.count : null;
    const rowMonthlyRate = Number(raw.TJR_Rental) || 0;
    const mismatch = actualMonthlyRate !== null && rowMonthlyRate > 0 && Math.abs(actualMonthlyRate - rowMonthlyRate) > rowMonthlyRate * 0.10;
    return { row: raw, totalRent: total, totalTds: tds, actual, mismatch };
  });

  const config = cfgRow ? {
    cess: Number(cfgRow.TC_CessRate) || 0,
    rebateLimit: Number(cfgRow.TC_RebateIncomeLimit) || 0,
    rebateMax: Number(cfgRow.TC_RebateMax) || 0,
    surchargeTiers: parseSurchargeTiers(cfgRow.TC_Surcharge),
  } : { cess: 0, rebateLimit: 0, rebateMax: 0, surchargeTiers: [] };

  const calc = computeTax({
    grossRent, otherSourcesRent,
    municipalTaxes: projection.TJ_MunicipalTaxes,
    loanInterest: projection.TJ_LoanInterest,
    otherIncome: projection.TJ_OtherIncome,
    otherDeductions: projection.TJ_OtherDeductions,
    rentTds,
    otherTds: projection.TJ_OtherTds,
  }, { slabRows, config });

  const payments = db.getAll(PAYMENTS).filter(p => group.codes.includes(p.TP_Landlord) && String(p.TP_FY) === String(fy));
  const schedule = advanceSchedule(fy, calc.netPayable, payments);
  const totalPaid = payments.reduce((s, p) => s + (Number(p.TP_Amount) || 0), 0);

  return {
    fy, regime, group, rowDetails, calc, schedule, payments, totalPaid,
    balance: calc.netPayable - totalPaid, problems,
    actualAvailable: !!actualPull,
  };
}

// ---- Permissions ----------------------------------------------------------
function canView(user) {
  return usersLib.can(user, WORKSHEETS, 'read') && usersLib.can(user, PAYMENTS, 'read');
}

// ---- Routes ---------------------------------------------------------------
router.use('/tax', (req, res, next) => { ensureTaxTables(); next(); });
router.use('/tax-projections', (req, res, next) => { ensureTaxTables(); next(); });

// Computation view for one worksheet. Data entry stays on the standard
// entity forms (/tax_worksheets/:id) — this page is read-only math.

// ---- Landlord annexure ----------------------------------------------------
// One document per landlord GROUP: identity (every GST registration in
// the group), then a section per related table. Two mechanisms feed it:
//
//   * REGISTRY: the known sections, with hand-picked columns in the order
//     an auditor wants to read them.
//   * AUTO-DISCOVERY: any OTHER entity carrying an fk to landlords that
//     isn't excluded below gets a generic section using its own list
//     columns — which is how the future shares/holdings tracker will
//     appear in this annexure the day it's created, with zero changes
//     here. Excluded: high-volume operational tables (invoices, tenants)
//     and this module's own tables, which belong in the computation, not
//     the annexure.
const ANNEXURE_REGISTRY = [
  { entity: 'banking', fk: 'B_Landlord', title: 'Bank Accounts Held',
    columns: ['B_Code', 'B_Detail', 'B_AccountNum', 'B_AccountType', 'B_Status', 'B_Nominee', 'B_OpenDate'] },
  { entity: 'property', fk: 'P_Landlord', title: 'Properties Held',
    columns: ['P_Code', 'P_ShortName', 'P_Address', 'P_State', 'P_PurchaseDate', 'P_Cost', 'P_SiteArea', 'P_BuiltUpArea'] },
];
const ANNEXURE_EXCLUDE = new Set(['landlords', 'invoices', 'tenants', 'bs_id', WORKSHEETS, PAYMENTS, SLABS, CONFIG]);

// Assembles every section for one group. Pure given the schema + a
// row-fetcher, so tests can drive it without a database. Sections with no
// rows still render (an auditor wants to SEE "no accounts" rather than
// wonder if the section was forgotten); missing tables are skipped.
function annexureSections(schema, groupCodes, fetchRows) {
  const codeSet = new Set(groupCodes);
  const sections = [];
  const covered = new Set(['landlords']);

  ANNEXURE_REGISTRY.forEach(reg => {
    const entity = schema.entities[reg.entity];
    if (!entity) return;
    covered.add(reg.entity);
    const fields = reg.columns
      .map(name => entity.fields.find(f => f.name === name))
      .filter(Boolean);
    const rows = fetchRows(reg.entity).filter(r => codeSet.has(r[reg.fk]));
    sections.push({ title: reg.title, entity, fields, rows });
  });

  // Auto-discovery: future landlord-linked tables (shares tracker etc.).
  Object.values(schema.entities).forEach(entity => {
    if (covered.has(entity.key) || ANNEXURE_EXCLUDE.has(entity.key)) return;
    const fkField = entity.fields.find(f => f.type === 'fk' && f.ref === 'landlords');
    if (!fkField) return;
    const fields = (entity.listColumns || [])
      .map(name => entity.fields.find(f => f.name === name))
      .filter(f => f && f.name !== fkField.name);
    const rows = fetchRows(entity.key).filter(r => codeSet.has(r[fkField.name]));
    sections.push({ title: entity.label, entity, fields, rows, discovered: true });
  });

  return sections;
}

const TAX_NOT_CONFIGURED_MSG = 'Tax is not fully configured yet. Go to Admin \u2192 Tax Settings to map the required fields.';

// Checked at the top of every custom Tax route, every time — not just
// once at setup — so a table renamed or a setting cleared months into
// real use fails the same way a fresh, never-configured install does:
// loudly, with a clear next step, rather than computing something wrong
// or crashing on a missing field. Returns a message string to show, or
// null when everything's genuinely ready.
function taxNotConfiguredMessage(schema) {
  const missingTables = ['landlords', 'tenants', 'invoices'].filter(k => !schema.entities[k]);
  if (missingTables.length > 0) {
    return `Tax needs tables named exactly ${missingTables.map(k => `"${k}"`).join(', ')} to exist, which ${missingTables.length > 1 ? "aren't" : "isn't"} the case on this install. See Admin \u2192 Tax Settings.`;
  }
  if (!schemaLib.taxSettingsComplete(schema)) return TAX_NOT_CONFIGURED_MSG;
  return null;
}

// Dismisses the one-time setup notice (see the banner in nav.ejs) —
// permanent once acknowledged, same as the notice text itself says. Not a
// safety mechanism on its own (a table renamed months later isn't caught
// by a notice already dismissed) — that's what taxNotConfiguredMessage
// above is actually for, checked fresh on every request regardless of
// whether this was ever seen. This is purely "don't show the intro again."
router.post('/tax/acknowledge-notice', (req, res) => {
  const schema = schemaLib.load();
  schema.taxNoticeAcknowledged = true;
  schemaLib.persist(schema);
  res.redirect(req.body.next || '/tax_worksheets');
});

router.get('/tax/annexure/:code', (req, res) => {
  if (!canView(req.currentUser)) {
    return res.status(403).render('403', { message: "You don't have read permission on Tax Worksheets.", activeKey: 'tax_worksheets' });
  }
  const schema = schemaLib.load();
  const notConfigured = taxNotConfiguredMessage(schema);
  if (notConfigured) return res.status(409).send(notConfigured);
  const ll = schema.entities['landlords'];
  if (!ll) return res.status(404).send('No landlords table in this schema.');
  const group = landlordGroup(schema, req.params.code);
  if (group.members.length === 0) return res.status(404).send('No such landlord.');
  // Sections compute their own row values (formula columns included) so
  // the annexure shows what the list screens show.
  const fetchRows = (entityKey) => {
    const entity = schema.entities[entityKey];
    const needed = new Set((entity.listColumns || []).concat(ANNEXURE_REGISTRY.flatMap(r => r.entity === entityKey ? r.columns : [])));
    return db.getAll(entityKey).map(r => schemaLib.withComputedFieldsSubset(schema, entity, r, needed));
  };
  const sections = annexureSections(schema, group.codes, fetchRows);
  const rootRecord = group.members.find(m => m[ll.pk] === group.root) || group.members[0];
  const settings = schema.taxSettings || {};

  // FY-specific detailed schedules (property-by-property rent, tenant-by-
  // tenant TDS, bank-by-bank interest, individual advance/self-assessment
  // payments) — the point-in-time sections above (Landlord Details, Bank
  // Accounts Held, Properties Held) don't need a year, these do, so
  // they're only computed and shown when a real FY is actually given.
  const fy = (req.query.fy || '').trim();
  let fySchedules = null;
  if (fy) {
    const rentPull = pullRentAndTds(schema, group.codes, fy);
    const trackedPull = pullTrackedIncome(schema, group.codes, fy);
    const paymentRows = db.getAll(PAYMENTS)
      .filter(p => group.codes.includes(p.TP_Landlord) && String(p.TP_FY) === String(fy))
      .sort((a, b) => String(a.TP_Date).localeCompare(String(b.TP_Date)));
    fySchedules = {
      fy, rentPull, trackedPull, paymentRows,
      paymentsTotal: paymentRows.reduce((s, p) => s + (Number(p.TP_Amount) || 0), 0),
    };
  }

  res.render('tax-annexure', {
    activeKey: 'tax_worksheets', group, rootRecord, sections, ll, fySchedules,
    contactFields: {
      pan: settings.landlordPanField, gstin: settings.landlordGstinField, address: settings.landlordAddressField,
      phone: settings.landlordPhoneField, email: settings.landlordEmailField,
    },
    formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent,
    formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    display: (e, r) => schemaLib.display(e, r, schema),
    print: req.query.print === '1',
  });
});

router.get('/tax/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  if (!canView(req.currentUser)) {
    return res.status(403).render('403', { message: "You don't have read permission on Tax Worksheets.", activeKey: 'tax_worksheets' });
  }
  const schema = schemaLib.load();
  const notConfigured = taxNotConfiguredMessage(schema);
  if (notConfigured) return res.status(409).send(notConfigured);
  const wsEntity = schema.entities[WORKSHEETS];
  const worksheet = db.getById(WORKSHEETS, wsEntity.pk, req.params.id);
  if (!worksheet) return res.status(404).send('No such tax worksheet.');
  const result = computeWorksheet(schema, worksheet);
  const landlordName = resolveLandlordName(schema, result.group.root);
  res.render('tax', { activeKey: 'tax_worksheets', worksheet, landlordName, r: result, print: req.query.print === '1' });
});

function resolveLandlordName(schema, code) {
  const ll = schema.entities['landlords'];
  if (!ll) return String(code || '');
  const row = db.getById('landlords', ll.pk, code);
  if (!row) return String(code || '');
  return schemaLib.display(ll, row, schema);
}

// ---- Advance Tax Projection routes -----------------------------------
function canViewProjections(user) {
  return usersLib.can(user, PROJECTIONS, 'read') && usersLib.can(user, PROJECTION_ROWS, 'read');
}

router.get('/tax-projections/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  if (!canViewProjections(req.currentUser)) {
    return res.status(403).render('403', { message: "You don't have read permission on Advance Tax Projections.", activeKey: PROJECTIONS });
  }
  const schema = schemaLib.load();
  const pEntity = schema.entities[PROJECTIONS];
  const projection = db.getById(PROJECTIONS, pEntity.pk, req.params.id);
  if (!projection) return res.status(404).send('No such projection.');
  const result = computeProjection(schema, projection);
  const landlordName = resolveLandlordName(schema, result.group.root);
  const tenantsEntity = schema.entities['tenants'];
  const activeTenants = tenantsEntity
    ? db.getAll('tenants').filter(t => t.T_IsCurrent && result.group.codes.includes(t.T_MappedTo))
    : [];
  const usedTenantCodes = new Set(result.rowDetails.map(d => d.row.TJR_Tenant).filter(Boolean));
  const availableTenants = activeTenants.filter(t => !usedTenantCodes.has(t[tenantsEntity.pk]));
  res.render('tax-projection', {
    activeKey: PROJECTIONS, projection, landlordName, r: result,
    availableTenantsCount: availableTenants.length,
    print: req.query.print === '1',
  });
});

// One click: a row per currently-active tenant not already represented
// in this projection, each fully auto-filled — Prop Type/TDS Debitor
// from the tenant's own record, TDS % defaulted to the common 10%,
// Months suggested from the tenant's own tenancy dates. Covers the
// common shape directly (a flat year, nothing changing) so only the
// real exceptions need a manual row afterward.
router.post('/tax-projections/:id/populate', (req, res) => {
  const schema = schemaLib.load();
  const pEntity = schema.entities[PROJECTIONS];
  const projection = db.getById(PROJECTIONS, pEntity.pk, req.params.id);
  if (!projection) return res.status(404).send('No such projection.');
  const tenantsEntity = schema.entities['tenants'];
  if (!tenantsEntity) return res.redirect(`/tax-projections/${req.params.id}`);
  const group = landlordGroup(schema, projection.TJ_Landlord);
  const existing = db.getAll(PROJECTION_ROWS).filter(r => String(r.TJR_Projection) === String(projection.TJ_RowID));
  const usedTenantCodes = new Set(existing.map(r => r.TJR_Tenant).filter(Boolean));
  const rowsEntity = schema.entities[PROJECTION_ROWS];
  let added = 0;
  db.getAll('tenants').forEach(t => {
    if (!t.T_IsCurrent) return;
    if (!group.codes.includes(t.T_MappedTo)) return;
    const code = t[tenantsEntity.pk];
    if (usedTenantCodes.has(code)) return;
    const record = {
      [rowsEntity.pk]: db.nextAutoId(PROJECTION_ROWS, rowsEntity.pk),
      TJR_Projection: projection.TJ_RowID,
      TJR_PropType: incomeHeadOf(t) === 'Other Sources' ? 'Land' : 'Building',
      TJR_Tenant: code,
      TJR_Label: schemaLib.display(tenantsEntity, t),
      TJR_Rental: t.T_InvoiceValue || 0,
      TJR_TDSDebitor: !!t.T_TDSDebitor,
      TJR_TDSPercent: 0.10,
      TJR_Months: suggestProjectedMonths(schema, code, projection.TJ_FY),
    };
    db.insert(PROJECTION_ROWS, record);
    audit.log({ entityKey: PROJECTION_ROWS, recordId: record[rowsEntity.pk], action: 'create', username: req.currentUser.username, before: null, after: record });
    added += 1;
  });
  res.redirect(`/tax-projections/${req.params.id}?notice=` + encodeURIComponent(`${added} row(s) added from active tenants.`));
});

// Custom add-row form (not the generic one) specifically so picking a
// tenant can auto-fill the rest of the row via plain client-side JS —
// the tenant list is small enough to embed directly rather than round-
// trip for it.
router.get('/tax-projections/:id/add-row', (req, res) => {
  if (!canViewProjections(req.currentUser) || !usersLib.can(req.currentUser, PROJECTION_ROWS, 'create')) {
    return res.status(403).render('403', { message: "You don't have create permission on Advance Tax Projection Rows.", activeKey: PROJECTIONS });
  }
  const schema = schemaLib.load();
  const pEntity = schema.entities[PROJECTIONS];
  const projection = db.getById(PROJECTIONS, pEntity.pk, req.params.id);
  if (!projection) return res.status(404).send('No such projection.');
  const tenantsEntity = schema.entities['tenants'];
  const group = landlordGroup(schema, projection.TJ_Landlord);
  const tenants = tenantsEntity ? db.getAll('tenants').filter(t => t.T_IsCurrent && group.codes.includes(t.T_MappedTo)).map(t => ({
    code: t[tenantsEntity.pk],
    label: schemaLib.display(tenantsEntity, t),
    propType: incomeHeadOf(t) === 'Other Sources' ? 'Land' : 'Building',
    rental: t.T_InvoiceValue || 0,
    tdsDebitor: !!t.T_TDSDebitor,
    months: suggestProjectedMonths(schema, t[tenantsEntity.pk], projection.TJ_FY),
  })) : [];
  res.render('tax-projection-add-row', { activeKey: PROJECTIONS, projection, tenants });
});

router.post('/tax-projections/:id/add-row', (req, res) => {
  const schema = schemaLib.load();
  const pEntity = schema.entities[PROJECTIONS];
  const projection = db.getById(PROJECTIONS, pEntity.pk, req.params.id);
  if (!projection) return res.status(404).send('No such projection.');
  const rowsEntity = schema.entities[PROJECTION_ROWS];
  const record = {
    [rowsEntity.pk]: db.nextAutoId(PROJECTION_ROWS, rowsEntity.pk),
    TJR_Projection: projection.TJ_RowID,
    TJR_PropType: req.body.TJR_PropType || '',
    TJR_Tenant: req.body.TJR_Tenant || '',
    TJR_Label: req.body.TJR_Label || '',
    TJR_Rental: Number(req.body.TJR_Rental) || 0,
    TJR_TDSDebitor: req.body.TJR_TDSDebitor === 'on',
    TJR_TDSPercent: Number(req.body.TJR_TDSPercent) || 0,
    TJR_Months: Number(req.body.TJR_Months) || 0,
  };
  db.insert(PROJECTION_ROWS, record);
  audit.log({ entityKey: PROJECTION_ROWS, recordId: record[rowsEntity.pk], action: 'create', username: req.currentUser.username, before: null, after: record });
  res.redirect(`/tax-projections/${req.params.id}`);
});

module.exports = {
  router, ensureTaxTables,
  slabTax, parseSurchargeTiers, surchargeWithMarginalRelief, computeTax, advanceSchedule, fyOfDateString, incomeHeadOf, INCOME_HEAD_FIELD,
  landlordGroup, pullTrackedIncomePure, annexureSections, ANNEXURE_REGISTRY,
  computeWorksheet, suggestProjectedMonths, computeProjection, tenantGroupCode, tenantGroupMembers,
  WORKSHEETS, PAYMENTS, SLABS, CONFIG, SEED_SLABS, SEED_CONFIG, PROJECTIONS, PROJECTION_ROWS,
};
