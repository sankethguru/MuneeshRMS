// tests/email-permission.test.js
// v3.11.0: sending email from a record requires an explicit per-entity
// 'email' permission — Read no longer implies it. Run: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const users = require('../users.js');

test('can(email) is false for a user with only read, true when granted', () => {
  const reader = { isAdmin: false, permissions: { invoices: { read: true, create: false } } };
  assert.strictEqual(users.can(reader, 'invoices', 'read'), true);
  assert.strictEqual(users.can(reader, 'invoices', 'email'), false); // read no longer implies email

  const emailer = { isAdmin: false, permissions: { invoices: { read: true, email: true } } };
  assert.strictEqual(users.can(emailer, 'invoices', 'email'), true);
});

test('admins can always email; email is per-entity', () => {
  const admin = { isAdmin: true, permissions: {} };
  assert.strictEqual(users.can(admin, 'invoices', 'email'), true);

  const scoped = { isAdmin: false, permissions: { invoices: { email: true }, tenants: { read: true } } };
  assert.strictEqual(users.can(scoped, 'invoices', 'email'), true);
  assert.strictEqual(users.can(scoped, 'tenants', 'email'), false); // granted on invoices only
});

test('an absent permission entry means no email (tightened default)', () => {
  const legacy = { isAdmin: false, permissions: { invoices: { read: true, create: true, update: true, delete: true } } };
  // Pre-v3.11.0 stored permissions have no 'email' key at all -> false.
  assert.strictEqual(users.can(legacy, 'invoices', 'email'), false);
});
