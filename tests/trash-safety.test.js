// tests/trash-safety.test.js
// The invariants that soft-delete depends on:
//   - db.getByIdActive returns null for trashed parents (and getById does not)
//   - Cross-table fk reads in schema.js return undefined via the active
//     resolver — verified on a formula that dots through an fk to a
//     trashed record.
//   - db.dropFieldFromRows strips a property from every row and NEVER
//     touches reserved internals or any other field.
// Uses the real db via runWithRequestCache with a temp file so these
// tests don't depend on any user's data.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Redirect the data file for this test's process BEFORE requiring db.
// db.js reads DATA_DIR at require time via __dirname, so the cleanest
// approach is a temp working directory.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-trash-test-'));
const tmpDataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(tmpDataDir);
const tmpDb = path.join(tmpDataDir, 'db.json');

// Point the module at our temp store — the simplest way is a bind mount
// via a fresh require cache with a proxied fs, but that's overkill;
// instead, seed the real data file location. Since data path is baked
// into db.js (path.join(__dirname, 'data')), we can't relocate it from a
// test without a shim. Instead, we back up and restore any existing
// data/db.json around this test's run. On CI or a clean checkout there
// is no data yet, so this is a no-op.
const realDataFile = path.join(__dirname, '..', 'data', 'db.json');
const realDataDir = path.dirname(realDataFile);
let backupContent = null;
if (fs.existsSync(realDataFile)) backupContent = fs.readFileSync(realDataFile);
if (!fs.existsSync(realDataDir)) fs.mkdirSync(realDataDir, { recursive: true });

test.after(() => {
  if (backupContent !== null) fs.writeFileSync(realDataFile, backupContent);
  else if (fs.existsSync(realDataFile)) fs.unlinkSync(realDataFile);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

const db = require('../db.js');
const schemaLib = require('../schema.js');

function seed() {
  fs.writeFileSync(realDataFile, JSON.stringify({
    landlords: [
      { LL_Code: 'A', LL_Display: 'Alice Live' },
      { LL_Code: 'B', LL_Display: 'Bob Trashed', __deletedAt: '2026-01-01T00:00Z' },
    ],
    invoices: [
      { I_RowID: 1, I_LL: 'A', I_Amount: 1000, I_Legacy: 'stale value' },
      { I_RowID: 2, I_LL: 'B', I_Amount: 2000 },   // points at trashed landlord
    ],
  }, null, 2));
}

test('getByIdActive returns the row for a live parent, null for a trashed one', () => {
  seed();
  db.runWithRequestCache(() => {
    const live = db.getByIdActive('landlords', 'LL_Code', 'A');
    const trashed = db.getByIdActive('landlords', 'LL_Code', 'B');
    assert.ok(live && live.LL_Display === 'Alice Live');
    assert.strictEqual(trashed, null);
    // getById itself must still find the trashed row (needed by the
    // Trash view and detail page — this is the whole reason we needed
    // a second function rather than changing getById's behavior).
    assert.ok(db.getById('landlords', 'LL_Code', 'B'));
  });
});

test('schema.js cross-table fk read returns undefined for a trashed parent', () => {
  seed();
  const schema = {
    entities: {
      landlords: { key: 'landlords', pk: 'LL_Code', fields: [
        { name: 'LL_Code', type: 'text' }, { name: 'LL_Display', type: 'text' },
      ] },
      invoices: { key: 'invoices', pk: 'I_RowID', fields: [
        { name: 'I_RowID', type: 'number' }, { name: 'I_LL', type: 'fk', ref: 'landlords' },
        { name: 'I_LandlordName', type: 'formula', formula: 'I_LL.LL_Display' },
      ] },
    },
  };
  db.runWithRequestCache(() => {
    const invA = { I_RowID: 1, I_LL: 'A' };
    const invB = { I_RowID: 2, I_LL: 'B' };
    const outA = schemaLib.withComputedFields(schema, schema.entities.invoices, invA);
    const outB = schemaLib.withComputedFields(schema, schema.entities.invoices, invB);
    // Live parent resolves normally.
    assert.strictEqual(outA.I_LandlordName, 'Alice Live');
    // Trashed parent renders blank via the same "no such record" path
    // a dangling fk would take — the point of getByIdActive.
    assert.ok(!outB.I_LandlordName, 'trashed parent must not surface old data via fk-hop; got: ' + JSON.stringify(outB.I_LandlordName));
  });
});

test('dropFieldFromRows removes the property from every row and touches nothing else', () => {
  seed();
  db.runWithRequestCache(() => {
    const beforeInvoices = db.getAll('invoices', true);
    assert.ok(beforeInvoices.some(r => 'I_Legacy' in r), 'seed row must have I_Legacy for the test to be meaningful');
    const beforeLandlords = db.getAll('landlords', true);
    const changed = db.dropFieldFromRows('invoices', 'I_Legacy');
    assert.strictEqual(changed, 1);
    const afterInvoices = db.getAll('invoices', true);
    afterInvoices.forEach(r => assert.ok(!('I_Legacy' in r), `I_Legacy still present on row ${r.I_RowID}`));
    // Other fields on the same table are untouched.
    afterInvoices.forEach(r => assert.strictEqual(r.I_Amount, beforeInvoices.find(b => b.I_RowID === r.I_RowID).I_Amount));
    // Other tables are untouched entirely.
    const afterLandlords = db.getAll('landlords', true);
    assert.strictEqual(JSON.stringify(afterLandlords), JSON.stringify(beforeLandlords));
    // Reserved internals on the trashed landlord row survive: the
    // migration primitive should NEVER be able to touch them.
    assert.strictEqual(afterLandlords[1].__deletedAt, '2026-01-01T00:00Z');
    // Idempotent — a second call finds nothing to change.
    assert.strictEqual(db.dropFieldFromRows('invoices', 'I_Legacy'), 0);
  });
});
