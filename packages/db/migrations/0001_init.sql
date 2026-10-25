-- =====================================================================
-- Tula — billing, stock and accounts — SQLite schema
-- Conventions
--   * Every synced table: id TEXT (UUIDv7), created_at, updated_at,
--     device_id, deleted (soft delete). No AUTOINCREMENT ids except the
--     local-only sync_outbox.
--   * Money: INTEGER paise.  Quantity: INTEGER thousandths of a unit
--     (qty_milli).  GST rate: INTEGER basis points (18% = 1800).
--   * Dates: TEXT 'YYYY-MM-DD'.  Timestamps: TEXT ISO-8601 UTC.
--   * Documents (sales, purchases, money, adjustments) are append-only;
--     corrections are new documents (credit/debit notes, cancellations).
-- =====================================================================

-- ---------- System -----------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,           -- see packages/core/src/settings.ts for the registry
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id  TEXT NOT NULL
);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,             -- e.g. "Counter PC", "Owner's phone"
  series_code  TEXT NOT NULL UNIQUE,      -- '' for PC, 'M1', 'M2' for phones
  is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  revoked      INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','billing','viewer')),
  lang        TEXT,                       -- UI language; NULL = business default
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

-- One row per (document type, device, financial year). Only the owning
-- device ever increments next_no, so this never conflicts in sync.
CREATE TABLE number_series (
  id          TEXT PRIMARY KEY,
  doc_type    TEXT NOT NULL CHECK (doc_type IN ('INV','QT','CN','RCPT','PAY','PUR','DN','EXP','ADJ')),
  owner_device TEXT NOT NULL REFERENCES devices(id),
  fy          TEXT NOT NULL,              -- '26-27'
  prefix      TEXT NOT NULL,              -- 'ST'
  next_no     INTEGER NOT NULL DEFAULT 1,
  pad         INTEGER NOT NULL DEFAULT 4,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (doc_type, owner_device, fy)
);

-- ---------- Masters ----------------------------------------------------
CREATE TABLE units (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,       -- KG, ROD, BDL, BAG, LTR, TIN, NOS, MTR, ROLL
  name_en     TEXT NOT NULL,
  name_ta     TEXT,
  gst_uqc     TEXT,                       -- GST unit code for GSTR-1 HSN summary: KGS, BAG, LTR, NOS, MTR...
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  is_service  INTEGER NOT NULL DEFAULT 0 CHECK (is_service IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  name_en     TEXT NOT NULL,
  name_ta     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id              TEXT PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,   -- business's own item code
  name_en         TEXT NOT NULL,
  name_ta         TEXT,
  category_id     TEXT NOT NULL REFERENCES categories(id),
  brand           TEXT,
  hsn             TEXT,
  gst_bp          INTEGER NOT NULL CHECK (gst_bp BETWEEN 0 AND 4000),
  base_unit_id    TEXT NOT NULL REFERENCES units(id),
  track_stock     INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0,1)),
  min_stock_milli INTEGER NOT NULL DEFAULT 0,
  -- Pricing: 'fixed' uses sale_rate_paise; 'daily' = today's group rate + extra
  rate_mode       TEXT NOT NULL DEFAULT 'fixed' CHECK (rate_mode IN ('fixed','daily')),
  rate_group      TEXT,                   -- rate_groups.code when rate_mode = 'daily'
  rate_extra_paise INTEGER NOT NULL DEFAULT 0,   -- size extra per base unit
  sale_rate_paise INTEGER NOT NULL DEFAULT 0,    -- per rate unit below, excl. GST
  rate_unit_id    TEXT REFERENCES units(id),     -- unit the rate is quoted in (default base)
  attrs_json      TEXT NOT NULL DEFAULT '{}',    -- free-form attributes, e.g. {"size_mm":12,"grade":"Fe550D"}
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_products_category ON products(category_id);

-- Alternate units: how many base-unit thousandths are in ONE of this unit.
-- 12 mm TMT, 12 m rod: 1 ROD = 10.667 kg -> factor_milli = 10667
-- 1 BDL (5 rods) = 53.333 kg -> 53333 ;  20 L tin of paint -> 20000
CREATE TABLE product_units (
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  unit_id       TEXT NOT NULL REFERENCES units(id),
  factor_milli  INTEGER NOT NULL CHECK (factor_milli > 0),
  is_theoretical INTEGER NOT NULL DEFAULT 0,   -- 1 = calculated weight, not weighed (e.g. steel rods)
  on_bill       INTEGER NOT NULL DEFAULT 1,    -- offer this unit as a quantity box on the bill
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, unit_id)
);

-- Rate groups: products whose price follows a rate set each day (e.g. TMT bars ₹/kg).
-- Fully data-driven: a business can have none, one or many groups.
CREATE TABLE rate_groups (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,     -- referenced by products.rate_group
  name_en       TEXT NOT NULL,
  name_ta       TEXT,
  unit_id       TEXT REFERENCES units(id),-- unit the rate is quoted per (e.g. KG)
  show_on_topbar INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);

-- Base rate per rate group per day (excl. GST).
CREATE TABLE daily_rates (
  id          TEXT PRIMARY KEY,
  rate_group  TEXT NOT NULL,
  rate_date   TEXT NOT NULL,
  rate_paise  INTEGER NOT NULL CHECK (rate_paise >= 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (rate_group, rate_date)
);

CREATE TABLE price_levels (
  id          TEXT PRIMARY KEY,
  name_en     TEXT NOT NULL,
  name_ta     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE parties (
  id                 TEXT PRIMARY KEY,
  party_type         TEXT NOT NULL CHECK (party_type IN ('customer','supplier','both')),
  name_en            TEXT NOT NULL,
  name_ta            TEXT,
  mobile             TEXT,
  address            TEXT,
  gstin              TEXT,
  state_code         TEXT NOT NULL,       -- GST state code, e.g. '33'
  credit_limit_paise INTEGER NOT NULL DEFAULT 0,  -- 0 = no limit
  credit_days        INTEGER NOT NULL DEFAULT 0,
  opening_balance_paise INTEGER NOT NULL DEFAULT 0, -- + they owe us, - we owe them
  opening_date       TEXT,
  price_level_id     TEXT REFERENCES price_levels(id),
  lang               TEXT,                -- preferred bill language; NULL = business default
  is_walk_in         INTEGER NOT NULL DEFAULT 0 CHECK (is_walk_in IN (0,1)), -- counter / cash sales account
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_parties_mobile ON parties(mobile);

-- Rate resolution order: party_rates -> product_prices (party's level) -> daily/fixed rate
CREATE TABLE product_prices (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products(id),
  price_level_id  TEXT NOT NULL REFERENCES price_levels(id),
  rate_paise      INTEGER,                -- absolute rate, or
  adjust_paise    INTEGER,                -- +/- on top of the daily/fixed rate
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, price_level_id)
);

CREATE TABLE party_rates (
  id            TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES parties(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  rate_paise    INTEGER,
  adjust_paise  INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (party_id, product_id)
);

CREATE TABLE expense_heads (
  id          TEXT PRIMARY KEY,
  name_en     TEXT NOT NULL,
  name_ta     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

-- ---------- Sales documents (invoice, quotation, credit note) ----------
CREATE TABLE sales_docs (
  id              TEXT PRIMARY KEY,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('INV','QT','CN')),
  doc_no          TEXT NOT NULL CHECK (length(doc_no) <= 16),
  doc_kind        TEXT NOT NULL DEFAULT 'tax_invoice' CHECK (doc_kind IN ('tax_invoice','bill_of_supply')),
  doc_date        TEXT NOT NULL,
  fy              TEXT NOT NULL,
  party_id        TEXT NOT NULL REFERENCES parties(id),
  -- snapshot of party details at time of billing (masters can change later)
  party_name      TEXT NOT NULL,
  party_gstin     TEXT,
  party_address   TEXT,
  place_of_supply TEXT NOT NULL,          -- state code
  supply_type     TEXT NOT NULL CHECK (supply_type IN ('intra','inter')),
  site            TEXT,                   -- construction site / project
  ref_doc_id      TEXT REFERENCES sales_docs(id),   -- CN -> original INV; INV -> source QT
  lang            TEXT NOT NULL,
  taxable_paise   INTEGER NOT NULL,
  cgst_paise      INTEGER NOT NULL DEFAULT 0,
  sgst_paise      INTEGER NOT NULL DEFAULT 0,
  igst_paise      INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  total_paise     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason   TEXT,
  cancelled_at    TEXT,
  cancelled_by    TEXT REFERENCES users(id),
  notes           TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (doc_type, fy, doc_no),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + round_off_paise)
);
CREATE INDEX ix_sales_docs_party ON sales_docs(party_id, doc_date);
CREATE INDEX ix_sales_docs_date  ON sales_docs(doc_type, doc_date);

CREATE TABLE sales_doc_lines (
  id                TEXT PRIMARY KEY,
  doc_id            TEXT NOT NULL REFERENCES sales_docs(id),
  line_no           INTEGER NOT NULL,
  product_id        TEXT NOT NULL REFERENCES products(id),
  description       TEXT NOT NULL,        -- printed text, in the bill's language
  hsn               TEXT,
  entry_json        TEXT,                 -- how it was keyed in: {"BDL":10,"ROD":4} or {"KG":147.35,"weighed":true}
  base_qty_milli    INTEGER NOT NULL,     -- for stock
  rate_unit_id      TEXT NOT NULL REFERENCES units(id),
  rate_qty_milli    INTEGER NOT NULL,     -- quantity in the rate unit (printed)
  rate_paise        INTEGER NOT NULL,     -- excl. GST, per rate unit
  discount_paise    INTEGER NOT NULL DEFAULT 0,
  taxable_paise     INTEGER NOT NULL,
  gst_bp            INTEGER NOT NULL,
  cgst_paise        INTEGER NOT NULL DEFAULT 0,
  sgst_paise        INTEGER NOT NULL DEFAULT 0,
  igst_paise        INTEGER NOT NULL DEFAULT 0,
  line_total_paise  INTEGER NOT NULL,
  cost_per_base_paise INTEGER,            -- weighted-average cost snapshot (INV/CN only)
  cost_total_paise  INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  deleted           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (doc_id, line_no)
);
CREATE INDEX ix_sales_lines_product ON sales_doc_lines(product_id);

-- ---------- Purchase documents (purchase bill, debit note) -------------
CREATE TABLE purchase_docs (
  id              TEXT PRIMARY KEY,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('PUR','DN')),
  doc_no          TEXT NOT NULL,          -- our internal number
  supplier_bill_no TEXT,                  -- number on the supplier's invoice
  doc_date        TEXT NOT NULL,
  fy              TEXT NOT NULL,
  party_id        TEXT NOT NULL REFERENCES parties(id),
  supply_type     TEXT NOT NULL CHECK (supply_type IN ('intra','inter')),
  ref_doc_id      TEXT REFERENCES purchase_docs(id),
  taxable_paise   INTEGER NOT NULL,
  cgst_paise      INTEGER NOT NULL DEFAULT 0,
  sgst_paise      INTEGER NOT NULL DEFAULT 0,
  igst_paise      INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  total_paise     INTEGER NOT NULL,
  itc_eligible    INTEGER NOT NULL DEFAULT 1,
  due_date        TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  notes           TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (doc_type, fy, doc_no)
);

CREATE TABLE purchase_doc_lines (
  id                TEXT PRIMARY KEY,
  doc_id            TEXT NOT NULL REFERENCES purchase_docs(id),
  line_no           INTEGER NOT NULL,
  product_id        TEXT REFERENCES products(id),   -- NULL for freight/loading lines
  description       TEXT NOT NULL,
  base_qty_milli    INTEGER NOT NULL DEFAULT 0,
  rate_unit_id      TEXT REFERENCES units(id),
  rate_qty_milli    INTEGER NOT NULL DEFAULT 0,
  rate_paise        INTEGER NOT NULL DEFAULT 0,
  discount_paise    INTEGER NOT NULL DEFAULT 0,
  taxable_paise     INTEGER NOT NULL,
  gst_bp            INTEGER NOT NULL,
  cgst_paise        INTEGER NOT NULL DEFAULT 0,
  sgst_paise        INTEGER NOT NULL DEFAULT 0,
  igst_paise        INTEGER NOT NULL DEFAULT 0,
  line_total_paise  INTEGER NOT NULL,
  landed_cost_paise INTEGER,              -- taxable + share of freight, used for average cost
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  deleted           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (doc_id, line_no)
);

-- ---------- Money (receipts from customers, payments to suppliers) -----
CREATE TABLE money_docs (
  id            TEXT PRIMARY KEY,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('RCPT','PAY')),
  doc_no        TEXT NOT NULL,
  doc_date      TEXT NOT NULL,
  fy            TEXT NOT NULL,
  party_id      TEXT NOT NULL REFERENCES parties(id),
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
  mode          TEXT NOT NULL CHECK (mode IN ('cash','upi','bank','cheque')),
  reference     TEXT,                     -- UTR / cheque no
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  notes         TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (doc_type, fy, doc_no)
);

-- Which bills a receipt/payment settles. Unallocated remainder = advance.
CREATE TABLE money_allocations (
  id            TEXT PRIMARY KEY,
  money_doc_id  TEXT NOT NULL REFERENCES money_docs(id),
  sales_doc_id    TEXT REFERENCES sales_docs(id),
  purchase_doc_id TEXT REFERENCES purchase_docs(id),
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  CHECK ((sales_doc_id IS NULL) <> (purchase_doc_id IS NULL))
);

-- ---------- Expenses ---------------------------------------------------
CREATE TABLE expenses (
  id             TEXT PRIMARY KEY,
  doc_no         TEXT NOT NULL,
  doc_date       TEXT NOT NULL,
  fy             TEXT NOT NULL,
  head_id        TEXT NOT NULL REFERENCES expense_heads(id),
  party_id       TEXT REFERENCES parties(id),
  vendor_gstin   TEXT,
  taxable_paise  INTEGER NOT NULL,
  gst_bp         INTEGER NOT NULL DEFAULT 0,
  cgst_paise     INTEGER NOT NULL DEFAULT 0,
  sgst_paise     INTEGER NOT NULL DEFAULT 0,
  igst_paise     INTEGER NOT NULL DEFAULT 0,
  total_paise    INTEGER NOT NULL,
  itc_eligible   INTEGER NOT NULL DEFAULT 0,
  mode           TEXT NOT NULL CHECK (mode IN ('cash','upi','bank','cheque','credit')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  notes          TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (fy, doc_no)
);

-- ---------- Stock ------------------------------------------------------
CREATE TABLE stock_adjustments (
  id           TEXT PRIMARY KEY,
  doc_no       TEXT NOT NULL,
  doc_date     TEXT NOT NULL,
  fy           TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('opening','weight_diff','scrap','damage','count','other')),
  notes        TEXT,
  approved_by  TEXT REFERENCES users(id),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (fy, doc_no)
);

CREATE TABLE stock_adjustment_lines (
  id             TEXT PRIMARY KEY,
  adjustment_id  TEXT NOT NULL REFERENCES stock_adjustments(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  qty_milli      INTEGER NOT NULL,        -- signed
  cost_per_base_paise INTEGER,            -- required for 'opening'
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0
);

-- The stock ledger. Every document that moves goods writes rows here.
-- Stock on hand = SUM(qty_milli). Never stored anywhere else.
CREATE TABLE stock_moves (
  id            TEXT PRIMARY KEY,
  move_date     TEXT NOT NULL,
  product_id    TEXT NOT NULL REFERENCES products(id),
  qty_milli     INTEGER NOT NULL,         -- + in, - out
  value_paise   INTEGER,                  -- inward cost value (for weighted average)
  source_type   TEXT NOT NULL CHECK (source_type IN ('INV','CN','PUR','DN','ADJ')),
  source_id     TEXT NOT NULL,
  source_line_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_stock_moves_product ON stock_moves(product_id, move_date);

-- ---------- Accounting (double entry, posted automatically) ------------
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,       -- CASH, BANK, UPI, SALES, PURCH, OUT_CGST, IN_SGST, PARTY:<id>, EXP:<id>...
  name_en     TEXT NOT NULL,
  name_ta     TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('asset','liability','income','expense','equity')),
  party_id    TEXT REFERENCES parties(id),
  expense_head_id TEXT REFERENCES expense_heads(id),
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ledger_entries (
  id            TEXT PRIMARY KEY,
  entry_date    TEXT NOT NULL,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  debit_paise   INTEGER NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise  INTEGER NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  source_type   TEXT NOT NULL,            -- INV, CN, PUR, DN, RCPT, PAY, EXP, ADJ, OPEN, JV
  source_id     TEXT NOT NULL,
  narration     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  CHECK ((debit_paise = 0) <> (credit_paise = 0))
);
CREATE INDEX ix_ledger_account ON ledger_entries(account_id, entry_date);
CREATE INDEX ix_ledger_source  ON ledger_entries(source_type, source_id);

-- ---------- Audit and sync ---------------------------------------------
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  user_id      TEXT,
  entity       TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('create','update','cancel','delete','restore','login','override')),
  before_json  TEXT,
  after_json   TEXT,
  reason       TEXT,
  device_id    TEXT NOT NULL
);
CREATE INDEX ix_audit_entity ON audit_log(entity, entity_id);

-- Local only (never synced): pending changes to push.
CREATE TABLE sync_outbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE sync_state (
  key    TEXT PRIMARY KEY,                -- last_pull_cursor, last_push_at, ...
  value  TEXT NOT NULL
);

-- ---------- Views ------------------------------------------------------
CREATE VIEW v_stock_on_hand AS
SELECT p.id AS product_id, p.sku, p.name_en, p.name_ta,
       COALESCE(SUM(m.qty_milli), 0) AS qty_milli,
       p.min_stock_milli,
       CASE WHEN COALESCE(SUM(m.qty_milli),0) < 0 THEN 'NEGATIVE'
            WHEN COALESCE(SUM(m.qty_milli),0) = 0 THEN 'OUT'
            WHEN COALESCE(SUM(m.qty_milli),0) <= p.min_stock_milli THEN 'LOW'
            ELSE 'OK' END AS status
FROM products p
LEFT JOIN stock_moves m ON m.product_id = p.id AND m.deleted = 0
WHERE p.deleted = 0 AND p.track_stock = 1
GROUP BY p.id;

-- Weighted-average cost per base unit (paise), from all inward moves.
CREATE VIEW v_avg_cost AS
SELECT product_id,
       CASE WHEN SUM(qty_milli) > 0
            THEN (SUM(value_paise) * 1000 + SUM(qty_milli) / 2) / SUM(qty_milli)
            ELSE 0 END AS avg_cost_per_base_paise
FROM stock_moves
WHERE deleted = 0 AND qty_milli > 0 AND value_paise IS NOT NULL
GROUP BY product_id;

-- Party balance from the ledger: + means the party owes the shop.
CREATE VIEW v_party_balance AS
SELECT a.party_id,
       SUM(e.debit_paise) - SUM(e.credit_paise) AS balance_paise
FROM ledger_entries e
JOIN accounts a ON a.id = e.account_id
WHERE a.party_id IS NOT NULL AND e.deleted = 0
GROUP BY a.party_id;
