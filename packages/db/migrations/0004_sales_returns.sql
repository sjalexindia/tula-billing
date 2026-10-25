-- Sales returns: each credit-note line points at the invoice line it returns,
-- so "already returned" is exact even after several partial returns.
ALTER TABLE sales_doc_lines ADD COLUMN ref_line_id TEXT REFERENCES sales_doc_lines(id);
CREATE INDEX ix_sales_lines_ref ON sales_doc_lines(ref_line_id);
CREATE INDEX ix_sales_docs_ref ON sales_docs(ref_doc_id);
CREATE INDEX ix_alloc_sales ON money_allocations(sales_doc_id);
CREATE INDEX ix_alloc_money ON money_allocations(money_doc_id);
