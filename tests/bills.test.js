// tests/bills.test.js
// Pure-logic coverage for the Bills module: FY month math and the
// items×months pivot. Run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const bills = require('../bills.js');

test('fyMonths: Indian FY runs Apr..Mar across the year boundary', () => {
  const months = bills.fyMonths('2026-27');
  assert.strictEqual(months.length, 12);
  assert.strictEqual(months[0], '2026-04');
  assert.strictEqual(months[8], '2026-12');
  assert.strictEqual(months[9], '2027-01');
  assert.strictEqual(months[11], '2027-03');
});

test('fyMonths: rejects malformed and mismatched FY strings', () => {
  assert.throws(() => bills.fyMonths('2026'));
  assert.throws(() => bills.fyMonths('2026-28'), /not a valid financial year/);
  assert.throws(() => bills.fyMonths(''));
});

test('fyOf: Jan–Mar belong to the previous FY start year', () => {
  assert.strictEqual(bills.fyOf(new Date('2026-07-15')), '2026-27');
  assert.strictEqual(bills.fyOf(new Date('2026-02-15')), '2025-26');
  assert.strictEqual(bills.fyOf(new Date('2026-04-01')), '2026-27');
});

const items = [
  { EI_Code: 'BESCOM', EI_Item: 'Electricity — Home', EI_Category: 'Electricity', EI_Archived: false },
  { EI_Code: 'BWSSB', EI_Item: 'Water', EI_Category: 'Water', EI_Archived: false },
  { EI_Code: 'OLDCARD', EI_Item: 'Closed Card', EI_Category: 'Credit Cards', EI_Archived: true },
  { EI_Code: 'DEADITEM', EI_Item: 'Never Used', EI_Category: 'Other', EI_Archived: true },
];
const entries = [
  { EE_Item: 'BESCOM', EE_Month: '2026-04', EE_Amount: 1200 },
  { EE_Item: 'BESCOM', EE_Month: '2026-05', EE_Amount: 1300 },
  { EE_Item: 'BWSSB', EE_Month: '2026-04', EE_Amount: 400 },
  { EE_Item: 'OLDCARD', EE_Month: '2026-04', EE_Amount: 9000 },   // archived WITH history → visible
  { EE_Item: 'BESCOM', EE_Month: '2023-04', EE_Amount: 999 },     // other FY → excluded
  { EE_Item: 'BWSSB', EE_Month: '2026-06', EE_Amount: 100 },      // split cell (two rows, same month)
  { EE_Item: 'BWSSB', EE_Month: '2026-06', EE_Amount: 150 },
];

test('buildMatrix: cells, totals, subtotals, and grand total', () => {
  const months = bills.fyMonths('2026-27');
  const m = bills.buildMatrix(items, entries, months);

  const elec = m.categories.find(c => c.name === 'Electricity');
  const bescom = elec.items.find(i => i.code === 'BESCOM');
  assert.strictEqual(bescom.cells['2026-04'].amount, 1200);
  assert.strictEqual(bescom.cells['2026-06'], null);
  assert.strictEqual(bescom.total, 2500);            // 1200 + 1300, NOT the 2023 row
  assert.strictEqual(elec.subtotals['2026-04'], 1200);

  assert.strictEqual(m.grand['2026-04'], 1200 + 400 + 9000);
  assert.strictEqual(m.grandTotal, 2500 + 400 + 250 + 9000);
});

test('buildMatrix: archived items appear only when they have history in the FY', () => {
  const months = bills.fyMonths('2026-27');
  const m = bills.buildMatrix(items, entries, months);
  const allCodes = m.categories.flatMap(c => c.items.map(i => i.code));
  assert.ok(allCodes.includes('OLDCARD'), 'archived item with entries stays visible');
  assert.ok(!allCodes.includes('DEADITEM'), 'archived item with no entries is hidden');
  const old = m.categories.find(c => c.name === 'Credit Cards').items[0];
  assert.strictEqual(old.archived, true);
});

test('buildMatrix: two rows for one item+month sum in display and flag as split', () => {
  const months = bills.fyMonths('2026-27');
  const m = bills.buildMatrix(items, entries, months);
  const water = m.categories.find(c => c.name === 'Water').items[0];
  assert.strictEqual(water.cells['2026-06'].amount, 250);
  assert.strictEqual(water.cells['2026-06'].split, true);
  assert.strictEqual(water.cells['2026-04'].split, false);
});
