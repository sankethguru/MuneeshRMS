// tests/email-maintenance.test.js
// v3.10.1 fixes: db.removeWhere (single-write bulk delete), email_log
// retention purge, and the duplicate-send guard. Run: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../db.js');
const email = require('../email.js');
const schemaLib = require('../schema.js');

test('db.removeWhere deletes matching rows in one pass and returns the count', () => {
  db.runWithRequestCache(() => {
    const T = '__test_rmw';
    db.removeWhere(T, () => true); // start clean
    for (let i = 0; i < 5; i++) db.insert(T, { id: i, old: i < 3 });
    const removed = db.removeWhere(T, r => r.old === true);
    assert.strictEqual(removed, 3);
    assert.strictEqual(db.getAll(T).length, 2);
    assert.strictEqual(db.removeWhere(T, r => r.old === true), 0); // nothing left to match
    db.removeWhere(T, () => true); // cleanup
  });
});

test('email.purgeOldLogs drops rows older than retention, keeps recent ones', () => {
  db.runWithRequestCache(() => {
    email.ensureEmailTables();
    const schema = schemaLib.load(); // fresh load, so schema.entities.email_log is present
    db.insert('email_log', { EM_RowID: 990001, EM_SentAt: '2000-01-01T00:00:00.000Z', EM_Status: 'sent' });
    db.insert('email_log', { EM_RowID: 990002, EM_SentAt: new Date().toISOString(), EM_Status: 'sent' });
    schema.emailSettings = schema.emailSettings || {};
    schema.emailSettings.logRetentionDays = 90;
    const purged = email.purgeOldLogs(schema);
    assert.ok(purged >= 1, 'should purge the year-2000 row');
    const rows = db.getAll('email_log');
    assert.ok(!rows.some(r => r.EM_RowID === 990001), 'old row gone');
    assert.ok(rows.some(r => r.EM_RowID === 990002), 'recent row kept');
    db.removeWhere('email_log', r => r.EM_RowID === 990002); // cleanup
  });
});

test('email.purgeOldLogs is a no-op when the table is absent', () => {
  assert.strictEqual(email.purgeOldLogs({ entities: {}, emailSettings: {} }), 0);
});

test('email.send rejects an immediate duplicate (same recipient/subject/source)', async () => {
  const schema = { entities: {}, emailSettings: { host: 'smtp.x', fromAddress: 'a@b.com' } };
  const stub = { sendMail: async () => ({ messageId: '1', accepted: ['t@x.com'], response: '250 OK' }) };
  const msg = { to: 't@x.com', subject: 'Dup guard ' + Date.now(), html: '<p>x</p>' };
  const meta = { kind: 'test', sourceEntity: 's', sourceId: '1', templateKey: 'k' };
  const r1 = await email.send(schema, msg, meta, { transport: stub });
  const r2 = await email.send(schema, msg, meta, { transport: stub });
  assert.strictEqual(r1.ok, true, 'first send goes through');
  assert.strictEqual(r2.ok, false, 'immediate identical resend blocked');
  assert.match(r2.error.message, /duplicate/i);
  // A different recipient is NOT a duplicate.
  const r3 = await email.send(schema, { ...msg, to: 'other@x.com' }, meta, { transport: stub });
  assert.strictEqual(r3.ok, true);
});
