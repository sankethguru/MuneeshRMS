// tests/fk-constraint.test.js
// Coverage for the generic fk-picker constraint engine (fkWhere): filtering
// candidate referenced rows (static + dependent conditions), extracting the
// sibling fields a condition depends on, and the single-row save-time check.
// Self-contained schema — no disk/db state. Run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const schemaLib = require('../schema.js');

const landlords = {
  key: 'landlords', label: 'Landlords', singular: 'Landlord', pk: 'LL_Code',
  fields: [
    { name: 'LL_Code', type: 'text', key: true },
    { name: 'LL_GroupRoot', type: 'text' },
  ],
};
const tenants = {
  key: 'tenants', label: 'Tenants', singular: 'Tenant', pk: 'T_Code',
  fields: [
    { name: 'T_Code', type: 'text', key: true },
    { name: 'T_Active', type: 'bool' },
    { name: 'T_MappedTo', type: 'fk', ref: 'landlords' },
  ],
};
const invoices = {
  key: 'invoices', label: 'Invoices', singular: 'Invoice', pk: 'INV_ID',
  fields: [
    { name: 'INV_ID', type: 'text', key: true },
    { name: 'INV_Landlord', type: 'fk', ref: 'landlords', fkWhere: 'LL_Code != LL_GroupRoot' },
    { name: 'INV_Tenant', type: 'fk', ref: 'tenants', fkWhere: 'T_Active = true AND T_MappedTo = parent.INV_Landlord' },
  ],
};
const schema = { entities: { landlords, tenants, invoices } };

const LL = [
  { LL_Code: 'ROOT', LL_GroupRoot: 'ROOT' }, // the group root — its code equals its own root
  { LL_Code: 'SUB1', LL_GroupRoot: 'ROOT' }, // a state-specific sub-landlord
  { LL_Code: 'SUB2', LL_GroupRoot: 'ROOT' },
];
const TEN = [
  { T_Code: 'T1', T_Active: true, T_MappedTo: 'SUB1' },
  { T_Code: 'T2', T_Active: false, T_MappedTo: 'SUB1' }, // inactive
  { T_Code: 'T3', T_Active: true, T_MappedTo: 'SUB2' },
];

const llField = invoices.fields.find(f => f.name === 'INV_Landlord');
const tenField = invoices.fields.find(f => f.name === 'INV_Tenant');
const codes = rows => rows.map(r => r[Object.keys(r)[0]]);

// ---- Static condition: landlord must not be its own group root -----------
test('static fkWhere drops the group root, keeps sub-landlords', () => {
  const out = schemaLib.fkWhereFilterRows(schema, llField, landlords, LL, invoices, {});
  assert.deepStrictEqual(codes(out).sort(), ['SUB1', 'SUB2']);
});

// ---- Dependent condition: tenants of the chosen landlord, active only ----
test('dependent fkWhere narrows tenants to the chosen landlord + active', () => {
  const forSub1 = schemaLib.fkWhereFilterRows(schema, tenField, tenants, TEN, invoices, { INV_Landlord: 'SUB1' });
  assert.deepStrictEqual(codes(forSub1), ['T1']); // T2 inactive, T3 other landlord
  const forSub2 = schemaLib.fkWhereFilterRows(schema, tenField, tenants, TEN, invoices, { INV_Landlord: 'SUB2' });
  assert.deepStrictEqual(codes(forSub2), ['T3']);
});

test('dependent fkWhere yields nothing until the landlord is chosen', () => {
  const none = schemaLib.fkWhereFilterRows(schema, tenField, tenants, TEN, invoices, {});
  assert.deepStrictEqual(none, []);
});

test('no parent record (e.g. a list-filter dropdown) means no filtering', () => {
  const all = schemaLib.fkWhereFilterRows(schema, tenField, tenants, TEN, invoices, null);
  assert.deepStrictEqual(codes(all), ['T1', 'T2', 'T3']);
});

test('a field with no fkWhere is never filtered', () => {
  const plain = { name: 'X', type: 'fk', ref: 'tenants' };
  const all = schemaLib.fkWhereFilterRows(schema, plain, tenants, TEN, invoices, { INV_Landlord: 'SUB1' });
  assert.deepStrictEqual(codes(all), ['T1', 'T2', 'T3']);
});

// ---- Parent-ref extraction (which siblings a picker depends on) ----------
test('fkWhereParentRefs extracts parent.<field> references, de-duplicated', () => {
  assert.deepStrictEqual(schemaLib.fkWhereParentRefs('LL_Code != LL_GroupRoot'), []);
  assert.deepStrictEqual(schemaLib.fkWhereParentRefs('T_Active = true AND T_MappedTo = parent.INV_Landlord'), ['INV_Landlord']);
  assert.deepStrictEqual(schemaLib.fkWhereParentRefs('parent.A + parent.B - parent.A'), ['A', 'B']);
  assert.deepStrictEqual(schemaLib.fkWhereParentRefs(''), []);
  assert.deepStrictEqual(schemaLib.fkWhereParentRefs(undefined), []);
});

// ---- Single-row save-time check ------------------------------------------
test('fkRowSatisfies enforces the same condition on a single row', () => {
  assert.strictEqual(schemaLib.fkRowSatisfies(schema, invoices, llField, landlords, { LL_Code: 'ROOT', LL_GroupRoot: 'ROOT' }, {}), false);
  assert.strictEqual(schemaLib.fkRowSatisfies(schema, invoices, llField, landlords, { LL_Code: 'SUB1', LL_GroupRoot: 'ROOT' }, {}), true);
  assert.strictEqual(schemaLib.fkRowSatisfies(schema, invoices, tenField, tenants, TEN[0], { INV_Landlord: 'SUB1' }), true);  // T1 active, SUB1
  assert.strictEqual(schemaLib.fkRowSatisfies(schema, invoices, tenField, tenants, TEN[1], { INV_Landlord: 'SUB1' }), false); // T2 inactive
  assert.strictEqual(schemaLib.fkRowSatisfies(schema, invoices, tenField, tenants, TEN[0], { INV_Landlord: 'SUB2' }), false); // T1 not mapped to SUB2
});
