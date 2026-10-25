-- Who cancelled a receipt or payment, when and why (receipts and supplier payments).
ALTER TABLE money_docs ADD COLUMN cancel_reason TEXT;
ALTER TABLE money_docs ADD COLUMN cancelled_at TEXT;
ALTER TABLE money_docs ADD COLUMN cancelled_by TEXT REFERENCES users(id);
