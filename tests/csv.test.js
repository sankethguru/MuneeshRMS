// tests/csv.test.js
// Basic coverage for csv.js — run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const csv = require('../csv.js');

test('stringify/parse round-trip preserves plain values', () => {
  const rows = [['Name', 'Amount'], ['Ravi', '100'], ['Priya', '200']];
  const text = csv.stringify(rows);
  const parsed = csv.parse(text);
  assert.deepStrictEqual(parsed, rows);
});

test('parse handles quoted fields with embedded commas', () => {
  const text = 'Name,Address\r\n"Doe, John","123 Main St"\r\n';
  const parsed = csv.parse(text);
  assert.deepStrictEqual(parsed, [['Name', 'Address'], ['Doe, John', '123 Main St']]);
});

test('parse handles embedded quotes (doubled) and newlines inside quoted fields', () => {
  const text = 'Note\r\n"He said ""hi""\nand left"\r\n';
  const parsed = csv.parse(text);
  assert.deepStrictEqual(parsed, [['Note'], ['He said "hi"\nand left']]);
});

test('parse strips a UTF-8 BOM if present', () => {
  const text = '\uFEFFName,Value\r\nA,1\r\n';
  const parsed = csv.parse(text);
  assert.strictEqual(parsed[0][0], 'Name'); // not "\uFEFFName"
});

// Security: formula injection (item #10 in the security patch)
test('stringify neutralizes cells that would execute as a formula in Excel', () => {
  assert.ok(csv.stringifyRow(['=cmd|/c calc']).startsWith("'="));
  assert.ok(csv.stringifyRow(['+1+1']).startsWith("'+"));
  assert.ok(csv.stringifyRow(['-2+3']).startsWith("'-")); // not a clean number, so it IS neutralized
  assert.ok(csv.stringifyRow(['@SUM(A1:A2)']).startsWith("'@"));
});

test('stringify does NOT neutralize a legitimate negative number', () => {
  assert.strictEqual(csv.stringifyRow(['-500']), '-500');
  assert.strictEqual(csv.stringifyRow(['-1234.56']), '-1234.56');
});
