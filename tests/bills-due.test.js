// tests/bills-due.test.js
// Pure-logic coverage for the Bills frequency / due-cadence engine
// (bills.billDueInfo). Two modes: floating ("due once it's been >= N months
// since the last entry") and anchored ("pinned to the calendar; a payment
// satisfies the current cycle rather than moving it — no drift").
// Run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const bills = require('../bills.js');

// today helper: month is 1-based here for readability.
const day = (y, m, d = 15) => new Date(y, m - 1, d);
const due = (item, months, today) => bills.billDueInfo(item, months, today).due;

// ---- Monthly (floating, N=1) reproduces the pre-frequency behavior --------
test('Monthly: no entries -> due', () => {
  assert.strictEqual(due({ EI_Frequency: 'Monthly' }, [], day(2026, 6)), true);
});
test('Monthly: entry for the current month -> not due', () => {
  assert.strictEqual(due({ EI_Frequency: 'Monthly' }, ['2026-06'], day(2026, 6)), false);
});
test('Monthly: only an older entry -> due', () => {
  assert.strictEqual(due({ EI_Frequency: 'Monthly' }, ['2026-05'], day(2026, 6)), true);
});
test('Monthly: a blank/absent frequency behaves as Monthly', () => {
  assert.strictEqual(due({}, ['2026-06'], day(2026, 6)), false);
  assert.strictEqual(due({}, ['2026-05'], day(2026, 6)), true);
});
test('Monthly: an anchor month is ignored (every month is scheduled)', () => {
  assert.strictEqual(due({ EI_Frequency: 'Monthly', EI_AnchorMonth: 'April' }, ['2026-06'], day(2026, 6)), false);
});

// ---- Quarterly / Annual, floating ----------------------------------------
test('Quarterly floating: paid within the last 3 months -> not due', () => {
  const it = { EI_Frequency: 'Quarterly' };
  assert.strictEqual(due(it, ['2026-06'], day(2026, 6)), false); // 0 months ago
  assert.strictEqual(due(it, ['2026-04'], day(2026, 6)), false); // 2 months ago
});
test('Quarterly floating: last paid 3+ months ago -> due', () => {
  assert.strictEqual(due({ EI_Frequency: 'Quarterly' }, ['2026-03'], day(2026, 6)), true);
});
test('Quarterly floating: never logged -> due (cold start)', () => {
  assert.strictEqual(due({ EI_Frequency: 'Quarterly' }, [], day(2026, 6)), true);
});
test('Annual floating: 11 months -> not due, 12 months -> due', () => {
  assert.strictEqual(due({ EI_Frequency: 'Annual' }, ['2025-07'], day(2026, 6)), false);
  assert.strictEqual(due({ EI_Frequency: 'Annual' }, ['2025-06'], day(2026, 6)), true);
});

// ---- Irregular and Archived never surface as due --------------------------
test('Irregular: never due, even with no entries', () => {
  assert.strictEqual(due({ EI_Frequency: 'Irregular' }, [], day(2026, 6)), false);
  assert.strictEqual(due({ EI_Frequency: 'Irregular' }, ['2020-01'], day(2026, 6)), false);
});
test('Archived: never due regardless of frequency', () => {
  assert.strictEqual(due({ EI_Frequency: 'Monthly', EI_Archived: true }, [], day(2026, 6)), false);
});

// ---- Anchored: pinned to the calendar, no drift ---------------------------
test('Anchored quarterly (anchor June): due in June when the cycle is unpaid', () => {
  const it = { EI_Frequency: 'Quarterly', EI_AnchorMonth: 'June' };
  assert.strictEqual(due(it, [], day(2026, 6)), true);
  assert.strictEqual(due(it, ['2026-06'], day(2026, 6)), false);
});
test('Anchored quarterly: a June payment satisfies the whole Jun–Aug cycle', () => {
  const it = { EI_Frequency: 'Quarterly', EI_AnchorMonth: 'June' };
  assert.strictEqual(due(it, ['2026-06'], day(2026, 7)), false); // July, still June cycle
  assert.strictEqual(due(it, ['2026-06'], day(2026, 8)), false); // August, still June cycle
  assert.strictEqual(due(it, [], day(2026, 7)), true);           // unpaid June cycle, seen in July
});
test('Anchored quarterly: the next cycle (Sept) is independent of the last', () => {
  const it = { EI_Frequency: 'Quarterly', EI_AnchorMonth: 'June' };
  assert.strictEqual(due(it, ['2026-06'], day(2026, 9)), true); // Sept cycle unpaid despite June paid
});
test('Anchored quarterly: NO DRIFT — a payment in the previous cycle (May) does not satisfy the June cycle', () => {
  const it = { EI_Frequency: 'Quarterly', EI_AnchorMonth: 'June' };
  // May belongs to the Mar–May cycle; it must not carry into Jun–Aug.
  assert.strictEqual(due(it, ['2026-05'], day(2026, 6)), true);
});
test('Anchored quarterly (anchor June): the schedule lands on Jun/Sep/Dec/Mar', () => {
  const it = { EI_Frequency: 'Quarterly', EI_AnchorMonth: 'June' };
  // A payment recorded in each scheduled month clears that month's view.
  assert.strictEqual(due(it, ['2026-12'], day(2026, 12)), false); // Dec is scheduled
  assert.strictEqual(due(it, ['2027-03'], day(2027, 3)), false);  // Mar is scheduled
  // February falls inside the December cycle (Dec–Feb), so a Dec payment covers it.
  assert.strictEqual(due(it, ['2026-12'], day(2027, 2)), false);
});
test('Anchored annual (anchor April): one April payment covers the whole FY', () => {
  const it = { EI_Frequency: 'Annual', EI_AnchorMonth: 'April' };
  assert.strictEqual(due(it, ['2026-04'], day(2026, 6)), false);  // paid in April, checked in June
  assert.strictEqual(due(it, ['2026-04'], day(2027, 2)), false);  // still same annual cycle in Feb
  assert.strictEqual(due(it, [], day(2026, 6)), true);            // unpaid annual cycle
  assert.strictEqual(due(it, ['2026-04'], day(2027, 4)), true);   // new FY, April cycle unpaid again
});

// ---- Reason/detail surface is populated (used by the Home widget) ---------
test('billDueInfo returns a human detail string and a mode', () => {
  const info = bills.billDueInfo({ EI_Frequency: 'Quarterly', EI_AnchorMonth: 'June' }, [], day(2026, 6));
  assert.strictEqual(info.mode, 'anchored');
  assert.match(info.detail, /cycle/);
  const floaty = bills.billDueInfo({ EI_Frequency: 'Annual' }, ['2025-06'], day(2026, 6));
  assert.strictEqual(floaty.mode, 'floating');
  assert.match(floaty.detail, /last paid/);
});
