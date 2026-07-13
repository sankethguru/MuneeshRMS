// schema.js
// Loads/saves the editable application schema (data/schema.json) and
// provides mutation helpers used by the /admin routes. This is what makes
// the app self-sufficient: tables, fields, order, and foreign keys are all
// data, not code.

const fs = require('fs');
const path = require('path');
const defaultSchema = require('./default-schema');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const SCHEMA_FILE = path.join(DATA_DIR, 'schema.json');

const FIELD_TYPES = ['text', 'number', 'date', 'timestamp', 'bool', 'textarea', 'fk', 'currency', 'percent', 'image', 'formula', 'picklist', 'series', 'rollup', 'spacer', 'section'];
// Layout-only types: hold no data, never saved, never in list columns, never importable/exportable.
const LAYOUT_TYPES = ['spacer', 'section'];
// Computed types: value is derived, never taken from a form or CSV import.
const COMPUTED_TYPES = ['formula', 'rollup', 'series'];

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SCHEMA_FILE)) fs.writeFileSync(SCHEMA_FILE, JSON.stringify(defaultSchema, null, 2));
}

function load() {
  ensure();
  const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
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

  // Idle session timeout, in minutes. Admin-configurable (Admin -> Session);
  // 30 is a reasonable default for a data-entry app — long enough that
  // filling in a big Bill/Tenant form doesn't risk losing work, short
  // enough to matter as a real security control.
  if (typeof schema.sessionTimeoutMinutes !== 'number' || schema.sessionTimeoutMinutes <= 0) {
    schema.sessionTimeoutMinutes = 30;
  }

  // Report definitions (Admin -> Reports) — data, not code, so a report's
  // field references are editable from Admin rather than baked into a
  // .js file. See runReport() below for how these get executed.
  if (!Array.isArray(schema.reportDefs)) schema.reportDefs = [];

  return schema;
}

function persist(schema) {
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2));
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
function display(entity, record) {
  if (!record) return '';
  if (entity.displayField && record[entity.displayField]) return record[entity.displayField];
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
  return str.replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||').replace(/\bNOT\b/g, '!');
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
  const remote = db.getById(refEntity.key, refEntity.pk, fkValue);
  if (!remote) return { value: undefined, field: remoteField };
  return { value: remote[fieldPart], field: remoteField };
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

const STATIC_FORMULA_FUNCTIONS = {
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
    let conditionError = null;
    const matches = db.getAll(targetEntity.key).filter(row => {
      if (conditionError) return false;
      const scopes = { ...extraScopes, [tableKey]: { entity: targetEntity, row } };
      const result = evalFormula(conditionExpr, schema, entity, record, scopes, depth + 1);
      if (isFormulaError(result)) { conditionError = result; return false; }
      return result === true;
    });
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
function evalFormula(formula, schema, entity, record, extraScopes, depth) {
  extraScopes = extraScopes || {};
  depth = depth || 0;
  if (!formula || !formula.trim()) return '';
  const trimmed = formula.trim();
  if (!FORMULA_SAFE_RE.test(trimmed) || FORMULA_BANNED_RE.test(trimmed)) return '#ERR';

  // Fast path: the whole formula is just one reference (same-table field,
  // or "x.y" cross-table field) — return its raw value as-is, so text
  // lookups (names, statuses, etc.) aren't mangled into 0 by numeric
  // coercion. Arithmetic/expressions/function calls fall through below.
  const bareCrossRef = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (bareCrossRef) {
    const scope = extraScopes[bareCrossRef[1]];
    if (scope) {
      if (!scope.entity.fields.some(f => f.name === bareCrossRef[2])) {
        return `#REF: no such field "${bareCrossRef[2]}" on ${scope.entity.key}`;
      }
      return scope.row[bareCrossRef[2]];
    }
    const resolved = resolveCrossTableValue(schema, entity, record, bareCrossRef[1], bareCrossRef[2]);
    if (resolved.error) return resolved.error;
    return resolved.value === undefined ? '' : resolved.value;
  }
  const bareField = trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  if (bareField && entity.fields.some(f => f.name === trimmed)) {
    const v = record[trimmed];
    return v === undefined ? '' : v;
  }

  const { masked, literals } = maskQuotedStrings(trimmed);
  const equalsFixed = convertLogicalKeywords(convertEquals(masked));
  const crossRefs = {};
  let refCounter = 0;
  let refError = null;
  let maskedWorking = equalsFixed.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (match, p1, p2) => {
    const varName = `__ref${refCounter++}`;
    if (refError) return varName; // already found a bad reference; keep the string well-formed and bail after
    let remoteVal;
    let remoteFieldType;
    const scope = extraScopes[p1];
    if (scope) {
      const remoteField = scope.entity.fields.find(f => f.name === p2);
      if (!remoteField) {
        refError = `#REF: no such field "${p2}" on ${scope.entity.key}`;
        remoteVal = undefined;
      } else {
        remoteVal = scope.row[p2];
        remoteFieldType = remoteField.type;
      }
    } else {
      const resolved = resolveCrossTableValue(schema, entity, record, p1, p2);
      if (resolved.error) { refError = resolved.error; remoteVal = undefined; } else { remoteVal = resolved.value; remoteFieldType = resolved.field && resolved.field.type; }
    }
    const isBlank = remoteVal === undefined || remoteVal === null || remoteVal === '';
    crossRefs[varName] = isBlank ? (isArithmeticFieldType(remoteFieldType) ? 0 : '') : remoteVal;
    return varName;
  });
  if (refError) return refError;
  const workingFormula = unmaskQuotedStrings(maskedWorking, literals);

  const varFields = entity.fields.filter(f => f.type !== 'formula' && f.type !== 'rollup');
  const fnNames = Object.keys(STATIC_FORMULA_FUNCTIONS).concat(['LOOKUP']);
  const names = varFields.map(f => f.name).concat(Object.keys(crossRefs)).concat(fnNames);
  // Pass raw values (not force-coerced to numbers) — JS arithmetic operators
  // already coerce numeric strings/numbers naturally, but functions like
  // MONTH()/YEAR()/UPPER() need the real date/text value, not a mangled 0.
  const args = varFields.map(f => {
    const v = record[f.name];
    const isBlank = v === undefined || v === null || v === '';
    if (isBlank) return isArithmeticFieldType(f.type) ? 0 : '';
    return v;
  }).concat(Object.values(crossRefs))
    .concat(Object.values(STATIC_FORMULA_FUNCTIONS))
    .concat([makeLookupFn(schema, entity, record, extraScopes, depth)]);

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

function computeRollup(schema, field, parentEntity, parentRecord) {
  const targetKey = field.rollupHop2Entity || field.rollupHop1Entity;
  const targetEntity = schema.entities[targetKey];
  if (!targetEntity) return '#ERR';

  let rows = rollupSourceRows(schema, parentEntity, parentRecord, field.rollupHop1Entity, field.rollupHop2Entity || null);

  if (field.rollupWhere && field.rollupWhere.trim()) {
    let whereError = null;
    rows = rows.filter(r => {
      if (whereError) return false;
      const result = evalFormula(field.rollupWhere, schema, targetEntity, r, { parent: { entity: parentEntity, row: parentRecord } }, 0);
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
  entity.fields.forEach(f => {
    if (f.type === 'formula') out[f.name] = evalFormula(f.formula, schema, entity, record);
    if (f.type === 'rollup') out[f.name] = computeRollup(schema, f, entity, record);
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
function picklistOptions(field) {
  return String(field.options || '').split(',').map(s => s.trim()).filter(Boolean);
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
function addApplet(schema, entityKey, baseKey) {
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
function applyAppletFilter(schema, applet, setting, rows) {
  if (!setting || !setting.filterField) return rows;
  const targetEntity = schema.entities[applet.entity];
  const f = targetEntity && targetEntity.fields.find(fl => fl.name === setting.filterField);
  if (!f) return rows;
  const kind = filterKindFor(f);
  if (kind === 'date-range') {
    if (!setting.filterFrom && !setting.filterTo) return rows;
    return rows.filter(r => {
      const v = r[setting.filterField];
      if (!v) return false;
      if (setting.filterFrom && v < setting.filterFrom) return false;
      if (setting.filterTo && v > setting.filterTo) return false;
      return true;
    });
  }
  if (kind === 'number-range') {
    if (!setting.filterFrom && !setting.filterTo) return rows;
    const isPercent = f.type === 'percent' || f.format === 'percent';
    const scale = isPercent ? 100 : 1;
    return rows.filter(r => {
      const n = Number(r[setting.filterField]);
      if (isNaN(n)) return false;
      const displayVal = n * scale;
      if (setting.filterFrom !== '' && displayVal < Number(setting.filterFrom)) return false;
      if (setting.filterTo !== '' && displayVal > Number(setting.filterTo)) return false;
      return true;
    });
  }
  if (!setting.filterValue) return rows;
  if (f.type === 'bool') {
    const want = setting.filterValue === 'true';
    return rows.filter(r => !!r[setting.filterField] === want);
  }
  return rows.filter(r => String(r[setting.filterField] ?? '') === setting.filterValue);
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
  schema.navOrder = schema.navOrder.filter(k => k !== entityKey);
}

function addField(schema, entityKey, { name, label, type, ref, required, inList, rows, formula, format, options, seriesGroupPath, seriesTrackerEntity, seriesTrackerGroupField, seriesTrackerCounterField, rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField, rollupWhere }) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  if (!name || !String(name).trim()) throw new Error('Field name is required.');
  const t = FIELD_TYPES.includes(type) ? type : 'text';
  if (t !== 'spacer' && (!label || !String(label).trim())) throw new Error('Field label is required.');
  const fname = safeFieldName(name);
  if (e.fields.some(f => f.name === fname)) throw new Error(`Field "${fname}" already exists on this table.`);
  if (t === 'fk' && (!ref || !schema.entities[ref])) throw new Error('Please choose a table for this lookup field to link to.');
  if (t === 'formula' && (!formula || !formula.trim())) throw new Error('Please enter a formula for this calculated field.');
  if (t === 'picklist' && (!options || !options.trim())) throw new Error('Please enter at least one option (comma-separated).');
  if (t === 'series' && (!seriesGroupPath || !seriesTrackerEntity || !seriesTrackerGroupField || !seriesTrackerCounterField)) {
    throw new Error('Series fields need a group path, a tracker table, and its group/counter fields.');
  }
  if (t === 'rollup') validateRollupConfig(schema, entityKey, { rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField });
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
    options: t === 'picklist' ? options.trim() : undefined,
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

function updateField(schema, entityKey, fieldName, { label, type, ref, required, inList, rows, formula, format, options, seriesGroupPath, seriesTrackerEntity, seriesTrackerGroupField, seriesTrackerCounterField, rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField, rollupWhere }) {
  const e = schema.entities[entityKey];
  if (!e) throw new Error('Unknown table.');
  const f = e.fields.find(fl => fl.name === fieldName);
  if (!f) throw new Error('Unknown field.');
  if (label && label.trim()) f.label = label.trim();
  if (f.key) return; // primary key: label only, type/ref/required stay fixed
  const t = FIELD_TYPES.includes(type) ? type : f.type;
  if (t === 'fk' && (!ref || !schema.entities[ref])) throw new Error('Please choose a table for this lookup field to link to.');
  if (t === 'formula' && (!formula || !formula.trim())) throw new Error('Please enter a formula for this calculated field.');
  if (t === 'picklist' && (!options || !options.trim())) throw new Error('Please enter at least one option (comma-separated).');
  if (t === 'series' && (!seriesGroupPath || !seriesTrackerEntity || !seriesTrackerGroupField || !seriesTrackerCounterField)) {
    throw new Error('Series fields need a group path, a tracker table, and its group/counter fields.');
  }
  if (t === 'rollup') validateRollupConfig(schema, entityKey, { rollupFn, rollupHop1Entity, rollupHop2Entity, rollupField, rollupOrderField });
  f.type = t;
  f.ref = t === 'fk' ? ref : undefined;
  f.required = (COMPUTED_TYPES.includes(t) || LAYOUT_TYPES.includes(t)) ? false : !!required;
  f.inList = LAYOUT_TYPES.includes(t) ? false : !!inList;
  f.rows = t === 'textarea' ? (Number(rows) > 0 ? Number(rows) : (f.rows || 2)) : undefined;
  f.formula = t === 'formula' ? formula.trim() : undefined;
  f.format = (t === 'formula' || t === 'rollup') ? (['currency', 'percent', 'date', 'datetime'].includes(format) ? format : 'none') : undefined;
  f.options = t === 'picklist' ? options.trim() : undefined;
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
}

// Applies a formula field's configured "Format As" (currency/percent/date/datetime)
// to its computed value, for consistent display in both list and form views.
function formatFormulaValue(field, value) {
  if (value === '#ERR' || value === '' || value === undefined || value === null) return value;
  if (field.format === 'currency') return formatINR(value);
  if (field.format === 'percent') return formatPercent(value);
  if (field.format === 'date') return formatDate(value, false);
  if (field.format === 'datetime') return formatDate(value, true);
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
  columns.forEach(c => { if (!c.label || !c.label.trim()) c.label = c.expr; });

  const groupBy = (input.groupBy || '').trim();
  const aggregates = (input.aggregates || []).filter(a => a && a.expr && a.expr.trim() && a.fn);
  aggregates.forEach(a => { if (!a.label || !a.label.trim()) a.label = `${a.fn}(${a.expr})`; });

  if (groupBy) {
    if (aggregates.length === 0) throw new Error('A grouped report needs at least one aggregate (e.g. SUM of an amount).');
  } else if (columns.length === 0) {
    throw new Error('Add at least one column.');
  }

  const parameters = (input.parameters || []).filter(p => p && p.key && p.field);
  parameters.forEach(p => {
    // Resolve the parameter's field type up front (not guessed later from a
    // runtime value) so its filter control is always statically known —
    // same reasoning FILTERABLE_TYPES/filterKindFor already use elsewhere.
    const resolved = resolveExprField(schema, baseEntity, p.field);
    if (!resolved) throw new Error(`Parameter "${p.label || p.key}": "${p.field}" doesn't resolve to a real field.`);
    if (!FILTERABLE_TYPES.includes(resolved.type)) {
      throw new Error(`Parameter "${p.label || p.key}": "${p.field}" is type "${resolved.type}", which can't be used as a parameter.`);
    }
    p.kind = filterKindFor(resolved);
    p.fieldType = resolved.type;
    p.isPercent = resolved.type === 'percent' || resolved.format === 'percent';
    if (!p.label || !p.label.trim()) p.label = p.field;
  });

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
  };
}

// Resolves a dotted/bare expr to the actual field definition it refers to,
// so callers can know its real type (for parameter filter controls)
// without guessing from a runtime value. Only handles the simple cases —
// a bare field name, or one "x.y" cross-table hop — matching what
// parameters are restricted to; full arithmetic expressions (used freely
// in columns/aggregates/conditions) aren't resolved to a single field on
// purpose, since they don't have just one type.
function resolveExprField(schema, baseEntity, expr) {
  const trimmed = String(expr || '').trim();
  const bareMatch = trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  if (bareMatch) {
    return baseEntity.fields.find(f => f.name === trimmed) || null;
  }
  const dotted = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (dotted) {
    let fkField = baseEntity.fields.find(f => f.type === 'fk' && f.name === dotted[1]);
    if (!fkField) fkField = baseEntity.fields.find(f => f.type === 'fk' && f.ref === dotted[1]);
    if (!fkField) return null;
    const refEntity = schema.entities[fkField.ref];
    return refEntity ? (refEntity.fields.find(f => f.name === dotted[2]) || null) : null;
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
    if (param.kind === 'date-range' || param.kind === 'number-range') {
      const from = (raw && raw.from) || '';
      const to = (raw && raw.to) || '';
      if (!from && !to) return;
      rows = rows.filter(r => {
        const v = evalFormula(param.field, schema, baseEntity, r, {}, 0);
        if (param.kind === 'date-range') {
          if (!v) return false;
          if (from && v < from) return false;
          if (to && v > to) return false;
          return true;
        }
        const n = Number(v);
        if (isNaN(n)) return false;
        const scale = param.isPercent ? 100 : 1;
        const dv = n * scale;
        if (from !== '' && dv < Number(from)) return false;
        if (to !== '' && dv > Number(to)) return false;
        return true;
      });
    } else {
      const val = raw || '';
      if (!val) return;
      rows = rows.filter(r => {
        const v = evalFormula(param.field, schema, baseEntity, r, {}, 0);
        if (param.fieldType === 'bool') return !!v === (val === 'true');
        return String(v ?? '') === val;
      });
    }
  });

  if (!reportDef.groupBy) {
    const cols = reportDef.columns.map(c => c.label);
    const outRows = rows.map(r => {
      const out = {};
      reportDef.columns.forEach(col => {
        out[col.label] = formatFormulaValue({ format: col.format }, evalFormula(col.expr, schema, baseEntity, r, {}, 0));
      });
      return out;
    });
    return { mode: 'detail', columns: cols, rows: outRows };
  }

  const groups = {};
  const groupOrder = [];
  rows.forEach(r => {
    const key = evalFormula(reportDef.groupBy, schema, baseEntity, r, {}, 0);
    const keyStr = String(key);
    if (!groups[keyStr]) { groups[keyStr] = []; groupOrder.push(keyStr); }
    groups[keyStr].push(r);
  });
  const outRows = groupOrder.map(keyStr => {
    const out = { [reportDef.groupByLabel]: keyStr };
    (reportDef.aggregates || []).forEach(agg => {
      const nums = groupRowsFor(groups[keyStr], agg, schema, baseEntity);
      out[agg.label] = formatFormulaValue({ format: agg.format }, aggregateValues(agg.fn, nums));
    });
    return out;
  });
  const cols = [reportDef.groupByLabel, ...(reportDef.aggregates || []).map(a => a.label)];
  return { mode: 'grouped', columns: cols, rows: outRows };
}

function groupRowsFor(groupRows, agg, schema, baseEntity) {
  return groupRows.map(r => {
    const v = Number(evalFormula(agg.expr, schema, baseEntity, r, {}, 0));
    return isNaN(v) ? 0 : v;
  });
}

module.exports = {
  FIELD_TYPES, LAYOUT_TYPES, COMPUTED_TYPES, FILTERABLE_TYPES, filterKindFor, load, persist, slugify, safeFieldName, display, listTitle, detailTitle, listFieldsFor, filterFieldsFor,
  formatINR, formatPercent, formatDate, formatFormulaValue, evalFormula, withComputedFields, resolveCrossTableValue,
  picklistOptions, assignSeriesFields, getChildren, isReferenced,
  addEntity, updateEntitySettings, deleteEntity, moveNav, addNav, removeNav,
  addField, updateField, deleteField, moveField,
  updateViewSort, addListColumn, removeListColumn, moveListColumn,
  addFilterField, removeFilterField, moveFilterField,
  reorderFields, reorderListColumns, reorderFilterFields, reorderNav,
  PAYQR_FIELD_ROLES, updatePayqrSettings, payqrEligibleFields, payqrPayeePkField, payqrPaymentToPayeeFkField,
  SESSION_TIMEOUT_MIN, SESSION_TIMEOUT_MAX, updateSessionTimeout,
  discoverApplets, appletSettingsFor, addApplet, removeApplet, reorderApplets, setAppletFilter, computeAppletData,
  reportDefsFor, reportDefByKey, addReportDef, updateReportDef, deleteReportDef, duplicateReportDef, runReport, resolveExprField, aggregateValues,
};
