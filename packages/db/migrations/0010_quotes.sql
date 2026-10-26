-- Quotations (doc_type 'QT' in sales_docs; no stock moves, ledger entries or GST effect).
-- The link to the bill a quote became is kept on the quote, not in the bill's ref_doc_id: registers,
-- the stock ledger and GSTR-1 read ref_doc_id of a sales document as "the invoice a credit note is against".
ALTER TABLE sales_docs ADD COLUMN converted_bill_id TEXT REFERENCES sales_docs(id);
-- Last date the quoted rates are offered (printed on the quotation); NULL = not stated.
ALTER TABLE sales_docs ADD COLUMN valid_until TEXT;
