// tests/home-widgets.test.js
// Assertion suite for widget graceful-degradation: every widget with a
// data dependency MUST return { available: false } when its required
// entity or role field is missing from the schema, rather than crashing
// or silently returning zero-shaped data. A future schema field rename
// or table removal shouldn't degrade to a silently empty widget.
// Run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const home = require('../home.js');

// A user with universal read access — permission is not what these tests
// are covering; the schema shape is.
const adminUser = { username: 'admin', isAdmin: true, permissions: {} };

// Minimal schema that has NOTHING. Every widget with a dependency should
// bail cleanly rather than blow up.
const emptySchema = { entities: {}, taxSettings: {}, homeWidgets: [] };

test('home widgets: all types tolerate an empty schema without throwing', () => {
  const types = Object.keys(home.WIDGET_TYPES);
  // computeHomeWidgets runs each widget in the list — populate with one
  // widget per type so every branch executes.
  const schema = { ...emptySchema, homeWidgets: types.map(t => ({ id: t, type: t, config: {} })) };
  let out;
  assert.doesNotThrow(() => { out = home.computeHomeWidgets(schema, adminUser); });
  // Every widget that DEPENDS on schema data should have been dropped.
  // Announcement + Quick Actions + KPI can technically render blank
  // (they're configured, not schema-derived), so we don't require them
  // to be absent — but the schema-dependent ones must be:
  const schemaDependent = ['due-soon', 'rent-status', 'tax-alerts', 'bills-due', 'uncleared-cheques', 'cc-bills-due', 'advance-tax-next-due'];
  schemaDependent.forEach(t => {
    assert.ok(!out.some(w => w.type === t),
      `widget "${t}" MUST return available:false on an empty schema; found in output`);
  });
});

test('home widgets: unknown widget type is dropped, not crashed on', () => {
  const schema = { ...emptySchema, homeWidgets: [{ id: 'x', type: 'this-does-not-exist', config: {} }] };
  const out = home.computeHomeWidgets(schema, adminUser);
  assert.strictEqual(out.length, 0);
});

test('KPI metrics: all registered metrics return null cleanly on empty schema', () => {
  Object.keys(home.KPI_METRICS).forEach(key => {
    const metric = home.KPI_METRICS[key];
    let result;
    assert.doesNotThrow(() => { result = metric.compute(emptySchema, adminUser); },
      `KPI metric "${key}" threw on empty schema`);
    assert.ok(result === null || result === undefined,
      `KPI metric "${key}" MUST return null on empty schema; got ${JSON.stringify(result)}`);
  });
});

test('KPI metric registry: kpiEligibleEntities matches registered metric keys', () => {
  assert.deepStrictEqual(home.kpiEligibleEntities().sort(), Object.keys(home.KPI_METRICS).sort());
});

test('rent-status widget: taxSettings missing invoiceRentReceivedField degrades gracefully', () => {
  const schema = {
    entities: {
      invoices: { key: 'invoices', pk: 'I_RowID', fields: [
        { name: 'I_RowID', type: 'number' }, { name: 'I_Date', type: 'date' }, { name: 'I_Amount', type: 'currency' },
      ] },
    },
    taxSettings: {
      invoiceDateField: 'I_Date', invoiceRentField: 'I_Amount',
      // invoiceRentReceivedField deliberately absent.
    },
    homeWidgets: [{ id: 'rs', type: 'rent-status', config: {} }],
  };
  const out = home.computeHomeWidgets(schema, adminUser);
  assert.strictEqual(out.length, 0, 'rent-status must not render without a mapped Rent Received field');
});
