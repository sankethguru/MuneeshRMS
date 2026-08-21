// csv.js
// Minimal CSV read/write — good enough for admin schema export/import,
// without pulling in a dependency. Handles quoted fields, escaped quotes
// (""), and commas/newlines inside quotes.

function stringifyRow(cells) {
  return cells.map(c => {
    let s = c === undefined || c === null ? '' : String(c);
    // A cell starting with =, +, -, or @ executes as a formula when the
    // exported CSV is opened in Excel — prefixing it with a single quote
    // forces it to be treated as literal text instead. Checked on the
    // raw value before the existing quote-escaping below, since a
    // leading "'" doesn't itself introduce anything that needs quoting.
    // Deliberately skipped for a value that's actually just a clean
    // number (Number(s) parses cleanly) — a legitimate negative amount
    // like "-500" also starts with "-", and forcing it to display as
    // text in Excel would be a real usability regression for something
    // that was never a formula-injection risk in the first place.
    if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s;
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

function stringify(rows) {
  return rows.map(stringifyRow).join('\r\n') + '\r\n';
}

// Returns an array of rows, each an array of string cells. Throws a clear
// error (rather than silently swallowing everything after a stray quote
// into one runaway field) if the input ends with a quoted field still
// open — a mismatched/missing closing quote, which otherwise produces
// silently misaligned columns instead of an obvious failure.
function parse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, ''); // strip BOM if present

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (inQuotes) {
    const rowNum = rows.length + 1;
    throw new Error(`CSV parse error: an opening quote on or after row ${rowNum} is never closed — check for a stray " in the file.`);
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

module.exports = { stringify, stringifyRow, parse };
