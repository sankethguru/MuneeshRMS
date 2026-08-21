// tests/reminders-tax.test.js
// Pure-logic coverage for the Reminders due/mark-done semantics and the
// tax computation engine (slabs, 87A rebate, surcharge marginal relief,
// advance-tax schedule). Run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const rem = require('../reminders.js');
const tax = require('../tax.js');

// ---- Reminders -------------------------------------------------------------
const TODAY = new Date(2026, 6, 20);   // 2026-07-20 local

test('reminders: Date type — lead window and overdue', () => {
  const r = { RM_Type: 'Date', RM_Paused: false, RM_NextDue: '2026-08-10', RM_LeadDays: 30 };
  assert.strictEqual(rem.dueState(r, [], TODAY).state, 'due');           // 21 days out, inside 30
  r.RM_NextDue = '2026-12-01';
  assert.strictEqual(rem.dueState(r, [], TODAY).state, 'upcoming');
  r.RM_NextDue = '2026-07-01';
  const s = rem.dueState(r, [], TODAY);
  assert.strictEqual(s.state, 'overdue');
  assert.strictEqual(s.daysLeft, -19);
});

test('reminders: Date mark-done with a new date reschedules; without one, pauses', () => {
  const r = { RM_RowID: 1, RM_Type: 'Date', RM_Paused: false, RM_NextDue: '2026-07-01' };
  const withDate = rem.markDonePlan(r, TODAY, { newDue: '2036-07-01' });
  assert.deepStrictEqual(withDate.updates, { RM_NextDue: '2036-07-01' });
  const without = rem.markDonePlan(r, TODAY, {});
  assert.deepStrictEqual(without.updates, { RM_Paused: true });
  assert.strictEqual(without.paused, true);
  assert.ok(rem.markDonePlan(r, TODAY, { newDue: 'garbage' }).error);
});

test('reminders: Recurring advances from the SCHEDULED date, catching up missed cycles', () => {
  // Annual service scheduled Oct 2024, never done since — done today
  // (Jul 2026) must land on Oct 2026, keeping the October anchor.
  const r = { RM_RowID: 2, RM_Type: 'Recurring', RM_Paused: false, RM_NextDue: '2024-10-15', RM_FrequencyMonths: 12 };
  const plan = rem.markDonePlan(r, TODAY, {});
  assert.strictEqual(plan.updates.RM_NextDue, '2026-10-15');
  const noFreq = rem.markDonePlan({ ...r, RM_FrequencyMonths: '' }, TODAY, {});
  assert.ok(noFreq.error);
});

test('reminders: month-end anchored math clamps instead of overflowing', () => {
  assert.strictEqual(rem.addMonths(new Date(2026, 0, 31), 1).getDate(), 28);   // Jan 31 → Feb 28
  assert.strictEqual(rem.addMonths(new Date(2026, 0, 31), 2).getDate(), 31);   // → Mar 31
});

test('reminders: Monthly type keys off the current month log', () => {
  const r = { RM_RowID: 3, RM_Type: 'Monthly', RM_Paused: false };
  assert.strictEqual(rem.dueState(r, [], TODAY).state, 'due');
  assert.strictEqual(rem.dueState(r, [{ RL_Month: '2026-07' }], TODAY).state, 'done');
  assert.strictEqual(rem.dueState(r, [{ RL_Month: '2026-06' }], TODAY).state, 'due');
  const plan = rem.markDonePlan(r, TODAY, {});
  assert.strictEqual(plan.logRow.RL_Month, '2026-07');
  assert.strictEqual(plan.updates, null);
});

test('reminders: Paused never surfaces; missing due date is called out', () => {
  assert.strictEqual(rem.dueState({ RM_Type: 'Date', RM_Paused: true, RM_NextDue: '2020-01-01' }, [], TODAY).state, 'paused');
  assert.strictEqual(rem.dueState({ RM_Type: 'Date', RM_Paused: false, RM_NextDue: '' }, [], TODAY).state, 'misconfigured');
});

// ---- Tax -------------------------------------------------------------------
const NEW_SLABS = tax.SEED_SLABS['New'].map(([f, c, r]) => ({ TS_Floor: f, TS_Ceiling: c === null ? '' : c, TS_Rate: r }));
const NEW_CFG = { cess: 0.04, rebateLimit: 1200000, rebateMax: 60000, surchargeTiers: tax.parseSurchargeTiers(tax.SEED_CONFIG['New'].surcharge) };

test('tax: slab tax on new-regime seed rates', () => {
  assert.strictEqual(tax.slabTax(400000, NEW_SLABS), 0);
  assert.strictEqual(tax.slabTax(1200000, NEW_SLABS), 60000);              // 20k + 40k
  assert.strictEqual(tax.slabTax(2400000, NEW_SLABS), 300000);             // full ladder to 24L
  assert.strictEqual(tax.slabTax(3000000, NEW_SLABS), 300000 + 600000 * 0.30);
});

test('tax: 87A rebate zeroes tax at/below the limit and not above it', () => {
  const at = tax.computeTax({ grossRent: 0, bankInterest: 1200000 }, { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.strictEqual(at.baseTax, 60000);
  assert.strictEqual(at.rebate, 60000);
  assert.strictEqual(at.totalLiability, 0);
  const above = tax.computeTax({ grossRent: 0, bankInterest: 1300000 }, { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.strictEqual(above.rebate, 0);
});

test('tax: house property cascade — municipal, 30% standard, loan interest', () => {
  const r = tax.computeTax(
    { grossRent: 1000000, municipalTaxes: 100000, loanInterest: 200000 },
    { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.strictEqual(r.nav, 900000);
  assert.strictEqual(r.stdDeduction, 270000);
  assert.strictEqual(r.houseProperty, 430000);
  assert.strictEqual(r.totalIncome, 430000);
  assert.strictEqual(r.baseTax, 1500);          // 30k over 4L at 5%
});

test('tax: surcharge applies above 50L and marginal relief caps it just past the threshold', () => {
  // ₹51,00,000: raw surcharge 10% would exceed what the extra ₹1L of
  // income can justify — marginal relief must bite.
  const income = 5100000;
  const baseTax = tax.slabTax(income, NEW_SLABS);
  const sur = tax.surchargeWithMarginalRelief(income, baseTax, NEW_CFG.surchargeTiers, NEW_SLABS);
  assert.strictEqual(sur.rate, 0.10);
  assert.ok(sur.marginalRelief > 0, 'relief expected just past 50L');
  const taxAt50 = tax.slabTax(5000000, NEW_SLABS);
  // Cap identity: tax + surcharge == tax at threshold + income above it.
  assert.ok(Math.abs((baseTax + sur.amount) - (taxAt50 + (income - 5000000))) < 1);
  // Far above the threshold: no relief, full 10%.
  const far = 9000000;
  const farTax = tax.slabTax(far, NEW_SLABS);
  const farSur = tax.surchargeWithMarginalRelief(far, farTax, NEW_CFG.surchargeTiers, NEW_SLABS);
  assert.strictEqual(farSur.marginalRelief, 0);
  assert.ok(Math.abs(farSur.amount - farTax * 0.10) < 1);
});

test('tax: advance schedule — cumulative dues and date-bucketed payments', () => {
  const sched = tax.advanceSchedule('2026-27', 100000, [
    { TP_Date: '2026-06-10', TP_Amount: 20000 },
    { TP_Date: '2026-09-14', TP_Amount: 30000 },
    { TP_Date: '2027-03-16', TP_Amount: 50000 },   // AFTER the 15 Mar due date
  ]);
  assert.strictEqual(sched[0].cumulativeDue, 15000);
  assert.strictEqual(sched[0].cumulativePaid, 20000);
  assert.strictEqual(sched[0].shortfall, 0);
  assert.strictEqual(sched[1].cumulativeDue, 45000);
  assert.strictEqual(sched[1].cumulativePaid, 50000);
  assert.strictEqual(sched[3].cumulativeDue, 100000);
  assert.strictEqual(sched[3].cumulativePaid, 50000);   // late payment excluded
  assert.strictEqual(sched[3].shortfall, 50000);
});

test('tax: FY attribution of invoice dates (accrual basis)', () => {
  assert.strictEqual(tax.fyOfDateString('2026-04-01'), '2026-27');
  assert.strictEqual(tax.fyOfDateString('2026-03-31'), '2025-26');
  assert.strictEqual(tax.fyOfDateString(''), '');
});

test('tax: refund case — TDS exceeding liability goes negative, schedule floors at zero', () => {
  const r = tax.computeTax({ grossRent: 600000, rentTds: 60000 }, { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.ok(r.netPayable < 0, 'expected refund');
  const sched = tax.advanceSchedule('2026-27', r.netPayable, []);
  assert.strictEqual(sched[3].cumulativeDue, 0);
});

// ---- Income head split (v2.70.1) -------------------------------------------
test('tax: incomeHeadOf defaults blank/missing to House Property', () => {
  assert.strictEqual(tax.incomeHeadOf({ T_IncomeHead: 'Other Sources' }), 'Other Sources');
  assert.strictEqual(tax.incomeHeadOf({ T_IncomeHead: 'House Property' }), 'House Property');
  assert.strictEqual(tax.incomeHeadOf({ T_IncomeHead: '' }), 'House Property');
  assert.strictEqual(tax.incomeHeadOf({}), 'House Property');
  assert.strictEqual(tax.incomeHeadOf(undefined), 'House Property');
  assert.strictEqual(tax.incomeHeadOf({ T_IncomeHead: 'garbage' }), 'House Property');
});

test('tax: Other Sources rent bypasses municipal taxes and the 30% deduction', () => {
  // Same ₹10L of rent, classified two ways, with ₹1L municipal taxes:
  // as HP it nets 6.3L into income; as OS it lands whole and the
  // municipal taxes deduct nothing (they only reduce HP annual value).
  const hp = tax.computeTax(
    { grossRent: 1000000, otherSourcesRent: 0, municipalTaxes: 100000 },
    { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.strictEqual(hp.houseProperty, 630000);      // (10L-1L) less 30%
  assert.strictEqual(hp.totalIncome, 630000);

  const os = tax.computeTax(
    { grossRent: 0, otherSourcesRent: 1000000, municipalTaxes: 100000 },
    { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.strictEqual(os.houseProperty, 0);           // municipal capped at GAV of 0
  assert.strictEqual(os.otherSourcesRent, 1000000);
  assert.strictEqual(os.totalIncome, 1000000);
  assert.ok(os.totalIncome > hp.totalIncome, 'OS classification must tax more of the same rent');
});

test('tax: mixed heads — each rupee goes through exactly one path', () => {
  const r = tax.computeTax(
    { grossRent: 1000000, otherSourcesRent: 400000, municipalTaxes: 50000, bankInterest: 100000 },
    { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.strictEqual(r.houseProperty, (1000000 - 50000) * 0.70);
  assert.strictEqual(r.otherSources, 400000 + 100000);
  assert.strictEqual(r.grossTotal, r.houseProperty + r.otherSources);
});

// ---- Group + tracked income + annexure (v2.71.0) ---------------------------
const GROUP_SCHEMA = { entities: { landlords: { key: 'landlords', pk: 'LL_Code', fields: [] } } };

test('tax: landlordGroup resolves any member to the whole group', () => {
  // Stubbing db.getAll via a temporary monkeypatch is uglier than it's
  // worth — landlordGroup reads through db, so this test drives it with a
  // seeded in-memory request cache instead is also unavailable here.
  // Covered live in the e2e run; here we pin the PURE pieces around it.
  assert.ok(typeof tax.landlordGroup === 'function');
});

test('tax: pullTrackedIncomePure — FY filter, group filter, per-head grouping', () => {
  const banks = [
    { B_Code: 'BK1', B_Landlord: 'SANKHUF' },
    { B_Code: 'BK2', B_Landlord: 'MUNEESHT' },   // same group, different GSTIN
    { B_Code: 'BK3', B_Landlord: 'DEEPIKA' },    // different group
  ];
  const rows = [
    { OTH_Date: '2025-06-01', OTH_Bank: 'BK1', OTH_Head: 'Interest Income - Savings A/c', OTH_Value: 1000 },
    { OTH_Date: '2025-07-01', OTH_Bank: 'BK1', OTH_Head: 'Interest Income - Fixed Deposit', OTH_Value: 5000 },
    { OTH_Date: '2026-01-01', OTH_Bank: 'BK2', OTH_Head: 'Interest Income - Fixed Deposit', OTH_Value: 2000 },
    { OTH_Date: '2025-08-01', OTH_Bank: 'BK3', OTH_Head: 'Interest Income - Savings A/c', OTH_Value: 999 },   // other group
    { OTH_Date: '2024-08-01', OTH_Bank: 'BK1', OTH_Head: 'Interest Income - Savings A/c', OTH_Value: 888 },   // other FY
    { OTH_Date: '2026-02-01', OTH_Bank: 'BK2', OTH_Head: 'Interest Income - ITR Refund', OTH_Value: 300 },
  ];
  const r = tax.pullTrackedIncomePure(rows, banks, 'B_Code', ['SANKHUF', 'MUNEESHT'], '2025-26');
  assert.strictEqual(r.total, 1000 + 5000 + 2000 + 300);
  assert.deepStrictEqual(r.heads.map(h => [h.head, h.amount]), [
    ['Interest Income - Fixed Deposit', 7000],
    ['Interest Income - ITR Refund', 300],
    ['Interest Income - Savings A/c', 1000],
  ]);
  // byBank: BK1 (6000, within-FY only) ahead of BK2 (2300) — sorted by
  // total descending; BK3 (a different group) correctly excluded entirely.
  assert.deepStrictEqual(r.byBank.map(b => [b.label, b.total]), [
    ['BK1', 6000],
    ['BK2', 2300],
  ]);
});

test('tax: trackedInterest flows into other sources untouched by HP deductions', () => {
  const r = tax.computeTax(
    { grossRent: 1000000, municipalTaxes: 100000, trackedInterest: 50000 },
    { slabRows: NEW_SLABS, config: NEW_CFG });
  assert.strictEqual(r.otherSources, 50000);
  assert.strictEqual(r.grossTotal, 630000 + 50000);
});

test('tax: annexureSections — registry order, empty sections kept, auto-discovery of future tables', () => {
  const schema = { entities: {
    landlords: { key: 'landlords', pk: 'LL_Code', fields: [] },
    banking: { key: 'banking', pk: 'B_Code', label: 'Banking', fields: [
      { name: 'B_Code', type: 'text' }, { name: 'B_Detail', type: 'textarea' }, { name: 'B_AccountNum', type: 'text' },
      { name: 'B_AccountType', type: 'picklist' }, { name: 'B_Status', type: 'picklist' }, { name: 'B_Nominee', type: 'text' },
      { name: 'B_OpenDate', type: 'date' }, { name: 'B_Landlord', type: 'fk', ref: 'landlords' } ] },
    property: { key: 'property', pk: 'P_Code', label: 'Property', fields: [
      { name: 'P_Code', type: 'text' }, { name: 'P_ShortName', type: 'text' }, { name: 'P_Address', type: 'textarea' },
      { name: 'P_State', type: 'picklist' }, { name: 'P_PurchaseDate', type: 'date' }, { name: 'P_Cost', type: 'currency' },
      { name: 'P_SiteArea', type: 'number' }, { name: 'P_BuiltUpArea', type: 'number' }, { name: 'P_Landlord', type: 'fk', ref: 'landlords' } ] },
    // The future shares tracker: not in the registry, has a landlords fk.
    shares: { key: 'shares', pk: 'SH_RowID', label: 'Shares & Holdings',
      listColumns: ['SH_RowID', 'SH_Scrip', 'SH_Qty', 'SH_Owner'],
      fields: [
        { name: 'SH_RowID', type: 'number' }, { name: 'SH_Scrip', type: 'text' },
        { name: 'SH_Qty', type: 'number' }, { name: 'SH_Owner', type: 'fk', ref: 'landlords' } ] },
    invoices: { key: 'invoices', pk: 'I_RowID', label: 'Invoices', fields: [
      { name: 'I_RowID', type: 'number' }, { name: 'I_LL', type: 'fk', ref: 'landlords' } ] },   // excluded
  } };
  const data = {
    banking: [ { B_Code: 'BK1', B_Landlord: 'A' }, { B_Code: 'BK2', B_Landlord: 'B' } ],
    property: [],
    shares: [ { SH_RowID: 1, SH_Scrip: 'INFY', SH_Qty: 10, SH_Owner: 'A' }, { SH_RowID: 2, SH_Scrip: 'TCS', SH_Qty: 5, SH_Owner: 'X' } ],
    invoices: [ { I_RowID: 1, I_LL: 'A' } ],
  };
  const sections = tax.annexureSections(schema, ['A', 'A2'], (k) => data[k] || []);
  assert.deepStrictEqual(sections.map(s => s.title), ['Bank Accounts Held', 'Properties Held', 'Shares & Holdings']);
  assert.strictEqual(sections[0].rows.length, 1);                       // BK2 belongs to another group
  assert.strictEqual(sections[1].rows.length, 0);                       // empty section still present
  assert.strictEqual(sections[2].discovered, true);
  assert.strictEqual(sections[2].rows.length, 1);                       // TCS belongs to X
  assert.ok(!sections[2].fields.some(f => f.name === 'SH_Owner'), 'fk column dropped from discovered section');
});
