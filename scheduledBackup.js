// scheduledBackup.js
// Nightly automatic backup — no manual action needed, so a fat-fingered
// delete or bad restore is never more than a day of loss. Runs inside
// the same long-running Node process (an hourly setInterval check for
// "has today's backup already been taken") rather than a separate
// OS-level cron daemon inside the container — simpler, no new package
// or Dockerfile complexity, and works identically whether deployed via
// Docker or run as bare Node. Reuses the exact same zip-building shape
// as the existing manual "Download Backup" button.

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const schemaLib = require('./schema');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const SCHEMA_FILE = path.join(DATA_DIR, 'schema.json');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUPS_DIR = path.join(DATA_DIR, 'scheduled-backups');

const KEEP_DAYS = 7;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — cheap to check, only actually backs up once/day

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { filename: f, mtime: stat.mtimeMs, sizeBytes: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

function hasTodaysBackup() {
  return listBackups().some(b => b.filename.includes(todayStamp()));
}

function takeBackup() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const filename = `auto-backup-${todayStamp()}.zip`;
    const filepath = path.join(BACKUPS_DIR, filename);
    const output = fs.createWriteStream(filepath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(filename));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    // NOTE: this is an explicit ALLOWLIST of files, and that is
    // load-bearing for security — data/secrets.json (the Telegram bot
    // token) lives in this same directory and must never enter a backup
    // archive, since backups get downloaded, emailed and restored on
    // other machines. If this is ever changed to archive the data
    // directory wholesale, secrets.json must be explicitly excluded.
    // See secrets.js for the full rationale.
    if (fs.existsSync(SCHEMA_FILE)) archive.file(SCHEMA_FILE, { name: 'schema.json' });
    if (fs.existsSync(DB_FILE)) archive.file(DB_FILE, { name: 'db.json' });
    if (fs.existsSync(USERS_FILE)) archive.file(USERS_FILE, { name: 'users.json' });
    if (fs.existsSync(UPLOADS_DIR)) archive.directory(UPLOADS_DIR, 'uploads');
    archive.finalize();
  });
}

function pruneOldBackups() {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  listBackups().forEach(b => {
    if (b.mtime < cutoff) {
      try { fs.unlinkSync(path.join(BACKUPS_DIR, b.filename)); } catch (e) { /* best-effort */ }
    }
  });
}

async function checkAndRun() {
  try {
    // schema.json/db.json/users.json are all created lazily, the first
    // time something actually requests them (typically the first real
    // HTTP request) — not automatically on server startup. Since this
    // runs immediately at startup, before any request may have happened
    // yet, force that seed-creation to happen here first — otherwise the
    // very first scheduled backup could genuinely be an empty zip
    // (confirmed: this actually happened during testing, not a
    // theoretical risk).
    schemaLib.load();
    db.getAll('__nonexistent__'); // any call triggers db.js's own ensureStore()
    if (!hasTodaysBackup()) {
      await takeBackup();
    }
    // Pruning runs every check, not only right after taking a new
    // backup — otherwise, once today's backup already exists (e.g. the
    // app restarts more than once in a day), pruning would never run
    // again until the NEXT day's backup happens, letting old backups
    // linger well past the intended 7-day retention (confirmed: this
    // actually happened during testing when pruning was nested inside
    // the "no backup yet today" branch instead of running unconditionally).
    pruneOldBackups();
  } catch (e) {
    console.error('Scheduled backup failed:', e.message);
  }
}

function start() {
  checkAndRun(); // check once immediately on startup — don't make the very first backup wait a full hour
  setInterval(checkAndRun, CHECK_INTERVAL_MS);
}

module.exports = { start, listBackups, BACKUPS_DIR };
