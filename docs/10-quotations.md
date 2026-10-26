# Quotations (estimates)

Billing → **Quotations**. Owners and counter staff can make them; view-only users can see them.

## What a quotation is
The customer asks "how much for 250 kg of 12 mm TMT and 40 bags of cement?" before buying. A quotation is priced exactly like a bill (today's rate, the customer's own rates, GST, round-off), printed or shared the same way, but **nothing changes**: no stock goes out, the customer owes nothing, and it is not in the sales register, GST returns or profit reports. Quotations have their own numbers: `QT/26-27/0001` (phones and second computers add their series code, like bills).

## Make a quotation
1. Billing → Quotations → **New quotation**. It is the bill screen, without the payment box.
2. Pick the customer, the site, the items and quantities as for a bill. Change a rate if you agree a special price.
3. **Valid until** (optional) is printed on the quotation. After that date the list shows it as *Past date*; it can still become a bill.
4. **Save quotation**, then **Open quotation** to print it or **Share** it (WhatsApp picture). The printed copy says *Quotation*, shows no UPI QR code and notes that prices may change.

## Make a bill from it
When the customer buys: Quotations → **Make bill** on the row (or **Make bill** on the printed quotation).
- The bill uses **today's rates**. The panel shows the quoted rate and today's rate side by side, and marks rates that changed.
- Tick **Keep the quoted rates** to bill at the price you quoted.
- Stock and credit-limit warnings appear now, as on a bill; **Save anyway** if you agree.
- The bill opens for printing. The quotation shows *Billed* with the bill number, and cannot become a second bill. If that bill is later cancelled, the quotation is open again.

**Cancel** a quotation the customer won't take (it stays in the list, marked *Cancelled*). A quotation that is already a bill can't be cancelled; cancel the bill instead.

To add a payment taken when billing, use Receipts after making the bill.

## For developers
- Server: `apps/server/src/quotes.ts` (registered in `api.ts`, so it runs on phones too). A quotation is a `sales_docs` row with `doc_type = 'QT'` and its `sales_doc_lines`; no `stock_moves`, `ledger_entries` or `money_docs`. Every report, balance and register already reads only `INV` / `CN`. Numbers come from `nextNumber(…, 'QT', …)` (prefix `QT`, per device and financial year).
- Migration `0010_quotes.sql`: `sales_docs.converted_bill_id` (the bill a quotation became) and `sales_docs.valid_until`. The link is kept on the quotation, **not** in the bill's `ref_doc_id`: registers, the stock ledger and GSTR-1 read `ref_doc_id` of a sales document as the invoice a credit note is against.
- Pricing: `priceQuote` = `priceBill` with stock and credit warnings dropped. Converting: `billFromQuote` rebuilds a `BillInput` from the quotation's lines (entry, discount, inclusive flag; the rate only with `keepRates`) and calls `createBill(…, { fromQuote })`; `markQuoteConverted` (bills.ts) checks and records the conversion in the bill's transaction.
- API: `POST /api/quotes/preview`, `POST /api/quotes`, `GET /api/quotes?from&to&q`, `GET /api/quotes/:id` (the bill shape plus `quote: { state, bill, validUntil }`), `POST /api/quotes/:id/convert/preview` and `/convert` (`{ keepRates, confirmWarnings, payment? }`; 409 with warnings like a bill), `POST /api/quotes/:id/cancel`. Billing staff may use all the POSTs (`BILLING_WRITES` in `auth.ts`).
- States: `open`, `expired` (open, past `valid_until`), `converted` (its bill is not cancelled), `cancelled`.
- Web: `screens/Quotes.tsx` (list, `NewQuote` = `NewBill mode="quote"`, the Make bill sheet, `QuoteActions` on the printed view), `api/quotes.ts`, strings in `locales/*/quotes.json`.
- Two devices converting the same quotation while offline make two bills (last writer wins on `converted_bill_id`); cancel one of them.
- Tests: `apps/server/test/quotes.test.ts`, also on the phone stack.
