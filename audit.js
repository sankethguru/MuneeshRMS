// audit.js
// Append-only audit log, stored as JSONL (one JSON object per line) with
// size-based rotation — same pattern errorlog.js already uses. Only
// written to for tables with auditEnabled set in the schema.
//
// Previously stored as a single audit.json — fully parsed and rewritten
// on every single logged change, and getRecent() loaded the entire file
// into memory. Fine at small scale, but would get slow over years of
// real use. JSONL fixes both: logging a new entry is a pure append (no
// read-modify-write of the whole file), and rotation keeps the file from
// growing unbounded, at the cost of only keeping recent history rather
// than every entry ever logged (same tradeoff errorlog.js already makes).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'audit.jsonl');
const LOG_BACKUP = path.join(DATA_DIR, 'audit.jsonl.1');
const OLD_JSON_FILE = path.join(DATA_DIR, 'audit.json'); // pre-JSONL format, migrated once if found
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file, ~10 MB total on disk

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// One-time migration: if an old-format audit.json exists (from before
// this rewrite) and the new JSONL file doesn't exist yet, convert its
// entries into JSONL rather than silently discarding real audit history.
function migrateOldFormatIfNeeded() {
  ensureDir();
  if (fs.existsSync(LOG_FILE) || !fs.existsSync(OLD_JSON_FILE)) return;
  try {
    const old = JSON.parse(fs.readFileSync(OLD_JSON_FILE, 'utf8'));
    const lines = (old.entries || []).map(e => JSON.stringify(e)).join('\n');
    if (lines) fs.writeFileSync(LOG_FILE, lines + '\n');
    fs.renameSync(OLD_JSON_FILE, OLD_JSON_FILE + '.migrated');
  } catch (e) {
    // If the old file is somehow unreadable, don't block startup over it —
    // just leave it in place, unmigrated, rather than crash.
  }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size >= MAX_BYTES) {
      if (fs.existsSync(LOG_BACKUP)) fs.unlinkSync(LOG_BACKUP);
      fs.renameSync(LOG_FILE, LOG_BACKUP);
    }
  } catch (e) {
    // ENOENT is fine — nothing to rotate yet.
  }
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
  migrateOldFormatIfNeeded();
  ensureDir();
  rotateIfNeeded();
  const entry = {
    ts: new Date().toISOString(),
    entity: entityKey,
    recordId: String(recordId),
    action, // 'create' | 'update' | 'delete'
    user: username || 'unknown',
    // Record changes only diff on 'update' — showing every field as a
    // "change" on create/delete would be noisy when the whole record is
    // new or gone anyway. Schema changes (entityKey prefixed "schema:")
    // are different: a field has few, meaningful properties, and knowing
    // exactly what a deleted/newly-created field looked like (its type,
    // formula, etc.) is exactly the detail that makes "why did this
    // report just break" debuggable — so those always get a full diff,
    // regardless of action.
    changes: (action === 'update' || String(entityKey).startsWith('schema:')) ? diffRecords(before, after) : [],
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

// Reads a single file backward in fixed-size chunks, yielding each
// complete line newest-first (the file's last line first), without ever
// holding the whole file in memory at once — the actual fix for
// readAllEntries()'s previous "read + JSON.parse everything, every call,
// even when the caller only wants a few recent/matching entries" cost.
// Safe to rely on line-per-entry here specifically because every entry
// is written via JSON.stringify (log(), below), which never itself
// emits a literal newline byte inside a value — a JSONL line and a
// audit entry are always exactly the same thing, no multi-line-field
// edge case to worry about the way a general text/CSV reader would.
// A line spanning a chunk boundary is correctly reassembled via a
// carry-over fragment; chunk size (64KB) is generous relative to a
// single audit line's real size (well under 1KB typically).
function* reverseLines(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    return; // file doesn't exist — nothing to yield, not an error
  }
  try {
    const stat = fs.fstatSync(fd);
    let position = stat.size;
    const CHUNK_SIZE = 65536;
    let carry = ''; // an incomplete line fragment, its true start further back in the file
    while (position > 0) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, position);
      const lines = (buffer.toString('utf8') + carry).split('\n');
      // lines[0] may be an incomplete fragment (its real start is in an
      // earlier, not-yet-read chunk) — unless this chunk reaches all
      // the way back to byte 0 of the file, in which case it's genuinely
      // the file's first complete line.
      carry = position > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i] !== '') yield lines[i];
      }
    }
    if (carry !== '') yield carry;
  } finally {
    fs.closeSync(fd);
  }
}

// Yields parsed audit entries newest-first across both log files (the
// current file first — it holds the newest entries — then the backup),
// stopping as soon as the caller's onEntry callback returns false. This
// is what makes getForRecord()/getRecent() cheap even against a near-
// full-size (~10MB combined) audit log: both usually only need a
// handful of matching/recent entries, so most calls now touch only the
// first chunk or two of the current file, not the whole thing. A line
// that fails to parse (e.g. a mid-write truncation from a crash) is
// skipped rather than aborting the whole read, same as before.
function forEachEntryReverse(onEntry) {
  migrateOldFormatIfNeeded();
  ensureDir();
  for (const filePath of [LOG_FILE, LOG_BACKUP]) {
    for (const line of reverseLines(filePath)) {
      let entry;
      try { entry = JSON.parse(line); } catch (e) { continue; }
      if (onEntry(entry) === false) return;
    }
  }
}

// Reads and parses every entry from the backup + current JSONL files, in
// file (chronological) order. A line that fails to parse (e.g. a
// mid-write truncation from a crash) is skipped rather than aborting the
// whole read — one bad line shouldn't hide all the good ones. Kept for
// anyone who genuinely wants the complete list — getForRecord/getRecent
// below no longer use this, since both only need a bounded subset and
// now stream via forEachEntryReverse instead.
function readAllEntries() {
  migrateOldFormatIfNeeded();
  ensureDir();
  let text = '';
  if (fs.existsSync(LOG_BACKUP)) text += fs.readFileSync(LOG_BACKUP, 'utf8');
  if (fs.existsSync(LOG_FILE)) text += fs.readFileSync(LOG_FILE, 'utf8');
  return text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(Boolean);
}

function getForRecord(entityKey, recordId) {
  const matches = [];
  forEachEntryReverse((e) => {
    if (e.entity === entityKey && e.recordId === String(recordId)) matches.push(e);
  });
  return matches; // already newest-first, since forEachEntryReverse walks backward
}

function getRecent(limit) {
  const entries = [];
  forEachEntryReverse((e) => {
    entries.push(e);
    if (limit && entries.length >= limit) return false; // stop early — no need to read further back
  });
  return entries;
}

module.exports = { log, getForRecord, getRecent };
