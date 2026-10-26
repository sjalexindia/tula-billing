# Tula

Billing, stock and accounts for Indian traders: GST invoices, credit tracking, profit reports, in English and Tamil.

Runs on the shop's own computer without internet, syncs to phones, backs up to Google Drive. No monthly cost.

*Tula (तुला / துலாம்) means the weighing scale, and a balanced book.*

## Status
**Phase 1 done.** A full shop day: billing, returns, receipts, purchases, expenses, stock, reports and GST returns, roles, backups, auto-start and sync. See [docs/08-phase-1.md](docs/08-phase-1.md).

**Phones that work anywhere.** The Android app can run Tula on the phone itself: it bills with no internet and the shop computer off, and syncs through the cloud copy. See [docs/07-sync-and-phones.md](docs/07-sync-and-phones.md) §5.

| Doc | What it covers |
|---|---|
| [docs/01-release-1-spec.md](docs/01-release-1-spec.md) | Goals, roles, use cases, business rules, architecture, screens, release plan |
| [docs/02-milestone-0.md](docs/02-milestone-0.md) | What M0 delivered, decisions, what's next |
| [docs/03-configuration.md](docs/03-configuration.md) | Settings, presets, business profiles, environment variables, adding a language |
| [docs/04-milestone-1.md](docs/04-milestone-1.md) | Sign-in and roles, items, customers, opening figures |
| [docs/05-engineering-guide.md](docs/05-engineering-guide.md) | How Tula is built: numbers, data rules, accounting conventions, API, web, tests |
| [docs/06-install-and-run.md](docs/06-install-and-run.md) | Installing on the shop PC, auto-start, backups and restore, troubleshooting |
| [docs/07-sync-and-phones.md](docs/07-sync-and-phones.md) | Cloud copy (Turso), phones and other computers |
| [docs/08-phase-1.md](docs/08-phase-1.md) | What Phase 1 delivered, how it was verified, known gaps |
| [docs/09-excel.md](docs/09-excel.md) | Excel import and export of items, customers and suppliers, opening stock |
| [docs/11-recycle-bin.md](docs/11-recycle-bin.md) | Recycle bin, settings that save what they can, stock in larger units |
| [packages/db/migrations/](packages/db/migrations/) | SQLite schema |

## Run it
Needs Node.js 20 or later.

```bash
npm install
npm run build -w apps/web          # build the web app once
npm start -w apps/server           # http://localhost:5000
```

The first run creates `data/tula.db` with an owner user, base units and a walk-in customer. Sign in as **Owner** with PIN **1234**; you'll be asked to choose your own PIN, then to fill in the business details in **Settings** before the first bill.

To start with a ready catalogue and sample data instead:

```bash
TULA_PRESET=building-materials TULA_DEMO=1 npm start -w apps/server
```

Development (hot reload): `npm run dev:server` and `npm run dev:web` (http://localhost:5173). Tests: `npm test`.

## Layout
```
apps/
  server/   Node + Fastify API; serves the web app; presets/ holds starter catalogues
  web/      React app (computer browser now; Android APK via Capacitor in Milestone 5)
packages/
  core/     money and quantity maths, GST, invoice numbering, amount in words, settings registry
  db/       SQLite connection, migrations, sync-aware inserts
docs/
```

## Principles
- No business-specific values in code. Business details are settings; catalogues are data; trades are presets.
- Money in integer paise, quantities in integer thousandths, GST in basis points. No floating point.
- Saved documents are never edited; corrections are new documents (cancellation, credit note, adjustment).
- Every change to synced data writes the sync outbox in the same transaction.
- No user-facing text outside `apps/web/src/locales/`.
