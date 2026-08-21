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
  clone.querySelectorAll('input[type="checkbox"]').forEach(function (el) {
    el.checked = false;
    if (el.previousElementSibling && el.previousElementSibling.type === 'hidden') el.previousElementSibling.value = '0';
  });
  tbody.appendChild(clone);
}

// Removes the row containing the clicked button. Rows aren't saved data
// until the whole form submits, so this is just a DOM removal — no
// server call, same reasoning as mlAddReportRow above. Deleting down to
// zero rows in a section is fine; existing server-side validation (e.g.
// "add at least one column") already handles that case correctly.
function mlRemoveReportRow(button) {
  var row = button.closest('tr');
  if (row) row.remove();
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
      // Bug fixed here: this used to just navigate to /login directly.
      // But /login and the server-side session expiry are two entirely
      // separate clocks (the session cookie's own expiry resets on every
      // request via rolling:true, including this same script's own
      // keepalive pings) — they can easily drift out of sync with each
      // other and with this timer. If the server-side session happened
      // to still be valid at the exact moment this fired, landing on
      // /login just bounced straight back to Home (/login's own "already
      // logged in" check redirects there) — which is exactly "it just
      // goes to the Home screen" instead of actually logging out.
      // Posting to /logout first genuinely destroys the session
      // server-side (req.session.destroy), so there's nothing left to
      // bounce back to regardless of how the two clocks had drifted.
      fetch('/logout', { method: 'POST' }).catch(function () { /* best effort */ }).then(function () {
        window.location.href = '/login';
      });
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

  // Same reorder-then-POST behavior as above, but for a flat, non-table
  // container (e.g. the Admin subnav's row of tabs) — no drag handle
  // needed here, since SortableJS already distinguishes a plain click
  // (no movement) from an actual drag, so the tabs stay normally
  // clickable while also being draggable.
  document.querySelectorAll('.reorderable-list').forEach(function (container) {
    var url = container.getAttribute('data-reorder-url');
    if (!url) return;
    Sortable.create(container, {
      animation: 140,
      ghostClass: 'row-dragging',
      onEnd: function () {
        var ids = Array.from(container.querySelectorAll('[data-item-id]'))
          .map(function (el) { return el.getAttribute('data-item-id'); });
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: ids }),
        }).then(function (res) {
          if (!res.ok) alert('Reorder failed. Please try again.');
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

// Constrained picklist live filtering — a picklist field configured with
// a Constraint Field (Admin -> Fields, "Constrain by") narrows its
// options to only those matching a sibling field's current value, e.g.
// a Credit Cards picklist only showing cards where the Banking table's
// own Account Type matches this record's Account Type field. The server
// already renders the CORRECT initial state (matching options visible,
// others display:none) — this just keeps it correct as the constraining
// field changes live, without a page reload, since the whole point is
// letting someone pick Account Type first and immediately see a
// narrowed Card list.
document.addEventListener('DOMContentLoaded', function () {
  function refilterConstrainedPicklist(select) {
    var constrainingFieldId = select.getAttribute('data-constrained-by');
    var constrainingEl = document.getElementById(constrainingFieldId);
    var constraintValue = constrainingEl ? constrainingEl.value : '';
    var currentValueStillValid = !select.value; // blank is always "valid"
    Array.from(select.options).forEach(function (opt) {
      if (!opt.value) return; // the "— none —" placeholder always stays visible
      var matches = !constraintValue || opt.getAttribute('data-constraint') === constraintValue;
      opt.style.display = matches ? '' : 'none';
      if (matches && opt.value === select.value) currentValueStillValid = true;
    });
    // If the previously-selected option no longer matches the new
    // constraint, clear the selection rather than silently keep an
    // option selected that's now hidden and shouldn't be choosable.
    if (select.value && !currentValueStillValid) select.value = '';
  }

  document.querySelectorAll('select[data-constrained-by]').forEach(function (select) {
    var constrainingEl = document.getElementById(select.getAttribute('data-constrained-by'));
    if (constrainingEl) {
      constrainingEl.addEventListener('change', function () { refilterConstrainedPicklist(select); });
    }
    refilterConstrainedPicklist(select); // apply once on load too, as a consistency double-check
  });
});

// Dependent fk pickers — an fk field whose fkWhere condition references
// sibling fields (parent.X) is re-fetched from the server whenever one of
// those siblings changes, so e.g. the Tenant list re-narrows the moment the
// Landlord is changed. Static-only fkWhere constraints need nothing here:
// the server already filtered them for the initial render, and they don't
// depend on anything the user edits on this form. Arbitrary condition
// formulas can't be evaluated in the browser, so this asks the server
// (/:entity/fk-options/:field) with the current form values as context.
document.addEventListener('DOMContentLoaded', function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  document.querySelectorAll('select[data-fk-depends]').forEach(function (select) {
    var entityKey = select.getAttribute('data-fk-entity');
    var fieldName = select.getAttribute('data-fk-field');
    var dependsOn = (select.getAttribute('data-fk-depends') || '').split(',').filter(Boolean);
    function refresh() {
      var params = new URLSearchParams();
      document.querySelectorAll('.detail-form [name]').forEach(function (el) {
        if (!el.name) return;
        params.set(el.name, el.type === 'checkbox' ? (el.checked ? 'true' : '') : (el.value || ''));
      });
      fetch('/' + encodeURIComponent(entityKey) + '/fk-options/' + encodeURIComponent(fieldName) + '?' + params.toString(), { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var prev = select.value;
          var html = ['<option value="">\u2014 none \u2014</option>'];
          (data.options || []).forEach(function (o) {
            var sel = (String(o.value) === String(prev)) ? ' selected' : '';
            html.push('<option value="' + escapeHtml(o.value) + '"' + sel + '>' + escapeHtml(o.label) + '</option>');
          });
          select.innerHTML = html.join('');
          // If the previous choice is no longer offered under the new
          // constraint, the select falls back to the blank option — the
          // stale value isn't silently kept.
        })
        .catch(function () { /* leave existing options in place on error */ });
    }
    dependsOn.forEach(function (depName) {
      var el = document.getElementById('fld_' + depName);
      if (el) el.addEventListener('change', refresh);
    });
  });
});

// ---- Sidebar: whole-sidebar collapse, and per-group collapse --------------
// Whole-sidebar state is applied BEFORE this file even loads (see the
// inline script in partials/head.ejs) so there's no flash of the expanded
// sidebar on every page load — this function only needs to handle it
// changing after a click. Per-group state is restored here instead,
// on DOMContentLoaded: a brief settle of a group's schema-configured
// default before a user's own override applies is a much smaller, less
// jarring flash than the whole sidebar's width changing would be, and
// group keys are dynamic (vary per schema) so they can't be inlined the
// same way.
function mlToggleSidebar() {
  var collapsed = document.body.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('ml-sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) {}
}

function mlToggleGroup(key) {
  var group = document.querySelector('.side-group[data-group-key="' + key + '"]');
  if (!group) return;
  var collapsed = group.classList.toggle('collapsed');
  try { localStorage.setItem('ml-sidebar-group-' + key, collapsed ? '1' : '0'); } catch (e) {}
}

// Theme switch. The masthead button cycles through the available themes;
// each flips the data-theme attribute on <html> live — the stylesheet is
// variable-driven so the whole UI re-skins with no reload — and remembers
// the choice in localStorage. head.ejs re-applies it before first paint on
// the next load. 'siebel' is the default (no attribute). To add another
// theme later: add its key here and a matching html[data-theme="key"]
// block in style.css (and whitelist the key in head.ejs's init script).
var ML_THEMES = ['siebel', 'salesforce', 'coral'];
var ML_THEME_LABELS = { siebel: 'Classic', salesforce: 'Lightning', coral: 'Coral', custom: 'Custom' };

function mlCurrentTheme() {
  var t = document.documentElement.getAttribute('data-theme');
  if (t === 'custom') return 'custom';
  return (t && ML_THEMES.indexOf(t) !== -1) ? t : 'siebel';
}

// Injects the saved custom theme's colours/fonts as CSS custom properties,
// overriding the base theme's tokens. Called on every page load (if a
// custom theme is saved and active) and immediately when the user applies
// one from the Themes page. Takes 6 clear, distinct roles and derives the
// gradient/hover shades every OTHER theme also needs, rather than asking
// the person to pick a dozen near-identical colours themselves.
function mlApplyCustomThemeVars(theme) {
  var styleEl = document.getElementById('ml-custom-theme-vars');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'ml-custom-theme-vars';
    document.head.appendChild(styleEl);
  }
  var rules = [];
  if (theme.pageBg) { rules.push('--chrome-bg:' + theme.pageBg + ';'); rules.push('--chrome-bg-dark:' + mlDarken(theme.pageBg, 8) + ';'); }
  if (theme.cardBg) { rules.push('--panel-bg:' + theme.cardBg + ';'); rules.push('--white:' + theme.cardBg + ';'); }
  if (theme.header) {
    rules.push('--navy-1:' + theme.header + ';');
    rules.push('--navy-2:' + mlDarken(theme.header, 12) + ';');
    rules.push('--navy-3:' + mlDarken(theme.header, 8) + ';');
  }
  if (theme.accent) {
    rules.push('--gold:' + theme.accent + ';');
    rules.push('--gold-light:' + mlLighten(theme.accent, 15) + ';');
    rules.push('--link:' + theme.accent + ';');
  }
  if (theme.text) rules.push('--ink:' + theme.text + ';', '--ink-soft:' + mlLighten(theme.text, 25) + ';');
  if (theme.border) rules.push('--border-dark:' + theme.border + ';');
  var fontRules = [];
  if (theme.displayFont) fontRules.push('.masthead-brand .brand-name, .applet-title, .home-kpi-value{font-family:"' + theme.displayFont + '",serif !important;}');
  if (theme.bodyFont) fontRules.push('body,.btn,.list-table,.field-value input{font-family:"' + theme.bodyFont + '",sans-serif !important;}');
  styleEl.textContent = 'html[data-theme="custom"] {' + rules.join(' ') + '} ' + fontRules.join(' ');
  // Load the Google Fonts URL (or any @import-style URL) if given.
  if (theme.fontUrl) {
    var existing = document.getElementById('ml-custom-theme-font');
    if (existing) existing.remove();
    var link = document.createElement('link');
    link.id = 'ml-custom-theme-font';
    link.rel = 'stylesheet';
    link.href = theme.fontUrl;
    document.head.appendChild(link);
  }
}

function mlApplyTheme(name) {
  var root = document.documentElement;
  if (name === 'siebel') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', name);
  if (name === 'custom') {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('ml-custom-theme') || 'null'); } catch (e) {}
    if (saved) mlApplyCustomThemeVars(saved);
  }
  try { localStorage.setItem('ml-theme', name); } catch (e) {}
  mlSyncThemeLabel();
}

function mlToggleTheme() {
  var i = ML_THEMES.indexOf(mlCurrentTheme());
  mlApplyTheme(ML_THEMES[(i + 1) % ML_THEMES.length]);
}

// The masthead button shows the CURRENTLY ACTIVE theme's name.
function mlSyncThemeLabel() {
  var label = document.getElementById('mlThemeLabel');
  if (label) label.textContent = ML_THEME_LABELS[mlCurrentTheme()];
}

document.addEventListener('DOMContentLoaded', function () {
  mlSyncThemeLabel();
  document.querySelectorAll('.side-group').forEach(function (group) {
    var key = group.getAttribute('data-group-key');
    var stored = null;
    try { stored = localStorage.getItem('ml-sidebar-group-' + key); } catch (e) {}
    // A stored '1'/'0' always wins (the user explicitly toggled it before);
    // with nothing stored yet, the schema's own collapsedByDefault (already
    // reflected in whether the server rendered the "collapsed" class) is
    // left exactly as rendered — nothing to do.
    if (stored === '1') group.classList.add('collapsed');
    else if (stored === '0') group.classList.remove('collapsed');
  });
});

// ---- Email compose / preview modal (record-detail "send email" buttons) ----
// A button per email template resolves the template against this record on
// the server (merge tags -> concrete To/Subject/Body), shows an editable
// draft + live preview, and posts back to send. Nothing is hardcoded — the
// buttons come from whatever email templates an admin bound to this entity.
var mlEmailCtx = null;
function mlEmailCompose(entityKey, encId, tplKey) {
  mlEmailCtx = { entityKey: entityKey, id: encId, tpl: tplKey };
  var banner = document.getElementById('mlEmailBanner');
  document.getElementById('mlEmailStatus').textContent = '';
  banner.style.display = 'none';
  document.getElementById('mlEmailSendBtn').disabled = false;
  fetch('/' + encodeURIComponent(entityKey) + '/' + encId + '/email/' + encodeURIComponent(tplKey) + '/preview', { headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok || !res.j.ok) { alert((res.j && res.j.error) || 'Could not prepare the email.'); return; }
      var j = res.j;
      document.getElementById('mlEmailTitle').textContent = j.label || 'Send email';
      document.getElementById('mlEmailTo').value = j.to || '';
      document.getElementById('mlEmailCc').value = j.cc || '';
      document.getElementById('mlEmailBcc').value = j.bcc || '';
      document.getElementById('mlEmailSubject').value = j.subject || '';
      document.getElementById('mlEmailBody').value = j.html || '';
      mlEmailSyncPreview();
      if (!j.configured) {
        banner.textContent = 'Email isn\u2019t configured yet \u2014 set SMTP details in Admin \u2192 Email Settings before sending.';
        banner.style.display = 'block';
        document.getElementById('mlEmailSendBtn').disabled = true;
      }
      document.getElementById('mlEmailModal').style.display = 'flex';
    })
    .catch(function () { alert('Could not reach the server to prepare the email.'); });
}
function mlEmailSyncPreview() {
  document.getElementById('mlEmailPreview').innerHTML = document.getElementById('mlEmailBody').value || '';
}
function mlEmailClose() { document.getElementById('mlEmailModal').style.display = 'none'; mlEmailCtx = null; }
function mlEmailSend() {
  if (!mlEmailCtx) return;
  var btn = document.getElementById('mlEmailSendBtn');
  var status = document.getElementById('mlEmailStatus');
  btn.disabled = true; status.textContent = 'Sending\u2026';
  var payload = new URLSearchParams();
  ['To', 'Cc', 'Bcc', 'Subject'].forEach(function (f) { payload.set(f.toLowerCase(), document.getElementById('mlEmail' + f).value); });
  payload.set('html', document.getElementById('mlEmailBody').value);
  fetch('/' + encodeURIComponent(mlEmailCtx.entityKey) + '/' + mlEmailCtx.id + '/email/' + encodeURIComponent(mlEmailCtx.tpl) + '/send', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: payload.toString(),
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (res.ok && res.j.ok) { status.textContent = '\u2713 Sent.'; setTimeout(mlEmailClose, 900); }
      else { status.textContent = '\u2717 ' + ((res.j && res.j.error) || 'Send failed.'); btn.disabled = false; }
    })
    .catch(function () { status.textContent = '\u2717 Could not reach the server.'; btn.disabled = false; });
}

// ---- Screen list applet: client-side search (filters visible rows) ----
document.querySelectorAll('.screen-list-search').forEach(function(input) {
  input.addEventListener('input', function() {
    var q = (this.value || '').toLowerCase();
    var shell = this.closest('.applet-shell');
    if (!shell) return;
    shell.querySelectorAll('.list-table tbody .data-row').forEach(function(row) {
      var text = row.textContent.toLowerCase();
      row.style.display = q && text.indexOf(q) === -1 ? 'none' : '';
    });
  });
});

// ---- FK info-on-select: after choosing an fk value, fetch and show the
// referenced record's computed/rollup fields as a read-only hint below the
// picker. Generic: works for any fk field. The info is fetched from a new
// GET /:entity/:id/peek endpoint that returns a summary of computed fields.
document.querySelectorAll('select[data-fk-ref]').forEach(function(sel) {
  sel.addEventListener('change', function() {
    var ref = this.getAttribute('data-fk-ref');
    var val = this.value;
    var infoDiv = this.parentElement.querySelector('.fk-peek-info');
    if (!infoDiv) { infoDiv = document.createElement('div'); infoDiv.className = 'fk-peek-info'; this.parentElement.appendChild(infoDiv); }
    if (!val || !ref) { infoDiv.innerHTML = ''; return; }
    fetch('/' + encodeURIComponent(ref) + '/' + encodeURIComponent(val) + '/peek', { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j.ok || !j.fields || !j.fields.length) { infoDiv.innerHTML = ''; return; }
        infoDiv.innerHTML = j.fields.map(function(f) { return '<span class="fk-peek-field"><strong>' + f.label + ':</strong> ' + (f.display || '\u2014') + '</span>'; }).join(' ');
      })
      .catch(function() { infoDiv.innerHTML = ''; });
  });
});

// ---- Custom HSV colour picker (canvas-based; deliberately NOT the native
// <input type=color> OS picker, so it looks/behaves the same everywhere and
// stays visually inside the app). One instance per swatch button; each
// tracks its own H/S/V state and calls onChange(hex) live while dragging.
function mlHsvToHex(h, s, v) {
  s /= 100; v /= 100;
  var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r, g, b;
  if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  var toHex = function (n) { var v2 = Math.round((n + m) * 255); return v2.toString(16).padStart(2, '0'); };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
function mlHexToHsv(hex) {
  hex = (hex || '#888888').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
  var r = parseInt(hex.substr(0, 2), 16) / 255, g = parseInt(hex.substr(2, 2), 16) / 255, b = parseInt(hex.substr(4, 2), 16) / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  var s = max === 0 ? 0 : d / max;
  return { h: h, s: s * 100, v: max * 100 };
}
function mlColorPicker(swatchEl, hexInputEl, panelEl, initialHex, onChange) {
  var state = mlHexToHsv(initialHex || '#888888');
  var svWrap = panelEl.querySelector('.ml-cp-sv-wrap');
  var svCanvas = svWrap.querySelector('canvas');
  var svCursor = svWrap.querySelector('.ml-cp-sv-cursor');
  var hueWrap = panelEl.querySelector('.ml-cp-hue-wrap');
  var hueCanvas = hueWrap.querySelector('canvas');
  var hueCursor = hueWrap.querySelector('.ml-cp-hue-cursor');
  var W = 196, H = 140, HUEH = 16;
  svCanvas.width = W; svCanvas.height = H;
  hueCanvas.width = W; hueCanvas.height = HUEH;
  var svCtx = svCanvas.getContext('2d');
  var hueCtx = hueCanvas.getContext('2d');

  function drawHue() {
    var grad = hueCtx.createLinearGradient(0, 0, W, 0);
    for (var i = 0; i <= 6; i++) grad.addColorStop(i / 6, mlHsvToHex(i * 60, 100, 100));
    hueCtx.fillStyle = grad;
    hueCtx.fillRect(0, 0, W, HUEH);
  }
  function drawSv() {
    var hueColor = mlHsvToHex(state.h, 100, 100);
    var satGrad = svCtx.createLinearGradient(0, 0, W, 0);
    satGrad.addColorStop(0, '#fff'); satGrad.addColorStop(1, hueColor);
    svCtx.fillStyle = satGrad; svCtx.fillRect(0, 0, W, H);
    var valGrad = svCtx.createLinearGradient(0, 0, 0, H);
    valGrad.addColorStop(0, 'rgba(0,0,0,0)'); valGrad.addColorStop(1, '#000');
    svCtx.fillStyle = valGrad; svCtx.fillRect(0, 0, W, H);
  }
  function syncCursors() {
    svCursor.style.left = (state.s / 100 * W) + 'px';
    svCursor.style.top = (H - state.v / 100 * H) + 'px';
    hueCursor.style.left = (state.h / 360 * W) + 'px';
  }
  function currentHex() { return mlHsvToHex(state.h, state.s, state.v); }
  function commit(fromDrag) {
    var hex = currentHex();
    swatchEl.style.background = hex;
    hexInputEl.value = hex;
    syncCursors();
    onChange(hex);
  }
  function pointerDrag(el, move) {
    function handler(ev) {
      var rect = el.getBoundingClientRect();
      var clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      var clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      move(Math.max(0, Math.min(rect.width, clientX - rect.left)), Math.max(0, Math.min(rect.height, clientY - rect.top)));
    }
    el.addEventListener('mousedown', function (ev) {
      handler(ev);
      function onMove(e) { handler(e); }
      function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  pointerDrag(svWrap, function (x, y) { state.s = x / W * 100; state.v = (1 - y / H) * 100; drawSv(); commit(true); });
  pointerDrag(hueWrap, function (x) { state.h = x / W * 360; drawSv(); commit(true); });

  hexInputEl.addEventListener('change', function () {
    var v = hexInputEl.value.trim();
    if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) return;
    if (v[0] !== '#') v = '#' + v;
    state = mlHexToHsv(v);
    drawSv(); commit(false);
  });

  drawHue(); drawSv(); syncCursors();
  swatchEl.style.background = currentHex();
  hexInputEl.value = currentHex();

  swatchEl.addEventListener('click', function (ev) {
    ev.stopPropagation();
    document.querySelectorAll('.ml-cp-panel.open').forEach(function (p) { if (p !== panelEl) p.classList.remove('open'); });
    panelEl.classList.toggle('open');
  });
  document.addEventListener('click', function (ev) {
    if (!panelEl.contains(ev.target) && ev.target !== swatchEl) panelEl.classList.remove('open');
  });
  var closeBtn = panelEl.querySelector('.ml-cp-close');
  if (closeBtn) closeBtn.addEventListener('click', function () { panelEl.classList.remove('open'); });

  return { setHex: function (hex) { state = mlHexToHsv(hex); drawSv(); commit(false); }, getHex: currentHex };
}

// Small helpers for deriving related shades (gradient stops, hover states)
// from one chosen colour, so the custom-theme picker only needs to ask for
// a handful of clearly-distinct roles instead of every CSS variable. Plain
// RGB-channel scaling (not a full HSV round-trip) — deliberately simple so
// the identical logic can be duplicated inline in head.ejs's pre-paint
// script (which runs before this file loads) with guaranteed matching output.
function mlHexToRgb(hex) {
  hex = (hex || '#888888').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
  return { r: parseInt(hex.substr(0, 2), 16), g: parseInt(hex.substr(2, 2), 16), b: parseInt(hex.substr(4, 2), 16) };
}
function mlRgbToHex(r, g, b) {
  var toHex = function (n) { return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0'); };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
function mlDarken(hex, pct) {
  var c = mlHexToRgb(hex), f = 1 - pct / 100;
  return mlRgbToHex(c.r * f, c.g * f, c.b * f);
}
function mlLighten(hex, pct) {
  var c = mlHexToRgb(hex), f = pct / 100;
  return mlRgbToHex(c.r + (255 - c.r) * f, c.g + (255 - c.g) * f, c.b + (255 - c.b) * f);
}
