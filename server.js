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
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 2299;

if (!process.env.SESSION_SECRET) {
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

app.post('/login', (req, res) => {
  const rateLimit = checkLoginRateLimit(req.body.username);
  if (rateLimit.blocked) {
    const msg = `Too many failed attempts. Try again in about ${rateLimit.minutesLeft} minute(s).`;
    return res.redirect('/login?error=' + encodeURIComponent(msg) + '&next=' + encodeURIComponent(req.body.next || ''));
  }
  const user = usersLib.verifyPassword(req.body.username, req.body.password);
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

app.post('/account/password', (req, res) => {
  try {
    if (!usersLib.verifyPassword(req.currentUser.username, req.body.currentPassword)) {
      throw new Error('Current password is incorrect.');
    }
    if (req.body.newPassword !== req.body.confirmPassword) {
      throw new Error('New password and confirmation do not match.');
    }
    usersLib.changeOwnPassword(req.currentUser.id, req.body.newPassword);
    res.redirect('/account?notice=' + encodeURIComponent('Password updated.'));
  } catch (err) {
    res.redirect('/account?error=' + encodeURIComponent(err.message));
  }
});

// ---- helpers ---------------------------------------------------------------

function getFkOptions(schema, field) {
  const refEntity = schema.entities[field.ref];
  if (!refEntity) return [];
  return db.getAll(refEntity.key).map(r => ({
    value: r[refEntity.pk],
    label: `${r[refEntity.pk]} \u2014 ${schemaLib.display(refEntity, r)}`,
  }));
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
function validateRequiredAndTypes(entity, record) {
  entity.fields.forEach(f => {
    if (f.type === 'formula' || f.type === 'series' || f.type === 'rollup' || f.type === 'spacer' || f.type === 'section' || f.type === 'image') return;
    if (f.key && f.auto) return; // auto-numbered primary key — legitimately blank until assigned after this validation runs, not something the form ever supplies
    const val = record[f.name];
    if ((f.type === 'number' || f.type === 'currency' || f.type === 'percent') && val !== '' && typeof val === 'number' && isNaN(val)) {
      throw new Error(`"${f.label}" needs a real number \u2014 the value given isn't one.`);
    }
    if (f.required) {
      if (f.type === 'bool') return; // a checkbox's "required" doesn't mean "must be checked" here — false is a valid, complete value
      const isBlank = val === '' || val === undefined || val === null;
      if (isBlank) throw new Error(`"${f.label}" is required.`);
    }
  });
}

// Persists uploaded image files under data/uploads/<entity>/<field>/ and
// returns the filename that should be stored in the record. Prior file (if
// being replaced) is removed to avoid orphans piling up.
function persistUploadedImages(entity, files, record, priorRecord) {
  entity.fields.filter(f => f.type === 'image').forEach(f => {
    const uploaded = (files && files[`img_${f.name}`] && files[`img_${f.name}`][0]) || null;
    if (uploaded) {
      // Verify the file's REAL type from its actual bytes — never trust
      // the client-supplied mimetype or originalname's extension, since
      // both are attacker-controlled and this is exactly the gap a
      // stored-XSS attempt would exploit (upload something claiming to
      // be an image but actually HTML/script, served later with a
      // Content-Type derived from that same untrusted input).
      const ext = detectRealImageExtension(uploaded.buffer);
      if (!ext) {
        throw new Error(`"${uploaded.originalname}" doesn't look like a genuine image file (JPG/PNG/GIF/WEBP) — the upload was rejected.`);
      }
      const dir = path.join(UPLOADS_DIR, entity.key, f.name);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
function applySort(entity, rows) {
  if (!entity.sortField) return rows;
  const dir = entity.sortDir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = a[entity.sortField], bv = b[entity.sortField];
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
app.get('/screens/:screenKey', (req, res) => {
  const schema = req.schema;
  const screen = schemaLib.screenByKey(schema, req.params.screenKey);
  if (!screen) return res.status(404).send('Unknown screen.');
  const viewRefs = (screen.views || []).slice().sort((a, b) => a.position - b.position);
  const viewList = viewRefs.map(v => schemaLib.viewByKey(schema, v.viewKey)).filter(Boolean);

  if (viewList.length === 0) {
    return res.render('screen', { screen, viewList: [], activeViewKey: null, appletBlocks: [], activeKey: 'screen:' + screen.key, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue });
  }
  const activeViewKey = viewList.some(v => v.key === req.query.view) ? req.query.view : viewList[0].key;
  const activeView = viewList.find(v => v.key === activeViewKey);

  const selections = {};
  Object.keys(req.query).forEach(k => {
    if (k.startsWith('selected_') && req.query[k]) selections[k.slice('selected_'.length)] = req.query[k];
  });

  const instances = (activeView.applets || []).slice().sort((a, b) => a.position - b.position);
  const appletBlocks = instances.map(instance => {
    const applet = schemaLib.appletByKey(schema, instance.appletKey);
    if (!applet) return { instance, applet: null, error: 'This applet no longer exists.' };
    if (applet.type !== 'list') {
      // Detail-type applet rendering isn't wired up in this build — the
      // confirmed, tested use case is List+List (a parent list with a
      // reactively-filtered child list), not List+Detail. Said plainly
      // here rather than half-rendering something unverified.
      return { instance, applet, notSupported: true };
    }
    const entity = schema.entities[applet.baseTable];
    const rows = computeAppletInstanceRows(schema, applet, instance, selections);
    const columns = (applet.columns || []).map(name => entity.fields.find(f => f.name === name)).filter(Boolean);
    const selectedValue = selections[instance.instanceKey] || null;
    function selectUrl(pkValue) {
      const params = new URLSearchParams();
      params.set('view', activeViewKey);
      Object.keys(selections).forEach(k => { if (k !== instance.instanceKey) params.set('selected_' + k, selections[k]); });
      params.set('selected_' + instance.instanceKey, pkValue);
      return `/screens/${screen.key}?${params.toString()}`;
    }
    return { instance, applet, entity, columns, rows, selectUrl, selectedValue, needsParentSelection: rows === null };
  });

  res.render('screen', { screen, viewList, activeViewKey, appletBlocks, activeKey: 'screen:' + screen.key, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue });
});

app.get('/', (req, res) => {
  res.render('landing', { activeKey: '' });
});

// Reports: on-demand summaries built from admin-defined report configs,
// not a table of its own. Mounted here, before the generic /:entity
// routes below, because "/reports" is a single path segment and would
// otherwise be swallowed by the LIST route (which would try to treat
// "reports" as a table name and 404) — this bit us once already.
app.use(reports.router);

// LIST view (Siebel "List Applet")
app.get('/:entity', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  let rows = db.getAll(entity.key).map(r => schemaLib.withComputedFields(req.schema, entity, r));
  const q = (req.query.q || '').trim().toLowerCase();
  const listFields = schemaLib.listFieldsFor(entity);
  const filterFields = schemaLib.filterFieldsFor(entity);

  if (q) {
    rows = rows.filter(r =>
      listFields.some(f => String(r[f.name] ?? '').toLowerCase().includes(q))
    );
  }

  // Generic filters: control type depends on the field's filter "kind"
  // (schemaLib.filterKindFor) — bool/picklist/fk/text/textarea = exact-match,
  // date = from/to range, number/currency/percent = from/to range,
  // formula/rollup = whichever of the above matches their own Format As.
  // Each stacks with AND, and with the Query search above — plain GET
  // query params, so nothing is saved: leaving the screen and coming back
  // starts fresh.
  const filterValues = {};
  let filtersActive = false;
  filterFields.forEach(f => {
    const kind = schemaLib.filterKindFor(f);
    const isPercent = f.type === 'percent' || f.format === 'percent';
    if (kind === 'date-range' || kind === 'number-range') {
      const from = (req.query[`f_${f.name}_from`] || '').trim();
      const to = (req.query[`f_${f.name}_to`] || '').trim();
      filterValues[f.name] = { from, to };
      if (from || to) {
        filtersActive = true;
        rows = schemaLib.applyFilterCondition(rows, kind, f.type, isPercent, { from, to }, r => r[f.name]);
      }
    } else {
      const val = req.query[`f_${f.name}`];
      filterValues[f.name] = val || '';
      if (val !== undefined && val !== '') {
        filtersActive = true;
        rows = schemaLib.applyFilterCondition(rows, kind, f.type, isPercent, { value: val }, r => r[f.name]);
      }
    }
  });

  rows = applySort(entity, rows);

  const fkFilterOptions = {};
  filterFields.filter(f => f.type === 'fk').forEach(f => { fkFilterOptions[f.name] = getFkOptions(req.schema, f); });

  res.render('list', {
    entity, rows, q: req.query.q || '', activeKey: entity.key, listFields,
    filterFields, filterValues, filtersActive, fkFilterOptions, picklistOptions: schemaLib.picklistOptions, filterKindFor: schemaLib.filterKindFor,
    display: schemaLib.display, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    listTitle: schemaLib.listTitle(entity),
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
  const fkOptions = {};
  entity.fields.filter(f => f.type === 'fk').forEach(f => { fkOptions[f.name] = getFkOptions(req.schema, f); });

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

  res.render('form', {
    entity, record: emptyRecord, isNew: true, fkOptions, children: [], activeKey: entity.key,
    display: schemaLib.display, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    picklistOptions: schemaLib.picklistOptions, detailTitle: schemaLib.detailTitle(entity), renderHintHtml: schemaLib.renderHintHtml,
    picklistFieldData: getPicklistFieldData(req.schema, entity, emptyRecord),
    auditEntries: [], canUpdate: true, canDelete: false, payqrConfig, error: req.query.error,
  });
});

// PayQR: narration preview + QR generation. Extracted into payqr.js — see
// that file for why (hardcoded field names, isolated for locatability).
app.use(payqr.router);

// DETAIL / EDIT form
app.get('/:entity/:id', requireEntity, auth.requirePermission('read'), (req, res) => {
  const entity = req.entity;
  const rawRecord = db.getById(entity.key, entity.pk, req.params.id);
  if (!rawRecord) return res.status(404).send(`${entity.singular} "${req.params.id}" not found.`);
  const record = schemaLib.withComputedFields(req.schema, entity, rawRecord);

  const fkOptions = {};
  entity.fields.filter(f => f.type === 'fk').forEach(f => { fkOptions[f.name] = getFkOptions(req.schema, f); });

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
    display: schemaLib.display, formatINR: schemaLib.formatINR, formatPercent: schemaLib.formatPercent, formatDate: schemaLib.formatDate, formatFormulaValue: schemaLib.formatFormulaValue,
    picklistOptions: schemaLib.picklistOptions, detailTitle: schemaLib.detailTitle(entity), renderHintHtml: schemaLib.renderHintHtml,
    picklistFieldData: getPicklistFieldData(req.schema, entity, record),
    auditEntries, payqrConfig: getPayqrConfigFor(entity, req.schema), prevPk, nextPk, error: req.query.error, ...perms(entity, req.currentUser),
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
  const spec = imageFields.map(f => ({ name: `img_${f.name}`, maxCount: 1 }));
  uploadImage.fields(spec)(req, res, (err) => {
    if (err) {
      const back = req.params.id ? `/${entity.key}/${encodeURIComponent(req.params.id)}` : `/${entity.key}/new/form`;
      return res.redirect(back + '?error=' + encodeURIComponent(err.message));
    }
    next();
  });
}

// CREATE
app.post('/:entity', requireEntity, auth.requirePermission('create'), imageUploadMiddleware, (req, res) => {
  const entity = req.entity;
  const record = coerceBody(req.schema, entity, req.body, req.files, null);
  try {
    validateRequiredAndTypes(entity, record);
    persistUploadedImages(entity, req.files, record, null);
  } catch (e) {
    return res.redirect(`/${entity.key}/new/form?error=` + encodeURIComponent(e.message));
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

// UPDATE
app.post('/:entity/:id', requireEntity, auth.requirePermission('update'), imageUploadMiddleware, (req, res) => {
  const entity = req.entity;
  const before = db.getById(entity.key, entity.pk, req.params.id);
  if (!before) return res.status(404).send(`${entity.singular} "${req.params.id}" not found.`);
  const record = coerceBody(req.schema, entity, req.body, req.files, before);
  try {
    validateRequiredAndTypes(entity, record);
    persistUploadedImages(entity, req.files, record, before);
  } catch (e) {
    return res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}?error=` + encodeURIComponent(e.message));
  }
  record[entity.pk] = before[entity.pk]; // identity is immutable via this form, regardless of body contents
  db.update(entity.key, entity.pk, req.params.id, record);
  if (entity.auditEnabled) {
    audit.log({ entityKey: entity.key, recordId: req.params.id, action: 'update', username: req.currentUser.username, before, after: { ...before, ...record } });
  }
  res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}`);
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
  db.remove(entity.key, entity.pk, req.params.id);
  // Clean up any image files owned by this record so they don't orphan on disk.
  if (before) {
    entity.fields.filter(f => f.type === 'image').forEach(f => {
      if (before[f.name]) {
        const p = path.join(UPLOADS_DIR, entity.key, f.name, before[f.name]);
        if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) { /* best-effort */ }
      }
    });
  }
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
  const field = entity.fields.find(f => f.name === req.params.field && f.type === 'image');
  if (!field) return res.status(404).send('Not found.');
  // Refuse any path-traversal shenanigans in the filename before touching the FS.
  if (!/^[a-zA-Z0-9._-]+$/.test(req.params.filename) || req.params.filename.includes('..')) {
    return res.status(400).send('Bad filename.');
  }
  const filepath = path.join(UPLOADS_DIR, entity.key, field.name, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found.');
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
});
