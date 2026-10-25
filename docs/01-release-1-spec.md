# Release 1 Specification — Tula

Status: **Draft for review** · Version 0.2 · 25 Oct 2026

Tula is a billing, stock and accounts product for Indian traders. Release 1 targets building-material and hardware dealers (steel, cement, paint, plumbing, fencing); the first deployment is a TMT steel dealership. It runs on the business's own computer (works without internet) and on Android phones, in English and Tamil. Everything business-specific is configuration — see [03-configuration.md](03-configuration.md).

---

## 1. Goals

1. **Fast, correct GST billing at the counter** — a bill in under a minute, invoice PDF on WhatsApp, UPI QR for the exact amount.
2. **Know stock in real units** — steel in kg with bundles/rods shown, cement in bags, paint in litres/tins.
3. **Control credit** — contractor outstanding, credit limits, ageing, reminders.
4. **Know profit** — bill-wise, party-wise and monthly P&L using weighted-average cost.
5. **Hand clean data to the CA** — GSTR-1 / GSTR-3B exports, sales and purchase registers.
6. **Zero running cost** — local SQLite on the shop PC, Turso free plan for sync, Google Drive for backups.

### Non-goals for Release 1
Filing GST returns (the CA does this), e-invoicing (only above ₹5 crore turnover), payroll, online store, manufacturing, loyalty, marketing tools.

---

## 2. Users and roles

| Role | Who | Can do |
|---|---|---|
| **Owner** | Business owner | Everything, incl. settings, rates, cancelling bills, reports, user management |
| **Billing** | Counter staff | Create bills/quotes, take receipts, view stock and customer balance. Cannot cancel bills, change rates in masters, or see profit |
| **Viewer** | Remote family member, CA | Read-only reports and exports |

Login is a 4–6 digit PIN per user on each device. Every create/edit/cancel is written to the audit log with user, device and time.

---

## 3. Product lines and units

All quantities are stored in a **base unit** as integers (thousandths), and every product can have **alternate units** with a conversion factor.

| Line | Base unit | Alternate units (examples) | Notes |
|---|---|---|---|
| TMT steel bars | kg | rod, bundle | kg/rod = d²/162 × length (theoretical). Bundle = N rods (per size, editable). Weighed kg overrides |
| Rings, binding wire | kg | — | |
| Cement | bag | — | Optionally kg = 50 per bag |
| Paint | litre | tin (1/4/10/20 L), each | Shade and pack size as item custom fields |
| Plumbing | nos / metre | length (e.g. 3 m pipe) | Size, class/pressure as custom fields |
| Fencing | kg / metre / nos | roll, bundle | Barbed wire, chain link, poles |
| Services | nos | — | Transport, loading, cutting charges — no stock |

---

## 4. Use cases

### Daily operations
- **UC-01 Set today's rates.** Owner sets the base steel rate (₹/kg excl. GST) each morning; each size carries a size extra (e.g. 8 mm +₹3). Cement/other items keep their master rate unless changed. Rate history is kept.
- **UC-02 Create sale bill.** Pick customer (or Cash), site/project, items. Enter quantity in any unit (e.g. 10 bundles + 4 rods of 12 mm, or 147.35 kg weighed). Rate auto-fills from: party-wise rate → price level → today's rate. Discount per line or on bill. Shows customer outstanding and credit limit. Payment taken now (cash/UPI/bank/cheque, split allowed). Saves → invoice number assigned → print/PDF/WhatsApp.
- **UC-03 Quotation / estimate.** Same screen, no stock or accounts effect; convert to bill later with one tap (rates re-checked against today's).
- **UC-04 Sales return.** Against a bill: return some lines → credit note, stock back in, customer balance reduced.
- **UC-05 Cancel bill.** Owner only, with reason. Bill stays in the register marked *Cancelled* (number never reused); stock and accounts reversed.
- **UC-06 Receive payment.** From a customer, allocated to specific bills (oldest first by default) or kept on account (advance).
- **UC-07 Purchase entry.** Supplier bill: items, qty as per mill weight, rate, GST, freight/loading on the bill. Stock in. Weighted-average cost updated.
- **UC-08 Purchase return.** Debit note to supplier; stock out.
- **UC-09 Pay supplier.** Allocated to supplier bills or on account.
- **UC-10 Expense.** Rent, wages, electricity, loading/unloading, fuel, misc. — with GST input (ITC) where there's a GST bill.
- **UC-11 Stock adjustment.** Weighbridge difference, cutting scrap, damage/rust, count correction — with reason, owner approval.
- **UC-12 Payment reminder.** From outstanding list → opens WhatsApp with a prefilled Tamil/English message and UPI link. No paid API.

### Setup
- **UC-20** Shop settings: name (EN/TA), address, GSTIN, state, bank, UPI ID, logo, invoice series, financial year.
- **UC-21** Product master with HSN, GST rate, units/conversions, min stock, custom fields, EN + TA names.
- **UC-22** Party master (customer / supplier / both) with GSTIN, state, credit limit, credit days, opening balance, price level, party-wise rates.
- **UC-23** Opening stock (qty + cost) and opening balances on go-live date.
- **UC-24** Users, PINs, roles, devices.

### Reports (all filterable by date range, exportable to Excel/PDF)
- **R-01** Day book (all transactions of a day) and cash/bank book
- **R-02** Sales register, purchase register (with GST split)
- **R-03** Stock summary (qty in base + alternate units, value at average cost), stock ledger per item, low-stock list
- **R-04** Customer outstanding with ageing (0–30 / 31–60 / 61–90 / 90+), customer statement (shareable PDF)
- **R-05** Supplier payables and statement
- **R-06** Bill-wise profit, party-wise profit, item-wise profit
- **R-07** Monthly P&L (sales, COGS, gross profit, expenses by category, net profit)
- **R-08** GST: GSTR-1 data (B2B, B2CS, HSN summary, credit notes) as Excel + JSON for the CA; GSTR-3B summary; ITC from purchases and expenses
- **R-09** Steel: kg sold per size per day/month, average realised rate vs. base rate

### System
- **UC-30** Language switch (English / தமிழ்) per user; invoice language chosen per bill.
- **UC-31** Sync PC ↔ cloud ↔ phones (see §6).
- **UC-32** Automatic nightly backup to Google Drive + manual backup to USB; restore with confirmation.
- **UC-33** Audit log and recycle bin (soft-deleted masters can be restored).

---

## 5. Business rules

### 5.1 Money and quantities
- **Money is stored as integer paise** (₹10.50 → `1050`). Never floating point.
- **Quantities are stored as integer thousandths of the base unit** (`qty_milli`): 147.350 kg → `147350`; 12 bags → `12000`.
- **GST rates are stored in basis points** (18% → `1800`).
- Conversions between units use integer maths with a single, explicit rounding step.

### 5.2 GST calculation (per line, then summed)
1. `line_value = round(qty × rate)` (paise), minus line discount → **taxable value**.
2. Intra-state (customer state = shop state, or unregistered customer in same state): `CGST = SGST = round(taxable × rate / 2)`.
3. Inter-state: `IGST = round(taxable × rate)`.
4. Bill total = Σ taxable + Σ tax; **round-off** to the nearest rupee shown as a separate line.
5. Rates can be entered **inclusive** of GST (common when quoting customers); the app back-calculates the taxable value.
6. Place of supply = customer's state (from GSTIN or address); defaults to the shop's state.
7. If the shop is on the **composition scheme**, documents print as *Bill of Supply* with no tax lines (setting).

### 5.3 Invoice numbering (CGST Rule 46)
- Unique per **financial year (Apr–Mar)**, consecutive, **max 16 characters**, only letters, digits, `-` and `/`.
- Format: `{prefix}/{FY}/{n}` e.g. `ST/26-27/0001` (13 chars).
- **Each device has its own series** so offline devices never collide: PC `ST/26-27/0001`, phone 1 `ST/26-27/M10001`. Numbers are assigned at save, never reused; cancelled bills keep their number.
- Separate series for credit notes (`CN/…`), quotations (`QT/…`), receipts (`RC/…`).

### 5.4 Stock and cost
- Stock is **never stored as a number** — it is the sum of the stock movements ledger (opening + purchases − sales ± returns ± adjustments).
- Cost uses **weighted average**; the cost at the time of sale is snapshotted on each sale line so past profit never changes.
- Billing more than available stock: warn (owner can allow); setting to block.

### 5.5 Credit
- Credit limit check on save: warn for Billing role, owner can override with a reason. Setting to block.
- Credit days drive the "overdue" flag and ageing buckets.

### 5.6 Editing and audit
- Saved bills, receipts and purchases are **immutable**. Corrections go through cancel + re-issue, returns, or adjustments. This keeps sync conflict-free and gives the CA a clean trail.
- Masters (products, parties) are editable; every change is audited. Deletes are soft (recycle bin).

### 5.7 Accounting
- Every saved document also posts **double-entry ledger lines** (accounts: Cash, Bank, UPI clearing, Sales, Purchases, Output CGST/SGST/IGST, Input CGST/SGST/IGST, each party, each expense head, Round-off, Stock adjustment). Release 1 uses this for party balances, cash book and P&L; Release 2 adds journal entries, trial balance and balance sheet on top — no data migration needed.

---

## 6. Architecture

```
┌──────────── Shop PC (Windows) ─────────────┐        ┌── Turso (free) ──┐
│ Node.js (Fastify) server                    │  sync  │ cloud SQLite     │
│  ├─ serves React app (browser / PWA)        │◄──────►│ (sync hub only)  │
│  ├─ REST API + business rules               │        └────────▲─────────┘
│  └─ SQLite file (WAL)  ── nightly ──► Google Drive backup      │ sync
└─────────────────────────────────────────────┘                  │
        ▲ LAN (same Wi-Fi): phones can also use the PC directly   │
┌───────┴──────── Android phone (APK via Capacitor) ─────────────┴──┐
│ Same React app + local SQLite; works offline, syncs when online     │
└────────────────────────────────────────────────────────────────────┘
```

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere |
| UI | React + Vite, PWA; component library TBD in scaffold (keyboard-first counter screen) |
| Server (PC) | Node.js LTS, Fastify, Zod validation |
| Database | SQLite (libSQL client), WAL mode, Drizzle ORM + SQL migrations |
| Shared core | `packages/core`: money/qty maths, GST, numbering, validation — **one implementation used by PC and phone** |
| Mobile | Capacitor Android APK, installed directly (no Play Store) |
| Cloud sync | Turso free plan |
| i18n | react-i18next; Noto Sans Tamil |
| Invoice output | HTML invoice template → browser print / save as PDF (handles Tamil text shaping correctly); A4 and A5 layouts |
| Backup | Node job → SQLite online backup → Google Drive (OAuth, your account) + USB |
| Run on PC | Windows service (auto-start), app opens in Chrome/Edge as an installed app |

### 6.1 Sync design
- Every row has a **UUIDv7 text id**, `updated_at`, `device_id`, `deleted` — no auto-increment ids anywhere.
- Each device writes changes to a local **outbox**; a sync worker pushes to Turso and pulls others' changes.
- **Documents (bills, receipts, purchases) are append-only**, so two devices can never edit the same document → no conflicts.
- **Masters** use last-writer-wins per row by `updated_at` (hybrid logical clock), with the audit log keeping the losing version.
- Stock and balances are always **derived**, never synced as numbers, so they converge automatically.
- **Spike first:** test Turso's native offline sync for Node and Capacitor. If it's not production-ready, use our own outbox over Turso's HTTP API (design above works either way).

### 6.2 Security
- Phones get a **per-device Turso token**; tokens can be revoked if a phone is lost.
- PINs stored hashed; owner-only actions re-ask the PIN.
- The PC server listens only on the shop LAN.

---

## 7. Screens (Release 1)

1. **Login** (user + PIN, language toggle)
2. **Dashboard** — today's sales, cash in hand, receivables, overdue, low stock, today's steel rate
3. **New Bill** — keyboard-first: customer, items, unit picker (bundle/rod/kg), live totals, payment, save & print
4. **Bills list** — search, filter, reprint, return, cancel
5. **Quotations** — list, convert to bill
6. **Receive payment** / **Pay supplier**
7. **Purchases** — entry and list
8. **Expenses**
9. **Stock** — summary, item ledger, adjustments
10. **Parties** — customers/suppliers, statement, WhatsApp reminder
11. **Products** — master, units, party-wise rates
12. **Today's rates** — steel base rate + size extras
13. **Reports** (R-01 … R-09)
14. **Settings** — shop, GST, invoice series, users, devices, backup, sync status

Mobile (Release 1): dashboard, stock lookup, customer outstanding, receive payment, quotation, and bill creation on its own invoice series.

---

## 8. English + Tamil

- All UI text in `locales/en.json` and `locales/ta.json`; no hard-coded strings (checked in CI).
- Products, units, expense heads and parties have `name_en` and `name_ta`; display falls back to English if Tamil is empty.
- Invoice language per bill (default from the customer); amount in words in English (Indian system: lakh/crore) or Tamil.
- Numbers always in Indian format (12,34,567.00); dates `dd-mm-yyyy`.
- Search matches both English and Tamil names (e.g. typing "கம்பி" or "tmt").
- Tamil translations drafted by me, reviewed by the family before go-live.

---

## 9. Non-functional requirements

| Area | Target |
|---|---|
| Bill entry | ≤ 60 s for a 5-line bill; no screen > 300 ms on the shop PC |
| Offline | PC fully usable with no internet; sync resumes automatically |
| Data size | ~100 bills/day for 10 years well within SQLite and Turso free limits |
| Backups | Nightly to Drive (keep 30 daily + 12 monthly), manual USB backup, tested restore |
| Printing | Canon PIXMA G3730 (A4/A5) |
| Testing | Unit tests for all money/GST/qty maths; end-to-end test for bill → stock → balance → GSTR-1 |

---

## 10. Release plan

| Milestone | Content |
|---|---|
| **M0 Spike** (2–3 days) | Monorepo scaffold, SQLite + Turso sync test on Node and Capacitor, Tamil HTML-to-PDF print test |
| **M1 Masters** | Settings, users/PIN, products/units, parties, opening stock and balances, EN/TA |
| **M2 Steel billing end-to-end** | Today's rates, New Bill, invoice print/PDF/WhatsApp, UPI QR, receipts, bills list, cancel |
| **M3 Purchases & stock** | Purchases, returns, supplier payments, expenses, adjustments, stock reports |
| **M4 Accounts & reports** | Ledger posting, outstanding/ageing, P&L, profit reports, GSTR exports, backup/restore |
| **M5 Mobile** | APK, sync, mobile screens, per-device series |
| **M6 Other product lines + go-live** | Cement/paint/plumbing/fencing data load, parallel run vs current method, training |

### Release 2 (after Release 1 is stable)
E-way bill data preparation (API later via a GSP), weighing-scale integration, godown/yard, journal entries, trial balance, balance sheet, Tally export, barcode labels for paint/plumbing.

---

## 11. Open questions for the family and the CA

1. GST registration: **regular or composition**? Shop state and GSTIN?
2. Invoice prefix and starting number (continuing an existing series?).
3. Do customers get rates **inclusive or exclusive** of GST when quoted?
4. How are transport/loading charged — separate line, included in rate, or not billed?
5. Which GST rate and HSN codes does the CA use for each product line? (App stores these as master data; nothing hard-coded.)
6. How many people bill at the same time, and on which devices?
7. A4 or A5 invoice? Tamil, English or both on printed bills?
8. How often do steel loads need an e-way bill (consignments above ₹50,000)?
9. Current credit practice: typical credit days, any interest on overdue?
10. Go-live date and what the shop uses today (to plan data migration and a parallel run).
