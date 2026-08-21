// mailer.js
//
// The email transport — the counterpart to telegram.js. All outbound mail
// (both the per-record email templates and the email notification channel)
// funnels through sendMail() here. SMTP only for now (nodemailer); the shape
// is deliberately provider-agnostic so an API provider could slot in later.
//
// Config split, on purpose:
//   - Non-secret settings (host, port, secure, from name/address, reply-to)
//     live in schema.emailSettings, like every other setting.
//   - The SMTP password is a credential, so it lives in secrets.js (env var
//     or the backup-excluded secrets file), never in the schema/backups.
//
// Testability: sendMail accepts deps.transport, so tests (and a dry-run)
// can inject nodemailer's jsonTransport or a stub and assert on the built
// message without ever opening a socket.

const nodemailer = require('nodemailer');
const secrets = require('./secrets');

// Is there enough configured to attempt a send? (host + from-address are the
// irreducible minimum; auth is optional for an open relay / localhost.)
function isConfigured(settings) {
  const s = settings || {};
  return !!(String(s.host || '').trim() && String(s.fromAddress || '').trim());
}

// Build a nodemailer transport from settings + the stored password. Exposed
// so the same construction is used everywhere and can be swapped in tests.
function buildTransport(settings, deps) {
  if (deps && deps.transport) return deps.transport;
  const s = settings || {};
  const port = Number(s.port) || 587;
  const opts = {
    host: String(s.host || '').trim(),
    port,
    // `secure` true => implicit TLS (465); false => STARTTLS upgrade on 587/25.
    secure: s.secure === true || s.secure === 'true' || port === 465,
  };
  const user = String(s.username || '').trim();
  const pass = (deps && deps.password !== undefined) ? deps.password : secrets.getSmtpPassword();
  if (user || pass) opts.auth = { user, pass };
  return nodemailer.createTransport(opts);
}

function fromHeader(settings) {
  const s = settings || {};
  const addr = String(s.fromAddress || '').trim();
  const name = String(s.fromName || '').trim();
  return name ? `"${name.replace(/"/g, '')}" <${addr}>` : addr;
}

// Split a recipient string ("a@x.com, b@y.com") into a clean array.
function splitAddresses(v) {
  return String(v || '')
    .split(/[,;]+/)
    .map(a => a.trim())
    .filter(Boolean);
}

// Minimal sanity check — not full RFC validation, just enough to catch the
// obvious "that isn't an address" before we hand it to the transport.
function looksLikeEmail(a) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(a || '').trim());
}

// Send one message. `message` = { to, cc, bcc, subject, html, text }.
// Returns { ok: true, messageId, accepted } or { ok: false, error }.
async function sendMail(settings, message, deps) {
  if (!isConfigured(settings)) {
    return { ok: false, error: new Error('Email is not configured (set SMTP host and from-address in Admin \u2192 Email Settings).') };
  }
  const to = splitAddresses(message.to);
  if (to.length === 0) return { ok: false, error: new Error('No recipient address.') };
  const bad = [...to, ...splitAddresses(message.cc), ...splitAddresses(message.bcc)].filter(a => !looksLikeEmail(a));
  if (bad.length) return { ok: false, error: new Error(`Invalid email address: ${bad.join(', ')}`) };

  const mail = {
    from: fromHeader(settings),
    to,
    subject: String(message.subject || ''),
  };
  const cc = splitAddresses(message.cc); if (cc.length) mail.cc = cc;
  const bcc = splitAddresses(message.bcc); if (bcc.length) mail.bcc = bcc;
  if (String(settings.replyTo || '').trim()) mail.replyTo = String(settings.replyTo).trim();
  if (message.html) mail.html = message.html;
  if (message.text) mail.text = message.text;
  // If only HTML was given, nodemailer will still send; a text alternative
  // improves deliverability but we don't fabricate one here.

  try {
    const transport = buildTransport(settings, deps);
    const info = await transport.sendMail(mail);
    return { ok: true, messageId: info.messageId, accepted: info.accepted, response: info.response, envelope: info.envelope };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// A fixed "does this actually work" probe for the settings page.
async function sendTest(settings, to, deps) {
  return sendMail(settings, {
    to,
    subject: 'Muneesh Legacy \u2014 test email',
    text: 'This is a test email from Muneesh Legacy. If you received it, your SMTP settings are working.',
    html: '<p>This is a test email from <strong>Muneesh Legacy</strong>. If you received it, your SMTP settings are working.</p>',
  }, deps);
}

module.exports = { isConfigured, buildTransport, fromHeader, splitAddresses, looksLikeEmail, sendMail, sendTest };
