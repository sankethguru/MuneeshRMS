// tests/mailer.test.js
// Transport-layer coverage for the email feature (mailer.js), using a
// captured stub transport so nothing opens a socket. Run: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const mailer = require('../mailer.js');

const SETTINGS = { host: 'smtp.example.com', port: 587, fromName: 'Muneesh Legacy', fromAddress: 'billing@example.com', replyTo: 'noreply@example.com' };

// A transport that just records the message it was handed.
function capture() {
  const box = { last: null };
  const transport = { sendMail: async (mail) => { box.last = mail; return { messageId: 'test-id', accepted: mail.to, response: '250 OK' }; } };
  return { transport, box };
}

test('isConfigured requires host + from-address', () => {
  assert.strictEqual(mailer.isConfigured({}), false);
  assert.strictEqual(mailer.isConfigured({ host: 'x' }), false);
  assert.strictEqual(mailer.isConfigured(SETTINGS), true);
});

test('fromHeader formats name + address', () => {
  assert.strictEqual(mailer.fromHeader(SETTINGS), '"Muneesh Legacy" <billing@example.com>');
  assert.strictEqual(mailer.fromHeader({ fromAddress: 'a@b.com' }), 'a@b.com');
});

test('splitAddresses handles commas and semicolons', () => {
  assert.deepStrictEqual(mailer.splitAddresses('a@x.com, b@y.com; c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepStrictEqual(mailer.splitAddresses(''), []);
});

test('sendMail builds the message and passes it to the transport', async () => {
  const { transport, box } = capture();
  const r = await mailer.sendMail(SETTINGS, { to: 'tenant@example.com', cc: 'acct@example.com', subject: 'Invoice INV-001', html: '<p>Hi</p>' }, { transport });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.messageId, 'test-id');
  assert.deepStrictEqual(box.last.to, ['tenant@example.com']);
  assert.deepStrictEqual(box.last.cc, ['acct@example.com']);
  assert.strictEqual(box.last.subject, 'Invoice INV-001');
  assert.strictEqual(box.last.from, '"Muneesh Legacy" <billing@example.com>');
  assert.strictEqual(box.last.replyTo, 'noreply@example.com');
  assert.strictEqual(box.last.html, '<p>Hi</p>');
});

test('sendMail rejects an unconfigured transport', async () => {
  const r = await mailer.sendMail({}, { to: 'a@b.com', subject: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /not configured/i);
});

test('sendMail rejects a missing recipient', async () => {
  const { transport } = capture();
  const r = await mailer.sendMail(SETTINGS, { to: '', subject: 'x' }, { transport });
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /recipient/i);
});

test('sendMail rejects an invalid address', async () => {
  const { transport } = capture();
  const r = await mailer.sendMail(SETTINGS, { to: 'not-an-email', subject: 'x' }, { transport });
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /invalid email/i);
});

test('sendMail surfaces a transport error as { ok:false }', async () => {
  const transport = { sendMail: async () => { throw new Error('connection refused'); } };
  const r = await mailer.sendMail(SETTINGS, { to: 'a@b.com', subject: 'x' }, { transport });
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /connection refused/);
});
