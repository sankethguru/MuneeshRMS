// audit.js
// Append-only audit log. Only written to for tables with auditEnabled set
// in the schema. Stored as data/audit.json.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, JSON.stringify({ nextId: 1, entries: [] }, null, 2));
}

function load() {
  ensure();
  return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
}

function persist(data) {
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(data, null, 2));
}

// Compute a compact list of {field, before, after} for changed keys only.
function diffRecords(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.forEach(k => {
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    if (String(b ?? '') !== String(a ?? '')) changes.push({ field: k, before: b ?? '', after: a ?? '' });
  });
  return changes;
}

function log({ entityKey, recordId, action, username, before, after }) {
  const data = load();
  data.entries.push({
    id: data.nextId++,
    ts: new Date().toISOString(),
    entity: entityKey,
    recordId: String(recordId),
    action, // 'create' | 'update' | 'delete'
    user: username || 'unknown',
    changes: action === 'update' ? diffRecords(before, after) : [],
  });
  persist(data);
}

function getForRecord(entityKey, recordId) {
  return load().entries
    .filter(e => e.entity === entityKey && e.recordId === String(recordId))
    .sort((a, b) => b.id - a.id);
}

function getRecent(limit) {
  const entries = load().entries.slice().sort((a, b) => b.id - a.id);
  return limit ? entries.slice(0, limit) : entries;
}

module.exports = { log, getForRecord, getRecent };
