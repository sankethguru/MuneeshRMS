// tests/picklist-key-label.test.js
// v4.1.0: picklist fields now store a stable KEY (never changes) and
// resolve a LABEL for display (editable anytime) — the same store-a-key,
// resolve-a-label shape an fk field already has. This directly tests the
// bug report: renaming a picklist's display value must NOT break existing
// records referencing it. Uses the shared ./data dir like every other
// test file in this project; entity/picklist keys are timestamped so
// repeated runs never collide with leftover state. Run: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const schemaLib = require('../schema.js');
const db = require('../db.js');

function freshSchema() {
  schemaLib.load();
  return schemaLib.load();
}

test('static global picklist: renaming a label preserves the key and existing record resolution', () => {
  let schema = freshSchema();
  const pl = schemaLib.addPicklist(schema, { label: 'Status Test ' + Date.now(), sourceType: 'static', values: [{ label: 'Active' }, { label: 'Inactive' }] });
  schemaLib.persist(schema);
  schema = schemaLib.load();
  const before = schemaLib.picklistByKey(schema, pl.key);
  const activeKey = before.values.find(v => v.label === 'Active').key;
  const inactiveKey = before.values.find(v => v.label === 'Inactive').key;

  // Rename "Active" -> "Currently Active", submitting the SAME key.
  schemaLib.updatePicklist(schema, pl.key, {
    label: before.label, sourceType: 'static',
    values: [
      { key: activeKey, label: 'Currently Active', active: true },
      { key: inactiveKey, label: 'Inactive', active: true },
    ],
  });
  schemaLib.persist(schema);
  schema = schemaLib.load();
  const after = schemaLib.picklistByKey(schema, pl.key);
  assert.strictEqual(after.values.find(v => v.key === activeKey).label, 'Currently Active', 'key survived the rename');
  assert.strictEqual(after.values.length, 2, 'no duplicate/orphaned rows created');
});

test('custom (per-field) picklist: a record storing the key resolves the current label after a rename, including through formulas', () => {
  let schema = freshSchema();
  const tKey = 'pl_test_' + Date.now();
  schema.entities[tKey] = { key: tKey, label: 'PL Test', singular: 'Row', pk: 'ID', pkAuto: true, fields: [
    { name: 'ID', type: 'text', key: true },
    { name: 'F_Status', label: 'Status', type: 'picklist', picklistSource: 'custom', picklistValues: [] },
  ], listColumns: ['ID'], filterFields: [], inAdmin: true };
  schemaLib.persist(schema);
  schema = schemaLib.load();

  schemaLib.updateField(schema, tKey, 'F_Status', {
    label: 'Status', type: 'picklist', picklistSource: 'custom',
    picklistValues: [{ label: 'Active' }, { label: 'Inactive' }],
  });
  schemaLib.persist(schema);
  schema = schemaLib.load();

  const field = schema.entities[tKey].fields.find(f => f.name === 'F_Status');
  const activeKey = field.picklistValues.find(v => v.label === 'Active').key;

  db.runWithRequestCache(() => {
    db.insert(tKey, { ID: 'r1', F_Status: activeKey });
  });

  // Rename the label, preserving the key.
  schemaLib.updateField(schema, tKey, 'F_Status', {
    label: 'Status', type: 'picklist', picklistSource: 'custom',
    picklistValues: [
      { key: activeKey, label: 'Currently Active' },
      { key: field.picklistValues.find(v => v.label === 'Inactive').key, label: 'Inactive' },
    ],
  });
  schemaLib.persist(schema);
  schema = schemaLib.load();

  db.runWithRequestCache(() => {
    const rec = db.getById(tKey, 'ID', 'r1');
    const f2 = schema.entities[tKey].fields.find(f => f.name === 'F_Status');
    assert.strictEqual(rec.F_Status, activeKey, 'stored value is still the unchanged key');
    assert.strictEqual(schemaLib.resolvePicklistLabel(schema, schema.entities[tKey], f2, rec.F_Status), 'Currently Active', 'label resolves to the renamed text');
    assert.strictEqual(schemaLib.evalFormula('F_Status', schema, schema.entities[tKey], rec, {}, 0), 'Currently Active', 'bare-field formula reference resolves to the current label');
    assert.strictEqual(schemaLib.evalFormula('F_Status = "Currently Active"', schema, schema.entities[tKey], rec, {}, 0), true, 'comparison formula matches the current label');
    assert.strictEqual(schemaLib.evalFormula('F_Status = "Active"', schema, schema.entities[tKey], rec, {}, 0), false, 'the OLD label text no longer matches (expected — labels are the current truth)');
  });
});

test('resolvePicklistOptions returns key/label pairs for a custom picklist, active only', () => {
  let schema = freshSchema();
  const tKey = 'pl_test2_' + Date.now();
  schema.entities[tKey] = { key: tKey, label: 'PL Test2', singular: 'Row', pk: 'ID', pkAuto: true, fields: [
    { name: 'ID', type: 'text', key: true },
    { name: 'F_Status', label: 'Status', type: 'picklist', picklistSource: 'custom', picklistValues: [
      { key: 'a', label: 'Alpha', active: true },
      { key: 'b', label: 'Beta', active: false },
    ] },
  ], listColumns: ['ID'], filterFields: [], inAdmin: true };
  const opts = schemaLib.resolvePicklistOptions(schema, schema.entities[tKey], schema.entities[tKey].fields[1]);
  assert.deepStrictEqual(opts, [{ key: 'a', label: 'Alpha' }], 'only the active option is offered');
});

test('table-sourced picklist can use a formula/computed field as its sourceValueField', () => {
  let schema = freshSchema();
  const tKey = 'pl_test4_' + Date.now();
  schema.entities[tKey] = { key: tKey, label: 'PL Test4', singular: 'Row', pk: 'ID', pkAuto: true, fields: [
    { name: 'ID', type: 'text', key: true },
    { name: 'Base', label: 'Base', type: 'text' },
    { name: 'Computed', label: 'Computed', type: 'formula', formula: 'CONCAT(Base, " suffix")' },
  ], listColumns: ['ID'], filterFields: [], inAdmin: true };
  schemaLib.persist(schema);
  schema = schemaLib.load();

  db.runWithRequestCache(() => {
    db.insert(tKey, { ID: 'row1', Base: 'Hello' });
  });

  const pl = schemaLib.addPicklist(schema, { label: 'Computed Picklist', sourceType: 'table', sourceTable: tKey, sourceValueField: 'Computed' });
  schemaLib.persist(schema);
  schema = schemaLib.load();

  db.runWithRequestCache(() => {
    const field = { picklistSource: 'global', picklistKey: pl.key };
    const options = schemaLib.resolvePicklistOptions(schema, schema.entities[tKey], field);
    assert.deepStrictEqual(options, [{ key: 'row1', label: 'Hello suffix' }], 'formula field resolves as the picklist label, not blank/undefined');
    assert.strictEqual(schemaLib.resolvePicklistLabel(schema, schema.entities[tKey], field, 'row1'), 'Hello suffix', 'reverse lookup also resolves the formula field');
  });
});

test('resolvePicklistLabel falls back to the raw key if the option was fully deleted', () => {
  let schema = freshSchema();
  const tKey = 'pl_test3_' + Date.now();
  schema.entities[tKey] = { key: tKey, label: 'PL Test3', singular: 'Row', pk: 'ID', pkAuto: true, fields: [
    { name: 'ID', type: 'text', key: true },
    { name: 'F_Status', label: 'Status', type: 'picklist', picklistSource: 'custom', picklistValues: [{ key: 'a', label: 'Alpha', active: true }] },
  ], listColumns: ['ID'], filterFields: [], inAdmin: true };
  const field = schema.entities[tKey].fields[1];
  assert.strictEqual(schemaLib.resolvePicklistLabel(schema, schema.entities[tKey], field, 'ghost-key'), 'ghost-key');
});
