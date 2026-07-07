// reports.js
//
// End-user side of the report-building tool. Unlike the earlier
// (rolled-back) version of this file, there is deliberately NOTHING
// table- or field-specific in here — every report is defined as data in
// schema.json (see schema.js's report-building section: addReportDef,
// updateReportDef, runReport), editable from Admin -> Reports. This file
// just renders whatever reports exist; it has no idea what "Bills" or
// "Tenants" even are.
//
// Permissions: a simplification, stated plainly rather than left
// implicit — a report requires read permission on its OWN base table
// only, not on every table its columns/parameters happen to reach via a
// cross-table expression. This mirrors how a List screen showing an fk's
// display value doesn't separately gate on the linked table's
// permission either. Fine for this install (family, not separate
// customers); worth revisiting if that ever changes.

const express = require('express');
const schemaLib = require('./schema');
const usersLib = require('./users');
const csv = require('./csv');

const router = express.Router();

function userCanRunReport(user, def) {
  return usersLib.can(user, def.baseTable, 'read');
}

function forbidReport(res, def) {
  return res.status(403).render('403', {
    message: `You don't have read permission on ${def.baseTable}, which this report needs. Ask an administrator to grant it under Admin \u2192 Users.`,
    activeKey: 'reports',
  });
}

// Parses the parameter values a report's own form submits (query string)
// into the shape runReport() expects: a plain string for exact-kind
// parameters, or {from, to} for range-kind ones.
function parseParamValues(def, query) {
  const values = {};
  (def.parameters || []).forEach(p => {
    if (p.kind === 'date-range' || p.kind === 'number-range') {
      values[p.key] = { from: (query[`${p.key}_from`] || '').trim(), to: (query[`${p.key}_to`] || '').trim() };
    } else {
      values[p.key] = (query[p.key] || '').trim();
    }
  });
  return values;
}

// Builds the option list for an fk-typed or picklist-typed parameter's
// dropdown, resolving the parameter's field the same way runReport()
// itself resolves expressions — so the options shown always match what
// the report can actually filter on.
function optionsForParam(schema, baseEntity, param) {
  const resolved = schemaLib.resolveExprField(schema, baseEntity, param.field);
  if (!resolved) return null;
  if (resolved.type === 'picklist') return { kind: 'picklist', options: schemaLib.picklistOptions(resolved) };
  if (resolved.type === 'fk') {
    const db = require('./db');
    const refEntity = schema.entities[resolved.ref];
    if (!refEntity) return { kind: 'fk', options: [] };
    return {
      kind: 'fk',
      options: db.getAll(refEntity.key).map(r => ({ value: r[refEntity.pk], label: `${r[refEntity.pk]} \u2014 ${schemaLib.display(refEntity, r)}` })),
    };
  }
  return null;
}

router.get('/reports', (req, res) => {
  const defs = schemaLib.reportDefsFor(req.schema).filter(d => userCanRunReport(req.currentUser, d));
  res.render('reports/index', { activeKey: 'reports', reportDefs: defs });
});

router.get('/reports/:key', (req, res) => {
  const schema = req.schema;
  const def = schemaLib.reportDefByKey(schema, req.params.key);
  if (!def) return res.status(404).send('Unknown report.');
  if (!userCanRunReport(req.currentUser, def)) return forbidReport(res, def);

  const baseEntity = schema.entities[def.baseTable];
  const hasAllParams = (def.parameters || []).length === 0 || Object.keys(req.query).length > 0;
  const paramValues = parseParamValues(def, req.query);

  const paramFields = (def.parameters || []).map(p => ({
    ...p,
    optionSet: optionsForParam(schema, baseEntity, p),
  }));

  let result = { mode: def.groupBy ? 'grouped' : 'detail', columns: [], rows: [] };
  if (hasAllParams) {
    result = schemaLib.runReport(schema, def, paramValues);
  }

  res.render('reports/run', {
    activeKey: 'reports', reportLabel: def.label, def, paramFields, paramValues, result, ran: hasAllParams,
  });
});

router.get('/reports/:key/export.csv', (req, res) => {
  const schema = req.schema;
  const def = schemaLib.reportDefByKey(schema, req.params.key);
  if (!def) return res.status(404).send('Unknown report.');
  if (!userCanRunReport(req.currentUser, def)) return forbidReport(res, def);

  const paramValues = parseParamValues(def, req.query);
  const result = schemaLib.runReport(schema, def, paramValues);
  const rows = [result.columns].concat(result.rows.map(r => result.columns.map(c => r[c])));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${def.key}.csv"`);
  // UTF-8 BOM — see routes/admin.js's export routes for the full
  // explanation (Excel misreads non-ASCII characters like ₹ without it).
  res.send('\uFEFF' + csv.stringify(rows));
});

module.exports = { router };
