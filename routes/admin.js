// routes/admin.js
// "Application Administration" screen: create/edit/reorder tables and
// fields, manage users & permissions, without touching code.
// This whole router is mounted behind auth.requireAdmin in server.js.

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const schemaLib = require('../schema');
const { atomicWriteFileSync } = require('../fsutil');
const db = require('../db');
const usersLib = require('../users');
const audit = require('../audit');
const errorlog = require('../errorlog');
const csv = require('../csv');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SCHEMA_FILE = path.join(DATA_DIR, 'schema.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
// Backups can be larger (images add up); allow 100 MB.
const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function uploadCsvMiddleware(req, res, next) {
  upload.single('csvfile')(req, res, (err) => {
    if (err) return res.redirect(`/admin/${req.params.entity}/import?error=` + encodeURIComponent('Upload failed: ' + err.message));
    next();
  });
}

function uploadBackupMiddleware(req, res, next) {
  uploadBackup.single('backupfile')(req, res, (err) => {
    if (err) return res.redirect('/admin/backup?error=' + encodeURIComponent('Upload failed: ' + err.message));
    next();
  });
}

router.use((req, res, next) => {
  // server.js's own global middleware already loads the schema fresh for
  // every request before any route (including this router) is reached —
  // reloading it again here was pure waste, not a correctness issue,
  // since both loads would always see the same on-disk state within one
  // request. Falls back to a fresh load only if req.schema somehow isn't
  // already set (e.g. this router used standalone in some other context).
  req.schema = req.schema || schemaLib.load();
  res.locals.navOrder = req.schema.navOrder;
  res.locals.entities = req.schema.entities;
  res.locals.activeKey = 'admin';
  res.locals.adminSubnavOrder = req.schema.adminSubnavOrder;
  res.locals.adminSubnavFixedPages = schemaLib.ADMIN_SUBNAV_FIXED_PAGES;
  next();
});

// ---- whole-DB backup / restore -------------------------------------------
// Snapshot everything the app depends on into a single ZIP:
//   schema.json  (table/field definitions)
//   db.json      (all record data)
//   users.json   (accounts and permissions)
//   uploads/**   (image files referenced by records)
// Restore replaces all four in one atomic-looking swap (writes are
// sequential, but the entire archive is validated first, and existing
// state is preserved to a timestamped .bak so a bad restore is recoverable).

router.get('/backup', (req, res) => {
  res.render('admin/backup', { error: req.query.error, notice: req.query.notice });
});

// ---- errors: recent server crashes ---------------------------------------

router.get('/errors', (req, res) => {
  res.render('admin/errors', { entries: errorlog.recent(100), notice: req.query.notice });
});

router.post('/errors/clear', (req, res) => {
  errorlog.clearAll();
  res.redirect('/admin/errors?notice=' + encodeURIComponent('Error log cleared.'));
});

// ---- PayQR field-role settings --------------------------------------------
// Which field on Payees/Payments plays each role PayQR's QR generation and
// narration logic needs. See payqr.js and schema.js (PAYQR_FIELD_ROLES) for
// the full rationale — this page exists so those role mappings are editable
// without a code change if the tables are ever restructured.

router.get('/payqr-settings', (req, res) => {
  const schema = req.schema;
  const payeesEntity = schema.entities.payees;
  const paymentsEntity = schema.entities.payments;
  const settings = schema.payqrSettings || {};
  const roleFields = {};
  Object.keys(schemaLib.PAYQR_FIELD_ROLES).forEach(key => {
    const role = schemaLib.PAYQR_FIELD_ROLES[key];
    const entity = schema.entities[role.entity];
    roleFields[key] = { ...role, options: schemaLib.payqrEligibleFields(entity, key) };
  });
  const payeePk = schemaLib.payqrPayeePkField(schema);
  const paymentFk = schemaLib.payqrPaymentToPayeeFkField(schema);
  res.render('admin/payqr-settings', {
    payeesEntity, paymentsEntity, settings, roleFields, payeePk, paymentFk,
    error: req.query.error, notice: req.query.notice,
  });
});

router.post('/payqr-settings', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updatePayqrSettings(schema, req.body);
    schemaLib.persist(schema);
    res.redirect('/admin/payqr-settings?notice=' + encodeURIComponent('PayQR settings saved.'));
  } catch (err) {
    res.redirect('/admin/payqr-settings?error=' + encodeURIComponent(err.message));
  }
});

// ---- Formula language help --------------------------------------------
// Pure static documentation, no data dependency — just explains the
// syntax available inside formula/rollup/report expressions.

router.get('/help', (req, res) => {
  res.render('admin/help', {});
});

// ---- Getting Started / Journey ------------------------------------------
// A narrative, story-style walkthrough of actually using the app end to
// end — as opposed to /help above, which is a function-by-function
// formula reference. This is the thing meant to let a brand-new user run
// the whole app without the person who built it ever having to explain
// anything in person. STANDING INSTRUCTION: revisit and update this
// whenever a meaningfully new feature ships, the same way README.md gets
// kept current for developers — this is that same habit, aimed at an
// actual end user instead.

router.get('/journey', (req, res) => {
  res.render('admin/journey', {});
});

// ---- Idle session timeout settings ----------------------------------------

router.get('/session-settings', (req, res) => {
  res.render('admin/session-settings', {
    minutes: req.schema.sessionTimeoutMinutes,
    min: schemaLib.SESSION_TIMEOUT_MIN,
    max: schemaLib.SESSION_TIMEOUT_MAX,
    error: req.query.error, notice: req.query.notice,
  });
});

router.post('/session-settings', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updateSessionTimeout(schema, req.body.minutes);
    schemaLib.persist(schema);
    res.redirect('/admin/session-settings?notice=' + encodeURIComponent('Session timeout saved. Takes effect immediately for new requests — no restart needed.'));
  } catch (err) {
    res.redirect('/admin/session-settings?error=' + encodeURIComponent(err.message));
  }
});

// ---- Report builder --------------------------------------------------
// Reports are DATA (schema.json), not code — see schema.js's report-
// building section for the full rationale. This is the admin CRUD for
// that data: pick a base table, define columns (or a group-by +
// aggregates), an optional condition, and optional run-time parameters.

function reportFormArrays(body) {
  // Reconstructs the repeatable-row sections (columns/parameters/
  // aggregates) from parallel bracket-array form fields, e.g.
  // col_expr[]=A&col_expr[]=B&col_label[]=X&col_label[]=Y. Rows where the
  // primary field is blank are dropped — that's how "3 blank spare rows"
  // in the form become "user didn't fill this one in," with no JS needed
  // to add/remove rows client-side.
  const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
  const colExpr = arr(body.col_expr), colLabel = arr(body.col_label), colFormat = arr(body.col_format), colTotal = arr(body.col_total);
  const columns = colExpr.map((expr, i) => ({ expr, label: colLabel[i] || '', format: colFormat[i] || 'none', total: colTotal[i] === '1' }));

  const paramKey = arr(body.param_key), paramLabel = arr(body.param_label), paramField = arr(body.param_field), paramDataKind = arr(body.param_datakind), paramAnchorTable = arr(body.param_anchortable), paramAnchorResolver = arr(body.param_anchorresolver);
  const parameters = paramField.map((field, i) => ({ key: paramKey[i] || '', label: paramLabel[i] || '', field, dataKind: paramDataKind[i] || '', anchorTable: paramAnchorTable[i] || '', anchorResolver: paramAnchorResolver[i] || '' }));

  const aggExpr = arr(body.agg_expr), aggFn = arr(body.agg_fn), aggLabel = arr(body.agg_label), aggFormat = arr(body.agg_format), aggTotal = arr(body.agg_total);
  const aggregates = aggExpr.map((expr, i) => ({ expr, fn: aggFn[i] || 'SUM', label: aggLabel[i] || '', format: aggFormat[i] || 'none', total: aggTotal[i] === '1' }));

  const hdrExpr = arr(body.hdr_expr), hdrLabel = arr(body.hdr_label), hdrRenderType = arr(body.hdr_rendertype),
        hdrRows = arr(body.hdr_rows), hdrFormat = arr(body.hdr_format), hdrColumn = arr(body.hdr_column);
  const headerFields = hdrExpr.map((expr, i) => ({
    expr, label: hdrLabel[i] || '', renderType: hdrRenderType[i] || 'text',
    rows: hdrRows[i] || '', format: hdrFormat[i] || 'none', column: hdrColumn[i] || 'left',
  }));

  return { columns, parameters, aggregates, headerFields };
}

router.get('/reports', (req, res) => {
  res.render('admin/reports', { reportDefs: schemaLib.reportDefsFor(req.schema), notice: req.query.notice, error: req.query.error });
});

router.get('/reports/new', (req, res) => {
  res.render('admin/report-edit', {
    def: null, entities: req.schema.entities, error: req.query.error,
  });
});

router.post('/reports', (req, res) => {
  const schema = req.schema;
  try {
    const { columns, parameters, aggregates, headerFields } = reportFormArrays(req.body);
    const def = schemaLib.addReportDef(schema, { ...req.body, columns, parameters, aggregates, headerFields });
    schemaLib.persist(schema);
    res.redirect('/admin/reports?notice=' + encodeURIComponent(`"${def.label}" created.`));
  } catch (err) {
    res.redirect('/admin/reports/new?error=' + encodeURIComponent(err.message));
  }
});

router.get('/reports/:key/edit', (req, res) => {
  const def = schemaLib.reportDefByKey(req.schema, req.params.key);
  if (!def) return res.status(404).send('Unknown report.');
  res.render('admin/report-edit', { def, entities: req.schema.entities, error: req.query.error });
});

router.post('/reports/:key', (req, res) => {
  const schema = req.schema;
  try {
    const { columns, parameters, aggregates, headerFields } = reportFormArrays(req.body);
    const def = schemaLib.updateReportDef(schema, req.params.key, { ...req.body, columns, parameters, aggregates, headerFields });
    schemaLib.persist(schema);
    res.redirect('/admin/reports?notice=' + encodeURIComponent(`"${def.label}" saved.`));
  } catch (err) {
    res.redirect(`/admin/reports/${req.params.key}/edit?error=` + encodeURIComponent(err.message));
  }
});

router.post('/reports/:key/delete', (req, res) => {
  const schema = req.schema;
  schemaLib.deleteReportDef(schema, req.params.key);
  schemaLib.persist(schema);
  res.redirect('/admin/reports?notice=' + encodeURIComponent('Report deleted.'));
});

router.post('/reports/:key/duplicate', (req, res) => {
  const schema = req.schema;
  try {
    const copy = schemaLib.duplicateReportDef(schema, req.params.key);
    schemaLib.persist(schema);
    res.redirect(`/admin/reports/${copy.key}/edit`);
  } catch (err) {
    res.redirect('/admin/reports?error=' + encodeURIComponent(err.message));
  }
});

// ---- Applets (Applet / View / Screen, stage 2) -------------------------
// An Applet is created minimally first (label, type, base table), then
// edited — same two-step convention Reports already uses for baseTable,
// since the columns/filter/sort config below genuinely needs the base
// table to already be fixed and known (real checkboxes/dropdowns against
// its actual fields, not a client-side reload as the table changes).

router.get('/applets', (req, res) => {
  res.render('admin/applets', { applets: schemaLib.appletsFor(req.schema), notice: req.query.notice, error: req.query.error });
});

router.get('/applets/new', (req, res) => {
  res.render('admin/applet-edit', { applet: null, entities: req.schema.entities, error: req.query.error, notice: req.query.notice });
});

router.post('/applets', (req, res) => {
  const schema = req.schema;
  try {
    const applet = schemaLib.addApplet(schema, req.body);
    schemaLib.persist(schema);
    res.redirect(`/admin/applets/${applet.key}/edit?notice=` + encodeURIComponent(`"${applet.label}" created \u2014 now set up its columns/filter below.`));
  } catch (err) {
    res.redirect('/admin/applets/new?error=' + encodeURIComponent(err.message));
  }
});

router.get('/applets/:key/edit', (req, res) => {
  const applet = schemaLib.appletByKey(req.schema, req.params.key);
  if (!applet) return res.status(404).send('Unknown applet.');
  res.render('admin/applet-edit', { applet, entities: req.schema.entities, error: req.query.error, notice: req.query.notice });
});

router.post('/applets/:key', (req, res) => {
  const schema = req.schema;
  try {
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const applet = schemaLib.updateApplet(schema, req.params.key, { ...req.body, columns: arr(req.body.columns) });
    schemaLib.persist(schema);
    res.redirect('/admin/applets?notice=' + encodeURIComponent(`"${applet.label}" saved.`));
  } catch (err) {
    res.redirect(`/admin/applets/${req.params.key}/edit?error=` + encodeURIComponent(err.message));
  }
});

router.post('/applets/:key/delete', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.deleteApplet(schema, req.params.key);
    schemaLib.persist(schema);
    res.redirect('/admin/applets?notice=' + encodeURIComponent('Applet deleted.'));
  } catch (err) {
    res.redirect('/admin/applets?error=' + encodeURIComponent(err.message));
  }
});

// ---- Views (Applet / View / Screen, stage 3) ----------------------------
// A View is an ordered list of Applet *instances*. The tricky UI bit:
// letting the admin say "this row's parent is that row", when rows have
// no stable identity until saved (same situation Report Columns already
// live with — a fresh row is just blank inputs). Solved the same way:
// the admin references a parent by its 1-based ROW POSITION in the form
// ("Row 1", "Row 2", ...) rather than some opaque instance key, and the
// server translates position -> the actual instanceKey it assigns (by
// array order, every save) before handing off to validateView.

function viewFormApplets(body) {
  const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
  const appletKeys = arr(body.applet_key);
  const parentPositions = arr(body.parent_position); // 1-based strings, or ''
  const linkFields = arr(body.link_field);
  const rows = appletKeys
    .map((appletKey, i) => ({ appletKey, parentPosition: parentPositions[i], linkField: linkFields[i] }))
    .filter(r => r.appletKey && r.appletKey.trim());
  const instanceKeys = rows.map((r, i) => `inst${i}`);
  return rows.map((r, i) => {
    let parentInstanceKey = null;
    if (r.parentPosition && r.parentPosition.trim()) {
      const parentIdx = parseInt(r.parentPosition, 10) - 1;
      if (isNaN(parentIdx) || parentIdx < 0 || parentIdx >= instanceKeys.length) {
        throw new Error(`Row ${i + 1}: "Row ${r.parentPosition}" as a parent doesn't refer to a row that actually exists here.`);
      }
      if (parentIdx === i) {
        throw new Error(`Row ${i + 1}: can't be its own parent.`);
      }
      parentInstanceKey = instanceKeys[parentIdx];
    }
    return { instanceKey: instanceKeys[i], appletKey: r.appletKey, parentInstanceKey, linkField: r.linkField || '' };
  });
}

router.get('/composed-views', (req, res) => {
  res.render('admin/views-list', { views: schemaLib.viewsFor(req.schema), applets: schemaLib.appletsFor(req.schema), notice: req.query.notice, error: req.query.error });
});

router.get('/composed-views/new', (req, res) => {
  res.render('admin/view-edit', { view: null, applets: schemaLib.appletsFor(req.schema), entities: req.schema.entities, error: req.query.error, notice: req.query.notice });
});

router.post('/composed-views', (req, res) => {
  const schema = req.schema;
  try {
    const applets = viewFormApplets(req.body);
    const view = schemaLib.addView(schema, { ...req.body, applets });
    schemaLib.persist(schema);
    res.redirect('/admin/composed-views?notice=' + encodeURIComponent(`"${view.label}" created.`));
  } catch (err) {
    res.redirect('/admin/composed-views/new?error=' + encodeURIComponent(err.message));
  }
});

router.get('/composed-views/:key/edit', (req, res) => {
  const view = schemaLib.viewByKey(req.schema, req.params.key);
  if (!view) return res.status(404).send('Unknown view.');
  res.render('admin/view-edit', { view, applets: schemaLib.appletsFor(req.schema), entities: req.schema.entities, error: req.query.error, notice: req.query.notice });
});

router.post('/composed-views/:key', (req, res) => {
  const schema = req.schema;
  try {
    const applets = viewFormApplets(req.body);
    const view = schemaLib.updateView(schema, req.params.key, { ...req.body, applets });
    schemaLib.persist(schema);
    res.redirect('/admin/composed-views?notice=' + encodeURIComponent(`"${view.label}" saved.`));
  } catch (err) {
    res.redirect(`/admin/composed-views/${req.params.key}/edit?error=` + encodeURIComponent(err.message));
  }
});

router.post('/composed-views/:key/delete', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.deleteView(schema, req.params.key);
    schemaLib.persist(schema);
    res.redirect('/admin/composed-views?notice=' + encodeURIComponent('View deleted.'));
  } catch (err) {
    res.redirect('/admin/composed-views?error=' + encodeURIComponent(err.message));
  }
});

// ---- Screens (Applet / View / Screen, stage 4) --------------------------
// A Screen is an ordered collection of Views, referenced by their real,
// stable key — unlike the View form's Parent Row, there's no position-
// reference hazard here, so drag-to-reorder is safe and used.

router.get('/screens', (req, res) => {
  res.render('admin/screens-list', { screens: schemaLib.screensFor(req.schema), views: schemaLib.viewsFor(req.schema), notice: req.query.notice, error: req.query.error });
});

router.get('/screens/new', (req, res) => {
  res.render('admin/screen-edit', { screen: null, views: schemaLib.viewsFor(req.schema), error: req.query.error, notice: req.query.notice });
});

router.post('/screens', (req, res) => {
  const schema = req.schema;
  try {
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const viewKeys = arr(req.body.view_key).filter(k => k && k.trim());
    const screen = schemaLib.addScreen(schema, { ...req.body, views: viewKeys.map(k => ({ viewKey: k })) });
    schemaLib.persist(schema);
    res.redirect('/admin/screens?notice=' + encodeURIComponent(`"${screen.label}" created.`));
  } catch (err) {
    res.redirect('/admin/screens/new?error=' + encodeURIComponent(err.message));
  }
});

router.get('/screens/:key/edit', (req, res) => {
  const screen = schemaLib.screenByKey(req.schema, req.params.key);
  if (!screen) return res.status(404).send('Unknown screen.');
  res.render('admin/screen-edit', { screen, views: schemaLib.viewsFor(req.schema), error: req.query.error, notice: req.query.notice });
});

router.post('/screens/:key', (req, res) => {
  const schema = req.schema;
  try {
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const viewKeys = arr(req.body.view_key).filter(k => k && k.trim());
    const screen = schemaLib.updateScreen(schema, req.params.key, { ...req.body, views: viewKeys.map(k => ({ viewKey: k })) });
    schemaLib.persist(schema);
    res.redirect('/admin/screens?notice=' + encodeURIComponent(`"${screen.label}" saved.`));
  } catch (err) {
    res.redirect(`/admin/screens/${req.params.key}/edit?error=` + encodeURIComponent(err.message));
  }
});

router.post('/screens/:key/delete', (req, res) => {
  const schema = req.schema;
  schemaLib.deleteScreen(schema, req.params.key);
  schemaLib.persist(schema);
  res.redirect('/admin/screens?notice=' + encodeURIComponent('Screen deleted.'));
});

// ---- Global Picklists ("List of Values") --------------------------------
// Two source shapes, handled by one form: static (admin-typed values,
// each individually deactivatable) and table (options pulled live from
// a real table's field, optionally constrained by a field on whichever
// record is using this picklist). See schema.js's validatePicklist/
// resolvePicklistOptions for the actual logic this configures.

router.get('/picklists', (req, res) => {
  res.render('admin/picklists', { picklists: schemaLib.picklistsFor(req.schema), notice: req.query.notice, error: req.query.error });
});

router.get('/picklists/new', (req, res) => {
  res.render('admin/picklist-edit', { picklist: null, entities: req.schema.entities, error: req.query.error });
});

router.post('/picklists', (req, res) => {
  const schema = req.schema;
  try {
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const picklist = schemaLib.addPicklist(schema, { ...req.body, values: arr(req.body.value) });
    schemaLib.persist(schema);
    res.redirect(`/admin/picklists/${picklist.key}/edit?notice=` + encodeURIComponent(`"${picklist.label}" created.`));
  } catch (err) {
    res.redirect('/admin/picklists/new?error=' + encodeURIComponent(err.message));
  }
});

router.get('/picklists/:key/edit', (req, res) => {
  const picklist = schemaLib.picklistByKey(req.schema, req.params.key);
  if (!picklist) return res.status(404).send('Unknown picklist.');
  res.render('admin/picklist-edit', { picklist, entities: req.schema.entities, error: req.query.error, notice: req.query.notice });
});

router.post('/picklists/:key', (req, res) => {
  const schema = req.schema;
  try {
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const submittedValues = arr(req.body.value);
    const activeFlags = arr(req.body.active); // one 'on'/undefined per submitted value, same order
    const values = submittedValues.map((v, i) => ({ value: v, active: activeFlags[i] === 'on' }));
    const picklist = schemaLib.updatePicklist(schema, req.params.key, { ...req.body, values });
    // updatePicklist preserves prior active flags by matching on value
    // text — but the form itself is the source of truth for a value the
    // admin just explicitly toggled, so apply those overrides too.
    if (picklist.sourceType === 'static') {
      values.forEach(v => { const real = picklist.values.find(x => x.value === v.value); if (real) real.active = v.active; });
    }
    schemaLib.persist(schema);
    res.redirect('/admin/picklists?notice=' + encodeURIComponent(`"${picklist.label}" saved.`));
  } catch (err) {
    res.redirect(`/admin/picklists/${req.params.key}/edit?error=` + encodeURIComponent(err.message));
  }
});

router.post('/picklists/:key/delete', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.deletePicklist(schema, req.params.key);
    schemaLib.persist(schema);
    res.redirect('/admin/picklists?notice=' + encodeURIComponent('Picklist deleted.'));
  } catch (err) {
    res.redirect('/admin/picklists?error=' + encodeURIComponent(err.message));
  }
});

router.get('/backup/download', (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="muneesh-legacy-backup-${stamp}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => { try { res.end(); } catch (e) { /* client gone */ } });
  archive.pipe(res);
  if (fs.existsSync(SCHEMA_FILE)) archive.file(SCHEMA_FILE, { name: 'schema.json' });
  if (fs.existsSync(DB_FILE)) archive.file(DB_FILE, { name: 'db.json' });
  if (fs.existsSync(USERS_FILE)) archive.file(USERS_FILE, { name: 'users.json' });
  if (fs.existsSync(UPLOADS_DIR)) archive.directory(UPLOADS_DIR, 'uploads');
  archive.finalize();
});

// Schema-only export: just the table/field/view structure, no data, no
// users, no uploaded files. For the "iterate in dev, push structure to
// prod, bring real data in separately" workflow — previously the only way
// to do this was manually deleting every record in dev first so a normal
// Backup's db.json ended up empty, which worked but was real manual
// effort every time.
router.get('/backup/download-schema-only', (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="muneesh-legacy-schema-${stamp}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => { try { res.end(); } catch (e) { /* client gone */ } });
  archive.pipe(res);
  if (fs.existsSync(SCHEMA_FILE)) archive.file(SCHEMA_FILE, { name: 'schema.json' });
  archive.finalize();
});

router.post('/backup/restore', uploadBackupMiddleware, (req, res) => {
  try {
    if (!req.file) throw new Error('Please choose a backup ZIP file to upload.');

    // Validate the archive before touching anything on disk.
    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (e) {
      throw new Error('The uploaded file is not a valid ZIP archive.');
    }
    const entries = zip.getEntries();
    const names = entries.map(e => e.entryName);
    if (!names.includes('schema.json')) throw new Error('This ZIP is missing schema.json — it does not look like a Muneesh Legacy backup.');
    // A schema-only export (db.json intentionally omitted) is a valid,
    // separate kind of restore — it replaces just the table/field/view
    // structure and leaves existing data, users, and uploads completely
    // untouched. A full backup (db.json present) still restores
    // everything together, exactly as before.
    const isSchemaOnly = !names.includes('db.json');

    // Parse the JSON files in-memory to catch corruption before we
    // clobber the running state.
    let schemaData, dbData = null, usersData = null;
    try { schemaData = JSON.parse(zip.getEntry('schema.json').getData().toString('utf8')); } catch (e) { throw new Error('schema.json in the backup is not valid JSON.'); }
    // Run the uploaded schema through the exact same migration/shape
    // validation a normal boot applies — catches a structurally broken
    // schema.json (missing "entities", wrong types) before committing it,
    // rather than letting a merely-valid-JSON-but-malformed file through
    // to crash every subsequent request, including this Backup page.
    try { schemaData = schemaLib.normalizeSchema(schemaData); } catch (e) { throw new Error('This ZIP\'s schema.json isn\'t a valid Muneesh Legacy schema: ' + e.message); }
    if (!isSchemaOnly) {
      try { dbData = JSON.parse(zip.getEntry('db.json').getData().toString('utf8')); } catch (e) { throw new Error('db.json in the backup is not valid JSON.'); }
    }
    if (names.includes('users.json')) {
      try { usersData = JSON.parse(zip.getEntry('users.json').getData().toString('utf8')); } catch (e) { throw new Error('users.json in the backup is not valid JSON.'); }
    }

    // Set aside current state to a .bak folder so a mistake is recoverable.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bakDir = path.join(DATA_DIR, `.bak-${stamp}`);
    fs.mkdirSync(bakDir, { recursive: true });
    if (fs.existsSync(SCHEMA_FILE)) fs.copyFileSync(SCHEMA_FILE, path.join(bakDir, 'schema.json'));
    if (!isSchemaOnly) {
      if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, path.join(bakDir, 'db.json'));
      if (fs.existsSync(USERS_FILE)) fs.copyFileSync(USERS_FILE, path.join(bakDir, 'users.json'));
      if (fs.existsSync(UPLOADS_DIR)) fs.renameSync(UPLOADS_DIR, path.join(bakDir, 'uploads'));
    }

    // Commit: schema.json always gets written. db.json/users.json/uploads
    // only get touched for a full (non-schema-only) restore.
    atomicWriteFileSync(SCHEMA_FILE, JSON.stringify(schemaData, null, 2));
    if (!isSchemaOnly) {
      atomicWriteFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
      if (usersData) atomicWriteFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      entries.forEach(entry => {
        if (!entry.entryName.startsWith('uploads/') || entry.isDirectory) return;
        // Guard against path traversal in a malicious archive.
        const relPath = entry.entryName.slice('uploads/'.length);
        if (relPath.includes('..')) return;
        const dest = path.join(UPLOADS_DIR, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
      });
    }

    res.redirect('/admin/backup?notice=' + encodeURIComponent(isSchemaOnly
      ? `Schema restored. Data, users, and uploads were left untouched. Previous schema saved to data/.bak-${stamp}/ in case you need to roll back.`
      : `Restore complete. Previous state saved to data/.bak-${stamp}/ in case you need to roll back.`));
  } catch (err) {
    res.redirect('/admin/backup?error=' + encodeURIComponent(err.message));
  }
});

router.get('/', (req, res) => {
  const schema = req.schema;
  const navRows = schema.navOrder.map(key => {
    const e = schema.entities[key];
    return { entity: e, count: db.getAll(key).length, referenced: schemaLib.isReferenced(schema, key), inNav: true };
  });
  const offNavRows = Object.keys(schema.entities)
    .filter(key => !schema.navOrder.includes(key))
    .map(key => {
      const e = schema.entities[key];
      return { entity: e, count: db.getAll(key).length, referenced: schemaLib.isReferenced(schema, key), inNav: false };
    });
  res.render('admin/index', { rows: navRows.concat(offNavRows), error: req.query.error, notice: req.query.notice });
});

router.post('/nav/:entity/add', (req, res) => {
  const schema = req.schema;
  schemaLib.addNav(schema, req.params.entity);
  schemaLib.persist(schema);
  res.redirect('/admin');
});

router.post('/nav/:entity/remove', (req, res) => {
  const schema = req.schema;
  schemaLib.removeNav(schema, req.params.entity);
  schemaLib.persist(schema);
  res.redirect('/admin');
});

// ---- bulk reorder endpoints (drag-and-drop) ------------------------------
// All four take a JSON body { order: [...ids] } and return 204 on success.

router.post('/nav/reorder', (req, res) => {
  const schema = req.schema;
  schemaLib.reorderNav(schema, req.body && req.body.order);
  schemaLib.persist(schema);
  res.status(204).end();
});

router.post('/:entity/fields/reorder', (req, res) => {
  const schema = req.schema;
  schemaLib.reorderFields(schema, req.params.entity, req.body && req.body.order);
  schemaLib.persist(schema);
  res.status(204).end();
});

router.post('/:entity/views/columns/reorder', (req, res) => {
  const schema = req.schema;
  schemaLib.reorderListColumns(schema, req.params.entity, req.body && req.body.order);
  schemaLib.persist(schema);
  res.status(204).end();
});

router.post('/:entity/views/filters/reorder', (req, res) => {
  const schema = req.schema;
  schemaLib.reorderFilterFields(schema, req.params.entity, req.body && req.body.order);
  schemaLib.persist(schema);
  res.status(204).end();
});

// ---- tables -----------------------------------------------------------

router.get('/entities/new', (req, res) => {
  res.render('admin/new-entity', { error: req.query.error });
});

router.post('/entities', (req, res) => {
  const schema = req.schema;
  try {
    const e = schemaLib.addEntity(schema, {
      key: req.body.key,
      label: req.body.label,
      singular: req.body.singular,
      pkName: req.body.pkName,
      pkLabel: req.body.pkLabel,
      pkAuto: req.body.pkAuto === 'on',
    });
    schemaLib.persist(schema);
    res.redirect(`/admin/${e.key}/fields?notice=${encodeURIComponent('Table created. Add more fields below.')}`);
  } catch (err) {
    res.redirect('/admin/entities/new?error=' + encodeURIComponent(err.message));
  }
});

router.get('/:entity/settings', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  res.render('admin/settings', { entity, error: req.query.error, notice: req.query.notice });
});

router.post('/:entity/settings', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updateEntitySettings(schema, req.params.entity, {
      label: req.body.label,
      singular: req.body.singular,
      displayField: req.body.displayField,
      displayPrefix: req.body.displayPrefix,
      listTitle: req.body.listTitle,
      detailTitle: req.body.detailTitle,
      auditEnabled: req.body.auditEnabled === 'on',
    });
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/settings?notice=${encodeURIComponent('Saved.')}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/settings?error=` + encodeURIComponent(err.message));
  }
});

router.post('/:entity/delete', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.deleteEntity(schema, req.params.entity);
    schemaLib.persist(schema);
    res.redirect('/admin?notice=' + encodeURIComponent('Table deleted.'));
  } catch (err) {
    res.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

router.post('/nav/:entity/move', (req, res) => {
  const schema = req.schema;
  schemaLib.moveNav(schema, req.params.entity, req.body.dir);
  schemaLib.persist(schema);
  res.redirect('/admin');
});

router.post('/:entity/move-to-admin', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.moveEntityToAdmin(schema, req.params.entity);
    schemaLib.persist(schema);
    res.redirect('/admin?notice=' + encodeURIComponent(`"${schema.entities[req.params.entity].label}" moved into Admin.`));
  } catch (e) {
    res.redirect('/admin?error=' + encodeURIComponent(e.message));
  }
});

router.post('/:entity/move-out-of-admin', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.moveEntityOutOfAdmin(schema, req.params.entity);
    schemaLib.persist(schema);
    res.redirect('/admin?notice=' + encodeURIComponent(`"${schema.entities[req.params.entity].label}" moved out of Admin, back to the main nav.`));
  } catch (e) {
    res.redirect('/admin?error=' + encodeURIComponent(e.message));
  }
});

router.post('/subnav/reorder', (req, res) => {
  const schema = req.schema;
  schemaLib.reorderAdminSubnav(schema, req.body && req.body.order);
  schemaLib.persist(schema);
  res.status(204).end();
});

// ---- CSV schema export / data import ---------------------------------

// Fields eligible for CSV export: real user-settable columns, but excluding
// computed (formula/rollup/series) and layout-only (spacer/section) types.
// Image fields ARE exported (as the stored filename string), so a backup
// captures the pointer even though the binary lives outside db.json.
function exportableFields(entity) {
  return entity.fields.filter(f => !schemaLib.COMPUTED_TYPES.includes(f.type) && !schemaLib.LAYOUT_TYPES.includes(f.type));
}

// Fields eligible for CSV IMPORT: same as export, minus image fields —
// there's no useful way to attach a binary file via CSV. If an image
// column exists in the uploaded CSV, its cell values are ignored.
function importableFields(entity) {
  return exportableFields(entity).filter(f => f.type !== 'image');
}

// Schema-only CSV: header row of field names, no data. Handy as a fill-in template.
router.get('/:entity/export-schema.csv', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  const fields = exportableFields(entity);
  const csvText = csv.stringify([fields.map(f => f.name)]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${entity.key}_template.csv"`);
  // UTF-8 BOM: Excel ignores the charset in Content-Type once a file is
  // saved and reopened directly, and guesses encoding from raw bytes —
  // without this, it defaults to Windows-1252 and mangles any non-ASCII
  // character (e.g. ₹ shows up as "â‚¹").
  res.send('\uFEFF' + csvText);
});

// Data CSV: header row + every existing row's exportable values. Same
// field set as the schema template, so the two round-trip cleanly.
// Booleans as "true"/"false" for readability; blanks stay blank; image
// fields export the stored filename (import will still ignore them).
router.get('/:entity/export.csv', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  const fields = exportableFields(entity);
  const header = fields.map(f => f.name);
  const rows = [header];
  db.getAll(entity.key).forEach(r => {
    rows.push(fields.map(f => {
      const v = r[f.name];
      if (v === undefined || v === null) return '';
      if (f.type === 'bool') return v ? 'true' : 'false';
      return String(v);
    }));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${entity.key}.csv"`);
  res.send('\uFEFF' + csv.stringify(rows));
});

router.get('/:entity/import', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  res.render('admin/import', { entity, fields: importableFields(entity), error: req.query.error, notice: req.query.notice });
});

router.post('/:entity/import', uploadCsvMiddleware, (req, res) => {
  const schema = req.schema;
  const entity = schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  try {
    if (!req.file) throw new Error('Please choose a CSV file to upload.');
    const rows = csv.parse(req.file.buffer.toString('utf8'));
    if (rows.length === 0) throw new Error('The CSV file is empty.');
    const headers = rows[0].map(h => h.trim());
    const dataRows = rows.slice(1);
    if (dataRows.length === 0) throw new Error('The CSV file has a header row but no data rows.');

    const fields = importableFields(entity);
    const fieldsByName = {};
    fields.forEach(f => { fieldsByName[f.name] = f; });

    if (!headers.includes(entity.pk)) {
      throw new Error(`The CSV must include a column for the primary key field "${entity.pk}".`);
    }

    const existingPks = new Set(db.getAll(entity.key).map(r => String(r[entity.pk])));
    const seenPksInFile = new Set();
    const pkField = fieldsByName[entity.pk];
    const toInsert = [];

    dataRows.forEach((cells, idx) => {
      const rowNum = idx + 2; // header row + 1-indexed
      const raw = {};
      headers.forEach((h, ci) => { raw[h] = cells[ci] !== undefined ? cells[ci] : ''; });

      const pkVal = (raw[entity.pk] || '').trim();
      const isAutoBlank = pkField && pkField.auto && pkVal === '';

      if (!isAutoBlank) {
        if (pkVal === '') throw new Error(`Row ${rowNum}: missing a value for primary key "${entity.pk}". No rows were imported.`);
        if (existingPks.has(pkVal)) throw new Error(`Row ${rowNum}: primary key "${pkVal}" already exists in ${entity.label}. Import cancelled — no rows were added.`);
        if (seenPksInFile.has(pkVal)) throw new Error(`Row ${rowNum}: primary key "${pkVal}" appears more than once in this file. No rows were imported.`);
        seenPksInFile.add(pkVal);
      }

      const record = {};
      entity.fields.forEach(f => { record[f.name] = ''; });
      fields.forEach(f => {
        if (!(f.name in raw)) return;
        let val = raw[f.name];
        if (f.type === 'bool') {
          val = /^(true|yes|y|1)$/i.test(String(val).trim());
        } else if (f.type === 'number' || f.type === 'currency') {
          val = val === '' ? '' : Number(val);
        } else if (f.type === 'percent') {
          val = val === '' ? '' : Number(val) / 100;
        }
        record[f.name] = val;
      });

      if (isAutoBlank) {
        record.__autoPk = true;
      } else {
        record[entity.pk] = pkVal;
      }
      toInsert.push(record);
    });

    // Every row validated — now commit all-or-nothing.
    let nextAuto = null;
    toInsert.forEach(record => {
      if (record.__autoPk) {
        if (nextAuto === null) nextAuto = db.nextAutoId(entity.key, entity.pk);
        record[entity.pk] = nextAuto++;
        delete record.__autoPk;
      }
      schemaLib.assignSeriesFields(schema, entity, record);
      db.insert(entity.key, record);
      if (entity.auditEnabled) {
        audit.log({ entityKey: entity.key, recordId: record[entity.pk], action: 'create', username: req.currentUser.username, before: null, after: record });
      }
    });

    res.redirect(`/admin/${entity.key}/import?notice=${encodeURIComponent(`Imported ${toInsert.length} record(s).`)}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/import?error=` + encodeURIComponent(err.message));
  }
});

// ---- fields -------------------------------------------------------------

router.get('/:entity/fields', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  // Lookup fields CAN target their own table (self-referencing fk) — e.g.
  // a "Group Root" field grouping revisions of the same tenant, or a
  // "Parent" field for sub-landlords. Nothing in fk resolution, the
  // formula engine, or db.getById assumes the target is a different
  // table, so there's no reason to exclude the current one here.
  const fkTargets = Object.values(req.schema.entities);
  const childOptions = schemaLib.getChildren(req.schema, entity.key).map(c => req.schema.entities[c.entity]);
  res.render('admin/fields', {
    entity, fkTargets, childOptions, allEntities: Object.values(req.schema.entities),
    fieldTypes: schemaLib.FIELD_TYPES, error: req.query.error, notice: req.query.notice,
    picklists: schemaLib.picklistsFor(req.schema),
  });
});

router.post('/:entity/fields', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.addField(schema, req.params.entity, {
      name: req.body.name,
      label: req.body.label,
      type: req.body.type,
      ref: req.body.ref,
      required: req.body.required === 'on',
      inList: req.body.inList === 'on',
      rows: req.body.rows,
      formula: req.body.formula,
      format: req.body.format,
      options: req.body.options,
      seriesGroupPath: req.body.seriesGroupPath,
      seriesTrackerEntity: req.body.seriesTrackerEntity,
      seriesTrackerGroupField: req.body.seriesTrackerGroupField,
      seriesTrackerCounterField: req.body.seriesTrackerCounterField,
      rollupFn: req.body.rollupFn,
      rollupHop1Entity: req.body.rollupHop1Entity,
      rollupHop2Entity: req.body.rollupHop2Entity,
      rollupField: req.body.rollupField,
      rollupOrderField: req.body.rollupOrderField,
      rollupWhere: req.body.rollupWhere,
      hint: req.body.hint,
      hintImportant: req.body.hintImportant === 'on',
      readOnlyMode: req.body.readOnlyMode,
      defaultMode: req.body.defaultMode,
      defaultValue: req.body.defaultValue,
      defaultFormula: req.body.defaultFormula,
      picklistSource: req.body.picklistSource,
      picklistKey: req.body.picklistKey,
      picklistConstraintField: req.body.picklistConstraintField,
    });
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/fields?notice=${encodeURIComponent('Field added.')}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/fields?error=` + encodeURIComponent(err.message));
  }
});

router.post('/:entity/fields/:field', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updateField(schema, req.params.entity, req.params.field, {
      label: req.body.label,
      type: req.body.type,
      ref: req.body.ref,
      required: req.body.required === 'on',
      inList: req.body.inList === 'on',
      rows: req.body.rows,
      formula: req.body.formula,
      format: req.body.format,
      options: req.body.options,
      seriesGroupPath: req.body.seriesGroupPath,
      seriesTrackerEntity: req.body.seriesTrackerEntity,
      seriesTrackerGroupField: req.body.seriesTrackerGroupField,
      seriesTrackerCounterField: req.body.seriesTrackerCounterField,
      rollupFn: req.body.rollupFn,
      rollupHop1Entity: req.body.rollupHop1Entity,
      rollupHop2Entity: req.body.rollupHop2Entity,
      rollupField: req.body.rollupField,
      rollupOrderField: req.body.rollupOrderField,
      rollupWhere: req.body.rollupWhere,
      hint: req.body.hint,
      hintImportant: req.body.hintImportant === 'on',
      readOnlyMode: req.body.readOnlyMode,
      defaultMode: req.body.defaultMode,
      defaultValue: req.body.defaultValue,
      defaultFormula: req.body.defaultFormula,
      picklistSource: req.body.picklistSource,
      picklistKey: req.body.picklistKey,
      picklistConstraintField: req.body.picklistConstraintField,
    });
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/fields?notice=${encodeURIComponent('Field updated.')}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/fields?error=` + encodeURIComponent(err.message));
  }
});

router.post('/:entity/fields/:field/delete', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.deleteField(schema, req.params.entity, req.params.field);
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/fields?notice=${encodeURIComponent('Field deleted.')}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/fields?error=` + encodeURIComponent(err.message));
  }
});

router.post('/:entity/fields/:field/move', (req, res) => {
  const schema = req.schema;
  schemaLib.moveField(schema, req.params.entity, req.params.field, req.body.dir);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/fields`);
});

// ---- views (list-column selection/order + default sort, per table) --------

router.get('/views', (req, res) => {
  const schema = req.schema;
  const rows = schema.navOrder.map(key => schema.entities[key]);
  res.render('admin/views-index', { rows });
});

router.get('/:entity/views', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  const included = schemaLib.listFieldsFor(entity);
  const excluded = entity.fields.filter(f => !entity.listColumns.includes(f.name) && !schemaLib.LAYOUT_TYPES.includes(f.type));
  const filterIncluded = schemaLib.filterFieldsFor(entity);
  const filterExcluded = entity.fields.filter(f => schemaLib.FILTERABLE_TYPES.includes(f.type) && !entity.filterFields.includes(f.name));

  // Child applets: intersect configured settings against what's currently
  // discoverable, so a stale entry (e.g. from a since-deleted linking
  // field) never shows as a ghost row here — same safety net
  // computeAppletData uses when actually rendering a detail page. The
  // Available list is NOT filtered down to "not yet added" — every
  // discoverable relationship stays clickable, since the same relationship
  // can now have multiple independently-filtered instances shown at once.
  const discoverable = schemaLib.discoverApplets(req.schema, entity.key);
  const configured = schemaLib.appletSettingsFor(req.schema, entity.key);
  const shownApplets = configured.map(setting => {
    const applet = discoverable.find(a => a.appletKey === setting.baseKey);
    if (!applet) return null;
    const targetEntity = req.schema.entities[applet.entity];
    const eligibleFields = targetEntity.fields.filter(f => schemaLib.FILTERABLE_TYPES.includes(f.type));
    let valueField = null;
    let valueOptions = null;
    if (setting.filterField) {
      valueField = targetEntity.fields.find(f => f.name === setting.filterField);
      if (valueField && valueField.type === 'picklist') {
        valueOptions = schemaLib.picklistOptions(valueField);
      } else if (valueField && valueField.type === 'fk') {
        const refEntity = req.schema.entities[valueField.ref];
        valueOptions = refEntity ? db.getAll(refEntity.key).map(r => ({
          value: r[refEntity.pk],
          label: `${r[refEntity.pk]} \u2014 ${schemaLib.display(refEntity, r)}`,
        })) : [];
      }
    }
    return { applet, setting, targetEntity, eligibleFields, valueField, valueOptions };
  }).filter(Boolean);

  res.render('admin/views', {
    entity, included, excluded, filterIncluded, filterExcluded, shownApplets, availableApplets: discoverable,
    filterKindFor: schemaLib.filterKindFor,
    error: req.query.error, notice: req.query.notice,
  });
});

router.post('/:entity/views/applets/add', (req, res) => {
  const schema = req.schema;
  schemaLib.addChildAppletInstance(schema, req.params.entity, req.body.baseKey);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/applets/remove', (req, res) => {
  const schema = req.schema;
  schemaLib.removeApplet(schema, req.params.entity, req.body.instanceKey);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/applets/reorder', (req, res) => {
  const schema = req.schema;
  schemaLib.reorderApplets(schema, req.params.entity, req.body && req.body.order);
  schemaLib.persist(schema);
  res.status(204).end();
});

router.post('/:entity/views/applets/filter', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.setAppletFilter(schema, req.params.entity, req.body.instanceKey, req.body);
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/views`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/views?error=` + encodeURIComponent(err.message));
  }
});

router.post('/:entity/views/columns/:field/add', (req, res) => {
  const schema = req.schema;
  schemaLib.addListColumn(schema, req.params.entity, req.params.field);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/columns/:field/remove', (req, res) => {
  const schema = req.schema;
  schemaLib.removeListColumn(schema, req.params.entity, req.params.field);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/columns/:field/move', (req, res) => {
  const schema = req.schema;
  schemaLib.moveListColumn(schema, req.params.entity, req.params.field, req.body.dir);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/filters/:field/add', (req, res) => {
  const schema = req.schema;
  schemaLib.addFilterField(schema, req.params.entity, req.params.field);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/filters/:field/remove', (req, res) => {
  const schema = req.schema;
  schemaLib.removeFilterField(schema, req.params.entity, req.params.field);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/filters/:field/move', (req, res) => {
  const schema = req.schema;
  schemaLib.moveFilterField(schema, req.params.entity, req.params.field, req.body.dir);
  schemaLib.persist(schema);
  res.redirect(`/admin/${req.params.entity}/views`);
});

router.post('/:entity/views/sort', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updateViewSort(schema, req.params.entity, { sortField: req.body.sortField, sortDir: req.body.sortDir });
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/views?notice=${encodeURIComponent('Sort order saved.')}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/views?error=` + encodeURIComponent(err.message));
  }
});

// ---- users & permissions --------------------------------------------------

function readPermissionsFromBody(body, schema) {
  const permissions = {};
  Object.keys(schema.entities).forEach(key => {
    permissions[key] = {
      create: body[`perm_${key}_create`] === 'on',
      read: body[`perm_${key}_read`] === 'on',
      update: body[`perm_${key}_update`] === 'on',
      delete: body[`perm_${key}_delete`] === 'on',
    };
  });
  return permissions;
}

router.get('/users', (req, res) => {
  res.render('admin/users', { users: usersLib.getAll(), error: req.query.error, notice: req.query.notice, currentUserId: req.currentUser.id });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user-form', { schema: req.schema, user: null, error: req.query.error });
});

router.post('/users', (req, res) => {
  try {
    const user = usersLib.createUser({
      username: req.body.username,
      password: req.body.password,
      isAdmin: req.body.isAdmin === 'on',
      permissions: readPermissionsFromBody(req.body, req.schema),
    });
    res.redirect(`/admin/users?notice=${encodeURIComponent(`User "${user.username}" created.`)}`);
  } catch (err) {
    res.redirect('/admin/users/new?error=' + encodeURIComponent(err.message));
  }
});

router.get('/users/:id/edit', (req, res) => {
  const user = usersLib.getById(req.params.id);
  if (!user) return res.status(404).send('Unknown user.');
  res.render('admin/user-form', { schema: req.schema, user, error: req.query.error });
});

router.post('/users/:id', (req, res) => {
  try {
    usersLib.updateUser(req.params.id, {
      username: req.body.username,
      password: req.body.password || null,
      isAdmin: req.body.isAdmin === 'on',
      permissions: readPermissionsFromBody(req.body, req.schema),
    });
    res.redirect(`/admin/users?notice=${encodeURIComponent('User updated.')}`);
  } catch (err) {
    res.redirect(`/admin/users/${req.params.id}/edit?error=` + encodeURIComponent(err.message));
  }
});

router.post('/users/:id/delete', (req, res) => {
  try {
    if (String(req.params.id) === String(req.currentUser.id)) {
      throw new Error('You cannot delete your own account while logged in as it.');
    }
    usersLib.deleteUser(req.params.id);
    res.redirect(`/admin/users?notice=${encodeURIComponent('User deleted.')}`);
  } catch (err) {
    res.redirect('/admin/users?error=' + encodeURIComponent(err.message));
  }
});

// ---- audit log (global view) -----------------------------------------------

router.get('/audit', (req, res) => {
  const entries = audit.getRecent(300);
  res.render('admin/audit', { entries, entities: req.schema.entities });
});

module.exports = router;
