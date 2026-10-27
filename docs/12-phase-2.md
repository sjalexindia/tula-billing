# Phase 2 — phones anywhere, Excel, quotations, and the Phase 1 backlog

Date: 27 Oct 2026. Branch `feature/phone-anywhere`.

## Delivered
| Area | What works | Doc |
|---|---|---|
| Phones that work anywhere | The Android app runs Tula on the phone (own database, same rules), bills with no internet and no shop computer, syncs through the cloud copy; series M1, M2… The app can still open Tula from the shop computer. | [07](07-sync-and-phones.md) |
| Excel | Import and export of items, customers and suppliers, opening stock: checked row by row, all-or-nothing, unchanged rows left alone. Report Excel downloads also in the app. | [09](09-excel.md) |
| Quotations | Priced like a bill, no stock or accounts effect, own numbers (QT), Make bill at the day's rates or the quoted ones, once. | [10](10-quotations.md) |
| Recycle bin | Unused items, customers, categories and expense heads can be deleted and restored; anything in use is refused. | [11](11-recycle-bin.md) |
| Settings | Saving keeps every valid change and marks refused ones with the reason. | [11](11-recycle-bin.md) |
| Stock in larger units | "46 Bundle + 13.35 Kg" (≈ for calculated weights) instead of rounding down. | [11](11-recycle-bin.md) |
| Tamil | Server messages, warnings, ledger narrations, GST report terms and state names in Tamil; a test fails when a new server message has no Tamil. | [03](03-configuration.md) |
| Share | Bills, receipts and statements as a picture or a PDF to WhatsApp, a printer app or Drive; Print on the computer. | [07](07-sync-and-phones.md) |
| Phone menu | All groups visible at phone width; printed bills fit the screen. | — |
| Google Drive backup | One tap to back up into a Google Drive for desktop folder. | [06](06-install-and-run.md) |
| Phone tokens | Each phone can have its own expiring token; Devices & sync warns before it runs out. | [07](07-sync-and-phones.md) |
| Signed APK | The Android workflow also builds a signed release APK when the signing secrets are set. | [07](07-sync-and-phones.md) |
| Windows | Backup and restore work on Windows (they never had); restore refuses backups from a newer Tula again. | [06](06-install-and-run.md) |
| Help | The user guide inside Tula in English and Tamil (the **?** button, every role, also in the phone app), with search and links between parts; [USER-GUIDE.md](USER-GUIDE.md) is the same text. | — |

## Verified
- Automated: core 30, server 181, and 112 of the server tests again on the phone's stack (SQLite WebAssembly + the in-app router), on Windows. Includes the phone joining from a cloud copy, billing offline and syncing, with every report identical to the computer's.
- End-to-end in a browser (headless Chrome, scratch server with demo data): a bill made on the New bill screen (stock down, total, printed view at phone width), a quotation turned into a bill, a receipt (balance), the day book and Outstanding, the recycle bin (delete, restore, refusal for an item on bills), settings saving the valid change and refusing the bad one.
- Every screen (21) in English and Tamil at 390 px and 1366 px: no page errors, no raw text keys, no sideways scroll, no English left in Tamil mode apart from data.
- Phone build in a browser: database in the worker, data kept across a reload, the real Turso reached from the browser (read-only), setup errors for a wrong or tampered token, no internet and a bad address; Tamil.
- Found and fixed during the end-to-end run: the printed bill was wider than a phone screen; a malformed request answered 500 instead of 400; whole-day tests could time out on a cold machine.

## Not verified here
- A full phone setup and offline billing on a real Android phone (the first real check; it needs the APK from GitHub Actions).
- The Android workflow's signed release build (needs the signing secrets on GitHub; the debug build is verified).
- Google Drive for desktop uploading the backups (Tula only writes the folder; check drive.google.com).
- Install / auto-start scripts on a real shop PC (dry-run only, as in Phase 1).

## Known gaps
- A lost phone is cut off at once only by invalidating all tokens (Turso cannot revoke one token); expiring tokens limit the risk ([07](07-sync-and-phones.md)).
- Two devices turning the same quotation into a bill while both are offline make two bills; cancel one.
- Server messages added later need a Tamil line in `locales/ta/server.json` (the test says which).
