const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const schemaLib = require('./schema');
const db = require('./db');
const usersLib = require('./users');
const audit = require('./audit');
const auth = require('./auth');
const errorlog = require('./errorlog');
const payqr = require('./payqr');
const reports = require('./reports');
const scheduledBackup = require('./scheduledBackup');
const bills = require('./bills');
const notify = require('./notify');
const emailMod = require('./email');
const remindersMod = require('./reminders');
const icons = require('./icons');
const homeMod = require('./home');
const tax = require('./tax');
const gsttds = require('./gsttds');
const trashPurge = require('./trashPurge');
const billPdf = require('./billPdf');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 2299;

// Version shown in the UI footer, read from package.json's own version
// field rather than hardcoded separately here — one number to bump per
// release (npm version, or a direct edit), not two places to keep in
// sync manually. Exposed via app.locals so every EJS view has it
// automatically, without threading it through every single res.render()
// call across the whole app.
app.locals.appVersion = require('./package.json').version;

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // A real deployment must never run on the known, source-visible
    // fallback secret below — anyone who's seen this codebase knows the
    // exact string, so session cookies signed with it can be forged,
    // a full authentication bypass. Local/dev use (NODE_ENV unset)
    // still gets the warn-and-continue behavior below, so a first-time
    // `docker-compose up` without a .env file yet still boots far
    // enough to show the fix, rather than failing with no login page
    // at all — the packaged Dockerfile sets NODE_ENV=production so the
    // real shipped deployment target gets the strict check.
    console.error('\n' + '!'.repeat(70));
    console.error('! FATAL: SESSION_SECRET is not set and NODE_ENV=production.');
    console.error('! Refusing to boot on a known, hardcoded fallback secret in a real');
    console.error('! deployment — session cookies signed with it can be forged by');
    console.error('! anyone who has seen this codebase. Set SESSION_SECRET in your');
    console.error('! environment (see docker-compose.yml) and restart.');
    console.error('!'.repeat(70) + '\n');
    process.exit(1);
  }
  console.warn('\n' + '!'.repeat(70));
  console.warn('! WARNING: SESSION_SECRET is not set — falling back to a hardcoded');
  console.warn('! development secret. Session cookies signed with this are NOT');
  console.warn('! secure for real use. Set SESSION_SECRET in your environment (see');
  console.warn('! docker-compose.yml) before relying on this deployment for anything.');
  console.warn('!'.repeat(70) + '\n');
}

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// SVG deliberately excluded: an SVG can embed <script>, and there's no
// cheap way to sanitize that server-side without a dedicated library —
// removing it entirely is the safe fix, not trying to half-sanitize it.
// The remaining types are verified for real below (magic bytes checked
// against the actual uploaded buffer), not just trusted from the
// client-supplied mimetype, which is why fileFilter here is only a cheap
// first-pass rejection, not the real security boundary.
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB — signatures/logos, not photo albums
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported image type: ${file.mimetype}. Accepted: JPG, PNG, GIF, WEBP.`));
  },
});

// Verifies a file's REAL type by checking its actual leading bytes
// against known signatures, rather than trusting the client-supplied
// mimetype or filename extension (both are attacker-controlled — this
// is the fix for the stored-XSS risk where a file claiming image/png
// but actually containing HTML/script, named with a misleading
// extension, would otherwise be stored and later served with a
// Content-Type derived from that same untrusted extension). Returns the
// safe extension to save under if the buffer genuinely matches one of
// the allowed types, or null if it doesn't match anything we accept.
function detectRealImageExtension(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const bytes = buffer;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return '.jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return '.png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return '.gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return '.webp';
  return null;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(morgan('dev'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  // Deliberately still MemoryStore, not a persistent store — attempted
  // session-file-store here, but it has no retry/locking mechanism at
  // all, and with rolling:true re-writing the session file on every
  // request, concurrent requests for the same session raced on that
  // write and randomly appeared logged-out (confirmed: 5 sequential
  // requests all succeeded, 5 concurrent ones all failed). That's a
  // worse, active bug traded for a lower-impact, longer-term concern
  // (memory growth over time, sessions lost on restart) — not a good
  // trade at this app's actual scale (a handful of concurrent users at
  // most). Left as MemoryStore; a properly concurrency-safe persistent
  // store (e.g. SQLite-backed with real locking) would be the right fix
  // if this ever needs revisiting, not another plain-file store.
  secret: process.env.SESSION_SECRET || 'muneesh-legacy-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true, // reset expiry on every request — see the dynamic maxAge middleware below for the "N minutes of inactivity" behavior
  cookie: {
    maxAge: 1000 * 60 * 30, // fallback default; overridden per-request once the schema (and its admin-configured timeout) is loaded
    sameSite: 'lax', // explicit, not relying on the browser default — blocks the cookie being sent on a cross-site POST, the actual mechanism that makes most CSRF attempts fail here today. Not a full CSRF-token system (every state-changing form would need one) — that's a larger, separate undertaking; this is the cheap, high-value floor.
    httpOnly: true, // explicit, though this was already the express-session default — stops the cookie being readable from client-side JS (e.g. via an XSS payload that got past the upload/rendering safeguards elsewhere)
  },
}));

app.use(auth.loadCurrentUser);

// ---- login / logout (no login required) -----------------------------------

// Simple in-memory login rate limiter — no new dependency, deliberately
// basic rather than a full sliding-window/IP-based system. Tracks failed
// attempts per username (lowercased); after LOGIN_MAX_ATTEMPTS within
// LOGIN_WINDOW_MS, further attempts for that username are refused for
// LOGIN_LOCKOUT_MS regardless of whether the password given is actually
// correct, closing the brute-force gap a 4-character (now 8-character)
// minimum alone doesn't. Resets on any successful login. Being in-memory,
// this resets on process restart — acceptable for this app's scale, but
// worth knowing if that matters later.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // username -> { count, firstAttemptAt, lockedUntil }

function checkLoginRateLimit(username) {
  const key = String(username || '').toLowerCase();
  const entry = loginAttempts.get(key);
  if (!entry) return { blocked: false };
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const minutesLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return { blocked: true, minutesLeft };
  }
  return { blocked: false };
}

function recordFailedLogin(username) {
  const key = String(username || '').toLowerCase();
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    entry = { count: 0, firstAttemptAt: now, lockedUntil: null };
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
  loginAttempts.set(key, entry);
}

function clearLoginAttempts(username) {
  loginAttempts.delete(String(username || '').toLowerCase());
}

app.get('/login', (req, res) => {
  if (req.currentUser) return res.redirect('/');
  res.render('login', { error: req.query.error, nextUrl: req.query.next || '' });
});

app.post('/login', async (req, res) => {
  const rateLimit = checkLoginRateLimit(req.body.username);
  if (rateLimit.blocked) {
    const msg = `Too many failed attempts. Try again in about ${rateLimit.minutesLeft} minute(s).`;
    return res.redirect('/login?error=' + encodeURIComponent(msg) + '&next=' + encodeURIComponent(req.body.next || ''));
  }
  const user = await usersLib.verifyPassword(req.body.username, req.body.password);
  if (!user) {
    recordFailedLogin(req.body.username);
    return res.redirect('/login?error=' + encodeURIComponent('Incorrect username or password.') + '&next=' + encodeURIComponent(req.body.next || ''));
  }
  clearLoginAttempts(req.body.username);
  // Regenerate the session on login rather than reusing whatever session
  // (if any) existed before authentication — otherwise an attacker who
  // fixed a victim's session ID before login (session fixation) would
  // gain a valid, authenticated session once that victim logs in.
  req.session.regenerate((err) => {
    if (err) return res.redirect('/login?error=' + encodeURIComponent('Login failed, please try again.'));
    req.session.userId = user.id;
    // A leading "/" alone isn't enough — "//evil.com" also starts with "/"
    // but browsers treat a leading "//" as protocol-relative, redirecting
    // off-site. Both checks are required for this to actually be a safe,
    // same-origin-only redirect target.
    const nextUrl = req.body.next;
    const isSafeNext = nextUrl && nextUrl.startsWith('/') && !nextUrl.startsWith('//');
    res.redirect(isSafeNext ? nextUrl : '/');
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Everything below requires login.
app.use(auth.requireLogin);

// mustChangePassword was previously tracked correctly but only ever
// surfaced as a dismissible banner (partials/nav.ejs) — nothing actually
// stopped a user ignoring it indefinitely. This is the real, server-side
// gate: while it's true, every page except the account page itself (where
// the password actually gets changed) and logout redirects there instead.
app.use((req, res, next) => {
  const allowedWhileGated = req.path === '/account' || req.path === '/account/password' || req.path === '/logout';
  if (req.currentUser && req.currentUser.mustChangePassword && !allowedWhileGated) {
    return res.redirect('/account?notice=' + encodeURIComponent('Please set a new password before continuing.'));
  }
  next();
});

// Wrap each authenticated request in a db read cache so cross-table
// formula/rollup lookups don't re-read data/db.json on every hop.
// Measured impact: /bills was averaging ~2.5s on ~100 records; this drops
// it to a few hundred ms without changing storage.
app.use((req, res, next) => {
  db.runWithRequestCache(next);
});

// Load schema fresh per request and expose it, filtering the nav to what
// this user is allowed to read (admins see everything).
app.use((req, res, next) => {
  req.schema = schemaLib.load();
  const isAdmin = req.currentUser && req.currentUser.isAdmin;
  res.locals.navOrder = isAdmin
    ? req.schema.navOrder
    : req.schema.navOrder.filter(k => usersLib.can(req.currentUser, k, 'read'));
  res.locals.entities = req.schema.entities;
  res.locals.screens = schemaLib.screensFor(req.schema);
  // Template-side permission check, currently used by the nav partial to
  // decide whether the Bills tab shows — same usersLib.can everything else
  // uses, just reachable from EJS.
  res.locals.userCan = (entityKey, action) => usersLib.can(req.currentUser, entityKey, action);
  // Sidebar: same permission model as navOrder above (admin sees
  // everything; everyone else only what they can read), but grouped and
  // icon-carrying rather than a flat list. usersLib.can already returns
  // true for an admin on every table, so one code path covers both —
  // no separate isAdmin branch needed the way navOrder above has one.
  res.locals.sidebarGroups = schemaLib.sidebarGroupsFor(req.schema, (k, action) => usersLib.can(req.currentUser, k, action));
  res.locals.renderIcon = icons.renderIcon;
  res.locals.taxNoticeAcknowledged = !!req.schema.taxNoticeAcknowledged;
  res.locals.currentUrl = req.originalUrl;
  next();
});

// Idle session timeout: apply the admin-configured minutes (Admin ->
// Session) to THIS session's cookie right now. Combined with rolling:true
// above, this means the browser's session cookie always expires
// `sessionTimeoutMinutes` from the most recent request — genuine "N
// minutes of inactivity," not a flat timer from login, and it takes
// effect immediately if the admin changes the setting (no restart needed,
// since we read it fresh from schema.json on every request).
app.use((req, res, next) => {
  if (req.session) {
    req.session.cookie.maxAge = (req.schema.sessionTimeoutMinutes || 30) * 60 * 1000;
  }
  res.locals.sessionTimeoutMinutes = req.schema.sessionTimeoutMinutes || 30;
  next();
});

// Lightweight endpoint the client-side idle-warning JS pings while the user
// is genuinely active (mouse/keyboard), so the server-side session stays in
// sync with real activity rather than only resetting on full page loads.
// Doesn't need to do anything itself — just being an authenticated request
// that passes through the middleware above is enough to extend the cookie.
app.post('/api/keepalive', (req, res) => {
  res.status(204).end();
});

app.use('/admin', auth.requireAdmin, adminRouter);

// ---- account (any logged-in user) ------------------------------------------

app.get('/account', (req, res) => {
  res.render('account', { error: req.query.error, notice: req.query.notice, activeKey: '' });
});

app.post('/account/password', async (req, res) => {
  try {
    if (!(await usersLib.verifyPassword(req.currentUser.username, req.body.currentPassword))) {
      throw new Error('Current password is incorrect.');
    }
    if (req.body.newPassword !== req.body.confirmPassword) {
      throw new Error('New password and confirmation do not match.');
    }
    await usersLib.changeOwnPassword(req.currentUser.id, req.body.newPassword);
    res.redirect('/account?notice=' + encodeURIComponent('Password updated.'));
  } catch (err) {
    res.redirect('/account?error=' + encodeURIComponent(err.message));
  }
});

// ---- helpers ---------------------------------------------------------------

function getFkOptions(schema, field, parentEntity, parentRecord, grandfatherValue) {
  const refEntity = schema.entities[field.ref];
  if (!refEntity) return [];
  // parentEntity/parentRecord are supplied for create/edit forms so an
  // fkWhere condition can filter the picker (and resolve any parent.X
  // references). List-filter dropdowns call this with neither, which
  // schemaLib.fkWhereFilterRows treats as "no constraint" — full list.
  const rows = schemaLib.fkWhereFilterRows(schema, field, refEntity, db.getAll(refEntity.key), parentEntity, parentRecord);
  const options = rows.map(r => ({
    value: r[refEntity.pk],
    label: `${r[refEntity.pk]} \u2014 ${schemaLib.display(refEntity, r, schema)}`,
  }));
  // A constrained picker is a convenience for choosing something NOW — it
  // should never make an already-chosen, historically valid value vanish
  // from the dropdown just because the world changed (e.g. a tenant who
  // was active when this record was created, but isn't anymore). Without
  // this, the <select> silently shows "— none —" for a record that
  // actually has a real value, and saving without touching the field
  // would wipe it to blank with no warning at all — worse than a visible
  // validation error. grandfatherValue is this record's OWN current
  // value for this field (not the general option list) — added back in
  // if fkWhereFilterRows dropped it, clearly labelled so it's obvious why.
  if (grandfatherValue !== undefined && grandfatherValue !== null && grandfatherValue !== '' &&
      !options.some(o => String(o.value) === String(grandfatherValue))) {
    const row = db.getAll(refEntity.key).find(r => String(r[refEntity.pk]) === String(grandfatherValue));
    if (row) {
      options.unshift({
        value: row[refEntity.pk],
        label: `${row[refEntity.pk]} \u2014 ${schemaLib.display(refEntity, row, schema)} (current \u2014 no longer matches this field's filter)`,
      });
    }
  }
  return options;
}

// One resolvePicklistOptionsForForm() call per picklist-type field on the
// entity, keyed by field name — the create/edit form needs this for
// every such field at once, not just one.
function getPicklistFieldData(schema, entity, record) {
  const out = {};
  entity.fields.filter(f => f.type === 'picklist').forEach(f => {
    out[f.name] = schemaLib.resolvePicklistOptionsForForm(schema, entity, f, record);
  });
  return out;
}

// Enriches schemaLib.bulkLinkableRelationships() with human-readable
// labels for the button text and confirm dialog — kept as a small
// server.js helper rather than in schema.js since it's purely about
// display text, not schema logic.
function bulkLinkableRelationshipsWithLabels(schema, entityKey) {
  return schemaLib.bulkLinkableRelationships(schema, entityKey).map(rel => {
    const childEntity = schema.entities[rel.childEntityKey];
    const field = childEntity.fields.find(f => f.name === rel.childFieldName);
    return { ...rel, childLabel: childEntity.label, fieldLabel: field ? field.label : rel.childFieldName };
  });
}

function coerceBody(schema, entity, body, files, existingRecord) {
  files = files || {};
  const record = {};
  entity.fields.forEach(f => {
    if (f.type === 'formula' || f.type === 'series' || f.type === 'rollup' || f.type === 'spacer' || f.type === 'section') return; // computed/auto-assigned/layout-only, never taken from the form
    if (f.type === 'image') {
      // Uploads are handled after coerceBody (need to await disk write), so
      // here we just preserve the existing filename unless the form
      // explicitly asked to clear it. The route handler fills in a new
      // filename if a file was uploaded.
      const clear = body[`__clear_${f.name}`] === 'on';
      record[f.name] = clear ? '' : (existingRecord ? existingRecord[f.name] || '' : '');
      return;
    }
    // Read-only enforcement — the disabled/readonly HTML attribute on the
    // form is purely a client-side hint and trivially bypassed by
    // submitting the form directly (curl, a modified page, etc.), the
    // same lesson as the required-field/type validation added earlier.
    // On update: keep whatever the record already had, ignore anything
    // submitted for this field. On create: there's no existing value to
    // fall back to, and a genuinely disabled form field isn't included
    // in what the browser submits at all — so recompute its default the
    // same way the "new record" form itself did, rather than landing
    // blank.
    const isReadOnlyNow = f.readOnlyMode === 'always' || (f.readOnlyMode === 'afterCreation' && existingRecord);
    if (isReadOnlyNow) {
      record[f.name] = existingRecord ? existingRecord[f.name] : schemaLib.computeFieldDefault(schema, entity, f, {});
      if (record[f.name] === undefined) record[f.name] = '';
      return;
    }
    let val = body[f.name];
    if (f.type === 'bool') {
      val = val === 'on' || val === 'true' || val === true;
    } else if (f.type === 'number' || f.type === 'currency' || f.type === 'percent') {
      val = val === '' || val === undefined ? '' : Number(val);
    } else {
      val = val === undefined ? '' : val;
    }
    record[f.name] = val;
  });
  return record;
}

// Server-side enforcement of "required" and numeric-type validity —
// previously only the browser's own HTML5 required/number-input
// validation stood in the way, trivially bypassed by anyone submitting
// the form directly (curl, a modified page, etc.). Called right after
// coerceBody, before anything gets written; throws with a clear,
// specific message naming the actual field, rather than silently
// storing a blank required field or a NaN (which becomes null once
// JSON.stringify'd, a confusing thing to debug later).
// Returns an array of { field, message } — empty means valid. Collects
// every failing field in one pass rather than throwing on the first one,
// so a form re-render can show every problem at once instead of a
// fix-one-submit-again-find-the-next cycle.
function validateRequiredAndTypes(entity, record) {
  const errors = [];
  entity.fields.forEach(f => {
    if (f.type === 'formula' || f.type === 'series' || f.type === 'rollup' || f.type === 'spacer' || f.type === 'section' || f.type === 'image') return;
    if (f.key && f.auto) return; // auto-numbered primary key — legitimately blank until assigned after this validation runs, not something the form ever supplies
    const val = record[f.name];
    if ((f.type === 'number' || f.type === 'currency' || f.type === 'percent') && val !== '' && typeof val === 'number' && isNaN(val)) {
      errors.push({ field: f.name, message: `"${f.label}" needs a real number \u2014 the value given isn't one.` });
      return;
    }
    if (f.required) {
      if (f.type === 'bool') return; // a checkbox's "required" doesn't mean "must be checked" here — false is a valid, complete value
      const isBlank = val === '' || val === undefined || val === null;
      if (isBlank) errors.push({ field: f.name, message: `"${f.label}" is required.` });
    }
  });
  return errors;
}

// Persists uploaded image files under data/uploads/<entity>/<field>/ and
// returns the filename that should be stored in the record. Prior file (if
// being replaced) is removed to avoid orphans piling up.
// Extensions that must never land on disk or be served for an
// attacker-influenced upload — executable/script/markup types a browser
// or the OS would treat as active content rather than inert data. The
// filename's extension for a "file"-type upload is whatever the
// uploader's original filename claimed (no magic-bytes check exists for
// generic files, unlike images) — this is the actual safety net for
// that field type, checked both at upload time (below) and again at
// serve time (the /uploads route) as defense-in-depth.
const DANGEROUS_UPLOAD_EXTENSIONS = new Set([
  '.html', '.htm', '.svg', '.js', '.mjs', '.cjs', '.php', '.phtml', '.exe', '.sh',
  '.bat', '.cmd', '.com', '.jar', '.msi', '.dll', '.ps1', '.vbs', '.wsf', '.xhtml',
]);

function persistUploadedImages(entity, files, record, priorRecord) {
  entity.fields.filter(f => f.type === 'image' || f.type === 'file').forEach(f => {
    const fieldKey = f.type === 'file' ? `file_${f.name}` : `img_${f.name}`;
    const uploaded = (files && files[fieldKey] && files[fieldKey][0]) || null;
    if (uploaded) {
      if (f.type === 'image') {
        // Verify the file's REAL type from its actual bytes
        const ext = detectRealImageExtension(uploaded.buffer);
        if (!ext) {
          throw new Error(`"${uploaded.originalname}" doesn't look like a genuine image file (JPG/PNG/GIF/WEBP) — the upload was rejected.`);
        }
      }
      if (f.type === 'file') {
        // No magic-bytes check exists for generic files (unlike images) —
        // the extension is whatever the uploader's original filename
        // claimed. Reject anything that would be dangerous to have ever
        // land on disk at all, not just dangerous to later SERVE (see the
        // matching check in the /uploads route) — belt and suspenders.
        const claimedExt = path.extname(uploaded.originalname).toLowerCase();
        if (DANGEROUS_UPLOAD_EXTENSIONS.has(claimedExt)) {
          throw new Error(`"${uploaded.originalname}" has a file type (${claimedExt}) that isn't allowed for security reasons.`);
        }
      }
      const dir = path.join(UPLOADS_DIR, entity.key, f.name);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // For files: preserve the original extension; for images: use detected extension
      const ext = f.type === 'file'
        ? (path.extname(uploaded.originalname) || '.bin')
        : detectRealImageExtension(uploaded.buffer);
      const filename = crypto.randomBytes(8).toString('hex') + ext;
      fs.writeFileSync(path.join(dir, filename), uploaded.buffer);
      // Remove the previous file, if any, once the new one is safely written.
      if (priorRecord && priorRecord[f.name]) {
        const oldPath = path.join(dir, priorRecord[f.name]);
        if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (e) { /* best-effort */ }
      }
      record[f.name] = filename;
    } else if (record[f.name] === '' && priorRecord && priorRecord[f.name]) {
      // Explicit clear: remove the old file too.
      const oldPath = path.join(UPLOADS_DIR, entity.key, f.name, priorRecord[f.name]);
      if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (e) { /* best-effort */ }
    }
  });
}

function requireEntity(req, res, next) {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown screen: ' + req.params.entity);
  // A table moved into Admin (Admin -> Tables -> "Move into Admin") is
  // admin-only by virtue of living there — same reasoning as any other
  // Admin subpage, not a separate permission concept to configure.
  if (entity.inAdmin && !(req.currentUser && req.currentUser.isAdmin)) {
    return res.status(403).send('This screen is only available to administrators.');
  }
  req.entity = entity;
  next();
}

function perms(entity, user) {
  return {
    canCreate: usersLib.can(user, entity.key, 'create'),
    canUpdate: usersLib.can(user, entity.key, 'update'),
    canDelete: usersLib.can(user, entity.key, 'delete'),
  };
}

// Sorts an array of records by an entity's configured default sort field/dir.
function applySort(entity, rows, overrideField, overrideDir) {
  const sortField = overrideField || entity.sortField;
  if (!sortField) return rows;
  const dir = (overrideDir || entity.sortDir) === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = a[sortField], bv = b[sortField];
    if (av === bv) return 0;
    if (av === undefined || av === '') return 1;
    if (bv === undefined || bv === '') return -1;
    const an = Number(av), bn = Number(bv);
    if (!isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

// ---- routes ---------------------------------------------------------------

// Computes the actual rows an Applet instance should show inside a
// Screen/View: the applet's own filterCondition (always applied), then —
// if this instance has a parent in the same view — filtered further by
// whatever's currently selected there, then sorted the same way any List
// screen already sorts (applySort reads sortField/sortDir generically,
// and an Applet has both, so it's reused directly, no duplicate logic).
// Returns null specifically (not an empty array) when the instance has a
// parent but nothing's selected there yet, so the caller can render
// "select a record above" instead of a merely-empty table.
function computeAppletInstanceRows(schema, applet, instance, selections) {
  const entity = schema.entities[applet.baseTable];
  let rows = db.getAll(applet.baseTable);
  if (applet.filterCondition && applet.filterCondition.trim()) {
    rows = rows.filter(r => schemaLib.evalFormula(applet.filterCondition, schema, entity, r, {}, 0) === true);
  }
  if (instance.parentInstanceKey) {
    const parentSelection = selections[instance.parentInstanceKey];
    if (!parentSelection) return null;
    rows = rows.filter(r => String(r[instance.linkField]) === String(parentSelection));
  }
  // Every other screen in the app (List, Detail, Reports) renders
  // formula/rollup fields via their actually-computed value, and formats
  // every field by its real type (currency, date, percent, ...) — this
  // was missing here entirely: rows were the raw stored records, so a
  // formula/rollup column would render blank (not just unformatted —
  // genuinely missing, since the raw record has no such key at all).
  // Computed BEFORE sorting, not after — applySort reads row[sortField]
  // directly rather than through the formula engine, so sorting by a
  // computed field needs that value already present on the row.
  rows = rows.map(r => schemaLib.withComputedFields(schema, entity, r));
  return applySort(applet, rows);
}

// Renders a Screen: whichever View is active (?view=<key>, defaulting to
// the first), with each of its Applet instances computed and rendered in
// position order. Selections carried in the URL as one query param per
// instance (?selected_<instanceKey>=<pk>) rather than one single value,
// since more than one applet instance on the same view could each need
// their own independent "currently selected row" tracked. This is the
// settled "full page reload" design — clicking a row re-navigates here
// with that row's key added to the URL, no client-side state at all.
// Save an edited record from a detail applet (in-screen form save).
// Redirects back to the same screen/view with the selection preserved.
app.post('/screens/:screenKey/save/:entity/:id', requireEntity, auth.requirePermission('update'), (req, res) => {
  const entity = req.entity;
  const before = db.getById(entity.key, entity.pk, req.params.id);
  if (!before) return res.status(404).send(`${entity.singular} "${req.params.id}" not found.`);
  const record = coerceBody(req.schema, entity, req.body, null, before);
  record[entity.pk] = before[entity.pk]; // PK from URL, not the form body
  // fkConstraintErrors evaluates the fkWhere formula's `parent.*` references
  // against this record — if the condition references a formula/rollup
  // field (e.g. "parent.I_MonthYear"), that field only exists after
  // withComputedFields runs; coerceBody alone never produces it (formula
  // fields aren't editable inputs, so they're never in req.body). Validate
  // against a computed-fields-resolved copy, but keep saving the raw one —
  // formula values must never be persisted, only derived on read.
  const recordForValidation = schemaLib.withComputedFields(req.schema, entity, record);
  const validationErrors = validateRequiredAndTypes(entity, record).concat(schemaLib.fkConstraintErrors(req.schema, entity, recordForValidation, before));
  const returnView = req.body._returnView || '';
  const returnParams = new URLSearchParams();
  if (returnView) returnParams.set('view', returnView);
  Object.keys(req.body).forEach(k => { if (k.startsWith('_sel_')) returnParams.set(k.replace('_sel_', 'selected_'), req.body[k]); });
  const returnUrl = `/screens/${encodeURIComponent(req.params.screenKey)}?${returnParams.toString()}`;
  if (validationErrors.length > 0) {
    const msgs = validationErrors.map(e => `${e.field}: ${e.message}`).join('; ');
    return res.redirect(returnUrl + '&_saveError=' + encodeURIComponent(msgs));
  }
  record[entity.pk] = before[entity.pk];
  db.update(entity.key, entity.pk, req.params.id, record);
  res.redirect(returnUrl + '&_saveOk=1');
});

app.get('/screens/:screenKey', (req, res) => {
  const schema = req.schema;
  const screen = schemaLib.screenByKey(schema, req.params.screenKey);
  if (!screen) return res.status(404).send('Unknown screen.');
  const viewRefs = (screen.views || []).slice().sort((a, b) => a.position - b.position);
  const viewList = viewRefs.map(v => schemaLib.viewByKey(schema, v.viewKey)).filter(Boolean);

  if (viewList.length === 0) {
    return res.render('screen', { screen, viewList: [], activeViewKey: null, appletBlocks: [], activeKey: 'screen:' + screen.key, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue, picklistLabel: (ent, f, v) => schemaLib.resolvePicklistLabel(req.schema, ent, f, v), picklistOptionsFor: (ent, f) => schemaLib.resolvePicklistOptions(req.schema, ent, f) });
  }
  const activeViewKey = viewList.some(v => v.key === req.query.view) ? req.query.view : viewList[0].key;
  const activeView = viewList.find(v => v.key === activeViewKey);

  const selections = {};
  Object.keys(req.query).forEach(k => {
    if (k.startsWith('selected_') && req.query[k]) selections[k.slice('selected_'.length)] = req.query[k];
  });

  const instances = (activeView.applets || []).slice().sort((a, b) => a.position - b.position);

  // Selecting a new row in any applet instance must invalidate every
  // selection *downstream* of it (child, grandchild, and so on) — not
  // just leave them untouched. A stale child/grandchild selection left
  // over from the previous parent record may not even belong to the new
  // parent at all once its own rows are re-filtered, which is exactly
  // what "grandchild applets don't refresh when the parent record steps
  // off to another record" was actually describing: the immediate child
  // does re-filter correctly (computeAppletInstanceRows always uses the
  // current selections), but a grandchild's own selected_ value was
  // being blindly carried forward in the URL regardless of whether it
  // still made sense, since the previous code only excluded the single
  // instance actually being clicked. Built once per request (not once
  // per instance) since every instance's selectUrl needs the same
  // descendant map.
  const descendantsOf = {};
  instances.forEach(inst => { descendantsOf[inst.instanceKey] = new Set(); });
  instances.forEach(inst => {
    let current = inst;
    const seen = new Set(); // guard against a corrupt/cyclic parentInstanceKey chain
    while (current && current.parentInstanceKey && !seen.has(current.parentInstanceKey)) {
      seen.add(current.parentInstanceKey);
      if (descendantsOf[current.parentInstanceKey]) descendantsOf[current.parentInstanceKey].add(inst.instanceKey);
      current = instances.find(i => i.instanceKey === current.parentInstanceKey);
    }
  });

  const appletBlocks = instances.map(instance => {
    const applet = schemaLib.appletByKey(schema, instance.appletKey);
    if (!applet) return { instance, applet: null, error: 'This applet no longer exists.' };
    const entity = schema.entities[applet.baseTable];
    if (!entity) return { instance, applet, error: 'This applet\u2019s base table no longer exists.' };
    const rows = computeAppletInstanceRows(schema, applet, instance, selections);

    if (applet.type === 'detail') {
      // Read-only detail applet: shows the single record currently selected
      // in its parent list applet (all fields, formatted by type). This is
      // Siebel's list-form pairing on one business component. rows === null
      // => the parent has no selection yet; empty => the selected key matched
      // nothing; no parent at all => it isn't wired to a list to select from.
      if (!instance.parentInstanceKey) return { instance, applet, entity, isDetail: true, detailUnlinked: true };
      if (rows === null) return { instance, applet, entity, isDetail: true, needsParentSelection: true };
      const canUpdate = usersLib.can(req.currentUser, entity.key, 'update');
      const canDelete = usersLib.can(req.currentUser, entity.key, 'delete');
      const canCreate = usersLib.can(req.currentUser, entity.key, 'create');
      // Per-applet field selection: if the applet specifies detailFields, use
      // those (in order); otherwise show all fields (the default).
      const chosenFields = (applet.detailFields && applet.detailFields.length)
        ? applet.detailFields.map(n => {
            if (n === '__spacer__') return { name: '__spacer__', label: '', type: 'spacer' };
            if (n === '__section__') return { name: '__section__', label: 'Section', type: 'section' };
            return entity.fields.find(f => f.name === n);
          }).filter(Boolean)
        : entity.fields;
      return { instance, applet, entity, isDetail: true, detailRecord: rows[0] || null, detailFields: chosenFields, canUpdate, canDelete, canCreate, navPrev: null, navNext: null };
    }

    const columns = (applet.columns || []).map(name => entity.fields.find(f => f.name === name)).filter(Boolean);
    const selectedValue = selections[instance.instanceKey] || null;
    const listCanCreate = usersLib.can(req.currentUser, entity.key, 'create');
    function selectUrl(pkValue) {
      const params = new URLSearchParams();
      params.set('view', activeViewKey);
      const descendants = descendantsOf[instance.instanceKey];
      Object.keys(selections).forEach(k => {
        if (k === instance.instanceKey) return;
        if (descendants.has(k)) return; // clear, don't carry forward — this ancestor's selection just changed
        params.set('selected_' + k, selections[k]);
      });
      params.set('selected_' + instance.instanceKey, pkValue);
      const firstChild = instances.find(inst => inst.parentInstanceKey === instance.instanceKey);
      const frag = "#applet-" + (firstChild ? firstChild.instanceKey : instance.instanceKey);
      return `/screens/${screen.key}?${params.toString()}${frag}`;
    }
    return { instance, applet, entity, columns, rows, selectUrl, selectedValue, needsParentSelection: rows === null, canCreate: listCanCreate };
  });

  // Second pass: detail applet record navigation (prev/next). Needs the
  // parent list block to be fully built, so it can't happen inside the
  // single-pass .map() above.
  appletBlocks.forEach(block => {
    if (!block.isDetail || !block.detailRecord || !block.instance.parentInstanceKey) return;
    const parentBlock = appletBlocks.find(b => b.instance && b.instance.instanceKey === block.instance.parentInstanceKey);
    if (!parentBlock || !parentBlock.rows) return;
    const pks = parentBlock.rows.map(r => String(r[block.entity.pk]));
    const curIdx = pks.indexOf(String(block.detailRecord[block.entity.pk]));
    if (curIdx > 0) block.navPrev = pks[curIdx - 1];
    if (curIdx >= 0 && curIdx < pks.length - 1) block.navNext = pks[curIdx + 1];
  });

  res.render('screen', { screen, viewList, activeViewKey, appletBlocks, activeKey: 'screen:' + screen.key, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue, picklistLabel: (ent, f, v) => schemaLib.resolvePicklistLabel(req.schema, ent, f, v), picklistOptionsFor: (ent, f) => schemaLib.resolvePicklistOptions(req.schema, ent, f), saveError: req.query._saveError || null, saveOk: !!req.query._saveOk });
});

app.get('/', (req, res) => {
  // A single bad widget (a Tax computation error, a missing field) fails
  // its own widget quietly rather than take down the whole Home page —
  // computeHomeWidgets already drops any widget whose data came back
  // unavailable, this is just a last-resort net around the whole call.
  let widgets = [];
  try { widgets = homeMod.computeHomeWidgets(req.schema, req.currentUser); } catch (e) { widgets = []; }
  res.render('landing', {
    activeKey: '', widgets, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent,
    formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    schema: req.schema, display: (e, r) => schemaLib.display(e, r, req.schema), db: db,
    resolvePicklistLabel: schemaLib.resolvePicklistLabel,
    WIDGET_TYPES: homeMod.WIDGET_TYPES,
  });
});

// Reports: on-demand summaries built from admin-defined report configs,
// not a table of its own. Mounted here, before the generic /:entity
// routes below, because "/reports" is a single path segment and would
// otherwise be swallowed by the LIST route (which would try to treat
// "reports" as a table name and 404) — this bit us once already.
app.use(reports.router);

// LIST view (Siebel "List Applet")
const LIST_PAGE_SIZE = 50;

// Resolves this request's effective list-view state (query, filters,
// sort, page) for one table. If the request has any explicit query
// params, those win and get remembered in the session for next time
// (sticky filters) — otherwise, falls back to whatever was last
// remembered for this table. `?clear=1` wipes the remembered state for
// this table entirely, rather than falling back to it, so leaving and
// re-entering a screen after explicitly clearing doesn't silently bring
// the old filter back.
function resolveListState(req, entityKey, filterFieldNames) {
  if (!req.session.listState) req.session.listState = {};
  if (req.query.clear) {
    delete req.session.listState[entityKey];
    return { q: '', filters: {}, sort: '', dir: 'asc', page: 1 };
  }
  const hasExplicitParams = req.query.q !== undefined || req.query.sort !== undefined || req.query.page !== undefined ||
    filterFieldNames.some(name => req.query[`f_${name}`] !== undefined || req.query[`f_${name}_from`] !== undefined || req.query[`f_${name}_to`] !== undefined);

  if (hasExplicitParams) {
    const state = {
      q: req.query.q || '',
      filters: {},
      sort: req.query.sort || '',
      dir: req.query.dir === 'desc' ? 'desc' : 'asc',
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
    };
    filterFieldNames.forEach(name => {
      if (req.query[`f_${name}`] !== undefined) state.filters[`f_${name}`] = req.query[`f_${name}`];
      if (req.query[`f_${name}_from`] !== undefined) state.filters[`f_${name}_from`] = req.query[`f_${name}_from`];
      if (req.query[`f_${name}_to`] !== undefined) state.filters[`f_${name}_to`] = req.query[`f_${name}_to`];
    });
    req.session.listState[entityKey] = state;
    return state;
  }
  return req.session.listState[entityKey] || { q: '', filters: {}, sort: '', dir: 'asc', page: 1 };
}

const GLOBAL_SEARCH_CAP_PER_TABLE = 5;

// Global masthead search — scans every table the current user can read,
// reusing the exact same field-matching logic the existing per-table
// Query search already uses (schemaLib.listFieldsFor's columns), so
// "what counts as a match" is one rule, not two. Capped per table
// (rather than truly unlimited) with a link into that table's own
// filtered list for the full result set — an uncapped single page could
// otherwise return an unscannable wall of results on a big table.
// Registered BEFORE the generic /:entity route below — otherwise that
// wildcard would match "/search" as if "search" were a table name and
// this route would never be reached at all (caught by actually testing
// the real route, not just the logic in isolation).
app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const groups = [];
  if (q) {
    (req.schema.navOrder || []).forEach(entityKey => {
      const entity = req.schema.entities[entityKey];
      if (!entity || !usersLib.can(req.currentUser, entityKey, 'read')) return;
      const listFields = schemaLib.listFieldsFor(entity);
      // Search matches against list columns only (same as the per-table
      // Query box), so those are also the only computed fields worth
      // paying for here — same subset-computation rationale, and same
      // caveat, as the list route above. displayField included because
      // the result line renders it.
      const searchNeeded = new Set([...listFields.map(f => f.name), entity.displayField].filter(Boolean));
      const allRows = db.getAll(entityKey).map(r => schemaLib.withComputedFieldsSubset(req.schema, entity, r, searchNeeded));
      const matches = allRows.filter(r => listFields.some(f => String(r[f.name] ?? '').toLowerCase().includes(q)));
      if (matches.length > 0) {
        groups.push({
          entity,
          totalCount: matches.length,
          rows: matches.slice(0, GLOBAL_SEARCH_CAP_PER_TABLE),
          hasMore: matches.length > GLOBAL_SEARCH_CAP_PER_TABLE,
        });
      }
    });
  }
  res.render('search', {
    q: req.query.q || '', groups, activeKey: '',
    display: (e, r) => schemaLib.display(e, r, req.schema),
  });
});

// Bills mini-app (matrix + month entry grid) — see bills.js for why this
// is an embedded module rather than a separate service. MUST be mounted
// before the generic /:entity routes below: /bills is one path segment,
// exactly the shape /:entity matches, and requireEntity 404s unknown
// keys rather than falling through.
app.use(bills.router);
app.use(remindersMod.router);
app.use(tax.router);

app.get('/:entity', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  const listFields = schemaLib.listFieldsFor(entity);
  const filterFields = schemaLib.filterFieldsFor(entity);
  const listState = resolveListState(req, entity.key, filterFields.map(f => f.name));
  // Compute only the computed fields this view can actually read — the
  // visible columns, anything filterable, both possible sort fields (the
  // table default and any explicit override in effect), the list-totals
  // sources, and the display field (used for row link text). On a table
  // like invoices this skips the LOOKUP-heavy detail-only display strings
  // (I_Description, I_MonthYear) for every one of thousands of rows —
  // measured together with the request-scoped memo, this took the list
  // view from ~1.2s to ~0.3s at 2,100 records. Anything skipped here is
  // absent from the row, so listFields/filters/totals must ALL be in this
  // set — if you add a new consumer of row values in this route, add its
  // fields here too.
  const neededComputed = new Set([
    ...listFields.map(f => f.name),
    ...filterFields.map(f => f.name),
    entity.sortField, listState.sort, entity.displayField,
    ...((entity.listTotals || []).map(t => t.field)),
  ].filter(Boolean));
  let rows = db.getAll(entity.key).map(r => schemaLib.withComputedFieldsSubset(req.schema, entity, r, neededComputed));
  const q = listState.q.trim().toLowerCase();

  if (q) {
    rows = rows.filter(r =>
      listFields.some(f => String(r[f.name] ?? '').toLowerCase().includes(q))
    );
  }

  // Generic filters: control type depends on the field's filter "kind"
  // (schemaLib.filterKindFor) — bool/picklist/fk/text/textarea = exact-match,
  // date = from/to range, number/currency/percent = from/to range,
  // formula/rollup = whichever of the above matches their own Format As.
  // Each stacks with AND, and with the Query search above. Sticky across
  // navigation via resolveListState/req.session — a visible "Clear
  // filter" link (rendered whenever filtersActive) wipes it explicitly.
  const filterValues = {};
  let filtersActive = false;
  filterFields.forEach(f => {
    const kind = schemaLib.filterKindFor(f);
    const isPercent = f.type === 'percent' || f.format === 'percent';
    if (kind === 'date-range' || kind === 'number-range') {
      const from = (listState.filters[`f_${f.name}_from`] || '').trim();
      const to = (listState.filters[`f_${f.name}_to`] || '').trim();
      filterValues[f.name] = { from, to };
      if (from || to) {
        filtersActive = true;
        rows = schemaLib.applyFilterCondition(rows, kind, f.type, isPercent, { from, to }, r => r[f.name]);
      }
    } else {
      const val = listState.filters[`f_${f.name}`];
      filterValues[f.name] = val || '';
      if (val !== undefined && val !== '') {
        filtersActive = true;
        rows = schemaLib.applyFilterCondition(rows, kind, f.type, isPercent, { value: val }, r => r[f.name]);
      }
    }
  });

  // Sortable column headers: an explicit ?sort= (remembered via
  // listState the same as filters) overrides the table's fixed default
  // sort, rather than replacing it outright — a table with no header
  // ever clicked still sorts exactly as it always did.
  const effectiveSortField = listState.sort || entity.sortField;
  const effectiveSortDir = listState.sort ? listState.dir : entity.sortDir;
  rows = applySort(entity, rows, listState.sort, listState.sort ? listState.dir : undefined);

  const totalCount = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / LIST_PAGE_SIZE));
  const page = Math.min(listState.page, totalPages);
  // Computed over the full filtered/searched result set, BEFORE the
  // pagination slice below — a total that silently changed depending on
  // which page you happened to be viewing would be actively misleading.
  const listTotals = schemaLib.computeListTotals(rows, entity.listTotals);
  rows = rows.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);

  const fkFilterOptions = {};
  filterFields.filter(f => f.type === 'fk').forEach(f => { fkFilterOptions[f.name] = getFkOptions(req.schema, f); });

  res.render('list', {
    entity, rows, q: listState.q, activeKey: entity.key, listFields,
    filterFields, filterValues, filtersActive, fkFilterOptions, picklistOptions: schemaLib.picklistOptions, filterKindFor: schemaLib.filterKindFor,
    resolvePicklistOptions: (ent, f) => schemaLib.resolvePicklistOptions(req.schema, ent, f),
    picklistLabel: (ent, f, v) => schemaLib.resolvePicklistLabel(req.schema, ent, f, v),
    display: (e, r) => schemaLib.display(e, r, req.schema), formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    listTitle: schemaLib.listTitle(entity),
    sortField: effectiveSortField, sortDir: effectiveSortDir, listState,
    page, totalPages, totalCount, pageSize: LIST_PAGE_SIZE, listTotals,
    ...perms(entity, req.currentUser),
  });
});

// Builds the small config object form.ejs needs to render the PayQR bits
// (QR box, narration auto-fill script) using the *actual* configured field
// names rather than assuming any. Returns null for every entity except
// Payments, or if PayQR isn't fully configured yet — either way, form.ejs
// just skips the PayQR-specific sections entirely.
function getPayqrConfigFor(entity, schema) {
  if (!payqr.isPaymentsEntity(entity.key)) return null;
  const settings = payqr.getSettings(schema);
  const payeeFkField = schemaLib.payqrPaymentToPayeeFkField(schema);
  if (!payeeFkField || !payqr.settingsComplete(settings)) return null;
  return { payeeFkField, notesField: settings.paymentNotesField };
}

// NEW record form
app.get('/:entity/new/form', requireEntity, auth.requirePermission('create'), (req, res) => {
  const entity = req.entity;

  const emptyRecord = {};
  entity.fields.forEach(f => {
    emptyRecord[f.name] = f.auto ? db.nextAutoId(entity.key, entity.pk) : '';
  });
  schemaLib.applyFieldDefaults(req.schema, entity, emptyRecord);

  // "Duplicate" support: /entity/new/form?duplicateFrom=<id> pre-fills every
  // real, storable field from an existing record — used by the Duplicate
  // button on the detail page. The primary key stays blank/auto (a
  // duplicate needs its own identity), and computed fields (formula/
  // rollup/series) and images are deliberately skipped: computed fields
  // aren't stored so there's nothing to copy, series numbers must be
  // freshly assigned per record, and copying an image would mean copying
  // the underlying file, which is out of scope here — left for the admin
  // to re-upload if the duplicate genuinely needs one.
  if (req.query.duplicateFrom) {
    const source = db.getById(entity.key, entity.pk, req.query.duplicateFrom);
    if (source) {
      entity.fields.forEach(f => {
        if (f.key || schemaLib.COMPUTED_TYPES.includes(f.type) || schemaLib.LAYOUT_TYPES.includes(f.type) || f.type === 'image') return;
        emptyRecord[f.name] = source[f.name] !== undefined && source[f.name] !== null ? source[f.name] : '';
      });
    }
  }

  const payqrConfig = getPayqrConfigFor(entity, req.schema);
  // Payment records get a couple of small conveniences pre-filled before the
  // create form renders (today's date, and the payee if arriving via a
  // "Pay <payee>" link). This is PayQR-specific — see payqr.js.
  if (payqrConfig) {
    payqr.prefillNewPayment(req.query, emptyRecord, payqr.getSettings(req.schema), payqrConfig.payeeFkField);
  }

  // Built here (not at the top) so any pre-filled values — defaults,
  // duplicate-from source, PayQR prefills — are already in emptyRecord and
  // so available as `parent` to any fkWhere condition on the picker.
  const fkOptions = {};
  entity.fields.filter(f => f.type === 'fk').forEach(f => { fkOptions[f.name] = getFkOptions(req.schema, f, entity, emptyRecord); });

  res.render('form', {
    entity, record: emptyRecord, isNew: true, fkOptions, children: [], activeKey: entity.key,
    display: (e, r) => schemaLib.display(e, r, req.schema), formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    picklistOptions: schemaLib.picklistOptions, detailTitle: schemaLib.detailTitle(entity), renderHintHtml: schemaLib.renderHintHtml,
    fkWhereParentRefs: schemaLib.fkWhereParentRefs,
    picklistFieldData: getPicklistFieldData(req.schema, entity, emptyRecord),
    auditEntries: [], canUpdate: true, canDelete: false, canCreate: usersLib.can(req.currentUser, entity.key, 'create'), payqrConfig, error: req.query.error,
  });
});

// PayQR: narration preview + QR generation. Extracted into payqr.js — see
// that file for why (hardcoded field names, isolated for locatability).
app.use(payqr.router);

// Live fk-option refresh: returns the fk picker options for one field given
// the current (partial) form values as the parent record — so a dependent
// fkWhere (e.g. tenants for the chosen landlord) re-narrows the instant a
// sibling field changes, without a full page reload. Query params carry the
// sibling field values; nothing is persisted. Defined before /:entity/:id so
// "fk-options" isn't mistaken for a record id.
app.get('/:entity/fk-options/:field', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  const field = entity.fields.find(f => f.name === req.params.field && f.type === 'fk');
  if (!field) return res.status(404).json({ error: 'Unknown fk field.' });
  const parentRecord = {};
  entity.fields.forEach(f => { if (Object.prototype.hasOwnProperty.call(req.query, f.name)) parentRecord[f.name] = req.query[f.name]; });
  res.json({ options: getFkOptions(req.schema, field, entity, parentRecord) });
});

// Peek at a record's computed/rollup fields (used by fk-info-on-select).
// Returns a summary of the record's rollup and formula values for display
// next to an fk picker after the user selects a reference.
app.get('/:entity/:id/peek', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  const rec = db.getById(entity.key, entity.pk, req.params.id);
  if (!rec) return res.json({ ok: false });
  const full = schemaLib.withComputedFields(req.schema, entity, rec);
  const computed = entity.fields.filter(f => f.type === 'formula' || f.type === 'rollup');
  const fields = computed.map(f => ({
    name: f.name, label: f.label,
    display: schemaLib.formatFormulaValue(f, full[f.name]),
  }));
  res.json({ ok: true, fields });
});

// Email a record via one of its entity's email templates. Preview resolves
// the template's merge tags against the record (returns editable draft);
// send takes the (possibly preview-edited) fields and dispatches + logs.
// Placed before /:entity/:id so "email" isn't read as a record id.
app.get('/:entity/:id/email/:tpl/preview', requireEntity, auth.requirePermission('email'), (req, res) => {
  const entity = req.entity;
  const rec = db.getById(entity.key, entity.pk, req.params.id);
  if (!rec) return res.status(404).json({ error: 'Record not found.' });
  const tpl = schemaLib.templateByKey(req.schema, req.params.tpl);
  if (!tpl || tpl.baseKind !== 'email' || tpl.baseTable !== entity.key) return res.status(404).json({ error: 'Unknown email template for this record.' });
  const draft = emailMod.resolveDraft(req.schema, tpl, rec);
  if (!draft.ok) return res.status(400).json({ error: draft.error });
  res.json({ ok: true, label: tpl.label, configured: emailMod.isConfigured(req.schema), to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, html: draft.html });
});

app.post('/:entity/:id/email/:tpl/send', requireEntity, auth.requirePermission('email'), async (req, res) => {
  const entity = req.entity;
  const rec = db.getById(entity.key, entity.pk, req.params.id);
  if (!rec) return res.status(404).json({ error: 'Record not found.' });
  const tpl = schemaLib.templateByKey(req.schema, req.params.tpl);
  if (!tpl || tpl.baseKind !== 'email' || tpl.baseTable !== entity.key) return res.status(404).json({ error: 'Unknown email template for this record.' });
  const message = { to: req.body.to, cc: req.body.cc, bcc: req.body.bcc, subject: req.body.subject, html: req.body.html };
  const r = await emailMod.send(req.schema, message, { kind: 'template', sourceEntity: entity.key, sourceId: req.params.id, templateKey: tpl.key, by: req.user && req.user.username }, {});
  if (r.ok) return res.json({ ok: true, messageId: r.messageId });
  res.status(400).json({ ok: false, error: (r.error && r.error.message) || 'Send failed.' });
});

// DETAIL / EDIT form
app.get('/:entity/:id', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  const rawRecord = db.getById(entity.key, entity.pk, req.params.id);
  if (!rawRecord) return res.status(404).send(`${entity.singular} "${req.params.id}" not found.`);
  const record = schemaLib.withComputedFields(req.schema, entity, rawRecord);

  const fkOptions = {};
  entity.fields.filter(f => f.type === 'fk').forEach(f => { fkOptions[f.name] = getFkOptions(req.schema, f, entity, record, record[f.name]); });

  const children = schemaLib.computeAppletData(req.schema, entity.key, record, applySort);

  const auditEntries = entity.auditEnabled ? audit.getForRecord(entity.key, record[entity.pk]) : [];

  // Prev/Next navigation: cycles through every record of this table in its
  // default sort order (same order the List screen uses), regardless of
  // whatever Query/Filter happened to be active on the list page the user
  // arrived from — keeps this simple and predictable rather than needing
  // to carry filter state through the URL. Read permission is already
  // table-wide (checked above), so every row here is one this user can see.
  const orderedRows = applySort(entity, db.getAll(entity.key));
  const currentIdx = orderedRows.findIndex(r => String(r[entity.pk]) === String(record[entity.pk]));
  const prevPk = currentIdx > 0 ? orderedRows[currentIdx - 1][entity.pk] : null;
  const nextPk = (currentIdx !== -1 && currentIdx < orderedRows.length - 1) ? orderedRows[currentIdx + 1][entity.pk] : null;

  res.render('form', {
    entity, record, isNew: false, fkOptions, children, activeKey: entity.key,
    display: (e, r) => schemaLib.display(e, r, req.schema), formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    picklistOptions: schemaLib.picklistOptions, detailTitle: schemaLib.detailTitle(entity), renderHintHtml: schemaLib.renderHintHtml,
    picklistFieldData: getPicklistFieldData(req.schema, entity, record),
    isSoftDeleted: !!rawRecord.__deletedAt, deletedAt: rawRecord.__deletedAt, deletedBy: rawRecord.__deletedBy,
    billTemplate: schemaLib.templateForEntity(req.schema, entity.key),
    emailTemplates: schemaLib.emailTemplatesForEntity(req.schema, entity.key),
    canEmail: usersLib.can(req.currentUser, entity.key, 'email'),
    fkWhereParentRefs: schemaLib.fkWhereParentRefs,
    pdfGeneratedAt: rawRecord.__pdfGeneratedAt || null,
    auditEntries, payqrConfig: getPayqrConfigFor(entity, req.schema), prevPk, nextPk, error: req.query.error, notice: req.query.notice, ...perms(entity, req.currentUser),
    bulkLinkable: bulkLinkableRelationshipsWithLabels(req.schema, entity.key),
  });
});

// Dynamically build multer field spec for this entity's image fields.
// The record form is always submitted as multipart/form-data (needed for
// image uploads), so multer has to run on every submission — otherwise
// req.body is empty and every field on the new record ends up blank.
// This applies even for tables with no image fields: multer.fields() with
// an empty spec still parses text fields and just rejects any files.
function imageUploadMiddleware(req, res, next) {
  const entity = req.entity;
  const imageFields = entity.fields.filter(f => f.type === 'image');
  const fileFields = entity.fields.filter(f => f.type === 'file');
  const spec = imageFields.map(f => ({ name: `img_${f.name}`, maxCount: 1 }))
    .concat(fileFields.map(f => ({ name: `file_${f.name}`, maxCount: 1 })));
  uploadImage.fields(spec)(req, res, (err) => {
    if (err) {
      const back = req.params.id ? `/${entity.key}/${encodeURIComponent(req.params.id)}` : `/${entity.key}/new/form`;
      return res.redirect(back + '?error=' + encodeURIComponent(err.message));
    }
    next();
  });
}

// Re-renders the create/edit form after a validation failure, instead of
// redirecting — a redirect loses every value the user already typed,
// forcing a full re-entry over one bad field. Builds the essential
// context form.ejs needs (fkOptions, picklist data, formatters) the same
// way the real GET routes do; deliberately does NOT rebuild the fuller
// edit-page extras (child applets, audit history, prev/next navigation)
// inline here too — that would substantially bloat both POST routes for
// what's meant to be a quickly-fixed, short-lived state, not a page
// someone lingers on. Those reappear normally on the next successful
// load.
function renderFormWithErrors(req, res, entity, record, isNew, fieldErrors, generalError) {
  const fkOptions = {};
  entity.fields.filter(f => f.type === 'fk').forEach(f => { fkOptions[f.name] = getFkOptions(req.schema, f, entity, record, record[f.name]); });
  res.status(400).render('form', {
    entity, record, isNew, fkOptions, children: [], activeKey: entity.key,
    display: (e, r) => schemaLib.display(e, r, req.schema), formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    picklistOptions: schemaLib.picklistOptions, detailTitle: schemaLib.detailTitle(entity), renderHintHtml: schemaLib.renderHintHtml,
    fkWhereParentRefs: schemaLib.fkWhereParentRefs,
    picklistFieldData: getPicklistFieldData(req.schema, entity, record),
    auditEntries: [], payqrConfig: getPayqrConfigFor(entity, req.schema), prevPk: null, nextPk: null,
    error: generalError || null, fieldErrors: fieldErrors || {},
    canUpdate: true, canDelete: !isNew, canCreate: usersLib.can(req.currentUser, entity.key, 'create'),
  });
}

// CREATE
app.post('/:entity', requireEntity, auth.requirePermission('create'), imageUploadMiddleware, (req, res) => {
  const entity = req.entity;
  const record = coerceBody(req.schema, entity, req.body, req.files, null);
  // Same reasoning as the screen-save route above: an fkWhere condition
  // may reference a formula/rollup field via parent.X, which only exists
  // after withComputedFields runs — validate against a resolved copy,
  // save the raw one.
  const recordForValidation = schemaLib.withComputedFields(req.schema, entity, record);
  const validationErrors = validateRequiredAndTypes(entity, record).concat(schemaLib.fkConstraintErrors(req.schema, entity, recordForValidation));
  if (validationErrors.length > 0) {
    const fieldErrors = {};
    validationErrors.forEach(e => { fieldErrors[e.field] = e.message; });
    return renderFormWithErrors(req, res, entity, record, true, fieldErrors, `Please fix ${validationErrors.length === 1 ? 'the field below' : `the ${validationErrors.length} fields below`}.`);
  }
  try {
    persistUploadedImages(entity, req.files, record, null);
  } catch (e) {
    return renderFormWithErrors(req, res, entity, record, true, {}, e.message);
  }
  const pkField = entity.fields.find(f => f.key);
  if (pkField && pkField.auto) record[entity.pk] = db.nextAutoId(entity.key, entity.pk);
  schemaLib.assignSeriesFields(req.schema, entity, record);
  db.insert(entity.key, record);
  if (entity.auditEnabled) {
    audit.log({ entityKey: entity.key, recordId: record[entity.pk], action: 'create', username: req.currentUser.username, before: null, after: record });
  }
  res.redirect(`/${entity.key}/${encodeURIComponent(record[entity.pk])}`);
});

// Generic "Link Matching Records" bulk-link action — see
// schemaLib.linkMatchingRecords for the full explanation. Entirely
// schema-driven: works for any relationship an admin has opted into via
// fkBulkLink on the child field, no table/field names hardcoded here.
app.post('/:entity/:id/link-matching/:childEntity/:childField', requireEntity, auth.requirePermission('update'), (req, res) => {
  const entity = req.entity;
  const record = db.getById(entity.key, entity.pk, req.params.id);
  if (!record) return res.status(404).send(`${entity.singular} "${req.params.id}" not found.`);
  const childEntity = req.schema.entities[req.params.childEntity];
  if (!childEntity || !usersLib.can(req.currentUser, childEntity.key, 'update')) {
    return res.status(403).send('Not permitted to link records on that table.');
  }
  const linked = schemaLib.linkMatchingRecords(req.schema, entity.key, record, req.params.childEntity, req.params.childField);
  res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}?notice=` + encodeURIComponent(`${linked} record(s) linked.`));
});

// UPDATE
app.post('/:entity/:id', requireEntity, auth.requirePermission('update'), imageUploadMiddleware, (req, res) => {
  const entity = req.entity;
  const before = db.getById(entity.key, entity.pk, req.params.id);
  if (!before) return res.status(404).send(`${entity.singular} "${req.params.id}" not found.`);
  const record = coerceBody(req.schema, entity, req.body, req.files, before);
  // Same reasoning as CREATE above: resolve computed fields for the
  // fkConstraintErrors check (parent.X may reference a formula field),
  // but keep saving the raw coerced record.
  const recordForValidation = schemaLib.withComputedFields(req.schema, entity, record);
  const validationErrors = validateRequiredAndTypes(entity, record).concat(schemaLib.fkConstraintErrors(req.schema, entity, recordForValidation, before));
  if (validationErrors.length > 0) {
    const fieldErrors = {};
    validationErrors.forEach(e => { fieldErrors[e.field] = e.message; });
    record[entity.pk] = before[entity.pk];
    return renderFormWithErrors(req, res, entity, record, false, fieldErrors, `Please fix ${validationErrors.length === 1 ? 'the field below' : `the ${validationErrors.length} fields below`}.`);
  }
  try {
    persistUploadedImages(entity, req.files, record, before);
  } catch (e) {
    record[entity.pk] = before[entity.pk];
    return renderFormWithErrors(req, res, entity, record, false, {}, e.message);
  }
  record[entity.pk] = before[entity.pk]; // identity is immutable via this form, regardless of body contents
  db.update(entity.key, entity.pk, req.params.id, record);
  if (entity.auditEnabled) {
    audit.log({ entityKey: entity.key, recordId: req.params.id, action: 'update', username: req.currentUser.username, before, after: { ...before, ...record } });
  }
  res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}`);
});

// BILL/DOCUMENT PDF — generate-and-store (per the agreed v1 scope: the
// PDF that was actually generated stays retrievable later even if the
// template or the underlying data changes afterward, rather than
// re-rendering fresh every time). Gated by the same read permission as
// the record itself, since a generated bill is just another view of
// that same record's data.
app.post('/:entity/:id/generate-pdf', requireEntity, auth.requirePermission('read'), async (req, res) => {
  const entity = req.entity;
  const template = schemaLib.templateForEntity(req.schema, entity.key);
  if (!template) return res.status(404).send('No template configured for this table.');
  const record = db.getById(entity.key, entity.pk, req.params.id);
  if (!record) return res.status(404).send(`${entity.singular} "${req.params.id}" not found.`);
  const rendered = schemaLib.renderBillTemplate(req.schema, template, record);
  if (rendered.error) return res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent(rendered.error));
  try {
    await billPdf.generateAndStore(entity.key, req.params.id, rendered.html, { landscape: template.pageOrientation === 'landscape' });
    db.update(entity.key, entity.pk, req.params.id, { __pdfGeneratedAt: new Date().toISOString(), __pdfTemplateKey: template.key });
  } catch (e) {
    return res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent('PDF generation failed: ' + e.message));
  }
  res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}?notice=` + encodeURIComponent('PDF generated.'));
});

app.get('/:entity/:id/pdf', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  if (!billPdf.pdfExists(entity.key, req.params.id)) return res.status(404).send('No PDF has been generated for this record yet.');
  res.sendFile(billPdf.pdfPathFor(entity.key, req.params.id));
});

// DELETE
app.post('/:entity/:id/delete', requireEntity, auth.requirePermission('delete'), (req, res) => {
  const entity = req.entity;
  const before = db.getById(entity.key, entity.pk, req.params.id);
  // Block the delete if any actual row in another table still references
  // this specific record via a lookup field — otherwise that row is left
  // with a dangling reference, surfacing later as a #REF-style error or a
  // blank value rather than at delete time. Direct children only (see
  // findBlockingReferences) — sufficient on its own since this same check
  // applies uniformly at every delete, so a grandchild can never be
  // silently orphaned either.
  if (before) {
    const blockers = schemaLib.findBlockingReferences(req.schema, entity.key, before[entity.pk]);
    if (blockers.length > 0) {
      const detail = blockers.map(b => `${b.count} ${b.entityLabel} record(s)`).join(', ');
      const message = `Cannot delete: ${detail} still reference this ${entity.singular} \u2014 remove or reassign those first.`;
      return res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(message)}`);
    }
  }
  // Soft delete — recoverable via Admin -> Trash for 30 days (or a
  // scheduled purge/explicit "Delete Forever" after that), rather than
  // permanently gone the instant Delete is clicked. Image files are
  // deliberately NOT cleaned up here — only at actual purge time, since
  // a soft-deleted record might still be restored, and its image should
  // still be there if it is.
  db.softDelete(entity.key, entity.pk, req.params.id, req.currentUser.username);
  if (entity.auditEnabled && before) {
    audit.log({ entityKey: entity.key, recordId: req.params.id, action: 'delete', username: req.currentUser.username, before, after: null });
  }
  res.redirect(`/${entity.key}`);
});

// Authenticated image serving. The URL is unguessable (random filename) but
// we also require read permission on the entity — so a signature image
// can't be scraped by a user with no rights to that landlord record.
app.get('/uploads/:entity/:field/:filename', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  const field = entity.fields.find(f => f.name === req.params.field && (f.type === 'image' || f.type === 'file'));
  if (!field) return res.status(404).send('Not found.');
  // Refuse any path-traversal shenanigans in the filename before touching the FS.
  if (!/^[a-zA-Z0-9._-]+$/.test(req.params.filename) || req.params.filename.includes('..')) {
    return res.status(400).send('Bad filename.');
  }
  const filepath = path.join(UPLOADS_DIR, entity.key, field.name, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found.');
  if (field.type === 'file') {
    // Generic file uploads have no magic-bytes validation (unlike images,
    // which are verified against their real content) — the extension is
    // whatever the uploader's original filename claimed. Two safeguards:
    // never serve a dangerous extension at all, and even for an allowed
    // one, force a download instead of letting the browser render it
    // inline — closes the stored-XSS-via-upload path regardless of what
    // Content-Type auto-detection would otherwise have picked.
    const ext = path.extname(req.params.filename).toLowerCase();
    if (DANGEROUS_UPLOAD_EXTENSIONS.has(ext)) {
      return res.status(403).send('This file type cannot be served for security reasons.');
    }
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  res.sendFile(filepath);
});

// Global error handler: any exception thrown by a route or middleware ends
// up here. We record it to the rolling error log for later inspection in
// Admin → Errors, then return a plain 500 so the user knows something
// broke rather than seeing a hung or blank page.
app.use((err, req, res, next) => {
  errorlog.record({
    method: req && req.method,
    url: req && req.originalUrl,
    user: req && req.currentUser && req.currentUser.username,
    err,
  });
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong on the server. This error has been logged to Admin → Errors for review.');
});

app.listen(PORT, () => {
  console.log(`Muneesh Legacy running on port ${PORT}`);
  scheduledBackup.start();
  notify.start();
  db.runWithRequestCache(() => {
    if (bills.ensureBillsTables()) console.log('Bills: created expense_items / expense_entries tables.');
    if (remindersMod.ensureReminderTables()) console.log('Reminders: created reminders / reminder_log tables.');
    if (notify.ensureNotificationTables()) console.log('Notifications: created notification_log table and default settings (all sources off).');
    if (emailMod.ensureEmailTables()) console.log('Email: created email_log table.');
    { const purged = emailMod.purgeOldLogs(schemaLib.load()); if (purged) console.log(`Email: purged ${purged} old email_log rows.`); }
    if (tax.ensureTaxTables()) console.log('Tax: created tax_worksheets / tax_payments / tax_slabs / tax_config tables (rates seeded — verify with your auditor).');
    if (gsttds.ensureGstTdsTables()) console.log('GST TDS: created GST TDS Returns table + Invoices fields (generic to any number of TDS-deducting tenants).');
    // Runs every boot, not just once — fixes a duplicate the one-time
    // sidebarGroups migration itself could bake in (see the function's
    // own comment in schema.js) on any install that already migrated
    // before this existed.
    const schema = schemaLib.load();
    if (schemaLib.dedupeSidebarItemsWithinGroups(schema)) {
      schemaLib.persist(schema);
      console.log('Sidebar: removed a duplicate item baked in by an earlier migration.');
    }
    if (homeMod.ensureHomeWidgetsMigrated(schema)) {
      schemaLib.persist(schema);
      console.log('Home Screen: added the default Due Soon widget.');
    }
  });
  trashPurge.start();
});
