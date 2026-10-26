# Recycle bin, settings that save what they can, stock in larger units

## Recycle bin (UC-33)
Settings → **Recycle bin** (owner only).

**Delete** is on the item screen, the customer / supplier screen and the expense heads list; categories with no items are deleted from the Recycle bin screen. A deleted master disappears from lists, billing and reports, and waits in the recycle bin with who deleted it and when. **Restore** puts it back exactly as it was.

Only things never used can be deleted, so no bill, stock figure or balance ever loses a row:

| Master | Can be deleted when | Otherwise |
|---|---|---|
| Item | never on a bill or purchase, no stock or stock history, no special customer rates | mark it inactive |
| Customer / supplier | no bills, payments or expenses, no opening balance, no special rates; never the walk-in account | mark them inactive |
| Category | no items in it | move or delete the items first |
| Expense head | no expenses | — |

Units and rate groups are not deleted: they are part of how items are measured and priced. Documents are never deleted; mistakes in them are corrected with a cancellation, credit note or debit note.

Restore is refused, with the reason, when it would clash: a customer whose mobile number another customer now has, an expense head whose name is now used, an item whose category is also in the recycle bin (restore the category first). An item code stays taken while its item is in the recycle bin: adding a new item with that code says so.

Deleting and restoring are recorded in the audit log and copied to the other computers and phones like any change.

**For developers:** `apps/server/src/recycle.ts`. `DELETE /api/products/:id`, `/api/parties/:id`, `/api/categories/:id`, `/api/expense-heads/:id` set `deleted = 1` through `update()` (so they sync) after the in-use checks; `GET /api/recycle-bin` lists deleted masters; `POST /api/recycle-bin/:kind/:id/restore` sets `deleted = 0` after the clash checks. All owner only. Screen: `apps/web/src/screens/RecycleBin.tsx`; the Delete button is `components/DeleteButton.tsx`.

## Settings save what they can
Saving the Settings screen keeps every change that can be saved and marks the others, each with its reason, keeping what was typed so it can be fixed. A change is refused when its value is not valid, when it would contradict another setting (the GSTIN's state and the business state, the languages…; only the changed settings in that rule are refused, so what is kept stays consistent), or when it changes the invoice numbering after the year's first bill (the numbering changes are refused together).

**For developers:** `apps/server/src/settings-save.ts`. `PUT /api/settings` returns `saved` (keys) and `refused` (`key → reason`) with the settings. When nothing can be saved it fails as before (400 with `BAD_VALUE`, `INCONSISTENT` or `NUMBERING_IN_USE`) and `details.refused`. Cross-field rules are `settingsIssues()` in `packages/core/src/settings.ts`, each naming its settings; `checkSettingsConsistency()` is built on it.

## Stock in the larger unit
The Stock screen and the Stock summary report (on screen and in Excel) show stock in the item's largest unit exactly: **46 Bundle + 13.35 Kg**, not rounded down to 46 bundles. For a unit that is a calculated weight (steel rods and bundles) it starts with **≈**, because the real weight of a bundle differs. Nothing is shown when there is less than one larger unit. One function makes the text everywhere: `largerUnitText()` in `packages/core/src/qty.ts`.
