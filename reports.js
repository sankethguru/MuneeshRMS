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
const billPdf = require('./billPdf');

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

// Express's query parser (qs) turns a repeated query key into an array
// rather than a string (e.g. ?tenant=A&tenant=B -> ['A','B']) — this
// shouldn't normally happen since validateReportDef now rejects duplicate
// parameter keys at save time, but a stale report saved before that check
// existed, a hand-edited URL, or any other unexpected shape should degrade
// gracefully rather than crash the whole page. Takes the first value if
// given an array; coerces anything else to a string defensively.
function asQueryString(v) {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

// Parses the parameter values a report's own form submits (query string)
// into the shape runReport() expects: a plain string for exact-kind
// parameters, or {from, to} for range-kind ones.
function parseParamValues(def, query) {
  const values = {};
  (def.parameters || []).forEach(p => {
    if (p.kind === 'date-range' || p.kind === 'number-range') {
      values[p.key] = { from: asQueryString(query[`${p.key}_from`]), to: asQueryString(query[`${p.key}_to`]) };
    } else {
      values[p.key] = asQueryString(query[p.key]);
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
  if (resolved.type === 'picklist') {
    // evalFormula resolves a picklist field reference to its current LABEL
    // (not the raw stored key), so the comparison this report parameter
    // performs is against label text — the dropdown must offer the same
    // label space. resolvePicklistOptions covers custom, global-static,
    // AND global-table-sourced uniformly (picklistOptions() alone used to
    // only handle the custom case, so a report filtering on a global
    // picklist field silently got an empty dropdown before this). Use the
    // field's ACTUAL owning entity (may be a related table one fk hop
    // away, e.g. "tenants.Status"), not always baseEntity.
    const owningEntity = schema.entities[resolved._resolvedOnEntityKey] || baseEntity;
    return { kind: 'picklist', options: schemaLib.resolvePicklistOptions(schema, owningEntity, resolved).map(o => o.label) };
  }
  if (resolved.type === 'fk') {
    const db = require('./db');
    const refEntity = schema.entities[resolved.ref];
    if (!refEntity) return { kind: 'fk', options: [] };

    // A self-referential fk (the resolved field lives on the same table
    // it points to, e.g. tenants.T_GroupRoot: type fk, ref 'tenants') is
    // a group tag shared across several rows (every revision of the same
    // tenant), not a genuine per-row identifier — listing every row by
    // its own primary key here is actively wrong: two different rows
    // sharing one tag would show as two separate options, and picking
    // one row's own PK as the "value" doesn't match what the report
    // actually filters by (the shared tag), so the very option a person
    // would naturally click can silently return zero matching records.
    // Confirmed directly against a real two-revision tenant before this
    // fix: selecting the current revision's own code from the dropdown
    // returned "No matching records", while the actual group tag (not
    // offered as its own clearly labeled option at all) worked.
    if (resolved._resolvedOnEntityKey === resolved.ref) {
      const allRows = db.getAll(refEntity.key);
      const byValue = new Map(); // value -> most-recently-seen row sharing it
      allRows.forEach(r => {
        const v = r[resolved.name];
        if (v !== undefined && v !== null && v !== '') byValue.set(v, r); // last one wins - later rows are usually the more current revision
      });
      return {
        kind: 'fk',
        options: Array.from(byValue.entries()).map(([value, r]) => ({ value, label: `${value} \u2014 ${schemaLib.display(refEntity, r, schema)}` })),
      };
    }

    return {
      kind: 'fk',
      options: db.getAll(refEntity.key).map(r => ({ value: r[refEntity.pk], label: `${r[refEntity.pk]} \u2014 ${schemaLib.display(refEntity, r, schema)}` })),
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
    hasPdfTemplate: !!schemaLib.templateForReport(schema, def.key),
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

// Report-based PDF generation — deliberately generate-and-stream-back
// only, nothing stored anywhere on disk, unlike the Bill/Invoice PDF
// feature. Decided explicitly: a report's underlying data (payments
// received, GST status) changes often enough that a stored copy would
// go stale and become actively misleading rather than useful, unlike a
// Bill PDF which is fine to store since that data is essentially final
// once issued. Single-subject only (whatever the Header Panel is
// currently anchored to from the given parameter values) — no batch/
// multi-tenant generation, per the agreed scope.
router.get('/reports/:key/generate-pdf', async (req, res) => {
  const schema = req.schema;
  const def = schemaLib.reportDefByKey(schema, req.params.key);
  if (!def) return res.status(404).send('Unknown report.');
  if (!userCanRunReport(req.currentUser, def)) return forbidReport(res, def);

  const template = schemaLib.templateForReport(schema, req.params.key);
  if (!template) return res.status(404).send('No PDF template configured for this report.');

  const paramValues = parseParamValues(def, req.query);
  const rendered = schemaLib.renderReportTemplate(schema, template, paramValues);
  if (rendered.error) return res.status(400).send(rendered.error);

  try {
    const buffer = await billPdf.htmlToPdfBuffer(rendered.html, { landscape: template.pageOrientation === 'landscape' });
    // Filename built from the report + whatever's actually resolved as
    // the anchor's own display value + the raw parameter values, rather
    // than a generic "report.pdf" — e.g. TenantSummary_SGHUF_HPCL_2025-26.pdf.
    const anchor = schemaLib.resolveReportAnchorRecord(schema, def, paramValues);
    const anchorLabel = anchor ? schemaLib.display(anchor.anchorEntity, anchor.computedRecord, schema) : '';
    const paramPart = Object.values(paramValues).filter(v => v && typeof v !== 'object').join('_');
    const rawParts = [def.label.replace(/[^a-zA-Z0-9]+/g, ''), anchorLabel.replace(/[^a-zA-Z0-9]+/g, ''), paramPart.replace(/[^a-zA-Z0-9]+/g, '')].filter(Boolean);
    const filenameParts = rawParts.filter((part, i) => rawParts.indexOf(part) === i); // dedupe - e.g. the anchor's own code and a raw parameter value are often literally the same string
    const filename = (filenameParts.join('_') || def.key) + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).send('PDF generation failed: ' + e.message);
  }
});

// Same idea as the Bill Template's own preview route — the merged HTML
// directly, not a PDF, so someone building a report template can check
// it looks right without waiting on real PDF rendering each time.
router.get('/reports/:key/preview-pdf', (req, res) => {
  const schema = req.schema;
  const def = schemaLib.reportDefByKey(schema, req.params.key);
  if (!def) return res.status(404).send('Unknown report.');
  if (!userCanRunReport(req.currentUser, def)) return forbidReport(res, def);

  const template = schemaLib.templateForReport(schema, req.params.key);
  if (!template) return res.status(404).send('No PDF template configured for this report.');

  const paramValues = parseParamValues(def, req.query);
  const rendered = schemaLib.renderReportTemplate(schema, template, paramValues);
  if (rendered.error) return res.status(400).send(rendered.error);
  res.send(rendered.html);
});

module.exports = { router };
