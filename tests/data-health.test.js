// tests/data-health.test.js
// Coverage for the four categories of issue findDataHealthIssues surfaces
// and, importantly, the ones it correctly IGNORES: legit blank fks, fks
// pointing at active parents, __deletedAt/__deletedBy/__importBatch as
// reserved internals, and trashed CHILDREN (they can't have "problems"
// worth reporting since they're already invisible to normal reads).
// Pure over an injected getter, so no real db needed.
// Run with: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const dataHealth = require('../dataHealth.js');

function makeGetter(dataAll) {
  return {
    getAll: (k) => (dataAll[k] || []).filter(r => !r.__deletedAt),
    getAllWithTrash: (k) => (dataAll[k] || []).slice(),
  };
}

const schema = { entities: {
  landlords: { key: 'landlords', pk: 'LL_Code', label: 'Landlords', fields: [
    { name: 'LL_Code', type: 'text' }, { name: 'LL_Display', type: 'text' },
  ] },
  invoices: { key: 'invoices', pk: 'I_RowID', label: 'Invoices', fields: [
    { name: 'I_RowID', type: 'number' }, { name: 'I_LL', type: 'fk', ref: 'landlords' },
  ] },
  tenants: { key: 'tenants', pk: 'T_Code', label: 'Tenants', fields: [
    { name: 'T_Code', type: 'text' }, { name: 'T_GroupRoot', type: 'text' },
    { name: 'T_IsCurrent', type: 'boolean' }, { name: 'T_Notes', type: 'text' },
  ] },
} };

test('data-health: healthy store returns all zeros', () => {
  const data = {
    landlords: [{ LL_Code: 'A', LL_Display: 'Alice' }, { LL_Code: 'B', LL_Display: 'Bob' }],
    invoices: [{ I_RowID: 1, I_LL: 'A' }, { I_RowID: 2, I_LL: 'B' }],
    tenants: [{ T_Code: 'TG1', T_GroupRoot: 'TG1', T_IsCurrent: true }],
  };
  const issues = dataHealth.findDataHealthIssues(schema, makeGetter(data));
  assert.strictEqual(issues.total, 0);
});

test('data-health: trashed parent referenced by active child is flagged; child in trash is not', () => {
  const data = {
    landlords: [{ LL_Code: 'A', LL_Display: 'Alice', __deletedAt: '2026-01-01T00:00Z' }],
    invoices: [
      { I_RowID: 1, I_LL: 'A' },                          // active child → trashed parent: FLAG
      { I_RowID: 2, I_LL: 'A', __deletedAt: '2026-01-02T00:00Z' },  // trashed child → not flagged
    ],
    tenants: [],
  };
  const issues = dataHealth.findDataHealthIssues(schema, makeGetter(data));
  assert.strictEqual(issues.trashedParents.length, 1);
  assert.strictEqual(issues.trashedParents[0].childId, 1);
  assert.strictEqual(issues.trashedParents[0].parentId, 'A');
  assert.strictEqual(issues.danglingFks.length, 0);
});

test('data-health: dangling fk (no such parent anywhere) is distinguished from trashed parent', () => {
  const data = {
    landlords: [{ LL_Code: 'A' }],
    invoices: [
      { I_RowID: 1, I_LL: 'GONE' },   // no parent anywhere: dangling
      { I_RowID: 2, I_LL: 'A' },      // fine
      { I_RowID: 3, I_LL: '' },       // blank fk: legitimate, not a problem
      { I_RowID: 4, I_LL: null },     // null fk: same
    ],
    tenants: [],
  };
  const issues = dataHealth.findDataHealthIssues(schema, makeGetter(data));
  assert.strictEqual(issues.danglingFks.length, 1);
  assert.strictEqual(issues.danglingFks[0].parentId, 'GONE');
  assert.strictEqual(issues.trashedParents.length, 0);
});

test('data-health: duplicate T_IsCurrent within a group is flagged, single-current is not', () => {
  const data = {
    landlords: [], invoices: [],
    tenants: [
      { T_Code: 'TG1', T_GroupRoot: 'TG1', T_IsCurrent: true },
      { T_Code: 'TG1.1', T_GroupRoot: 'TG1', T_IsCurrent: true },   // dup!
      { T_Code: 'TG2', T_GroupRoot: 'TG2', T_IsCurrent: true },
      { T_Code: 'TG2.1', T_GroupRoot: 'TG2', T_IsCurrent: false },  // fine — only one current
      { T_Code: 'TG3', T_GroupRoot: 'TG3', T_IsCurrent: false },    // no current at all: fine (may be intentional)
    ],
  };
  const issues = dataHealth.findDataHealthIssues(schema, makeGetter(data));
  assert.strictEqual(issues.duplicateCurrentTenants.length, 1);
  assert.strictEqual(issues.duplicateCurrentTenants[0].groupRoot, 'TG1');
  assert.deepStrictEqual(issues.duplicateCurrentTenants[0].codes.sort(), ['TG1', 'TG1.1']);
});

test('data-health: orphaned field data is flagged; reserved internals never are', () => {
  const data = {
    landlords: [
      { LL_Code: 'A', LL_Display: 'Alice', LL_LegacyPhone: '555-1234' },   // orphan!
      { LL_Code: 'B', LL_Display: 'Bob', LL_LegacyPhone: '555-5678', __deletedAt: '2026-01-01T00:00Z', __deletedBy: 'admin', __importBatch: 'imp-xyz' },
    ],
    invoices: [], tenants: [],
  };
  const issues = dataHealth.findDataHealthIssues(schema, makeGetter(data));
  const orphan = issues.orphanedFieldData.find(o => o.fieldName === 'LL_LegacyPhone');
  assert.ok(orphan, 'LL_LegacyPhone should be flagged');
  assert.strictEqual(orphan.entityKey, 'landlords');
  assert.strictEqual(orphan.sampleIds.length, 2);
  // Reserved internals must NEVER appear as orphans.
  const bad = issues.orphanedFieldData.map(o => o.fieldName);
  assert.ok(!bad.includes('__deletedAt') && !bad.includes('__deletedBy') && !bad.includes('__importBatch'),
    'reserved internals must never be flagged as orphan data');
});

test('data-health: parent index reuse — fks to same table across entities scanned once', () => {
  // Regression protection for the perf comment: same parent (landlords)
  // referenced by two different entities via different fk fields. Both
  // must produce correct results.
  const data = {
    landlords: [{ LL_Code: 'A' }],
    invoices: [{ I_RowID: 1, I_LL: 'GONE' }],   // dangling
    tenants: [],
    property: [{ P_Code: 'PROP1', P_Landlord: 'GONE2' }],   // dangling
  };
  const schemaWithProp = { entities: { ...schema.entities,
    property: { key: 'property', pk: 'P_Code', label: 'Property', fields: [
      { name: 'P_Code', type: 'text' }, { name: 'P_Landlord', type: 'fk', ref: 'landlords' },
    ] },
  } };
  const issues = dataHealth.findDataHealthIssues(schemaWithProp, makeGetter(data));
  assert.strictEqual(issues.danglingFks.length, 2);
  const parents = issues.danglingFks.map(d => d.parentId).sort();
  assert.deepStrictEqual(parents, ['GONE', 'GONE2']);
});
