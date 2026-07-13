// payqr.js
//
// PayQR-specific backend: narration templates + server-side QR generation.
// Kept isolated in its own module for two reasons:
//
// 1. Table identity is still fixed. This file only ever operates on
//    tables literally named "payees" and "payments" — that's a deliberate
//    scope boundary, not an oversight. Making the *table* choice
//    configurable (as opposed to which field on those tables plays a
//    given role) was out of scope for this build; if that's ever needed,
//    it's a bigger change than field-role mapping.
//
// 2. FIELD roles ARE fully configurable, via Admin -> PayQR Settings
//    (schema.payqrSettings). Two of the seven original hardcoded field
//    names never needed a setting at all — the payee's lookup identity is
//    just payees.pk, and "which field links Payments to Payees" is just
//    "whichever fk field on Payments has ref === 'payees'" — both fully
//    derivable from schema.js's existing relationship data. Those are
//    computed on demand (payqrPayeePkField, payqrPaymentToPayeeFkField)
//    rather than stored as redundant settings that could drift out of
//    sync with the schema.
//
// If PayQR ever isn't fully configured (a setting points at nothing, or a
// referenced field was deleted), every route here fails loudly with a
// clear message pointing at Admin -> PayQR Settings, rather than silently
// guessing or degrading.

const express = require('express');
const QRCode = require('qrcode');
const schemaLib = require('./schema');
const db = require('./db');
const usersLib = require('./users');

const router = express.Router();

function getSettings(schema) {
  return schema.payqrSettings || {};
}

function settingsComplete(settings) {
  return !!(settings.payeeUpiField && settings.payeeNarrationField &&
            settings.paymentAmountField && settings.paymentNotesField && settings.paymentDateField);
}

// The Payment Method field is optional config (unlike the 5 above) — if
// it's not mapped, we simply skip the method check and behave as before
// (generate whenever a UPI ID is present). If it IS mapped, we treat any
// value that doesn't look like a UPI method as "not payable by QR yet" —
// matched loosely (case-insensitive "upi" substring) against whatever the
// admin's picklist option text actually says, rather than assuming an
// exact hardcoded string like "UPI ID", since that text is editable.
function payeeIsUpiPayable(payee, settings) {
  if (!settings.payeeMethodField) return true; // not configured — don't block on it
  const method = String(payee[settings.payeeMethodField] || '');
  return /upi/i.test(method);
}

// Resolves a payee's narration template, substituting {{PREV_MONTH}} with
// last month's short name (e.g. "Jun 2026").
function resolveNarration(payee, settings) {
  const tmpl = (payee && payee[settings.payeeNarrationField]) || '';
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const prevMonth = `${months[prev.getMonth()]} ${prev.getFullYear()}`;
  return tmpl.replace(/\{\{PREV_MONTH\}\}/g, prevMonth);
}

// Builds the upi://pay intent URL from a payee + payment record.
function buildPaymentQrUrl(payee, payment, settings, payeePkField) {
  return 'upi://pay?pa=' + encodeURIComponent(payee[settings.payeeUpiField]) +
         '&pn=' + encodeURIComponent(payee[payeePkField]) +
         (payment[settings.paymentAmountField] ? '&am=' + encodeURIComponent(payment[settings.paymentAmountField]) : '') +
         (payment[settings.paymentNotesField] ? '&tn=' + encodeURIComponent(payment[settings.paymentNotesField]) : '');
}

// Pre-fills a brand-new Payment record's Date (today) and Payee (if the
// user arrived via a "Pay <payee>" link with ?pay_for_payee=<name>)
// before the create form renders.
function prefillNewPayment(query, emptyRecord, settings, payeeFkField) {
  const todayF = query.pay_for_payee ? '' : new Date().toISOString().slice(0, 10);
  if (todayF && settings.paymentDateField) emptyRecord[settings.paymentDateField] = todayF;
  if (query.pay_for_payee && payeeFkField) emptyRecord[payeeFkField] = query.pay_for_payee;
}

function isPaymentsEntity(entityKey) {
  return entityKey === 'payments';
}

const NOT_CONFIGURED_MSG = 'PayQR is not fully configured yet. Go to Admin \u2192 PayQR Settings to map the required fields.';

// Small helper endpoint used by the payment create form to preview a
// payee's narration template with {{PREV_MONTH}} substituted.
router.get('/api/payee-narration/:payeeName', (req, res) => {
  const schema = req.schema;
  const settings = getSettings(schema);
  const pkField = schemaLib.payqrPayeePkField(schema);
  if (!pkField || !settingsComplete(settings)) return res.status(409).json({ error: NOT_CONFIGURED_MSG });
  if (!usersLib.can(req.currentUser, 'payees', 'read')) return res.status(403).json({ error: 'No read permission on Payees.' });
  const payee = db.getById('payees', pkField, req.params.payeeName);
  if (!payee) return res.json({ narration: '' });
  res.json({ narration: resolveNarration(payee, settings) });
});

// Server-side QR generation for a payment record.
router.get('/api/payment-qr/:id.png', async (req, res) => {
  const schema = req.schema;
  const settings = getSettings(schema);
  const payeePkField = schemaLib.payqrPayeePkField(schema);
  const payeeFkField = schemaLib.payqrPaymentToPayeeFkField(schema);
  const paymentsEntity = schema.entities.payments;
  if (!payeePkField || !payeeFkField || !paymentsEntity || !settingsComplete(settings)) {
    return res.status(409).send(NOT_CONFIGURED_MSG);
  }
  if (!usersLib.can(req.currentUser, 'payments', 'read')) return res.status(403).send('No read permission on Payments.');
  const payment = db.getById('payments', paymentsEntity.pk, req.params.id);
  if (!payment) return res.status(404).send('Not found.');
  const payee = db.getById('payees', payeePkField, payment[payeeFkField]);
  if (!payee || !payee[settings.payeeUpiField]) return res.status(404).send('Payee has no UPI ID configured.');
  if (!payeeIsUpiPayable(payee, settings)) {
    return res.status(409).send('QR-code payment by bank account isn\u2019t supported yet. This payee\u2019s payment method is set to bank transfer \u2014 use the bank details on their record to pay manually.');
  }
  const url = buildPaymentQrUrl(payee, payment, settings, payeePkField);
  try {
    const png = await QRCode.toBuffer(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, no-cache'); // QR reflects live payment data, no browser cache
    res.send(png);
  } catch (e) {
    res.status(500).send('QR generation failed: ' + e.message);
  }
});

module.exports = {
  router, getSettings, settingsComplete, resolveNarration, buildPaymentQrUrl,
  prefillNewPayment, isPaymentsEntity, NOT_CONFIGURED_MSG,
};
