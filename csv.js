// csv.js
// Minimal CSV read/write — good enough for admin schema export/import,
// without pulling in a dependency. Handles quoted fields, escaped quotes
// (""), and commas/newlines inside quotes.

function stringifyRow(cells) {
  return cells.map(c => {
    const s = c === undefined || c === null ? '' : String(c);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

function stringify(rows) {
  return rows.map(stringifyRow).join('\r\n') + '\r\n';
}

// Returns an array of rows, each an array of string cells.
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
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

module.exports = { stringify, stringifyRow, parse };
