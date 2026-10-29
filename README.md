# Primark Event Registration

Registration and administration software for the Primark Carton Nomination Program. The current application collects attendee details, enforces supplier/factory seat limits, stores optional photos, provides an admin dashboard, and exports registration data to Excel.

The repository includes registration, online mobile scanning, attendance reporting, and test/demo tooling. Offline scanning remains a future enhancement.

## Current status

### Implemented

- Public registration for supplier, factory, and other attendees.
- Maximum two attendees charged to each supplier and one to each factory.
- Required contact details and designation; optional JPEG/PNG photo up to 1 MiB.
- Duplicate-email prevention and transactional seat enforcement.
- Admin dashboard, charts, filters, editing, deletion, Excel export, and QR generation.
- Pending organisation approval and merge operations.
- Optional confirmation email through a Power Automate webhook.
- Canonical supplier/factory import.
- Maintenance mode and abandoned-photo cleanup.
- Unit, API, and database tests.
- Event/day records, event-scoped registration snapshots, revocable QR credential history, and per-day attendance constraints.
- Guarded realistic demo-data generation for scanner development.
- Mobile-first admin scanner with camera/image scanning and manual fallback-code entry.
- Immediate identity/photo verification, duplicate detection, and per-day attendance recording.
- Stable per-attendee QR codes with individual view/download and multi-select or bulk PDF printing.
- Public QR verification showing the attendee photo, name, designation, supplier/factory or other organisation, email, and attending side.
- Attendance dashboard, live refresh, and day-specific Excel export.

### Not implemented

- Offline roster, scanning, or synchronization.
- Installable Progressive Web App.
- Individual administrator/scanner accounts; the requested simple setup uses one shared admin login.

## Architecture

The application is an API-driven modular monolith. This remains the recommended architecture for attendance work; microservices are unnecessary.

```text
Public registration page ─┐
Admin dashboard ──────────┼──► Node.js 24 / Express 5 ───► Supabase PostgreSQL
Mobile scanner ───────────┘                └─────────────► Supabase Storage
```

Express is the only Supabase client. The browser never receives the secret key. PostgreSQL functions handle multi-step registration and admin changes transactionally.

| Layer | Technology |
|---|---|
| Runtime/API | Node.js 24, Express 5 |
| Frontend | Plain HTML, CSS, JavaScript modules |
| Database/storage | Supabase PostgreSQL and private Storage |
| Database client | `@supabase/supabase-js` |
| Export | ExcelJS |
| Camera scanner | html5-qrcode (served locally) |
| Tests | Node test runner, Supertest |
| Optional email | Power Automate webhook |

There is no frontend build step. The scanner library is served from the installed npm package; some dashboard libraries/fonts still load from CDNs.

## Repository structure

```text
public/
  index.html                 Public registration
  admin.html                 Admin dashboard
  scanner.html               Mobile attendance scanner
  maintenance.html           Maintenance page
  styles.css                 Shared styles
  brand/                     Logos and icons
  js/                        Page controllers, forms, charts, API helper
  shared/                    Validation, constants, filters, form/chart logic
src/
  create-app.js              Express composition and error boundary
  config.js                  Environment validation
  db.js                      Supabase/query helpers
  auth.js                    Admin cookie signing/verification
  errors.js                  Stable API error mapping
  routes/                    Public, photo, and admin endpoints
  services/                  Dashboard, attendance, export, import, notification, photos
supabase/migrations/         Ordered migrations 001–016
scripts/
  apply-migration.js         Apply named SQL migrations through DATABASE_URL
  import-orgs.js             Organisation import entry point
  data/*.psv                 Canonical supplier/factory data
tests/
  unit/                      Dependency-free/service tests
  api/                       Express endpoint tests
  db/                        Disposable-Supabase tests
  helpers/                   Fakes and fixtures
server.js                    Runtime entry point
Dockerfile
docker-compose.yml
```

## Current application flows

### Registration

1. Browser downloads the approved organisation catalogue.
2. Attendee completes contact, designation, type, and organisation fields.
3. An optional photo is uploaded first; the API checks MIME type, binary signature, and size.
4. Shared validation runs in browser and server.
5. Express calls `public.register_attendee`.
6. PostgreSQL validates organisations, locks affected rows, checks capacity, and inserts the attendee and links in one transaction.
7. API returns the attendee UUID.
8. Confirmation data is optionally sent to Power Automate. Notification failure never rolls back registration.

### Seat accounting

A relationship consumes a seat only when the attendee's `from_type` matches the organisation's `kind`.

| Attendee type | Requirement | Seat limit |
|---|---|---:|
| Supplier | At least one supplier | 2 per supplier |
| Factory | At least one factory | 1 per factory |
| Other | No supplier/factory links | None |

Organisation rows are locked in stable ID order before capacity checks, preventing concurrent requests from both taking the last seat.

### Admin

Authenticated administrators can view summaries, filter participants, add attendees without public seat limits, edit/delete attendees, view private photos, approve/merge organisations, and export Excel data with embedded QR images in the Participants sheet.

The Participants tab can view or download an individual's plain QR code, download selected/all QR codes as a one-QR-per-page PDF, or download all QR PNGs in a ZIP named by participant and company. Once issued, an attendee's opaque QR credential is reused. Editing attendee details changes the verified profile without changing the QR.

### Photos

- Private bucket: `attendee-photos`.
- JPEG/PNG only, maximum 1 MiB.
- Random UUID object names.
- Unattached uploads are removed after two hours by the standalone Node worker.
- Replaced/deleted photos are removed on a best-effort basis after database success.
- The cleanup worker does not run when `VERCEL` is set.

## Current database model

```text
organisations 1 ─────< attendee_orgs >───── 1 attendees
```

### `public.organisations`

Supplier/factory catalogue: bigint identity `id`, `kind`, display `name`, normalized generated `match_key`, source-list `code`, `source`, `status`, and timestamp.

### `public.attendees`

Current event attendee/registration: UUID `id`, name, email, phone, designation, `from_type`, optional other `organisation_name`, optional `photo_path`, and timestamps.

Email is globally unique today. This suits one event but must become event-scoped before recurring events are supported.

### `public.attendee_orgs`

Many-to-many attendee/organisation links. `(attendee_id, org_id)` is the primary key; `code` snapshots the organisation code at registration time.

### `public.org_status`

Security-invoker view calculating seat use and link count.

### Permissions and migrations

RLS is enabled. `anon` and `authenticated` have no application-table access; only `service_role` receives table/RPC permissions.

Apply migrations numerically. Never edit an applied migration. Every database change must use the next numbered migration.

## Current HTTP API

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/organisations` | Approved catalogue and full-seat registrants |
| `POST` | `/api/photos` | Upload validated JPEG/PNG |
| `POST` | `/api/register` | Validate and register attendee |
| `POST` | `/api/attendee-profile` | Verify an active QR credential and return its public attendee profile |
| `POST` | `/api/attendee-profile/photo` | Verify the credential again and stream its private attendee photo |

For full organisations, the public catalogue exposes only registrant name/designation by design.

### Authentication and admin

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/login` | Start signed admin session |
| `POST` | `/api/admin/logout` | Clear session |
| `GET` | `/api/admin/data` | Dashboard data |
| `GET` | `/api/admin/export` | Excel export with participant QR images |
| `GET` | `/api/admin/qr-events` | Events available for QR generation |
| `GET` | `/api/admin/events/:id/qr-registrations` | Confirmed attendees available for QR generation |
| `POST` | `/api/admin/events/:id/qr.png` | View or download one attendee QR as PNG |
| `POST` | `/api/admin/events/:id/qrs.pdf` | Generate selected or all QR codes as PDF |
| `POST` | `/api/admin/events/:id/qrs.zip` | Generate all QR codes as named PNGs in a ZIP |
| `GET` | `/api/admin/attendance-days` | Event/day choices for scanner and dashboard |
| `POST` | `/api/admin/attendance/check-in` | Verify QR/fallback and record attendance |
| `GET` | `/api/admin/attendance?event_day_id=…` | Day roster and attendance summary |
| `GET` | `/api/admin/attendance/export?event_day_id=…` | Day-specific Excel export |
| `GET` | `/api/admin/participants/:id/photo` | Private photo |
| `POST` | `/api/admin/participants` | Add a participant without public seat limits |
| `PUT` | `/api/admin/participants/:id` | Update participant |
| `DELETE` | `/api/admin/participants/:id` | Delete participant |
| `POST` | `/api/admin/organisations/:id/approve` | Approve pending organisation |
| `POST` | `/api/admin/organisations/:id/merge` | Merge pending organisation |

Admin cookies are HTTP-only, `SameSite=Strict`, valid for 12 hours, and `Secure` in production.

## Configuration

Copy `.env.example` to `.env`.

| Variable | Required | Purpose |
|---|---:|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Server-only secret key |
| `DATABASE_URL` | For migrations | Supabase direct/session-pooler PostgreSQL URL |
| `ADMIN_PASSWORD` | Yes | Shared admin password |
| `SESSION_SECRET` | Yes | At least 32 characters; signs cookies |
| `EVENT_TITLE` | Yes | Interface event subtitle |
| `MAINTENANCE_MODE` | No | `true/1/yes/on` enables maintenance |
| `POWER_AUTOMATE_WEBHOOK_URL` | No | Confirmation webhook |
| `PORT` | No | HTTP port; default 3000 |
| `NODE_ENV` | No | Set to `production` behind HTTPS |
| `HTTPS_KEY_PATH` | No | Local trusted HTTPS private-key path; set with certificate |
| `HTTPS_CERT_PATH` | No | Local trusted HTTPS certificate path; set with key |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

The current event configuration is fragmented: subtitle comes from `EVENT_TITLE`; notification name/date/time are constants in `src/services/notify.js`; timezone is in `public/shared/constants.js`. Planned event tables will replace these scattered values.

Never commit `.env`, secret keys, webhook URLs, database exports, or attendee data.

## Local development

Requirements: Node.js 24, a development Supabase project, and migrations `001–016`.

```bash
npm install
cp .env.example .env
# Fill in .env
npm run dev
```

- Registration: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin`
- Scanner: `http://localhost:3000/scanner`
- Public attendee verification: `http://localhost:3000/verify.html#ER1.example-token`
- Maintenance: `http://localhost:3000/maintenance`

Generated QR codes contain `https://YOUR_HOST/verify.html#<opaque-credential>`. A phone camera opens the mobile verification page without an admin login and shows the current photo, name, designation, supplier/factory or other organisation, email, and attending side. The fragment is submitted to a read-only endpoint and is not included in the initial HTTP request or referrer. The authenticated staff scanner understands the same URL and performs check-in separately.

```bash
npm run dev
npm start
npm run test:unit
npm test
npm run import-orgs
npm run seed:demo
npm run db:apply -- 009_attendance_scanner_details.sql
npm run smoke:attendance
npm run backup
```

### Android testing

For basic page/manual-code testing on the same Wi-Fi, run the server and open `http://YOUR-PC-LAN-IP:3000/scanner.html` on Android. Allow inbound TCP port 3000 in Windows Firewall if prompted. Find the PC address with `ipconfig` (usually an `IPv4 Address` such as `192.168.1.20`).

Phone camera access requires a secure context. `localhost` is trusted only on the machine running the browser; a phone opening a PC's plain `http://192.168…` address is not. For real camera testing, deploy behind HTTPS or use a trusted local HTTPS certificate. The image-file and manual-code fallbacks remain available when live camera access is unavailable.

The standalone server supports local HTTPS. Create a certificate containing the PC's LAN address, trust its issuing CA on the Android device, and set both paths before starting:

```env
HTTPS_KEY_PATH=certs/local-key.pem
HTTPS_CERT_PATH=certs/local-cert.pem
```

It will then report `Listening on https://localhost:3000`; open `https://YOUR-PC-LAN-IP:3000/scanner.html`. A self-signed certificate that Android does not trust is not sufficient for dependable camera permission. For event use, a normal HTTPS deployment is simpler and safer.

Pushing to GitHub stores the source but does not run this Node/Express application. GitHub Pages is unsuitable because it cannot run the server or safely hold `SUPABASE_SECRET_KEY`. Connect the repository to a Node host such as Render, Railway, or Fly.io (or another HTTPS Node host), set the environment variables there, use `npm ci` as the build command and `npm start` as the start command. The resulting HTTPS `/scanner.html` URL works on Android.

## Recovery backups

`npm run backup` creates a timestamped directory under `backups/` containing:

- `database.sql` with the ordered migrations, application rows, and identity-sequence repair.
- Every object from the private `attendee-photos` bucket, preserving its object path.
- `manifest.json` with the source host, migration list, row counts, object count, sizes, and SHA-256 hashes.
- `checksums.sha256` for verifying the complete bundle after copying it elsewhere.

The command fails if an attendee references a photo that is absent from Storage. Backup directories and legacy `db-*.sql` exports are ignored by Git and Docker. They still contain personal data and are not encrypted; move completed bundles to encrypted storage outside the repository.

```bash
npm run backup
npm run backup:verify -- "backups/backup-2026-10-13T12-00-00Z"
```

Restore only into a new, empty Supabase project:

1. Verify the bundle with `npm run backup:verify -- "path/to/backup"`.
2. Run `database.sql` in the new project's SQL editor.
3. Point `.env` at the new project and run `npm run restore:storage -- "path/to/backup"`.
4. Compare database row counts and Storage object count with `manifest.json`.
5. Run the registration, admin, photo, edit, delete, and export smoke tests.

Storage restore refuses to target the source Supabase hostname and does not overwrite existing objects. This is deliberate: an object collision means the target is not empty or the restore has already been partially attempted and should be inspected before continuing.

## Testing

```bash
npm run test:unit
```

Full suite:

```bash
npm test
```

The full suite requires `.env.test` pointing only at a disposable test Supabase project with `ALLOW_DB_WIPE=yes`. Database tests can delete all application data. Never target production.

Tests cover validation, authentication, concurrent registration/capacity, database functions, admin operations, import/export, dashboard data, photos, cleanup, notifications, and maintenance mode.

## Organisation import

Canonical files are `scripts/data/suppliers.psv` and `scripts/data/factories.psv`, with `code|name` lines.

```bash
node --env-file=.env.production scripts/import-orgs.js
node --env-file=.env.production scripts/import-orgs.js "path/to/data"
```

The import inserts new list organisations, refreshes codes, preserves attendee-created pending rows, and removes stale list organisations only when no attendee links to them.

## Demo event data

After migrations and organisation import, a disposable development project can be populated with realistic attendees, event days, credential states, and attendance examples:

```bash
ALLOW_DUMMY_SEED=yes npm run seed:demo
```

PowerShell:

```powershell
$env:ALLOW_DUMMY_SEED='yes'
npm run seed:demo
```

The explicit flag prevents accidental execution. The command is repeatable and writes the raw dummy QR/fallback values to `.demo/credentials.json`, which is ignored by Git. The database stores only their SHA-256 hashes.

## Deployment

### Node/Linux

1. Install Node 24, clone, and run `npm ci`.
2. Create production `.env`.
3. Apply all migrations and import organisations.
4. Run behind HTTPS using systemd and nginx or equivalent.

```ini
[Unit]
Description=Primark Event Registration
After=network.target

[Service]
WorkingDirectory=/opt/primark-registration
ExecStart=/usr/bin/node --env-file=.env server.js
Environment=NODE_ENV=production
Restart=always
User=primark

[Install]
WantedBy=multi-user.target
```

Rate-limit registration, photo upload, and login. Keep the Supabase project active throughout registration/event operation.

### Docker

```bash
docker compose build
docker compose up -d
```

Compose exposes port 3000, loads `.env`, limits memory, and includes a health check. It omits production mode for plain-HTTP local use because browsers reject `Secure` cookies without HTTPS.

### Production checklist

- Dedicated production Supabase project.
- Strong random admin/session secrets.
- HTTPS and endpoint rate limits.
- Photo cleanup worker running.
- Registration/photo/export smoke tests completed.
- Database **and Storage** backups created and restore-tested.
- Backups kept encrypted outside Git.

## Security and privacy

Current protections include server-only Supabase access, RLS, transactions, dual validation, signed HTTP-only cookies, timing-safe password comparison, photo signature/size checks, private photo access, bounded bodies, and a bot honeypot.

Current limitations:

- One shared admin password instead of individual accounts.
- No separation between administrators and future scanner staff.
- Public full-organisation output includes attendee name/designation.
- Current UI uses external CDN assets and is not fully offline.
- SQL exports contain personal data in clear text.

The scanner must use a separate role/device session that cannot edit/delete registrations or export private data.

## Attendance design

### Objective

For every confirmed registration:

1. Verify an opaque credential for the selected event.
2. Record attendance once per selected event day.
3. Identify repeat scans clearly.
4. Continue during internet outages.
5. Synchronize safely afterward.

### Approach

Keep one Express service and one Supabase project. Use typed tables and modules for events, credentials, check-in, and offline synchronization. Do not create microservices or a generic key/value settings system.

```text
Admin attendance UI ───────┐
Online scanner ────────────┼──► Express API ───► PostgreSQL/Storage
Offline scanner PWA ───────┘        ▲
  ├─ cached application             │ sync
  ├─ IndexedDB roster               │
  └─ IndexedDB outbox ──────────────┘
```

## Planned database model

Recommended reusable structure:

```text
people ──< event_registrations >── events ──< event_days
                    │
                    ├──< registration_orgs >── organisations
                    ├── registration_credentials
                    └──< attendance >── event_days
```

### Core tables

```text
events
  id, name, subtitle, timezone, starts_at, ends_at
  status (draft/open/closed/archived), timestamps

event_days
  id, event_id, event_date, label
  check_in_opens_at, check_in_closes_at
  unique(event_id, event_date)

people
  id, name, email, phone, timestamps

event_registrations
  id, event_id, person_id, designation, from_type
  organisation_name, photo_path
  status (confirmed/cancelled/revoked), timestamps
  unique(event_id, person_id)

registration_credentials
  registration_id primary key
  token_hash unique, status (active/revoked)
  issued_at, rotated_at

attendance
  id, registration_id, event_day_id
  first_scanned_at, scanned_at_device, received_at
  device_id, scan_id unique, source (online/offline)
  unique(registration_id, event_day_id)
```

The unique attendance constraint is the authoritative duplicate guard. The scanner selects an `event_day_id`; do not determine the day solely from an offline device clock.

Existing attendees should be backfilled into people/registrations for the current event, and `attendee_orgs` into registration relationships. Verify counts before retiring old structures.

## QR credential design

Use a versioned opaque token:

```text
ER1.<base64url cryptographically-random value>
```

Requirements:

- At least 128 random bits.
- Encode no name, email, phone, organisation, or photo URL.
- Encode no API/Supabase secret.
- Store only `SHA-256(raw token)` in database/offline roster.
- Keep the printable token only as an authenticated server-encrypted payload so reprints stay identical.
- Support revoke and rotate without changing registration ID.
- Support a short manual fallback code.

Do not use only the attendee UUID: it is permanent and cannot be independently rotated after a leaked/copied credential.

Normal attendee edits never rotate a credential. A legacy hash-only credential is replaced once when its first downloadable QR is generated because a SHA-256 hash cannot recover the original token; every later generation reuses that same credential.

A scanned QR can be copied. Online duplicate detection helps but does not prove identity; staff should verify the attendee details returned after a successful scan.

## Online check-in flow

1. Staff signs in with the shared admin login (the deliberately simple current requirement).
2. Select event/day.
3. Scan QR and submit credential, day, device ID, client `scan_id`, and device time.
4. Express hashes credential and calls one transactional database function.
5. Database validates credential/registration/event/day and inserts attendance.
6. API returns display details and a stable status.

| Status | Meaning |
|---|---|
| `CHECKED_IN` | Valid; attendance recorded now |
| `ALREADY_CHECKED_IN` | Valid; already attended that day |
| `INVALID` | Unknown credential |
| `REVOKED` | Credential/registration disabled |
| `WRONG_EVENT` | Registration belongs elsewhere |
| `OUTSIDE_CHECKIN_WINDOW` | Selected day is not open |

Database uniqueness—not browser state—prevents online duplicates.

## Offline check-in flow

Build an installable PWA:

- Service worker caches scanner HTML/CSS/JS/fonts/icons/QR library.
- IndexedDB stores a minimized roster and pending outbox.
- UI always shows connectivity, roster version/age, device ID, and unsynchronized count.

### Device preparation

While online: install/open scanner, authenticate, choose event/day, select **Prepare for offline use**, verify roster count/version/time, then test valid and invalid QRs in airplane mode.

Minimized roster:

```text
token_hash, registration_id, status
display name, designation, organisation
small photo thumbnail (optional)
event_id, event_day_id, roster_version
```

Avoid email/phone unless manual-search requirements justify them.

### Offline scan

1. Hash scanned credential locally.
2. Match the hash in IndexedDB.
3. Validate status/event/day and check local prior scans.
4. Show result immediately.
5. Save an outbox item with client-generated UUID `scan_id`, selected day, device time, and device ID.
6. Synchronize automatically on reconnect.

The sync API accepts bounded batches and is idempotent by `scan_id`. Each item becomes accepted, already checked in, rejected with reason, or retained for retry. Never silently discard rejected/unresolved records.

### Offline limitations

- A device only knows its downloaded snapshot; later revocation may appear valid.
- Independent offline phones cannot see one another's scans.
- A copied QR may be accepted at separate offline gates.
- Server constraints reconcile duplicates after sync but cannot undo physical entry.
- Clearing browser storage can remove the roster/outbox.
- A new device must download data before going offline.

For strict outage-time duplicate prevention, use one scanner or a local-LAN server on a laptop/Raspberry Pi. Multiple independent offline scanners provide resilience, not global real-time coordination.

## Future offline API

Scanner users may download permitted rosters, verify/check in, sync, and perform limited search. They must not edit/delete registrations or export data.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/check-in/login` | Scanner session |
| `POST` | `/api/check-in/logout` | End session |
| `GET` | `/api/check-in/events` | Permitted events/days |
| `GET` | `/api/check-in/bootstrap` | Event/day/version configuration |
| `GET` | `/api/check-in/offline-roster` | Minimized offline dataset |
| `POST` | `/api/check-in/scan` | Online check-in |
| `POST` | `/api/check-in/sync` | Idempotent offline batch |
| `GET` | `/api/check-in/search` | Manual fallback |

Example request:

```json
{
  "credential": "ER1.example-opaque-value",
  "event_day_id": "6ad69e3a-33fc-4ca8-940d-acde76f22f40",
  "scan_id": "55dc641d-8b95-4856-a577-bc823a1344e9",
  "device_id": "gate-a-01",
  "scanned_at_device": "2026-11-04T09:13:22+06:00"
}
```

## Implementation roadmap

### Phase 0 — Recovery first

- Implemented: repeatable database and Storage backup tooling.
- Implemented: sequence repair, manifest, row/object counts, and SHA-256 checksums.
- Implemented: generated database exports and backup bundles are ignored by Git and Docker.
- Remaining operational step: rehearse a complete restore in a separate Supabase project.
- Rehearse restoration in a separate project.

Complete this before production schema changes.

### Phase 1 — Event-ready data (implemented)

- Migration `006`: events, days, registrations, organisation snapshots, credential history, and attendance.
- Backfill existing attendees when upgrading a populated database.
- Add transactional credential rotation/check-in functions, stable outcomes, and indexes.
- Add guarded repeatable demo data covering active, checked-in, revoked, and cancelled registrations.

### Phase 2 — Online scanning (implemented)

- Shared-admin authentication for the scanner.
- Camera/image scanner plus manual fallback.
- Online transaction and daily attendance dashboard/export.

### Phase 3 — Offline scanner

- Manifest, service worker, local assets.
- IndexedDB roster/outbox and versioning.
- Batch synchronization/conflict display.
- Airplane-mode, restart, reconnect, and multi-device testing.

### Phase 4 — Operational hardening

- Individual staff/device accounts and audit log.
- Credential-revocation workflow, monitoring, load test, full rehearsal.
- Incident, support, backup, and retention procedures.

Future options only when required: local LAN hub, native scanner, multi-tenant ownership, or badge-printer integration.

## Acceptance criteria

### Online

- First valid scan records selected-day attendance.
- Repeat returns `ALREADY_CHECKED_IN` without another row.
- Same person can attend separate days once each.
- Invalid/revoked/cancelled/wrong-event codes fail.
- Concurrent scans cannot duplicate attendance.
- Scanner requires a valid admin session; individual restricted roles are intentionally not part of the current simple setup.

### Offline

- Prepared device works after reload/restart in airplane mode.
- Valid, invalid, and local-repeat scans are distinguishable.
- Pending records survive restart.
- Reconnect processes each `scan_id` at most once.
- Conflicts/revocations remain visible for review.
- Roster age and unsynchronized count are always visible.

### Recovery

- Database and Storage restore successfully into a separate project.
- Row/object counts and checksums match a manifest.
- No backup/attendee data is committed.
- Event staff complete an airplane-mode rehearsal.

---

**Design rule:** the database is authoritative online; a versioned roster snapshot and idempotent outbox provide controlled continuity offline.
