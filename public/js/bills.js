// public/js/bills.js
//
// Client for the Bills matrix page. Everything stateful lives here: which
// FY is shown, which month is open for entry, and the unsaved edits. The
// server owns all truth — this script only renders /bills/api/matrix and
// batches edits into one POST /bills/api/month/<month>.
//
// Entry ergonomics are the whole point of this page (the Excel habit being
// replaced was "type amounts straight down a month column"): the entry
// month's cells are inputs; Enter and ArrowDown/ArrowUp move down/up the
// column skipping locked cells, so a whole month can be keyed in without
// touching the mouse.

(function () {
  'use strict';

  var fySelect = document.getElementById('bills-fy');
  var monthSelect = document.getElementById('bills-entry-month');
  var saveBtn = document.getElementById('bills-save');
  var statusEl = document.getElementById('bills-status');
  var table = document.getElementById('bills-table');
  var canEdit = !!window.BILLS_CAN_EDIT;

  var matrix = null;          // last server response
  var dirty = {};             // itemCode -> raw input value (only touched cells)

  // ---- FY options: current FY ± 3 years, newest first ---------------------
  function currentFyStart() {
    var now = new Date();
    return (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  }
  function fyString(startYear) {
    return startYear + '-' + String((startYear + 1) % 100).padStart(2, '0');
  }
  (function populateFy() {
    var cur = currentFyStart();
    for (var y = cur + 1; y >= cur - 3; y--) {
      var opt = document.createElement('option');
      opt.value = fyString(y);
      opt.textContent = 'FY ' + fyString(y);
      if (y === cur) opt.selected = true;
      fySelect.appendChild(opt);
    }
  })();

  function monthLabel(ym) {
    var parts = ym.split('-');
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[Number(parts[1]) - 1] + ' ' + parts[0].slice(2);
  }

  var inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(n) { return n === 0 ? '' : '\u20B9' + inr.format(n); }

  // ---- Status line --------------------------------------------------------
  function setStatus(text, kind) {
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
    statusEl.className = 'bills-status' + (kind ? ' bills-status-' + kind : '');
  }

  function dirtyCount() { return Object.keys(dirty).length; }
  function refreshSaveButton() {
    if (!saveBtn) return;
    var n = dirtyCount();
    saveBtn.disabled = n === 0;
    saveBtn.textContent = n === 0 ? 'Save Month' : 'Save Month (' + n + ')';
  }

  // Warn before leaving with unsaved edits — same contract as the app's
  // record forms, which also refuse to lose typed work silently.
  window.addEventListener('beforeunload', function (e) {
    if (dirtyCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---- Rendering ----------------------------------------------------------
  function render() {
    var months = matrix.months;
    var entryMonth = canEdit ? monthSelect.value : null;
    var html = [];

    html.push('<thead><tr>');
    html.push('<th class="bills-col-item">Item</th><th class="bills-col-meta">Paid From</th><th class="bills-col-meta bills-col-due">Due</th>');
    months.forEach(function (mn) {
      var cls = mn === entryMonth ? ' class="bills-entry-col"' : '';
      html.push('<th' + cls + '>' + monthLabel(mn) + '</th>');
    });
    html.push('<th class="bills-col-total">Total</th></tr></thead><tbody>');

    if (matrix.categories.length === 0) {
      html.push('<tr><td class="bills-empty" colspan="' + (months.length + 4) + '">No expense items yet. Create some under <a href="/expense_items">Expense Items</a>, then enter amounts here.</td></tr>');
    }

    matrix.categories.forEach(function (cat) {
      html.push('<tr class="bills-cat-row"><td colspan="' + (months.length + 4) + '">' + esc(cat.name) + '</td></tr>');
      cat.items.forEach(function (it) {
        html.push('<tr' + (it.archived ? ' class="bills-archived"' : '') + '>');
        html.push('<td class="bills-col-item" title="' + esc(it.code) + '"><a href="/expense_items/' + encodeURIComponent(it.code) + '" style="color:inherit;text-decoration:none;" onmouseover="this.style.textDecoration=\'underline\'" onmouseout="this.style.textDecoration=\'none\'">' + esc(it.item) + '</a>' + (it.archived ? ' <span class="bills-archived-tag">(archived)</span>' : '') + '</td>');
        html.push('<td class="bills-col-meta">' + esc(it.paidFrom) + '</td>');
        html.push('<td class="bills-col-meta bills-col-due">' + esc(String(it.dueDay || '')) + '</td>');
        months.forEach(function (mn) {
          var cell = it.cells[mn];
          var isEntry = canEdit && mn === entryMonth && !it.archived;
          if (isEntry && cell && cell.split) {
            // Multiple raw rows behind one cell — locked here on purpose;
            // the server enforces the same rule (see bills.js).
            html.push('<td class="bills-cell bills-cell-split" title="Multiple entries — edit in Raw Entries"><a href="/expense_entries?f_EE_Item=' + encodeURIComponent(it.code) + '&f_EE_Month=' + encodeURIComponent(mn) + '">' + money(cell.amount) + ' \u2298</a></td>');
          } else if (isEntry) {
            var isDirty = it.code in dirty;
            var rawVal = isDirty ? dirty[it.code] : (cell ? String(cell.amount) : '');
            // A dirty cell (already edited, not yet saved) always shows its
            // exact raw typed value, never reformatted — mid-edit is not the
            // moment to dress a number up. An untouched cell shows the same
            // formatted currency text every other month column uses; focus
            // swaps it to the plain editable number (see wireInputs), blur
            // swaps it back, so the column only looks "input-like" for the
            // one cell actually being typed into, not the whole column at
            // rest.
            var displayVal = isDirty ? dirty[it.code] : (cell ? money(cell.amount) : '');
            html.push('<td class="bills-cell bills-entry-col"><input type="text" inputmode="decimal" data-item="' + esc(it.code) + '" data-raw="' + esc(rawVal) + '" value="' + esc(displayVal) + '"></td>');
          } else {
            html.push('<td class="bills-cell">' + (cell ? money(cell.amount) : '') + '</td>');
          }
        });
        html.push('<td class="bills-col-total">' + money(it.total) + '</td></tr>');
      });
      html.push('<tr class="bills-subtotal-row"><td colspan="3">' + esc(cat.name) + ' subtotal</td>');
      months.forEach(function (mn) { html.push('<td>' + money(cat.subtotals[mn]) + '</td>'); });
      html.push('<td>' + money(cat.total) + '</td></tr>');
    });

    if (matrix.categories.length > 0) {
      html.push('<tr class="bills-grand-row"><td colspan="3">Grand total</td>');
      months.forEach(function (mn) { html.push('<td>' + money(matrix.grand[mn]) + '</td>'); });
      html.push('<td>' + money(matrix.grandTotal) + '</td></tr>');
    }
    html.push('</tbody>');
    table.innerHTML = html.join('');
    wireInputs();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Entry column behavior ----------------------------------------------
  function wireInputs() {
    var inputs = Array.prototype.slice.call(table.querySelectorAll('input[data-item]'));
    inputs.forEach(function (inp, idx) {
      inp.addEventListener('input', function () {
        dirty[inp.dataset.item] = inp.value;
        refreshSaveButton();
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          var next = inputs[idx + 1];
          if (next) { next.focus(); next.select(); }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          var prev = inputs[idx - 1];
          if (prev) { prev.focus(); prev.select(); }
        }
      });
      // Formatted currency text (₹1,450.50) is for reading, not typing over —
      // swap to the plain raw number the instant a cell is actually focused
      // (by click or by the ArrowUp/ArrowDown navigation above, which fires
      // the same native focus event), and only swap back on blur if the
      // user didn't touch it — an already-dirty cell keeps showing exactly
      // what was typed, focused or not.
      inp.addEventListener('focus', function () {
        if (!(inp.dataset.item in dirty)) inp.value = inp.dataset.raw;
        inp.select();
      });
      inp.addEventListener('blur', function () {
        if (inp.dataset.item in dirty) return;
        var raw = inp.dataset.raw;
        inp.value = raw === '' ? '' : money(Number(raw));
      });
    });
  }

  // ---- Data flow ----------------------------------------------------------
  function load() {
    setStatus('Loading\u2026');
    fetch('/bills/api/matrix?fy=' + encodeURIComponent(fySelect.value), { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) { setStatus(res.body.error || 'Could not load the matrix.', 'error'); return; }
        matrix = res.body;
        if (canEdit) populateEntryMonths();
        setStatus('');
        render();
        refreshSaveButton();
      })
      .catch(function () { setStatus('Could not reach the server. Check your connection and refresh.', 'error'); });
  }

  function populateEntryMonths() {
    var prev = monthSelect.value;
    monthSelect.innerHTML = '';
    var now = new Date();
    var currentYm = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    matrix.months.forEach(function (mn) {
      var opt = document.createElement('option');
      opt.value = mn;
      opt.textContent = monthLabel(mn);
      monthSelect.appendChild(opt);
    });
    // Keep the user's chosen month across reloads of the same FY; default
    // to the real current month when it belongs to the shown FY, else the
    // FY's first month.
    if (prev && matrix.months.indexOf(prev) !== -1) monthSelect.value = prev;
    else if (matrix.months.indexOf(currentYm) !== -1) monthSelect.value = currentYm;
    else monthSelect.value = matrix.months[0];
  }

  function save() {
    if (dirtyCount() === 0) return;
    saveBtn.disabled = true;
    setStatus('Saving\u2026');
    fetch('/bills/api/month/' + encodeURIComponent(monthSelect.value), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ amounts: dirty }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) { setStatus(res.body.error || 'Save failed.', 'error'); refreshSaveButton(); return; }
        var b = res.body;
        var bits = [];
        if (b.created) bits.push(b.created + ' added');
        if (b.updated) bits.push(b.updated + ' changed');
        if (b.removed) bits.push(b.removed + ' cleared');
        var msg = bits.length ? 'Saved \u2014 ' + bits.join(', ') + '.' : 'Nothing to change.';
        if (b.errors && b.errors.length) {
          setStatus(msg + ' ' + b.errors.length + ' cell(s) not saved: ' + b.errors.join(' '), 'error');
        } else {
          setStatus(msg, 'ok');
        }
        dirty = {};
        load();
      })
      .catch(function () { setStatus('Could not reach the server \u2014 nothing was saved. Try again.', 'error'); refreshSaveButton(); });
  }

  function confirmDiscardEdits() {
    return dirtyCount() === 0 || window.confirm('Discard ' + dirtyCount() + ' unsaved cell(s)?');
  }

  fySelect.addEventListener('change', function () {
    if (!confirmDiscardEdits()) { return; }
    dirty = {};
    load();
  });
  if (canEdit) {
    monthSelect.addEventListener('change', function () {
      if (!confirmDiscardEdits()) { return; }
      dirty = {};
      render();
      refreshSaveButton();
    });
    saveBtn.addEventListener('click', save);
  }

  load();
})();
