-- Purchases, debit notes, expenses and stock corrections (Phase 1).
-- New nullable columns only, so old rows stay valid.

-- Who cancelled a purchase bill or expense, when and why (sales_docs already has these).
ALTER TABLE purchase_docs ADD COLUMN cancel_reason TEXT;
ALTER TABLE purchase_docs ADD COLUMN cancelled_at TEXT;
ALTER TABLE purchase_docs ADD COLUMN cancelled_by TEXT REFERENCES users(id);
CREATE INDEX ix_purchase_docs_party ON purchase_docs(party_id, doc_date);
CREATE INDEX ix_purchase_docs_ref ON purchase_docs(ref_doc_id);

-- How the quantity was keyed in ({"BDL":"10"}), the share of freight/loading in landed cost,
-- and for a debit-note line the purchase line it returns.
ALTER TABLE purchase_doc_lines ADD COLUMN entry_json TEXT;
ALTER TABLE purchase_doc_lines ADD COLUMN charge_share_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_doc_lines ADD COLUMN ref_line_id TEXT REFERENCES purchase_doc_lines(id);
CREATE INDEX ix_purchase_lines_ref ON purchase_doc_lines(ref_line_id);

ALTER TABLE expenses ADD COLUMN reference TEXT;
ALTER TABLE expenses ADD COLUMN cancel_reason TEXT;
ALTER TABLE expenses ADD COLUMN cancelled_at TEXT;
ALTER TABLE expenses ADD COLUMN cancelled_by TEXT REFERENCES users(id);
CREATE INDEX ix_expenses_date ON expenses(doc_date);

-- Stock corrections by physical count keep what the system showed and what was counted;
-- every correction line keeps its value at average cost (signed).
ALTER TABLE stock_adjustment_lines ADD COLUMN system_milli INTEGER;
ALTER TABLE stock_adjustment_lines ADD COLUMN counted_milli INTEGER;
ALTER TABLE stock_adjustment_lines ADD COLUMN value_paise INTEGER;
