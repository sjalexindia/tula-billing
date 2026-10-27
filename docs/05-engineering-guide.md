# Engineering guide

How Tula is built, and the rules every change follows. Read this before writing code.

## 1. Shape of the system

```
apps/web  (React)  ──HTTP /api──►  apps/server (Fastify)  ──►  SQLite file (libSQL)
     │                                   │                          │
     └── uses packages/core              └── uses packages/core     └── sync_outbox ──► Turso replica

Android app, working on its own (phone build of apps/web):
apps/web (React) ──apiFetch──► in-app router + the same API routes ──► SQLite WebAssembly ──► Turso replica
```

- **packages/core**: pure TypeScript, no I/O. Money, quantity, GST, numbering, words, settings registry. Shared by server and web, so a number is calculated the same way everywhere.
- **packages/db**: migrations and the only functions that write rows (`insert`, `update`, `softDelete`, `setSetting`), `uuidv7` (monotonic within a millisecond). `@tula/db/node`: opening a database file, `loadMigrations`, `closeDb`. `@tula/db/wasm`: a libSQL-compatible client on SQLite WebAssembly (the phone's database, and in-memory copies of backup files on the computer).
- **apps/server**: business rules and the HTTP API. One module per area, each exporting `registerX(app, db, deviceId)`. `src/api.ts` registers everything the phone can run too; `src/app.ts` adds Fastify and the computer-only parts.
- **apps/web**: screens. One file per screen in `src/screens`, registered in `src/nav.tsx`. `src/local` is Tula running on a phone (phone build only).

### Code that also runs on the phone
The Android app runs the server's route modules, the sync engine and `packages/db` inside the WebView. So:
- Route modules use only the `Router` / `Req` / `Reply` types in `apps/server/src/http.ts`, never Fastify features directly. Fastify satisfies them on the computer; `apps/web/src/local/router.ts` on the phone.
- No `node:*` imports, `Buffer`, `process` or `NodeJS.*` types in `packages/db/src/index.ts`, `packages/core`, `apps/server/src/api.ts` or anything it imports, or `apps/server/src/sync/{engine,hub,join,routes,schema,state,worker}.ts`. Node-only code lives in `@tula/db/node`, `app.ts`, `ops*`, `setup.ts`, `sync.ts`, `sync/node-hub.ts`, the CLI and the supervisor.
- A computer-only screen sets `computerOnly: true` in `src/nav.tsx`; a computer-only control checks `runsLocally` from `src/platform.ts`.
- `npm run typecheck` (the web project compiles the shared server modules without Node types) and `npm run build:phone -w apps/web` catch most slips.

## 2. Numbers

| Kind | Stored as | Example | Helpers |
|---|---|---|---|
| Money | integer **paise** | ₹10.50 → `1050` | `toPaise`, `formatRs`, `roundDiv` |
| Quantity | integer **thousandths** of the base unit | 147.35 kg → `147350` | `toMilli`, `formatQty` |
| GST rate | integer **basis points** | 18% → `1800` | — |
| Dates | `'YYYY-MM-DD'` text | | `todayIST`, `financialYear` |
| Timestamps | ISO-8601 UTC text | | `nowIso` |

Rules:
- Never use floating point for money or quantity. Parse user input with `toPaise` / `toMilli` (they reject extra decimals), divide only with `roundDiv` (half away from zero).
- Round **once**, at a defined point: each GST line, then the bill to the rupee (`roundToRupee`). Totals are sums of rounded lines.
- Column names say the unit: `*_paise`, `*_milli`, `*_bp`.

## 3. Data rules

- **Every synced row** has `id` (UUIDv7), `created_at`, `updated_at`, `device_id`, `deleted`. Write through `insert` / `update` / `softDelete` from `@tula/db` so the change also lands in `sync_outbox` in the same transaction. Never `DELETE` from a synced table; never write synced tables with raw SQL except reads.
- **Documents are immutable** once saved (bills, credit notes, purchases, receipts, payments, expenses, adjustments). Mistakes are fixed with a new document: cancellation, credit/debit note, adjustment. A cancelled document keeps its number.
- **Stock is never stored.** On hand = `SUM(stock_moves.qty_milli)`. Every document that moves goods writes `stock_moves` rows (`+` in, `−` out) with `source_type`/`source_id`/`source_line_id`.
- **Balances are never stored.** A party's balance = its ledger account (`v_party_balance`). Every document posts a **balanced** voucher with `post()` from `apps/server/src/accounts.ts`; it throws if debit ≠ credit.
- **Multi-step writes run in one transaction** (`db.transaction('write')`, commit, roll back on error).
- **Schema changes** are new files in `packages/db/migrations/NNNN_name.sql`, never edits to old ones. SQLite cannot change a `CHECK` without rebuilding the table, so prefer new nullable columns.
- **Masters** (items, customers, settings) may be edited; every change writes `audit_log`. A master is deleted (`deleted = 1` through `update()`) only while nothing uses it, and can be restored from the recycle bin (`recycle.ts`); anything in use is made inactive instead.
- **Order must not depend on storage.** Every `ORDER BY` that picks or lists rows ends with a unique tie-breaker (id or code). Devices store rows in different orders, so a tie can show different answers on two computers or a phone (two such bugs were found by comparing the phone with the computer).
- **Quotations** are `sales_docs` with `doc_type = 'QT'`: no stock, ledger or money rows. Reports, registers and balances read only `INV`/`CN`; keep it that way when adding a report.
- **Database files on Windows.** The libSQL client keeps a file open after `close()` until garbage collection; Windows cannot rename or delete an open file. Close with `closeDb()` when the file must be free (restore, tools), and check or edit backup files as in-memory copies (`ops/dbfile.ts`).

## 4. Accounting conventions (Phase 1)

| Document | Ledger | Stock |
|---|---|---|
| Sales invoice `INV` | Dr Party (total) · Cr SALES (taxable) · Cr OUT_CGST/SGST/IGST · Cr/Dr ROUND_OFF | − qty, cost snapshot on the line |
| Cancel invoice | Soft-delete the invoice's ledger entries and stock moves; status `cancelled`, reason, who, when. Receipts allocated to it become on-account (advance) | moves soft-deleted |
| Credit note `CN` (sales return) | Reverse of INV for the returned lines: Dr SALES · Dr OUT_* · Cr Party · ROUND_OFF | + qty, `value_paise` = qty × the original line's cost |
| Receipt `RCPT` | Dr CASH / UPI / BANK · Cr Party; `money_allocations` link it to bills; the unallocated part is an advance | — |
| Purchase `PUR` | Dr PURCHASES (taxable + freight) · Dr IN_CGST/SGST/IGST (only if ITC eligible; otherwise tax goes into cost) · Cr Party · ROUND_OFF | + qty, `value_paise` = landed cost |
| Debit note `DN` (purchase return) | Reverse of PUR for the returned lines | − qty at the purchase cost |
| Supplier payment `PAY` | Dr Party · Cr CASH / UPI / BANK | — |
| Expense `EXP` | Dr expense account `EXP:<head id>` (taxable, plus tax if no ITC) · Dr IN_* (if ITC) · Cr CASH/UPI/BANK, or Cr Party when on credit | — |
| Stock correction `ADJ` | none in Phase 1 | ± qty; negative moves carry `value_paise` = − qty × average cost at the time |

Profit and loss is computed from documents, not from the PURCHASES account:
sales (taxable, INV − CN) − cost of goods sold (INV line costs − CN line costs) = gross profit; − expenses (taxable + non-ITC tax) − stock-correction losses = net profit.

Average cost = all inward value ÷ all inward quantity (`v_avg_cost`). Each sale snapshots it, so old profit never changes.

## 5. API

- Routes live under `/api/`. JSON in, JSON out. Validate every body/query with **zod**.
- Errors: throw `UserError(message, CODE, status)`. The message is shown to the person, so write it in plain words saying what to do ("Pick a category"), never a stack trace. `ZodError` and `RangeError` become 400 automatically.
- **Who can do what** is decided in one place: `apps/server/src/auth.ts`. GET is open to any signed-in user; writes are owner-only unless listed in `BILLING_WRITES`. Use `requireOwner(req)` for owner-only reads. The acting user is `req.user`.
- Every document records `created_by = req.user.id`.
- Money crosses the API as paise integers in responses and as decimal strings in requests (`"10.50"`).

## 6. Web

- One screen per file in `src/screens`, exported as a component taking `ScreenProps` (`{ id?, ratesVersion }`), listed once in `src/nav.tsx` with its roles.
- Talk to the server through `req` from `src/api.ts`. A feature may put its calls and types in its own file (e.g. `src/api/receipts.ts`).
- **No text in code.** Every word on screen comes from `src/locales/<lang>/<feature>.json` (top-level key = feature, e.g. `{ "receipts": { … } }`) in **both** `en` and `ta`. Product and party names come from the data (`name_en` / `name_ta`) via `nameIn`.
- Reuse the shared classes before adding CSS: `.page`, `.page-head`, `.grid` (`.compact`), `.form-grid`, `.field`, `.btn` (`.primary`, `.small`, `.big`), `.seg`, `.hint`, `.empty`, `.notice`, `.field-error`, `.saved-note`, `.form-actions`, `.search`; `Field` from `components/Field.tsx`. Feature-specific CSS goes in `src/styles/<feature>.css`, imported by the screen.
- Write for the shop counter: plain words, sentence case, buttons that say what happens ("Save receipt"), errors that say how to fix. Every input has a label. Works at 390 px wide.
- Print views use the browser's print (HTML), never a PDF library, so Tamil shapes correctly.

## 7. Configuration, never constants

Nothing about one business lives in code. Business facts are **settings** (registry in `packages/core/src/settings.ts`, validated, shown automatically on the Settings screen). Catalogues are **presets** (`apps/server/presets/*.json`). A business's real details are a **profile** kept outside the repo. Secrets (sync tokens) are environment variables only.

## 8. Tests

Where things live, for the features added after Phase 1:
| Feature | Server | Web | Doc |
|---|---|---|---|
| Phones working on their own | `api.ts`, `http.ts`, `sync/*` | `src/local/*`, `platform.ts` | 07 |
| Excel import / export | `excel.ts` | `api/excel.ts`, `screens/Excel.tsx` | 09 |
| Quotations | `quotes.ts`, `bills.ts` (`createBill(…, { fromQuote })`) | `screens/Quotes.tsx`, `NewBill mode="quote"` | 10 |
| Recycle bin, partial settings save | `recycle.ts`, `settings-save.ts` | `screens/RecycleBin.tsx` | 11 |
| Share as picture / PDF | — | `components/PrintShare.tsx`, `files.ts` | 07 |
| Google Drive backup folder | `ops/drive.ts` | Backup screen | 06 |
| Expiring phone tokens | `sync/routes.ts` | Devices screen | 07 |


- `packages/core`: unit tests for every calculation (vitest).
- `apps/server`: API tests with an in-memory database via `bootSignedIn()` in `test/helpers.ts`. Test the rule, the refusal, and that the ledger still balances (`SUM(debit) = SUM(credit)`).
- Run `npm test` and `npx tsc --noEmit -p <package>` before every commit. A change isn't done until its tests pass.
- `npm run test:phone -w apps/server` runs the business tests again on the phone's stack (SQLite WebAssembly behind the libSQL-compatible client, the in-app router); `test/phone.test.ts` covers joining from the cloud copy, billing offline and syncing. A change to shared code passes both.
- Browser checks: build the web app, start the server on a scratch database, and drive it with Playwright.

## 9. Git

- Small commits with a subject saying what changed for the user. `main` always passes tests.
- Never commit a real business profile, a database file, or a token. `.gitignore` covers `*.db`, `data/`, `*.profile.json`, `.env*`.
