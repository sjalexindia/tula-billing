# Phase 1 — complete shop day

Date: 26 Oct 2026

Phase 1 covers everything a building-materials shop does in a day, on the shop computer, with phones on the same Wi-Fi and a cloud copy.

## Delivered
| Area | What works |
|---|---|
| Billing | GST bills (inclusive or exclusive rates), steel by bundle / rod / kg, transport lines, e-way bill reminder, Tamil / English / bilingual print, UPI QR, continuing a paper bill series |
| Mistakes | Cancel with reason (same-day; earlier months steer to a credit note), sales returns as credit notes, receipt cancellation |
| Money in | Receipts allocated to bills (opening balance first, then oldest), advances, refunds from advances, outstanding with ageing and interest, customer statements |
| Purchases | Purchase bills with freight and ITC / no-ITC, debit notes, supplier payments, expenses by head |
| Stock | Live stock and value, weighted average cost, counts and corrections, opening stock |
| Reports | Day book, cash & bank book, sales and purchase registers, steel sales vs rate, stock summary, P&L, profit by bill / customer / item, GSTR-1 (Excel + JSON), GSTR-3B, CMP-08; print and Excel for all |
| People | PIN sign-in, owner / billing / view-only roles enforced by the server, friendly refusal on owner screens, `reset-pin` for a forgotten owner PIN |
| Running the shop PC | Windows install script, auto-start before sign-in, supervisor that restarts on crash or freeze, daily verified backups with retention, restore from the app, update with rollback ([06](06-install-and-run.md)) |
| Sync and phones | Turso cloud copy, phones and a second computer, Android app ([07](07-sync-and-phones.md)) |

## Verified
- 154 automated tests (core 29, server 125), including a full shop day where purchases, bills, a return, a receipt, an expense and a stock count must agree across stock, ledger, outstanding, statement, sales register, P&L and GSTR-1; two bills saved at the same moment; a request arriving while a bill is being saved.
- Every screen in English and Tamil at 1366 px and 390 px: no page errors, no raw text keys, no sideways page scroll.
- All ten workflows driven in a real browser as owner and counter clerk; 11 issues found and fixed.
- Not yet run on a real Windows PC: the install / auto-start scripts were parsed and dry-run only.
- The automated tests also pass on Windows (October 2026). Running them there found that backups left temp files and restore could not replace the database, because the libSQL client keeps a file open after close() until garbage collection; backup files are now checked in memory (`ops/dbfile.ts`) and `closeDb()` lets go of a file at once.

## Known gaps (Phase 2 backlog)
- A lost phone can't be cut off at once without changing every device's token: Turso can't revoke one token. Each phone gets its own token that expires (30 days suggested), and Devices & sync warns before it runs out (docs/07 §2).

## Before go-live
See the questions list kept with the business profile (not in this repo). Install on the shop PC, enter opening stock and balances, set the next bill number, run alongside paper bills for a trial period.
