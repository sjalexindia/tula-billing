# Cloud copy (sync) and phones

Phase 1. Owner-facing steps first, then how it works and its limits.

## 1. What sync does in Phase 1, and what it doesn't do

**Does:**
- Keeps an **off-site copy of all business data** in a cloud libSQL database (Turso). Every change on the shop computer (bills, receipts, items, customers, settings, users and so on) is sent within a few seconds. If the internet is down, changes wait on the computer and are sent later.
- Lets you **set up a replacement computer**, or a second one, from that copy ("join").
- Lets two or more computers share the same data, each with its own bill number series.

**Doesn't:**
- Phones do **not** keep their own copy. A phone is a screen for the shop computer: it works only on the shop Wi-Fi while that computer is on. Billing on a phone without the computer is Phase 2.
- It is not a backup history. The cloud copy is the **latest state**, not yesterday's version. Keep using the daily backup on the Backup screen as well.
- Login sessions are never copied. Each computer signs its own people in, but users and PINs are copied.

## 2. Set up the cloud copy (Turso)

1. Create an account at turso.tech (the free tier is enough for one shop).
2. Create a database in the **Mumbai (`aws-ap-south-1`)** region. With the CLI:
   ```
   turso db create tula-<shop> --location aws-ap-south-1
   turso db show tula-<shop> --url          # libsql://tula-<shop>-<org>.turso.io
   turso db tokens create tula-<shop>       # long string: this is the password
   ```
   You can do the same on the Turso website: Databases → Create → choose Mumbai, then "Create token".
3. On the shop computer, add two lines to Tula's environment file (the same place as `TULA_DB` and `TULA_PORT`; see [03-configuration.md](03-configuration.md)):
   ```
   TULA_SYNC_URL=libsql://tula-<shop>-<org>.turso.io
   TULA_SYNC_TOKEN=<token>
   ```
4. Restart Tula. Settings → **Devices & sync** should show **"Cloud copy is up to date"** within a minute.

The token is a password. Keep it **only** in that environment file: never in a business profile, a screenshot, WhatsApp or git. Tula never shows it. The status screen shows only the database's host name.

**Rotate the token** (once a year, or when someone who knew it leaves): create a new token, put it in `TULA_SYNC_TOKEN` on every computer, restart Tula, then invalidate the old ones with `turso db tokens invalidate tula-<shop>`. Note that invalidating **all** tokens of the database is how Turso revokes access, so do this on every computer the same day.

**If the screen shows a problem**, it says what to do:

| Message | What to do |
|---|---|
| Cannot reach the cloud copy | Internet is down. Billing keeps working; changes are sent when it is back (retries every 5 s, then slower, at most every 5 min). |
| The cloud refused the access token | Token wrong, expired or invalidated: make a new one (above). |
| The cloud address is not correct | Fix `TULA_SYNC_URL`. |
| Another computer has a newer version | Update Tula on this computer. Its changes wait safely on the hub. |
| This computer was marked as lost | See §4. |

## 3. Join a new or replacement computer

The new computer starts with an **empty** database (a new `TULA_DB` file). In its environment file, set the same `TULA_SYNC_URL` and `TULA_SYNC_TOKEN`, plus:

- **Second computer** (both stay in use):
  ```
  TULA_JOIN=new
  TULA_DEVICE_NAME=Back office PC      # optional
  ```
  It copies everything from the cloud and gets its own bill series code: `C2`, then `C3` and so on. Its bills are numbered like `DT/26-27/C20001`, so the two computers never clash. Owners sign in with their existing PINs.

- **Replacement for a dead or stolen main computer** (the same bill series continues):
  ```
  TULA_JOIN=replace
  TULA_JOIN_DEVICE=<device id of the old computer>
  ```
  The device id is on the old computer's Devices & sync screen, or is printed in the log if you start with `TULA_JOIN=replace` alone (it refuses and lists the devices in the cloud copy). This computer **takes over** the old one's identity, so bill numbers continue from the last one that reached the cloud.

  **Never switch the old computer back on with sync enabled.** Two computers with one identity would issue the same bill numbers. Bills made on the old computer that never reached the cloud (no internet before it died) are lost; check the last bill number before billing.

Start Tula. The log says what happened, for example: `sync: joined the business … as a NEW computer "Back office PC" (device …, invoice series code C2); copied 1234 rows.` After that, remove `TULA_JOIN*` from the file. They are ignored once the computer is set up, and Tula logs a reminder. If joining fails (wrong token, empty cloud copy, bad device id), Tula stops with the reason. It never quietly starts a blank business.

## 4. Devices screen: rename, "mark as lost"

Settings → Devices & sync lists every computer that shares the data, with its bill series. **Mark as lost** (from another computer) makes that computer stop sending and receiving as soon as it next connects. All computers share one Turso token, so a thief with the computer still has the token: **also rotate the token** (§2). "Found again" undoes the mark. A computer cannot mark itself as lost.

## 5. Phones

Phones open Tula **from the shop computer**, over the shop Wi-Fi. The shop computer must be on and Tula running (it listens on the LAN by default: `TULA_HOST=0.0.0.0`).

### Browser (any phone)
1. Connect the phone to the shop Wi-Fi.
2. Settings → Devices & sync → **Open on a phone** shows a QR code for each network address of the computer. Scan it with the camera; Tula opens in the browser. Sign in with your name and PIN.
3. Browser menu → **Add to Home screen**.

What "Add to Home screen" really does today (checked October 2026):
- Over `http://192.168.x.x:5000` (plain http on the LAN), Chrome on Android makes a **home-screen shortcut** that opens Tula in a normal Chrome tab, with the address bar. It is **not** installed as a full-screen app, and no service worker runs. Browsers install web apps and run service workers only in a *secure context*: `https://`, `localhost` or `127.0.0.1` ([MDN: Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_Installable); a [Node-RED forum thread](https://discourse.nodered.org/t/pwa-capability-on-android/89086) reports the same for LAN http on Android Chrome: older shortcuts opened full screen, new ones show the URL bar). It works, and is one tap away.
- On the shop computer itself (`http://localhost:5000`), Chrome or Edge offers **Install Tula**, which gives a real app window. The manifest (`apps/web/public/manifest.webmanifest`), icons and `sw.js` are in place for this.
- A full-screen phone app over the LAN would need https on the shop computer (a certificate for a LAN name). That is out of Phase 1. Use the Android app below.

The service worker caches only the app's static files (page, scripts, styles, icons). It **never** caches `/api/`, so figures are always live.

### Android app (APK)
A thin app that opens Tula from the shop computer full screen, without the address bar.
1. Build: on GitHub → Actions → **Android APK** → *Run workflow* (also runs for tags `v*` / `android-*`). When it finishes, download the artifact `tula-android-debug` (a zip with `tula-…-debug.apk`).
2. Send the APK to the phone (USB, or a shared drive link; not a public link). Open it. Android asks to allow **"Install unknown apps"** for the Files or Chrome app: allow it once, then install. Play Protect may warn about an unknown developer, because this is a debug build that isn't from the Play Store: choose "Install anyway".
3. Open **Tula**, type the address under the QR code (for example `192.168.1.20:5000`; `http://` and port 5000 are added if left out; a pasted QR link also works), then **Connect**. The app checks `/api/health`, remembers the address, and opens Tula. Next time it opens Tula straight away.
4. If the computer can't be reached, the app shows **Try again** and **Change address**. The Back button from Tula also returns to this page.

Technical notes: Capacitor 8, app id `in.tula.app`, `webDir` = `apps/web/shell` (the connect page; no build step). Plain http to private LAN ranges (`192.168.*`, `10.*`, `172.16–31.*`, `*.local`) is allowed via `server.cleartext`, `allowNavigation` and `android.allowMixedContent`. `server.errorPath` = `error.html`. The health check uses the native `CapacitorHttp` plugin, so the browser's cross-origin rules don't apply. The `android/` project is committed. CI runs `npx cap sync android` and `./gradlew assembleDebug` with Java 21. **The CI build has not been run yet**: the first run may need small fixes. A signed release build (for Play Store or to avoid warnings) is not set up.

**Router tip:** give the shop computer a fixed IP (a DHCP reservation in the Wi-Fi router). Otherwise the address can change after a power cut, and phones and the app must be pointed at the new one.

## 6. How sync works (for developers)

- **Writes.** `insert` / `update` / `softDelete` / `setSetting` (`packages/db`) append the full row as JSON to the local-only `sync_outbox` in the same transaction.
- **Hub.** The cloud database runs the **same migrations**. It also has `sync_log(seq AUTOINCREMENT, device_id, table_name, row_id, op, payload_json, received_at)`: every change any device pushed, in arrival order. It holds a full copy of every synced table **and** the log. Code: `apps/server/src/sync/hub.ts`.
- **Synced tables** are discovered from the schema: every table with a single-column primary key and a `device_id` column, except `sync_outbox`, `sync_state`, `schema_migrations`, `sessions`, `sync_rejects`, `sync_log`. New tables sync without code changes. A new local-only table must not have a `device_id` column (or must be added to `LOCAL_TABLES` in `sync/schema.ts`).
- **Push** (`sync/engine.ts`). Outbox rows in `seq` order, 200 per batch. Each batch is one atomic `batch(…, 'write')` on the hub, containing `PRAGMA defer_foreign_keys = ON`, then for each row an upsert and a `sync_log` insert. The outbox rows are deleted only after it succeeds. The upsert uses only the columns present in the payload that the hub also has:
  `INSERT … ON CONFLICT(pk) DO UPDATE SET c = excluded.c, … WHERE excluded.updated_at >= t.updated_at`. `settings` is keyed by `key`. Tables without `updated_at` (`audit_log`) use `ON CONFLICT DO NOTHING`.
  **Idempotent:** re-pushing a batch after a crash rewrites the same values. The duplicate log entries are harmless, because applying them is last-writer-wins too.
- **Pull.** Hub `sync_log` rows with `seq > sync.cursor` and `device_id != this device`, 500 per page. Each page is applied in **one local transaction** with the same LWW upsert, and `sync.cursor` advances in the same transaction. This is **the one place synced tables are written with raw SQL**, so that pulled rows do not enter the local outbox and echo back.
- **Worker** (`sync/worker.ts`). Push, then pull: every 30 s, and about 3 s after the outbox count rises (polled every second). Exponential backoff from 5 s up to 5 min. It never throws into the server. It records `sync.last_push_at`, `sync.last_pull_at`, `sync.pending`, `sync.last_error` (+ `_code`, `_at`) in `sync_state`. The same failure is logged once.
- **Join** (`sync/join.ts`). Reads the hub's max `seq` first, copies every synced table (keyset pages, FKs deferred, one local transaction), sets the cursor, creates or takes over the device, and pushes.
- **Conflicts the hub can't take** (a UNIQUE clash, e.g. two computers entering the same day's rate) are retried row by row. Rows that still fail go to the local `sync_rejects` table instead of blocking sync, and the screen shows a count. Nothing resolves them automatically yet.
- **API** (owner only): `GET /api/sync/status`, `POST /api/sync/now`, `GET /api/devices`, `PUT /api/devices/:id` (`{name?, revoked?}`), `GET /api/network`.
- **Tests:** `apps/server/test/sync.test.ts` uses two computers and a **file** hub (`file:…/hub.db`). The client API is identical to Turso's; only the URL differs.

## 7. Limits (Phase 1)

- **Clock-based last-writer-wins.** `updated_at` is each computer's wall clock (ISO time, millisecond resolution). A computer whose clock is wrong can win or lose edits unfairly; keep Windows time sync on. The spec's hybrid logical clock is not implemented. LWW is per row: two people changing *different* fields of the same item on two computers keeps only the later row. The losing version is not yet written to the audit log on pull.
- Documents are append-only, so bills never conflict. Stock and balances are derived, so they converge.
- One shared token for all computers: per-device revocation is advisory (§4); real revocation means rotating the token.
- `replace` cannot recover changes that never left the dead computer.
- Rows set aside in `sync_rejects` need a person to look at them (no screen for that yet).
- Turso over the real network has **not** been exercised in development; only the `file:` hub, which uses the same client API. Migrations on the hub run through `executeMultiple` with `BEGIN … COMMIT`. Check this on the first real setup.

## 8. Phase 2: phones that bill offline

Each phone would keep its own libSQL replica and outbox, with its own series code (`M1`, `M2`; `devices.series_code` is ready). It would push and pull through the same hub `sync_log`, so the server-side design here carries over. Needs: a phone-side database (Turso's embedded replicas or our outbox over HTTP, after the spike in the spec §6.1), per-device tokens, conflict review for masters, and an https story for full-screen web install.
