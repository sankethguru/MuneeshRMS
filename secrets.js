// secrets.js
//
// Storage for credentials that must NEVER travel in a backup archive.
//
// This exists because of a specific, verified hazard: scheduledBackup.js
// and the manual "Download Backup" button both bundle data/schema.json
// into the zip. Any credential put in the schema — the natural place,
// since that's where every other setting lives — would therefore be
// copied into every backup the family downloads, emails to an auditor,
// or restores on another machine. A Telegram bot token is enough to
// impersonate the bot and message every chat it belongs to, so it gets
// its own file that the backup builders explicitly skip.
//
// Resolution order, highest priority first:
//   1. Environment variable  — the right answer for Docker/production.
//      Nothing is written to disk at all, so there's nothing to leak.
//   2. data/secrets.json     — the fallback for someone running bare
//      Node who'd rather paste a token into the Admin UI than edit a
//      compose file. Written 0600 and excluded from backups.
//
// The UI never renders a stored token back to the browser; it only ever
// asks hasToken()/maskedToken(). That way a shoulder-surfer or a stray
// screenshot of the settings page can't capture it either.

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./fsutil');

const DATA_DIR = path.join(__dirname, 'data');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

// Exported so the two backup builders can skip it by name rather than
// hardcoding the string in three places and drifting apart later.
const SECRETS_FILENAME = 'secrets.json';

function load() {
  try {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch (e) {
    // A corrupt secrets file must not take the whole app down at boot —
    // notifications simply stay unconfigured until it's fixed.
    return {};
  }
}

function persist(obj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteFileSync(SECRETS_FILE, JSON.stringify(obj, null, 2));
  // Best-effort tighten: on a shared host the file should not be world
  // readable. Wrapped because some filesystems (notably a Windows bind
  // mount into Docker) reject chmod, and that's not worth failing over.
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch (e) { /* non-fatal */ }
}

function getTelegramToken() {
  const fromEnv = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const v = load().telegramBotToken;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

// Where the active token came from, for the Admin UI to explain itself.
// An env-var token deliberately cannot be edited or cleared from the
// browser: the process owner set it, and silently shadowing it with a
// file value would make the UI lie about what's actually in use.
function telegramTokenSource() {
  if ((process.env.TELEGRAM_BOT_TOKEN || '').trim()) return 'env';
  if (load().telegramBotToken) return 'file';
  return 'none';
}

function setTelegramToken(token) {
  const obj = load();
  const clean = String(token || '').trim();
  if (clean) obj.telegramBotToken = clean;
  else delete obj.telegramBotToken;
  persist(obj);
}

function hasTelegramToken() {
  return !!getTelegramToken();
}

// ---- SMTP password (same never-in-a-backup treatment as the bot token) ----
// The rest of the email config (host, port, from-address, …) is ordinary
// non-secret settings and lives in schema.emailSettings; only the password
// is a credential, so it gets the secrets-file / env-var treatment here.
function getSmtpPassword() {
  const fromEnv = (process.env.SMTP_PASSWORD || '').trim();
  if (fromEnv) return fromEnv;
  const v = load().smtpPassword;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}
function smtpPasswordSource() {
  if ((process.env.SMTP_PASSWORD || '').trim()) return 'env';
  if (load().smtpPassword) return 'file';
  return 'none';
}
function setSmtpPassword(pw) {
  const obj = load();
  const clean = String(pw || '');
  if (clean) obj.smtpPassword = clean;
  else delete obj.smtpPassword;
  persist(obj);
}
function hasSmtpPassword() {
  return !!getSmtpPassword();
}

// Telegram tokens look like "<botId>:<35-char secret>". Showing the bot
// id plus a tail is enough for a human to confirm WHICH bot is wired up
// without exposing anything usable.
function maskedTelegramToken() {
  const t = getTelegramToken();
  if (!t) return '';
  const colon = t.indexOf(':');
  if (colon === -1) return t.slice(0, 2) + '\u2026' + t.slice(-2);
  return `${t.slice(0, colon)}:\u2026${t.slice(-4)}`;
}

module.exports = {
  SECRETS_FILE, SECRETS_FILENAME,
  getTelegramToken, setTelegramToken, hasTelegramToken, maskedTelegramToken, telegramTokenSource,
  getSmtpPassword, setSmtpPassword, hasSmtpPassword, smtpPasswordSource,
};
