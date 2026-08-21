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
const scheduledBackup = require('../scheduledBackup');
const templateStarters = require('../templateStarters');
const AdmZip = require('adm-zip');
const schemaLib = require('../schema');
const mailer = require('../mailer');
const emailMod = require('../email');
const { atomicWriteFileSync } = require('../fsutil');
const db = require('../db');
const usersLib = require('../users');
const audit = require('../audit');
const billsLib = require('../bills');
const remindersLib = require('../reminders');
const taxLib = require('../tax');
const icons = require('../icons');
const homeMod = require('../home');
const errorlog = require('../errorlog');
const notify = require('../notify');
const telegram = require('../telegram');
const secrets = require('../secrets');
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
  res.locals.isAdminPage = true;
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
  res.render('admin/backup', { error: req.query.error, notice: req.query.notice, scheduledBackups: scheduledBackup.listBackups() });
});

router.get('/backup/scheduled/:filename', (req, res) => {
  // Guard against path traversal — only a bare filename, no directory
  // components, and it has to actually be one of the real, currently
  // listed scheduled backups, not an arbitrary path constructed by hand.
  const filename = path.basename(req.params.filename);
  const known = scheduledBackup.listBackups().some(b => b.filename === filename);
  if (!known) return res.status(404).send('Unknown backup file.');
  res.download(path.join(scheduledBackup.BACKUPS_DIR, filename), filename);
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

// ---- Email Settings (SMTP transport + notify-channel toggle) --------------
// Email settings were merged into the Notifications page (below Telegram).
// Keep this path working for old links/bookmarks by redirecting there.
router.get('/email-settings', (req, res) => res.redirect('/admin/notifications'));

router.post('/email-settings', (req, res) => {
  const schema = req.schema;
  try {
    schema.emailSettings = {
      host: String(req.body.host || '').trim(),
      port: Number(req.body.port) || 587,
      secure: req.body.secure === 'on' || req.body.secure === 'true',
      username: String(req.body.username || '').trim(),
      fromName: String(req.body.fromName || '').trim(),
      fromAddress: String(req.body.fromAddress || '').trim(),
      replyTo: String(req.body.replyTo || '').trim(),
      notifyChannel: req.body.notifyChannel === 'on' || req.body.notifyChannel === 'true',
      notifyEmailTo: String(req.body.notifyEmailTo || '').trim(),
      logRetentionDays: Number(req.body.logRetentionDays) > 0 ? Number(req.body.logRetentionDays) : 90,
    };
    // Password only via secrets (never schema/backups). Blank = leave as-is;
    // an explicit "clear" checkbox wipes it. Env-var passwords aren't editable.
    if (secrets.smtpPasswordSource() !== 'env') {
      if (req.body.clearPassword === 'on') secrets.setSmtpPassword('');
      else if (String(req.body.password || '').length) secrets.setSmtpPassword(req.body.password);
    }
    schemaLib.persist(schema);
    res.redirect('/admin/notifications?notice=' + encodeURIComponent('Email settings saved.'));
  } catch (err) {
    res.redirect('/admin/notifications?error=' + encodeURIComponent(err.message));
  }
});

router.post('/email-settings/test', async (req, res) => {
  const schema = req.schema;
  const to = String(req.body.testTo || '').trim();
  if (!to) return res.redirect('/admin/notifications?error=' + encodeURIComponent('Enter an address to send the test to.'));
  const r = await mailer.sendTest(schema.emailSettings || {}, to);
  emailMod.logEmail({ to, subject: 'Muneesh Legacy — test email', kind: 'test', status: r.ok ? 'sent' : 'failed', detail: r.ok ? (r.response || 'sent') : (r.error && r.error.message), by: req.user && req.user.username });
  if (r.ok) res.redirect('/admin/notifications?notice=' + encodeURIComponent('Test email sent to ' + to + '.'));
  else res.redirect('/admin/notifications?error=' + encodeURIComponent('Test failed: ' + ((r.error && r.error.message) || 'unknown error')));
});

// ---- Tax field-role settings -----------------------------------------
// Same shape as PayQR settings above: which field on Landlords/Tenants/
// Invoices plays each role tax.js's computation needs. See tax.js and
// schema.js (TAX_FIELD_ROLES) for the full rationale.

router.get('/tax-settings', (req, res) => {
  const schema = req.schema;
  const requiredTables = ['landlords', 'tenants', 'invoices'];
  const missingTables = requiredTables.filter(k => !schema.entities[k]);
  const settings = schema.taxSettings || {};
  const roleFields = {};
  Object.keys(schemaLib.TAX_FIELD_ROLES).forEach(key => {
    const role = schemaLib.TAX_FIELD_ROLES[key];
    const entity = schema.entities[role.entity];
    roleFields[key] = { ...role, options: schemaLib.taxEligibleFields(entity, key) };
  });
  res.render('admin/tax-settings', {
    missingTables, settings, roleFields,
    error: req.query.error, notice: req.query.notice,
  });
});

router.post('/tax-settings', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updateTaxSettings(schema, req.body);
    schemaLib.persist(schema);
    res.redirect('/admin/tax-settings?notice=' + encodeURIComponent('Tax settings saved.'));
  } catch (err) {
    res.redirect('/admin/tax-settings?error=' + encodeURIComponent(err.message));
  }
});

// ---- Help (Getting Started + Formula Language Reference) ----------------
// One consolidated page, two views selected by ?view= (getting-started is
// the default) — Getting Started is the narrative walkthrough of actually
// using the app end to end, Formula Language Reference is the
// function-by-function technical reference for formulas/rollups/reports
// plus the separate {{tag}} syntax used in Template Library documents.
// Previously two entirely separate pages (/help and /journey); merged per
// direct request — no redirect kept for the old /journey URL, a clean
// break was explicitly preferred over compatibility since this is still
// pre-production. STANDING INSTRUCTION (carried forward from both
// previous routes, not new): keep this current whenever a meaningfully
// new feature ships or an existing one's behavior changes — both views
// usually need updating together, since a new feature is often both a
// new step in the walkthrough AND a new function/syntax entry in the
// reference.

// ---- Admin -> Sidebar: customizing the left nav's groups/items/icons -----
// See schema.js's sidebarGroupsFor/addSidebarGroup/etc. for the actual data
// model and validation; these routes are thin wrappers, matching every
// other Admin CRUD screen's own shape (load schema, mutate, persist,
// redirect with a notice/error).

// Everything NOT currently placed in any group — real tables (navOrder),
// custom Screens, and the built-in mini-app routes — is what the "Add
// item" picker on each group offers. A table/screen/mini-app already
// placed in one group doesn't show up as addable again elsewhere; the
// same table CAN still be added to a second group deliberately (e.g.
// wanting Invoices reachable from two different groupings), so this only
// excludes items that are placed nowhere yet, not exact duplicates.
function unplacedSidebarCandidates(schema) {
  const placedPaths = new Set();
  schema.sidebarGroups.forEach(g => g.items.forEach(it => placedPaths.add(it.path)));
  const candidates = [];
  schema.navOrder.forEach(key => {
    const e = schema.entities[key];
    if (e && !placedPaths.has(`/${key}`)) candidates.push({ path: `/${key}`, label: e.label, icon: schemaLib.guessIconForKey(key), entityKeys: [key] });
  });
  schemaLib.screensFor(schema).forEach(s => {
    const p = `/screens/${s.key}`;
    if (!placedPaths.has(p)) candidates.push({ path: p, label: s.label, icon: 'layout', entityKeys: [] });
  });
  schemaLib.builtinSidebarLinks(schema).forEach(link => {
    if (!placedPaths.has(link.path)) candidates.push(link);
  });
  return candidates;
}

router.get('/sidebar', (req, res) => {
  const schema = req.schema;
  res.render('admin/sidebar', {
    groups: schema.sidebarGroups,
    candidates: unplacedSidebarCandidates(schema),
    iconKeys: icons.iconKeys(),
    renderIcon: icons.renderIcon,
    error: req.query.error, notice: req.query.notice,
  });
});

router.post('/sidebar/groups', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.addSidebarGroup(schema, { label: req.body.label, collapsedByDefault: req.body.collapsedByDefault === 'on' });
    schemaLib.persist(schema);
    res.redirect('/admin/sidebar?notice=' + encodeURIComponent('Group added.'));
  } catch (err) {
    res.redirect('/admin/sidebar?error=' + encodeURIComponent(err.message));
  }
});

router.post('/sidebar/groups/reorder', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.reorderSidebarGroups(schema, req.body.order || []);
    schemaLib.persist(schema);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sidebar/groups/:key', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updateSidebarGroup(schema, req.params.key, { label: req.body.label, collapsedByDefault: req.body.collapsedByDefault === 'on' });
    schemaLib.persist(schema);
    res.redirect('/admin/sidebar?notice=' + encodeURIComponent('Group updated.'));
  } catch (err) {
    res.redirect('/admin/sidebar?error=' + encodeURIComponent(err.message));
  }
});

router.post('/sidebar/groups/:key/delete', (req, res) => {
  const schema = req.schema;
  schemaLib.deleteSidebarGroup(schema, req.params.key);
  schemaLib.persist(schema);
  res.redirect('/admin/sidebar?notice=' + encodeURIComponent('Group removed — its items are no longer in the sidebar (not deleted as tables, just unlisted here).'));
});

router.post('/sidebar/groups/:key/items', (req, res) => {
  const schema = req.schema;
  try {
    // The "Add item" picker submits path/label/icon/entityKeys together
    // (entityKeys as a JSON string, since a plain form field can't carry
    // an array) — reparsed here rather than trusting the client further
    // than that.
    let entityKeys = [];
    try { entityKeys = JSON.parse(req.body.entityKeys || '[]'); } catch (e) { entityKeys = []; }
    schemaLib.addSidebarItem(schema, req.params.key, { path: req.body.path, label: req.body.label, icon: req.body.icon, entityKeys });
    schemaLib.persist(schema);
    res.redirect('/admin/sidebar?notice=' + encodeURIComponent('Item added.'));
  } catch (err) {
    res.redirect('/admin/sidebar?error=' + encodeURIComponent(err.message));
  }
});

router.post('/sidebar/groups/:key/items/:idx', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.updateSidebarItem(schema, req.params.key, Number(req.params.idx), { label: req.body.label, icon: req.body.icon });
    schemaLib.persist(schema);
    res.redirect('/admin/sidebar?notice=' + encodeURIComponent('Item updated.'));
  } catch (err) {
    res.redirect('/admin/sidebar?error=' + encodeURIComponent(err.message));
  }
});

router.post('/sidebar/groups/:key/items/:idx/delete', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.deleteSidebarItem(schema, req.params.key, Number(req.params.idx));
    schemaLib.persist(schema);
    res.redirect('/admin/sidebar?notice=' + encodeURIComponent('Item removed.'));
  } catch (err) {
    res.redirect('/admin/sidebar?error=' + encodeURIComponent(err.message));
  }
});

router.post('/sidebar/groups/:key/items/reorder', (req, res) => {
  const schema = req.schema;
  try {
    const indexes = (req.body.order || []).map(Number);
    schemaLib.reorderSidebarItems(schema, req.params.key, indexes);
    schemaLib.persist(schema);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Home Screen widgets ------------------------------------------------
// Same overall shape as the Sidebar routes above — a flat, ordered list
// rather than nested groups, since widgets aren't grouped. See home.js for
// the widget registry and how each widget's own data actually gets pulled.

router.get('/home-screen', (req, res) => {
  const schema = req.schema;
  const kpiEntityLabel = (k) => (schema.entities[k] ? schema.entities[k].label : k);
  res.render('admin/home-screen', {
    widgets: schema.homeWidgets,
    widgetTypes: homeMod.WIDGET_TYPES,
    kpiMetrics: homeMod.KPI_METRICS,
    actionCandidates: schema.navOrder.filter(k => schema.entities[k]).map(k => ({ key: k, label: schema.entities[k].label })),
    reportOptions: schemaLib.reportDefsFor(schema).map(r => ({ key: r.key, label: r.label })),
    kpiEntityLabel,
    error: req.query.error, notice: req.query.notice,
  });
});

router.post('/home-screen/add', (req, res) => {
  const schema = req.schema;
  try {
    homeMod.addHomeWidget(schema, req.body.type);
    schemaLib.persist(schema);
    res.redirect('/admin/home-screen?notice=' + encodeURIComponent('Widget added.'));
  } catch (err) {
    res.redirect('/admin/home-screen?error=' + encodeURIComponent(err.message));
  }
});

router.post('/home-screen/reorder', (req, res) => {
  const schema = req.schema;
  try {
    homeMod.reorderHomeWidgets(schema, req.body.order || []);
    schemaLib.persist(schema);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/home-screen/:id/delete', (req, res) => {
  const schema = req.schema;
  homeMod.deleteHomeWidget(schema, req.params.id);
  schemaLib.persist(schema);
  res.redirect('/admin/home-screen?notice=' + encodeURIComponent('Widget removed.'));
});

router.post('/home-screen/:id/config', (req, res) => {
  const schema = req.schema;
  try {
    // Checkbox-list fields (actions, metrics) arrive as a single string
    // when only one is checked, an array otherwise; normalized to always
    // be an array before handing off. text/reportKey are plain single
    // values, passed through as-is.
    const raw = req.body.actions || req.body.metrics;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    homeMod.updateHomeWidgetConfig(schema, req.params.id, {
      actions: list, metrics: list,
      text: req.body.text, reportKey: req.body.reportKey,
      columns: req.body.columns,
    });
    schemaLib.persist(schema);
    res.redirect('/admin/home-screen?notice=' + encodeURIComponent('Widget updated.'));
  } catch (err) {
    res.redirect('/admin/home-screen?error=' + encodeURIComponent(err.message));
  }
});

router.get('/help', (req, res) => {
  res.render('admin/help', { view: req.query.view === 'formula-reference' ? 'formula-reference' : 'getting-started' });
});

// ---- Notifications (Telegram) ---------------------------------------------
// Config lives in schema.notificationSettings (chat IDs are not secrets —
// nothing can be sent without the bot token). The TOKEN itself lives in
// secrets.js, outside schema.json, so it never enters a backup archive.

function notificationsPageModel(req) {
  const schema = req.schema;
  notify.ensureNotificationSettings(schema);
  const settings = schema.notificationSettings;
  const now = new Date();

  // "Status right now" per source, computed against an admin-level view
  // so the page reports what EXISTS, not what one recipient can see.
  const sourceStatus = {};
  Object.keys(notify.SOURCES).forEach(key => {
    let r;
    try { r = notify.SOURCES[key].collect(schema, req.currentUser); }
    catch (e) { r = { available: false, reason: e && e.message }; }
    sourceStatus[key] = { available: !!r.available, reason: r.reason, count: (r.items || []).length };
  });

  return {
    settings,
    sources: notify.SOURCES,
    modes: notify.MODES,
    modeLabels: { off: 'Off', digest: 'Daily digest', immediate: 'Immediate', both: 'Both' },
    sourceStatus,
    users: usersLib.getAll().map(u => ({ username: u.username, isAdmin: !!u.isAdmin })),
    hasToken: secrets.hasTelegramToken(),
    maskedToken: secrets.maskedTelegramToken(),
    tokenSource: secrets.telegramTokenSource(),
    digestInQuiet: notify.isQuietHour(Number(settings.digestHour), settings.quietStartHour, settings.quietEndHour),
    tickMinutes: Math.round(notify.TICK_INTERVAL_MS / 60000),
    preview: notify.previewForAdmin(schema, settings, now),
    // Email delivery section (merged from the old Email Settings page).
    emailSettings: schema.emailSettings || {},
    emailPasswordSource: secrets.smtpPasswordSource(),
    emailHasPassword: secrets.hasSmtpPassword(),
    emailConfigured: mailer.isConfigured(schema.emailSettings),
    emailTemplates: (schema.templates || []).filter(t => t.baseKind === 'email'),
    error: req.query.error, notice: req.query.notice,
  };
}

router.get('/notifications', (req, res) => {
  res.render('admin/notifications', notificationsPageModel(req));
});

router.post('/notifications/token', (req, res) => {
  if (secrets.telegramTokenSource() === 'env') {
    return res.redirect('/admin/notifications?error=' + encodeURIComponent('The token comes from the TELEGRAM_BOT_TOKEN environment variable and cannot be changed here.'));
  }
  try {
    if (req.body.clear) {
      secrets.setTelegramToken('');
      return res.redirect('/admin/notifications?notice=' + encodeURIComponent('Bot token removed.'));
    }
    const token = String(req.body.token || '').trim();
    // Blank submit means "leave the stored token alone" — the field is a
    // password input that never echoes the current value, so an empty
    // post is far more likely to be "I didn't touch it" than "erase it".
    // Erasing is an explicit button.
    if (!token) return res.redirect('/admin/notifications?notice=' + encodeURIComponent('Token unchanged.'));
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
      return res.redirect('/admin/notifications?error=' + encodeURIComponent('That does not look like a Telegram bot token (expected "123456789:AA..."). Nothing was saved.'));
    }
    secrets.setTelegramToken(token);
    res.redirect('/admin/notifications?notice=' + encodeURIComponent('Bot token saved. Use "Check connection" to confirm it works.'));
  } catch (err) {
    res.redirect('/admin/notifications?error=' + encodeURIComponent(err.message));
  }
});

router.post('/notifications/check', async (req, res) => {
  const r = await telegram.getMe(secrets.getTelegramToken());
  if (!r.ok) return res.redirect('/admin/notifications?error=' + encodeURIComponent(r.error.message));
  const me = r.result || {};
  res.redirect('/admin/notifications?notice=' + encodeURIComponent(`Connected as @${me.username || me.first_name || 'bot'}.`));
});

router.post('/notifications/test', async (req, res) => {
  const chatId = String(req.body.chatId || '').trim();
  if (!chatId) return res.redirect('/admin/notifications?error=' + encodeURIComponent('No chat ID given.'));
  const r = await notify.sendTest(chatId);
  if (!r.ok) return res.redirect('/admin/notifications?error=' + encodeURIComponent(`Test to ${chatId} failed: ${r.error.message}`));
  res.redirect('/admin/notifications?notice=' + encodeURIComponent(`Test message sent to ${chatId}.`));
});

router.post('/notifications/settings', (req, res) => {
  const schema = req.schema;
  notify.ensureNotificationSettings(schema);
  const s = schema.notificationSettings;
  const hour = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
  };
  s.enabled = !!req.body.enabled;
  s.digestHour = hour(req.body.digestHour, s.digestHour);
  s.quietStartHour = hour(req.body.quietStartHour, s.quietStartHour);
  s.quietEndHour = hour(req.body.quietEndHour, s.quietEndHour);
  const days = Number(req.body.retentionDays);
  if (Number.isFinite(days) && days >= 1 && days <= 3650) s.retentionDays = Math.round(days);
  Object.keys(notify.SOURCES).forEach(key => {
    const mode = req.body[`mode__${key}`];
    if (notify.MODES.includes(mode)) s.sources[key] = { ...(s.sources[key] || {}), mode };
  });
  schemaLib.persist(schema);
  res.redirect('/admin/notifications?notice=' + encodeURIComponent('Notification settings saved.'));
});

// Saves the same form the regular "Save settings" button does (so what
// gets tested is exactly what's now actually configured, not some
// unsaved in-between state), then sends the current admin's own preview
// as a real Telegram message to their own configured chat — "this is
// genuinely what your selections produce," not just the on-screen text
// preview in section 5, which doesn't show how Telegram itself renders
// the formatting.
router.post('/notifications/test-selection', (req, res) => {
  const schema = req.schema;
  notify.ensureNotificationSettings(schema);
  const s = schema.notificationSettings;
  const hour = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
  };
  s.enabled = !!req.body.enabled;
  s.digestHour = hour(req.body.digestHour, s.digestHour);
  s.quietStartHour = hour(req.body.quietStartHour, s.quietStartHour);
  s.quietEndHour = hour(req.body.quietEndHour, s.quietEndHour);
  const days = Number(req.body.retentionDays);
  if (Number.isFinite(days) && days >= 1 && days <= 3650) s.retentionDays = Math.round(days);
  Object.keys(notify.SOURCES).forEach(key => {
    const mode = req.body[`mode__${key}`];
    if (notify.MODES.includes(mode)) s.sources[key] = { ...(s.sources[key] || {}), mode };
  });
  schemaLib.persist(schema);

  const chatId = (s.userChats || {})[req.currentUser.username];
  if (!chatId) {
    return res.redirect('/admin/notifications?error=' + encodeURIComponent(
      'Settings saved, but there\u2019s no chat ID set for your own account yet \u2014 set one under Per-user chats first, then try again.'));
  }
  const token = secrets.getTelegramToken();
  if (!token) {
    return res.redirect('/admin/notifications?error=' + encodeURIComponent('Settings saved, but no bot token is configured yet.'));
  }

  (async () => {
    const previews = notify.previewForAdmin(schema, s, new Date());
    const mine = previews.find(p => p.recipient.kind === 'user' && String(p.recipient.chatId) === String(chatId));
    const text = mine
      ? `<b>Preview of your current selections</b>\n\n${mine.digestPreview}`
      : '<b>Preview of your current selections</b>\n\nNothing would be sent right now — every enabled source has zero outstanding items for you at the moment.';
    const result = await telegram.sendMessage(token, chatId, text);
    if (result.ok) {
      res.redirect('/admin/notifications?notice=' + encodeURIComponent('Settings saved and a preview of your selections was sent to your own chat.'));
    } else {
      res.redirect('/admin/notifications?error=' + encodeURIComponent('Settings saved, but the test send failed: ' + result.error.message));
    }
  })();
});

router.post('/notifications/group', (req, res) => {
  const schema = req.schema;
  notify.ensureNotificationSettings(schema);
  const chatId = String(req.body.chatId || '').trim();
  if (!chatId) return res.redirect('/admin/notifications?error=' + encodeURIComponent('Chat ID is required.'));
  const asUser = String(req.body.asUser || '').trim();
  if (asUser && !usersLib.getByUsername(asUser)) {
    return res.redirect('/admin/notifications?error=' + encodeURIComponent('That user no longer exists.'));
  }
  schema.notificationSettings.groupChats.push({
    id: 'g' + Date.now().toString(36),
    chatId, label: String(req.body.label || '').trim(), asUser,
  });
  schemaLib.persist(schema);
  res.redirect('/admin/notifications?notice=' + encodeURIComponent('Group chat added. Send a test message to confirm the bot can post there.'));
});

router.post('/notifications/group/:id/delete', (req, res) => {
  const schema = req.schema;
  notify.ensureNotificationSettings(schema);
  schema.notificationSettings.groupChats = (schema.notificationSettings.groupChats || [])
    .filter(g => String(g.id) !== String(req.params.id));
  schemaLib.persist(schema);
  res.redirect('/admin/notifications?notice=' + encodeURIComponent('Group chat removed.'));
});

router.post('/notifications/user-chat', (req, res) => {
  const schema = req.schema;
  notify.ensureNotificationSettings(schema);
  const username = String(req.body.username || '').trim();
  if (!usersLib.getByUsername(username)) {
    return res.redirect('/admin/notifications?error=' + encodeURIComponent('Unknown user.'));
  }
  const chatId = String(req.body.chatId || '').trim();
  if (chatId) schema.notificationSettings.userChats[username] = chatId;
  else delete schema.notificationSettings.userChats[username];
  schemaLib.persist(schema);
  res.redirect('/admin/notifications?notice=' + encodeURIComponent(chatId ? `Chat ID saved for ${username}.` : `Chat ID cleared for ${username}.`));
});

// Data Health — read-only diagnostics over the whole store. Runs
// inside the normal request cache, so a healthy install stays cheap
// (one full-table scan per entity, reusing indexes across fk fields).
router.get('/data-health', (req, res) => {
  const dataHealth = require('../dataHealth');
  const issues = dataHealth.runDataHealth(req.schema);
  res.render('admin/data-health', { issues });
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
  const colExpr = arr(body.col_expr), colLabel = arr(body.col_label), colFormat = arr(body.col_format), colTotal = arr(body.col_total), colTagKey = arr(body.col_tagkey);
  const columns = colExpr.map((expr, i) => ({ expr, label: colLabel[i] || '', format: colFormat[i] || 'none', total: colTotal[i] === '1', tagKey: colTagKey[i] || '' }));

  const paramKey = arr(body.param_key), paramLabel = arr(body.param_label), paramField = arr(body.param_field), paramDataKind = arr(body.param_datakind), paramAnchorTable = arr(body.param_anchortable), paramAnchorResolver = arr(body.param_anchorresolver);
  const parameters = paramField.map((field, i) => ({ key: paramKey[i] || '', label: paramLabel[i] || '', field, dataKind: paramDataKind[i] || '', anchorTable: paramAnchorTable[i] || '', anchorResolver: paramAnchorResolver[i] || '' }));

  const aggExpr = arr(body.agg_expr), aggFn = arr(body.agg_fn), aggLabel = arr(body.agg_label), aggFormat = arr(body.agg_format), aggTotal = arr(body.agg_total), aggTagKey = arr(body.agg_tagkey);
  const aggregates = aggExpr.map((expr, i) => ({ expr, fn: aggFn[i] || 'SUM', label: aggLabel[i] || '', format: aggFormat[i] || 'none', total: aggTotal[i] === '1', tagKey: aggTagKey[i] || '' }));

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
    const applet = schemaLib.updateApplet(schema, req.params.key, { ...req.body, columns: arr(req.body.columns), detailFields: arr(req.body.detailFields) });
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

function viewFormApplets(body, schema) {
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
    let linkField = r.linkField || '';
    // Siebel-style shared active row: a Detail applet that is a child of a
    // list applet on the SAME table simply shows the parent's selected
    // record, so its link is always that table's primary key. Set it
    // automatically — the user just picks the Parent Row, no need to know
    // or type the PK into the Link Field.
    if (schema && parentInstanceKey) {
      const applet = schemaLib.appletByKey(schema, r.appletKey);
      const parentApplet = schemaLib.appletByKey(schema, rows[parseInt(r.parentPosition, 10) - 1].appletKey);
      if (applet && applet.type === 'detail' && parentApplet && parentApplet.baseTable === applet.baseTable) {
        const ent = schema.entities[applet.baseTable];
        if (ent) linkField = ent.pk;
      }
    }
    return { instanceKey: instanceKeys[i], appletKey: r.appletKey, parentInstanceKey, linkField };
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
    const applets = viewFormApplets(req.body, req.schema);
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
    const applets = viewFormApplets(req.body, req.schema);
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
  res.render('admin/picklist-edit', { picklist: null, entities: req.schema.entities, error: req.query.error, notice: req.query.notice });
});

// Reads the bracket-notation rows a picklist/field-option editor submits
// (values[0][key], values[0][label], values[0][active], values[1][...],
// ...) into a clean array. qs parses this into an object keyed by
// whatever index each row used (not necessarily sequential — new rows
// added client-side get a fresh non-conflicting index), so this reads
// Object.values() rather than assuming a real array.
function readBracketedRows(body, paramName) {
  const raw = body[paramName];
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw).map(row => {
    // The active flag is submitted as a hidden "off" followed by a
    // checkbox "on" sharing the same bracketed name, so an unchecked box
    // yields "off" alone but a checked one yields BOTH — qs collects
    // same-key duplicates into an array (submission order), so the last
    // entry reflects whether the checkbox actually fired.
    let activeRaw = row && row.active;
    if (Array.isArray(activeRaw)) activeRaw = activeRaw[activeRaw.length - 1];
    return {
      key: (row && row.key) || '',
      label: (row && row.label) || '',
      active: activeRaw !== 'off',
    };
  });
}

router.post('/picklists', (req, res) => {
  const schema = req.schema;
  try {
    const values = readBracketedRows(req.body, 'values');
    const picklist = schemaLib.addPicklist(schema, { ...req.body, values });
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
    const values = readBracketedRows(req.body, 'values');
    const picklist = schemaLib.updatePicklist(schema, req.params.key, { ...req.body, values });
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

// ---- Template Library (bill/document templates) -------------------------

router.get('/templates', (req, res) => {
  res.render('admin/templates', { templates: schemaLib.templatesFor(req.schema), entities: req.schema.entities, notice: req.query.notice, error: req.query.error });
});

router.get('/templates/new', (req, res) => {
  res.render('admin/template-new', {
    entities: Object.values(req.schema.entities), reportDefs: schemaLib.reportDefsFor(req.schema),
    starters: templateStarters, error: req.query.error, notice: req.query.notice,
  });
});

router.post('/templates', (req, res) => {
  const schema = req.schema;
  try {
    const starter = templateStarters.find(s => s.key === req.body.starter);
    const kind = req.body.baseKind;
    const template = schemaLib.addTemplate(schema, kind === 'email' ? {
      baseKind: 'email', label: req.body.label, baseTable: req.body.baseTable,
      emailTo: req.body.emailTo, emailCc: req.body.emailCc, emailBcc: req.body.emailBcc,
      emailSubject: req.body.emailSubject, htmlBody: req.body.htmlBody || '',
    } : {
      baseKind: kind === 'report' ? 'report' : 'table',
      label: req.body.label,
      baseTable: req.body.baseTable,
      htmlBody: starter ? starter.htmlBody : '',
    });
    schemaLib.persist(schema);
    res.redirect(`/admin/templates/${template.key}/edit?notice=` + encodeURIComponent(`"${template.label}" created.`));
  } catch (err) {
    res.redirect('/admin/templates/new?error=' + encodeURIComponent(err.message));
  }
});

// Quick-iteration preview while editing a template — the merged HTML
// directly, not a PDF (PDF generation is real work; this is meant for
// "does this look right" while actively typing merge tags).
router.get('/templates/:key/preview', (req, res) => {
  const template = schemaLib.templateByKey(req.schema, req.params.key);
  if (!template) return res.status(404).send('Unknown template.');
  const entity = req.schema.entities[template.baseTable];
  if (!entity) return res.status(404).send('Base table no longer exists.');
  const record = db.getById(entity.key, entity.pk, req.query.id);
  if (!record) return res.status(404).send(`${entity.singular} "${req.query.id}" not found.`);
  const rendered = schemaLib.renderBillTemplate(req.schema, template, record);
  if (rendered.error) return res.status(400).send(rendered.error);
  res.send(rendered.html);
});

router.get('/templates/:key/edit', (req, res) => {
  const template = schemaLib.templateByKey(req.schema, req.params.key);
  if (!template) return res.status(404).send('Unknown template.');

  if (template.baseKind === 'email') {
    const baseEntity = req.schema.entities[template.baseTable];
    return res.render('admin/template-edit-email', { template, baseEntity, error: req.query.error, notice: req.query.notice });
  }

  if (template.baseKind === 'report') {
    const reportDef = schemaLib.reportDefByKey(req.schema, template.baseTable);
    if (!reportDef) return res.status(404).send('This template\'s report no longer exists.');
    const anchorParam = (reportDef.parameters || []).find(p => p.key === reportDef.headerAnchorParam);
    const anchorEntity = anchorParam ? req.schema.entities[anchorParam.anchorRef] : null;
    const columnItems = reportDef.groupBy
      ? [{ label: reportDef.groupByLabel || 'Group' }, ...(reportDef.aggregates || [])]
      : (reportDef.columns || []);
    const columnKeyMap = schemaLib.reportColumnKeyMap(columnItems);
    // Same "one hop deeper" tree the table-based editor's field-picker
    // already offers — e.g. a Tenant anchor's own T_MappedTo fk reaches
    // Landlord fields, which is exactly what a template combining
    // tenant + landlord details on one document needs.
    const anchorRelatedTrees = anchorEntity ? anchorEntity.fields.filter(f => f.type === 'fk').map(fk => ({
      fkFieldName: fk.name, fkLabel: fk.label, targetEntity: req.schema.entities[fk.ref],
    })).filter(r => r.targetEntity) : [];
    return res.render('admin/template-edit-report', {
      template, reportDef, anchorEntity, anchorRelatedTrees, columnKeyMap,
      hasTotals: reportDef.groupBy ? (reportDef.aggregates || []).some(a => a.total) : (reportDef.columns || []).some(c => c.total),
      error: req.query.error, notice: req.query.notice,
    });
  }

  const baseEntity = req.schema.entities[template.baseTable];
  // The field-picker's tree: the base table's own fields, plus every fk
  // relationship reachable from it (one hop deep in the tree UI, though
  // the merge engine itself supports any depth — a user can still hand-type
  // a deeper chain like {{A.B.C}} if they know it, the picker just doesn't
  // walk more than one level deep to keep the UI itself simple).
  const fkFields = baseEntity.fields.filter(f => f.type === 'fk');
  const relatedTrees = fkFields.map(fk => ({
    fkFieldName: fk.name, fkLabel: fk.label,
    targetEntity: req.schema.entities[fk.ref],
  })).filter(r => r.targetEntity);
  // Child tables eligible for the Line Items loop: any table with an fk
  // field pointing back at this base table.
  const childCandidates = Object.values(req.schema.entities)
    .filter(e => e.key !== template.baseTable)
    .map(e => ({ entity: e, fkFields: e.fields.filter(f => f.type === 'fk' && f.ref === template.baseTable) }))
    .filter(c => c.fkFields.length > 0);
  res.render('admin/template-edit', {
    template, baseEntity, fkFields, relatedTrees, childCandidates,
    error: req.query.error, notice: req.query.notice,
  });
});

router.post('/templates/:key', (req, res) => {
  const schema = req.schema;
  try {
    const existing = schemaLib.templateByKey(schema, req.params.key);
    const input = (existing && existing.baseKind === 'email') ? {
      baseKind: 'email', label: req.body.label, baseTable: existing.baseTable,
      emailTo: req.body.emailTo, emailCc: req.body.emailCc, emailBcc: req.body.emailBcc,
      emailSubject: req.body.emailSubject, htmlBody: req.body.htmlBody,
    } : {
      baseKind: req.body.baseKind === 'report' ? 'report' : 'table',
      label: req.body.label,
      baseTable: req.body.baseTable,
      htmlBody: req.body.htmlBody,
      pageOrientation: req.body.pageOrientation,
      lineItemsChildTable: req.body.lineItemsChildTable || null,
      lineItemsFkField: req.body.lineItemsFkField || null,
    };
    const updated = schemaLib.updateTemplate(schema, req.params.key, input);
    schemaLib.persist(schema);
    res.redirect(`/admin/templates/${updated.key}/edit?notice=` + encodeURIComponent('Template saved.'));
  } catch (err) {
    res.redirect(`/admin/templates/${req.params.key}/edit?error=` + encodeURIComponent(err.message));
  }
});

router.post('/templates/:key/delete', (req, res) => {
  const schema = req.schema;
  try {
    schemaLib.deleteTemplate(schema, req.params.key);
    schemaLib.persist(schema);
    res.redirect('/admin/templates?notice=' + encodeURIComponent('Template deleted.'));
  } catch (err) {
    res.redirect('/admin/templates?error=' + encodeURIComponent(err.message));
  }
});

router.get('/backup/download', (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="muneesh-legacy-backup-${stamp}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => { try { res.end(); } catch (e) { /* client gone */ } });
  archive.pipe(res);
  // NOTE: this is an explicit ALLOWLIST of files, and that is
  // load-bearing for security — data/secrets.json (the Telegram bot
  // token) lives in this same directory and must never enter a backup
  // archive, since backups get downloaded, emailed and restored on
  // other machines. If this is ever changed to archive the data
  // directory wholesale, secrets.json must be explicitly excluded.
  // See secrets.js for the full rationale.
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
    // A backup taken before a built-in module's tables existed restores a
    // schema WITHOUT them — and module table creation otherwise only runs
    // at boot, so the Bills tab (and its tables) would silently vanish
    // until the next restart. Re-run the same idempotent ensure step here
    // so a restore behaves exactly like a fresh boot of this version.
    // Runs after the schema commit (it loads from disk) and before the
    // redirect, so the very next page render already has the tables.
    billsLib.ensureBillsTables();
    remindersLib.ensureReminderTables();
    taxLib.ensureTaxTables();
    notify.ensureNotificationTables();
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

  // Read the same session-based list state the list view uses, so the
  // export matches exactly what the user is currently seeing.
  const listState = (req.session.listState && req.session.listState[req.params.entity]) || { q: '', filters: {}, sort: '', dir: 'asc' };
  let allRows = db.getAll(entity.key);

  // Text search (same as the list route's q filter)
  const q = (listState.q || '').trim().toLowerCase();
  if (q) {
    const searchFields = entity.fields.filter(f => !['spacer','section'].includes(f.type));
    allRows = allRows.filter(r => searchFields.some(f => String(r[f.name] ?? '').toLowerCase().includes(q)));
  }

  // Field filters from session (same keys as the list route)
  const filters = listState.filters || {};
  entity.fields.forEach(f => {
    const kind = schemaLib.filterKindFor(f);
    if (kind === 'date-range' || kind === 'number-range') {
      const from = (filters[`f_${f.name}_from`] || '').trim();
      const to = (filters[`f_${f.name}_to`] || '').trim();
      if (from || to) {
        allRows = allRows.filter(r => {
          const v = r[f.name];
          if (v == null || v === '') return false;
          if (kind === 'date-range') {
            if (from && String(v) < from) return false;
            if (to && String(v) > to) return false;
          } else {
            const n = Number(v);
            if (from && n < Number(from)) return false;
            if (to && n > Number(to)) return false;
          }
          return true;
        });
      }
    } else {
      const fv = (filters[`f_${f.name}`] || '').trim();
      if (fv) {
        allRows = allRows.filter(r => {
          if (f.type === 'bool') return (r[f.name] ? 'true' : 'false') === fv;
          return String(r[f.name] ?? '') === fv;
        });
      }
    }
  });

  // Sort (from session state)
  const sortField = listState.sort || entity.sortField || '';
  const sortDir = (listState.sort ? listState.dir : entity.sortDir) === 'desc' ? -1 : 1;
  if (sortField && entity.fields.some(f => f.name === sortField)) {
    allRows.sort((a, b) => {
      const va = a[sortField], vb = b[sortField];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return va < vb ? -sortDir : va > vb ? sortDir : 0;
    });
  }

  const rows = [header];
  allRows.forEach(r => {
    rows.push(fields.map(f => {
      const v = r[f.name];
      if (v === undefined || v === null) return '';
      if (f.type === 'bool') return v ? 'true' : 'false';
      if (f.type === 'picklist') return v === '' ? '' : String(schemaLib.resolvePicklistLabel(req.schema, entity, f, v));
      return String(v);
    }));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${entity.key}.csv"`);
  res.send('\uFEFF' + csv.stringify(rows));
});

// ---- Trash (soft-deleted records) ---------------------------------------
// A record's normal Delete button soft-deletes rather than removing it
// outright (see server.js's delete route + db.js's softDelete) — this is
// where those recoverable deletions actually live: restore them, or
// purge one for real before the scheduled 30-day auto-purge would.

router.get('/:entity/trash', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  const trashedRows = db.getTrash(entity.key).map(r => schemaLib.withComputedFields(req.schema, entity, r));
  res.render('admin/trash', { entity, rows: trashedRows, display: (e, r) => schemaLib.display(e, r, req.schema), notice: req.query.notice, error: req.query.error });
});

router.post('/:entity/trash/:id/restore', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  const restored = db.restore(entity.key, entity.pk, req.params.id);
  if (!restored) return res.redirect(`/admin/${entity.key}/trash?error=` + encodeURIComponent('Record not found in Trash.'));
  res.redirect(`/${entity.key}/${encodeURIComponent(req.params.id)}?notice=` + encodeURIComponent('Restored from Trash.'));
});

router.post('/:entity/trash/:id/purge', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  const record = db.getById(entity.key, entity.pk, req.params.id);
  db.remove(entity.key, entity.pk, req.params.id);
  // Image files were deliberately left alone at soft-delete time (in case
  // of a restore) — this is the actual permanent removal, so they get
  // cleaned up now instead.
  if (record) {
    entity.fields.filter(f => f.type === 'image').forEach(f => {
      if (record[f.name]) {
        const p = path.join(UPLOADS_DIR, entity.key, f.name, record[f.name]);
        if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) { /* best-effort */ }
      }
    });
  }
  res.redirect(`/admin/${entity.key}/trash?notice=` + encodeURIComponent('Permanently deleted.'));
});

router.get('/:entity/import', (req, res) => {
  const entity = req.schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  res.render('admin/import', { entity, fields: importableFields(entity), error: req.query.error, notice: req.query.notice, batchId: req.query.batchId || null, batchCount: req.query.batchCount || null });
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
        } else if (f.type === 'date' || f.type === 'timestamp') {
          if (val !== '') {
            const preferDayFirst = (req.body.dateFormat || 'dd-mm-yyyy') === 'dd-mm-yyyy';
            const normalized = schemaLib.normalizeDateValue(val, preferDayFirst);
            if (normalized === null) {
              throw new Error(`Row ${rowNum}: "${val}" is not a recognizable date for field "${f.label}" (${f.name}). Expected formats: dd-mm-yyyy, dd/mm/yyyy, yyyy-mm-dd, dd-Mon-yyyy, or an Excel serial number. No rows were imported.`);
            }
            val = normalized;
          }
        } else if (f.type === 'picklist') {
          // A CSV cell holds the LABEL a person actually typed/exported —
          // records store the stable KEY, so resolve label -> key against
          // this field's current active options. An unrecognized label
          // (renamed/retired since the file was made, or a typo) errors
          // clearly rather than silently storing text that matches nothing.
          const raw2 = String(val).trim();
          if (raw2 === '') {
            val = '';
          } else {
            const opts = schemaLib.resolvePicklistOptions(req.schema, entity, f);
            const match = opts.find(o => o.label === raw2) || opts.find(o => o.label.toLowerCase() === raw2.toLowerCase());
            if (!match) {
              throw new Error(`Row ${rowNum}: "${raw2}" is not a current option for "${f.label}" (${f.name}). Valid options: ${opts.map(o => o.label).join(', ') || '(none configured)'}. No rows were imported.`);
            }
            val = match.key;
          }
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

    // Every row validated — now commit all-or-nothing. Tagged with a
    // batch ID (an internal property, not a real schema field — never
    // rendered or exported, same as how other internal-only properties
    // already work) so this specific import can be undone as a unit
    // afterward, without needing to hand-pick which rows came from it.
    const importBatchId = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let nextAuto = null;
    toInsert.forEach(record => {
      if (record.__autoPk) {
        if (nextAuto === null) nextAuto = db.nextAutoId(entity.key, entity.pk);
        record[entity.pk] = nextAuto++;
        delete record.__autoPk;
      }
      schemaLib.assignSeriesFields(schema, entity, record);
      record.__importBatchId = importBatchId;
      db.insert(entity.key, record);
      if (entity.auditEnabled) {
        audit.log({ entityKey: entity.key, recordId: record[entity.pk], action: 'create', username: req.currentUser.username, before: null, after: record });
      }
    });

    res.redirect(`/admin/${entity.key}/import?notice=${encodeURIComponent(`Imported ${toInsert.length} record(s).`)}&batchId=${encodeURIComponent(importBatchId)}&batchCount=${toInsert.length}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/import?error=` + encodeURIComponent(err.message));
  }
});

// Undoes one import batch as a unit — blocks the WHOLE undo if ANY row
// from that batch is referenced by something else (e.g. a Bill created
// afterward pointing at an imported Tenant), rather than a partial undo
// that deletes what it safely can and leaves the rest — matching the
// same "block, don't silently orphan" principle used for regular
// deletes, and much simpler to reason about and explain than a partial
// result would be.
router.post('/:entity/import/undo/:batchId', (req, res) => {
  const schema = req.schema;
  const entity = schema.entities[req.params.entity];
  if (!entity) return res.status(404).send('Unknown table.');
  const rows = db.getAll(entity.key).filter(r => r.__importBatchId === req.params.batchId);
  if (rows.length === 0) {
    return res.redirect(`/admin/${entity.key}/import?error=` + encodeURIComponent('That import batch has nothing left to undo (already undone, or too old to still be tracked).'));
  }
  const blockedBy = [];
  rows.forEach(r => {
    const blockers = schemaLib.findBlockingReferences(schema, entity.key, r[entity.pk]);
    blockers.forEach(b => blockedBy.push(`${b.count} ${b.entityLabel} record(s) reference "${r[entity.pk]}"`));
  });
  if (blockedBy.length > 0) {
    return res.redirect(`/admin/${entity.key}/import?error=` + encodeURIComponent(`Cannot undo: ${blockedBy.join('; ')} — remove or reassign those first.`));
  }
  rows.forEach(r => {
    db.remove(entity.key, entity.pk, r[entity.pk]);
    if (entity.auditEnabled) {
      audit.log({ entityKey: entity.key, recordId: r[entity.pk], action: 'delete', username: req.currentUser.username, before: r, after: null });
    }
  });
  res.redirect(`/admin/${entity.key}/import?notice=` + encodeURIComponent(`Undone: ${rows.length} record(s) from that import removed.`));
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
    // Brand-new field: the compact "comma-separated" bootstrap input is
    // fine here since there are no existing records/keys to preserve yet.
    const picklistValues = String(req.body.newOptionsCsv || '')
      .split(',').map(s => s.trim()).filter(Boolean).map(label => ({ label }));
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
      picklistValues,
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
      fkWhere: req.body.fkWhere,
    });
    const newField = schema.entities[req.params.entity].fields.find(f => f.name === schemaLib.safeFieldName(req.body.name));
    // Schema changes (unlike record data changes) were never audited at
    // all before this — a field silently changing type, say, could break
    // every report/formula that touched it with no trace of when or by
    // whom. Reuses the same audit.js infrastructure as record changes,
    // distinguished by an entityKey prefixed "schema:" rather than a
    // separate logging system.
    audit.log({ entityKey: `schema:${req.params.entity}`, recordId: newField ? newField.name : req.body.name, action: 'create', username: req.currentUser.username, before: null, after: newField });
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/fields?notice=${encodeURIComponent('Field added.')}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/fields?error=` + encodeURIComponent(err.message));
  }
});

router.post('/:entity/fields/:field', (req, res) => {
  const schema = req.schema;
  try {
    const before = { ...schema.entities[req.params.entity].fields.find(f => f.name === req.params.field) };
    schemaLib.updateField(schema, req.params.entity, req.params.field, {
      label: req.body.label,
      type: req.body.type,
      ref: req.body.ref,
      required: req.body.required === 'on',
      inList: req.body.inList === 'on',
      rows: req.body.rows,
      formula: req.body.formula,
      format: req.body.format,
      picklistValues: readBracketedRows(req.body, 'picklistValues'),
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
      fkWhere: req.body.fkWhere, fkBulkLink: req.body.fkBulkLink === "on",
    });
    const after = schema.entities[req.params.entity].fields.find(f => f.name === req.params.field);
    audit.log({ entityKey: `schema:${req.params.entity}`, recordId: req.params.field, action: 'update', username: req.currentUser.username, before, after });
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/fields?notice=${encodeURIComponent('Field updated.')}`);
  } catch (err) {
    res.redirect(`/admin/${req.params.entity}/fields?error=` + encodeURIComponent(err.message));
  }
});

router.post('/:entity/fields/:field/delete', (req, res) => {
  const schema = req.schema;
  try {
    const before = { ...schema.entities[req.params.entity].fields.find(f => f.name === req.params.field) };
    schemaLib.deleteField(schema, req.params.entity, req.params.field);
    audit.log({ entityKey: `schema:${req.params.entity}`, recordId: req.params.field, action: 'delete', username: req.currentUser.username, before, after: null });
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
        // applyAppletFilter compares against the record's RAW stored value
        // (the key, not the label) — same reasoning as the fk branch just
        // below, which already offers {value: PK, label: display name}.
        valueOptions = schemaLib.resolvePicklistOptions(req.schema, targetEntity, valueField)
          .map(o => ({ value: o.key, label: o.label }));
      } else if (valueField && valueField.type === 'fk') {
        const refEntity = req.schema.entities[valueField.ref];
        valueOptions = refEntity ? db.getAll(refEntity.key).map(r => ({
          value: r[refEntity.pk],
          label: `${r[refEntity.pk]} \u2014 ${schemaLib.display(refEntity, r, req.schema)}`,
        })) : [];
      }
    }
    return { applet, setting, targetEntity, eligibleFields, valueField, valueOptions };
  }).filter(Boolean);

  res.render('admin/views', {
    entity, included, excluded, filterIncluded, filterExcluded, shownApplets, availableApplets: discoverable,
    filterKindFor: schemaLib.filterKindFor, numericFields: schemaLib.numericFieldsFor(entity),
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

router.post('/:entity/views/totals', (req, res) => {
  const schema = req.schema;
  try {
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));
    const fields = arr(req.body.totalField);
    const fns = arr(req.body.totalFn);
    const totals = fields.map((field, i) => ({ field, fn: fns[i] }));
    schemaLib.updateListTotals(schema, req.params.entity, totals);
    schemaLib.persist(schema);
    res.redirect(`/admin/${req.params.entity}/views?notice=${encodeURIComponent('List Totals saved.')}`);
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
      // 'email' = may send an email (from a record) for this table. Only
      // meaningful where the table has email templates; the matrix only
      // renders the checkbox there, so it's absent (false) elsewhere.
      email: body[`perm_${key}_email`] === 'on',
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

// ---- Themes ----------------------------------------------------------------
router.get('/themes', (req, res) => {
  res.render('admin/themes', { error: req.query.error, notice: req.query.notice, customTheme: {} });
});
router.post('/themes', (req, res) => {
  // Theme is persisted per-device in localStorage by the client JS — this
  // POST just redirects back with a notice so it feels like a save.
  const theme = req.body.theme || 'siebel';
  res.redirect('/admin/themes?notice=' + encodeURIComponent('Theme set to ' + theme + '. Saved in your browser for this device.'));
});

// ---- Bulk Generate ---------------------------------------------------------
router.get('/bulk-generate', (req, res) => {
  const schema = req.schema;
  schemaLib.ensureBulkGenerateProfiles(schema);
  res.render('admin/bulk-generate', { profiles: schema.bulkGenerateProfiles, entities: schema.entities, error: req.query.error, notice: req.query.notice });
});

router.post('/bulk-generate/profile', (req, res) => {
  const schema = req.schema;
  try {
    const mappings = [];
    const tfs = [].concat(req.body.map_target || []);
    const svs = [].concat(req.body.map_value || []);
    tfs.forEach((tf, i) => { if (tf && tf.trim()) mappings.push({ targetField: tf.trim(), value: (svs[i] || '').trim() }); });
    schemaLib.addBulkGenerateProfile(schema, {
      label: req.body.label, sourceTable: req.body.sourceTable, sourceFilter: req.body.sourceFilter,
      sourceSort: req.body.sourceSort, targetTable: req.body.targetTable, fieldMappings: mappings,
      monthField: req.body.monthField, dedupField: req.body.dedupField, dedupSourceField: req.body.dedupSourceField,
    });
    res.redirect('/admin/bulk-generate?notice=' + encodeURIComponent('Profile created.'));
  } catch (e) { res.redirect('/admin/bulk-generate?error=' + encodeURIComponent(e.message)); }
});

router.post('/bulk-generate/:key/delete', (req, res) => {
  schemaLib.deleteBulkGenerateProfile(req.schema, req.params.key);
  res.redirect('/admin/bulk-generate?notice=' + encodeURIComponent('Profile deleted.'));
});

router.get('/bulk-generate/:key/edit', (req, res) => {
  const schema = req.schema;
  schemaLib.ensureBulkGenerateProfiles(schema);
  const profile = (schema.bulkGenerateProfiles || []).find(p => p.key === req.params.key);
  if (!profile) return res.redirect('/admin/bulk-generate?error=' + encodeURIComponent('Unknown profile.'));
  res.render('admin/bulk-generate-edit', { profile, entities: schema.entities, error: req.query.error, notice: req.query.notice });
});

router.post('/bulk-generate/:key/edit', (req, res) => {
  const schema = req.schema;
  try {
    const mappings = [];
    const tfs = [].concat(req.body.map_target || []);
    const svs = [].concat(req.body.map_value || []);
    tfs.forEach((tf, i) => { if (tf && tf.trim()) mappings.push({ targetField: tf.trim(), value: (svs[i] || '').trim() }); });
    schemaLib.updateBulkGenerateProfile(schema, req.params.key, {
      label: req.body.label, sourceFilter: req.body.sourceFilter,
      sourceSort: req.body.sourceSort, fieldMappings: mappings,
      monthField: req.body.monthField, dedupField: req.body.dedupField, dedupSourceField: req.body.dedupSourceField,
    });
    schemaLib.persist(schema);
    res.redirect('/admin/bulk-generate?notice=' + encodeURIComponent('Profile updated.'));
  } catch (e) { res.redirect(`/admin/bulk-generate/${req.params.key}/edit?error=` + encodeURIComponent(e.message)); }
});

router.post('/bulk-generate/:key/run', (req, res) => {
  const schema = req.schema;
  const profile = (schema.bulkGenerateProfiles || []).find(p => p.key === req.params.key);
  if (!profile) return res.redirect('/admin/bulk-generate?error=' + encodeURIComponent('Unknown profile.'));
  const month = req.body.month || '';
  const sourceEntity = schema.entities[profile.sourceTable];
  const targetEntity = schema.entities[profile.targetTable];
  if (!sourceEntity || !targetEntity) return res.redirect('/admin/bulk-generate?error=' + encodeURIComponent('Source or target table no longer exists.'));

  const db = require('../db');
  let sourceRows = db.getAll(profile.sourceTable).filter(r => !r.__deletedAt);

  // Apply source filter (formula)
  if (profile.sourceFilter && profile.sourceFilter.trim()) {
    sourceRows = sourceRows.filter(r => {
      try { return schemaLib.evalFormula(profile.sourceFilter, schema, sourceEntity, r, {}, 0); }
      catch (e) { return false; }
    });
  }

  // Sort by sourceSort field
  if (profile.sourceSort && sourceEntity.fields.some(f => f.name === profile.sourceSort)) {
    sourceRows.sort((a, b) => {
      const va = a[profile.sourceSort], vb = b[profile.sourceSort];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
  }

  // Dedup: skip source rows that already have a target record for this month
  let existingTargets = [];
  if (profile.dedupField && profile.dedupSourceField && month) {
    existingTargets = db.getAll(profile.targetTable).filter(r => !r.__deletedAt && r[profile.monthField] === month);
  }

  let created = 0, skipped = 0;
  sourceRows.forEach(srcRow => {
    // Dedup check
    if (profile.dedupField && profile.dedupSourceField && month) {
      const srcVal = String(srcRow[profile.dedupSourceField] || '');
      if (existingTargets.some(t => String(t[profile.dedupField] || '') === srcVal)) { skipped++; return; }
    }

    // Build the target record using the FULL record creation pipeline —
    // not just the mapped fields. Start with an empty record (every field
    // initialised to its default), apply field defaults, overlay the
    // profile's field mappings, then assign auto-PK + series fields.
    // This matches exactly what the normal form POST does, so the
    // generated records have proper row IDs, series numbers, defaults,
    // and complete field structure — not just the handful of mapped fields.
    const newRecord = {};
    targetEntity.fields.forEach(f => {
      if (f.type === 'spacer' || f.type === 'section') return;
      newRecord[f.name] = '';
    });
    schemaLib.applyFieldDefaults(schema, targetEntity, newRecord);

    // Overlay the month field
    if (profile.monthField && month) newRecord[profile.monthField] = month;

    // Overlay the field mappings from the source row
    (profile.fieldMappings || []).forEach(m => {
      if (srcRow.hasOwnProperty(m.value)) {
        newRecord[m.targetField] = srcRow[m.value];
      } else {
        newRecord[m.targetField] = m.value;
      }
    });

    // Auto-PK (if the target table uses an auto-numbered primary key)
    const pkField = targetEntity.fields.find(f => f.key);
    if (pkField && pkField.auto) newRecord[targetEntity.pk] = db.nextAutoId(profile.targetTable, targetEntity.pk);

    // Series fields (auto-numbered sequences like bill numbers)
    schemaLib.assignSeriesFields(schema, targetEntity, newRecord);

    db.insert(profile.targetTable, newRecord);
    created++;
  });

  res.redirect('/admin/bulk-generate?notice=' + encodeURIComponent(created + ' record(s) created, ' + skipped + ' skipped (already exist).'));
});
