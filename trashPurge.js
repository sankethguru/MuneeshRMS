// trashPurge.js
// Automatically, permanently removes soft-deleted records once they've
// been in the Trash for 30 days — same "check hourly, act only if
// actually due" pattern already established by scheduledBackup.js.

const fs = require('fs');
const path = require('path');
const schemaLib = require('./schema');
const db = require('./db');

const KEEP_DAYS = 30;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');

function purgeOldTrash() {
  try {
    const schema = schemaLib.load();
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    Object.keys(schema.entities).forEach(entityKey => {
      const entity = schema.entities[entityKey];
      db.getTrash(entityKey).forEach(r => {
        const deletedAtMs = new Date(r.__deletedAt).getTime();
        if (isNaN(deletedAtMs) || deletedAtMs >= cutoff) return;
        db.remove(entityKey, entity.pk, r[entity.pk]);
        entity.fields.filter(f => f.type === 'image').forEach(f => {
          if (r[f.name]) {
            const p = path.join(UPLOADS_DIR, entityKey, f.name, r[f.name]);
            if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) { /* best-effort */ }
          }
        });
      });
    });
  } catch (e) {
    console.error('Trash purge failed:', e.message);
  }
}

function start() {
  purgeOldTrash();
  setInterval(purgeOldTrash, CHECK_INTERVAL_MS);
}

module.exports = { start, purgeOldTrash };
