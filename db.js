// db.js
// Lightweight synchronous JSON-file datastore. No native bindings, so it
// builds cleanly on any Docker base image. Fine for an admin-scale app
// like this (hundreds, not millions, of records).
//
// Request-scoped read cache: the previous implementation read and parsed
// data/db.json fresh for every getAll/getById/getChildren call, which
// meant a single "/bills" render with 100 records and cross-table
// formulas could do thousands of file reads (measured: 2.5s average, 5s
// worst). To fix this without changing storage, callers wrap request
// handling in runWithRequestCache() and all reads inside that window
// share a single parse. Writes go through immediately and invalidate
// the cache.
//
// Uses AsyncLocalStorage (Node's built-in mechanism for values scoped to
// the current async call chain) rather than a plain module-level
// variable — the original implementation used a single shared variable
// for this, meaning two genuinely overlapping requests (plausible: any
// route that awaits, e.g. PayQR's QR generation) would clobber each
// other's cache mid-flight. AsyncLocalStorage gives each request's own
// async chain its own isolated store automatically, with no risk of one
// request's cache leaking into or being reset by another's.

const fs = require('fs');
const { atomicWriteFileSync } = require('./fsutil');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const requestCacheStorage = new AsyncLocalStorage();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = require('./seed.js');
    atomicWriteFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function loadRaw() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function currentData() {
  const store = requestCacheStorage.getStore();
  if (store) return store.data;
  return loadRaw();
}

// Runs fn() (typically the rest of an Express request's middleware/route
// chain, via calling next() inside it) with a fresh, isolated request
// cache — replaces the old beginRequest()/endRequest() pair, which
// mutated one shared variable rather than genuinely scoping per request.
function runWithRequestCache(fn) {
  return requestCacheStorage.run({ data: loadRaw(), byId: {}, byFk: {}, lookupCache: {}, tableIndexCache: {}, computedMemo: {} }, fn);
}

function save(data) {
  atomicWriteFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  const store = requestCacheStorage.getStore();
  if (store) {
    store.data = data;
    store.byId = {};
    store.byFk = {};
    store.lookupCache = {};
    store.tableIndexCache = {};
    store.computedMemo = {};
  }
}

// Request-scoped cache for LOOKUP() formula results (see schema.js) — a
// LOOKUP condition scanning a large table (e.g. 1000+ GST rate rows)
// produces the same result for any two calls whose caller-side values
// are the same, and with real data many rows share the same effective
// query (e.g. many invoices in the same month/year). Returns null when
// there's no active request cache (rare — a script calling schema.js
// directly outside a request) rather than throwing, so LOOKUP still
// works correctly, just uncached, in that case.
function getLookupCache() {
  const store = requestCacheStorage.getStore();
  return store ? store.lookupCache : null;
}

// Request-scoped cache for a built table index (see schema.js's
// buildTableIndex) — the memoization above only helps when two LOOKUP
// calls happen to ask the exact same question; this instead builds one
// real hash index of the target table (by whichever fields a
// pure-AND-of-equalities condition indexes on) so every call after the
// first is an O(1) hash lookup regardless of how much the actual data
// repeats. Same null-when-no-request-cache behavior as above.
function getTableIndexCache() {
  const store = requestCacheStorage.getStore();
  return store ? store.tableIndexCache : null;
}

// Request-scoped memo of fully-computed formula/rollup field values, keyed
// by "entityKey|pk|fieldName" (see schema.js's resolveComputedField and
// withComputedFields for exactly what gets stored and when). This is what
// stops a table full of interdependent formulas (I_TotalBill referencing
// I_CGSTAmt referencing I_CGSTPC ...) recomputing the same field's value
// over and over for the same record within one request — measured on a
// real 2,100-invoice list view, that redundant recomputation (not
// LOOKUP scanning, and not new Function compilation, both already
// addressed) was the dominant cost of the whole page. Cleared on every
// save() like the other request caches, since a write can change any
// value a memoized formula depended on. Same null-when-no-request-cache
// behavior as the getters above.
function getComputedMemo() {
  const store = requestCacheStorage.getStore();
  return store ? store.computedMemo : null;
}

function getAll(entityKey, includeDeleted) {
  const rows = currentData()[entityKey] || [];
  return includeDeleted ? rows : rows.filter(r => !r.__deletedAt);
}

function getById(entityKey, pkField, id) {
  // Direct lookup by known ID deliberately does NOT exclude soft-deleted
  // records — the detail page and Trash view both need to still find a
  // soft-deleted record directly (to show "this is in the trash" +
  // restore, or to actually restore/purge it), unlike getAll/getChildren
  // below, which are for "find matching rows" scenarios (lists, rollups,
  // reports) where a soft-deleted record should stay invisible.
  const store = requestCacheStorage.getStore();
  if (store) {
    const key = `${pkField}|${id}`;
    if (!store.byId[entityKey]) {
      store.byId[entityKey] = {};
      const rows = getAll(entityKey, true);
      rows.forEach(r => { store.byId[entityKey][`${pkField}|${r[pkField]}`] = r; });
    }
    return store.byId[entityKey][key];
  }
  const rows = getAll(entityKey, true);
  return rows.find(r => String(r[pkField]) === String(id));
}

// Same as getById, but returns null (not the row) for a soft-deleted
// record. This is the right function for FK RESOLUTION — a formula's
// LOOKUP/dotted-chain, a rollup's join, a module reading "the tenant
// this invoice points at" — anywhere the caller is asking "what does
// this fk resolve TO right now for real work", the answer for a trashed
// parent must be "nothing" (matching getAll/getChildren's default), not
// "here's its old data". Same request-cache reuse as getById itself,
// with a cheap post-lookup check rather than a second index.
function getByIdActive(entityKey, pkField, id) {
  const row = getById(entityKey, pkField, id);
  if (!row || row.__deletedAt) return null;
  return row;
}

function getChildren(entityKey, fkField, value) {
  // Excludes soft-deleted rows by default (same reasoning as getAll) —
  // a rollup summing "every Bill for this Landlord" shouldn't include a
  // soft-deleted Bill, even though nothing points AT that Bill itself
  // (which is what actually makes it eligible for soft-delete in the
  // first place — see findBlockingReferences/deleteSoft below).
  const store = requestCacheStorage.getStore();
  if (store) {
    if (!store.byFk[entityKey]) store.byFk[entityKey] = {};
    if (!store.byFk[entityKey][fkField]) {
      const idx = {};
      const rows = getAll(entityKey);
      rows.forEach(r => {
        const k = String(r[fkField] ?? '');
        if (!idx[k]) idx[k] = [];
        idx[k].push(r);
      });
      store.byFk[entityKey][fkField] = idx;
    }
    return store.byFk[entityKey][fkField][String(value)] || [];
  }
  const rows = getAll(entityKey);
  return rows.filter(r => String(r[fkField]) === String(value));
}

// All the read-then-write functions below intentionally use loadRaw()
// (always a fresh disk read) rather than currentData() (which may return
// a request-scoped snapshot loaded before this request's own async work
// began) for their read step specifically — closing the class of
// last-write-wins race where a route awaits something slow (PDF
// generation, an SMTP send) and then writes using data that's gone
// stale relative to what another request may have committed to disk in
// the meantime. Every one of these functions stays fully synchronous —
// no route/module anywhere needs to change how it calls them — because
// Node's single-threaded event loop already guarantees a synchronous
// read-mutate-write block like this can't be interleaved by another
// request's code; the only actual gap was ever "written using data read
// before an earlier await," never "two writes racing each other."
// save() still refreshes the CURRENT request's own cache afterward (see
// below), so later reads in the same request see this write's result.
function insert(entityKey, record) {
  const data = loadRaw();
  if (!data[entityKey]) data[entityKey] = [];
  data[entityKey].push(record);
  save(data);
  return record;
}

function update(entityKey, pkField, id, updates) {
  const data = loadRaw();
  const rows = data[entityKey] || [];
  const idx = rows.findIndex(r => String(r[pkField]) === String(id));
  if (idx === -1) return null;
  data[entityKey][idx] = { ...rows[idx], ...updates };
  save(data);
  return data[entityKey][idx];
}

// The real, permanent, unrecoverable delete — unchanged from before this
// feature existed. Used directly by CSV-import undo (which has its own,
// separate reasoning for going straight to permanent removal) and by the
// Trash view's "Delete Forever" / scheduled 30-day purge, not by the
// normal record delete route anymore (see softDelete below).
function remove(entityKey, pkField, id) {
  const data = loadRaw();
  const rows = data[entityKey] || [];
  data[entityKey] = rows.filter(r => String(r[pkField]) !== String(id));
  save(data);
}

// Marks a record deleted without actually removing it — recoverable via
// restore() below, until a scheduled purge (30 days) or an explicit
// "Delete Forever" removes it for real. Internal properties only
// (__deletedAt/__deletedBy), never rendered or exported, same shape as
// the import-batch tagging.
function softDelete(entityKey, pkField, id, username) {
  return update(entityKey, pkField, id, { __deletedAt: new Date().toISOString(), __deletedBy: username || 'unknown' });
}

function restore(entityKey, pkField, id) {
  const data = loadRaw();
  const rows = data[entityKey] || [];
  const idx = rows.findIndex(r => String(r[pkField]) === String(id));
  if (idx === -1) return null;
  delete data[entityKey][idx].__deletedAt;
  delete data[entityKey][idx].__deletedBy;
  save(data);
  return data[entityKey][idx];
}

// Migration primitive: strips a named property from every row of a table,
// including soft-deleted ones. Meant for retiring a field cleanly — a
// schema-level deleteField() removes the field's DEFINITION but leaves
// row data untouched, so the actual values linger forever, invisible in
// the UI but re-surfaceable if someone later creates a new field of the
// same name (via Admin or CSV import). One save at the end covers the
// whole table batch, which matters when a migration runs on a table
// with thousands of rows.
function dropFieldFromRows(entityKey, fieldName) {
  const data = loadRaw();
  const rows = data[entityKey] || [];
  let changed = 0;
  rows.forEach(r => {
    if (fieldName in r) { delete r[fieldName]; changed += 1; }
  });
  if (changed > 0) save(data);
  return changed;
}

function getTrash(entityKey) {
  return getAll(entityKey, true).filter(r => r.__deletedAt);
}

// Hard-remove every row matching predicate(row) in ONE write, instead of a
// remove()-per-row loop (which rewrites the whole file each time — a 500-row
// purge = 500 full rewrites). Includes soft-deleted rows, since callers are
// log/telemetry purges where a soft-deleted row is still just a row to drop.
// Returns the number removed.
function removeWhere(entityKey, predicate) {
  const data = loadRaw();
  const rows = data[entityKey] || [];
  const kept = rows.filter(r => !predicate(r));
  const removed = rows.length - kept.length;
  if (removed > 0) { data[entityKey] = kept; save(data); }
  return removed;
}

function nextAutoId(entityKey, pkField) {
  // Deliberately includes soft-deleted rows (includeDeleted=true) — a
  // soft-deleted record's ID is still "taken" as far as avoiding a
  // collision goes, even though it's hidden from normal views.
  const rows = getAll(entityKey, true);
  const max = rows.reduce((m, r) => Math.max(m, Number(r[pkField]) || 0), 0);
  return max + 1;
}

module.exports = { getAll, getById, getByIdActive, getChildren, insert, update, remove, removeWhere, softDelete, restore, dropFieldFromRows, getTrash, nextAutoId, runWithRequestCache, getLookupCache, getTableIndexCache, getComputedMemo };
