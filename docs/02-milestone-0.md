# Milestone 0 — scaffold and spike

Date: 25 Oct 2026

## Delivered
- **Monorepo** (npm workspaces, TypeScript): `packages/core`, `packages/db`, `apps/server`, `apps/web`.
- **Core engine** (`packages/core`, 21 tests): exact money parsing/formatting in paise, half-up rounding, rupee round-off, steel rod weights (d²/162 × length), bundle/rod/kg conversion, CGST/SGST/IGST per line and per bill, GST-inclusive back-calculation, financial year, Rule 46 invoice numbers (≤ 16 chars), India-time "today", amount in words (English Indian system and Tamil).
- **Database** (`packages/db`): SQLite via libSQL, migrations, UUIDv7 ids, inserts that write the sync outbox in the same transaction.
- **Server** (`apps/server`, 6 API tests): catalog with resolved rates, today's TMT rate update, bill preview (live totals), save bill (numbering, stock movements, cost snapshot, double-entry ledger, receipt for money paid at billing), credit-limit and stock warnings that hold the bill until confirmed, IGST for out-of-state customers.
- **Web** (`apps/web`): New Bill (bundles + rods or weighed kg, auto rate, live GST totals, payment), Bills list, Stock, Today's rate, English/தமிழ் switch, printable invoice in the bill's language with UPI QR for the balance due.

## Verified
- End-to-end in headless Chrome: a 4-line bill (12 mm by bundles + rods, 8 mm weighed, binding wire, transport) totals ₹54,008.00, matching a hand calculation; saved as `ST/26-27/0001`; ledger balances; stock reduced.
- **Tamil invoice printing works**: printed through the browser to an A4 PDF with Noto Sans Tamil embedded; combined letters (க்ஷ, ஸ்ட், மிமீ) shape correctly. The HTML-invoice approach from the spec is confirmed.
- Layout checked at desktop (1366 px) and phone (390 px) widths.

## Decisions
- **Invoice output:** HTML template printed by the browser (not a PDF library), because browsers shape Tamil correctly.
- **Weighted-average cost:** currently the average over all inward stock (opening + purchases). Revisit in M3 when purchases arrive; may switch to a moving average.
- **Login:** M0 uses the owner account silently. PIN login and roles come in M1.

## Made generic (product, not a one-shop app)
- Renamed to **Tula**; packages are `@tula/*`.
- Business details, GST scheme (regular / composition / unregistered), invoice prefix and terms, languages, and stock/credit rules are **settings**, validated by a registry and edited in a generated Settings screen. Billing is blocked until the essentials are filled in.
- Daily-rate products use **rate groups** (data), not a hard-coded TMT rate.
- Bill quantity boxes come from each product's **units** (bundle/rod for steel, length for pipe, roll for wire), not from steel-specific code.
- Starter catalogues are **presets** (JSON): `blank` and a brand-neutral `building-materials`; demo data is optional.
- Composition dealers get a Bill of Supply without GST; walk-in sales are billed in the business's own state; all 38 GST state codes are known.
- Tested as both a demo Tamil Nadu dealer and a fresh Karnataka hardware shop set up from scratch in English only.

## Not done in M0 (carried forward)
- **Turso sync spike.** Needs a Turso account and database URL/token; this build environment can't reach Turso. The outbox is already written on every change, so sync can be tested as soon as credentials exist. Moved to the start of M5 (mobile), or earlier if you create the Turso database.
- **Capacitor APK** (M5).
- **Tamil wording review** — UI labels, invoice labels and amount-in-words were drafted by Claude and need a native reader's check.

## Next: Milestone 1 (masters)
Settings screen (shop details, GSTIN, invoice prefix), PIN login and roles, products and units (incl. cement, paint, plumbing, fencing), parties with credit limits and party-wise rates, opening stock and balances.
