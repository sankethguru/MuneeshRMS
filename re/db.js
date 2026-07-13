// db.js
// Lightweight synchronous JSON-file datastore. No native bindings, so it
// builds cleanly on any Docker base image. Fine for an admin-scale app
// like this (hundreds, not millions, of records).
//
// Request-scoped read cache: the previous implementation read and parsed
// data/db.json fresh for every getAll/getById/getChildren call, which
// meant a single "/bills" render with 100 records and cross-table
// formulas could do thousands of file reads (measured: 2.5s average, 5s
// worst). To fix this without changing storage, callers can start a
// request-scoped cache once per HTTP request via beginRequest()/endRequest()
// and all reads inside that window share a single parse. Writes go
// through immediately and invalidate the cache.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

let requestCache = null;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = require('./seed.js');
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function loadRaw() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function currentData() {
  if (requestCache) return requestCache.data;
  return loadRaw();
}

function beginRequest() {
  requestCache = { data: loadRaw(), byId: {}, byFk: {} };
}

function endRequest() {
  requestCache = null;
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  if (requestCache) {
    requestCache.data = data;
    requestCache.byId = {};
    requestCache.byFk = {};
  }
}

function getAll(entityKey) {
  return currentData()[entityKey] || [];
}

function getById(entityKey, pkField, id) {
  if (requestCache) {
    const key = `${pkField}|${id}`;
    if (!requestCache.byId[entityKey]) {
      requestCache.byId[entityKey] = {};
      const rows = getAll(entityKey);
      rows.forEach(r => { requestCache.byId[entityKey][`${pkField}|${r[pkField]}`] = r; });
    }
    return requestCache.byId[entityKey][key];
  }
  const rows = getAll(entityKey);
  return rows.find(r => String(r[pkField]) === String(id));
}

function getChildren(entityKey, fkField, value) {
  if (requestCache) {
    if (!requestCache.byFk[entityKey]) requestCache.byFk[entityKey] = {};
    if (!requestCache.byFk[entityKey][fkField]) {
      const idx = {};
      const rows = getAll(entityKey);
      rows.forEach(r => {
        const k = String(r[fkField] ?? '');
        if (!idx[k]) idx[k] = [];
        idx[k].push(r);
      });
      requestCache.byFk[entityKey][fkField] = idx;
    }
    return requestCache.byFk[entityKey][fkField][String(value)] || [];
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

module.exports = { getAll, getById, getChildren, insert, update, remove, nextAutoId, beginRequest, endRequest };
