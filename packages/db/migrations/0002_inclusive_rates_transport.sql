-- Rates typed or configured as GST-inclusive, and transport details for e-way bills.
ALTER TABLE sales_doc_lines ADD COLUMN rate_inclusive INTEGER NOT NULL DEFAULT 0 CHECK (rate_inclusive IN (0,1));
ALTER TABLE sales_docs ADD COLUMN vehicle_no TEXT;
ALTER TABLE sales_docs ADD COLUMN eway_bill_no TEXT;
