// schema.js
// Loads/saves the editable application schema (data/schema.json) and
// provides mutation helpers used by the /admin routes. This is what makes
// the app self-sufficient: tables, fields, order, and foreign keys are all
// data, not code.

const fs = require('fs');
const { atomicWriteFileSync } = require('./fsutil');
const path = require('path');
const defaultSchema = require('./default-schema');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const SCHEMA_FILE = path.join(DATA_DIR, 'schema.json');

const FIELD_TYPES = ['text', 'number', 'date', 'timestamp', 'bool', 'textarea', 'fk', 'currency', 'percent', 'image', 'file', 'formula', 'picklist', 'series', 'rollup', 'spacer', 'section'];
// Layout-only types: hold no data, never saved, never in list columns, never importable/exportable.
const LAYOUT_TYPES = ['spacer', 'section'];

// Admin's own built-in pages (as opposed to a table that's been moved in)
// — key, label, and route, in what was the old hardcoded subnav order.
// Used both to seed schema.adminSubnavOrder on first load and to render
// the subnav itself, since a moved-in table needs to be interleaved with
// these by position, not just appended after them.
const ADMIN_SUBNAV_FIXED_PAGES = {
  tables: { label: 'Tables', href: '/admin' },
  views: { label: 'Views', href: '/admin/views' },
  users: { label: 'Users', href: '/admin/users' },
  audit: { label: 'Audit Log', href: '/admin/audit' },
  backup: { label: 'Backup', href: '/admin/backup' },
  errors: { label: 'Errors', href: '/admin/errors' },
  payqr: { label: 'PayQR Settings', href: '/admin/payqr-settings' },
  themes: { label: 'Themes', href: '/admin/themes' },
  'bulk-generate': { label: 'Bulk Generate', href: '/admin/bulk-generate' },
  'tax-settings': { label: 'Tax Settings', href: '/admin/tax-settings' },
  session: { label: 'Session', href: '/admin/session-settings' },
  reports: { label: 'Reports', href: '/admin/reports' },
  applets: { label: 'Applets', href: '/admin/applets' },
  composedViews: { label: 'Custom Views', href: '/admin/composed-views' },
  screens: { label: 'Screens', href: '/admin/screens' },
  picklists: { label: 'Picklists', href: '/admin/picklists' },
  templates: { label: 'Templates', href: '/admin/templates' },
  sidebar: { label: 'Sidebar', href: '/admin/sidebar' },
  'home-screen': { label: 'Home Screen', href: '/admin/home-screen' },
  help: { label: 'Help', href: '/admin/help' },
  notifications: { label: 'Notifications', href: '/admin/notifications' },
  'data-health': { label: 'Data Health', href: '/admin/data-health' },
};
const ADMIN_SUBNAV_FIXED_KEYS = Object.keys(ADMIN_SUBNAV_FIXED_PAGES);
// Computed types: value is derived, never taken from a form or CSV import.
const COMPUTED_TYPES = ['formula', 'rollup', 'series'];

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SCHEMA_FILE)) atomicWriteFileSync(SCHEMA_FILE, JSON.stringify(defaultSchema, null, 2));
}

function load() {
  ensure();
  const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  return normalizeSchema(schema);
}

// Extracted from load() so an uploaded/in-memory schema (e.g. during a
// Backup Restore) can be run through the exact same migration and shape
// validation as a normal disk-based boot — catching a structurally
// broken schema (missing "entities", wrong types, etc.) before it's
// ever committed to disk, rather than a shallow "is this valid JSON"
// check that lets a malformed-but-parseable file through, only to crash
// every subsequent request (including the Backup page needed to fix it).
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || !schema.entities || typeof schema.entities !== 'object' || Array.isArray(schema.entities)) {
    throw new Error('This schema is missing a valid "entities" object \u2014 it doesn\'t look like a real Muneesh Legacy schema.json.');
  }
  // Migrate older schema.json files: list-view config used to be implicit
  // (whichever fields had inList:true, in field/form order). It's now an
  // explicit, independently-orderable list per entity (see "Views" in Admin).
  Object.values(schema.entities).forEach(e => {
    if (!Array.isArray(e.listColumns)) {
      e.listColumns = e.fields.filter(f => f.inList).map(f => f.name);
    }
    if (typeof e.sortField !== 'string') e.sortField = '';
    if (e.sortDir !== 'asc' && e.sortDir !== 'desc') e.sortDir = 'asc';
    if (!Array.isArray(e.filterFields)) e.filterFields = [];
    // Per-table List Totals — which numeric fields get a Sum/Average/Max/Min
    // shown in a totals row at the bottom of that table's List screen.
    // { field: fieldName, fn: 'sum'|'avg'|'max'|'min' }
    if (!Array.isArray(e.listTotals)) e.listTotals = [];
    // Configurable child applets: auto-populate with whatever currently
    // auto-discovers as a child/grandchild applet, so existing installs see
    // zero change until someone actively edits Views -> Child Applets.
    if (!Array.isArray(e.appletSettings)) {
      e.appletSettings = discoverApplets(schema, e.key).map(a => ({ instanceKey: `${a.appletKey}#1`, baseKey: a.appletKey, label: '', filterField: '', filterValue: '', filterFrom: '', filterTo: '' }));
    } else {
      // Migrate pre-multi-instance entries (a bare "key", no instanceKey/
      // baseKey split) to the new shape — same relationship, now framed as
      // its first instance, so behavior is unchanged until someone adds a
      // second instance of the same applet.
      e.appletSettings.forEach(s => {
        if (!s.instanceKey) {
          s.baseKey = s.key;
          s.instanceKey = `${s.key}#1`;
          s.label = s.label || '';
          delete s.key;
        }
      });
    }
  });

  // PayQR field-role settings: which field on Payees/Payments plays each
  // role the QR/narration logic needs. Auto-populated from today's actual
  // field names on first load after this feature ships, so existing
  // installs keep working with zero action needed — this only matters if
  // the user later renames/restructures those tables.
  if (!schema.payqrSettings) {
    schema.payqrSettings = { payeeUpiField: '', payeeMethodField: '', payeeNarrationField: '', paymentAmountField: '', paymentNotesField: '', paymentDateField: '' };
    const payeesEntity = schema.entities.payees;
    const paymentsEntity = schema.entities.payments;
    if (payeesEntity && payeesEntity.fields.some(f => f.name === 'PAY_UPI_ID')) schema.payqrSettings.payeeUpiField = 'PAY_UPI_ID';
    if (payeesEntity && payeesEntity.fields.some(f => f.name === 'PAY_Method')) schema.payqrSettings.payeeMethodField = 'PAY_Method';
    if (payeesEntity && payeesEntity.fields.some(f => f.name === 'PAY_NarrationTemplate')) schema.payqrSettings.payeeNarrationField = 'PAY_NarrationTemplate';
    if (paymentsEntity && paymentsEntity.fields.some(f => f.name === 'PMT_Amount')) schema.payqrSettings.paymentAmountField = 'PMT_Amount';
    if (paymentsEntity && paymentsEntity.fields.some(f => f.name === 'PMT_Notes')) schema.payqrSettings.paymentNotesField = 'PMT_Notes';
    if (paymentsEntity && paymentsEntity.fields.some(f => f.name === 'PMT_Date')) schema.payqrSettings.paymentDateField = 'PMT_Date';
  } else if (schema.payqrSettings.payeeMethodField === undefined) {
    // Migrating an install that already has payqrSettings from before this
    // role existed: same auto-populate logic, just for the one new field.
    const payeesEntity = schema.entities.payees;
    schema.payqrSettings.payeeMethodField = (payeesEntity && payeesEntity.fields.some(f => f.name === 'PAY_Method')) ? 'PAY_Method' : '';
  }

  // Email transport settings (non-secret half — the SMTP password lives in
  // secrets.js, never in the schema/backups). Everything defaults empty/off,
  // so email stays inert until an admin configures it in Admin -> Email.
  if (!schema.emailSettings) {
    schema.emailSettings = {
      host: '', port: 587, secure: false,
      username: '', fromName: '', fromAddress: '', replyTo: '',
      notifyChannel: false,   // Layer 3: also deliver notification sources by email
      notifyEmailTo: '',      // address(es) notifications are emailed to
      logRetentionDays: 90,   // email_log rows older than this are purged
    };
  }

  // Idle session timeout, in minutes. Admin-configurable (Admin -> Session);
  // 30 is a reasonable default for a data-entry app — long enough that
  // filling in a big Bill/Tenant form doesn't risk losing work, short
  // enough to matter as a real security control.
  if (typeof schema.sessionTimeoutMinutes !== 'number' || schema.sessionTimeoutMinutes <= 0) {
    schema.sessionTimeoutMinutes = 30;
  }

  // Left sidebar structure (Admin -> Sidebar) — an ordered list of
  // collapsible groups, each holding an ordered list of links (a real
  // table, a mini-app route, or a custom Screen). Replaces the old flat
  // navOrder as the actual thing rendered; navOrder itself is untouched
  // and still drives permission-filtering and "which tables exist to add"
  // in the sidebar's own admin editor, so nothing else that reads navOrder
  // needs to change. Migrated once, the first time an existing install
  // loads a schema with no sidebarGroups yet: everything from navOrder
  // plus the known built-in mini-app routes land in one "All Tables"
  // group, each with a best-effort icon guessed from its own table key —
  // a reasonable starting point, not a design statement; the whole point
  // of the admin editor is to let it be rearranged into real groups with
  // real icon choices afterward. An install that's already customized
  // this (sidebarGroups exists) is left completely alone.
  if (!Array.isArray(schema.sidebarGroups)) {
    schema.sidebarGroups = migrateSidebarGroups(schema);
  }

  // Home Screen widgets (Admin -> Home Screen) — an ordered list of
  // widget instances, each a real, predefined type (see home.js's
  // WIDGET_TYPES) with its own small config where relevant. Migrated once
  // the first time an existing install loads a schema with no
  // homeWidgets yet, matching what the Home page already showed before
  // this existed: just the Due Soon panel — so nothing a user sees
  // changes on upgrade until they actually visit Admin -> Home Screen and
  // add more. home.js can't be required here (it requires schema.js
  // itself), so the one-line default lives directly in this migration
  // rather than calling out to home.js for it.
  if (!Array.isArray(schema.homeWidgets)) {
    schema.homeWidgets = [{ id: 'due-soon-default', type: 'due-soon', config: {} }];
  }

  // Report definitions (Admin -> Reports) — data, not code, so a report's
  // field references are editable from Admin rather than baked into a
  // .js file. See runReport() below for how these get executed.
  if (!Array.isArray(schema.reportDefs)) schema.reportDefs = [];

  // Applet / View / Screen — a Siebel-mapped layer on top of the existing
  // table-centric screens. An Applet is a reusable, independent list/detail
  // definition bound to one table; a View is an ordered collection of
  // Applet *instances*, where a child instance can declare a parent
  // instance (in the same View) plus a linkField, so its rows re-filter
  // based on whatever's currently selected in the parent; a Screen is an
  // ordered collection of Views. None of this replaces the existing
  // per-table List/Detail screens — old and new can coexist table by table.
  if (!Array.isArray(schema.applets)) schema.applets = [];
  if (!Array.isArray(schema.views)) schema.views = [];
  if (!Array.isArray(schema.screens)) schema.screens = [];

  // Global Picklists (Admin -> Picklists) — a centrally-defined, reusable
  // value list, mapped on Siebel's "List of Values" concept. A picklist-
  // type field can point at one of these (picklistSource: 'global') as
  // an alternative to typing its own one-off comma-separated options.
  // Two source shapes: 'static' (admin-typed values, each with an
  // active flag so a retired option can be deactivated without breaking
  // historical records that already used it) and 'table' (options
  // pulled live from an actual table's field — e.g. every card name in
  // the Banking table — optionally further constrained by another field
  // on the record being edited, matching what's shown to what's actually
  // relevant, e.g. only THIS record's own account type's cards).
  if (!Array.isArray(schema.picklists)) schema.picklists = [];

  // Template Library — bill/invoice/document templates. One per table for
  // now (deliberately, not a design limitation of the data shape itself —
  // just the simplest thing that satisfies "one template per table" as
  // currently needed; revisit if/when multiple templates per table is
  // actually wanted).
  if (!Array.isArray(schema.templates)) schema.templates = [];

  // Admin's own subnav (Tables/Views/Users/.../Help) is now a dynamic,
  // orderable list rather than a fixed sequence — this is what makes
  // "move a screen into Admin" meaningful, since a moved-in table needs
  // a place in that same order. Auto-populated with today's fixed order
  // on first load so existing installs see zero change until something
  // actually gets moved in or reordered.
  if (!Array.isArray(schema.adminSubnavOrder)) {
    schema.adminSubnavOrder = [...ADMIN_SUBNAV_FIXED_KEYS];
  } else {
    // Migrating an existing install whose adminSubnavOrder was saved
    // before some newer fixed page (Journey, Applets, ...) existed —
    // append any missing ones at the end rather than losing them.
    ADMIN_SUBNAV_FIXED_KEYS.forEach(k => {
      if (!schema.adminSubnavOrder.includes(k)) schema.adminSubnavOrder.push(k);
    });
  }
  Object.values(schema.entities).forEach(e => {
    if (typeof e.inAdmin !== 'boolean') e.inAdmin = false;
  });

  return schema;
}

function persist(schema) {
  atomicWriteFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2));
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
}

function safeFieldName(s) {
  let n = String(s || '').trim().replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z_]/.test(n)) n = 'f_' + n;
  return n;
}

// Resolve a display string for a record, given its entity config.
// `schema` is optional (many older callers don't have it in scope) — when
// omitted, a picklist/formula/rollup-typed displayField falls back to its
// raw value (blank for computed fields, since they're never actually
// stored — same as before this fix). When passed, both cases resolve
// correctly: a picklist's stored key resolves to its current label, and
// a formula/rollup field (never present on the raw record at all — it
// only exists once computed) is evaluated on demand. This matters because
// entity.displayField can be either kind — e.g. a "Month Year" picklist,
// or a composite "Tenant — Month Year" formula built from other fields.
function display(entity, record, schema) {
  if (!record) return '';
  if (entity.displayField) {
    const f = schema ? entity.fields.find(fl => fl.name === entity.displayField) : null;
    if (schema && f && (f.type === 'formula' || f.type === 'rollup')) {
      const val = resolveComputedField(schema, entity, record, f, new Set(), 0);
      if (val !== undefined && val !== null && val !== '') return val;
    } else if (record[entity.displayField] !== undefined && record[entity.displayField] !== '') {
      const raw = record[entity.displayField];
      if (schema && f && f.type === 'picklist') return resolvePicklistLabel(schema, entity, f, raw);
      return raw;
    }
  }
  if (entity.displayPrefix) return `${entity.displayPrefix}${record[entity.pk]}`;
  return record[entity.pk];
}

// Resolves an entity's configured list-view columns (see "Views" in Admin)
// to actual field objects, in the admin-chosen order.
function listFieldsFor(entity) {
  return (entity.listColumns || []).map(name => entity.fields.find(f => f.name === name)).filter(Boolean);
}

// Applet titles are editable per-table, with sensible defaults if left blank.
function listTitle(entity) {
  return (entity.listTitle && entity.listTitle.trim()) || `${entity.label} List`;
}
function detailTitle(entity) {
  return (entity.detailTitle && entity.detailTitle.trim()) || `${entity.singular} Detail`;
}

// ---- Indian-style currency formatting (₹x,xx,xxx.xx) ----------------------
function formatINR(value) {
  if (value === '' || value === null || value === undefined) return '';
  const num = Number(value);
  if (isNaN(num)) return '';
  const isNeg = num < 0;
  const fixed = Math.abs(num).toFixed(2);
  const [intPart, dec] = fixed.split('.');
  let lastThree = intPart.substring(intPart.length - 3);
  const other = intPart.substring(0, intPart.length - 3);
  if (other !== '') lastThree = ',' + lastThree;
  const formattedInt = other.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;
  return (isNeg ? '-' : '') + '\u20B9' + formattedInt + '.' + dec;
}

// Percent fields store the raw fraction (0.18) and always display ×100 with
// a % sign (18%). Rounds to 2 decimals, trimming trailing zeros.
function formatPercent(value) {
  if (value === '' || value === null || value === undefined) return '';
  const num = Number(value) * 100;
  if (isNaN(num)) return '';
  const rounded = Math.round(num * 100) / 100;
  return `${rounded}%`;
}

// ---- Calculated ("formula") fields -----------------------------------------
// Admin-authored expressions referencing other field names on the same
// table, e.g. "T_Invoice_Value * T_Share / 100" — using "x.y" syntax, fields
// on a linked table via a foreign key, e.g. "tenants.T_Invoice_Value" —
// Excel-style functions like IF/ROUND/CONCAT — and LOOKUP() for scanning an
// arbitrary table. Evaluated in a locked-down Function scope with a strict
// character whitelist and a banned-token check — admin-only feature, but we
// still avoid handing out a raw eval.
//
// Quoted string literals are allowed (needed for LOOKUP conditions and text
// functions), but since our "x.y" cross-table syntax is a blind text
// substitution, we mask out quoted substrings before doing that
// substitution so dots *inside* strings are never touched, then restore
// them verbatim right before compiling.
const FORMULA_SAFE_RE = /^[a-zA-Z0-9_\s+\-*/().,<>=!&|?:%'"#]*$/;
const FORMULA_BANNED_RE = /\b(function|constructor|prototype|process|require|import|global|this|window|eval|Function|module|__proto__)\b/;
const MAX_LOOKUP_DEPTH = 5;

function maskQuotedStrings(str) {
  const literals = [];
  const masked = str.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => {
    literals.push(m);
    return `\u0001${literals.length - 1}\u0001`;
  });
  return { masked, literals };
}
function unmaskQuotedStrings(str, literals) {
  return str.replace(/\u0001(\d+)\u0001/g, (m, i) => literals[Number(i)]);
}

// Formula authors write "=" for equality (spreadsheet convention, and how
// LOOKUP conditions read naturally) — but bare "=" is JS *assignment*
// syntax. Convert standalone "=" to "===", leaving <=, >=, ==, != alone.
function convertEquals(str) {
  return str.replace(/([<>=!])?=(?!=)/g, (m, prefix) => (prefix ? m : '==='));
}

// AND / OR / NOT read naturally as infix words (spreadsheet/SQL WHERE-clause
// style, e.g. "X AND Y"), so they're keywords, not callable functions.
function convertLogicalKeywords(str) {
  // AND/OR/NOT are the app's logical keywords; TRUE/FALSE round out the set
  // as boolean literals. All are matched on whole-word boundaries only, and
  // this runs on the already-masked formula (string literals protected), so
  // a quoted "TRUE" or a field name like `Truest` is untouched. TRUE/FALSE
  // are case-insensitive (so TRUE, True and the already-valid lowercase true
  // all normalise to JS `true`) — the one accepted edge case is that a field
  // literally named `TRUE`/`FALSE` would be shadowed by the literal, but
  // that's a pathological name we don't support.
  return str
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||')
    .replace(/\bNOT\b/g, '!')
    .replace(/\bTRUE\b/gi, 'true')
    .replace(/\bFALSE\b/gi, 'false');
}

// Resolves "<fk field name or fk target table key>.<remote field name>"
// against a record on `entity`, following the fk to fetch the linked row.
// Returns {value} on success, or {error} when the reference itself is bad
// (unknown link, or a field name that doesn't exist on the target table) —
// distinct from a legitimately blank value, so a typo doesn't masquerade
// as "no data" / "no match" somewhere downstream.
function resolveCrossTableValue(schema, entity, record, refPart, fieldPart) {
  let fkField = entity.fields.find(f => f.type === 'fk' && f.name === refPart);
  if (!fkField) fkField = entity.fields.find(f => f.type === 'fk' && f.ref === refPart);
  if (!fkField) return { error: `#REF: "${refPart}" is not a linked table on this record` };
  const refEntity = schema.entities[fkField.ref];
  if (!refEntity) return { error: `#REF: linked table for "${refPart}" no longer exists` };
  const remoteField = refEntity.fields.find(f => f.name === fieldPart);
  if (!remoteField) {
    return { error: `#REF: no such field "${fieldPart}" on ${refEntity.key}` };
  }
  const fkValue = record[fkField.name];
  if (!fkValue) return { value: undefined, field: remoteField };
  // Trash-aware: getByIdActive returns null for a soft-deleted parent,
  // so this cross-table read collapses to blank (identical to how a
  // dangling fk already behaves) instead of surfacing the trashed row's
  // stale fields. Same reasoning applies to the two other fk-hop sites
  // in this file (multi-hop dotted chains and merge templates) — those
  // use the same call. See db.js:getByIdActive for the full rationale.
  const remote = db.getByIdActive(refEntity.key, refEntity.pk, fkValue);
  if (!remote) return { value: undefined, field: remoteField };
  return { value: remote[fieldPart], field: remoteField };
}

// Multi-hop version of resolveCrossTableValue above — walks a dotted
// chain of any length (e.g. T_PropCode.P_Landlord.LL_Display: Tenant ->
// Property via one real fk, Property -> Landlord via another, then read
// LL_Display), one fk hop at a time, carrying the resolved *record*
// (with its own formula/rollup fields computed, so a later segment can
// reference a computed field too, not just a stored one) forward until
// the final segment, which is where an actual field value gets read.
// Previously, evalFormula only ever resolved exactly one hop
// (resolveCrossTableValue above) — a 3+ part chain would resolve the
// first hop to a raw value, then silently return `undefined` trying to
// read a further ".field" off of that raw value in the compiled
// expression, no error at all. Reuses the same shape of logic
// resolveMergeChain already implements correctly for PDF merge tags
// (`{{HeaderPanel.X.Y.Z}}`), so formulas and merge tags now behave
// consistently instead of merge tags alone supporting real depth.
// extraScopes (ANCHOR.VALUE, a LOOKUP condition's own scanned-row
// scope, etc.) can only ever be the *first* segment of a chain, never a
// middle one — those scopes are a single injected row, not a navigable
// entity with its own further fk hops, so a chain starting there is
// still exactly the two-part shape those scopes have always supported.
function resolveFormulaChain(schema, entity, record, extraScopes, segments) {
  let schemaEntity = entity;
  let dataRecord = record;
  let i = 0;
  const firstScope = extraScopes[segments[0]];
  if (firstScope) {
    schemaEntity = firstScope.entity;
    dataRecord = firstScope.row;
    i = 1;
    // A scope's row is a single injected value, not a navigable entity
    // with further fk hops of its own — a chain any deeper than the
    // scope's own field doesn't make sense (ANCHOR only ever has VALUE).
    if (segments.length - i > 1) {
      return { error: `#REF: "${segments[0]}" doesn't have further linked tables to follow` };
    }
  }

  // Pass 1 — validate every hop against the SCHEMA, independent of what
  // real data exists. Which entity a chain lands on is always knowable
  // this way (an fk's own .ref names its target regardless of whether
  // any particular record's fk value is actually set), so a genuinely
  // broken reference — a fk that doesn't exist, or a final field that
  // isn't real — always errors, even when an earlier fk value in the
  // chain happens to be blank on this specific record. Without this
  // pass, a chain through a currently-unset fk would silently look like
  // a normal "nothing linked yet" blank instead of the actual mistake it
  // is, exactly the gap the one-hop version never had.
  let walkEntity = schemaEntity;
  const fkFieldsInOrder = [];
  for (let j = i; j < segments.length - 1; j++) {
    const seg = segments[j];
    let fkField = walkEntity.fields.find(f => f.type === 'fk' && f.name === seg);
    if (!fkField) fkField = walkEntity.fields.find(f => f.type === 'fk' && f.ref === seg);
    if (!fkField) return { error: `#REF: "${seg}" is not a linked table on ${walkEntity.key}` };
    const refEntity = schema.entities[fkField.ref];
    if (!refEntity) return { error: `#REF: linked table for "${seg}" no longer exists` };
    fkFieldsInOrder.push(fkField);
    walkEntity = refEntity;
  }
  const finalSeg = segments[segments.length - 1];
  const finalField = walkEntity.fields.find(f => f.name === finalSeg);
  if (!finalField) return { error: `#REF: no such field "${finalSeg}" on ${walkEntity.key}` };

  // Pass 2 — now walk the actual data. A blank fk value partway through
  // is a normal, unremarkable state (this particular record just doesn't
  // link that far yet), not an error — every schema-level check already
  // passed above, so this can only ever come up blank, never wrong.
  let currentEntity = schemaEntity;
  let currentRecord = dataRecord;
  for (const fkField of fkFieldsInOrder) {
    if (!currentRecord) return { value: undefined, field: finalField };
    const fkValue = currentRecord[fkField.name];
    if (!fkValue) return { value: undefined, field: finalField };
    const refEntity = schema.entities[fkField.ref];
    const remote = db.getByIdActive(refEntity.key, refEntity.pk, fkValue);
    if (!remote) return { value: undefined, field: finalField };
    currentEntity = refEntity;
    currentRecord = withComputedFields(schema, refEntity, remote);
  }
  if (!currentRecord) return { value: undefined, field: finalField };
  let finalValue = currentRecord[finalSeg];
  if (finalField.type === 'picklist' && finalValue !== undefined && finalValue !== null && finalValue !== '') {
    finalValue = resolvePicklistLabel(schema, currentEntity, finalField, finalValue);
  }
  return { value: finalValue, field: finalField };
}


// ---- Bill/Document Templates (Template Library) -------------------------
// Merge-tag template engine: {{FieldName}} for a field on the current
// record, {{Related.Related2.FieldName}} for a chain across fk lookups
// of any depth (each segment before the last is either an fk field's own
// name or its target table's key — the same two ways formulas' LOOKUP()
// already accepts, deliberately kept consistent with that rather than
// inventing a second convention), and {{#each LineItems}}...{{/each}} to
// repeat a block once per row of a configured child table.

// Walks every segment except the last as an fk hop (current entity/record
// -> the record it points at), then reads the final segment as a real
// field on wherever the walk ended up. Resolves a formula/rollup field at
// any hop, not just stored ones. A broken chain (unknown fk, blank fk
// value, deleted linked record) resolves to undefined rather than
// throwing — a template merging real data shouldn't crash the whole
// document over one blank/broken reference; it should just render blank
// there, same spirit as how a formula field shows blank rather than
// exploding when a lookup has nothing on the other end.
function resolveMergeChain(schema, entity, record, pathSegments) {
  let currentEntity = entity;
  let currentRecord = record;
  for (let i = 0; i < pathSegments.length - 1; i++) {
    if (!currentEntity || !currentRecord) return { value: undefined, field: null, entityKey: null };
    const seg = pathSegments[i];
    let fkField = currentEntity.fields.find(f => f.type === 'fk' && f.name === seg);
    if (!fkField) fkField = currentEntity.fields.find(f => f.type === 'fk' && f.ref === seg);
    if (!fkField) return { value: undefined, field: null, entityKey: null };
    const refEntity = schema.entities[fkField.ref];
    const fkValue = currentRecord[fkField.name];
    if (!refEntity || !fkValue) return { value: undefined, field: null, entityKey: null };
    const remote = db.getByIdActive(refEntity.key, refEntity.pk, fkValue);
    if (!remote) return { value: undefined, field: null, entityKey: null };
    currentEntity = refEntity;
    currentRecord = withComputedFields(schema, refEntity, remote);
  }
  if (!currentEntity || !currentRecord) return { value: undefined, field: null, entityKey: null };
  const finalName = pathSegments[pathSegments.length - 1];
  const field = currentEntity.fields.find(f => f.name === finalName);
  let value = currentRecord[finalName];
  if (field && field.type === 'picklist' && value !== undefined && value !== null && value !== '') {
    value = resolvePicklistLabel(schema, currentEntity, field, value);
  }
  return { value, field: field || null, entityKey: currentEntity.key };
}

const IMAGE_MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Formats a resolved value for display in a merged document, the same
// way every other screen in the app formats a field — by its real type
// (stored fields) or its declared format (formula/rollup fields) —
// rather than dumping a raw value into the document (a currency field
// should read "₹45,000.00" on an invoice, not "45000"). An image field is
// a genuine special case, and not just cosmetically: its stored value is
// a bare filename, and {{LL_Sign}} needs an actual <img> tag to show a
// signature at all — but pointing that tag at the normal /uploads/...
// URL doesn't work here specifically, because the PDF is rendered via
// Puppeteer's page.setContent() (a raw HTML string, not a real page
// navigation), which has no page origin for a relative URL to resolve
// against, and even a resolved one would hit /uploads/'s own
// authenticated route with no session cookie to satisfy it. Embedding
// the actual image bytes as a base64 data URI sidesteps both problems —
// no separate HTTP request happens at all.
function formatMergeValue(field, value, entityKey) {
  if (value === undefined || value === null || value === '') return '';
  if (!field) return String(value);
  if (field.type === 'image') {
    try {
      const filePath = path.join(__dirname, 'data', 'uploads', entityKey, field.name, value);
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(value).toLowerCase();
      const mime = IMAGE_MIME_BY_EXT[ext] || 'image/png';
      const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
      return `<img src="${dataUri}" alt="${escapeHtmlForMerge(field.label || '')}" style="max-width:220px; max-height:120px;">`;
    } catch (e) {
      return ''; // file missing/unreadable — blank rather than a broken image icon or a thrown error
    }
  }
  if (field.type === 'currency') return formatINR(value);
  if (field.type === 'percent') return formatPercent(value);
  if (field.type === 'date') return formatDate(value, false);
  if (field.type === 'timestamp') return formatDate(value, true);
  if (field.type === 'formula' || field.type === 'rollup') return String(formatFormulaValue(field, value));
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function escapeHtmlForMerge(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain-text variant of mergeFieldTags — resolves {{tags}} but does NOT
// HTML-escape the result. For contexts that aren't HTML: an email To/Cc
// line, or a Subject (where "Rent & upkeep" must stay "&", not "&amp;").
function mergeFieldTagsPlain(schema, entity, record, template) {
  return String(template || '').replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
    const segments = path.split('.');
    const { value, field, entityKey } = resolveMergeChain(schema, entity, record, segments);
    return formatMergeValue(field, value, entityKey);
  });
}

function mergeFieldTags(schema, entity, record, template) {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
    const segments = path.split('.');
    const { value, field, entityKey } = resolveMergeChain(schema, entity, record, segments);
    const formatted = formatMergeValue(field, value, entityKey);
    // Only an image field's own <img> tag is trusted, server-built markup
    // (the sole dynamic part is a filename the app itself generated on
    // upload, not free-typed user data) — everything else still gets
    // escaped normally, same as before.
    return (field && field.type === 'image') ? formatted : escapeHtmlForMerge(formatted);
  });
}

// Renders a template's full HTML body against one real record — resolves
// any {{#each LineItems}} block first (repeating its inner content once
// per child row, or once for the base record itself if no line-items
// child table is configured yet, since {{#each}} still needs to work
// sensibly before that table exists), then resolves every remaining
// plain field tag against the base record.
function renderBillTemplate(schema, template, record) {
  const entity = schema.entities[template.baseTable];
  if (!entity) return { error: `Base table "${template.baseTable}" no longer exists.` };
  const computedRecord = withComputedFields(schema, entity, record);
  let output = template.htmlBody;

  output = output.replace(/\{\{#each\s+LineItems\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, innerTemplate) => {
    let childRows;
    let childEntity;
    if (template.lineItemsChildTable && template.lineItemsFkField) {
      childEntity = schema.entities[template.lineItemsChildTable];
      if (!childEntity) return '';
      childRows = db.getChildren(template.lineItemsChildTable, template.lineItemsFkField, record[entity.pk])
        .map(r => withComputedFields(schema, childEntity, r));
    } else {
      // No line-items table configured yet — the bill's own single row
      // acts as one line item, so {{#each LineItems}} still works
      // sensibly (renders its inner block exactly once) rather than
      // needing special-casing in every template that doesn't use it.
      childEntity = entity;
      childRows = [computedRecord];
    }
    return childRows.map(row => mergeFieldTags(schema, childEntity, row, innerTemplate)).join('');
  });

  output = mergeFieldTags(schema, entity, computedRecord, output);
  output = mergeGeneratedAtTag(output);
  return { html: output };
}

// {{GeneratedAt}} — today's date, formatted the same way every other
// date in the app is (formatDate), resolved at the moment the PDF is
// actually generated. Useful in a document's own footer/header ("Generated
// on: ..."), which is genuinely different from any specific record's own
// date field — there's no single "the" date on a report with many rows,
// each with its own. Available on both Bill and Report templates, the
// one merge tag not tied to either kind's own data shape at all.
function mergeGeneratedAtTag(output) {
  return output.replace(/\{\{GeneratedAt\}\}/g, escapeHtmlForMerge(formatDate(new Date().toISOString().slice(0, 10), false)));
}

// Merges a report-based template's HTML against one real run of that
// report (real parameter values, e.g. the Tenant Root + FY someone
// actually picked). Structurally different from renderBillTemplate
// above because a report's rows aren't real schema records — they're
// already-computed, already-formatted flat objects keyed by column
// label (built by runReport) — so this can't reuse resolveMergeChain's
// fk-walking logic at all; it's a simpler, direct substitution instead.
// {{HeaderPanel.X}} is the one place that DOES resolve against a real
// record (the report's Header Panel anchor), reusing
// resolveReportAnchorRecord so this can never drift from what the Run
// Report page itself considers "the" anchor.
function mergeReportRowTags(row, keyToLabel, template) {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
    if (!(key in keyToLabel)) return '';
    const val = row[keyToLabel[key]];
    return escapeHtmlForMerge(val === undefined || val === null ? '' : String(val));
  });
}

function renderReportTemplate(schema, template, paramValues) {
  const reportDef = reportDefByKey(schema, template.baseTable);
  if (!reportDef) return { error: `Report "${template.baseTable}" no longer exists.` };
  const result = runReport(schema, reportDef, paramValues);
  if (result.error) return { error: result.error };

  const resolvedAnchor = resolveReportAnchorRecord(schema, reportDef, paramValues);
  if (!resolvedAnchor) {
    return { error: 'This report\'s parameters don\'t currently identify a single record to generate a document for — make sure every parameter (especially the one used as the Header Panel anchor) has a value selected.' };
  }

  let output = template.htmlBody;

  // {{#each LineItems}} — the report's own output rows, one iteration
  // per row, using each column's Tag Key (if explicitly set) or its
  // sanitized label otherwise as the tag name inside the loop (e.g.
  // {{InvSeriesNo}} for a column labeled "Inv #" with no Tag Key set).
  // Built from reportDef's own columns/aggregates, not result.columns —
  // the latter is just label strings (from runReport), which can't
  // carry an explicit Tag Key at all.
  const columnItems = reportDef.groupBy
    ? [{ label: reportDef.groupByLabel || 'Group' }, ...(reportDef.aggregates || [])]
    : (reportDef.columns || []);
  const rowKeyMap = reportColumnKeyMap(columnItems); // label -> tag key (explicit or sanitized-from-label)
  const rowKeyToLabel = Object.fromEntries(Object.entries(rowKeyMap).map(([label, key]) => [key, label]));
  output = output.replace(/\{\{#each\s+LineItems\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, innerTemplate) => {
    return result.rows.map(row => mergeReportRowTags(row, rowKeyToLabel, innerTemplate)).join('');
  });

  // {{Totals.X}} — the report's own grand-total row, same sanitized keys
  // as the loop above, under a "Totals." prefix so a template can tell
  // "this row's CGST" and "the whole report's total CGST" apart even
  // though they're the same underlying column. Resolves blank (not an
  // error) when the report has no totals at all — a template can safely
  // reference {{Totals.X}} even on a report that isn't grouped/totaled.
  output = output.replace(/\{\{Totals\.([\w]+)\}\}/g, (match, key) => {
    if (!result.totals || !(key in rowKeyToLabel)) return '';
    const val = result.totals[rowKeyToLabel[key]];
    return escapeHtmlForMerge(val === undefined || val === null ? '' : String(val));
  });

  // {{Params.X}} — the raw runtime parameter value the report was
  // actually run with (e.g. whatever FY was picked) — not a report
  // column, and deliberately not pulled from any specific row's own
  // field either, since every row in a correctly-scoped report should
  // already share the same value for something like this; asking the
  // report itself what it was run with is more direct and doesn't
  // require adding a column just to surface it. Range-shaped parameters
  // (date/number "from"/"to" pairs) aren't a single value, so those
  // resolve blank here rather than showing something misleading like
  // "[object Object]".
  output = output.replace(/\{\{Params\.([\w]+)\}\}/g, (match, key) => {
    const val = paramValues[key];
    if (val === undefined || val === null || typeof val === 'object') return '';
    return escapeHtmlForMerge(String(val));
  });

  // {{HeaderPanel.X}} — any real field on the anchor record, not just the
  // specific ones configured as Header Panel display fields, the same
  // way a Bill template can reference any field on its base record.
  const { anchorEntity, computedRecord } = resolvedAnchor;
  output = output.replace(/\{\{HeaderPanel\.([\w.]+)\}\}/g, (match, path) => {
    const segments = path.split('.');
    const { value, field, entityKey } = resolveMergeChain(schema, anchorEntity, computedRecord, segments);
    const formatted = formatMergeValue(field, value, entityKey);
    return (field && field.type === 'image') ? formatted : escapeHtmlForMerge(formatted);
  });

  return { html: mergeGeneratedAtTag(output) };
}

// Number/currency/percent fields are inherently arithmetic — a blank one
// means "nothing recorded," which for +/-/* purposes should behave as 0
// (the standard spreadsheet convention: blank cells contribute 0 to a
// SUM). Text/date/bool/etc fields are NOT coerced this way — a blank
// text field concatenated into a string should stay blank, not become
// "0". This distinction matters: without it, a formula like
// `BILLS_RentRecd + BILLS_TDSDep + BILLS_GSTRecd` silently falls back to
// JS string concatenation the moment any ONE of those is blank, since
// `5000 + '' ` produces the STRING "5000", and everything summed after
// that point concatenates as text instead of adding numerically —
// corrupting the total in a way that can look right or wrong depending
// on which field happens to be blank and where it sits in the chain.
function isArithmeticFieldType(type) {
  return type === 'number' || type === 'currency' || type === 'percent';
}

// True if a value looks like one of our own error markers (#ERR, #REF, #LOOKUP).
function isFormulaError(v) {
  return typeof v === 'string' && v.charAt(0) === '#';
}

// ---- Excel-style function library available inside every formula ----------
function fyLabelOf(x) {
  if (typeof x === 'string' && /^\d{4}-\d{2,4}$/.test(x)) return x;
  const d = new Date(x);
  if (isNaN(d.getTime())) return '#ERR';
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // Indian FY: April(3)-March
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// Number-to-words in the Indian numbering system (crore/lakh/thousand,
// not the Western million/billion grouping) — built for AMOUNT_TO_WORDS
// below, the standard "Rupees ... Only" line on an Indian invoice.
// Deliberately three small, single-purpose helpers rather than one dense
// function, so each piece (a 0-99 pair, a 0-999 triple, the overall
// crore/lakh/thousand/hundred split) can be reasoned about and tested on
// its own — number-to-words has a lot of easy-to-get-wrong edge cases
// (teens, an internal zero segment, exact round numbers) and a single
// tangled function makes those much easier to get subtly wrong.
const NUM_WORDS_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const NUM_WORDS_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// n: 0-99
function twoDigitsToWords(n) {
  if (n < 20) return NUM_WORDS_ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return NUM_WORDS_TENS[t] + (o ? ' ' + NUM_WORDS_ONES[o] : '');
}

// n: 0-999 — the one segment that can have its own internal "Hundred"
function threeDigitsToWords(n) {
  const h = Math.floor(n / 100), rest = n % 100;
  let out = '';
  if (h) out += NUM_WORDS_ONES[h] + ' Hundred';
  if (rest) out += (out ? ' ' : '') + twoDigitsToWords(rest);
  return out;
}

// n: any non-negative integer up to 99,99,99,999 (99 crore range) — comfortably
// beyond anything a real rent/GST invoice would ever need, without pretending
// to handle arab/kharab this app has no real use for.
function numberToIndianWords(n) {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = n; // 0-999, the final segment
  const parts = [];
  if (crore) parts.push(threeDigitsToWords(crore) + ' Crore');
  if (lakh) parts.push(twoDigitsToWords(lakh) + ' Lakh'); // always 0-99 once crore is already extracted
  if (thousand) parts.push(twoDigitsToWords(thousand) + ' Thousand'); // always 0-99 once lakh is already extracted
  if (hundred) parts.push(threeDigitsToWords(hundred));
  return parts.join(' ');
}

// The actual formula-facing function: a real Rupees amount (with paise)
// into the standard Indian invoice wording, e.g. 363000 -> "Rupees Three
// Lakh Sixty-Three Thousand Only", or 363000.50 -> "Rupees Three Lakh
// Sixty-Three Thousand and Fifty Paise Only". Rounds to the nearest paisa
// first (floating point rent/GST math can leave a stray 0.0000000004),
// then splits into rupees and paise so each half is a clean, real integer
// before either goes through numberToIndianWords — not one combined
// number with an implied decimal, which is where a lot of these
// converters quietly go wrong on values like 100.05.
function amountToWords(amount) {
  const n = Number(amount);
  if (!isFinite(n)) return '';
  const negative = n < 0;
  const paisaTotal = Math.round(Math.abs(n) * 100);
  const rupees = Math.floor(paisaTotal / 100);
  const paise = paisaTotal % 100;
  let out = 'Rupees ' + numberToIndianWords(rupees);
  if (paise > 0) out += ' and ' + twoDigitsToWords(paise) + ' Paise';
  out += ' Only';
  return (negative ? 'Minus ' : '') + out;
}

const STATIC_FORMULA_FUNCTIONS = {
  AMOUNT_TO_WORDS: amountToWords,
  IF: (cond, a, b) => (cond ? a : b),
  IFERROR: (val, fallback) => (val === '#ERR' || (typeof val === 'number' && isNaN(val)) ? fallback : val),
  ISBLANK: (v) => v === '' || v === undefined || v === null,
  ROUND: (n, d) => { const f = Math.pow(10, d || 0); return Math.round(Number(n) * f) / f; },
  ROUNDUP: (n, d) => { const f = Math.pow(10, d || 0); return Math.ceil(Number(n) * f) / f; },
  ROUNDDOWN: (n, d) => { const f = Math.pow(10, d || 0); return Math.floor(Number(n) * f) / f; },
  ABS: (n) => Math.abs(Number(n)),
  MIN: (...args) => Math.min(...args.map(Number)),
  MAX: (...args) => Math.max(...args.map(Number)),
  SUM: (...args) => args.reduce((a, b) => a + (Number(b) || 0), 0),
  TODAY: () => new Date().toISOString().slice(0, 10),
  YEAR: (d) => new Date(d).getFullYear(),
  MONTH: (d) => new Date(d).getMonth() + 1,
  DAY: (d) => new Date(d).getDate(),
  DAYS: (d1, d2) => Math.round((new Date(d1) - new Date(d2)) / 86400000),
  CONCAT: (...args) => args.join(''),
  LEFT: (s, n) => String(s).slice(0, n),
  RIGHT: (s, n) => String(s).slice(-n),
  MID: (s, start, len) => String(s).substr(start - 1, len),
  LEN: (s) => String(s).length,
  UPPER: (s) => String(s).toUpperCase(),
  LOWER: (s) => String(s).toLowerCase(),
  TRIM: (s) => String(s).trim(),
  FY: fyLabelOf,
  CURRENT_FY: () => fyLabelOf(new Date()),
};

// Shared "scan this table for rows where a condition holds" logic — used
// by both LOOKUP() and (below) Header Panel anchor resolution. The
// condition is evaluated once per row via the normal formula engine, with
// `extraScopes` supplying whatever named context the condition needs
// beyond the target table's own fields (which get bound under
// `targetEntity.key` here, same as LOOKUP's own `tableKey.field` syntax).
// Every identifier in conditionExpr EXCEPT ones prefixed by the target
// table's own key (e.g. "gstrates.GST_Month") is a "caller-side" value —
// something that stays fixed for the whole scan of the target table
// within one LOOKUP call, and is exactly what determines whether two
// different calls (e.g. from two different Invoice rows) would produce
// the same result. Excludes known function names and keywords, which
// aren't references to resolve.
const LOOKUP_CACHE_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'true', 'false', 'LOOKUP']);
function extractCallerSideRefs(conditionExpr, targetTableKey) {
  const refs = new Set();
  const tokenRe = /\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\b/g;
  let m;
  while ((m = tokenRe.exec(conditionExpr))) {
    const token = m[1];
    if (token.startsWith(targetTableKey + '.')) continue;
    if (LOOKUP_CACHE_KEYWORDS.has(token) || STATIC_FORMULA_FUNCTIONS[token]) continue;
    if (!isNaN(Number(token))) continue; // a bare number literal, not a reference
    refs.add(token);
  }
  return [...refs];
}

// Detects whether conditionExpr is safely reducible to a real hash index:
// a pure conjunction of "targetTable.field = <caller-side expression>"
// clauses joined only by AND — exactly the shape both of this schema's
// actual LOOKUP conditions use (gstrates/caldata month+year+SAC+taxtype
// matching). Deliberately conservative: any OR, NOT, parentheses, or a
// clause that isn't a single bare "=" comparison bails out to null,
// meaning "not safely indexable" — the caller then falls straight back
// to the existing, already-verified linear-scan path, unchanged. This
// function only ever decides whether the fast path is *allowed*; it
// never decides what the actual matching result is, so a wrong detection
// here can only cost performance, not correctness.
function detectIndexableCondition(conditionExpr, targetTableKey) {
  // Reject OR/NOT anywhere, and reject a "(" only when it's NOT a
  // function call's own paren (i.e. not immediately preceded by an
  // identifier character) — MONTH(I_Date) must stay allowed, since both
  // of this schema's real LOOKUP conditions use exactly that; a genuine
  // grouping paren like "(A OR B) AND C" is what actually needs to bail.
  if (/\bOR\b|\bNOT\b|(?<![a-zA-Z0-9_])\(/.test(conditionExpr)) return null;
  const clauses = conditionExpr.split(/\bAND\b/);
  const indexFields = [];
  const targetRefRe = new RegExp('^' + targetTableKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.([a-zA-Z_][a-zA-Z0-9_]*)$');
  for (let clause of clauses) {
    clause = clause.trim();
    // Exactly one bare "=" (not part of ==, !=, <=, >=) with neither side
    // itself containing a comparison operator — anything else (a
    // different comparison, or a malformed clause) isn't a plain
    // equality and bails out entirely.
    const eqMatches = clause.match(/(?<![<>=!])=(?!=)/g);
    if (!eqMatches || eqMatches.length !== 1) return null;
    const eqIdx = clause.search(/(?<![<>=!])=(?!=)/);
    const lhs = clause.slice(0, eqIdx).trim();
    const rhs = clause.slice(eqIdx + 1).trim();
    if (/[<>=!]/.test(lhs) || /[<>=!]/.test(rhs)) return null;
    const lhsMatch = lhs.match(targetRefRe);
    const rhsMatch = rhs.match(targetRefRe);
    if (lhsMatch && !rhsMatch) {
      indexFields.push({ targetField: lhsMatch[1], callerExpr: rhs });
    } else if (rhsMatch && !lhsMatch) {
      indexFields.push({ targetField: rhsMatch[1], callerExpr: lhs });
    } else {
      return null; // neither side (or both sides) reference the target table directly — not indexable this way
    }
  }
  return indexFields.length > 0 ? indexFields : null;
}

// Builds (and request-caches) a real hash index of targetEntity's rows,
// keyed by the values of the specific fields an indexable condition
// needs — one real O(n) pass over the table, done at most once per
// request per distinct set of indexed fields, however many LOOKUP calls
// actually use it afterward. Turns what would otherwise be an O(rows)
// scan on every single call into an O(1) hash lookup on every call after
// the first, regardless of how much the real data happens to repeat —
// unlike the LOOKUP result cache above, this helps even when no two
// calls ask the exact same question.
function buildTableIndex(targetEntity, targetFieldNames) {
  const cache = db.getTableIndexCache();
  const sortedFields = [...targetFieldNames].sort();
  const indexKey = targetEntity.key + '::' + sortedFields.join(',');
  if (cache && cache[indexKey]) return cache[indexKey];
  const index = new Map();
  db.getAll(targetEntity.key).forEach(row => {
    const key = JSON.stringify(sortedFields.map(f => row[f]));
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  });
  if (cache) cache[indexKey] = index;
  return index;
}

function findMatchingRows(schema, targetEntity, conditionExpr, callerEntity, callerRecord, extraScopes, depth) {
  // Cache keyed by the actual resolved caller-side values (not the whole
  // caller record) — two different rows sharing the same effective query
  // (e.g. two Invoices in the same month, same tenant SAC) hit the same
  // cache entry, turning what would otherwise be a full rescan of a
  // 1000+ row table into a single lookup. Reuses evalFormula itself to
  // resolve each reference (a bare reference like "I_Date" or
  // "tenants.T_SAC" is already a valid, simple formula expression via its
  // existing fast path), rather than re-implementing resolution — this is
  // purely about what to use as a cache key, not a new evaluation path.
  //
  // Correctness of this cache was verified rigorously before shipping,
  // not just spot-checked: a temporary instrumented version of this exact
  // function computed BOTH the cached result and a fresh, full-rescan
  // result on every single call, compared them, and would have logged any
  // mismatch loudly. Run against two tables that actually use LOOKUP()
  // (Invoices and a Credit Card Tracker table) with 250 + 200 randomized
  // records respectively, exercising every list page and 100 randomly
  // sampled detail pages: 11,690 total LOOKUP calls, 8,558 of them actual
  // cache hits (a 73% hit rate — the cache-hit path was genuinely
  // exercised at volume, not barely touched), zero mismatches.
  const cache = db.getLookupCache();
  let cacheKey = null;
  if (cache) {
    const callerRefs = extractCallerSideRefs(conditionExpr, targetEntity.key);
    const resolvedRefs = callerRefs.map(ref => {
      const val = evalFormula(ref, schema, callerEntity, callerRecord, extraScopes, depth + 1);
      return ref + '=' + JSON.stringify(val);
    });
    cacheKey = targetEntity.key + '::' + conditionExpr + '::' + resolvedRefs.sort().join('|');
    if (cache[cacheKey] !== undefined) return cache[cacheKey];
  }

  // Indexed fast path — only ever taken when detectIndexableCondition
  // recognizes the condition as a pure AND-of-equalities; everything else
  // (including anything the detector isn't fully sure about) falls
  // through to the linear scan below completely unchanged. This turns
  // repeated large-table LOOKUPs (the actual, confirmed real-world
  // bottleneck — GST rate and calendar tables in the thousands of rows)
  // from an O(rows) scan on every call into one O(rows) index build per
  // request, then O(1) per call afterward — a real fix for the case the
  // cache above can't help with: many calls that each ask a *different*
  // question of the same big table, not just repeats of the same one.
  const indexSpec = detectIndexableCondition(conditionExpr, targetEntity.key);
  if (indexSpec) {
    let indexError = null;
    const keyParts = indexSpec.map(spec => {
      if (indexError) return null;
      const val = evalFormula(spec.callerExpr, schema, callerEntity, callerRecord, extraScopes, depth + 1);
      if (isFormulaError(val)) { indexError = val; return null; }
      return val;
    });
    if (indexError) {
      const output = { matches: [], conditionError: indexError };
      if (cache) cache[cacheKey] = output;
      return output;
    }
    const index = buildTableIndex(targetEntity, indexSpec.map(s => s.targetField));
    // buildTableIndex sorts its own field list internally for a stable
    // cache key — key lookup here must use that exact same sorted order,
    // not the condition's own clause order, or every lookup would miss.
    const orderedForIndex = indexSpec.map((s, i) => ({ field: s.targetField, val: keyParts[i] }))
      .sort((a, b) => a.field < b.field ? -1 : 1).map(x => x.val);
    const indexKeyStr = JSON.stringify(orderedForIndex);
    const matches = index.get(indexKeyStr) || [];
    const output = { matches, conditionError: null };
    if (cache) cache[cacheKey] = output;
    return output;
  }

  let conditionError = null;
  const matches = db.getAll(targetEntity.key).filter(row => {
    if (conditionError) return false;
    const scopes = { ...extraScopes, [targetEntity.key]: { entity: targetEntity, row } };
    const result = evalFormula(conditionExpr, schema, callerEntity, callerRecord, scopes, depth + 1);
    if (isFormulaError(result)) { conditionError = result; return false; }
    return result === true;
  });
  const output = { matches, conditionError };
  if (cache) cache[cacheKey] = output;
  return output;
}

// LOOKUP("tableKey", "condition expression", "returnFieldName")
// Scans every row of the named table, evaluating the condition against each
// row (that row's own fields are reachable as "tableKey.Field" inside the
// condition, same dotted syntax as everywhere else) plus the calling
// record's own fields (bare names, same as the outer formula). Errors
// visibly — never silently returns 0 — if there's no match, more than one,
// or the condition itself references a field that doesn't exist.
function makeLookupFn(schema, entity, record, extraScopes, depth) {
  return function LOOKUP(tableKey, conditionExpr, returnField) {
    if (depth >= MAX_LOOKUP_DEPTH) return '#LOOKUP: too deeply nested';
    const targetEntity = schema.entities[tableKey];
    if (!targetEntity) return `#LOOKUP: unknown table "${tableKey}"`;
    const { matches, conditionError } = findMatchingRows(schema, targetEntity, conditionExpr, entity, record, extraScopes, depth);
    if (conditionError) return conditionError;
    if (matches.length === 0) return '#LOOKUP: no match';
    if (matches.length > 1) return `#LOOKUP: ambiguous (${matches.length} rows)`;
    if (!targetEntity.fields.some(f => f.name === returnField)) return `#LOOKUP: no such field "${returnField}" on ${tableKey}`;
    return matches[0][returnField];
  };
}

// extraScopes: optional { scopeName: rowObject } map for dotted references
// that aren't reached via a real fk on `entity` — e.g. "parent.X" inside a
// rollup's WHERE clause, or "tableKey.X" inside a LOOKUP condition.
// Formula/rollup fields can reference sibling formula/rollup fields on the
// same table (e.g. I_TotalBill = I_BaseRent + I_CGSTAmt, where I_BaseRent
// and I_CGSTAmt are themselves formula fields) — resolved on demand,
// recursively, right here, rather than requiring some separate
// pre-computation pass. `visiting` is a Set of "entityKey.fieldName"
// strings currently being resolved further up the call stack; if we're
// asked to resolve something already in there, that's a genuine circular
// reference (A depends on B depends on A) and we say so explicitly rather
// than looping forever or silently returning something wrong.
const MAX_FORMULA_REF_DEPTH = 15;
// Coercion shared by the fresh-compute and memo-hit paths below — a blank
// computed value must read as 0 in arithmetic contexts and '' in text ones,
// and that has to hold identically whether the value was just computed or
// served from the memo (the memo stores the RAW result, pre-coercion, so
// withComputedFields can seed it with exactly what it renders).
function coerceComputedResult(field, result) {
  const isBlank = result === undefined || result === null || result === '';
  if (isBlank) return isArithmeticFieldType(field.type) ? 0 : '';
  return result;
}

// Memo key for one record's one computed field. Returns null (no memoization)
// when the record has no usable pk value — e.g. formula evaluation against a
// transient/partial record during default-value preview — since without a
// real identity, two different in-memory records could otherwise collide on
// the same key and serve each other's values.
function computedMemoKey(entity, record, field) {
  const pkVal = record ? record[entity.pk] : undefined;
  if (pkVal === undefined || pkVal === null || pkVal === '') return null;
  return entity.key + '|' + pkVal + '|' + field.name;
}

function resolveComputedField(schema, entity, record, field, visiting, depth) {
  const cycleKey = entity.key + '.' + field.name;
  if (visiting.has(cycleKey)) return `#REF: circular reference involving "${field.name}"`;
  if (depth > MAX_FORMULA_REF_DEPTH) return '#REF: formula reference too deep';

  // Request-scoped memo (see db.js getComputedMemo for the why). Reading is
  // always safe: values only ever ENTER the memo when computed from a clean
  // top-level evaluation (visiting empty — enforced at the store below, and
  // by withComputedFields' own seeding), so a memo hit can never serve a
  // value that was poisoned mid-cycle by the circular-reference guard above.
  const memo = db.getComputedMemo();
  const memoKey = memo ? computedMemoKey(entity, record, field) : null;
  if (memoKey && memoKey in memo) return coerceComputedResult(field, memo[memoKey]);

  const nextVisiting = new Set(visiting);
  nextVisiting.add(cycleKey);
  let result;
  if (field.type === 'formula') {
    result = evalFormula(field.formula, schema, entity, record, {}, depth + 1, nextVisiting);
  } else if (field.type === 'rollup') {
    result = computeRollup(schema, field, entity, record, nextVisiting, depth + 1);
  } else {
    return record[field.name];
  }
  // Store only when this was a top-level resolution (visiting empty) — a
  // nested resolution inside a genuine A→B→A cycle produces a #REF-tainted
  // value that must not be cached as B's "real" value for later callers.
  if (memoKey && visiting.size === 0) memo[memoKey] = result;
  return coerceComputedResult(field, result);
}

function evalFormula(formula, schema, entity, record, extraScopes, depth, visiting) {
  extraScopes = extraScopes || {};
  depth = depth || 0;
  visiting = visiting || new Set();
  if (!formula || !formula.trim()) return '';
  const trimmed = formula.trim();
  if (!FORMULA_SAFE_RE.test(trimmed) || FORMULA_BANNED_RE.test(trimmed)) return '#ERR';

  // Fast path: the whole formula is just one reference (same-table field,
  // or a dotted cross-table chain of any depth, e.g. "x.y" or
  // "x.y.z.w") — return its raw value as-is, so text lookups (names,
  // statuses, etc.) aren't mangled into 0 by numeric coercion.
  // Arithmetic/expressions/function calls fall through below.
  const bareCrossRef = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)$/);
  if (bareCrossRef) {
    const segments = bareCrossRef[1].split('.');
    const resolved = resolveFormulaChain(schema, entity, record, extraScopes, segments);
    if (resolved.error) return resolved.error;
    return resolved.value === undefined ? '' : resolved.value;
  }
  const bareField = trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  if (bareField) {
    const f = entity.fields.find(f => f.name === trimmed);
    if (f && (f.type === 'formula' || f.type === 'rollup')) {
      return resolveComputedField(schema, entity, record, f, visiting, depth);
    }
    if (f) {
      const v = record[trimmed];
      if (v === undefined) return '';
      if (f.type === 'picklist' && v !== null && v !== '') return resolvePicklistLabel(schema, entity, f, v);
      return v;
    }
  }

  const { masked, literals } = maskQuotedStrings(trimmed);
  const equalsFixed = convertLogicalKeywords(convertEquals(masked));
  const crossRefs = {};
  let refCounter = 0;
  let refError = null;
  // Matches a dotted chain of any length embedded within a larger
  // expression (e.g. "T_PropCode.P_Landlord.LL_Display = 'X'"), not just
  // exactly two segments — see resolveFormulaChain's own comment for why
  // this needed fixing and what it was doing wrong before (silently
  // resolving only the first hop, then a further ".field" access on the
  // resulting raw value, which JS just returns undefined for).
  let maskedWorking = equalsFixed.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\b/g, (match, fullChain) => {
    const varName = `__ref${refCounter++}`;
    if (refError) return varName; // already found a bad reference; keep the string well-formed and bail after
    const segments = fullChain.split('.');
    const resolved = resolveFormulaChain(schema, entity, record, extraScopes, segments);
    let remoteVal, remoteFieldType;
    if (resolved.error) { refError = resolved.error; remoteVal = undefined; } else { remoteVal = resolved.value; remoteFieldType = resolved.field && resolved.field.type; }
    const isBlank = remoteVal === undefined || remoteVal === null || remoteVal === '';
    crossRefs[varName] = isBlank ? (isArithmeticFieldType(remoteFieldType) ? 0 : '') : remoteVal;
    return varName;
  });
  if (refError) return refError;
  const workingFormula = unmaskQuotedStrings(maskedWorking, literals);

  // Every STORED field is a valid bare-name reference, same as always.
  // Formula/rollup fields are ALSO now valid bare-name references (this is
  // the sibling-formula fix) — but only pulled in when actually mentioned
  // in this formula's own text. Unconditionally resolving every formula/
  // rollup field on the table for every single evaluation would mean each
  // one recomputes every other one too, compounding multiplicatively on a
  // table with many formula fields — a real, measured problem, not a
  // theoretical one.
  const storedFields = entity.fields.filter(f => f.type !== 'formula' && f.type !== 'rollup');
  const referencedComputedFields = entity.fields.filter(f => {
    if (f.type !== 'formula' && f.type !== 'rollup') return false;
    return new RegExp('\\b' + f.name + '\\b').test(workingFormula);
  });
  const varFields = storedFields.concat(referencedComputedFields);
  const fnNames = Object.keys(STATIC_FORMULA_FUNCTIONS).concat(['LOOKUP']);
  const names = varFields.map(f => f.name).concat(Object.keys(crossRefs)).concat(fnNames);
  // Pass raw values (not force-coerced to numbers) — JS arithmetic operators
  // already coerce numeric strings/numbers naturally, but functions like
  // MONTH()/YEAR()/UPPER() need the real date/text value, not a mangled 0.
  const args = varFields.map(f => {
    if (f.type === 'formula' || f.type === 'rollup') {
      return resolveComputedField(schema, entity, record, f, visiting, depth);
    }
    const v = record[f.name];
    const isBlank = v === undefined || v === null || v === '';
    if (isBlank) return isArithmeticFieldType(f.type) ? 0 : '';
    if (f.type === 'picklist') return resolvePicklistLabel(schema, entity, f, v);
    return v;
  }).concat(Object.values(crossRefs))
    .concat(Object.values(STATIC_FORMULA_FUNCTIONS))
    .concat([makeLookupFn(schema, entity, record, extraScopes, depth)]);

  // SECURITY NOTE: this is eval-adjacent (new Function compiles and runs
  // the formula text as real JS) and must stay admin-only — untrusted
  // users must never be allowed to author a formula, full stop. The
  // safety net here is real but narrow: FORMULA_SAFE_RE whitelists
  // characters before this point, FORMULA_BANNED_RE blocks dangerous
  // tokens, and there's no bracket-property access ([]) available in the
  // compiled body — but none of that is a substitute for "only admins
  // can reach this code path" as the actual boundary. Also worth knowing
  // when reading the compiled body during debugging: a chained
  // cross-table reference like a.b.c leaves __ref0.c behind, not a
  // second dynamic lookup — a.b resolves to a real value first (via
  // resolveCrossTableValue above), and .c is then a plain property
  // access on that already-resolved data.
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `try { return (${workingFormula}); } catch(e) { return '#ERR:' + e.message; }`);
    const result = fn(...args);
    if (typeof result === 'string' && result.startsWith('#ERR:')) {
      const notDefined = result.match(/^#ERR:(\S+) is not defined/);
      return notDefined ? `#REF: no such field "${notDefined[1]}" on ${entity.key}` : '#ERR';
    }
    return (typeof result === 'number' && !isFinite(result)) ? '#ERR' : result;
  } catch (e) {
    return '#ERR';
  }
}

// ---- Rollup fields: aggregate a parent's child (or grandchild) records ----
// e.g. Landlords.LL_TotalRentThisFY = SUM(BILLS_Total) via Tenants->Bills,
// where FY(BILLS_BillDate) = CURRENT_FY(). WHERE can reference the child
// row's own fields (bare) and the parent record's fields (via "parent.X"),
// using the exact same evaluator as formula fields.
function rollupSourceRows(schema, parentEntity, parentRecord, hop1Key, hop2Key) {
  const hop1Cfg = getChildren(schema, parentEntity.key).find(c => c.entity === hop1Key);
  if (!hop1Cfg) return [];
  const hop1Rows = db.getChildren(hop1Key, hop1Cfg.fk, parentRecord[parentEntity.pk]);
  if (!hop2Key) return hop1Rows;
  const hop1Entity = schema.entities[hop1Key];
  const hop2Cfg = getChildren(schema, hop1Key).find(c => c.entity === hop2Key);
  if (!hop1Entity || !hop2Cfg) return [];
  let rows = [];
  hop1Rows.forEach(r1 => {
    rows = rows.concat(db.getChildren(hop2Key, hop2Cfg.fk, r1[hop1Entity.pk]));
  });
  return rows;
}

function computeRollup(schema, field, parentEntity, parentRecord, visiting, depth) {
  visiting = visiting || new Set();
  depth = depth || 0;
  const targetKey = field.rollupHop2Entity || field.rollupHop1Entity;
  const targetEntity = schema.entities[targetKey];
  if (!targetEntity) return '#ERR';

  let rows = rollupSourceRows(schema, parentEntity, parentRecord, field.rollupHop1Entity, field.rollupHop2Entity || null);

  if (field.rollupWhere && field.rollupWhere.trim()) {
    let whereError = null;
    rows = rows.filter(r => {
      if (whereError) return false;
      const result = evalFormula(field.rollupWhere, schema, targetEntity, r, { parent: { entity: parentEntity, row: parentRecord } }, depth, visiting);
      if (isFormulaError(result)) { whereError = result; return false; }
      return result === true;
    });
    if (whereError) return whereError;
  }

  if (field.rollupFn === 'COUNT') return rows.length;

  // LATEST: sort by rollupOrderField (desc), return rollupField from the top row.
  // Different from MAX: MAX returns the maximum value of the field, LATEST returns
  // the field value from whichever row has the most-recent order-field value —
  // e.g. "amount of the most recent payment" vs "largest payment amount".
  if (field.rollupFn === 'LATEST') {
    if (rows.length === 0) return '';
    const orderKey = field.rollupOrderField || field.rollupField;
    const sorted = rows.slice().sort((a, b) => {
      const av = a[orderKey], bv = b[orderKey];
      if (av === bv) return 0;
      if (av === undefined || av === '' || av === null) return 1;
      if (bv === undefined || bv === '' || bv === null) return -1;
      return av < bv ? 1 : -1; // descending
    });
    const v = sorted[0][field.rollupField];
    return v === undefined ? '' : v;
  }

  const nums = rows.map(r => { const n = Number(r[field.rollupField]); return isNaN(n) ? 0 : n; });
  return aggregateValues(field.rollupFn, nums);
}

// Shared SUM/COUNT/AVG/MIN/MAX math — used by rollup fields and by Report
// grouped/aggregate mode, so the arithmetic only lives in one place.
function aggregateValues(fn, nums) {
  if (fn === 'COUNT') return nums.length;
  if (fn === 'SUM') return nums.reduce((a, b) => a + b, 0);
  if (fn === 'AVG') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  if (fn === 'MIN') return nums.length ? Math.min(...nums) : 0;
  if (fn === 'MAX') return nums.length ? Math.max(...nums) : 0;
  return '#ERR';
}

// Adds computed formula/rollup values onto a plain record for display.
function withComputedFields(schema, entity, record) {
  if (!record) return record;
  const out = { ...record };
  // Each field's raw result is seeded into the request-scoped memo as it's
  // computed — these ARE clean top-level evaluations (empty visiting set),
  // exactly what the memo is allowed to hold. Combined with the memo check
  // inside resolveComputedField, fields laid out in dependency order in the
  // schema (I_CGSTPC before I_CGSTAmt before I_TotalBill — the natural way
  // people author them) each compute exactly once per record per request,
  // instead of every later formula re-deriving the whole chain of every
  // earlier one it references.
  const memo = db.getComputedMemo();
  entity.fields.forEach(f => {
    if (f.type !== 'formula' && f.type !== 'rollup') return;
    const memoKey = memo ? computedMemoKey(entity, record, f) : null;
    if (memoKey && memoKey in memo) { out[f.name] = memo[memoKey]; return; }
    const result = f.type === 'formula'
      ? evalFormula(f.formula, schema, entity, record)
      : computeRollup(schema, f, entity, record);
    if (memoKey) memo[memoKey] = result;
    out[f.name] = result;
  });
  return out;
}

// Same contract as withComputedFields, but only computes the formula/rollup
// fields actually named in neededNames — for list-style views that render a
// fixed set of columns, computing every computed field on the table (46
// fields on a real invoices table, of which several are LOOKUP-heavy
// display strings shown only on the detail page) is pure waste multiplied
// by every row. Dependencies are still correct without being named: a
// needed field that references an unlisted sibling resolves it transitively
// through resolveComputedField (and the request memo means that sibling
// still only computes once per record). Fields NOT computed are left
// entirely absent from the output, exactly like the raw record — callers
// must pass every field they intend to read (columns + sort + filters +
// totals), not just the visible ones.
function withComputedFieldsSubset(schema, entity, record, neededNames) {
  if (!record) return record;
  const needed = neededNames instanceof Set ? neededNames : new Set(neededNames || []);
  const out = { ...record };
  const memo = db.getComputedMemo();
  entity.fields.forEach(f => {
    if (f.type !== 'formula' && f.type !== 'rollup') return;
    if (!needed.has(f.name)) return;
    const memoKey = memo ? computedMemoKey(entity, record, f) : null;
    if (memoKey && memoKey in memo) { out[f.name] = memo[memoKey]; return; }
    const result = f.type === 'formula'
      ? evalFormula(f.formula, schema, entity, record)
      : computeRollup(schema, f, entity, record);
    if (memoKey) memo[memoKey] = result;
    out[f.name] = result;
  });
  return out;
}

// ---- Date formatting for display -----------------------------------------
// Universal DD-MM-YYYY across the whole app. Two subtle things worth noting:
//
// 1. For date-only values (form <input type="date"> submits "2026-07-04"),
//    we must NOT round-trip through `new Date(...)` — that parses as UTC
//    midnight and .getDate() then returns the *local timezone* day, which
//    silently shifts to the wrong day west of UTC (e.g. "2026-07-04" in
//    a US-East server would render as "03-07-2026"). Instead, we
//    string-split the ISO date and reassemble the digits, no timezone
//    involved.
//
// 2. For timestamps (with a time component) we do want a real Date, since
//    those are stored with time-of-day and the "date" the user cares
//    about is the one shown in the picker, which is local.
function formatDate(value, withTime) {
  if (value === '' || value === null || value === undefined) return '';
  const s = String(value);
  // Date-only, no timezone: extract digits directly, avoid any Date parsing.
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly && !withTime) return `${dateOnly[3]}-${dateOnly[2]}-${dateOnly[1]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  let out = `${dd}-${mm}-${yyyy}`;
  if (withTime) out += ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return out;
}

// ---- Views: per-table list-column selection/order + default sort ---------
function updateViewSort(schema, entityKey, { sortField, sortDir }) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  e.sortField = sortField && e.fields.some(f => f.name === sortField) ? sortField : '';
  e.sortDir = sortDir === 'desc' ? 'desc' : 'asc';
}

// Only fields structurally guaranteed to hold a real number (coerced to
// Number by coerceBody at save time) are eligible for List Totals —
// deliberately not formula/rollup fields, since their result isn't
// guaranteed numeric (a formula can just as easily concatenate strings),
// and getting that wrong would show a nonsense total. A straightforward,
// safe reading of "restrict to number-only fields".
const NUMERIC_FIELD_TYPES = ['number', 'currency', 'percent'];
function numericFieldsFor(entity) {
  return entity.fields.filter(f => NUMERIC_FIELD_TYPES.includes(f.type));
}

const LIST_TOTAL_FNS = ['sum', 'avg', 'max', 'min'];
function updateListTotals(schema, entityKey, rawTotals) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  const eligibleNames = numericFieldsFor(e).map(f => f.name);
  const seen = new Set();
  e.listTotals = (rawTotals || [])
    .filter(t => t && t.field && eligibleNames.includes(t.field) && LIST_TOTAL_FNS.includes(t.fn))
    .filter(t => {
      // One aggregate per field is enough — silently drop a duplicate
      // rather than error, since the admin form could plausibly submit
      // the same field twice without meaning to.
      const key = t.field;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(t => ({ field: t.field, fn: t.fn }));
}

// The actual Sum/Average/Max/Min computation — operates on whatever rows
// are passed in, so the caller decides the scope (the full filtered/
// searched result set, not just one paginated page, is what the List
// route actually passes — a "total" that changes depending which page
// you're on would be misleading).
function computeListTotals(rows, listTotalsConfig) {
  const out = {};
  (listTotalsConfig || []).forEach(t => {
    const nums = rows.map(r => Number(r[t.field])).filter(n => !isNaN(n));
    if (nums.length === 0) { out[t.field] = { fn: t.fn, value: null }; return; }
    let value;
    if (t.fn === 'sum') value = nums.reduce((a, b) => a + b, 0);
    else if (t.fn === 'avg') value = nums.reduce((a, b) => a + b, 0) / nums.length;
    else if (t.fn === 'max') value = Math.max(...nums);
    else if (t.fn === 'min') value = Math.min(...nums);
    out[t.field] = { fn: t.fn, value };
  });
  return out;
}

function addListColumn(schema, entityKey, fieldName) {
  const e = schema.entities[entityKey];
  if (!e || !e.fields.some(f => f.name === fieldName)) return;
  if (!e.listColumns.includes(fieldName)) e.listColumns.push(fieldName);
}

function removeListColumn(schema, entityKey, fieldName) {
  const e = schema.entities[entityKey];
  if (!e) return;
  e.listColumns = e.listColumns.filter(n => n !== fieldName);
}

function moveListColumn(schema, entityKey, fieldName, dir) {
  const e = schema.entities[entityKey];
  if (!e) return;
  const idx = e.listColumns.indexOf(fieldName);
  if (idx === -1) return;
  const swapWith = dir === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= e.listColumns.length) return;
  const tmp = e.listColumns[idx];
  e.listColumns[idx] = e.listColumns[swapWith];
  e.listColumns[swapWith] = tmp;
}

// ---- Views: which fields offer a filter control on the List screen -------
// Only types where a structured control makes sense — bool/picklist/fk get
// a dropdown, date/number/currency/percent get a from/to range, text/
// textarea get an exact-match box. Formula/rollup fields are filterable
// too, but their control depends on their own "Format As" setting (see
// filterKindFor) since the field type alone doesn't say what shape of
// value they produce.
const FILTERABLE_TYPES = ['bool', 'picklist', 'fk', 'date', 'text', 'textarea', 'number', 'currency', 'percent', 'formula', 'rollup'];

// Resolves which KIND of filter control/logic a field needs: 'exact' (a
// single value match), 'date-range', or 'number-range' (both from/to
// bounds). Formula/rollup fields inherit their kind from their Format As
// setting — that's the only signal available about what shape of value
// they actually produce, since the field itself is just an expression.
function filterKindFor(field) {
  if (!field) return null;
  if (['bool', 'picklist', 'fk', 'text', 'textarea'].includes(field.type)) return 'exact';
  if (field.type === 'date') return 'date-range';
  if (['number', 'currency', 'percent'].includes(field.type)) return 'number-range';
  if (field.type === 'formula' || field.type === 'rollup') {
    if (field.format === 'currency' || field.format === 'percent') return 'number-range';
    if (field.format === 'date' || field.format === 'datetime') return 'date-range';
    return 'exact'; // plain format — value shape unknown, safest default
  }
  return null;
}

function filterFieldsFor(entity) {
  return (entity.filterFields || []).map(name => entity.fields.find(f => f.name === name)).filter(Boolean);
}

function addFilterField(schema, entityKey, fieldName) {
  const e = schema.entities[entityKey];
  if (!e) return;
  const f = e.fields.find(fl => fl.name === fieldName);
  if (!f || !FILTERABLE_TYPES.includes(f.type)) return;
  if (!e.filterFields.includes(fieldName)) e.filterFields.push(fieldName);
}

function removeFilterField(schema, entityKey, fieldName) {
  const e = schema.entities[entityKey];
  if (!e) return;
  e.filterFields = e.filterFields.filter(n => n !== fieldName);
}

function moveFilterField(schema, entityKey, fieldName, dir) {
  const e = schema.entities[entityKey];
  if (!e) return;
  const idx = e.filterFields.indexOf(fieldName);
  if (idx === -1) return;
  const swapWith = dir === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= e.filterFields.length) return;
  const tmp = e.filterFields[idx];
  e.filterFields[idx] = e.filterFields[swapWith];
  e.filterFields[swapWith] = tmp;
}

// ---- Picklist fields (static, admin-entered comma-separated options) ------
// Custom (per-field) picklist values now live directly on the field as
// picklistValues: [{key, label, active}] — same shape as a global static
// picklist's values, for consistency. Returns active-only label strings;
// kept for the few call sites that only need display text with no schema
// in hand. Prefer resolvePicklistOptions elsewhere — it returns {key,label}
// pairs and covers custom, global-static, AND global-table-sourced.
function picklistOptions(field) {
  return (field.picklistValues || []).filter(v => v.active !== false).map(v => v.label);
}

// ... (default-value comment block preserved above this point)

// The actual options a picklist-type field should offer right now, as
// {key, label} pairs — key is what gets STORED on the record (stable,
// survives a label rename); label is what a person reads. Unifies all
// three sources: custom (field.picklistValues), global static
// (picklist.values), and global table-sourced (each candidate row's own
// primary key as the option key — same "store a stable id, resolve a
// live display" shape a normal fk field already has). `record` is
// optional — needed only to resolve a constrained table-sourced
// picklist's filter value; omitted, a table-sourced picklist simply
// returns every value unfiltered.
function resolvePicklistOptions(schema, entity, field, record) {
  if (field.picklistSource !== 'global' || !field.picklistKey) {
    return (field.picklistValues || []).filter(v => v.active !== false).map(v => ({ key: v.key, label: v.label }));
  }
  const picklist = picklistByKey(schema, field.picklistKey);
  if (!picklist) return [];
  if (picklist.sourceType === 'static') {
    return (picklist.values || []).filter(v => v.active !== false).map(v => ({ key: v.key, label: v.label }));
  }
  const sourceEntity = schema.entities[picklist.sourceTable];
  if (!sourceEntity) return [];
  let rows = db.getAll(picklist.sourceTable);
  if (picklist.sourceConstraintField && field.picklistConstraintField && record) {
    const constraintVal = record[field.picklistConstraintField];
    if (constraintVal !== undefined && constraintVal !== '') {
      rows = rows.filter(r => String(r[picklist.sourceConstraintField]) === String(constraintVal));
    }
  }
  const seen = new Set();
  const out = [];
  rows.forEach(r => {
    // sourceValueField may itself be a formula/rollup field (e.g. a
    // "Month Year" display computed from separate month+year columns) —
    // resolve computed fields on the candidate row before reading it,
    // same as any other place a table's fields are displayed.
    const full = withComputedFields(schema, sourceEntity, r);
    const label = full[picklist.sourceValueField];
    if (label === undefined || label === null || label === '') return;
    const key = String(r[sourceEntity.pk]);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, label: String(label) });
  });
  return out;
}

// Reverse lookup: given a picklist field's STORED value (the key), what
// should currently display? Mirrors how an fk field resolves a stored PK
// to a live display name. Falls back to the raw stored value itself if
// the key can't be resolved (e.g. the option was later deleted outright,
// not just deactivated) — showing something rather than a blank is more
// useful for spotting and fixing an orphaned reference.
function resolvePicklistLabel(schema, entity, field, keyValue) {
  if (keyValue === undefined || keyValue === null || keyValue === '') return keyValue;
  if (field.picklistSource !== 'global' || !field.picklistKey) {
    const v = (field.picklistValues || []).find(x => x.key === keyValue);
    return v ? v.label : keyValue;
  }
  const picklist = picklistByKey(schema, field.picklistKey);
  if (!picklist) return keyValue;
  if (picklist.sourceType === 'static') {
    const v = (picklist.values || []).find(x => x.key === keyValue);
    return v ? v.label : keyValue;
  }
  const sourceEntity = schema.entities[picklist.sourceTable];
  if (!sourceEntity) return keyValue;
  const row = db.getByIdActive(picklist.sourceTable, sourceEntity.pk, keyValue);
  if (!row) return keyValue;
  // Same as resolvePicklistOptions above: sourceValueField may be a
  // computed field, which only exists after withComputedFields runs.
  const full = withComputedFields(schema, sourceEntity, row);
  const label = full[picklist.sourceValueField];
  return (label === undefined || label === null || label === '') ? keyValue : label;
}

// ---- Default values ----------------------------------------------------
// A field can default to a static value (defaultMode 'static') or a
// formula (defaultMode 'formula', same language as everywhere else —
// e.g. TODAY() for a date field). Applies only at creation, never on
// update. Shared by both the "new record" form (so the admin/user SEES
// the default and can still change it) and the actual create POST (so
// an "always read-only" field — which a browser never submits at all,
// since disabled form fields are excluded from submission — still gets
// its value set correctly rather than landing blank).
function coerceDefaultValueForType(field, raw) {
  if (field.type === 'bool') return raw === 'true' || raw === true;
  if (field.type === 'number' || field.type === 'currency' || field.type === 'percent') {
    const n = Number(raw);
    return isNaN(n) ? '' : n;
  }
  return raw;
}

function computeFieldDefault(schema, entity, field, record) {
  if (field.defaultMode === 'static' && field.defaultValue !== undefined && field.defaultValue !== '') {
    return coerceDefaultValueForType(field, field.defaultValue);
  }
  if (field.defaultMode === 'formula' && field.defaultFormula && field.defaultFormula.trim()) {
    const result = evalFormula(field.defaultFormula, schema, entity, record, {}, 0);
    // A default formula failing (e.g. #ERR) shouldn't ever land a visible
    // error string in a brand-new record's field — fall back to blank.
    if (typeof result === 'string' && result.startsWith('#')) return '';
    return result;
  }
  return undefined; // no default configured
}

function applyFieldDefaults(schema, entity, record) {
  entity.fields.forEach(f => {
    if (COMPUTED_TYPES.includes(f.type) || LAYOUT_TYPES.includes(f.type) || f.type === 'image' || f.type === 'file' || f.key) return;
    const def = computeFieldDefault(schema, entity, f, record);
    if (def !== undefined) record[f.name] = def;
  });
  return record;
}

// ---- Series (auto-numbered, grouped) fields --------------------------------
// e.g. a per-landlord bill sequence: BILLS_SeriesNo groups by resolving
// "BILLS_ClientCode.T_MappedTo" (the bill's tenant's landlord) and tracks
// the running count in a designated tracker table/fields (e.g. billseries).
function seriesGroupKey(schema, entity, field, record) {
  const [refPart, fieldPart] = String(field.seriesGroupPath || '').split('.');
  if (!refPart || !fieldPart) return null;
  const resolved = resolveCrossTableValue(schema, entity, record, refPart, fieldPart);
  if (resolved.error) return null; // misconfigured group path — treated as "no series assigned" rather than breaking record creation
  return resolved.value === undefined || resolved.value === '' ? null : resolved.value;
}

function nextSeriesNumber(schema, field, groupKey) {
  const trackerEntity = schema.entities[field.seriesTrackerEntity];
  if (!trackerEntity) return 1;
  const groupFieldName = field.seriesTrackerGroupField;
  const counterFieldName = field.seriesTrackerCounterField;
  if (!groupFieldName || !counterFieldName) return 1;

  const rows = db.getAll(trackerEntity.key);
  let row = rows.find(r => String(r[groupFieldName]) === String(groupKey));

  if (!row) {
    const pkField = trackerEntity.fields.find(f => f.key);
    row = {};
    trackerEntity.fields.forEach(f => { row[f.name] = ''; });
    row[groupFieldName] = groupKey;
    row[counterFieldName] = 0;
    if (pkField && pkField.auto) row[pkField.name] = db.nextAutoId(trackerEntity.key, trackerEntity.pk);
    db.insert(trackerEntity.key, row);
  }

  const next = (Number(row[counterFieldName]) || 0) + 1;
  db.update(trackerEntity.key, trackerEntity.pk, row[trackerEntity.pk], { ...row, [counterFieldName]: next });
  return next;
}

// Assigns values for every 'series' field on a freshly-built record (called
// once at create time only — series numbers, once issued, don't change).
function assignSeriesFields(schema, entity, record) {
  entity.fields.filter(f => f.type === 'series').forEach(f => {
    const groupKey = seriesGroupKey(schema, entity, f, record);
    record[f.name] = groupKey === null ? '' : nextSeriesNumber(schema, f, groupKey);
  });
  return record;
}

// Children are derived automatically: any fk field elsewhere that points
// at this entity makes that other table a "child" shown on the detail page.
function getChildren(schema, entityKey) {
  const kids = [];
  Object.values(schema.entities).forEach(other => {
    if (other.key === entityKey) return;
    (other.fields || []).forEach(f => {
      if (f.type === 'fk' && f.ref === entityKey) {
        kids.push({ entity: other.key, fk: f.name, label: `${other.label} (via ${f.label})` });
      }
    });
  });
  return kids;
}

function isReferenced(schema, entityKey) {
  return getChildren(schema, entityKey).length > 0;
}

// Data-level delete guard — unlike isReferenced/getChildren above (which
// only check whether some OTHER table's SCHEMA has an fk field pointing
// at this table at all, regardless of actual data), this checks whether
// any REAL ROW in any such table currently holds a value matching the
// SPECIFIC record being deleted. Scoped to direct children only (one
// hop) — deliberately, not multi-hop: since this same check applies
// uniformly at every delete, a grandchild table can never be silently
// orphaned either, since deleting its direct parent would already have
// been blocked one level up first.
function findBlockingReferences(schema, entityKey, pkValue) {
  const blockers = [];
  getChildren(schema, entityKey).forEach(child => {
    const childEntity = schema.entities[child.entity];
    const fkField = childEntity.fields.find(f => f.name === child.fk);
    const matches = db.getChildren(child.entity, child.fk, pkValue);
    if (matches.length > 0) {
      blockers.push({ entityKey: child.entity, entityLabel: childEntity.label, fieldLabel: fkField ? fkField.label : child.fk, count: matches.length });
    }
  });
  return blockers;
}

// ---- Configurable child applets (Views -> Child Applets) ------------------
// Discovers every applet that COULD show on entityKey's detail page — both
// direct children (fk pointing at entityKey) and grandchildren (fk pointing
// at one of those children, two hops away, e.g. Bills via Tenant via
// Landlord). Metadata only, no row data — used both by the admin Views page
// (to list choices) and by computeAppletData below (to know what to fetch).
// Canonical keys ("child:tenants:T_MappedTo", "grandchild:bills") are stable
// as long as field names don't change, which they can't once created.
function discoverApplets(schema, entityKey) {
  const entity = schema.entities[entityKey];
  const results = [];
  const directChildren = getChildren(schema, entityKey);
  directChildren.forEach(child => {
    results.push({
      appletKey: `child:${child.entity}:${child.fk}`,
      kind: 'child',
      label: child.label,
      entity: child.entity,
      viaEntity: entityKey,
      fk: child.fk,
    });
  });
  directChildren.forEach(child => {
    getChildren(schema, child.entity).forEach(gc => {
      if (gc.entity === entityKey) return; // don't loop back to the original parent
      if (directChildren.some(c => c.entity === gc.entity)) return; // already a direct child
      if (results.some(r => r.entity === gc.entity)) return; // dedupe multiple paths to the same grandchild table
      const grandEntity = schema.entities[gc.entity];
      if (!grandEntity) return;
      results.push({
        appletKey: `grandchild:${gc.entity}`,
        kind: 'grandchild',
        label: `${grandEntity.label} (via ${entity.singular})`,
        entity: gc.entity,
        viaEntity: child.entity,
        viaFk: child.fk,
        fk: gc.fk,
      });
    });
  });
  return results;
}

function appletSettingsFor(schema, entityKey) {
  const e = schema.entities[entityKey];
  return (e && Array.isArray(e.appletSettings)) ? e.appletSettings : [];
}

// Generates a fresh instance key for a given base relationship — the first
// instance of a relationship is just "<baseKey>#1", additional instances
// increment. Needed because multiple instances of the same relationship
// (e.g. two differently-filtered Bills applets) can now coexist, so a
// relationship alone is no longer a unique identifier — see addApplet.
function nextAppletInstanceKey(schema, entityKey, baseKey) {
  const existingNums = appletSettingsFor(schema, entityKey)
    .filter(s => s.baseKey === baseKey)
    .map(s => { const m = String(s.instanceKey).match(/#(\d+)$/); return m ? Number(m[1]) : 0; });
  const next = existingNums.length ? Math.max(...existingNums) + 1 : 1;
  return `${baseKey}#${next}`;
}

// Adds a NEW instance of the given base relationship (e.g. "child:tenants:T_MappedTo")
// — always creates a fresh instance, never toggles/dedupes, so the same
// relationship can be added more than once with different filters and
// labels. The Available list in Admin stays clickable even after an
// applet's already been added, specifically to support this.
// Renamed from the original addApplet — a second, unrelated addApplet
// (schema, input) was added later for the Applet/View/Screen builder,
// and JS silently let that declaration win, breaking every call to this
// one. See the critical-security-patch backlog entry for the full story.
function addChildAppletInstance(schema, entityKey, baseKey) {
  const e = schema.entities[entityKey];
  if (!e) return;
  const valid = discoverApplets(schema, entityKey).some(a => a.appletKey === baseKey);
  if (!valid) return;
  const instanceKey = nextAppletInstanceKey(schema, entityKey, baseKey);
  e.appletSettings.push({ instanceKey, baseKey, label: '', filterField: '', filterValue: '', filterFrom: '', filterTo: '' });
}

function removeApplet(schema, entityKey, instanceKey) {
  const e = schema.entities[entityKey];
  if (!e) return;
  e.appletSettings = e.appletSettings.filter(s => s.instanceKey !== instanceKey);
}

function reorderApplets(schema, entityKey, orderedInstanceKeys) {
  const e = schema.entities[entityKey];
  if (!e || !Array.isArray(orderedInstanceKeys)) return;
  e.appletSettings = reorderByKey(e.appletSettings || [], s => s.instanceKey, orderedInstanceKeys);
}

// Sets (or clears, or changes) the one predefined filter condition on a
// shown applet instance, and/or its custom label. Switching to a
// different field always resets any previously-set value — a stale bool
// "Yes" carried over onto a freshly-chosen picklist field would be
// meaningless. The admin UI relies on this: the field dropdown
// auto-submits on change, and this function discards whatever
// (now-irrelevant) value happened to be in the DOM at that moment rather
// than needing client-side JS to clear it first.
function setAppletFilter(schema, entityKey, instanceKey, input) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  const setting = (e.appletSettings || []).find(s => s.instanceKey === instanceKey);
  if (!setting) throw new Error('That applet is not currently shown on this table.');
  const applet = discoverApplets(schema, entityKey).find(a => a.appletKey === setting.baseKey);
  if (!applet) throw new Error('That applet is no longer available.');
  const targetEntity = schema.entities[applet.entity];

  if (typeof input.label === 'string') {
    setting.label = input.label.trim();
  }

  const newField = (input.filterField || '').trim();
  if (!newField) {
    setting.filterField = '';
    setting.filterValue = '';
    setting.filterFrom = '';
    setting.filterTo = '';
    return;
  }
  const f = targetEntity.fields.find(fl => fl.name === newField);
  if (!f) throw new Error(`"${newField}" is not a field on ${targetEntity.label}.`);
  if (!FILTERABLE_TYPES.includes(f.type)) throw new Error(`Applet filters only support ${FILTERABLE_TYPES.join('/')} fields.`);

  const fieldChanged = setting.filterField !== newField;
  setting.filterField = newField;
  if (fieldChanged) {
    setting.filterValue = '';
    setting.filterFrom = '';
    setting.filterTo = '';
  } else {
    const kind = filterKindFor(f);
    if (kind === 'date-range' || kind === 'number-range') {
      setting.filterFrom = (input.filterFrom || '').trim();
      setting.filterTo = (input.filterTo || '').trim();
    } else {
      setting.filterValue = (input.filterValue || '').trim();
    }
  }
}

// Applies one applet's predefined filter to its already-fetched rows.
// Mirrors the List-screen filter's per-type semantics exactly (bool exact
// match, picklist/fk exact string match, date inclusive from/to range) —
// just always-on rather than user-adjustable. Degrades gracefully (no
// filtering) if the configured field no longer exists, though deleteField
// clears these settings proactively so that shouldn't normally happen.
// Shared "does this row match?" logic for List filters, Child Applet
// filters, and Report parameters — the three places in the app that all
// need the same three behaviors: bool/picklist/fk/text exact match, date
// range, and number/currency/percent range (with percent scaling).
// Previously each had its own copy of this logic; consolidated here so a
// future bugfix or new field-type addition only needs to happen once.
//
// `getValue(row)` abstracts away HOW the value is read, since that's the
// one real difference between callers: List/Applet filters read a field
// directly off the row (`row[fieldName]`), while Report parameters
// evaluate a full formula expression (since a parameter can be a
// cross-table reference, not just a bare field on the row being
// filtered). `fieldType`/`isPercent` are passed as plain values rather
// than a whole field object, since Report parameters precompute
// `isPercent` at definition time rather than holding a real field def.
function applyFilterCondition(rows, kind, fieldType, isPercent, filterSpec, getValue) {
  if (kind === 'date-range') {
    const from = filterSpec.from || '';
    const to = filterSpec.to || '';
    if (!from && !to) return rows;
    return rows.filter(r => {
      const v = getValue(r);
      if (!v) return false;
      if (from && v < from) return false;
      if (to && v > to) return false;
      return true;
    });
  }
  if (kind === 'number-range') {
    const from = filterSpec.from || '';
    const to = filterSpec.to || '';
    if (!from && !to) return rows;
    const scale = isPercent ? 100 : 1;
    return rows.filter(r => {
      const n = Number(getValue(r));
      if (isNaN(n)) return false;
      const displayVal = n * scale;
      if (from !== '' && displayVal < Number(from)) return false;
      if (to !== '' && displayVal > Number(to)) return false;
      return true;
    });
  }
  const val = filterSpec.value || '';
  if (!val) return rows;
  if (fieldType === 'bool') {
    const want = val === 'true';
    return rows.filter(r => !!getValue(r) === want);
  }
  return rows.filter(r => String(getValue(r) ?? '') === val);
}

function applyAppletFilter(schema, applet, setting, rows) {
  if (!setting || !setting.filterField) return rows;
  const targetEntity = schema.entities[applet.entity];
  const f = targetEntity && targetEntity.fields.find(fl => fl.name === setting.filterField);
  if (!f) return rows;
  const kind = filterKindFor(f);
  const isPercent = f.type === 'percent' || f.format === 'percent';
  return applyFilterCondition(
    rows, kind, f.type, isPercent,
    { from: setting.filterFrom, to: setting.filterTo, value: setting.filterValue },
    r => r[setting.filterField]
  );
}

// Full applet data for a record's detail page: whichever applet INSTANCES
// are configured as shown (in their configured order), each with its rows
// fetched, computed fields resolved, that instance's predefined filter
// applied, and sorted per the target entity's default sort. Multiple
// instances of the same relationship (e.g. two differently-filtered Bills
// applets) are fully independent here — each just re-fetches and
// re-filters the same underlying rows its own way.
function computeAppletData(schema, entityKey, record, sortFn) {
  const entity = schema.entities[entityKey];
  if (!entity) return [];
  const available = discoverApplets(schema, entityKey);
  const shown = appletSettingsFor(schema, entityKey);

  return shown.map(setting => {
    const applet = available.find(a => a.appletKey === setting.baseKey);
    if (!applet) return null; // configured instance's relationship no longer discoverable (e.g. the linking field was deleted) — skip silently
    const targetEntity = schema.entities[applet.entity];
    if (!targetEntity) return null;

    let rows;
    if (applet.kind === 'child') {
      rows = db.getChildren(applet.entity, applet.fk, record[entity.pk]);
    } else {
      // Grandchild: fetch the intermediate hop's rows for this record, then
      // this applet's rows for each of those, deduping by primary key (the
      // same record could theoretically be reachable via more than one
      // intermediate row).
      const hop1Applet = available.find(a => a.kind === 'child' && a.entity === applet.viaEntity);
      const hop1Rows = hop1Applet ? db.getChildren(applet.viaEntity, hop1Applet.fk, record[entity.pk]) : [];
      const viaEntity = schema.entities[applet.viaEntity];
      let combined = [];
      hop1Rows.forEach(hop1Row => {
        combined = combined.concat(db.getChildren(applet.entity, applet.fk, hop1Row[viaEntity.pk]));
      });
      const seen = new Set();
      rows = combined.filter(r => {
        const k = r[targetEntity.pk];
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    rows = rows.map(r => withComputedFields(schema, targetEntity, r));
    rows = applyAppletFilter(schema, applet, setting, rows);
    if (typeof sortFn === 'function') rows = sortFn(targetEntity, rows);

    return {
      cfg: { entity: applet.entity, label: setting.label || applet.label },
      entity: targetEntity,
      rows,
      listFields: listFieldsFor(targetEntity),
    };
  }).filter(Boolean);
}

// ---- mutations (all operate on an in-memory schema; caller persists) -----

function addEntity(schema, { key, label, singular, pkName, pkLabel, pkAuto }) {
  if (!label || !String(label).trim()) throw new Error('Screen label is required.');
  const k = slugify(key || label);
  if (schema.entities[k]) throw new Error(`A table with key "${k}" already exists.`);
  const pk = safeFieldName(pkName || 'id');
  schema.entities[k] = {
    key: k,
    label: label.trim(),
    singular: (singular || label).trim(),
    pk,
    displayField: '',
    displayPrefix: '',
    listTitle: '',
    detailTitle: '',
    auditEnabled: false,
    listColumns: [pk],
    filterFields: [],
    sortField: '',
    sortDir: 'asc',
    fields: [
      { name: pk, label: (pkLabel || pk).trim(), type: pkAuto ? 'number' : 'text', required: true, key: true, auto: !!pkAuto, inList: true },
    ],
  };
  schema.navOrder.push(k);
  return schema.entities[k];
}

function updateEntitySettings(schema, entityKey, { label, singular, displayField, displayPrefix, listTitle, detailTitle, auditEnabled }) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  if (label && label.trim()) e.label = label.trim();
  if (singular && singular.trim()) e.singular = singular.trim();
  e.displayField = displayField || '';
  e.displayPrefix = displayPrefix || '';
  e.listTitle = listTitle || '';
  e.detailTitle = detailTitle || '';
  e.auditEnabled = !!auditEnabled;
}

function deleteEntity(schema, entityKey) {
  if (!schema.entities[entityKey]) throw new Error('Unknown table.');
  if (isReferenced(schema, entityKey)) {
    throw new Error('Cannot delete: other tables have fields linking to this one. Remove or repoint those fields first.');
  }
  delete schema.entities[entityKey];
  schema.navOrder = schema.navOrder.filter(k => k !== entityKey);
}

function moveNav(schema, entityKey, dir) {
  const idx = schema.navOrder.indexOf(entityKey);
  if (idx === -1) return;
  const swapWith = dir === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= schema.navOrder.length) return;
  const tmp = schema.navOrder[idx];
  schema.navOrder[idx] = schema.navOrder[swapWith];
  schema.navOrder[swapWith] = tmp;
}

function addNav(schema, entityKey) {
  if (!schema.entities[entityKey]) return;
  if (!schema.navOrder.includes(entityKey)) schema.navOrder.push(entityKey);
}

function removeNav(schema, entityKey) {
  const before = schema.navOrder.length;
  schema.navOrder = schema.navOrder.filter(k => k !== entityKey);
  return schema.navOrder.length !== before; // true only if something was actually removed
}

// ---- Left sidebar: groups, items, icon-guessing, migration ---------------
// See the schema.sidebarGroups comment in normalizeSchema for the overall
// shape and why this exists as a real, admin-editable structure instead of
// the old auto-generated flat tab list.

const icons = require('./icons');

// Best-effort icon guess for an existing table at migration time only —
// matches on recognizable substrings in the table's own key, falls back to
// a generic icon for anything unrecognized. Never called again after the
// one-time migration; an admin's own icon choice always wins from then on.
function guessIconForKey(entityKey) {
  const k = String(entityKey || '').toLowerCase();
  const rules = [
    [/landlord/, 'building'], [/tenant/, 'users'], [/bank/, 'bank'], [/propert|proptax/, 'home-dollar'],
    [/payee/, 'tag'], [/payment/, 'wallet'], [/cheque/, 'credit-card'], [/cctracker|cc_track/, 'trending-up'],
    [/invoice/, 'file-invoice'], [/bill_series|bs_id/, 'receipt'], [/gstrate|tax/, 'calculator'],
    [/caldata|calendar/, 'calendar'], [/incomeoth/, 'currency-rupee'], [/expense/, 'wallet'],
    [/reminder/, 'bell'], [/screen/, 'layout'], [/report/, 'chart-bar'],
  ];
  const hit = rules.find(([re]) => re.test(k));
  return hit ? hit[1] : icons.DEFAULT_ICON;
}

// Built-in mini-app routes aren't real schema entities with their own
// navOrder slot (their child tables are, but the route itself is custom) —
// listed here once so both the migration and the Admin "add item" picker
// know about them without hardcoding this list in more than one place.
// entityKeys is the set of tables read-permission actually gates the link
// on (matches each module's own canView logic) — plural because e.g. Bills
// needs BOTH expense_items and expense_entries readable, not just one.
function builtinSidebarLinks(schema) {
  const links = [];
  if (schema.entities['expense_items']) links.push({ path: '/bills', label: 'Bills', icon: 'wallet', entityKeys: ['expense_items', 'expense_entries'] });
  if (schema.entities['reminders']) links.push({ path: '/reminders', label: 'Reminders', icon: 'bell', entityKeys: ['reminders', 'reminder_log'] });
  links.push({ path: '/reports', label: 'Reports', icon: 'chart-bar', entityKeys: [] });
  return links;
}

function migrateSidebarGroups(schema) {
  const items = schema.navOrder
    .filter(key => schema.entities[key])
    .map(key => ({ path: `/${key}`, label: schema.entities[key].label, icon: guessIconForKey(key), entityKeys: [key] }));
  screensFor(schema).forEach(s => {
    items.push({ path: `/screens/${s.key}`, label: s.label, icon: 'layout', entityKeys: [] });
  });
  builtinSidebarLinks(schema).forEach(link => items.push(link));
  if (items.length === 0) return [];
  return [{ key: 'all-tables-' + Date.now().toString(36), label: 'All Tables', collapsedByDefault: false, items }];
}

function validateSidebarItem(schema, input) {
  const path = String(input.path || '').trim();
  if (!path || !path.startsWith('/')) throw new Error('Item needs a path starting with "/".');
  const label = String(input.label || '').trim();
  if (!label) throw new Error('Item needs a label.');
  const icon = icons.ICONS[input.icon] ? input.icon : icons.DEFAULT_ICON;
  const entityKeys = Array.isArray(input.entityKeys) ? input.entityKeys.filter(k => schema.entities[k]) : [];
  return { path, label, icon, entityKeys };
}

function addSidebarGroup(schema, input) {
  const label = String((input && input.label) || '').trim();
  if (!label) throw new Error('Group needs a label.');
  const group = { key: slugify(label) + '-' + Date.now().toString(36), label, collapsedByDefault: !!(input && input.collapsedByDefault), items: [] };
  schema.sidebarGroups.push(group);
  return group;
}

function updateSidebarGroup(schema, groupKey, input) {
  const group = schema.sidebarGroups.find(g => g.key === groupKey);
  if (!group) throw new Error('Unknown sidebar group.');
  if (typeof input.label === 'string' && input.label.trim()) group.label = input.label.trim();
  if (typeof input.collapsedByDefault === 'boolean') group.collapsedByDefault = input.collapsedByDefault;
  return group;
}

function deleteSidebarGroup(schema, groupKey) {
  schema.sidebarGroups = schema.sidebarGroups.filter(g => g.key !== groupKey);
}

function reorderSidebarGroups(schema, orderedKeys) {
  const byKey = {};
  schema.sidebarGroups.forEach(g => { byKey[g.key] = g; });
  schema.sidebarGroups = orderedKeys.map(k => byKey[k]).filter(Boolean);
}

function addSidebarItem(schema, groupKey, input) {
  const group = schema.sidebarGroups.find(g => g.key === groupKey);
  if (!group) throw new Error('Unknown sidebar group.');
  const item = validateSidebarItem(schema, input);
  group.items.push(item);
  return item;
}

function updateSidebarItem(schema, groupKey, itemIndex, input) {
  const group = schema.sidebarGroups.find(g => g.key === groupKey);
  if (!group) throw new Error('Unknown sidebar group.');
  const existing = group.items[itemIndex];
  if (!existing) throw new Error('Unknown sidebar item.');
  const merged = validateSidebarItem(schema, { ...existing, ...input });
  group.items[itemIndex] = merged;
  return merged;
}

function deleteSidebarItem(schema, groupKey, itemIndex) {
  const group = schema.sidebarGroups.find(g => g.key === groupKey);
  if (!group) throw new Error('Unknown sidebar group.');
  group.items.splice(itemIndex, 1);
}

function reorderSidebarItems(schema, groupKey, orderedIndexes) {
  const group = schema.sidebarGroups.find(g => g.key === groupKey);
  if (!group) throw new Error('Unknown sidebar group.');
  group.items = orderedIndexes.map(i => group.items[i]).filter(Boolean);
}

// What the sidebar actually renders for one request: schema.sidebarGroups,
// filtered down to items the current user can actually read (same
// usersLib.can check res.locals.navOrder already uses elsewhere) and with
// empty groups dropped entirely rather than shown as a bare, useless
// header. entityKeys: [] (Reports, a Screen) always passes — there's
// nothing table-shaped to gate those on.
// Fixes a duplicate baked into sidebarGroups by the one-time migration
// itself, on any schema that already migrated before this existed: for a
// table with a matching built-in mini-app link (Reminders, Bills),
// migrateSidebarGroups added it TWICE within the same "All Tables" group
// — once as a generic per-table entry from navOrder, once again from
// builtinSidebarLinks — both with the identical path, just constructed by
// two different code paths. Deliberately scoped to *within one group*,
// not globally: the same table CAN legitimately sit in two different
// groups on purpose (an admin's own choice via the Sidebar editor), and
// this must never undo that — it only removes an exact (same path) repeat
// sitting right next to itself in the same group, which is never
// intentional.
function dedupeSidebarItemsWithinGroups(schema) {
  let changed = false;
  schema.sidebarGroups.forEach(g => {
    const seen = new Set();
    const deduped = g.items.filter(it => {
      if (seen.has(it.path)) { changed = true; return false; }
      seen.add(it.path);
      return true;
    });
    if (deduped.length !== g.items.length) g.items = deduped;
  });
  return changed;
}

function sidebarGroupsFor(schema, canFn) {
  return schema.sidebarGroups
    .map(g => ({
      ...g,
      items: g.items.filter(it => !it.entityKeys || it.entityKeys.length === 0 || it.entityKeys.every(k => canFn(k, 'read'))),
    }))
    .filter(g => g.items.length > 0);
}

// Turns whatever shape the field-editor route hands in (an array of
// {key, label, active} rows, in submission order) into a clean
// [{key,label,active}] list — trims, drops blank-label rows, dedupes by
// label, mints a key for any row that doesn't already have one (a
// brand-new option), and leaves existing keys untouched so records
// already using them keep resolving correctly across a save.
function normalizePicklistValueRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const existingKeys = new Set(list.map(r => r && r.key).filter(Boolean));
  const seenLabels = new Set();
  const out = [];
  list.forEach(r => {
    if (!r) return;
    const label = String(r.label || '').trim();
    if (!label || seenLabels.has(label)) return;
    seenLabels.add(label);
    let key = r.key && String(r.key).trim();
    if (!key) {
      key = genPicklistKey(existingKeys, label);
      existingKeys.add(key);
    }
    out.push({ key, label, active: r.active !== false && r.active !== 'off' });
  });
  return out;
}

// Converts a comma-separated string of option labels into picklistValues
// rows — the bridge for internal modules (bills.js, reminders.js, tax.js,
// default-schema.js) that define their built-in picklist fields as a
// simple comma list, same convenience the old `options` string param
// offered, now producing the key/label shape addField/updateField expect.
function picklistValuesFromCsv(csv) {
  return String(csv || '').split(',').map(s => s.trim()).filter(Boolean).map(label => ({ label }));
}

function addField(schema, entityKey, { name, label, type, ref, required, inList, rows, formula, format, picklistValues, seriesGroupPath, seriesTrackerEntity, seriesTrackerGroupField, seriesTrackerCounterField, rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField, rollupWhere, fkWhere, fkBulkLink, hint, hintImportant, readOnlyMode, defaultMode, defaultValue, defaultFormula, picklistSource, picklistKey, picklistConstraintField }) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  if (!name || !String(name).trim()) throw new Error('Field name is required.');
  const t = FIELD_TYPES.includes(type) ? type : 'text';
  if (t !== 'spacer' && (!label || !String(label).trim())) throw new Error('Field label is required.');
  const fname = safeFieldName(name);
  if (e.fields.some(f => f.name === fname)) throw new Error(`Field "${fname}" already exists on this table.`);
  if (t === 'fk' && (!ref || !schema.entities[ref])) throw new Error('Please choose a table for this lookup field to link to.');
  if (t === 'formula' && (!formula || !formula.trim())) throw new Error('Please enter a formula for this calculated field.');
  const usesGlobalPicklist = t === 'picklist' && picklistSource === 'global';
  const resolvedPicklistValues = normalizePicklistValueRows(picklistValues);
  if (t === 'picklist' && !usesGlobalPicklist && resolvedPicklistValues.length === 0) throw new Error('Please add at least one option, or choose a Global Picklist instead.');
  if (usesGlobalPicklist && (!picklistKey || !picklistByKey(schema, picklistKey))) throw new Error('Choose a valid Global Picklist.');
  if (t === 'series' && (!seriesGroupPath || !seriesTrackerEntity || !seriesTrackerGroupField || !seriesTrackerCounterField)) {
    throw new Error('Series fields need a group path, a tracker table, and its group/counter fields.');
  }
  if (t === 'rollup') validateRollupConfig(schema, entityKey, { rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField });
  const isEligibleForReadOnlyAndDefault = !COMPUTED_TYPES.includes(t) && !LAYOUT_TYPES.includes(t);
  if (isEligibleForReadOnlyAndDefault && readOnlyMode === 'always' && defaultMode !== 'static' && defaultMode !== 'formula' && required) {
    throw new Error(`This field is required but set to always read-only with no default — it could never actually be filled in. Add a default value, or change one of these two settings.`);
  }
  const resolvedDefaultMode = isEligibleForReadOnlyAndDefault && ['static', 'formula'].includes(defaultMode) ? defaultMode : undefined;
  e.fields.push({
    name: fname,
    label: t === 'spacer' ? (label && label.trim() ? label.trim() : '(Spacer)') : label.trim(),
    type: t,
    ref: t === 'fk' ? ref : undefined,
    required: (COMPUTED_TYPES.includes(t) || LAYOUT_TYPES.includes(t)) ? false : !!required,
    inList: LAYOUT_TYPES.includes(t) ? false : !!inList,
    key: false,
    rows: t === 'textarea' ? (Number(rows) > 0 ? Number(rows) : 2) : undefined,
    formula: t === 'formula' ? formula.trim() : undefined,
    format: (t === 'formula' || t === 'rollup') ? (['currency', 'percent', 'date', 'datetime'].includes(format) ? format : 'none') : undefined,
    picklistValues: (t === 'picklist' && !usesGlobalPicklist) ? resolvedPicklistValues : undefined,
    picklistSource: t === 'picklist' ? (usesGlobalPicklist ? 'global' : 'custom') : undefined,
    picklistKey: usesGlobalPicklist ? picklistKey : undefined,
    // A field ON THIS SAME TABLE whose current value constrains which
    // options a table-sourced Global Picklist actually offers — e.g. an
    // Account Type field on this record filtering which Credit Cards
    // show up, matching against that Picklist's own sourceConstraintField.
    // No effect on a static-sourced picklist (nothing structured to
    // filter by there), or if the referenced picklist has no
    // sourceConstraintField configured at all.
    picklistConstraintField: usesGlobalPicklist && picklistConstraintField ? picklistConstraintField : undefined,
    seriesGroupPath: t === 'series' ? seriesGroupPath.trim() : undefined,
    seriesTrackerEntity: t === 'series' ? seriesTrackerEntity : undefined,
    seriesTrackerGroupField: t === 'series' ? seriesTrackerGroupField.trim() : undefined,
    seriesTrackerCounterField: t === 'series' ? seriesTrackerCounterField.trim() : undefined,
    rollupFn: t === 'rollup' ? rollupFn : undefined,
    rollupHop1Entity: t === 'rollup' ? rollupHop1Entity : undefined,
    rollupHop2Entity: t === 'rollup' ? (rollupHop2Entity || undefined) : undefined,
    rollupField: t === 'rollup' ? rollupField : undefined,
    rollupOrderField: t === 'rollup' ? (rollupOrderField || undefined) : undefined,
    rollupWhere: t === 'rollup' ? (rollupWhere || '') : undefined,
    fkWhere: t === 'fk' ? (fkWhere || '') : undefined,
    // Opt-in only (rule 5: no hardcoding) — the generic "Link Matching
    // Records" bulk-link action (see bulkLinkableRelationships /
    // linkMatchingRecords below) only offers itself for a specific
    // fk-with-fkWhere relationship when this is explicitly turned on for
    // that field. Meaningless without an fkWhere condition, since there'd
    // be no "matching" logic to apply in bulk.
    fkBulkLink: (t === 'fk' && fkWhere && fkWhere.trim()) ? !!fkBulkLink : undefined,
    // A free-text reminder/note an admin can attach to ANY field, shown on
    // the create/edit form near it — not type-specific, since the need
    // for "don't forget to do X here" applies just as much to a plain
    // picklist as to anything else. hintImportant renders it as a
    // red/urgent callout instead of a quiet grey hint, for things that
    // silently break something if skipped (e.g. "pick or create a Tenant
    // Group here — reports that group by it won't find this record
    // otherwise").
    hint: (hint || '').trim() || undefined,
    hintImportant: !!hintImportant,
    readOnlyMode: isEligibleForReadOnlyAndDefault && ['always', 'afterCreation'].includes(readOnlyMode) ? readOnlyMode : undefined,
    defaultMode: resolvedDefaultMode,
    defaultValue: resolvedDefaultMode === 'static' ? (defaultValue || '') : undefined,
    defaultFormula: resolvedDefaultMode === 'formula' ? (defaultFormula || '').trim() : undefined,
  });
  if (inList) addListColumn(schema, entityKey, fname);
}

function validateRollupConfig(schema, entityKey, { rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField }) {
  if (!['SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'LATEST'].includes(rollupFn)) throw new Error('Choose an aggregate function for this rollup.');
  if (!rollupHop1Entity) throw new Error('Choose which related table to roll up.');
  const hop1IsChild = getChildren(schema, entityKey).some(c => c.entity === rollupHop1Entity);
  if (!hop1IsChild) throw new Error(`"${rollupHop1Entity}" isn't a table that links back to this one.`);
  if (rollupHop2Entity) {
    const hop2IsChild = getChildren(schema, rollupHop1Entity).some(c => c.entity === rollupHop2Entity);
    if (!hop2IsChild) throw new Error(`"${rollupHop2Entity}" isn't a table that links back to "${rollupHop1Entity}".`);
  }
  if (rollupFn !== 'COUNT' && (!rollupField || !rollupField.trim())) {
    throw new Error('Choose which field to aggregate (not needed only for COUNT).');
  }
  if (rollupFn === 'LATEST' && (!rollupOrderField || !rollupOrderField.trim())) {
    throw new Error('LATEST needs a field to sort by (e.g. a date field) to know which row is most recent.');
  }
}

function updateField(schema, entityKey, fieldName, { label, type, ref, required, inList, rows, formula, format, picklistValues, seriesGroupPath, seriesTrackerEntity, seriesTrackerGroupField, seriesTrackerCounterField, rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField, rollupWhere, fkWhere, fkBulkLink, hint, hintImportant, readOnlyMode, defaultMode, defaultValue, defaultFormula, picklistSource, picklistKey, picklistConstraintField }) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  const f = e.fields.find(fl => fl.name === fieldName);
  if (!f) throw new Error('Unknown field.');
  if (label && label.trim()) f.label = label.trim();
  f.hint = (hint || '').trim() || undefined;
  f.hintImportant = !!hintImportant;
  if (f.key) return; // primary key: label/hint only, type/ref/required stay fixed
  const t = FIELD_TYPES.includes(type) ? type : f.type;
  if (t === 'fk' && (!ref || !schema.entities[ref])) throw new Error('Please choose a table for this lookup field to link to.');
  if (t === 'formula' && (!formula || !formula.trim())) throw new Error('Please enter a formula for this calculated field.');
  const usesGlobalPicklist = t === 'picklist' && picklistSource === 'global';
  const resolvedPicklistValues = normalizePicklistValueRows(picklistValues);
  if (t === 'picklist' && !usesGlobalPicklist && resolvedPicklistValues.length === 0) throw new Error('Please add at least one option, or choose a Global Picklist instead.');
  if (usesGlobalPicklist && (!picklistKey || !picklistByKey(schema, picklistKey))) throw new Error('Choose a valid Global Picklist.');
  if (t === 'series' && (!seriesGroupPath || !seriesTrackerEntity || !seriesTrackerGroupField || !seriesTrackerCounterField)) {
    throw new Error('Series fields need a group path, a tracker table, and its group/counter fields.');
  }
  if (t === 'rollup') validateRollupConfig(schema, entityKey, { rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField });
  const isEligibleForReadOnlyAndDefault = !COMPUTED_TYPES.includes(t) && !LAYOUT_TYPES.includes(t);
  if (isEligibleForReadOnlyAndDefault && readOnlyMode === 'always' && defaultMode !== 'static' && defaultMode !== 'formula' && required) {
    throw new Error(`"${f.label}" is required but set to always read-only with no default — it could never actually be filled in. Add a default value, or change one of these two settings.`);
  }
  f.type = t;
  f.ref = t === 'fk' ? ref : undefined;
  f.required = (COMPUTED_TYPES.includes(t) || LAYOUT_TYPES.includes(t)) ? false : !!required;
  f.inList = LAYOUT_TYPES.includes(t) ? false : !!inList;
  f.rows = t === 'textarea' ? (Number(rows) > 0 ? Number(rows) : (f.rows || 2)) : undefined;
  f.formula = t === 'formula' ? formula.trim() : undefined;
  f.format = (t === 'formula' || t === 'rollup') ? (['currency', 'percent', 'date', 'datetime'].includes(format) ? format : 'none') : undefined;
  f.picklistValues = (t === 'picklist' && !usesGlobalPicklist) ? resolvedPicklistValues : undefined;
  f.picklistSource = t === 'picklist' ? (usesGlobalPicklist ? 'global' : 'custom') : undefined;
  f.picklistKey = usesGlobalPicklist ? picklistKey : undefined;
  f.picklistConstraintField = usesGlobalPicklist && picklistConstraintField ? picklistConstraintField : undefined;
  f.seriesGroupPath = t === 'series' ? seriesGroupPath.trim() : undefined;
  f.seriesTrackerEntity = t === 'series' ? seriesTrackerEntity : undefined;
  f.seriesTrackerGroupField = t === 'series' ? seriesTrackerGroupField.trim() : undefined;
  f.seriesTrackerCounterField = t === 'series' ? seriesTrackerCounterField.trim() : undefined;
  f.rollupFn = t === 'rollup' ? rollupFn : undefined;
  f.rollupHop1Entity = t === 'rollup' ? rollupHop1Entity : undefined;
  f.rollupHop2Entity = t === 'rollup' ? (rollupHop2Entity || undefined) : undefined;
  f.rollupField = t === 'rollup' ? rollupField : undefined;
  f.rollupOrderField = t === 'rollup' ? (rollupOrderField || undefined) : undefined;
  f.rollupWhere = t === 'rollup' ? (rollupWhere || '') : undefined;
  f.fkWhere = t === 'fk' ? (fkWhere || '') : undefined;
  f.fkBulkLink = (t === 'fk' && fkWhere && fkWhere.trim()) ? !!fkBulkLink : undefined;
  // Read-only and default value are cross-cutting settings, not tied to
  // one field type the way formula/rollup/series config is — but they
  // don't make sense on a field that's already inherently non-editable
  // (formula/rollup/series/spacer/section), so left undefined there.
  f.readOnlyMode = isEligibleForReadOnlyAndDefault && ['always', 'afterCreation'].includes(readOnlyMode) ? readOnlyMode : undefined;
  f.defaultMode = isEligibleForReadOnlyAndDefault && ['static', 'formula'].includes(defaultMode) ? defaultMode : undefined;
  f.defaultValue = f.defaultMode === 'static' ? (defaultValue || '') : undefined;
  f.defaultFormula = f.defaultMode === 'formula' ? (defaultFormula || '').trim() : undefined;
}

// Applies a formula field's configured "Format As" (currency/percent/date/datetime)
// to its computed value, for consistent display in both list and form views.
// Renders a field's optional "hint" text (Admin -> Fields) into safe HTML,
// supporting exactly two Markdown-style patterns and nothing else:
// **bold** and [link text](url). Deliberately not general HTML/Markdown —
// the raw text is HTML-escaped FIRST (neutralizing anything that looks
// like a tag), and only THEN are these two specific patterns recognized
// and turned into real <strong>/<a> tags. This means a hint can never
// inject arbitrary HTML no matter what gets pasted into it, while still
// covering the actual need (a bold reminder with a link to a help
// article) without a general rich-text editor.
function renderHintHtml(hint) {
  if (!hint) return '';
  let escaped = String(hint)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // Links: [text](url) — only http(s):// or a relative "/" path are turned
  // into a real link; anything else (e.g. javascript:) is left as plain
  // escaped text rather than becoming a clickable link.
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
    if (!/^(https?:\/\/|\/)/i.test(url)) return m;
    return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
  });
  // Bold: **text**
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return escaped;
}

function formatFormulaValue(field, value) {
  if (value === '#ERR' || value === '' || value === undefined || value === null) return value;
  if (field.format === 'currency') return formatINR(value);
  if (field.format === 'percent') return formatPercent(value);
  if (field.format === 'date') return formatDate(value, false);
  if (field.format === 'datetime') return formatDate(value, true);
  // A bare bool (e.g. a Report column reading a Yes/No field directly,
  // not through a formula) was previously passing straight through as a
  // raw JS boolean — invisible on screen (EJS just stringifies it as
  // "true"/"false"), but became visibly wrong once report columns
  // started being used as Bill/Report PDF template tags, since there's
  // no separate display layer there to catch it. Same "Yes"/"No"
  // convention formatMergeValue already uses, for consistency.
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // 'number' displays the same as 'none' (raw passthrough) — it exists
  // purely as a declarative signal that a column/aggregate genuinely
  // produces a number, for Report total-row eligibility (see
  // validateReportDef) where there's no other way to know: unlike
  // currency/percent, a plain number doesn't need a display
  // transformation, just a "yes this is numeric" flag.
  return value;
}

function deleteField(schema, entityKey, fieldName) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  const f = e.fields.find(fl => fl.name === fieldName);
  if (f && f.key) throw new Error('Cannot delete the primary key field.');
  e.fields = e.fields.filter(fl => fl.name !== fieldName);
  e.listColumns = (e.listColumns || []).filter(n => n !== fieldName);
  e.filterFields = (e.filterFields || []).filter(n => n !== fieldName);
  if (e.sortField === fieldName) e.sortField = '';
  // If this field was configured as a PayQR role, clear that mapping
  // rather than leaving it pointing at a field that no longer exists —
  // PayQR's own "not configured" check will then fire loudly next time,
  // instead of silently degrading to a confusing 404.
  if (schema.payqrSettings) {
    Object.keys(schema.payqrSettings).forEach(k => {
      if (schema.payqrSettings[k] === fieldName) schema.payqrSettings[k] = '';
    });
  }
  // If this was an fk field, any applet built on it (direct child of
  // entityKey via this exact field) is now meaningless — drop it from
  // whichever entities had it shown. Grandchild applets built through a
  // different table's fk aren't precisely tracked here, but computeAppletData
  // and the admin Views page both re-check against discoverApplets() before
  // display, so any staleness there degrades safely rather than crashing or
  // showing a ghost entry.
  if (f && f.type === 'fk') {
    const appletKey = `child:${entityKey}:${fieldName}`;
    Object.values(schema.entities).forEach(other => {
      if (Array.isArray(other.appletSettings)) {
        other.appletSettings = other.appletSettings.filter(s => s.baseKey !== appletKey);
      }
    });
  }
  // If this field was used as an applet's predefined filter, clear that
  // filter — same "fail loud / reset rather than point at nothing" spirit
  // as the PayQR cleanup above.
  Object.values(schema.entities).forEach(other => {
    (other.appletSettings || []).forEach(s => {
      if (s.filterField === fieldName) {
        s.filterField = '';
        s.filterValue = '';
        s.filterFrom = '';
        s.filterTo = '';
      }
    });
  });
}

// ---- PayQR field-role settings --------------------------------------------
// Which field on Payees/Payments plays each role PayQR's QR-generation and
// narration logic needs. Two roles are deliberately NOT settings here
// because they're already fully knowable from existing schema concepts:
// the payee's lookup identity is just payees.pk, and "which field links
// Payments to Payees" is just "whichever fk field on Payments has
// ref === 'payees'". Adding manual settings for those would just be
// redundant config that could drift out of sync with the schema.
const PAYQR_FIELD_ROLES = {
  payeeUpiField: { entity: 'payees', types: ['text'], label: 'Payee UPI ID field' },
  payeeMethodField: { entity: 'payees', types: ['picklist'], label: 'Payee Payment Method field', optional: true },
  payeeNarrationField: { entity: 'payees', types: ['text'], label: 'Payee Narration Template field' },
  paymentAmountField: { entity: 'payments', types: ['currency', 'number'], label: 'Payment Amount field' },
  paymentNotesField: { entity: 'payments', types: ['text', 'textarea'], label: 'Payment Notes field' },
  paymentDateField: { entity: 'payments', types: ['date', 'timestamp'], label: 'Payment Date field' },
};

// ---- Tax field-role settings -----------------------------------------
// Same shape and reasoning as PayQR above: tax.js only ever operates on
// tables literally named landlords/tenants/invoices — that's still fixed,
// not configurable — but WHICH field on those tables plays each role the
// computation actually needs is. landlordGroupField and the two optional
// ones below it degrade gracefully rather than blocking the whole
// computation when left unset (see tax.js's own use of these); the rent/
// TDS/date fields don't, since without them there's no computation to run
// at all. The invoice->landlord and invoice->tenant links aren't listed
// here on purpose, same reasoning as PayQR's own payee link: derivable
// from the schema's own fk relationships, not something to ask for.
const TAX_FIELD_ROLES = {
  landlordGroupField: { entity: 'landlords', types: ['fk'], label: 'Landlord Group-Root field', optional: true },
  invoiceDateField: { entity: 'invoices', types: ['date', 'timestamp'], label: 'Invoice Date field' },
  invoiceRentField: { entity: 'invoices', types: ['currency', 'number', 'formula'], label: 'Invoice Taxable Rent field' },
  invoiceTdsField: { entity: 'invoices', types: ['currency', 'number', 'formula'], label: 'Invoice TDS Deducted field' },
  landlordPanField: { entity: 'landlords', types: ['text'], label: 'Landlord PAN field', optional: true },
  landlordGstinField: { entity: 'landlords', types: ['text'], label: 'Landlord GSTIN field', optional: true },
  landlordAddressField: { entity: 'landlords', types: ['text', 'textarea'], label: 'Landlord Address field', optional: true },
  landlordPhoneField: { entity: 'landlords', types: ['text'], label: 'Landlord Phone field', optional: true },
  landlordEmailField: { entity: 'landlords', types: ['text'], label: 'Landlord Email field', optional: true },
  invoiceRentReceivedField: { entity: 'invoices', types: ['currency', 'number'], label: 'Invoice Rent Received field', optional: true },
};

function updateTaxSettings(schema, input) {
  const next = {};
  Object.keys(TAX_FIELD_ROLES).forEach(key => {
    const role = TAX_FIELD_ROLES[key];
    const entity = schema.entities[role.entity];
    if (!entity) throw new Error(`The "${role.entity}" table does not exist.`);
    const fieldName = (input[key] || '').trim();
    if (!fieldName) {
      if (!role.optional) throw new Error(`${role.label} is required.`);
      next[key] = '';
      return;
    }
    const f = entity.fields.find(fl => fl.name === fieldName);
    if (!f) throw new Error(`"${fieldName}" is not a field on ${entity.label}.`);
    if (!role.types.includes(f.type)) {
      throw new Error(`${role.label} must be a ${role.types.join(' or ')} field — "${fieldName}" is type "${f.type}".`);
    }
    next[key] = fieldName;
  });
  schema.taxSettings = next;
}

function taxEligibleFields(entity, roleKey) {
  const role = TAX_FIELD_ROLES[roleKey];
  if (!entity || !role || entity.key !== role.entity) return [];
  return entity.fields.filter(f => role.types.includes(f.type));
}

// True once every REQUIRED role is mapped (optional ones may stay unset
// forever without blocking the computation itself).
function taxSettingsComplete(schema) {
  const settings = schema.taxSettings || {};
  return Object.keys(TAX_FIELD_ROLES).every(key => TAX_FIELD_ROLES[key].optional || settings[key]);
}

// ---- Idle session timeout --------------------------------------------------
const SESSION_TIMEOUT_MIN = 1;
const SESSION_TIMEOUT_MAX = 180;

function updateSessionTimeout(schema, minutesInput) {
  const minutes = Number(minutesInput);
  if (!Number.isFinite(minutes) || minutes < SESSION_TIMEOUT_MIN || minutes > SESSION_TIMEOUT_MAX) {
    throw new Error(`Session timeout must be a number between ${SESSION_TIMEOUT_MIN} and ${SESSION_TIMEOUT_MAX} minutes.`);
  }
  schema.sessionTimeoutMinutes = Math.round(minutes);
}

function updatePayqrSettings(schema, input) {
  const next = {};
  Object.keys(PAYQR_FIELD_ROLES).forEach(key => {
    const role = PAYQR_FIELD_ROLES[key];
    const entity = schema.entities[role.entity];
    if (!entity) throw new Error(`The "${role.entity}" table does not exist.`);
    const fieldName = (input[key] || '').trim();
    if (!fieldName) { next[key] = ''; return; }
    const f = entity.fields.find(fl => fl.name === fieldName);
    if (!f) throw new Error(`"${fieldName}" is not a field on ${entity.label}.`);
    if (!role.types.includes(f.type)) {
      throw new Error(`${role.label} must be a ${role.types.join(' or ')} field — "${fieldName}" is type "${f.type}".`);
    }
    next[key] = fieldName;
  });
  schema.payqrSettings = next;
}

function payqrEligibleFields(entity, roleKey) {
  const role = PAYQR_FIELD_ROLES[roleKey];
  if (!entity || !role || entity.key !== role.entity) return [];
  return entity.fields.filter(f => role.types.includes(f.type));
}

// The payee's lookup identity is just its primary key — already known,
// no setting needed. If the payees table doesn't exist, returns null.
function payqrPayeePkField(schema) {
  const e = schema.entities.payees;
  return e ? e.pk : null;
}

// Whichever fk field on Payments points at Payees — already discoverable
// from the schema's existing relationship data, no setting needed. If
// there's more than one (unusual), the first is used; if there's none,
// returns null so callers can fail loudly rather than guess.
function payqrPaymentToPayeeFkField(schema) {
  const e = schema.entities.payments;
  if (!e) return null;
  const fk = e.fields.find(f => f.type === 'fk' && f.ref === 'payees');
  return fk ? fk.name : null;
}

function moveField(schema, entityKey, fieldName, dir) {
  const e = schema.entities[entityKey];
  if (!e) return;
  const idx = e.fields.findIndex(f => f.name === fieldName);
  if (idx === -1) return;
  const swapWith = dir === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= e.fields.length) return;
  const tmp = e.fields[idx];
  e.fields[idx] = e.fields[swapWith];
  e.fields[swapWith] = tmp;
}

// ---- Bulk reorder (for drag-and-drop) ------------------------------------
// Given a target order (array of field/entity keys), reorders the list to
// exactly match, ignoring any items in the target that don't exist and
// preserving any missing items at the end. This is defensive: if the UI
// somehow submits a stale order (e.g. field deleted mid-drag), we don't
// lose data.
function reorderByKey(list, keyOf, targetOrder) {
  const known = new Map(list.map(item => [keyOf(item), item]));
  const seen = new Set();
  const out = [];
  targetOrder.forEach(k => {
    if (known.has(k) && !seen.has(k)) { out.push(known.get(k)); seen.add(k); }
  });
  list.forEach(item => {
    const k = keyOf(item);
    if (!seen.has(k)) out.push(item);
  });
  return out;
}

function reorderFields(schema, entityKey, orderedNames) {
  const e = schema.entities[entityKey];
  if (!e || !Array.isArray(orderedNames)) return;
  e.fields = reorderByKey(e.fields, f => f.name, orderedNames);
}

function reorderListColumns(schema, entityKey, orderedNames) {
  const e = schema.entities[entityKey];
  if (!e || !Array.isArray(orderedNames)) return;
  e.listColumns = reorderByKey(e.listColumns || [], n => n, orderedNames);
}

function reorderFilterFields(schema, entityKey, orderedNames) {
  const e = schema.entities[entityKey];
  if (!e || !Array.isArray(orderedNames)) return;
  e.filterFields = reorderByKey(e.filterFields || [], n => n, orderedNames);
}

function reorderNav(schema, orderedKeys) {
  if (!Array.isArray(orderedKeys)) return;
  schema.navOrder = reorderByKey(schema.navOrder || [], k => k, orderedKeys.filter(k => schema.entities[k]));
}

// Moves a table's screen from the main nav into Admin's own subnav —
// removed from navOrder, added to adminSubnavOrder, and gated to
// admin-only access by virtue of living there (see auth.requirePermission
// in server.js, which checks entity.inAdmin). Reversible via the
// counterpart function below.
function moveEntityToAdmin(schema, entityKey) {
  const entity = schema.entities[entityKey];
  if (!entity) throw new Error('Unknown table.');
  entity.inAdmin = true;
  schema.navOrder = (schema.navOrder || []).filter(k => k !== entityKey);
  if (!schema.adminSubnavOrder.includes(entityKey)) schema.adminSubnavOrder.push(entityKey);
}

function moveEntityOutOfAdmin(schema, entityKey) {
  const entity = schema.entities[entityKey];
  if (!entity) throw new Error('Unknown table.');
  entity.inAdmin = false;
  schema.adminSubnavOrder = schema.adminSubnavOrder.filter(k => k !== entityKey);
  if (!schema.navOrder.includes(entityKey)) schema.navOrder.push(entityKey);
}

// Same reorder-by-key mechanism as reorderNav, but for Admin's own
// subnav — a mix of fixed page keys (tables, views, ...) and any table
// keys that have been moved in via moveEntityToAdmin.
function reorderAdminSubnav(schema, orderedKeys) {
  if (!Array.isArray(orderedKeys)) return;
  const valid = orderedKeys.filter(k => ADMIN_SUBNAV_FIXED_KEYS.includes(k) || (schema.entities[k] && schema.entities[k].inAdmin));
  schema.adminSubnavOrder = reorderByKey(schema.adminSubnavOrder || [], k => k, valid);
}

// ---- Report-building tool (Admin -> Reports) -------------------------
// A report is defined as DATA (schema.json), not code — every field
// reference is a plain string the admin typed in, editable later, never
// baked into a .js file. This is deliberately the opposite of the
// hardcoded-fields approach used elsewhere for special-purpose features:
// reports are meant to be arbitrary and admin-built, so hardcoding
// anything here would defeat the entire point.
//
// Every expression (a column, the condition, a groupBy key, an aggregate
// input) is just a formula string, evaluated with the exact same
// evalFormula() the rest of the app already uses for calculated fields
// and rollup WHERE clauses — including cross-table dotted references
// (tenants.T_Client_Name) and full arithmetic (BILLS_Total - BILLS_RentRecd).
// No new expression language, no new parser.

function reportDefsFor(schema) {
  return Array.isArray(schema.reportDefs) ? schema.reportDefs : [];
}

function reportDefByKey(schema, key) {
  return reportDefsFor(schema).find(r => r.key === key);
}

function validateReportDef(schema, input) {
  const baseEntity = schema.entities[input.baseTable];
  if (!baseEntity) throw new Error('Choose a valid base table.');
  if (!input.label || !String(input.label).trim()) throw new Error('Report name is required.');
  const columns = (input.columns || []).filter(c => c && c.expr && c.expr.trim());
  columns.forEach(c => {
    if (!c.label || !c.label.trim()) c.label = c.expr;
    c.total = !!c.total;
    // A column can only be totaled if it's explicitly declared numeric
    // (Currency/Percent/Number format) — there's no way to statically know
    // an arbitrary expression's result type otherwise, so this format
    // choice doubles as that declaration, the same role Format already
    // plays for display. Fails loudly rather than silently skipping or
    // guessing at a non-numeric column.
    if (c.total && !['currency', 'percent', 'number'].includes(c.format)) {
      throw new Error(`Column "${c.label}" is marked for totaling but its format is "${c.format || 'none'}" — set it to Currency, Percent, or Number first.`);
    }
  });

  const groupBy = (input.groupBy || '').trim();
  const aggregates = (input.aggregates || []).filter(a => a && a.expr && a.expr.trim() && a.fn);
  aggregates.forEach(a => {
    if (!a.label || !a.label.trim()) a.label = `${a.fn}(${a.expr})`;
    a.total = !!a.total;
    // Unlike columns, an aggregate's output is always genuinely numeric
    // (SUM/COUNT/AVG/MIN/MAX all coerce to Number already) — but only
    // SUM and COUNT can be correctly turned into a grand total by
    // re-summing the per-group values. Averaging per-group averages (or
    // taking the min/max of per-group mins/maxes) isn't the same as the
    // true overall AVG/MIN/MAX, so those fail loudly instead of silently
    // producing a number that looks plausible but is actually wrong.
    if (a.total && !['SUM', 'COUNT'].includes(a.fn)) {
      throw new Error(`Aggregate "${a.label}" (${a.fn}) can't be totaled — only SUM and COUNT aggregates can have a grand total across groups; averaging/min/max across groups isn't mathematically valid.`);
    }
  });

  // Tag Key — an optional, explicitly-set merge-tag identifier for a
  // column/aggregate, stable across label renames. Without one, a
  // report-based PDF template's {{tag}} is derived by sanitizing the
  // column's own Label (see reportColumnKeyMap) — convenient, but it
  // means renaming "Inv #" to "Invoice No." silently changes the tag a
  // template needs to reference it by, with no error, just a blank cell
  // where data used to show. Setting an explicit Tag Key breaks that
  // link: the tag stays put no matter what the Label becomes.
  // Validated the same way any other admin-facing identifier in this
  // app is (safeFieldName-style rules) and checked for collisions
  // across the whole report (both columns and aggregates share the same
  // merge-tag namespace) — a silent duplicate would mean two different
  // pieces of data resolving to the same tag, which is worse than
  // requiring the admin to pick a different key up front.
  const tagKeyOwners = [...columns, ...aggregates];
  const seenTagKeys = new Map();
  tagKeyOwners.forEach(item => {
    if (!item.tagKey) { item.tagKey = ''; return; }
    const key = String(item.tagKey).trim();
    if (!key) { item.tagKey = ''; return; }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(`Tag Key "${key}" (on "${item.label}") must start with a letter or underscore and contain only letters, digits, and underscores — no spaces or punctuation.`);
    }
    if (seenTagKeys.has(key)) {
      throw new Error(`Tag Key "${key}" is used on both "${seenTagKeys.get(key)}" and "${item.label}" — each Tag Key must be unique within a report.`);
    }
    seenTagKeys.set(key, item.label);
    item.tagKey = key;
  });

  if (groupBy) {
    if (aggregates.length === 0) throw new Error('A grouped report needs at least one aggregate (e.g. SUM of an amount).');
  } else if (columns.length === 0) {
    throw new Error('Add at least one column.');
  }

  const DATA_KIND_MAP = {
    text: { kind: 'exact', fieldType: 'text', isPercent: false },
    bool: { kind: 'exact', fieldType: 'bool', isPercent: false },
    'date-range': { kind: 'date-range', fieldType: 'date', isPercent: false },
    'number-range': { kind: 'number-range', fieldType: 'number', isPercent: false },
    'percent-range': { kind: 'number-range', fieldType: 'percent', isPercent: true },
  };

  const parameters = (input.parameters || []).filter(p => p && p.key && p.field);
  parameters.forEach(p => {
    // Resolve the parameter's field type up front (not guessed later from a
    // runtime value) so its filter control is always statically known —
    // same reasoning FILTERABLE_TYPES/filterKindFor already use elsewhere.
    const resolved = resolveExprField(schema, baseEntity, p.field);
    if (resolved) {
      // Simple case: bare field or one clean cross-table hop — the type
      // is already sitting in the schema, no explicit declaration needed.
      if (!FILTERABLE_TYPES.includes(resolved.type)) {
        throw new Error(`Parameter "${p.label || p.key}": "${p.field}" is type "${resolved.type}", which can't be used as a parameter.`);
      }
      p.kind = filterKindFor(resolved);
      p.fieldType = resolved.type;
      p.isPercent = resolved.type === 'percent' || resolved.format === 'percent';
      p.anchorRef = resolved.type === 'fk' ? resolved.ref : null;
      p.dataKind = '';
    } else {
      // Calculated/arbitrary expression (e.g. BILLS_Total - BILLS_RentRecd)
      // — there's no schema field to read a type from, since the formula
      // engine doesn't do static type inference, only real evaluation
      // against real data. The admin must explicitly declare what kind of
      // value it produces — same "explicit, not guessed" principle Format
      // already uses for Columns/Aggregates. Fails loudly if they haven't,
      // rather than silently assuming a default.
      const dataKind = (p.dataKind || '').trim();
      if (!dataKind || !DATA_KIND_MAP[dataKind]) {
        throw new Error(`Parameter "${p.label || p.key}": "${p.field}" is a calculated expression, not a plain field \u2014 choose a Data Kind (Text / Yes-No / Date range / Number range / Percent range) to declare what it produces.`);
      }
      const mapped = DATA_KIND_MAP[dataKind];
      p.kind = mapped.kind;
      p.fieldType = mapped.fieldType;
      p.isPercent = mapped.isPercent;
      p.anchorRef = null;
      p.dataKind = dataKind;
    }
    // Anchor Table override: a real fk field already declares its target
    // table in the schema (anchorRef above), but a formula field or a
    // calculated expression has no such declaration — the formula engine
    // only produces a value, it doesn't know that value is "meant to be"
    // a Tenant code versus anything else. When auto-detection didn't
    // already supply an anchorRef, let the admin explicitly say which
    // table this parameter's value should be looked up in, so it can
    // still anchor a Header Panel. Same "explicit, not guessed" pattern
    // as Data Kind above; a real fk's auto-detected anchorRef always
    // takes precedence over this if both are somehow present, since the
    // schema-derived answer is never wrong.
    if (!p.anchorRef && p.anchorTable && p.anchorTable.trim()) {
      const anchorEntity = schema.entities[p.anchorTable.trim()];
      if (!anchorEntity) throw new Error(`Parameter "${p.label || p.key}": Anchor Table "${p.anchorTable}" is not a real table.`);
      p.anchorRef = anchorEntity.key;
    } else if (!p.anchorRef) {
      p.anchorTable = '';
    }
    // Anchor Resolver: optional. When the parameter's raw value doesn't
    // directly identify one row (e.g. a group tag shared by several
    // records), this condition picks exactly one out of the anchor
    // table — same formula language as everywhere else, with the
    // parameter's own value reachable inside it as "ANCHOR.VALUE". Left
    // blank, the Header Panel falls back to its original behavior:
    // treating the raw value as a direct primary-key lookup.
    p.anchorResolver = p.anchorRef ? (p.anchorResolver || '').trim() : '';
    if (!p.label || !p.label.trim()) p.label = p.field;
  });

  // Two parameters sharing the same key would render two form inputs with
  // the same `name` on the run page — submitting produces a duplicated
  // query key, which Express's query parser turns into an array rather
  // than a string, crashing the run page entirely (not a graceful
  // degradation). Reject at save time instead, naming which key collided.
  const seenKeys = new Set();
  parameters.forEach(p => {
    if (seenKeys.has(p.key)) throw new Error(`Two parameters both use the key "${p.key}" \u2014 parameter keys must be unique within a report.`);
    seenKeys.add(p.key);
  });

  // Header Panel: detail-style fields shown above the results table,
  // evaluated once against whichever record an fk-typed parameter
  // resolves to (e.g. "Tenant" picked as a parameter -> show that
  // tenant's + its landlord's info in a panel above the bill list).
  const headerAnchorParam = (input.headerAnchorParam || '').trim();
  const headerFields = (input.headerFields || []).filter(h => h && h.expr && h.expr.trim());
  headerFields.forEach(h => {
    if (!h.label || !h.label.trim()) h.label = h.expr;
    h.renderType = h.renderType === 'textarea' ? 'textarea' : 'text';
    h.rows = h.renderType === 'textarea' ? (Number(h.rows) || 3) : null;
    h.format = h.format || 'none';
    h.column = h.column === 'right' ? 'right' : 'left';
  });
  if (headerFields.length > 0) {
    if (!headerAnchorParam) throw new Error('Header panel fields need an anchor parameter \u2014 choose which parameter identifies the record to show.');
    const anchorParam = parameters.find(p => p.key === headerAnchorParam);
    if (!anchorParam) throw new Error(`Header anchor parameter "${headerAnchorParam}" is not one of this report's parameters.`);
    if (!anchorParam.anchorRef) throw new Error(`Header anchor parameter "${headerAnchorParam}" doesn't resolve to a linkable table \u2014 either use a lookup (fk) field, or set an explicit Anchor Table on that parameter.`);
  }

  return {
    key: input.key && input.key.trim() ? input.key.trim() : `${slugify(input.label)}-${Date.now().toString(36)}`,
    label: input.label.trim(),
    description: (input.description || '').trim(),
    baseTable: input.baseTable,
    columns,
    condition: (input.condition || '').trim(),
    groupBy,
    groupByLabel: (input.groupByLabel || '').trim() || 'Group',
    aggregates,
    parameters,
    headerAnchorParam,
    headerFields,
  };
}

// Resolves a dotted/bare expr to the actual field definition it refers to,
// so callers can know its real type (for parameter filter controls)
// without guessing from a runtime value. Only handles the simple cases —
// a bare field name, or one "x.y" cross-table hop — matching what
// parameters are restricted to; full arithmetic expressions (used freely
// in columns/aggregates/conditions) aren't resolved to a single field on
// purpose, since they don't have just one type.
// Returns the resolved field object for a bare field or one-hop
// cross-table expression, with one addition: `_resolvedOnEntityKey` is
// attached to the returned field, naming which entity that field
// actually lives on. This matters specifically for detecting a
// self-referential fk (e.g. tenants.T_GroupRoot, type 'fk' with
// ref:'tenants' — pointing back at its own table, used as a shared
// group tag across revisions, not a real per-row identifier) versus a
// genuine fk to a different table (e.g. invoices.I_LL -> landlords,
// where each row really is its own distinct, selectable thing). Callers
// that only read .type/.ref/etc (the existing behavior) are unaffected;
// only code that specifically checks `_resolvedOnEntityKey` sees the
// difference.
function resolveExprField(schema, baseEntity, expr) {
  const trimmed = String(expr || '').trim();
  const bareMatch = trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  if (bareMatch) {
    const f = baseEntity.fields.find(f => f.name === trimmed);
    return f ? { ...f, _resolvedOnEntityKey: baseEntity.key } : null;
  }
  const dotted = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (dotted) {
    let fkField = baseEntity.fields.find(f => f.type === 'fk' && f.name === dotted[1]);
    if (!fkField) fkField = baseEntity.fields.find(f => f.type === 'fk' && f.ref === dotted[1]);
    if (!fkField) return null;
    const refEntity = schema.entities[fkField.ref];
    if (!refEntity) return null;
    const f = refEntity.fields.find(f => f.name === dotted[2]);
    return f ? { ...f, _resolvedOnEntityKey: refEntity.key } : null;
  }
  return null;
}

function addReportDef(schema, input) {
  const def = validateReportDef(schema, input);
  schema.reportDefs.push(def);
  return def;
}

// Copies an existing report definition in full (columns, condition,
// group-by, aggregates, parameters) under a fresh key and a distinct
// label, so "make something similar" is copy-then-tweak instead of
// starting from scratch. Deliberately omits the source's key so
// addReportDef's normal key-generation kicks in — same mechanism as
// creating any new report, just pre-filled.
function duplicateReportDef(schema, key) {
  const source = reportDefByKey(schema, key);
  if (!source) throw new Error('Unknown report.');
  const { key: _omitKey, ...rest } = source;
  return addReportDef(schema, { ...rest, label: `Copy of ${source.label}` });
}

function updateReportDef(schema, key, input) {
  const idx = schema.reportDefs.findIndex(r => r.key === key);
  if (idx === -1) throw new Error('Unknown report.');
  const def = validateReportDef(schema, { ...input, key });
  schema.reportDefs[idx] = def;
  return def;
}

function deleteReportDef(schema, key) {
  schema.reportDefs = schema.reportDefs.filter(r => r.key !== key);
}

// Runs a report definition against current data, given user-supplied
// parameter values (paramValues[param.key] = string, or {from,to} for
// range-kind parameters). Returns { mode: 'detail'|'grouped', columns, rows }.
function runReport(schema, reportDef, paramValues) {
  paramValues = paramValues || {};
  const baseEntity = schema.entities[reportDef.baseTable];
  if (!baseEntity) return { mode: 'detail', columns: [], rows: [], error: 'Base table no longer exists.' };

  let rows = db.getAll(reportDef.baseTable).map(r => withComputedFields(schema, baseEntity, r));

  if (reportDef.condition) {
    rows = rows.filter(r => evalFormula(reportDef.condition, schema, baseEntity, r, {}, 0) === true);
  }

  (reportDef.parameters || []).forEach(param => {
    const raw = paramValues[param.key];
    const filterSpec = (param.kind === 'date-range' || param.kind === 'number-range')
      ? { from: (raw && raw.from) || '', to: (raw && raw.to) || '' }
      : { value: raw || '' };
    rows = applyFilterCondition(
      rows, param.kind, param.fieldType, param.isPercent, filterSpec,
      r => evalFormula(param.field, schema, baseEntity, r, {}, 0)
    );
  });

  const headerPanel = computeHeaderPanel(schema, reportDef, paramValues);

  if (!reportDef.groupBy) {
    const cols = reportDef.columns.map(c => c.label);
    const totalSums = {}; // label -> running raw numeric sum, only for total-eligible columns
    reportDef.columns.forEach(col => { if (col.total) totalSums[col.label] = 0; });
    const outRows = rows.map(r => {
      const out = {};
      reportDef.columns.forEach(col => {
        const raw = evalFormula(col.expr, schema, baseEntity, r, {}, 0);
        if (col.total) {
          const n = Number(raw);
          if (!isNaN(n)) totalSums[col.label] += n;
        }
        out[col.label] = formatFormulaValue({ format: col.format }, raw);
      });
      return out;
    });
    const totals = Object.keys(totalSums).length
      ? cols.reduce((acc, label) => {
          const col = reportDef.columns.find(c => c.label === label);
          acc[label] = col.total ? formatFormulaValue({ format: col.format }, totalSums[label]) : null;
          return acc;
        }, {})
      : null;
    return { mode: 'detail', columns: cols, rows: outRows, headerPanel, totals };
  }

  const groups = {};
  const groupOrder = [];
  rows.forEach(r => {
    const key = evalFormula(reportDef.groupBy, schema, baseEntity, r, {}, 0);
    const keyStr = String(key);
    if (!groups[keyStr]) { groups[keyStr] = []; groupOrder.push(keyStr); }
    groups[keyStr].push(r);
  });
  const grandTotals = {}; // agg.label -> running raw numeric sum, only for total-eligible (SUM/COUNT) aggregates
  (reportDef.aggregates || []).forEach(agg => { if (agg.total) grandTotals[agg.label] = 0; });
  const outRows = groupOrder.map(keyStr => {
    const out = { [reportDef.groupByLabel]: keyStr };
    (reportDef.aggregates || []).forEach(agg => {
      const nums = groupRowsFor(groups[keyStr], agg, schema, baseEntity);
      const rawAggValue = aggregateValues(agg.fn, nums);
      if (agg.total) grandTotals[agg.label] += (Number(rawAggValue) || 0);
      out[agg.label] = formatFormulaValue({ format: agg.format }, rawAggValue);
    });
    return out;
  });
  const cols = [reportDef.groupByLabel, ...(reportDef.aggregates || []).map(a => a.label)];
  const totals = Object.keys(grandTotals).length
    ? cols.reduce((acc, label) => {
        const agg = (reportDef.aggregates || []).find(a => a.label === label);
        acc[label] = (agg && agg.total) ? formatFormulaValue({ format: agg.format }, grandTotals[label]) : null;
        return acc;
      }, {})
    : null;
  return { mode: 'grouped', columns: cols, rows: outRows, headerPanel, totals };
}

// Evaluates a report's Header Panel fields (if configured) against
// whichever record the anchor fk-parameter currently resolves to.
// Deliberately evaluated against the ANCHOR entity (e.g. "tenants"),
// not the report's own base table ("bills") — header field expressions
// are written as if looking directly at that anchor record, so
// cross-table references from there (e.g. its own linked landlord) work
// the same way they would on that table's real detail page. Returns
// null whenever there's nothing to show yet (no header fields
// configured, or the anchor parameter hasn't been picked/doesn't
// resolve to a real record) — the run-time page just skips the panel.
// Resolves whatever single record a report's Header-Panel-anchor
// parameter currently points at, given real runtime parameter values —
// shared by computeHeaderPanel (the display panel shown on the Run
// Report page) and renderReportTemplate (PDF generation), so both use
// the exact same resolution logic rather than two copies that could
// quietly drift apart. Returns null whenever there's nothing resolvable
// yet (no anchor parameter, no anchor value picked, resolver condition
// didn't land on exactly one row) — callers treat that as "nothing to
// show/generate yet," not an error.
function resolveReportAnchorRecord(schema, reportDef, paramValues) {
  if (!reportDef.headerAnchorParam) return null;
  const anchorParam = (reportDef.parameters || []).find(p => p.key === reportDef.headerAnchorParam);
  if (!anchorParam || !anchorParam.anchorRef) return null;
  const anchorEntity = schema.entities[anchorParam.anchorRef];
  if (!anchorEntity) return null;
  const anchorValue = paramValues[anchorParam.key];
  if (!anchorValue) return null;

  let anchorRecord;
  if (anchorParam.anchorResolver && anchorParam.anchorResolver.trim()) {
    // Generic case: the parameter's raw value doesn't directly identify a
    // row (e.g. it's a group tag shared by several records, not a primary
    // key) — the admin supplies a condition, in the same formula language
    // as everywhere else, that picks exactly one row out of the anchor
    // table. The parameter's raw value is exposed inside that condition
    // as "ANCHOR.VALUE" — a fake single-field scope injected here, using
    // the exact same extraScopes mechanism "parent.field" (rollups) and
    // "tableKey.field" (LOOKUP's own scanned row) already use. Nothing
    // about T_GroupRoot, T_Is_Current, or any other specific field name
    // is known to this code — it's just evaluating whatever condition
    // the admin wrote, the same way LOOKUP always has.
    const anchorValueScope = { ANCHOR: { entity: { key: 'ANCHOR', fields: [{ name: 'VALUE', type: 'text' }] }, row: { VALUE: anchorValue } } };
    const { matches, conditionError } = findMatchingRows(schema, anchorEntity, anchorParam.anchorResolver, anchorEntity, {}, anchorValueScope, 0);
    if (conditionError || matches.length !== 1) return null; // no clean single match — panel just doesn't show, same as any other unresolved anchor
    anchorRecord = matches[0];
  } else {
    // Simple case (unchanged): the parameter's raw value directly IS the
    // anchor entity's primary key (a real fk, or a formula mirroring one).
    anchorRecord = db.getById(anchorEntity.key, anchorEntity.pk, anchorValue);
    if (!anchorRecord) return null;
  }
  return { anchorEntity, computedRecord: withComputedFields(schema, anchorEntity, anchorRecord) };
}

function computeHeaderPanel(schema, reportDef, paramValues) {
  if (!reportDef.headerFields || reportDef.headerFields.length === 0) return null;
  const resolved = resolveReportAnchorRecord(schema, reportDef, paramValues);
  if (!resolved) return null;
  const { anchorEntity, computedRecord } = resolved;

  const fields = reportDef.headerFields.map(h => ({
    label: h.label,
    value: formatFormulaValue({ format: h.format }, evalFormula(h.expr, schema, anchorEntity, computedRecord, {}, 0)),
    renderType: h.renderType,
    rows: h.rows,
    column: h.column,
  }));
  return {
    left: fields.filter(f => f.column === 'left'),
    right: fields.filter(f => f.column === 'right'),
  };
}

// ---- Applet / View / Screen (Siebel-mapped) --------------------------
// Stage 1: the schema layer only — data shapes and CRUD, no admin UI or
// runtime rendering yet (those are later stages). See the backlog's
// "Architecture: Applet / View / Screen" writeup for the full design and
// worked example this was built against.

function appletsFor(schema) {
  return schema.applets || [];
}

function appletByKey(schema, key) {
  return (schema.applets || []).find(a => a.key === key) || null;
}

// An Applet is a reusable, independent list/detail definition bound to
// one table — NOT tied to any one View, so the same Applet (e.g. "GST
// Registrations List") can appear as a master-detail child in one View
// and stand alone in a completely different one.
function validateApplet(schema, input, existingKey) {
  const baseEntity = schema.entities[input.baseTable];
  if (!baseEntity) throw new Error('Choose a valid base table for this applet.');
  if (!input.label || !String(input.label).trim()) throw new Error('Applet name is required.');
  const type = input.type === 'detail' ? 'detail' : 'list';

  const key = (existingKey || (input.key && input.key.trim())) || `${slugify(input.label)}-${Date.now().toString(36)}`;
  const dup = (schema.applets || []).find(a => a.key === key && a.key !== existingKey);
  if (dup) throw new Error(`An applet with key "${key}" already exists.`);

  let columns = [];
  let detailFields = [];
  if (type === 'list') {
    columns = (input.columns || []).filter(c => c && c.trim());
    columns.forEach(colName => {
      if (!baseEntity.fields.some(f => f.name === colName)) {
        throw new Error(`Applet "${input.label}": column "${colName}" is not a real field on ${input.baseTable}.`);
      }
    });
  }
  if (type === 'detail') {
    detailFields = (input.detailFields || []).filter(c => c && c.trim());
    detailFields.forEach(colName => {
      if (colName === '__spacer__' || colName === '__section__') return; // layout pseudo-fields
      if (!baseEntity.fields.some(f => f.name === colName)) {
        throw new Error(`Applet "${input.label}": detail field "${colName}" is not a real field on ${input.baseTable}.`);
      }
    });
  }

  // filterCondition is optional and, like Report conditions, just a
  // formula string evaluated at run time — not checked for correctness
  // here beyond being non-empty, matching how Report conditions are
  // handled (errors surface when actually run, same as any other formula).
  const filterCondition = (input.filterCondition || '').trim();

  if (input.sortField && !baseEntity.fields.some(f => f.name === input.sortField)) {
    throw new Error(`Applet "${input.label}": sort field "${input.sortField}" is not a real field on ${input.baseTable}.`);
  }

  return {
    key, label: input.label.trim(), type, baseTable: input.baseTable,
    columns, detailFields, filterCondition,
    sortField: input.sortField || '', sortDir: input.sortDir === 'desc' ? 'desc' : 'asc',
  };
}

function addApplet(schema, input) {
  const applet = validateApplet(schema, input);
  schema.applets.push(applet);
  return applet;
}

function updateApplet(schema, key, input) {
  const idx = (schema.applets || []).findIndex(a => a.key === key);
  if (idx === -1) throw new Error('Unknown applet.');
  const applet = validateApplet(schema, { ...input, key }, key);
  schema.applets[idx] = applet;
  return applet;
}

// Blocks deleting an Applet that's still placed in any View — same
// "block, don't silently orphan" principle already used for deleting a
// table that other tables still reference.
function deleteApplet(schema, key) {
  const usedIn = (schema.views || []).filter(v => (v.applets || []).some(a => a.appletKey === key));
  if (usedIn.length > 0) {
    const names = usedIn.map(v => v.label).join(', ');
    throw new Error(`Cannot delete: this applet is still used in ${usedIn.length} view(s) (${names}) — remove it from those views first.`);
  }
  schema.applets = (schema.applets || []).filter(a => a.key !== key);
}

function viewsFor(schema) {
  return schema.views || [];
}

function viewByKey(schema, key) {
  return (schema.views || []).find(v => v.key === key) || null;
}

// A View is an ordered collection of Applet *instances* — not the
// Applets themselves, since the same Applet can appear in more than one
// View, potentially with a different (or no) parent-link relationship
// each time. This is where the master-detail relationship actually
// lives: a child instance names another instance in the SAME view as
// its parent, plus a linkField — the field, on the child applet's own
// table, compared against whatever record is selected in the parent
// instance at run time.
function validateView(schema, input, existingKey) {
  if (!input.label || !String(input.label).trim()) throw new Error('View name is required.');
  const key = (existingKey || (input.key && input.key.trim())) || `${slugify(input.label)}-${Date.now().toString(36)}`;
  const dup = (schema.views || []).find(v => v.key === key && v.key !== existingKey);
  if (dup) throw new Error(`A view with key "${key}" already exists.`);

  const rawApplets = (input.applets || []).filter(a => a && a.appletKey);
  const instanceKeys = new Set();
  rawApplets.forEach((a, i) => {
    const instanceKey = (a.instanceKey && a.instanceKey.trim()) || `inst-${i}-${Date.now().toString(36)}`;
    if (instanceKeys.has(instanceKey)) throw new Error(`View "${input.label}": duplicate applet instance key "${instanceKey}".`);
    instanceKeys.add(instanceKey);
    a.instanceKey = instanceKey;
    if (!appletByKey(schema, a.appletKey)) throw new Error(`View "${input.label}": applet "${a.appletKey}" doesn't exist.`);
  });

  // Now that every instance's own key is known, validate parent links —
  // done as a second pass since a child can reference a sibling defined
  // either before or after it in the input array.
  rawApplets.forEach(a => {
    if (!a.parentInstanceKey) { a.linkField = ''; return; }
    if (a.parentInstanceKey === a.instanceKey) {
      throw new Error(`View "${input.label}": applet instance "${a.instanceKey}" can't be its own parent.`);
    }
    if (!instanceKeys.has(a.parentInstanceKey)) {
      throw new Error(`View "${input.label}": applet instance "${a.instanceKey}" names a parent ("${a.parentInstanceKey}") that isn't in this view.`);
    }
    if (!a.linkField || !a.linkField.trim()) {
      throw new Error(`View "${input.label}": applet instance "${a.instanceKey}" has a parent but no link field — which field on its own table should be compared against the parent's selected record?`);
    }
    const childApplet = appletByKey(schema, a.appletKey);
    const childEntity = schema.entities[childApplet.baseTable];
    if (!childEntity.fields.some(f => f.name === a.linkField)) {
      throw new Error(`View "${input.label}": link field "${a.linkField}" is not a real field on ${childApplet.baseTable}.`);
    }
  });

  // Simple, direct-cycle guard (A's parent is B, B's parent is A) — full
  // arbitrary-depth cycle detection isn't built yet since the confirmed
  // use case is two levels deep (one parent, one child), not longer
  // chains; worth revisiting if deeper nesting turns out to be needed.
  rawApplets.forEach(a => {
    if (!a.parentInstanceKey) return;
    const parent = rawApplets.find(p => p.instanceKey === a.parentInstanceKey);
    if (parent && parent.parentInstanceKey === a.instanceKey) {
      throw new Error(`View "${input.label}": applet instances "${a.instanceKey}" and "${parent.instanceKey}" name each other as parent — that's a cycle, not a hierarchy.`);
    }
  });

  const applets = rawApplets.map((a, i) => ({
    instanceKey: a.instanceKey, appletKey: a.appletKey, position: i,
    parentInstanceKey: a.parentInstanceKey || null, linkField: a.linkField || '',
  }));

  return { key, label: input.label.trim(), applets };
}

function addView(schema, input) {
  const view = validateView(schema, input);
  schema.views.push(view);
  return view;
}

function updateView(schema, key, input) {
  const idx = (schema.views || []).findIndex(v => v.key === key);
  if (idx === -1) throw new Error('Unknown view.');
  const view = validateView(schema, { ...input, key }, key);
  schema.views[idx] = view;
  return view;
}

function deleteView(schema, key) {
  const usedIn = (schema.screens || []).filter(s => (s.views || []).some(v => v.viewKey === key));
  if (usedIn.length > 0) {
    const names = usedIn.map(s => s.label).join(', ');
    throw new Error(`Cannot delete: this view is still used in ${usedIn.length} screen(s) (${names}) — remove it from those screens first.`);
  }
  schema.views = (schema.views || []).filter(v => v.key !== key);
}

function reorderViewApplets(schema, viewKey, orderedInstanceKeys) {
  const view = viewByKey(schema, viewKey);
  if (!view) throw new Error('Unknown view.');
  if (!Array.isArray(orderedInstanceKeys)) return;
  view.applets = reorderByKey(view.applets || [], a => a.instanceKey, orderedInstanceKeys)
    .map((a, i) => ({ ...a, position: i }));
}

function screensFor(schema) {
  return schema.screens || [];
}

function screenByKey(schema, key) {
  return (schema.screens || []).find(s => s.key === key) || null;
}

// A Screen is an ordered collection of Views — same idea as today's nav
// tab, just no longer assumed to be exactly one table.
function validateScreen(schema, input, existingKey) {
  if (!input.label || !String(input.label).trim()) throw new Error('Screen name is required.');
  const key = (existingKey || (input.key && input.key.trim())) || `${slugify(input.label)}-${Date.now().toString(36)}`;
  const dup = (schema.screens || []).find(s => s.key === key && s.key !== existingKey);
  if (dup) throw new Error(`A screen with key "${key}" already exists.`);

  const rawViews = (input.views || []).filter(v => v && v.viewKey);
  rawViews.forEach(v => {
    if (!viewByKey(schema, v.viewKey)) throw new Error(`Screen "${input.label}": view "${v.viewKey}" doesn't exist.`);
  });
  const views = rawViews.map((v, i) => ({ viewKey: v.viewKey, position: i }));

  return { key, label: input.label.trim(), views };
}

function addScreen(schema, input) {
  const screen = validateScreen(schema, input);
  schema.screens.push(screen);
  return screen;
}

function updateScreen(schema, key, input) {
  const idx = (schema.screens || []).findIndex(s => s.key === key);
  if (idx === -1) throw new Error('Unknown screen.');
  const screen = validateScreen(schema, { ...input, key }, key);
  schema.screens[idx] = screen;
  return screen;
}

function deleteScreen(schema, key) {
  schema.screens = (schema.screens || []).filter(s => s.key !== key);
}

function reorderScreenViews(schema, screenKey, orderedViewKeys) {
  const screen = screenByKey(schema, screenKey);
  if (!screen) throw new Error('Unknown screen.');
  if (!Array.isArray(orderedViewKeys)) return;
  screen.views = reorderByKey(screen.views || [], v => v.viewKey, orderedViewKeys)
    .map((v, i) => ({ ...v, position: i }));
}

// ---- Global Picklists (Admin -> Picklists) ------------------------------

function picklistsFor(schema) {
  return schema.picklists || [];
}

function picklistByKey(schema, key) {
  return (schema.picklists || []).find(p => p.key === key) || null;
}

// Generates a stable key for a picklist value, distinct from its (editable)
// label — the whole point of this being separate is that renaming a label
// later must NOT change the key, so records already storing it keep
// resolving correctly. Slug-based + a short random suffix for unlikely
// collisions, unique against whatever keys already exist in this picklist.
function genPicklistKey(existingKeys, label) {
  const base = slugify(label) || 'v';
  let key = base;
  let i = 0;
  while (existingKeys.has(key)) {
    i++;
    key = base + '-' + i;
  }
  return key;
}

function validatePicklist(schema, input, existingKey) {
  if (!input.label || !String(input.label).trim()) throw new Error('Picklist name is required.');
  const key = (existingKey || (input.key && input.key.trim())) || `${slugify(input.label)}-${Date.now().toString(36)}`;
  const dup = (schema.picklists || []).find(p => p.key === key && p.key !== existingKey);
  if (dup) throw new Error(`A picklist with key "${key}" already exists.`);
  const sourceType = input.sourceType === 'table' ? 'table' : 'static';

  if (sourceType === 'table') {
    const sourceEntity = schema.entities[input.sourceTable];
    if (!sourceEntity) throw new Error('Choose a valid source table.');
    // sourceValueField is intentionally allowed blank at creation — the
    // two-step flow (create with just a table, then configure which
    // field on the EDIT page, once real fields from that table can be
    // shown) matches how the Applet builder already handles this same
    // "need the table fixed before its fields can be offered" shape.
    // Still validated as a real field if actually provided, though.
    if (input.sourceValueField && !sourceEntity.fields.some(f => f.name === input.sourceValueField)) {
      throw new Error(`"${input.sourceValueField}" is not a real field on ${input.sourceTable}.`);
    }
    if (input.sourceConstraintField && !sourceEntity.fields.some(f => f.name === input.sourceConstraintField)) {
      throw new Error(`"${input.sourceConstraintField}" is not a real field on ${input.sourceTable}.`);
    }
    return {
      key, label: input.label.trim(), sourceType,
      sourceTable: input.sourceTable, sourceValueField: input.sourceValueField || '',
      sourceConstraintField: input.sourceConstraintField || '',
      values: [],
    };
  }

  // input.values is now [{key, label, active}], with key possibly blank
  // for a brand-new row (the edit form always submits a row per value,
  // in order; a new row has no key yet). Existing keys are preserved
  // verbatim — this is the entire point: renaming a label must not
  // change the stable key already stored on existing records.
  const rawValues = (input.values || []).filter(v => v && String(v.label || '').trim());
  const existingKeys = new Set(rawValues.map(v => v.key).filter(Boolean));
  const seenLabels = new Set();
  const values = [];
  rawValues.forEach(v => {
    const label = String(v.label).trim();
    if (seenLabels.has(label)) return; // dedupe same as before
    seenLabels.add(label);
    let key = v.key && String(v.key).trim();
    if (!key) {
      key = genPicklistKey(existingKeys, label);
      existingKeys.add(key);
    }
    values.push({ key, label, active: v.active !== false });
  });
  return { key, label: input.label.trim(), sourceType: 'static', values, sourceTable: '', sourceValueField: '', sourceConstraintField: '' };
}

function addPicklist(schema, input) {
  const picklist = validatePicklist(schema, input);
  schema.picklists.push(picklist);
  return picklist;
}

function updatePicklist(schema, key, input) {
  const idx = (schema.picklists || []).findIndex(p => p.key === key);
  if (idx === -1) throw new Error('Unknown picklist.');
  // Keys are the stable identity now (not label text), so the form's
  // submitted values are simply the new truth — validatePicklist already
  // preserves whatever key each row carries and only mints a fresh one
  // for genuinely new (keyless) rows. No cross-referencing against the
  // prior version needed.
  const updated = validatePicklist(schema, { ...input, key }, key);
  schema.picklists[idx] = updated;
  return updated;
}

// Blocks deleting a Picklist that's still referenced by any field —
// same "block, don't silently orphan" principle used elsewhere.
function deletePicklist(schema, key) {
  const usedBy = [];
  Object.values(schema.entities).forEach(e => {
    e.fields.forEach(f => {
      if (f.type === 'picklist' && f.picklistSource === 'global' && f.picklistKey === key) {
        usedBy.push(`${e.label}.${f.label}`);
      }
    });
  });
  if (usedBy.length > 0) {
    throw new Error(`Cannot delete: still used by ${usedBy.length} field(s) (${usedBy.join(', ')}) — change those fields to a custom or different picklist first.`);
  }
  schema.picklists = (schema.picklists || []).filter(p => p.key !== key);
}

function setPicklistValueActive(schema, key, valueKey, active) {
  const picklist = picklistByKey(schema, key);
  if (!picklist || picklist.sourceType !== 'static') throw new Error('Unknown static picklist.');
  const v = (picklist.values || []).find(x => x.key === valueKey);
  if (!v) throw new Error('Unknown value.');
  v.active = !!active;
}

// Richer variant specifically for rendering a create/edit form. A plain
// (non-constrained) picklist just needs its current {key,label} options,
// same as resolvePicklistOptions above — but a CONSTRAINED table-sourced
// picklist needs more: the constraint field's value can change live as
// the user fills out the form (e.g. picking Account Type before Card),
// so the initial server-rendered options aren't enough on their own.
// Returns the full unfiltered option set too, each tagged with its own
// constraint value, so client-side JS can re-filter without a server
// round-trip when the constraining sibling field changes.
function resolvePicklistOptionsForForm(schema, entity, field, record) {
  const options = resolvePicklistOptions(schema, entity, field, record);
  if (field.picklistSource !== 'global' || !field.picklistKey || !field.picklistConstraintField) {
    return { options, constrainedBy: null, allOptionsWithConstraint: [] };
  }
  const picklist = picklistByKey(schema, field.picklistKey);
  if (!picklist || picklist.sourceType !== 'table' || !picklist.sourceConstraintField) {
    return { options, constrainedBy: null, allOptionsWithConstraint: [] };
  }
  const sourceEntity = schema.entities[picklist.sourceTable];
  if (!sourceEntity) return { options, constrainedBy: null, allOptionsWithConstraint: [] };
  const rows = db.getAll(picklist.sourceTable);
  const allOptionsWithConstraint = rows
    .map(r => withComputedFields(schema, sourceEntity, r))
    .filter(full => full[picklist.sourceValueField] !== undefined && full[picklist.sourceValueField] !== null && full[picklist.sourceValueField] !== '')
    .map(full => ({ key: String(full[sourceEntity.pk]), label: String(full[picklist.sourceValueField]), constraintValue: String(full[picklist.sourceConstraintField] ?? '') }));
  return { options, constrainedBy: field.picklistConstraintField, allOptionsWithConstraint };
}

// ---- FK option constraints (fkWhere) ------------------------------------
//
// An fk field may carry an optional `fkWhere` condition — a formula
// evaluated against each candidate referenced row, with the record being
// edited exposed as `parent` (identical evaluation shape to a rollup's
// WHERE). Only rows where it returns true are offered in the picker, and
// the same condition is enforced on save. This is the generic mechanism
// behind things like "only sub-landlords, not the group root" or "only
// active tenants mapped to this record's landlord" — the specific fields
// live entirely in the admin-authored condition; nothing here is hardcoded.

// Filter candidate referenced rows by a fk field's fkWhere. `parentRecord`
// is the record being edited (whatever `parent.X` resolves against); when
// it's absent — e.g. a list-filter dropdown, which has no record in hand —
// the condition is skipped and every row is returned, so filter UIs keep
// offering the full set rather than mysteriously emptying out.
function fkWhereFilterRows(schema, field, refEntity, rows, parentEntity, parentRecord) {
  if (!field || !field.fkWhere || !field.fkWhere.trim() || !parentRecord) return rows;
  return rows.filter(r => evalFormula(field.fkWhere, schema, refEntity, r, { parent: { entity: parentEntity, row: parentRecord } }, 0) === true);
}

// Single-row form of the same check, used at save time. Pure (no db): given
// the already-fetched referenced row, does it satisfy the condition?
function fkRowSatisfies(schema, parentEntity, field, refEntity, refRow, record) {
  if (!field.fkWhere || !field.fkWhere.trim()) return true;
  return evalFormula(field.fkWhere, schema, refEntity, refRow, { parent: { entity: parentEntity, row: record } }, 0) === true;
}

// The sibling fields a fk field's condition depends on — its `parent.<name>`
// references — so a form can refresh exactly the right pickers when one of
// those fields changes. Purely lexical; returns [] when there's no condition.
function fkWhereParentRefs(fkWhere) {
  if (!fkWhere || !fkWhere.trim()) return [];
  const refs = new Set();
  const re = /parent\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(fkWhere)) !== null) refs.add(m[1]);
  return [...refs];
}

// Save-time enforcement: every fk field with an fkWhere must, if it holds a
// (non-blank) value, point at a referenced record that actually satisfies
// the condition given the rest of this record as `parent`. Returns an array
// of { field, message } (same shape as the required/type validator, so the
// two merge cleanly). A blank value is left to the required-check; a value
// that resolves to no row is left alone (dangling-fk is a separate concern)
// — this specifically stops choosing a real record the condition forbids
// (a stale form, or a direct POST bypassing the filtered picker).
//
// `beforeRecord` (optional — the record as it was before this save, i.e.
// absent on create) matters because an fkWhere condition is a picker
// convenience for choosing something NOW, not a permanent guarantee about
// data that was chosen in the past. Concretely: a "T_Active = true" filter
// on an invoice's Tenant field is there so today's data entry only offers
// currently-active tenants — it was never meant to retroactively break a
// 2022 invoice the moment that tenant's lease ends in 2024. If a field's
// value is UNCHANGED from beforeRecord, it's grandfathered in regardless
// of whether it still satisfies the condition; the condition only applies
// to a value that's actually being newly chosen in this save.
function fkConstraintErrors(schema, entity, record, beforeRecord) {
  const errors = [];
  entity.fields.forEach(field => {
    if (field.type !== 'fk' || !field.fkWhere || !field.fkWhere.trim()) return;
    const val = record[field.name];
    if (val === '' || val === undefined || val === null) return;
    if (beforeRecord && String(beforeRecord[field.name]) === String(val)) return; // unchanged — grandfathered in
    const refEntity = schema.entities[field.ref];
    if (!refEntity) return;
    const row = db.getAll(refEntity.key).find(r => String(r[refEntity.pk]) === String(val));
    if (!row) return;
    if (!fkRowSatisfies(schema, entity, field, refEntity, row, record)) {
      errors.push({ field: field.name, message: `"${field.label}" — the chosen ${refEntity.singular || field.ref} isn't allowed here (it doesn't meet this field's condition).` });
    }
  });
  return errors;
}

// ---- Generic "Link Matching Records" bulk-link action --------------------
//
// For a "many rows share one parent" relationship expressed purely as a
// constrained fk (e.g. many Invoices -> one GST Filing for their month),
// picking the parent one invoice at a time is needless once the parent
// record exists — the "right" child rows are already fully determined by
// the SAME fkWhere condition already governing the picker. This lets the
// owner opt a specific relationship in (fkBulkLink on the child's fk
// field — see addField/updateField) so a "Link Matching Records" button
// appears on the PARENT record's page; clicking it finds every child row
// that (a) doesn't already have this field set, and (b) would satisfy the
// fkWhere condition if linked to this parent, and links them in bulk.
// Entirely schema-driven — no table or field name is ever hardcoded here;
// it walks whatever fk-with-fkWhere-and-fkBulkLink relationships exist.

// Which fk-with-fkWhere relationships (on ANY other table) point at
// entityKey and have opted into the bulk-link button. Called when
// rendering a record's detail page to decide which buttons to show.
function bulkLinkableRelationships(schema, entityKey) {
  const out = [];
  Object.values(schema.entities).forEach(childEntity => {
    (childEntity.fields || []).forEach(f => {
      if (f.type === 'fk' && f.ref === entityKey && f.fkWhere && f.fkWhere.trim() && f.fkBulkLink) {
        out.push({ childEntityKey: childEntity.key, childFieldName: f.name });
      }
    });
  });
  return out;
}

// The actual bulk-link: for the given parent record, find every row on
// childEntityKey where childFieldName is blank and the fkWhere condition
// would be satisfied if that field were set to this parent — then set it.
// Returns the count linked. Never touches a row that already has a value
// (a manual override, or a prior link) — this only fills in blanks.
function linkMatchingRecords(schema, parentEntityKey, parentRecord, childEntityKey, childFieldName) {
  const parentEntity = schema.entities[parentEntityKey];
  const childEntity = schema.entities[childEntityKey];
  if (!parentEntity || !childEntity) return 0;
  const field = childEntity.fields.find(fl => fl.name === childFieldName && fl.type === 'fk' && fl.ref === parentEntityKey && fl.fkWhere && fl.fkBulkLink);
  if (!field) return 0;
  const candidates = db.getAll(childEntity.key).filter(r => r[field.name] === undefined || r[field.name] === null || r[field.name] === '');
  let linked = 0;
  candidates.forEach(r => {
    // Resolve computed fields on the candidate — the fkWhere condition may
    // reference a formula field via parent.X (e.g. parent.I_MonthYear),
    // same reasoning as the save-time recordForValidation pattern.
    const full = withComputedFields(schema, childEntity, r);
    if (fkRowSatisfies(schema, childEntity, field, parentEntity, parentRecord, full)) {
      db.update(childEntity.key, childEntity.pk, r[childEntity.pk], { [field.name]: parentRecord[parentEntity.pk] });
      linked++;
    }
  });
  return linked;
}

// ---- Template Library (bill/document templates) -------------------------

function templatesFor(schema) {
  return schema.templates || [];
}

function templateByKey(schema, key) {
  return (schema.templates || []).find(t => t.key === key) || null;
}

// One template per table for now (per the agreed scope) — this is what
// the record detail page checks to decide whether to show a
// Generate/View PDF button at all.
function templateForEntity(schema, entityKey) {
  return (schema.templates || []).find(t => (t.baseKind || 'table') === 'table' && t.baseTable === entityKey) || null;
}

function templateForReport(schema, reportKey) {
  return (schema.templates || []).find(t => t.baseKind === 'report' && t.baseTable === reportKey) || null;
}

// Email templates bound to an entity — many allowed (each becomes a "send
// email" button on that entity's records). Distinct from templateForEntity,
// which is the single PDF/document template per table.
function emailTemplatesForEntity(schema, entityKey) {
  return (schema.templates || []).filter(t => t.baseKind === 'email' && t.baseTable === entityKey);
}

// Every report column's Label (e.g. "Inv #", "Rent Recd. Dt.") is what a
// person reads, but isn't a safe {{tag}} name as-is — strips down to
// letters/digits/underscore, and if that produces something that can't
// start an identifier (empty, or starts with a digit) falls back to a
// positional Col1/Col2/... name instead of producing a broken or
// confusing tag. Collisions (two columns that sanitize to the same key,
// e.g. "Amount" and "Amount " differing only in trailing whitespace) get
// a numeric suffix on the second and later occurrences — deterministic
// and predictable, not silently overwriting one column's data with
// another's under the same tag name. This is the fallback only —
// reportColumnKeyMap below prefers an explicit, admin-set Tag Key first,
// since that's the one that survives a later label rename unscathed.
function sanitizeReportColumnKey(label, positionalFallback) {
  let key = String(label || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!key || /^[0-9]/.test(key)) key = 'Col' + positionalFallback;
  return key;
}
// Takes the actual column/aggregate objects (each { label, tagKey }),
// not bare label strings, so an explicit Tag Key can be honored — a
// merge tag set this way keeps working even after the Label it was
// originally derived from changes, which is the entire reason Tag Key
// exists. Falls back to the sanitized-label derivation for anything
// without one, so older reports built before Tag Key existed keep
// working exactly as before with zero migration needed.
function reportColumnKeyMap(items) {
  const used = new Set();
  const map = {};
  items.forEach((item, i) => {
    const label = typeof item === 'string' ? item : item.label;
    const explicitKey = typeof item === 'string' ? '' : (item.tagKey || '');
    let key = explicitKey || sanitizeReportColumnKey(label, i + 1);
    let finalKey = key;
    let suffix = 2;
    while (used.has(finalKey)) { finalKey = key + suffix; suffix++; }
    used.add(finalKey);
    map[label] = finalKey;
  });
  return map;
}

function validateTemplateInput(schema, input, existingKey) {
  if (!input.label || !String(input.label).trim()) throw new Error('Template name is required.');
  const baseKind = input.baseKind === 'report' ? 'report' : (input.baseKind === 'email' ? 'email' : 'table');
  const pageOrientation = input.pageOrientation === 'landscape' ? 'landscape' : 'portrait';

  if (baseKind === 'email') {
    // An email template is bound to an entity (so merge tags resolve against
    // its records) and carries the recipient/subject/body — it IS the unit a
    // record's "send email" button uses. Unlike table/report templates there
    // can be MANY per entity ("Email invoice", "Send reminder", …), so no
    // one-per-table limit here.
    const baseEntity = schema.entities[input.baseTable];
    if (!baseEntity) throw new Error('Choose a valid base table for the email.');
    if (!String(input.emailTo || '').trim()) throw new Error('A recipient (To) is required — use a merge tag like {{SomeField}} or an fk chain, or a literal address.');
    if (!String(input.emailSubject || '').trim()) throw new Error('An email subject is required.');
    return {
      baseKind: 'email',
      label: input.label.trim(),
      baseTable: input.baseTable,
      emailTo: String(input.emailTo).trim(),
      emailCc: String(input.emailCc || '').trim(),
      emailBcc: String(input.emailBcc || '').trim(),
      emailSubject: String(input.emailSubject).trim(),
      htmlBody: input.htmlBody || '',
      pageOrientation: 'portrait',
      lineItemsChildTable: null, lineItemsFkField: null,
    };
  }

  if (baseKind === 'report') {
    const reportDef = reportDefByKey(schema, input.baseTable);
    if (!reportDef) throw new Error('Choose a valid report.');
    if (!reportDef.headerAnchorParam) {
      throw new Error(`"${reportDef.label}" has no Header Panel configured — a report needs one so there's a single, sensible subject the PDF is "for". Set up a Header Panel on this report first (Admin → Reports → Edit).`);
    }
    const existingForReport = templateForReport(schema, input.baseTable);
    if (existingForReport && existingForReport.key !== existingKey) {
      throw new Error(`"${reportDef.label}" already has a template ("${existingForReport.label}") — only one template per report is supported right now. Edit the existing one instead, or delete it first.`);
    }
    return {
      baseKind: 'report',
      label: input.label.trim(),
      baseTable: input.baseTable,
      htmlBody: input.htmlBody || '',
      pageOrientation,
      lineItemsChildTable: null, lineItemsFkField: null,
    };
  }

  const baseEntity = schema.entities[input.baseTable];
  if (!baseEntity) throw new Error('Choose a valid base table.');
  const existingForTable = templateForEntity(schema, input.baseTable);
  if (existingForTable && existingForTable.key !== existingKey) {
    throw new Error(`"${baseEntity.label}" already has a template ("${existingForTable.label}") — only one template per table is supported right now. Edit the existing one instead, or delete it first.`);
  }
  let lineItemsChildTable = null;
  let lineItemsFkField = null;
  if (input.lineItemsChildTable) {
    const childEntity = schema.entities[input.lineItemsChildTable];
    if (!childEntity) throw new Error('Line items table is not a real table.');
    const fkField = childEntity.fields.find(f => f.name === input.lineItemsFkField && f.type === 'fk' && f.ref === input.baseTable);
    if (!fkField) throw new Error(`"${input.lineItemsFkField}" is not a real field on ${childEntity.label} linking back to ${baseEntity.label}.`);
    lineItemsChildTable = input.lineItemsChildTable;
    lineItemsFkField = fkField.name;
  }
  return {
    baseKind: 'table',
    label: input.label.trim(),
    baseTable: input.baseTable,
    htmlBody: input.htmlBody || '',
    pageOrientation,
    lineItemsChildTable, lineItemsFkField,
  };
}

function addTemplate(schema, input) {
  const validated = validateTemplateInput(schema, input);
  const key = `${slugify(input.label)}-${Date.now().toString(36)}`;
  const template = { key, ...validated, createdAt: new Date().toISOString() };
  schema.templates.push(template);
  return template;
}

function updateTemplate(schema, key, input) {
  const idx = (schema.templates || []).findIndex(t => t.key === key);
  if (idx === -1) throw new Error('Unknown template.');
  const validated = validateTemplateInput(schema, input, key);
  schema.templates[idx] = { ...schema.templates[idx], ...validated };
  return schema.templates[idx];
}

function deleteTemplate(schema, key) {
  schema.templates = (schema.templates || []).filter(t => t.key !== key);
}

function groupRowsFor(groupRows, agg, schema, baseEntity) {
  return groupRows.map(r => {
    const v = Number(evalFormula(agg.expr, schema, baseEntity, r, {}, 0));
    return isNaN(v) ? 0 : v;
  });
}

module.exports = {
  ensureAppSettings, normalizeDateValue,
  ensureBulkGenerateProfiles, addBulkGenerateProfile, updateBulkGenerateProfile, deleteBulkGenerateProfile,
  FIELD_TYPES, LAYOUT_TYPES, COMPUTED_TYPES, FILTERABLE_TYPES, filterKindFor, load, normalizeSchema, persist, slugify, safeFieldName, display, listTitle, detailTitle, listFieldsFor, filterFieldsFor, withComputedFieldsSubset,
  NUMERIC_FIELD_TYPES, LIST_TOTAL_FNS, numericFieldsFor, updateListTotals, computeListTotals,
  resolveMergeChain, formatMergeValue, renderBillTemplate,
  templatesFor, templateByKey, templateForEntity, templateForReport, emailTemplatesForEntity, addTemplate, updateTemplate, deleteTemplate,
  mergeFieldTags, renderBillTemplate, mergeFieldTagsPlain,
  sidebarGroupsFor, addSidebarGroup, updateSidebarGroup, deleteSidebarGroup, reorderSidebarGroups, dedupeSidebarItemsWithinGroups,
  addSidebarItem, updateSidebarItem, deleteSidebarItem, reorderSidebarItems, builtinSidebarLinks, guessIconForKey,
  reportColumnKeyMap, renderReportTemplate, resolveReportAnchorRecord,
  formatINR, formatPercent, formatDate, formatFormulaValue, renderHintHtml, evalFormula, withComputedFields, resolveCrossTableValue,
  picklistOptions, assignSeriesFields, getChildren, isReferenced, findBlockingReferences, computeFieldDefault, applyFieldDefaults,
  addEntity, updateEntitySettings, deleteEntity, moveNav, addNav, removeNav, moveEntityToAdmin, moveEntityOutOfAdmin, reorderAdminSubnav, ADMIN_SUBNAV_FIXED_PAGES,
  addField, updateField, deleteField, moveField,
  fkWhereFilterRows, fkRowSatisfies, fkWhereParentRefs, fkConstraintErrors, bulkLinkableRelationships, linkMatchingRecords,
  updateViewSort, addListColumn, removeListColumn, moveListColumn,
  addFilterField, removeFilterField, moveFilterField,
  reorderFields, reorderListColumns, reorderFilterFields, reorderNav,
  PAYQR_FIELD_ROLES, updatePayqrSettings, payqrEligibleFields, payqrPayeePkField, payqrPaymentToPayeeFkField,
  TAX_FIELD_ROLES, updateTaxSettings, taxEligibleFields, taxSettingsComplete,
  SESSION_TIMEOUT_MIN, SESSION_TIMEOUT_MAX, updateSessionTimeout,
  discoverApplets, appletSettingsFor, addChildAppletInstance, removeApplet, reorderApplets, setAppletFilter, computeAppletData, applyFilterCondition,
  reportDefsFor, reportDefByKey, addReportDef, updateReportDef, deleteReportDef, duplicateReportDef, runReport, resolveExprField, aggregateValues,
  appletsFor, appletByKey, addApplet, updateApplet, deleteApplet,
  viewsFor, viewByKey, addView, updateView, deleteView, reorderViewApplets,
  screensFor, screenByKey, addScreen, updateScreen, deleteScreen, reorderScreenViews,
  picklistsFor, picklistByKey, addPicklist, updatePicklist, deletePicklist, setPicklistValueActive, resolvePicklistOptions, resolvePicklistOptionsForForm, resolvePicklistLabel, picklistValuesFromCsv,
};

// ---- Bulk Generate Profiles ------------------------------------------------
// A saved configuration for generating target-table records from source-table
// rows (e.g. generate one invoice per active tenant for a month). Generic;
// not hardcoded to any specific tables.
function ensureBulkGenerateProfiles(schema) {
  if (!schema.bulkGenerateProfiles) schema.bulkGenerateProfiles = [];
}
function addBulkGenerateProfile(schema, input) {
  ensureBulkGenerateProfiles(schema);
  const key = (input.label || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '_') + '-' + Date.now().toString(36);
  const profile = {
    key,
    label: String(input.label || '').trim(),
    sourceTable: input.sourceTable,
    sourceFilter: input.sourceFilter || '',       // formula: e.g. "T_Active = true"
    sourceSort: input.sourceSort || '',            // field name for ordering
    targetTable: input.targetTable,
    fieldMappings: input.fieldMappings || [],       // [{targetField, value}] — value can be a source field name or a literal
    monthField: input.monthField || '',             // target field that receives the chosen month (YYYY-MM)
    dedupField: input.dedupField || '',             // target field to check for existing records (skip if match)
    dedupSourceField: input.dedupSourceField || '', // source field to match against dedupField
  };
  schema.bulkGenerateProfiles.push(profile);
  persist(schema);
  return profile;
}
function updateBulkGenerateProfile(schema, key, input) {
  ensureBulkGenerateProfiles(schema);
  const idx = schema.bulkGenerateProfiles.findIndex(p => p.key === key);
  if (idx === -1) throw new Error('Unknown profile.');
  const p = schema.bulkGenerateProfiles[idx];
  if (input.label !== undefined) p.label = String(input.label).trim();
  if (input.sourceFilter !== undefined) p.sourceFilter = input.sourceFilter;
  if (input.sourceSort !== undefined) p.sourceSort = input.sourceSort;
  if (input.fieldMappings !== undefined) p.fieldMappings = input.fieldMappings;
  if (input.monthField !== undefined) p.monthField = input.monthField;
  if (input.dedupField !== undefined) p.dedupField = input.dedupField;
  if (input.dedupSourceField !== undefined) p.dedupSourceField = input.dedupSourceField;
  persist(schema);
  return p;
}
function deleteBulkGenerateProfile(schema, key) {
  ensureBulkGenerateProfiles(schema);
  schema.bulkGenerateProfiles = schema.bulkGenerateProfiles.filter(p => p.key !== key);
  persist(schema);
}

// ---- App Settings (system-wide preferences) --------------------------------
function ensureAppSettings(schema) {
  if (!schema.appSettings) schema.appSettings = {};
  if (!schema.appSettings.dateFormat) schema.appSettings.dateFormat = 'dd-mm-yyyy'; // Indian default
}

// Normalize a raw date string to ISO (yyyy-mm-dd). Tries common formats;
// for ambiguous cases (e.g. 03-05-2025) uses the preferDayFirst flag.
// Returns null if the value can't be parsed.
function normalizeDateValue(raw, preferDayFirst) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return '';

  // Already ISO: yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Excel serial number (pure integer, 5 digits like 45883)
  if (/^\d{5}$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 1 && n < 200000) {
      // Excel serial: days since 1900-01-00 (with the Lotus 1-2-3 bug: day 60 = Feb 29, 1900 which didn't exist)
      const base = new Date(1899, 11, 30); // Dec 30, 1899
      const adjust = n > 59 ? n - 1 : n; // skip the phantom Feb 29
      const d = new Date(base.getTime() + (adjust + 1) * 86400000);
      return d.toISOString().slice(0, 10);
    }
  }

  // dd-Mon-yyyy or dd/Mon/yyyy (unambiguous: 15-Aug-2025)
  const monMatch = s.match(/^(\d{1,2})[\/-]([A-Za-z]{3,9})[\/-](\d{4})$/);
  if (monMatch) {
    const d = new Date(monMatch[3] + ' ' + monMatch[2] + ' ' + monMatch[1]);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // dd-mm-yyyy, dd/mm/yyyy, mm-dd-yyyy, mm/dd/yyyy
  const numMatch = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (numMatch) {
    const a = parseInt(numMatch[1], 10);
    const b = parseInt(numMatch[2], 10);
    const year = parseInt(numMatch[3], 10);
    let day, month;
    if (preferDayFirst) { day = a; month = b; }
    else { month = a; day = b; }
    // Sanity check
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const iso = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      const check = new Date(iso);
      if (!isNaN(check.getTime()) && check.getDate() === day) return iso;
    }
    // Try the other interpretation if the first failed
    if (!preferDayFirst) { day = a; month = b; } else { month = a; day = b; }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const iso = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      const check = new Date(iso);
      if (!isNaN(check.getTime()) && check.getDate() === day) return iso;
    }
  }

  // yyyy/mm/dd
  const slashIso = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if (slashIso) {
    const iso = slashIso[1] + '-' + slashIso[2].padStart(2, '0') + '-' + slashIso[3].padStart(2, '0');
    const check = new Date(iso);
    if (!isNaN(check.getTime())) return iso;
  }

  return null; // unrecognizable
}
