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
  return requestCacheStorage.run({ data: loadRaw(), byId: {}, byFk: {} }, fn);
}

function save(data) {
  atomicWriteFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  const store = requestCacheStorage.getStore();
  if (store) {
    store.data = data;
    store.byId = {};
    store.byFk = {};
  }
}

function getAll(entityKey) {
  return currentData()[entityKey] || [];
}

function getById(entityKey, pkField, id) {
  const store = requestCacheStorage.getStore();
  if (store) {
    const key = `${pkField}|${id}`;
    if (!store.byId[entityKey]) {
      store.byId[entityKey] = {};
      const rows = getAll(entityKey);
      rows.forEach(r => { store.byId[entityKey][`${pkField}|${r[pkField]}`] = r; });
    }
    return store.byId[entityKey][key];
  }
  const rows = getAll(entityKey);
  return rows.find(r => String(r[pkField]) === String(id));
}

function getChildren(entityKey, fkField, value) {
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

function insert(entityKey, record) {
  const data = currentData();
  if (!data[entityKey]) data[entityKey] = [];
  data[entityKey].push(record);
  save(data);
  return record;
}

function update(entityKey, pkField, id, updates) {
  const data = currentData();
  const rows = data[entityKey] || [];
  const idx = rows.findIndex(r => String(r[pkField]) === String(id));
  if (idx === -1) return null;
  data[entityKey][idx] = { ...rows[idx], ...updates };
  save(data);
  return data[entityKey][idx];
}

function remove(entityKey, pkField, id) {
  const data = currentData();
  const rows = data[entityKey] || [];
  data[entityKey] = rows.filter(r => String(r[pkField]) !== String(id));
  save(data);
}

function nextAutoId(entityKey, pkField) {
  const rows = getAll(entityKey);
  const max = rows.reduce((m, r) => Math.max(m, Number(r[pkField]) || 0), 0);
  return max + 1;
}

module.exports = { getAll, getById, getChildren, insert, update, remove, nextAutoId, runWithRequestCache };
