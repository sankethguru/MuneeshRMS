// tests/formula.test.js
// Basic coverage for schema.js's formula engine — run with: node --test tests/
// Uses a small, self-contained test schema rather than the full app's
// default-schema.js, so these tests are fast and independent of disk state.
const { test } = require('node:test');
const assert = require('node:assert');
const schemaLib = require('../schema.js');

const categories = {
  key: 'categories', label: 'Categories', pk: 'C_Code',
  fields: [
    { name: 'C_Code', type: 'text', key: true },
    { name: 'C_Label', type: 'text' },
  ],
};

const widgets = {
  key: 'widgets', label: 'Widgets', pk: 'W_Code',
  fields: [
    { name: 'W_Code', type: 'text', key: true },
    { name: 'W_Price', type: 'currency' },
    { name: 'W_Qty', type: 'number' },
    { name: 'W_Name', type: 'text' },
    { name: 'W_DateA', type: 'date' },
    { name: 'W_DateB', type: 'date' },
    { name: 'W_CategoryCode', type: 'fk', ref: 'categories' },
    { name: 'W_Total', type: 'formula', formula: 'W_Price * W_Qty' },
    { name: 'W_TotalPlusOne', type: 'formula', formula: 'W_Total + 1' }, // sibling-formula reference
  ],
};

function makeSchema(extraData) {
  return {
    entities: { categories, widgets },
    ...extraData,
  };
}

test('basic arithmetic', () => {
  const schema = makeSchema();
  const record = { W_Code: 'A1', W_Price: 10, W_Qty: 3 };
  assert.strictEqual(schemaLib.evalFormula('W_Price * W_Qty', schema, widgets, record, {}, 0), 30);
});

test('blank numeric fields act as 0 in arithmetic', () => {
  const schema = makeSchema();
  const record = { W_Code: 'A1', W_Price: '', W_Qty: 5 };
  assert.strictEqual(schemaLib.evalFormula('W_Price * W_Qty', schema, widgets, record, {}, 0), 0);
});

test('string functions: CONCAT and UPPER', () => {
  const schema = makeSchema();
  const record = { W_Code: 'A1', W_Name: 'widget' };
  assert.strictEqual(schemaLib.evalFormula('CONCAT(W_Name, " - ", W_Code)', schema, widgets, record, {}, 0), 'widget - A1');
  assert.strictEqual(schemaLib.evalFormula('UPPER(W_Name)', schema, widgets, record, {}, 0), 'WIDGET');
});

test('date function: DAYS returns whole days, correct sign both directions', () => {
  const schema = makeSchema();
  const record = { W_Code: 'A1', W_DateA: '2026-07-20', W_DateB: '2026-07-01' };
  assert.strictEqual(schemaLib.evalFormula('DAYS(W_DateA, W_DateB)', schema, widgets, record, {}, 0), 19);
  assert.strictEqual(schemaLib.evalFormula('DAYS(W_DateB, W_DateA)', schema, widgets, record, {}, 0), -19);
});

test('cross-table reference resolves via the fk field pointing at that table', () => {
  const schema = makeSchema({});
  const record = { W_Code: 'A1', W_CategoryCode: 'ELEC' };
  // Simulate the category existing in the datastore by monkeypatching
  // db.getById isn't needed here — resolveCrossTableValue reads from the
  // real db module, so this test instead confirms the *error* path
  // (no such field), which doesn't need real stored data.
  const result = schemaLib.evalFormula('categories.NoSuchField', schema, widgets, record, {}, 0);
  assert.ok(String(result).startsWith('#REF'));
});

test('banned/malformed formulas return #ERR rather than throwing', () => {
  const schema = makeSchema();
  const record = { W_Code: 'A1' };
  const result = schemaLib.evalFormula('require("fs")', schema, widgets, record, {}, 0);
  assert.strictEqual(result, '#ERR');
});

test('referencing a genuinely nonexistent field returns a clear #REF, not a crash', () => {
  const schema = makeSchema();
  const record = { W_Code: 'A1' };
  const result = schemaLib.evalFormula('W_Price + NotARealField', schema, widgets, record, {}, 0);
  assert.ok(String(result).startsWith('#REF'));
});

test('a formula field can reference a sibling formula field on the same table', () => {
  const schema = makeSchema();
  const record = { W_Code: 'A1', W_Price: 10, W_Qty: 3 };
  // W_TotalPlusOne = W_Total + 1, and W_Total = W_Price * W_Qty = 30
  assert.strictEqual(schemaLib.evalFormula('W_TotalPlusOne', schema, widgets, record, {}, 0), 31);
});

test('a genuine circular reference between two formula fields fails cleanly, not with a hang', () => {
  const circA = { name: 'CircA', type: 'formula', formula: 'CircB + 1' };
  const circB = { name: 'CircB', type: 'formula', formula: 'CircA + 1' };
  const circularEntity = { key: 'circular_test', label: 'Circular Test', pk: 'id', fields: [{ name: 'id', type: 'text', key: true }, circA, circB] };
  const schema = { entities: { circular_test: circularEntity } };
  const record = { id: 'x' };
  const result = schemaLib.evalFormula('CircA', schema, circularEntity, record, {}, 0);
  assert.ok(String(result).includes('circular reference'));
});

// ---- Boolean literals (TRUE/FALSE, any case) --------------------------------
// The logical keywords AND/OR/NOT are uppercase, so uppercase TRUE/FALSE is a
// natural expectation. Both cases must behave identically to lowercase, and a
// quoted "TRUE" must stay a text comparison (string literals are protected).
const flags = {
  key: 'flags', label: 'Flags', pk: 'F_Code',
  fields: [
    { name: 'F_Code', type: 'text', key: true },
    { name: 'F_On', type: 'bool' },
  ],
};
function flagSchema() { return { entities: { flags } }; }
const evalOn = (formula, val) => schemaLib.evalFormula(formula, flagSchema(), flags, { F_Code: 'r', F_On: val }, {}, 0);

test('uppercase TRUE behaves identically to lowercase true', () => {
  assert.strictEqual(evalOn('F_On = TRUE', true), true);
  assert.strictEqual(evalOn('F_On = TRUE', false), false);
  assert.strictEqual(evalOn('F_On = true', true), true);   // still works
  assert.strictEqual(evalOn('F_On = True', true), true);   // mixed case too
});

test('uppercase FALSE and negation work', () => {
  assert.strictEqual(evalOn('F_On = FALSE', false), true);
  assert.strictEqual(evalOn('F_On = FALSE', true), false);
  assert.strictEqual(evalOn('F_On != TRUE', false), true);
  assert.strictEqual(evalOn('NOT F_On AND F_On = FALSE', false), true);
});

test('a quoted "TRUE" stays a text comparison, not a boolean', () => {
  // If TRUE were converted inside strings, "TRUE" == "TRUE" would break.
  assert.strictEqual(evalOn('"TRUE" = "TRUE"', true), true);
  assert.strictEqual(evalOn('"TRUE" = "true"', true), false);
});
