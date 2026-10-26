# Excel import and export

Items & customers → **Excel import & export** (owner only). It works on the shop computer and in the Android app.

## What it covers
| List | Download | Import |
|---|---|---|
| Items | Every item with code, names, category, HSN, GST, units, rates, minimum stock | Adds new item codes, changes existing ones; a new category name adds the category |
| Customers and suppliers | Every party except the walk-in account, with GSTIN, credit terms, opening balance | Adds or changes; the same mobile number (else the same name) finds an existing party |
| Opening stock | Every item that keeps stock, with its opening quantity and cost | Sets the opening figures of the rows that have a quantity or cost |

Reports also download as Excel (each report's **Download Excel** button), as before. In the Android app the file opens the share sheet (WhatsApp, Drive, Gmail, Files).

## How to use it
1. **Download Excel**. The file is today's list, so it is also the form to fill. Its second sheet, *How to fill*, explains each column.
2. Change or add rows in Excel. Keep the headings in row 1. Delete rows you don't want to touch, or leave them as they are.
3. **Import from Excel…** and choose the file. Tula checks every row and lists what it will add, what it will change, and any mistakes with the row number and column.
4. **Save**. All rows are saved together, or none: a file with any mistake saves nothing.

Rows that would change nothing are left alone, so importing the whole list after changing one rate changes one item.

At go-live: import items first, then opening stock, then customers and suppliers with their opening balances.

## Columns
Items: `Item code`, `Name (English)`, `Name (Tamil)`, `Category`, `Brand`, `HSN/SAC`, `GST %`, `Base unit`, `Other units` (`BDL=10; ROD~10.667`, `~` for a theoretical weight), `Sale rate`, `Daily rate group`, `Rate extra`, `Min stock`, `Keep stock`, `Active`.

Customers and suppliers: `Type` (Customer / Supplier / Both), `Name (English)`, `Name (Tamil)`, `Mobile`, `Address`, `GSTIN`, `State code`, `Credit limit`, `Credit days`, `Opening balance` (empty keeps it as it is), `Active`.

Opening stock: `Item code`, `Name (English)` and `Base unit` (for reference), `Quantity`, `Cost per unit`.

Headings are always in English, so a file made in Tamil mode imports in English mode and the other way round. Amounts are rupees, quantities are in the item's base unit.

## For developers
- Server: `apps/server/src/excel.ts`. `GET /api/excel/:kind` returns `{ columns, rows }`; `POST /api/excel/:kind` takes `{ rows, apply }`. Rows are checked with the same functions as the screens (`saveProduct`, `saveParty`, `setOpeningStock` in `masters.ts`), all in one transaction with a savepoint per row; it commits only when `apply` is set and no row failed. A row whose exported form is the same before and after is rolled back (`skip`).
- Browser: `apps/web/src/api/excel.ts` writes and reads the `.xlsx` with exceljs (a lazy chunk), `src/files.ts` downloads it or, in the app, shares it through `@capacitor/filesystem` and `@capacitor/share`.
- Tests: `apps/server/test/excel.test.ts`, also run on the phone stack (`npm run test:phone -w apps/server`).
