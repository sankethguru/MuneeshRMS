// dataHealth.js
//
// A read-only diagnostic report over the entire data store, surfacing
// the classes of problem that CAN silently exist in a soft-delete +
// group + revision model but that no ordinary screen shows on its own:
//
//   1. Trashed parents referenced by active rows. A rollup or fk-hop
//      through such a parent already renders blank (getByIdActive), but
//      an admin still wants to know it's happening — either the parent
//      needs restoring, or the child needs repointing / trashing too.
//   2. Dangling fk values (fk field non-blank, pointed at nothing that
//      exists — not even in the trash). This is the "future orphan"
//      hazard: it renders blank identically to case 1, but there's
//      literally nothing to restore.
//   3. Tenant revisions with T_IsCurrent duplicates within one group.
//      Silently doubles rent in reports and rollups; specific to the
//      revision-scheme, worth its own explicit check.
//   4. Retired-field data (properties present in row data whose fields
//      no longer exist in the schema). Invisible under normal use,
//      resurface risk after a schema-import or field-add reuse.
//
// Pure over (schema, dbGetter): every branch is exported via
// findDataHealthIssues for tests, and the route is a thin renderer.
// All rows returned are ACTIVE rows (trash is the source, not the
// target) — no point flagging problems on records that are themselves
// deleted.

const schemaLib = require('./schema');
const db = require('./db');

function findDataHealthIssues(schema, dbGetter) {
  const getAll = dbGetter.getAll;                    // active rows
  const getAllWithTrash = dbGetter.getAllWithTrash;  // includes __deletedAt

  const trashedParents = [];    // { childEntity, childId, fkField, refEntity, parentId }
  const danglingFks = [];       // same shape
  const duplicateCurrentTenants = [];  // { groupRoot, count, codes: [...] }
  const orphanedFieldData = []; // { entityKey, fieldName, sampleIds: [...] }

  // Build id->row indexes ONCE per parent table across all fk fields —
  // a naive per-fk pass would call getAll(parent) once per fk field on
  // every child, which for a 20-entity schema means dozens of full-
  // table scans over the same table.
  const parentIndexActive = {};   // entityKey -> { pk: id -> row }
  const parentIndexAll = {};      // entityKey -> Set of pk values incl trash
  function indexParent(entityKey) {
    if (parentIndexActive[entityKey]) return;
    const e = schema.entities[entityKey];
    if (!e) { parentIndexActive[entityKey] = null; parentIndexAll[entityKey] = null; return; }
    const active = {};
    const allIds = new Set();
    getAllWithTrash(entityKey).forEach(r => {
      const idStr = String(r[e.pk]);
      allIds.add(idStr);
      if (!r.__deletedAt) active[idStr] = r;
    });
    parentIndexActive[entityKey] = active;
    parentIndexAll[entityKey] = allIds;
  }

  Object.values(schema.entities).forEach(entity => {
    const fkFields = entity.fields.filter(f => f.type === 'fk' && f.ref && schema.entities[f.ref]);
    if (fkFields.length === 0) return;

    fkFields.forEach(fk => indexParent(fk.ref));

    // For every ACTIVE row in the child, check every fk.
    getAll(entity.key).forEach(row => {
      fkFields.forEach(fk => {
        const raw = row[fk.name];
        if (raw === undefined || raw === null || raw === '') return;  // blank fk = no reference to check
        const idStr = String(raw);
        const active = parentIndexActive[fk.ref];
        const all = parentIndexAll[fk.ref];
        if (!active || !all) return;
        if (active[idStr]) return;    // resolves to a live parent — fine
        const record = { childEntity: entity.key, childPk: entity.pk, childId: row[entity.pk], fkField: fk.name, refEntity: fk.ref, parentId: idStr };
        if (all.has(idStr)) trashedParents.push(record);
        else danglingFks.push(record);
      });
    });
  });

  // Tenant IsCurrent duplicates — specific to the tenant-revision model.
  const tenantsEntity = schema.entities['tenants'];
  if (tenantsEntity
      && tenantsEntity.fields.some(f => f.name === 'T_IsCurrent')
      && tenantsEntity.fields.some(f => f.name === 'T_GroupRoot')) {
    const byGroup = {};
    getAll('tenants').forEach(t => {
      if (!t.T_IsCurrent) return;
      const root = t.T_GroupRoot || t[tenantsEntity.pk];
      (byGroup[root] = byGroup[root] || []).push(t[tenantsEntity.pk]);
    });
    Object.entries(byGroup).forEach(([root, codes]) => {
      if (codes.length > 1) duplicateCurrentTenants.push({ groupRoot: root, count: codes.length, codes });
    });
  }

  // Orphaned field data — schema.js's internal properties (__deletedAt/
  // __deletedBy, plus any import-batch marker) are legitimately absent
  // from the schema but present on rows, and must not be flagged.
  const RESERVED_PROPS = new Set(['__deletedAt', '__deletedBy', '__importBatch']);
  Object.values(schema.entities).forEach(entity => {
    const knownFields = new Set(entity.fields.map(f => f.name));
    const seenExtras = {};    // extra field name -> [sample ids up to 3]
    getAllWithTrash(entity.key).forEach(row => {
      Object.keys(row).forEach(key => {
        if (knownFields.has(key) || RESERVED_PROPS.has(key)) return;
        if (!seenExtras[key]) seenExtras[key] = [];
        if (seenExtras[key].length < 3) seenExtras[key].push(row[entity.pk]);
      });
    });
    Object.entries(seenExtras).forEach(([fieldName, sampleIds]) => {
      orphanedFieldData.push({ entityKey: entity.key, fieldName, sampleIds });
    });
  });

  return {
    trashedParents, danglingFks, duplicateCurrentTenants, orphanedFieldData,
    // Totals for the summary line — a healthy install returns all zeros.
    total: trashedParents.length + danglingFks.length + duplicateCurrentTenants.length + orphanedFieldData.length,
  };
}

// Thin wrapper for route consumers — pure findDataHealthIssues is what
// tests exercise, with an injected getter.
function runDataHealth(schema) {
  return findDataHealthIssues(schema, {
    getAll: (k) => db.getAll(k),
    getAllWithTrash: (k) => db.getAll(k, true),
  });
}

module.exports = { findDataHealthIssues, runDataHealth };
