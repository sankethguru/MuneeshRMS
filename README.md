# Muneesh Legacy

Rental & property management app, styled after a classic  enterprise
UI (masthead, screen tabs, thread bar, list/detail applets, beveled
toolbars). Fonts: **Cormorant Garamond** (headings/titles) + **DM Sans**
(body/UI).

The app is **self-sufficient**: tables, fields, field order, list columns,
lookups, applet titles, calculated fields, audit trails, and users/permissions
are all data (`data/schema.json`, `data/users.json`), not code. You manage
all of it from the **⚙ Admin** screen in the app itself.

## Login

First run creates one administrator account:

- **Username:** `admin`
- **Password:** `admin123`

You'll see a banner prompting you to change it under **My Account** — do
that first. Everything in the app requires login; unauthenticated requests
are redirected to `/login`.

## Screens (out of the box)

- **Home** — a blank landing page, reserved for whatever you want to put
  there later.
- **Landlords, Tenants, Banking, Property, Bills** — the original 5-table
  schema, fully wired with foreign keys and child "applet" lists.
- **Payees, Payments** — a UPI vendor/salary payment tracker with
  server-side QR code generation. See "PayQR: design notes" below for how
  it's built.
- **Reports** — a report-*building* tool, not fixed reports. See
  "Reports: design notes" below.

Each record's detail screen shows related child records below it,
generated automatically from whichever fields link to that table.

## Using the Admin screen

Click **⚙ Admin** (only visible to administrators). It's organized into
sub-tabs: **Tables**, **Views**, **Users**, **Audit Log**, **Backup**,
**Errors**, **PayQR Settings**, and **Session**.

- **Session** — sets the idle-timeout duration (in minutes, 1–180) that
  automatically signs everyone out after that much inactivity — no mouse
  movement, key presses, or clicks. Takes effect immediately for new
  requests, no restart needed. A floating warning counts down the last 10
  seconds before sign-out; any activity (including dismissing the
  warning) resets the clock. See "Idle session timeout" below for how
  this actually works under the hood.
- **Tables** (the main dashboard) — create tables, reorder screen tabs,
  and jump into a table's Fields or Settings.- **New Table / Fields** — create tables and columns at runtime, same as
  before. Field types now include:
  - **currency** — stored as a plain number, always displayed as
    `₹x,xx,xxx.xx` (Indian digit grouping). The record-form box shows the
    formatted value directly (e.g. `₹3,63,000.00`) and switches to a plain
    editable number while focused — one box, not a number field plus a
    separate preview. No increment/decrement spinner arrows on this or any
    plain number field.
  - **formula** — a read-only calculated field. Its Config box takes an
    expression referencing other field names on this table directly (e.g.
    `T_Invoice_Value * T_Share / 100`), a linked table via
    `tablename.FieldName` (e.g. `tenants.T_Invoice_Value`), quoted text
    (`"like this"`), infix `AND` / `OR` / `NOT` (write `=` for equality,
    it's converted automatically), and a small Excel-style function
    library: `IF, IFERROR, ISBLANK, ROUND, ROUNDUP, ROUNDDOWN, ABS, MIN,
    MAX, SUM, TODAY, YEAR, MONTH, DAY, DAYS, CONCAT, LEFT, RIGHT, MID, LEN,
    UPPER, LOWER, TRIM, FY, CURRENT_FY`. `FY(date)` returns an Indian
    financial-year label like `"2026-27"` (April–March); `FY("2025-26")`
    is a literal FY constant; `CURRENT_FY()` is today's.
  - **`LOOKUP("table", "condition", "returnField")`** — scans every row of
    a named table and returns one field from the single matching row. The
    condition can reference that table's own fields via `table.Field` and
    the calling record's fields by bare name — e.g.
    `LOOKUP("gst_calendar", "gst_calendar.GST_Month = MONTH(BILLS_BillDate) AND gst_calendar.GST_Year = YEAR(BILLS_BillDate)", "GST_Rate")`.
    Errors **visibly** (`#LOOKUP: no match`, `#LOOKUP: ambiguous (n rows)`,
    or `#REF: no such field "X" on tablekey` if the condition or return
    field references a name that's misspelled or doesn't exist)
    rather than guessing, so a missing calendar row, a data-entry
    duplicate, or a typo'd field name can't silently produce a wrong
    tax figure or an hour of confused debugging. This same "no such
    field" error also applies to plain cross-table formula references
    and rollup WHERE clauses, not just LOOKUP.
  - **Blank number/currency/percent fields act as 0 in arithmetic**
    (`+`/`-`/`*`/`/`), the standard spreadsheet convention — a blank cell
    contributes 0 to a sum. This matters more than it sounds: without it,
    a formula like `BILLS_RentRecd + BILLS_TDSDep + BILLS_GSTRecd` would
    silently fall back to plain JavaScript string concatenation the
    moment any ONE of those fields was blank (`5000 + ''` produces the
    *string* `"5000"`, and everything summed after that point
    concatenates as text instead of adding — `5000 + '' + 2000` is
    `"50002000"`, not `7000`). Depending on which field was blank and
    where it sat in the expression, a condition comparing that sum could
    look right by coincidence or be silently wrong — genuinely hard to
    catch by inspection. This coercion is scoped narrowly on purpose:
    only number/currency/percent-typed field references get it; a blank
    text field concatenated into a string still stays blank, not `"0"`.
  - **rollup** — aggregates a related table (one or two hops away — e.g. a
    Landlord summing Bills through Tenants) with `SUM/COUNT/AVG/MIN/MAX`
    and an optional WHERE expression. WHERE uses the same language as
    formulas: bare names refer to the row being aggregated,
    `parent.FieldName` refers back to the record the rollup lives on —
    e.g. `FY(BILLS_BillDate) = CURRENT_FY() AND BILLS_Total > parent.LL_CreditLimit`.
    The admin UI validates the hop chain at save time (rejects a "via"
    table that isn't actually a child of the one before it).
  - **percent** — stores the raw fraction (0.18), always displayed ×100
    with a % sign (18%). Type the whole number (18) and it converts
    automatically — same single-box edit behavior as currency.
  - **picklist** — a dropdown of admin-defined options. Config box takes
    a comma-separated list, e.g. `Active,Renewing,Expired,Terminated`.
  - **series** — an auto-numbered field scoped to a group, for cases like
    "each landlord gets their own continuous bill sequence." Config takes
    a group path (e.g. `BILLS_ClientCode.T_MappedTo` — this bill's
    tenant's landlord) and a tracker table/fields to store the running
    count in. The included **Bill Series** table (auto-linked under each
    Landlord's detail page) does exactly this for Bills out of the box:
    issue bills for Landlord A, they're numbered 1, 2, 3…; switch to
    Landlord B and its numbering starts independently at 1; go back to A
    and it continues right where it left off. The table's own primary key
    (`BILLS_BillNum`) stays a separate, always-unique internal ID — the
    per-landlord number is a second, human-facing field
    (`BILLS_SeriesNo`), since two different landlords can legitimately
    both have a "bill #1".
  - **textarea** — adjustable **height (rows)**, set per field in Config.
- **Views** — a dedicated admin sub-tab, separate from Fields, matching
  's split between a table's underlying fields (Business Component)
  and how a screen displays them (Applet/View). For each table, choose
  exactly which fields appear as List columns, their display order
  (independent of the field order used on the Detail form), and a default
  sort field/direction. New fields don't automatically appear in the list
  — add them here once created.
- **Layout fields** — **spacer** (blank, no label) and **section** (label
  becomes a full-width header) let you arrange or group fields on a busy
  Detail screen. Both are layout-only: no data, never saved, never in
  Views or CSV export/import.
- **Add/remove a table from the nav bar** — Admin → Tables now lists every
  table, including ones not on the main tab bar (like Bill Series, which
  is reached from a Landlord's page instead). Use the Nav button on any
  row to add or remove it from the tab bar at any time.
- **CSV export/import** — Admin → Tables → **Export CSV** downloads a
  blank template (header row only, real field names, excluding computed
  and layout fields) for a table. **Import CSV** uploads filled-in rows
  back in. Import only **creates** new records, matching by primary key —
  if any row's key already exists, or is duplicated within the file, the
  **entire import is cancelled** before anything is written (no partial
  imports). Leave the key blank on a row to auto-assign one, for tables
  with an auto-numbered primary key.
- **List filtering** — Admin → Views → Filters lets you offer a filter
  control for bool, picklist, lookup, date, number, currency, percent,
  text, and textarea fields (plus formula/rollup fields, which inherit
  their control from their own Format As setting). Bool/picklist/lookup
  get a dropdown, text/textarea get an exact-match box, and
  date/number/currency/percent get a from/to range — percent ranges are
  entered as whole numbers (10–20 for 10%–20%), matching how percent
  fields are entered and displayed everywhere else in the app, even
  though the value is stored internally as a raw fraction. On the List
  screen these live behind a collapsed **Filter** button; multiple
  filters stack together (AND), and combine with the Query search box the
  same way. Nothing is saved — it's plain URL parameters, so leaving the
  screen resets it.
- **Child applets, including indirect ones** — a record's detail page
  automatically lists related child records from any table with a lookup
  field pointing at it (e.g. a Landlord's page lists its Tenants). It now
  also surfaces **grandchild** relationships two hops away: Bills link to
  Tenants, which link to Landlords, so a Landlord's detail page shows a
  "Bills (via Landlord)" section listing every bill across all of that
  landlord's tenants — without Bills needing a direct link to Landlords.
  Skipped automatically if that table is already a direct child, so
  nothing shows up twice.
  - **textarea** — now has an adjustable **height (rows)**, set per field
    in its Config box.
- **Settings** (per table) — rename the screen/singular labels, set the
  **List Applet Title** and **Detail Applet Title** independently (leave
  blank to use the auto-generated default), choose a Display Field/Prefix,
  and toggle **Audit Trail**.
- **Audit Trail** — flip it on per table. Every create/update/delete on
  that table is logged (who, when, what changed) and shown two places: a
  **History** section at the bottom of each record, and the global
  **Admin → Audit Log** page.
- **Users** — create accounts, set passwords, and grant per-table
  Create/Read/Update/Delete permissions with checkboxes. Administrators
  bypass the matrix entirely (full access, including Admin). Standard
  users only see the screen tabs, buttons, and fields their permissions
  allow — read-only tables render with disabled inputs and no Save button;
  tables with no Read permission don't even show up in the nav.
- **Reorder tabs / Delete a table** — same as before.

Notes on limits (kept simple on purpose):
- Field *names* can't be renamed once created (only labels) — this avoids
  silently breaking existing data.
- Formula fields can reference ordinary fields on the same table, but not
  other formula fields (no recursion).
- Sessions are in-memory, so everyone is logged out if the container
  restarts — fine for a small team tool, not meant for multi-instance
  scaling. Set a real `SESSION_SECRET` env var in production.

## Run with Docker (recommended)

```bash
docker compose up -d --build
```

The app will be available at **http://localhost:2299**.

Data, schema, users, and the audit log are persisted in a named Docker
volume (`muneesh-legacy-data`), as JSON files inside the container:
`db.json`, `schema.json`, `users.json`, `audit.json` under `/app/data`.
All are created automatically on first run.

To reset everything (data, schema, and users), remove the volume:

```bash
docker compose down -v
```

### Without docker compose

```bash
docker build -t muneesh-legacy .
docker run -d --name muneesh-legacy -p 2299:2299 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v muneesh-legacy-data:/app/data muneesh-legacy
```

## Run locally (no Docker)

Requires Node.js 18+.

```bash
npm install
PORT=2299 npm start
```

## Record navigation (Prev/Next)

Every detail page has Previous/Next arrows (gold buttons, next to "Back to
List") that step through the table's records in its default sort order —
the same order the List screen uses. This is deliberately simple: it
doesn't try to preserve whatever Query/Filter was active on the list page
you arrived from, just cycles through every record in the table. Disabled
(grayed out, unclickable) at the first/last record.

> **A recurring EJS gotcha, documented here after hitting it twice**:
> `<%= %>` HTML-escapes its output, which is correct and desired for
> almost everything — but it means you can't use it to inject a raw HTML
> attribute like `<%= condition ? 'style="display:none"' : '' %>`, because
> the quotes get turned into `&#34;` and the browser silently ignores the
> resulting garbled attribute. Both the Expand-button feature and this
> Prev/Next feature shipped with exactly this bug on the first pass. The
> fix is always the same: keep the attribute's quotes as literal template
> text and interpolate only the unquoted value inside (`style="<%= cond ?
> 'display:none' : '' %>"`), or use a plain `<% if %>` scriptlet to emit
> the whole attribute conditionally rather than building it as a string.

## Project structure

```
server.js            Express app: auth, sessions, routes, formula/currency handling
schema.js             Load/save data/schema.json + mutation helpers, INR formatting, formula evaluator
default-schema.js     Seeds data/schema.json on first run (the 5 tables above, plus Payees/Payments)
migrate-payqr.js      One-time script to add Payees/Payments to an install that predates them
payqr.js               PayQR-specific backend: narration templates + QR generation, reads field mapping from Admin \u2192 PayQR Settings (see below)
reports.js              End-user Reports screen: runs admin-built report definitions from schema.json (see below) \u2014 fully schema-driven, no hardcoded field names
users.js               User accounts, bcrypt password hashing, permission checks
auth.js                 Login/permission middleware
audit.js                Append-only audit log (data/audit.json)
errorlog.js             Rolling server-crash log (data/logs/error.log), read by Admin → Errors
csv.js                  CSV parse/stringify used by Admin → Tables import/export
routes/admin.js          Admin screen routes (tables, fields, users, audit, backup, errors)
db.js                    Tiny JSON-file datastore for records (data/db.json), with a request-scoped read cache
seed.js                  Sample starter data
views/                   EJS templates (list.ejs, form.ejs, partials/, admin/, login.ejs, landing.ejs, account.ejs, 403.ejs)
public/css/style.css      S-classic theme
public/js/app.js          Client-side helpers (currency live-preview, drag-and-drop reorder, filter panel toggle, etc.)
```

## Idle session timeout

Configured in Admin → Session (1–180 minutes, default 30). Two things
worth understanding if you're touching this code:

**"N minutes of inactivity" means genuinely N minutes since the last real
activity, not N minutes since login.** This uses `express-session`'s
`rolling: true` option, which resends the session cookie with a reset
expiry on every request. Combined with reading the admin-configured
value fresh from `schema.json` on every request (rather than a static
value set once at server startup), changing the timeout in Admin takes
effect immediately for all new requests — no restart needed.

**Client-side activity tracking is separate from server-side enforcement,
and deliberately so.** The server only sees HTTP requests — it has no way
to know someone is actively reading a long form without submitting
anything. So the actual sign-out enforcement is server-side (the cookie
really does expire), but a small client-side script (`public/js/app.js`)
tracks real mouse/keyboard/touch activity, shows the countdown warning in
the last 10 seconds, and pings a lightweight `/api/keepalive` endpoint
(at most once every 30 seconds) while there's been genuine activity since
the last ping — keeping the server-side session in sync with what the
user actually experiences as "still here," rather than only resetting on
full page loads.

## Configurable child applets

By default, every fk relationship auto-creates a child applet on the
linked table's detail page — that's still the starting point, but it's
now editable under Admin → Views → Child Applets, per table:

- **Which applets show, and in what order** — both direct children (e.g.
  Tenants on a Landlord's page) and "grandchildren" two hops away (e.g.
  Bills on a Landlord's page, reached via Tenants). Existing installs see
  no change until this is actively edited — it auto-populates from
  whatever was already auto-discovered.
- **One predefined filter per applet** — set once by the admin (e.g.
  "only show *active* tenants under this landlord"), always applied, not
  an interactive control the end user sees or adjusts on the detail page
  itself (that's what the List-screen filters are for — see below). Same
  field-type restriction as List filters: bool, picklist, fk, or date
  fields only. A grandchild applet's filter is defined against the
  grandchild table's own fields, not the intermediate hop's.
- **Setting the filter is a two-step, fully server-rendered flow**:
  picking a field auto-submits and reloads the page, which then shows the
  correct value control for that field's actual type (Yes/No for bool,
  that field's own options for picklist, a record picker for fk, a
  from/to range for date). This avoids a subtler bug that a pure
  client-side approach would risk: pre-rendering multiple hidden
  value-selectors and toggling them with JS means every hidden one still
  gets submitted with the form unless carefully disabled — server-rendering
  only the one that's actually relevant sidesteps that entirely.
- **The same table can be added more than once, each with its own filter
  and label** — e.g. "Active Tenants" and "Inactive Tenants" as two
  separate boxes on a Landlord's page, both showing Tenants, each
  independently filtered. This applies to both direct children and
  grandchildren. Internally, an applet's identity is split into a
  **base key** (the relationship — `child:tenants:T_MappedTo`) and an
  **instance key** (`child:tenants:T_MappedTo#1`, `#2`, ...), since a
  relationship alone stopped being a unique identifier once duplicates
  became possible. The Available list in Admin stays clickable even
  after an applet's already been added, specifically so "Add" can be
  clicked again for a second, differently-configured copy. Deleting the
  underlying fk field removes every instance built on it, not just one —
  cleanup matches on the shared base key.

## Expand button on list applets

Every list applet (any box that lists records as rows — both the main
List screens like `/tenants` and the embedded child-record tables on a
detail page, e.g. "Tenants (via Landlord)") renders all matching rows
server-side, but hides everything past the first 12 behind a
`row-collapsed` CSS class and `display:none`. An "Show all N records"
button reveals them — pure client-side visibility toggle
(`mlToggleExpand` in `app.js`), no extra request, since the rows already
exist in the page. Each list applet on a page gets its own independent
expand state via a unique table `id`, since a single detail page can have
several child applets at once.

Submitting a new Query or Filter on the main List screens is a full page
reload, so the expanded/collapsed state naturally resets to collapsed for
the new result set — no special-casing needed for that interaction.

## Reports: design notes

Reports went through two builds. The first was two fixed, hand-coded
reports (GSTR Summary, Tenant Summary) with ~15 field names hardcoded
directly in a `reports.js` file — the same kind of hardcoding PayQR had
before it got a field-role-settings fix. That version was rolled back
once the inconsistency was raised, and rebuilt as what's actually here
now: **a report-building tool**, where reports are *data* in
`schema.json`, not code.

**A report definition is just a formula, several times over.** Every
report has: a base table, an optional condition (WHERE), either a list of
columns (detail mode) or a group-by expression plus aggregates (grouped
mode), and optional run-time parameters. Every one of those — a column,
the condition, the group-by key, an aggregate's input — is a plain
formula string, evaluated with the *exact same* `evalFormula()` the rest
of the app already uses for calculated fields and rollup WHERE clauses.
That includes cross-table dotted references (`tenants.T_Client_Name`)
and full arithmetic (`BILLS_Total - BILLS_RentRecd`) — no new expression
language, no new parser, and correspondingly, no hardcoded field names:
every reference is a string the admin typed into a form, editable any
time under Admin → Reports.

**Detail mode** produces one row per matching record. **Grouped mode**
buckets matching rows by a group-by expression and computes SUM / COUNT /
AVG / MIN / MAX aggregates per bucket — the same arithmetic rollup fields
already use, factored into one shared `aggregateValues()` helper so it
only lives in one place.

**Parameters** are the one genuinely new mechanism (everything else reuses
existing infrastructure) — a report can expose a live picker (Landlord,
Tenant, a date range, an amount range) that the person running the
report fills in, rather than a value fixed by whoever built the report.
A parameter's field type is resolved and locked in at *definition* time
(via `resolveExprField`), not guessed later from a runtime value, so its
filter control (dropdown, exact-match box, or from/to range) is always
statically known — the same reasoning `FILTERABLE_TYPES`/`filterKindFor`
already use for List and Child Applet filters.

**Permissions**: a report needs read permission on its own base table
only — not on every table its columns/parameters happen to reach via a
cross-table expression. Same simplification as the rolled-back version;
worth revisiting if this app ever serves genuinely separate customers
rather than one family.

**A deliberate, stated scope decision**: the List-filter and Child-Applet-
filter code each already have their own copy of "apply an exact-match or
range condition to a set of rows." Report parameters needed the same
logic and got their own third copy, written fresh in `runReport()`,
rather than a shared extraction across all three call sites. That
refactor is real and worth doing, but doing it as part of an
already-large build would have meant touching two other already-tested
features' code paths for marginal risk — flagged rather than silently
bundled in.

**Same routing gotcha as before, worth remembering**: `/reports` (a
single path segment) collides with the generic `/:entity` List-screen
route unless `reports.router` is mounted before it, not after — otherwise
Express treats "reports" as an unknown table and 404s it. Applied
correctly from the start this time, having hit it once already in the
rolled-back build — comment left in `server.js` at the mount point so
it's not rediscovered a third time in some future feature.

## PayQR: design notes

The Payees/Payments tables are a UPI payment tracker with server-side QR
generation. Two tables, one relationship:

- **Payees** — name, payment method, UPI ID / bank details, a narration
  template (e.g. `"Ambika Salary - {{PREV_MONTH}}"`), and two rollup
  fields — Last Paid Amount and Last Paid Date.
- **Payments** — date, payee (fk), amount, notes, and a formula field for
  the month. The fk to Payees means "Payments (via Payee)" shows up
  automatically as a child applet on each payee's detail page — no extra
  config needed.

**Last Paid Amount/Date use a `LATEST` rollup**, not `MAX`. `MAX` would
give you the *largest* payment ever made to that payee, which usually
isn't what "last paid" means. `LATEST` sorts the payee's payment rows by
a chosen date field and returns another field from whichever row sorts
first — so it's genuinely "the amount from the most recent payment," which
is what the payee's detail page actually shows.

Creating a Payment is also the moment the QR gets generated — there's no
separate "generate QR" step to remember, and no separate "log this
payment" step either. Notes get pre-filled from the payee's narration
template with `{{PREV_MONTH}}` resolved to last month's name, editable
before saving, and stored as plain text on the payment record — so
historical payments keep the note they were actually filed with even if
the payee's template changes later.

### Configuring PayQR's field mapping

Every other feature in this app — Fields, Views, Rollups, Filters, CSV
import/export, images, backup — reads table and field names from the live
`data/schema.json`. That's *why* the app is self-service from Admin:
rename a screen, add a field, reorder columns, and nothing in the code
needs to change.

**PayQR mostly follows this too, via Admin → PayQR Settings.** Generating
a UPI QR code needs a specific field's value — "the UPI ID," "the
amount" — so there's a settings page where you map each role to an actual
field:

- Payee UPI ID field
- Payee Payment Method field (optional — restricted to picklist fields; if set, a QR won't generate for a payee whose method doesn't look like "UPI," e.g. "Bank Account" — they'll see a message to pay manually instead. If left unset, this check is simply skipped, same as before this existed)
- Payee Narration Template field
- Payment Amount field (restricted to currency/number fields)
- Payment Notes field
- Payment Date field

Two roles aren't on that settings page at all, because they don't need to
be — they're already fully knowable from the schema without any new
configuration: **which field identifies a payee** is just `payees`'s
primary key, and **which field links a payment to its payee** is just
"whichever fk field on Payments points at Payees." Both are computed on
demand (`schema.payqrPayeePkField`, `schema.payqrPaymentToPayeeFkField`)
rather than stored as settings that could drift out of sync with the
actual schema.

**If a mapping is missing or a referenced field gets deleted**, PayQR
fails loudly — a clear `409` response pointing at Admin → PayQR
Settings — rather than guessing or silently doing nothing. Deleting a
field that's currently mapped to a PayQR role automatically clears that
mapping (so the next request explains what's wrong, instead of a
confusing 404 for a field that no longer exists).

**One thing that's still fixed, by design, not an oversight:** which
*tables* PayQR operates on. The settings page lets you remap *fields* on
Payees/Payments, but it doesn't let you point PayQR at a different pair
of tables entirely. `payqr.js` and one spot in `views/form.ejs`
(`entity.key === 'payments'`) still check for those literal table names.
Making the table choice itself configurable was judged a bigger change
than this feature needed — everything marked with a `###HARDCODED
FIELDS###` comment (`grep -rn "HARDCODED FIELDS" .`) is that one
remaining boundary, clearly isolated and easy to revisit if it's ever
worth doing.
