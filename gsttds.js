// gsttds.js — GST TDS Returns tracking.
//
// Certain tenants (typically govt/PSU entities) deduct TDS on GST when
// paying rent. The deduction is a per-invoice fact — it happens when
// that specific invoice is paid, and only for the tenants who actually
// deduct. But the deposit and return-filing (GSTR-7) happens once per
// tenant per month, covering every invoice that tenant paid in that
// period — the same "many invoices, one shared filing" shape as GST
// Filings (gstrfilings), just keyed by Tenant instead of Landlord.
//
// So the split is:
//   - GST TDS Returns (this table): one row per Tenant x Month Year,
//     holding the period-level facts (return reference, deposit date,
//     total deposited — manually entered, since it's what the tenant
//     reports and may not exactly match the sum of invoice-level
//     deductions).
//   - Invoices: two new fields — I_GSTTDS_Amount (how much THIS invoice
//     had deducted) and I_GSTTDS_Return (fk to this table, narrowed via
//     fkWhere to the matching tenant + period, same pattern already
//     built for I_GSTR_Ref -> gstrfilings).
//   - The three fields that used to hold this data directly on Invoices
//     (I_GSTTDSRecd, I_TDSCreditFiledOn, I_TDSClaimRef) become read-only
//     formula fields pulling through the new fk link — same convenience-
//     lookup pattern the GSTR-1/GSTR-3B fields already use via I_GSTR_Ref.

const schemaLib = require('./schema');

const GSTTDS = 'gsttdsreturns';
const INVOICES = 'invoices';

function ensureGstTdsTables() {
  const schema = schemaLib.load();
  let changed = false;
  if (!schema.entities[GSTTDS]) { addGstTdsTable(schema); changed = true; }
  if (ensureInvoiceGstTdsFields(schema)) changed = true;
  if (changed) schemaLib.persist(schema);
  return changed;
}

function addGstTdsTable(schema) {
  schemaLib.addEntity(schema, { key: GSTTDS, label: 'GST TDS Returns', singular: 'GST TDS Return', pkName: 'GTDS_RowID', pkLabel: 'Row ID', pkAuto: true });
  const add = (spec) => schemaLib.addField(schema, GSTTDS, spec);

  add({ name: 'GTDS_Tenant', label: 'Tenant', type: 'fk', ref: 'tenants', required: true, inList: true, hint: 'Which tenant deducted this TDS — generic to any number of TDS-deducting tenants, not hardcoded to one.' });

  // Reuse the SAME global "Month Year" picklist gstrfilings already uses
  // (sourced from caldata.CAL_MonthYear) so period values are directly
  // comparable across both tables — this is exactly what the fkWhere on
  // Invoices will match against.
  const monthYearPicklist = (schema.picklists || []).find(p => p.sourceType === 'table' && p.sourceValueField === 'CAL_MonthYear');
  if (monthYearPicklist) {
    add({ name: 'GTDS_MonthYear', label: 'Month Year', type: 'picklist', picklistSource: 'global', picklistKey: monthYearPicklist.key, required: true, inList: true });
  } else {
    // No matching global picklist found yet (e.g. a fresh install without
    // one configured) — fall back to plain text so the table is still
    // usable; can be switched to the picklist later once it exists.
    add({ name: 'GTDS_MonthYear', label: 'Month Year', type: 'text', required: true, inList: true });
  }

  add({ name: 'GTDS_ReturnRef', label: 'Return Reference', type: 'text', inList: true });
  add({ name: 'GTDS_DepositDate', label: 'Deposit Date', type: 'date', inList: true });
  add({ name: 'GTDS_TotalDeposited', label: 'Total Deposited', type: 'currency', inList: true, hint: 'What the tenant reports as deposited for this period. Manual entry — may not exactly match the sum of this period\'s invoice-level deductions.' });

  // Composite display name (Tenant — Month Year) so a flat list spanning
  // multiple tenants is still readable at a glance. A formula-typed
  // displayField resolves correctly through the fk hop and through
  // GTDS_MonthYear's own picklist label.
  add({ name: 'GTDS_Display', label: 'Display', type: 'formula', formula: 'CONCAT(tenants.T_Name, " - ", GTDS_MonthYear)' });

  const e = schema.entities[GSTTDS];
  e.displayField = 'GTDS_Display';
  e.listColumns = ['GTDS_RowID', 'GTDS_Tenant', 'GTDS_MonthYear', 'GTDS_ReturnRef', 'GTDS_DepositDate', 'GTDS_TotalDeposited'];
  e.filterFields = ['GTDS_Tenant', 'GTDS_MonthYear'];
  e.sortField = 'GTDS_MonthYear';
}

function ensureInvoiceGstTdsFields(schema) {
  const invoices = schema.entities[INVOICES];
  if (!invoices) return false;
  let changed = false;

  if (!invoices.fields.some(f => f.name === 'I_GSTTDS_Amount')) {
    schemaLib.addField(schema, INVOICES, {
      name: 'I_GSTTDS_Amount', label: 'GST TDS Amount', type: 'currency',
      hint: 'How much GST TDS was deducted on THIS invoice \u2014 only fill in for TDS-deducting tenants; leave blank otherwise.',
    });
    changed = true;
  }

  if (!invoices.fields.some(f => f.name === 'I_GSTTDS_Return')) {
    schemaLib.addField(schema, INVOICES, {
      name: 'I_GSTTDS_Return', label: 'GST TDS Return', type: 'fk', ref: GSTTDS,
      fkWhere: 'GTDS_Tenant = parent.I_TenantCode AND GTDS_MonthYear = parent.I_MonthYear',
      hint: 'Which GST TDS Return this invoice\u2019s deduction is covered by. Narrows automatically to the matching tenant and month.',
    });
    changed = true;
  }

  // The three fields that used to hold this data directly become
  // read-only formulas pulling through the new fk link \u2014 same
  // convenience-lookup pattern the existing GSTR-1/GSTR-3B fields
  // already use via I_GSTR_Ref (e.g. I_GSTR1Check -> "gstrfilings.GSTR_1_Check").
  // Safe here because there's no invoice data yet, so this is a clean
  // type change, not a migration needing to preserve stored values.
  const retarget = (name, label, formula) => {
    const f = invoices.fields.find(fl => fl.name === name);
    if (f && f.type !== 'formula') {
      schemaLib.updateField(schema, INVOICES, name, { label, type: 'formula', formula });
      changed = true;
    }
  };
  retarget('I_GSTTDSRecd', 'GST TDS Received', `${GSTTDS}.GTDS_TotalDeposited`);
  retarget('I_TDSCreditFiledOn', 'TDS Credit Filed On', `${GSTTDS}.GTDS_DepositDate`);
  retarget('I_TDSClaimRef', 'TDS Claim Reference', `${GSTTDS}.GTDS_ReturnRef`);

  return changed;
}

module.exports = { ensureGstTdsTables, GSTTDS };
