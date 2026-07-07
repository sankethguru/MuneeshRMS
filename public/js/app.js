// Muneesh Legacy — client-side niceties
document.addEventListener('keydown', function (e) {
  // "n" jumps to New Record when not typing in a field
  if (e.key === 'n' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    var newLink = document.querySelector('a[href$="/new/form"]');
    if (newLink) { window.location.href = newLink.getAttribute('href'); }
  }
});

function mlToggleFilterPanel() {
  var panel = document.getElementById('filterPanel');
  if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
}

// ---- Report builder: reorderable + addable rows -----------------------
// Unlike the admin reorder pattern elsewhere (which POSTs the new order
// immediately since it's reordering already-saved items), the report
// builder's Columns/Aggregates/Parameters rows aren't saved yet — they're
// just <input>s in a form. Reordering them is nothing more than changing
// DOM order: bracket-array fields (col_expr[], etc.) submit in DOM order
// naturally, so dragging a row and then clicking Save is enough. No
// server round-trip, no data-reorder-url, no item IDs needed.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof Sortable === 'undefined') return;
  document.querySelectorAll('table.reorderable-form tbody').forEach(function (tbody) {
    Sortable.create(tbody, { handle: '.drag-handle', animation: 140, ghostClass: 'row-dragging' });
  });
});

// Clones the last row in the given <tbody> (by id) and appends a blank
// copy — lets the report builder grow past its default 3 spare rows
// without a save-and-reopen round trip.
function mlAddReportRow(tbodyId) {
  var tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  var rows = tbody.querySelectorAll('tr');
  if (rows.length === 0) return;
  var clone = rows[rows.length - 1].cloneNode(true);
  clone.querySelectorAll('input[type="text"], input[type="number"]').forEach(function (el) { el.value = ''; });
  clone.querySelectorAll('select').forEach(function (el) { el.selectedIndex = 0; });
  tbody.appendChild(clone);
}

// ---- Expand/collapse for list applets --------------------------------
// Any list applet (main List screens and child-record tables on detail
// pages alike) renders all rows server-side but hides everything past the
// first ~12 behind a "row-collapsed" class. This just toggles visibility
// client-side — no extra request, since the rows are already there.
function mlToggleExpand(btn) {
  var table = document.getElementById(btn.getAttribute('data-target'));
  if (!table) return;
  var expanded = btn.getAttribute('data-expanded') === 'true';
  var rows = table.querySelectorAll('tbody tr.row-collapsed');
  rows.forEach(function (row) { row.style.display = expanded ? 'none' : ''; });
  btn.setAttribute('data-expanded', expanded ? 'false' : 'true');
  btn.textContent = expanded ? btn.getAttribute('data-more-label') : btn.getAttribute('data-less-label');
}

// ---- Idle session timeout warning ------------------------------------
// The server enforces the actual timeout (session cookie maxAge, reset on
// every request — see server.js). This is purely the client-side warning:
// track real activity (mouse/keyboard/touch, not just page loads), show a
// floating countdown in the last 10 seconds before the configured timeout,
// and ping a lightweight keepalive endpoint while genuinely active so the
// server-side session stays in sync with what the user actually
// experiences as "active."
(function () {
  var WARNING_SECONDS = 10;
  var PING_MIN_INTERVAL_MS = 30000;
  var timeoutMinutes = null;
  var lastActivity = Date.now();
  var lastPing = 0;
  var warningEl = null;
  var redirecting = false;

  function markActivity() {
    lastActivity = Date.now();
  }

  function showWarning(seconds) {
    if (!warningEl) {
      warningEl = document.createElement('div');
      warningEl.className = 'idle-warning';
      document.body.appendChild(warningEl);
    }
    warningEl.textContent = 'You will be automatically logged out due to inactivity in ' + seconds + '..';
  }

  function hideWarning() {
    if (warningEl) { warningEl.remove(); warningEl = null; }
  }

  function tick() {
    if (!timeoutMinutes || redirecting) return;
    var elapsed = Date.now() - lastActivity;
    var remaining = (timeoutMinutes * 60 * 1000) - elapsed;

    if (remaining <= 0) {
      redirecting = true;
      window.location.href = '/login';
      return;
    }
    if (remaining <= WARNING_SECONDS * 1000) {
      showWarning(Math.ceil(remaining / 1000));
    } else {
      hideWarning();
    }

    if (lastActivity > lastPing && (Date.now() - lastPing) > PING_MIN_INTERVAL_MS) {
      lastPing = Date.now();
      fetch('/api/keepalive', { method: 'POST' }).catch(function () { /* best effort */ });
    }
  }

  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(function (evt) {
    document.addEventListener(evt, markActivity, { passive: true });
  });

  document.addEventListener('DOMContentLoaded', function () {
    var minutesAttr = document.body.getAttribute('data-idle-timeout-minutes');
    if (!minutesAttr) return; // not set on pre-login pages — nothing to track
    timeoutMinutes = Number(minutesAttr);
    if (!timeoutMinutes || timeoutMinutes <= 0) return;
    setInterval(tick, 1000);
  });
})();

// ---- Drag-and-drop reordering ---------------------------------------------
// Any admin list-table that renders with class "reorderable" and has a
// data-reorder-url attribute becomes drag-and-droppable. Each row needs a
// data-item-id attribute (the field/entity key to reorder). On drop, we
// POST the new order as a JSON array to that URL and reload the page on
// success. Handles all four reorderable lists (Fields, List Columns,
// Filters, Nav) via one mechanism.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof Sortable === 'undefined') return;
  document.querySelectorAll('table.reorderable tbody').forEach(function (tbody) {
    var url = tbody.getAttribute('data-reorder-url');
    if (!url) return;
    Sortable.create(tbody, {
      handle: '.drag-handle',
      filter: '.row-not-draggable',
      preventOnFilter: false,
      animation: 140,
      ghostClass: 'row-dragging',
      onEnd: function () {
        var ids = Array.from(tbody.querySelectorAll('tr[data-item-id]'))
          .map(function (tr) { return tr.getAttribute('data-item-id'); });
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: ids }),
        }).then(function (res) {
          if (res.ok) location.reload();
          else alert('Reorder failed. Please try again.');
        }).catch(function () { alert('Reorder failed. Please try again.'); });
      },
    });
  });
});

// Indian-style currency formatting (₹x,xx,xxx.xx), mirrors schema.js formatINR
// so currency fields update live as the user types.
function mlFormatINR(value) {
  if (value === '' || value === null || value === undefined) return '';
  var num = Number(value);
  if (isNaN(num)) return '';
  var isNeg = num < 0;
  var fixed = Math.abs(num).toFixed(2);
  var pieces = fixed.split('.');
  var intPart = pieces[0];
  var dec = pieces[1];
  var lastThree = intPart.substring(intPart.length - 3);
  var other = intPart.substring(0, intPart.length - 3);
  if (other !== '') lastThree = ',' + lastThree;
  var formattedInt = other.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;
  return (isNeg ? '-' : '') + '\u20B9' + formattedInt + '.' + dec;
}

// Currency fields are a single box: shows the formatted ₹x,xx,xxx.xx value
// when not focused, and the raw editable number while typing. The actual
// numeric value that gets submitted lives in a paired hidden input.
function mlCurrencyFocus(name) {
  var hidden = document.getElementById('fld_' + name);
  var disp = document.getElementById('fld_' + name + '_disp');
  if (!hidden || !disp) return;
  disp.value = hidden.value !== '' && hidden.value !== null ? String(hidden.value) : '';
}

function mlCurrencySync(name) {
  var hidden = document.getElementById('fld_' + name);
  var disp = document.getElementById('fld_' + name + '_disp');
  if (!hidden || !disp) return;
  hidden.value = disp.value.replace(/[^0-9.\-]/g, '');
}

function mlCurrencyBlur(name) {
  mlCurrencySync(name);
  var hidden = document.getElementById('fld_' + name);
  var disp = document.getElementById('fld_' + name + '_disp');
  if (!hidden || !disp) return;
  disp.value = mlFormatINR(hidden.value);
}

// Percent fields: same single-box pattern as currency, but the box shows
// the human number (18) while editing and stores the fraction (0.18).
function mlFormatPercent(value) {
  if (value === '' || value === null || value === undefined) return '';
  var num = Number(value) * 100;
  if (isNaN(num)) return '';
  var rounded = Math.round(num * 100) / 100;
  return rounded + '%';
}

function mlPercentFocus(name) {
  var hidden = document.getElementById('fld_' + name);
  var disp = document.getElementById('fld_' + name + '_disp');
  if (!hidden || !disp) return;
  var raw = Number(hidden.value);
  disp.value = hidden.value !== '' && !isNaN(raw) ? String(Math.round(raw * 100 * 100) / 100) : '';
}

function mlPercentSync(name) {
  var hidden = document.getElementById('fld_' + name);
  var disp = document.getElementById('fld_' + name + '_disp');
  if (!hidden || !disp) return;
  var typed = disp.value.replace(/[^0-9.\-]/g, '');
  hidden.value = typed === '' ? '' : (Number(typed) / 100);
}

function mlPercentBlur(name) {
  mlPercentSync(name);
  var hidden = document.getElementById('fld_' + name);
  var disp = document.getElementById('fld_' + name + '_disp');
  if (!hidden || !disp) return;
  disp.value = mlFormatPercent(hidden.value);
}
