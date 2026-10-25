# Milestone 1 — sign-in, items, customers, opening figures

Date: 25 Oct 2026

## Delivered
- **PIN sign-in.** Tap your name, type your PIN (keyboard or on-screen keypad). The first-run owner PIN (1234) and any PIN set by the owner are temporary: the person must choose their own at first sign-in. Weak PINs (1111, 1234…) are refused. Five wrong PINs lock that person out for 5 minutes. Sessions last 14 days on this computer; signing out or a PIN reset ends them.
- **Roles.**
  | Role | Can |
  |---|---|
  | Owner | Everything: settings, rates, items, customers' credit terms, opening figures, people |
  | Billing | Make bills, add customers on the spot (no credit terms), look up items, stock, customers |
  | View only | Look at bills, stock, items and customers |
  The server enforces this on every request; screens hide what a role can't use. Every bill records who made it. There is always at least one owner.
- **People** (Settings): add, change role, reset PIN, turn off.
- **Items**: add and edit with code, English/Tamil names, brand, category (new categories from the same screen), HSN/SAC (4, 6 or 8 digits), GST rate, stock unit, fixed rate or "follows today's rate" plus a size extra, low-stock level, and **larger units** (bundle, rod, box, roll, length…), each of which becomes a quantity box on the bill. For steel rods a d²/162 button fills the theoretical weight. The stock unit cannot change once an item has stock.
- **Customers and suppliers**: GSTIN fills the state; duplicate mobile numbers are caught; credit limit and days; preferred bill language; **opening balance** (positive = they owe you); **special rates** per customer (a fixed rate, or + / − on the normal rate) that the bill applies automatically.
- **Opening stock**: enter counted quantity and cost per unit; saving again corrects it.
- **Quick add** of a customer from the bill screen when the name isn't found.
- With GST-inclusive pricing, item rates are labelled "incl. GST" and bill lines show the amount the customer pays.

## Verified
- 58 automated tests (core 29, server 29), including roles, lockout, forced PIN change, item and customer validation, special rates on a bill, opening balance replacement with a balanced ledger, and opening stock correction.
- Walk-through in a real browser with a business profile: owner first sign-in → new PIN → add a billing user → add a tile item sold by the box → add a customer with a special cement rate and opening balance → enter opening stock → sign in as the billing user → bill 40 bags at the special ₹405 and 10 boxes (= 155 sq ft) → ₹25,190.00, matching the hand calculation. Tamil screens checked.

## Next: Milestone 2 polish and Milestone 3
- Bill cancellation and sales returns (credit notes), receipts against bills, customer statements.
- Purchases, supplier payments, expenses, stock adjustments.
