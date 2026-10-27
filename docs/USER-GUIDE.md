# Tula — user guide

For the shop owner and counter staff. Each part says what to tap and what happens. Screen names are as they appear in English; in Tamil mode the same screens are in the same places.

The same guide is inside Tula, in English and Tamil: tap **?** at the top of any screen (or **Help** in your name's menu). It comes from `apps/web/src/locales/<lang>/help.json`; change it there and here together.

Technical details are in the other documents in this folder (see the README).

---

## 1. Signing in
1. Open Tula (on the shop computer: the Tula icon or `http://localhost:5000`).
2. Tap your name, type your PIN.
3. The first time, choose your own PIN (4 to 6 digits; easy PINs like 1234 are refused).

Five wrong PINs lock that person for 5 minutes. Forgot the owner PIN? See §14.

Language: tap **English / தமிழ்** at the top. Each person's language is remembered.

## 2. Who can do what
| Role | Can |
|---|---|
| Owner | Everything |
| Billing | Make bills and quotations, take payments, add customers (no credit terms), look up items, stock and customers |
| View only | Look at bills, stock, items, customers and reports |

Add people in **Settings → People**.

## 3. Before the first bill (go-live)
1. **Settings**: business name (English and Tamil), address, GSTIN, state, phone, bank and UPI ID, invoice numbering. A yellow line at the top says what is still missing. Saving keeps every change that is valid and marks any that were refused, with the reason.
2. **Items**: add them one by one (**Items & customers → Items**), or many at once with Excel (§11).
3. **Opening stock**: the counted stock and its cost (**Stock → Opening stock**, or Excel).
4. **Customers and suppliers** with what they owed on the go-live day (opening balance), credit limit and credit days.
5. **Next bill number**: if you continue a paper bill book, set the numbering in Settings before the first bill of the year.

## 4. Every morning: today's rates
The rate chips at the top (for example **TMT bars ₹60.00/kg**) are the day's rates. The owner taps a chip, types the new rate, **Save**. Items that follow the day's rate use it from then on; their size extra is added automatically.

## 5. Making a bill
**Billing → New bill**
1. Pick the customer (type a name or mobile number). Not found? **Add** them right there. Walk-in customers: leave it on the walk-in account.
2. Add items: type the code or name. Enter the quantity in any unit the item has (for example 10 bundles + 4 rods, or 147.35 kg weighed). The rate fills itself: the customer's special rate, else the day's rate, else the item's rate.
3. Optional: site, vehicle number, discount, bill language.
4. Payment now: cash, UPI, bank or cheque, any amount (the rest stays on credit).
5. **Save bill**. Warnings (low stock, credit limit) ask you to confirm; the owner decides in Settings whether they only warn or block.

After saving: **Print** (A4 or A5, set in Settings), **Share** (a picture of the bill for WhatsApp or a printer app) or **Share as PDF**. Bills with an amount due show a UPI QR code the customer can scan.

**E-way bill**: above the limit Tula reminds you to make one (the e-way bill itself is made on the government portal).

## 6. Quotations
A price for a customer who hasn't bought yet. Nothing changes: no stock goes out, nobody owes anything, and it is not in any register or GST return.
1. **Billing → Quotations → New quotation**: the bill screen without the payment box. Optional **Valid until** date.
2. **Save quotation**, then print it, **Share** it or **Share as PDF**. It is numbered `QT/26-27/0001`.
3. When the customer buys: **Make bill** on the quotation. It shows the quoted rate next to the day's rate; tick **Keep the quoted rates** to bill at the quoted price. The quotation then shows *Billed* with the bill number and can't become a second bill.

**Cancel** a quotation the customer won't take. More: [10-quotations.md](10-quotations.md).

## 7. Mistakes on a bill
- **Cancel** (owner, same day): the bill stays in the list marked *Cancelled*, its number is never reused, stock and accounts are reversed. Bills from an earlier month must be corrected with a return instead.
- **Return** (sales return / credit note): open the bill → **Return**, pick what came back. Stock comes back, the customer's balance goes down.

## 8. Money in: receipts
**Billing → Receipts → New receipt**: pick the customer, the amount and how they paid. Tula settles the opening balance first, then the oldest bills; you can change which bills it goes to. Money with no bill becomes an advance and is used on later bills.

**Outstanding** lists who owes what, by age (overdue in red). **WhatsApp** opens a reminder in the customer's language with the amount and your UPI ID. **Statement** shows a customer's account for a period, to print or share.

## 9. Purchases, supplier payments, expenses
- **Purchases → Purchases**: enter the supplier's bill (items, quantity as per the mill weight, rate, GST, freight). Stock goes up and the average cost is updated. Mark *no ITC* when the GST can't be claimed. Returns to the supplier: **Return** on the purchase.
- **Supplier payments**: pay against their bills or on account.
- **Expenses**: rent, wages, electricity, loading, fuel… by head, with GST where there is a GST bill.

## 10. Stock
- **Stock**: live stock and its value per item, also in the largest unit (for example *46 Bundle + 13.35 Kg*; ≈ for calculated steel weights); low and out-of-stock items stand out.
- **Stock corrections**: weighbridge difference, scrap, damage, count correction, always with a reason (owner).
- **Opening stock**: go-live figures.

## 11. Excel import and export
**Items & customers → Excel import & export** (owner). Download the list, change or add rows in Excel, choose the file: Tula checks every row and shows what it will add, change or skip, and any mistakes by row and column. **Save** keeps all rows or none. Details: [09-excel.md](09-excel.md).

Every report also has **Download Excel**.

## 12. Reports and GST
**Reports**: day book, cash and bank book, sales and purchase registers, steel sales against the day's rate, stock summary, profit and loss, profit by bill / customer / item, GSTR-1 (Excel and JSON for your CA), GSTR-3B, CMP-08. Pick the period, then **Print** or **Download Excel**.

## 13. Backups
Tula makes a checked backup every night (time set on the **Backup** screen) and keeps a month of them. Tap **Back up now** before anything risky.
**Copy backups to Google Drive (free):** install Google Drive for desktop on the shop computer, sign in with the shop's Google account and set it to **Mirror files**. Then **Settings → Backup → Copy backups to Google Drive → Back up to this folder**, and **Back up now**. Check once that the backup shows in drive.google.com. Steps and limits: [06-install-and-run.md](06-install-and-run.md) §5.

Restore: **Backup** → pick a backup → **Restore** → owner PIN. Tula first saves a safety copy of today's data, then restarts with the backup.

## 14. Forgot the owner PIN
On the shop computer, run the `reset-pin` tool as described in [06-install-and-run.md](06-install-and-run.md). Other people's PINs: the owner resets them in **Settings → People**.

## 15. Phones
Two ways ([07-sync-and-phones.md](07-sync-and-phones.md)):
- **Work on this phone** (Android app): Tula runs on the phone with its own copy of the data. Bill anywhere, without internet or the shop computer; changes go to the cloud copy when there is internet. Set up once with the cloud address and token. The phone's bills have their own series (M1…).
- **Connect to the shop computer** (Android app or any phone browser): only on the shop Wi-Fi while the computer is on.

On the phone, **Share** and **Share as PDF** replace Print. Each phone's access token can have an end date; **Devices & sync** warns a week before it runs out (make a new one as in [07-sync-and-phones.md](07-sync-and-phones.md)). **Settings → Devices & sync** shows whether the cloud copy is up to date and the changes waiting to send.

## 16. Cloud copy and other computers
**Settings → Devices & sync**: is the cloud copy up to date, which computers and phones share the data, and **Mark as lost** for a stolen device (then make a new access token). Setting up: [07-sync-and-phones.md](07-sync-and-phones.md).

## 17. Recycle bin
Items, customers and suppliers, categories and expense heads that were **never used** can be deleted (Delete on their screen; owner). Anything already on a bill, purchase, stock or balance can't be deleted: mark it inactive instead. Deleted things wait in **Settings → Recycle bin**, with who deleted them and when; **Restore** puts them back as they were (refused, with the reason, if it would clash with something added since). More: [11-recycle-bin.md](11-recycle-bin.md).

## 18. When something is wrong
| You see | Do this |
|---|---|
| "Cannot reach the shop computer" on a phone | Is the computer on, Tula running, the phone on the shop Wi-Fi? |
| "Cloud copy has a problem" | The screen says what to do. Billing keeps working meanwhile. |
| A red line at the top of a screen | Read it: it says what is missing or wrong and where to fix it. |
| Tula does not open on the shop computer | Restart the computer; Tula starts on its own. Still not? [06-install-and-run.md](06-install-and-run.md) §11. |
