// errorlog.js
// Writes server-side crashes (exception → 500 response) to a rolling file
// at data/logs/error.log. Rotates automatically when the file exceeds the
// size cap, keeping one backup (error.log.1) — enough to see the last few
// hundred KB of failures without letting disk usage grow unbounded. All
// I/O is synchronous — this only fires on the exception path, so any
// speed cost is irrelevant next to the fact that the request already
// failed.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'error.log');
const LOG_BACKUP = path.join(LOG_DIR, 'error.log.1');
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB per file, so ~4 MB total on disk

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
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

function record({ method, url, user, err }) {
  try {
    ensureDir();
    rotateIfNeeded();
    const entry = [
      '=== ' + new Date().toISOString() + ' ===',
      `${method || '?'} ${url || '?'}`,
      `user: ${user || '(anonymous)'}`,
      `error: ${err && err.message ? err.message : String(err)}`,
      err && err.stack ? err.stack : '(no stack)',
      '',
    ].join('\n');
    fs.appendFileSync(LOG_FILE, entry + '\n');
  } catch (e) {
    // If logging itself fails, don't crash the crash handler.
    // eslint-disable-next-line no-console
    console.error('errorlog: failed to record:', e && e.message);
  }
}

// Reads the tail of the log for the admin viewer — newest first.
// Combines rotated backup + current file, splits on the "=== " header
// marker, and returns up to `limit` most-recent parsed entries.
function recent(limit) {
  limit = Number(limit) || 100;
  ensureDir();
  let text = '';
  try {
    if (fs.existsSync(LOG_BACKUP)) text += fs.readFileSync(LOG_BACKUP, 'utf8');
    if (fs.existsSync(LOG_FILE)) text += fs.readFileSync(LOG_FILE, 'utf8');
  } catch (e) {
    return [];
  }
  const chunks = text.split(/^=== /m).map(s => s.trim()).filter(Boolean);
  const entries = chunks.map(chunk => {
    const lines = chunk.split('\n');
    const tsMatch = lines[0].match(/^([\d\-T:.Z]+) ===/);
    const ts = tsMatch ? tsMatch[1] : lines[0];
    const rest = lines.slice(1);
    const route = rest[0] || '';
    const user = (rest[1] || '').replace(/^user:\s*/, '');
    const message = (rest[2] || '').replace(/^error:\s*/, '');
    const stack = rest.slice(3).join('\n').trim();
    return { ts, route, user, message, stack };
  });
  entries.reverse();
  return entries.slice(0, limit);
}

function clearAll() {
  try {
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    if (fs.existsSync(LOG_BACKUP)) fs.unlinkSync(LOG_BACKUP);
  } catch (e) { /* best effort */ }
}

module.exports = { record, recent, clearAll };
