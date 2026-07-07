// migrate-payqr.js
//
// One-time migration: adds the "payees" and "payments" tables to an
// EXISTING installation's data/schema.json. Needed because default-schema.js
// only seeds schema.json on a brand-new install — it doesn't retroactively
// apply to an app that's already been running (same situation as Bill
// Series earlier).
//
// Safe to run more than once: if "payees" or "payments" already exist in
// the schema, this script does nothing and says so. It never touches
// data/db.json (your actual records) — only data/schema.json (table/field
// definitions).
//
// USAGE (run once, from inside the container or wherever data/ lives):
//   node migrate-payqr.js
//
// A timestamped backup of the current schema.json is written alongside it
// before any change, so this is reversible by hand if needed.

const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = path.join(__dirname, 'data', 'schema.json');

function fail(msg) {
  console.error('MIGRATION FAILED: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(SCHEMA_FILE)) {
  fail(`Could not find ${SCHEMA_FILE}. Run this from the app's root directory (the one containing server.js and the data/ folder).`);
}

let schema;
try {
  schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
} catch (e) {
  fail(`data/schema.json is not valid JSON (${e.message}). Nothing was changed.`);
}

const alreadyHasPayees = !!schema.entities.payees;
const alreadyHasPayments = !!schema.entities.payments;

if (alreadyHasPayees && alreadyHasPayments) {
  console.log('Nothing to do — "payees" and "payments" already exist in data/schema.json.');
  process.exit(0);
}

// Back up the current schema before touching anything.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupFile = path.join(__dirname, 'data', `schema.json.bak-${stamp}`);
fs.writeFileSync(backupFile, JSON.stringify(schema, null, 2));
console.log(`Backed up current schema to ${backupFile}`);

if (!alreadyHasPayees) {
  schema.entities.payees = {
    key: 'payees',
    label: 'Payees',
    singular: 'Payee',
    pk: 'PAY_Name',
    displayField: 'PAY_Name',
    displayPrefix: '',
    listTitle: 'Vendor & Salary Payees',
    detailTitle: '',
    auditEnabled: false,
    fields: [
      { name: 'PAY_Name', label: 'Payee Name', type: 'text', required: true, key: true, inList: true },
      { name: 'PAY_Method', label: 'Payment Method', type: 'picklist', options: 'UPI ID, Bank Account', required: true, inList: true },
      { name: 'PAY_UPI_ID', label: 'UPI ID', type: 'text', inList: true },
      { name: 'PAY_AccountNum', label: 'Account Number', type: 'text', inList: false },
      { name: 'PAY_IFSC', label: 'IFSC', type: 'text', inList: false },
      { name: 'PAY_NarrationTemplate', label: 'Narration Template', type: 'text', inList: false },
      { name: 'PAY_LastPaidAmount', label: 'Last Paid Amount', type: 'rollup', format: 'currency', inList: true,
        rollupFn: 'LATEST', rollupHop1Entity: 'payments',
        rollupField: 'PMT_Amount', rollupOrderField: 'PMT_Date' },
      { name: 'PAY_LastPaidDate', label: 'Last Paid Date', type: 'rollup', format: 'date', inList: true,
        rollupFn: 'LATEST', rollupHop1Entity: 'payments',
        rollupField: 'PMT_Date', rollupOrderField: 'PMT_Date' },
    ],
  };
  console.log('Added "payees" table.');
}

if (!alreadyHasPayments) {
  schema.entities.payments = {
    key: 'payments',
    label: 'Payments',
    singular: 'Payment',
    pk: 'PMT_ID',
    displayField: '',
    displayPrefix: 'PMT-',
    listTitle: 'UPI Payment History',
    detailTitle: '',
    auditEnabled: false,
    fields: [
      { name: 'PMT_ID', label: 'Payment ID', type: 'number', required: true, key: true, auto: true, inList: true },
      { name: 'PMT_Date', label: 'Date', type: 'date', required: true, inList: true },
      { name: 'PMT_Payee', label: 'Payee', type: 'fk', ref: 'payees', required: true, inList: true },
      { name: 'PMT_Amount', label: 'Amount', type: 'currency', required: true, inList: true },
      { name: 'PMT_Notes', label: 'Notes', type: 'textarea', rows: 2, inList: true },
      { name: 'PMT_Month', label: 'Month', type: 'formula', format: 'plain', inList: false,
        formula: 'CONCAT(YEAR(PMT_Date), "-", MONTH(PMT_Date))' },
    ],
  };
  console.log('Added "payments" table.');
}

if (!Array.isArray(schema.navOrder)) schema.navOrder = [];
['payees', 'payments'].forEach(key => {
  if (!schema.navOrder.includes(key)) {
    schema.navOrder.push(key);
    console.log(`Added "${key}" to the nav bar.`);
  }
});

fs.writeFileSync(SCHEMA_FILE, JSON.stringify(schema, null, 2));
console.log('\nDone. Restart the app (or it will pick this up on next request) and you should see Payees and Payments in the nav bar.');
