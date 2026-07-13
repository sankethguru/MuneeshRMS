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

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB — signatures/logos, not photo albums
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported image type: ${file.mimetype}. Accepted: JPG, PNG, GIF, WEBP, SVG.`));
  },
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(morgan('dev'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'muneesh-legacy-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true, // reset expiry on every request — see the dynamic maxAge middleware below for the "N minutes of inactivity" behavior
  cookie: { maxAge: 1000 * 60 * 30 }, // fallback default; overridden per-request once the schema (and its admin-configured timeout) is loaded
}));

app.use(auth.loadCurrentUser);

// ---- login / logout (no login required) -----------------------------------

app.get('/login', (req, res) => {
  if (req.currentUser) return res.redirect('/');
  res.render('login', { error: req.query.error, nextUrl: req.query.next || '' });
});

app.post('/login', (req, res) => {
  const user = usersLib.verifyPassword(req.body.username, req.body.password);
  if (!user) {
    return res.redirect('/login?error=' + encodeURIComponent('Incorrect username or password.') + '&next=' + encodeURIComponent(req.body.next || ''));
  }
  req.session.userId = user.id;
  res.redirect(req.body.next && req.body.next.startsWith('/') ? req.body.next : '/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Everything below requires login.
app.use(auth.requireLogin);

// Wrap each authenticated request in a db read cache so cross-table
// formula/rollup lookups don't re-read data/db.json on every hop.
// Measured impact: /bills was averaging ~2.5s on ~100 records; this drops
// it to a few hundred ms without changing storage.
app.use((req, res, next) => {
  db.beginRequest();
  res.on('finish', () => db.endRequest());
  res.on('close', () => db.endRequest());
  next();
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

function coerceBody(entity, body, files, existingRecord) {
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

// Persists uploaded image files under data/uploads/<entity>/<field>/ and
// returns the filename that should be stored in the record. Prior file (if
// being replaced) is removed to avoid orphans piling up.
function persistUploadedImages(entity, files, record, priorRecord) {
  entity.fields.filter(f => f.type === 'image').forEach(f => {
    const uploaded = (files && files[`img_${f.name}`] && files[`img_${f.name}`][0]) || null;
    if (uploaded) {
      const dir = path.join(UPLOADS_DIR, entity.key, f.name);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ext = (path.extname(uploaded.originalname) || '.bin').toLowerCase().replace(/[^a-z0-9.]/g, '');
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
    if (kind === 'date-range') {
      const from = (req.query[`f_${f.name}_from`] || '').trim();
      const to = (req.query[`f_${f.name}_to`] || '').trim();
      filterValues[f.name] = { from, to };
      if (from || to) {
        filtersActive = true;
        rows = rows.filter(r => {
          const v = r[f.name];
          if (!v) return false;
          if (from && v < from) return false;
          if (to && v > to) return false;
          return true;
        });
      }
    } else if (kind === 'number-range') {
      const from = (req.query[`f_${f.name}_from`] || '').trim();
      const to = (req.query[`f_${f.name}_to`] || '').trim();
      filterValues[f.name] = { from, to };
      if (from || to) {
        filtersActive = true;
        // Percent fields (and formula/rollup fields formatted as percent) are
        // stored as raw fractions (0.18) but entered/displayed as whole
        // numbers (18) everywhere else in the app — scale for comparison so
        // the filter box matches that same convention.
        const isPercent = f.type === 'percent' || f.format === 'percent';
        const scale = isPercent ? 100 : 1;
        rows = rows.filter(r => {
          const n = Number(r[f.name]);
          if (isNaN(n)) return false;
          const displayVal = n * scale;
          if (from !== '' && displayVal < Number(from)) return false;
          if (to !== '' && displayVal > Number(to)) return false;
          return true;
        });
      }
    } else {
      const val = req.query[`f_${f.name}`];
      filterValues[f.name] = val || '';
      if (val !== undefined && val !== '') {
        filtersActive = true;
        if (f.type === 'bool') {
          const want = val === 'true';
          rows = rows.filter(r => !!r[f.name] === want);
        } else {
          rows = rows.filter(r => String(r[f.name] ?? '') === val);
        }
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
    picklistOptions: schemaLib.picklistOptions, detailTitle: schemaLib.detailTitle(entity),
    auditEntries: [], canUpdate: true, canDelete: false, payqrConfig,
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
    picklistOptions: schemaLib.picklistOptions, detailTitle: schemaLib.detailTitle(entity),
    auditEntries, payqrConfig: getPayqrConfigFor(entity, req.schema), prevPk, nextPk, ...perms(entity, req.currentUser),
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
  const record = coerceBody(entity, req.body, req.files, null);
  persistUploadedImages(entity, req.files, record, null);
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
  const record = coerceBody(entity, req.body, req.files, before);
  persistUploadedImages(entity, req.files, record, before);
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
