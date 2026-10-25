# Configuration

Tula has no business-specific values in code. Everything a business changes lives in one of four places.

| What | Where | Changed by |
|---|---|---|
| Business identity, GST scheme, invoice prefix and terms, languages, billing rules | **Settings** (`settings` table; registry in `packages/core/src/settings.ts`) | Owner, in the app's Settings screen |
| Products, units, categories, daily-rate groups | **Data** (tables), seeded from a **preset** on first run | Owner (Milestone 1 adds the screens) |
| Translations | `apps/web/src/locales/<lang>.json` | Developer / translator |
| Where the database lives, port, first-run preset | **Environment variables** | Whoever installs it |

## Settings
Every setting has a type, a default, and validation. The Settings screen is generated from the registry, so adding a setting there makes it appear in the app automatically.

| Key | Purpose |
|---|---|
| `business.*` | Name (English/Tamil), tagline, address, phone, email, state, UPI ID, bank details |
| `gst.scheme` | `regular` (tax invoice), `composition` or `unregistered` (bill of supply, no GST) |
| `gst.gstin` | Checked for format and against the business state |
| `business.legal_name` | Name on the GST certificate, printed under the trade name |
| `invoice.prefix`, `invoice.number_format`, `invoice.seq_digits`, `invoice.start_number` | Invoice numbering. Format tokens: `{prefix}` `{fy}` (26-27) `{yy}` (26) `{seq}`. `{seq}` with 1 digit and a start number continues a paper bill book (246, 247…). Numbers are checked against the 16-character GST limit. None of these can change once the year's first invoice exists (GST requires a consecutive series); numbering restarts at 1 each financial year |
| `invoice.default_lang`, `invoice.terms_<lang>`, `invoice.show_upi_qr`, `invoice.paper` | Printed bill options (A4/A5) |
| `invoice.label_mode` | `single` or `bilingual` (every label in both enabled languages, e.g. வரி விலைப்பட்டியல் / Tax Invoice) |
| `billing.rates_include_gst` | Rates are quoted including GST. The bill back-calculates the taxable value and the line total equals the quoted amount to the paisa |
| `billing.stock_check`, `billing.credit_check` | `warn` (ask before saving), `block` (refuse) or `off` |
| `eway.warn`, `eway.threshold_intra`, `eway.threshold_inter` | Reminder on the bill when goods (not services) exceed the state's limit. Inter-state is ₹50,000 everywhere; intra-state limits differ by state (Tamil Nadu: ₹1,00,000). Bills can carry a vehicle number |
| `credit.default_days`, `credit.interest_pa` | Defaults for new customers and overdue interest (used by outstanding reports in Milestone 4) |
| `app.languages`, `app.default_lang` | Which languages this business uses; the language switch hides when only one is enabled |

Billing is blocked until name, address, state and GSTIN (unless unregistered) are filled in.

## Presets
A preset is a JSON file in `apps/server/presets/`, loaded once on first run.

- `_base.json` is always loaded: common units of measure with GST unit codes, and a walk-in customer.
- `blank.json`: nothing else. The business adds its own items.
- `building-materials.json`: brand-neutral starter catalogue for steel, cement, paint, plumbing and fencing dealers. Rates start at 0. HSN codes and GST rates are typical values to be confirmed with the business's CA.

A preset can declare:
- **units**: `code`, names, GST UQC.
- **rateGroups**: products priced from a daily rate (e.g. TMT bars per kg). Each shows as a chip on the top bar.
- **categories** and **products**: each product has a base unit and optional larger units, given as a fixed `factor` (6 m per length), a `steelRod` theoretical weight, or a `multipleOf` another unit (bundle = N rods). The bill screen offers one quantity box per larger unit automatically.
- **demo**: sample business settings, customers, rates and opening stock, loaded only with `TULA_DEMO=1`.

To support a new trade (electricals, tiles, fertiliser…), add a preset file. No code changes are needed.

## Business profiles
A profile is one business's real details in a JSON file, applied on first run with `TULA_PROFILE=path/to/profile.json`, or later with `npm run apply-profile -w apps/server -- path/to/profile.json`. It can set a preset, any settings, product patches (e.g. add a brand to every `TMT-*` item), and today's daily rates. Settings are validated exactly as in the app. See [examples/business-profile.example.json](examples/business-profile.example.json).

Keep real profiles **out of this repository**. Never put sync tokens in a profile.

## Environment variables
| Variable | Default | |
|---|---|---|
| `TULA_DB` | `./data/tula.db` | SQLite file |
| `TULA_PORT` | `5000` | |
| `TULA_HOST` | `0.0.0.0` | Listens on the LAN so phones on the same Wi-Fi can connect |
| `TULA_PRESET` | `blank` | First-run catalogue |
| `TULA_DEMO` | unset | `1` loads the preset's demo data |
| `TULA_PROFILE` | unset | Business profile applied on first run |
| `TULA_SYNC_URL`, `TULA_SYNC_TOKEN` | unset | Cloud sync (Milestone 5). Secrets live only in the environment of the shop computer |

## Adding a language
1. Add `apps/web/src/locales/<code>.json` (copy `en.json`; a test-style check confirms keys match).
2. Register it in `apps/web/src/i18n.ts` and `SUPPORTED_LANGS` in `packages/core/src/settings.ts`.
3. Amount-in-words: add the language in `packages/core/src/words.ts` (falls back to English otherwise).
4. Product and party names currently have English and Tamil columns; a third language will need a translations table (planned when a customer needs it).
