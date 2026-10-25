import {
  calcBill, calcLine, financialYear, parseScaled, roundDiv, toMilli, toPaise, todayIST, withDefaults, type LineAmounts, type SupplyType,
} from '@tula/core';
import { all, getSettings, insert, nowIso, one, softDelete, update, type Db, type Exec } from '@tula/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accountId, partyAccountId, partyBalance, post } from './accounts';
import { nextNumber } from './bills';
import { UserError, type Ctx } from './context';

// =====================================================================
// Cancel bills, sales returns (credit notes), customer receipts,
// outstanding with ageing, and customer statements.
//
// How a customer's money is tracked (guide §4):
//   * bill balance  = total − active receipt allocations − active credit notes against it
//   * opening balance is the oldest open item; unallocated receipt money pays it first
//   * advance       = unallocated receipt money (+ any credit opening balance) − refunds,
//                     after the opening balance has taken its share
//   * ledger balance = opening due + Σ open bill balances − advance (always; see tests)
// =====================================================================

const decimal = z.union([z.string(), z.number()]).transform(String);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const Mode = z.enum(['cash', 'upi', 'bank', 'cheque']);
type Mode = z.infer<typeof Mode>;
const CASH_ACCOUNT: Record<Mode, string> = { cash: 'CASH', upi: 'UPI', bank: 'BANK', cheque: 'BANK' };

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
/** 12500 -> "12.5" (plain decimal, no grouping) */
const milliText = (m: number) => `${Math.floor(m / 1000)}${m % 1000 ? `.${String(m % 1000).padStart(3, '0').replace(/0+$/, '')}` : ''}`;

async function inTx<T>(db: Db, fn: (tx: Exec) => Promise<T>): Promise<T> {
  const tx = await db.transaction('write');
  try {
    const r = await fn(tx);
    await tx.commit();
    return r;
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

const audit = (ex: Exec, dev: string, userId: string, entity: string, entityId: string, action: string, after?: unknown, reason?: string) =>
  insert(ex, 'audit_log', dev, { at: nowIso(), user_id: userId, entity, entity_id: entityId, action, after_json: after ?? null, reason: reason ?? null });

// ---------------------------------------------------------------------
// Customer position: open items, advance
// ---------------------------------------------------------------------

interface PartyRow { id: string; name_en: string; name_ta: string | null; mobile: string | null; lang: string | null; credit_days: number; party_type: string; opening_date: string | null; is_walk_in: number; address: string | null; gstin: string | null }

async function getParty(ex: Exec, id: string): Promise<PartyRow> {
  const p = await one<PartyRow>(ex, 'SELECT id, name_en, name_ta, mobile, lang, credit_days, party_type, opening_date, is_walk_in, address, gstin FROM parties WHERE id = ? AND deleted = 0', [id]);
  if (!p) throw new UserError('Customer not found', 'NO_PARTY', 404);
  return p;
}

export interface OpenBill {
  id: string; docNo: string; date: string; totalPaise: number; paidPaise: number; returnedPaise: number; balancePaise: number;
  daysOld: number; dueDate: string; overdueDays: number;
}

/** Every active invoice of a customer with what has been paid and returned against it, oldest first. */
async function partyBills(ex: Exec, partyId: string, creditDays: number, today: string): Promise<OpenBill[]> {
  const rows = await all<{ id: string; doc_no: string; doc_date: string; total_paise: number; paid: number; returned: number }>(ex, `
    SELECT d.id, d.doc_no, d.doc_date, d.total_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
        WHERE a.sales_doc_id = d.id AND a.deleted = 0 AND m.status = 'active' AND m.deleted = 0), 0) AS paid,
      COALESCE((SELECT SUM(c.total_paise) FROM sales_docs c
        WHERE c.ref_doc_id = d.id AND c.doc_type = 'CN' AND c.status = 'active' AND c.deleted = 0), 0) AS returned
    FROM sales_docs d
    WHERE d.party_id = ? AND d.doc_type = 'INV' AND d.status = 'active' AND d.deleted = 0
    ORDER BY d.doc_date, d.created_at`, [partyId]);
  return rows.map((r) => {
    const total = Number(r.total_paise);
    const paid = Number(r.paid);
    const returned = Number(r.returned);
    const daysOld = Math.max(0, daysBetween(r.doc_date, today));
    return {
      id: r.id, docNo: r.doc_no, date: r.doc_date, totalPaise: total, paidPaise: paid, returnedPaise: returned,
      balancePaise: Math.max(0, total - paid - returned), daysOld, dueDate: addDays(r.doc_date, creditDays), overdueDays: Math.max(0, daysOld - creditDays),
    };
  });
}

/** Active receipts of a customer with the part not yet allocated to bills, oldest first. */
async function partyReceipts(ex: Exec, partyId: string) {
  const rows = await all<{ id: string; doc_no: string; doc_date: string; amount_paise: number; allocated: number }>(ex, `
    SELECT m.id, m.doc_no, m.doc_date, m.amount_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM money_allocations a WHERE a.money_doc_id = m.id AND a.deleted = 0), 0) AS allocated
    FROM money_docs m WHERE m.party_id = ? AND m.doc_type = 'RCPT' AND m.status = 'active' AND m.deleted = 0
    ORDER BY m.doc_date, m.created_at`, [partyId]);
  return rows.map((r) => ({ id: r.id, docNo: r.doc_no, date: r.doc_date, amountPaise: Number(r.amount_paise), unallocatedPaise: Number(r.amount_paise) - Number(r.allocated) }));
}

export async function partyPosition(ex: Exec, partyId: string, today = todayIST()) {
  const party = await getParty(ex, partyId);
  const creditDays = Number(party.credit_days ?? 0);
  const bills = await partyBills(ex, partyId, creditDays, today);
  const receipts = await partyReceipts(ex, partyId);
  const opening = Number((await one<{ b: number }>(ex, `
    SELECT COALESCE(SUM(e.debit_paise - e.credit_paise), 0) AS b FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
    WHERE a.party_id = ? AND e.source_type = 'OPEN' AND e.deleted = 0`, [partyId]))?.b ?? 0);
  // Cash refunds against credit notes (PAY documents linked to a credit note).
  const refunds = Number((await one<{ r: number }>(ex, `
    SELECT COALESCE(SUM(a.amount_paise), 0) AS r FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
    WHERE m.party_id = ? AND m.doc_type = 'PAY' AND m.status = 'active' AND m.deleted = 0 AND a.deleted = 0 AND a.sales_doc_id IS NOT NULL`, [partyId]))?.r ?? 0);
  const unallocated = receipts.reduce((a, r) => a + r.unallocatedPaise, 0);
  // money paid in excess of bills (should be 0: returns release allocations above the bill total)
  const excess = bills.reduce((a, b) => a + Math.max(0, b.paidPaise + b.returnedPaise - b.totalPaise), 0);
  const credit = unallocated + excess + Math.max(0, -opening) - refunds;
  const openingOwed = Math.max(0, opening);
  const openingDue = Math.max(0, openingOwed - credit);
  const advance = Math.max(0, credit - openingOwed);
  const openingDate = party.opening_date ?? today;
  const openingDays = Math.max(0, daysBetween(openingDate, today));
  return {
    party, creditDays, bills, openBills: bills.filter((b) => b.balancePaise > 0), receipts, unallocatedPaise: unallocated, refundsPaise: refunds,
    openingPaise: opening, openingDuePaise: openingDue, openingDate, openingDays, openingOverdueDays: Math.max(0, openingDays - creditDays),
    advancePaise: advance, ledgerBalancePaise: await partyBalance(ex, partyId),
  };
}

type Position = Awaited<ReturnType<typeof partyPosition>>;

/** Oldest first: what part of an amount goes to the opening balance and to each open bill. */
function fifo(pos: Position, amount: number) {
  let left = amount;
  const toOpening = Math.min(left, pos.openingDuePaise);
  left -= toOpening;
  const allocations: Array<{ billId: string; docNo: string; amountPaise: number }> = [];
  for (const b of pos.openBills) {
    if (left <= 0) break;
    const a = Math.min(left, b.balancePaise);
    allocations.push({ billId: b.id, docNo: b.docNo, amountPaise: a });
    left -= a;
  }
  return { toOpening, allocations, advance: left };
}

// ---------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------

const ReceiptInput = z.object({
  partyId: z.string().min(1),
  date: isoDate.optional(),
  amount: decimal,
  mode: Mode,
  reference: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(300).optional(),
  /** omitted = oldest open bills first */
  allocations: z.array(z.object({ billId: z.string().min(1), amount: decimal })).max(200).optional(),
});

async function planReceipt(ex: Exec, raw: unknown) {
  const input = ReceiptInput.parse(raw);
  const today = todayIST();
  const date = input.date ?? today;
  if (date > today) throw new UserError('A receipt cannot be dated in the future');
  const amount = toPaise(input.amount);
  if (amount <= 0) throw new UserError('Enter the amount received');
  const pos = await partyPosition(ex, input.partyId, today);
  if (pos.party.party_type === 'supplier') throw new UserError('This is a supplier. Record supplier payments under Purchases.');
  if (input.allocations === undefined) {
    const plan = fifo(pos, amount);
    return { input, date, amount, pos, ...plan };
  }
  const allocations: Array<{ billId: string; docNo: string; amountPaise: number }> = [];
  let sum = 0;
  for (const a of input.allocations) {
    const amt = toPaise(a.amount);
    if (amt === 0) continue;
    if (amt < 0) throw new UserError('Amounts against bills cannot be negative');
    const b = pos.openBills.find((x) => x.id === a.billId);
    if (!b) throw new UserError('That bill is not open for this customer. Refresh and try again.', 'BAD_ALLOCATION');
    if (allocations.some((x) => x.billId === b.id)) throw new UserError(`Bill ${b.docNo} is listed twice`, 'BAD_ALLOCATION');
    if (amt > b.balancePaise) throw new UserError(`Bill ${b.docNo} has only ${(b.balancePaise / 100).toFixed(2)} left to pay`, 'BAD_ALLOCATION');
    allocations.push({ billId: b.id, docNo: b.docNo, amountPaise: amt });
    sum += amt;
  }
  if (sum > amount) throw new UserError('The amounts against bills add up to more than the amount received', 'BAD_ALLOCATION');
  const rest = amount - sum;
  const toOpening = Math.min(rest, pos.openingDuePaise);
  return { input, date, amount, pos, toOpening, allocations, advance: rest - toOpening };
}

const previewOf = (p: Awaited<ReturnType<typeof planReceipt>>) => ({
  amountPaise: p.amount, toOpeningPaise: p.toOpening, advancePaise: p.advance, advanceBeforePaise: p.pos.advancePaise,
  openingDuePaise: p.pos.openingDuePaise, balanceBeforePaise: p.pos.ledgerBalancePaise, balanceAfterPaise: p.pos.ledgerBalancePaise - p.amount,
  allocations: p.allocations, openBills: p.pos.openBills,
});

async function createReceipt(db: Db, ctx: Ctx, raw: unknown) {
  return inTx(db, async (tx) => {
    const p = await planReceipt(tx, raw);
    const settings = withDefaults(await getSettings(tx));
    const fy = financialYear(p.date);
    const docNo = await nextNumber(tx, ctx.deviceId, 'RCPT', fy, settings);
    const id = await insert(tx, 'money_docs', ctx.deviceId, {
      doc_type: 'RCPT', doc_no: docNo, doc_date: p.date, fy, party_id: p.pos.party.id, amount_paise: p.amount, mode: p.input.mode,
      reference: p.input.reference || null, notes: p.input.notes || null, created_by: ctx.userId,
    });
    for (const a of p.allocations) await insert(tx, 'money_allocations', ctx.deviceId, { money_doc_id: id, sales_doc_id: a.billId, amount_paise: a.amountPaise });
    const partyAcc = await partyAccountId(tx, ctx.deviceId, p.pos.party.id);
    await post(tx, ctx.deviceId, {
      date: p.date, sourceType: 'RCPT', sourceId: id, narration: docNo,
      lines: [{ accountId: await accountId(tx, CASH_ACCOUNT[p.input.mode]), debit: p.amount }, { accountId: partyAcc, credit: p.amount }],
    });
    await audit(tx, ctx.deviceId, ctx.userId, 'money_docs', id, 'create', { docNo, amount: p.amount, allocations: p.allocations.length });
    return { id, docNo, ...previewOf(p) };
  });
}

/** Put a customer's unallocated receipt money against their oldest open bills. */
async function applyAdvance(db: Db, ctx: Ctx, partyId: string) {
  return inTx(db, async (tx) => {
    const pos = await partyPosition(tx, partyId);
    let available = Math.min(pos.advancePaise, pos.unallocatedPaise);
    if (available <= 0) throw new UserError('This customer has no advance to apply', 'NO_ADVANCE');
    if (!pos.openBills.length) throw new UserError('This customer has no unpaid bills', 'NO_OPEN_BILLS');
    const receipts = pos.receipts.filter((r) => r.unallocatedPaise > 0).map((r) => ({ ...r }));
    const made: Array<{ receiptId: string; billId: string; amountPaise: number }> = [];
    for (const b of pos.openBills) {
      let need = b.balancePaise;
      for (const r of receipts) {
        if (need <= 0 || available <= 0) break;
        const a = Math.min(need, r.unallocatedPaise, available);
        if (a <= 0) continue;
        await insert(tx, 'money_allocations', ctx.deviceId, { money_doc_id: r.id, sales_doc_id: b.id, amount_paise: a });
        made.push({ receiptId: r.id, billId: b.id, amountPaise: a });
        r.unallocatedPaise -= a;
        need -= a;
        available -= a;
      }
    }
    await audit(tx, ctx.deviceId, ctx.userId, 'parties', partyId, 'update', { appliedAdvance: made }, 'Advance applied to bills');
    return { appliedPaise: made.reduce((a, m) => a + m.amountPaise, 0), allocations: made };
  });
}

async function cancelReceipt(db: Db, ctx: Ctx, id: string, reason: string) {
  return inTx(db, async (tx) => {
    const m = await one<{ id: string; doc_no: string; status: string; party_id: string; amount_paise: number; doc_type: string }>(tx,
      'SELECT id, doc_no, status, party_id, amount_paise, doc_type FROM money_docs WHERE id = ? AND deleted = 0', [id]);
    if (!m || m.doc_type !== 'RCPT') throw new UserError('Receipt not found', 'NOT_FOUND', 404);
    if (m.status === 'cancelled') throw new UserError(`Receipt ${m.doc_no} is already cancelled`, 'ALREADY_CANCELLED', 409);
    const pos = await partyPosition(tx, m.party_id);
    const r = pos.receipts.find((x) => x.id === id)!;
    if (pos.unallocatedPaise + Math.max(0, -pos.openingPaise) - pos.refundsPaise - r.unallocatedPaise < 0) {
      throw new UserError('Part of this money was already refunded to the customer, so the receipt cannot be cancelled', 'REFUNDED', 409);
    }
    await update(tx, 'money_docs', ctx.deviceId, id, { status: 'cancelled', notes: reason });
    const entries = await softDelete(tx, 'ledger_entries', ctx.deviceId, "source_type = 'RCPT' AND source_id = ?", [id]);
    const allocs = await softDelete(tx, 'money_allocations', ctx.deviceId, 'money_doc_id = ?', [id]);
    await audit(tx, ctx.deviceId, ctx.userId, 'money_docs', id, 'cancel', { docNo: m.doc_no, entries, allocations: allocs }, reason);
    return { id, docNo: m.doc_no, status: 'cancelled' };
  });
}

// ---------------------------------------------------------------------
// Cancel an invoice
// ---------------------------------------------------------------------

async function getInvoice(ex: Exec, id: string) {
  const d = await one<{ id: string; doc_no: string; doc_type: string; doc_date: string; status: string; party_id: string; total_paise: number }>(ex,
    'SELECT id, doc_no, doc_type, doc_date, status, party_id, total_paise FROM sales_docs WHERE id = ? AND deleted = 0', [id]);
  if (!d || d.doc_type !== 'INV') throw new UserError('Bill not found', 'NOT_FOUND', 404);
  return d;
}

const activeCreditNotes = (ex: Exec, billId: string) => all<{ id: string; doc_no: string; doc_date: string; total_paise: number }>(ex,
  "SELECT id, doc_no, doc_date, total_paise FROM sales_docs WHERE ref_doc_id = ? AND doc_type = 'CN' AND status = 'active' AND deleted = 0 ORDER BY doc_date, created_at", [billId]);

async function cancelCheck(ex: Exec, id: string) {
  const d = await getInvoice(ex, id);
  const cns = await activeCreditNotes(ex, id);
  const earlierMonth = d.doc_date < monthStart(todayIST());
  let blocker: { code: string; message: string } | null = null;
  if (d.status === 'cancelled') blocker = { code: 'ALREADY_CANCELLED', message: `Bill ${d.doc_no} is already cancelled` };
  else if (cns.length) blocker = { code: 'HAS_RETURN', message: `Bill ${d.doc_no} has a credit note. Make a return instead.` };
  return { bill: d, earlierMonth, canCancel: !blocker, blocker };
}

async function cancelBill(db: Db, ctx: Ctx, id: string, reason: string) {
  return inTx(db, async (tx) => {
    const c = await cancelCheck(tx, id);
    if (c.blocker) throw new UserError(c.blocker.message, c.blocker.code, 409);
    const at = nowIso();
    await update(tx, 'sales_docs', ctx.deviceId, id, { status: 'cancelled', cancel_reason: reason, cancelled_at: at, cancelled_by: ctx.userId });
    const entries = await softDelete(tx, 'ledger_entries', ctx.deviceId, "source_type = 'INV' AND source_id = ?", [id]);
    const moves = await softDelete(tx, 'stock_moves', ctx.deviceId, "source_type = 'INV' AND source_id = ?", [id]);
    // Money received against this bill stays with the customer as an advance.
    const freed = await one<{ s: number }>(tx, 'SELECT COALESCE(SUM(amount_paise),0) s FROM money_allocations WHERE sales_doc_id = ? AND deleted = 0', [id]);
    const allocs = await softDelete(tx, 'money_allocations', ctx.deviceId, 'sales_doc_id = ?', [id]);
    await audit(tx, ctx.deviceId, ctx.userId, 'sales_docs', id, 'cancel', { docNo: c.bill.doc_no, entries, moves, allocations: allocs }, reason);
    return { id, docNo: c.bill.doc_no, status: 'cancelled', earlierMonth: c.earlierMonth, advanceFreedPaise: Number(freed?.s ?? 0) };
  });
}

// ---------------------------------------------------------------------
// Sales return → credit note
// ---------------------------------------------------------------------

interface InvLine {
  id: string; line_no: number; product_id: string; description: string; hsn: string | null; base_qty_milli: number; rate_unit_id: string;
  rate_unit_code: string; rate_unit_en: string; rate_unit_ta: string | null; rate_qty_milli: number; rate_paise: number; rate_inclusive: number;
  discount_paise: number; taxable_paise: number; gst_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number; line_total_paise: number;
  cost_per_base_paise: number | null; track_stock: number;
  ret_rate_qty: number; ret_base_qty: number; ret_discount: number; ret_taxable: number; ret_cgst: number; ret_sgst: number; ret_igst: number; ret_total: number;
}

async function returnableLines(ex: Exec, billId: string): Promise<InvLine[]> {
  const sumRet = (col: string) => `COALESCE((SELECT SUM(r.${col}) FROM sales_doc_lines r JOIN sales_docs c ON c.id = r.doc_id
      WHERE r.ref_line_id = l.id AND r.deleted = 0 AND c.status = 'active' AND c.deleted = 0), 0)`;
  const rows = await all<InvLine>(ex, `
    SELECT l.id, l.line_no, l.product_id, l.description, l.hsn, l.base_qty_milli, l.rate_unit_id, u.code AS rate_unit_code, u.name_en AS rate_unit_en,
      u.name_ta AS rate_unit_ta, l.rate_qty_milli, l.rate_paise, l.rate_inclusive, l.discount_paise, l.taxable_paise, l.gst_bp, l.cgst_paise,
      l.sgst_paise, l.igst_paise, l.line_total_paise, l.cost_per_base_paise, p.track_stock,
      ${sumRet('rate_qty_milli')} AS ret_rate_qty, ${sumRet('base_qty_milli')} AS ret_base_qty, ${sumRet('discount_paise')} AS ret_discount,
      ${sumRet('taxable_paise')} AS ret_taxable, ${sumRet('cgst_paise')} AS ret_cgst, ${sumRet('sgst_paise')} AS ret_sgst,
      ${sumRet('igst_paise')} AS ret_igst, ${sumRet('line_total_paise')} AS ret_total
    FROM sales_doc_lines l JOIN units u ON u.id = l.rate_unit_id JOIN products p ON p.id = l.product_id
    WHERE l.doc_id = ? AND l.deleted = 0 ORDER BY l.line_no`, [billId]);
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])) as unknown as InvLine);
}

const ReturnInput = z.object({
  lines: z.array(z.object({ lineId: z.string().min(1), qty: decimal })).min(1).max(50),
  reason: z.string().trim().min(1, 'Say why the goods came back').max(300),
  date: isoDate.optional(),
  refund: z.object({ mode: Mode, amount: decimal }).optional(),
});

async function priceReturn(ex: Exec, billId: string, raw: unknown) {
  const input = ReturnInput.parse(raw);
  const doc = await one<{ id: string; doc_no: string; doc_type: string; doc_date: string; status: string; party_id: string; supply_type: SupplyType; doc_kind: string; party_name: string; party_gstin: string | null; party_address: string | null; place_of_supply: string; site: string | null; lang: string; total_paise: number }>(ex,
    'SELECT * FROM sales_docs WHERE id = ? AND deleted = 0', [billId]);
  if (!doc || doc.doc_type !== 'INV') throw new UserError('Bill not found', 'NOT_FOUND', 404);
  if (doc.status === 'cancelled') throw new UserError(`Bill ${doc.doc_no} is cancelled, so nothing can be returned against it`, 'CANCELLED', 409);
  const today = todayIST();
  const date = input.date ?? today;
  if (date > today) throw new UserError('A return cannot be dated in the future');
  if (date < doc.doc_date) throw new UserError('A return cannot be dated before its bill');
  const invLines = await returnableLines(ex, billId);
  const lines: Array<LineAmounts & { src: InvLine; rateQty: number; baseQty: number; gstBp: number; costTotal: number }> = [];
  for (const l of input.lines) {
    const qty = toMilli(l.qty);
    if (qty === 0) continue;
    if (qty < 0) throw new UserError('Returned quantity cannot be negative');
    const src = invLines.find((x) => x.id === l.lineId);
    if (!src) throw new UserError('That item is not on this bill', 'BAD_LINE');
    if (lines.some((x) => x.src.id === src.id)) throw new UserError(`Line ${src.line_no} is listed twice`, 'BAD_LINE');
    const left = src.rate_qty_milli - src.ret_rate_qty;
    if (qty > left) {
      throw new UserError(`Line ${src.line_no} (${src.description}): only ${milliText(left)} ${src.rate_unit_en} can still be returned`, 'TOO_MUCH', 400);
    }
    let amounts: LineAmounts;
    let baseQty: number;
    if (qty === left) {
      // Last of this line: return exactly what is left, so a full return reverses the bill to the paisa.
      baseQty = src.base_qty_milli - src.ret_base_qty;
      const discount = src.discount_paise - src.ret_discount;
      const taxable = src.taxable_paise - src.ret_taxable;
      amounts = {
        gross: taxable + discount, discount, taxable, cgst: src.cgst_paise - src.ret_cgst, sgst: src.sgst_paise - src.ret_sgst,
        igst: src.igst_paise - src.ret_igst, total: src.line_total_paise - src.ret_total,
      };
    } else {
      baseQty = roundDiv(qty * src.base_qty_milli, src.rate_qty_milli);
      const discount = roundDiv(src.discount_paise * qty, src.rate_qty_milli);
      amounts = calcLine({ rateQtyMilli: qty, ratePaise: src.rate_paise, discountPaise: discount, gstBp: src.gst_bp, inclusive: !!src.rate_inclusive }, doc.supply_type);
    }
    const cost = Number(src.cost_per_base_paise ?? 0);
    lines.push({ ...amounts, src, rateQty: qty, baseQty, gstBp: src.gst_bp, costTotal: roundDiv(baseQty * cost, 1000) });
  }
  if (!lines.length) throw new UserError('Enter the quantity coming back for at least one item', 'NO_QTY');
  const totals = calcBill(lines);
  // Money that will be the customer's to keep or take back after this return.
  const pos = await partyPosition(ex, doc.party_id, today);
  const bill = pos.bills.find((b) => b.id === billId)!;
  const overflow = Math.max(0, bill.paidPaise + bill.returnedPaise + totals.total - bill.totalPaise);
  // advance − opening due is the customer's net credit; the released overflow adds to it
  const advanceAfter = Math.max(0, pos.advancePaise - pos.openingDuePaise + overflow);
  const refundable = Math.min(totals.total, advanceAfter);
  let refund: { mode: Mode; amount: number } | null = null;
  if (input.refund) {
    const amt = toPaise(input.refund.amount);
    if (amt < 0) throw new UserError('Refund cannot be negative');
    if (amt > 0) {
      if (amt > refundable) {
        throw new UserError(refundable > 0
          ? `Refund can be at most ${(refundable / 100).toFixed(2)}: the rest of this return reduces what the customer owes`
          : 'The customer has not paid for these goods, so this return only reduces what they owe. No cash refund is due.', 'REFUND_TOO_MUCH');
      }
      refund = { mode: input.refund.mode, amount: amt };
    }
  }
  return { input, doc, date, lines, totals, overflow, refundable, refund, pos, bill };
}

const returnPreviewOf = (p: Awaited<ReturnType<typeof priceReturn>>) => ({
  totals: p.totals, refundablePaise: p.refundable, billBalanceBeforePaise: p.bill.balancePaise,
  billBalanceAfterPaise: Math.max(0, p.bill.balancePaise - p.totals.total),
  lines: p.lines.map((l) => ({ lineId: l.src.id, rateQtyMilli: l.rateQty, baseQtyMilli: l.baseQty, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total })),
});

async function createReturn(db: Db, ctx: Ctx, billId: string, raw: unknown) {
  return inTx(db, async (tx) => {
    const p = await priceReturn(tx, billId, raw);
    const { doc, date, lines, totals } = p;
    const dev = ctx.deviceId;
    const settings = withDefaults(await getSettings(tx));
    const fy = financialYear(date);
    const docNo = await nextNumber(tx, dev, 'CN', fy, settings);
    const cnId = await insert(tx, 'sales_docs', dev, {
      doc_type: 'CN', doc_kind: doc.doc_kind, doc_no: docNo, doc_date: date, fy, party_id: doc.party_id, party_name: doc.party_name,
      party_gstin: doc.party_gstin, party_address: doc.party_address, place_of_supply: doc.place_of_supply, supply_type: doc.supply_type,
      site: doc.site, ref_doc_id: doc.id, lang: doc.lang, taxable_paise: totals.taxable, cgst_paise: totals.cgst, sgst_paise: totals.sgst,
      igst_paise: totals.igst, round_off_paise: totals.roundOff, total_paise: totals.total, notes: p.input.reason, created_by: ctx.userId,
    });
    for (const [i, l] of lines.entries()) {
      const s = l.src;
      const lineId = await insert(tx, 'sales_doc_lines', dev, {
        doc_id: cnId, line_no: i + 1, product_id: s.product_id, description: s.description, hsn: s.hsn,
        entry_json: { [s.rate_unit_code]: milliText(l.rateQty) }, base_qty_milli: l.baseQty, rate_unit_id: s.rate_unit_id,
        rate_qty_milli: l.rateQty, rate_paise: s.rate_paise, rate_inclusive: s.rate_inclusive, discount_paise: l.discount, taxable_paise: l.taxable,
        gst_bp: s.gst_bp, cgst_paise: l.cgst, sgst_paise: l.sgst, igst_paise: l.igst, line_total_paise: l.total,
        cost_per_base_paise: s.cost_per_base_paise ?? 0, cost_total_paise: l.costTotal, ref_line_id: s.id,
      });
      if (s.track_stock && l.baseQty > 0) {
        await insert(tx, 'stock_moves', dev, {
          move_date: date, product_id: s.product_id, qty_milli: l.baseQty, value_paise: l.costTotal, source_type: 'CN', source_id: cnId, source_line_id: lineId,
        });
      }
    }
    const partyAcc = await partyAccountId(tx, dev, doc.party_id);
    await post(tx, dev, {
      date, sourceType: 'CN', sourceId: cnId, narration: `${docNo} against ${doc.doc_no}`,
      lines: [
        { accountId: await accountId(tx, 'SALES'), debit: totals.taxable },
        { accountId: await accountId(tx, 'OUT_CGST'), debit: totals.cgst },
        { accountId: await accountId(tx, 'OUT_SGST'), debit: totals.sgst },
        { accountId: await accountId(tx, 'OUT_IGST'), debit: totals.igst },
        { accountId: await accountId(tx, 'ROUND_OFF'), debit: totals.roundOff },
        { accountId: partyAcc, credit: totals.total },
      ],
    });

    // If the bill was already paid, money above the reduced bill goes back to the customer's advance:
    // release that much of the bill's receipt allocations, newest first.
    let release = p.overflow;
    if (release > 0) {
      const allocs = await all<{ id: string; money_doc_id: string; amount_paise: number }>(tx, `
        SELECT a.id, a.money_doc_id, a.amount_paise FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
        WHERE a.sales_doc_id = ? AND a.deleted = 0 AND m.status = 'active' ORDER BY a.created_at DESC`, [doc.id]);
      for (const a of allocs) {
        if (release <= 0) break;
        const amt = Number(a.amount_paise);
        const take = Math.min(amt, release);
        await update(tx, 'money_allocations', dev, a.id, { deleted: 1 });
        if (amt - take > 0) await insert(tx, 'money_allocations', dev, { money_doc_id: a.money_doc_id, sales_doc_id: doc.id, amount_paise: amt - take });
        release -= take;
      }
    }

    let refundNo: string | null = null;
    let refundId: string | null = null;
    if (p.refund) {
      refundNo = await nextNumber(tx, dev, 'PAY', fy, settings);
      refundId = await insert(tx, 'money_docs', dev, {
        doc_type: 'PAY', doc_no: refundNo, doc_date: date, fy, party_id: doc.party_id, amount_paise: p.refund.amount, mode: p.refund.mode,
        notes: `Refund for ${docNo}`, created_by: ctx.userId,
      });
      // Linked to the credit note, which marks it as a customer refund (not a supplier payment).
      await insert(tx, 'money_allocations', dev, { money_doc_id: refundId, sales_doc_id: cnId, amount_paise: p.refund.amount });
      await post(tx, dev, {
        date, sourceType: 'PAY', sourceId: refundId, narration: `${refundNo} refund for ${docNo}`,
        lines: [{ accountId: partyAcc, debit: p.refund.amount }, { accountId: await accountId(tx, CASH_ACCOUNT[p.refund.mode]), credit: p.refund.amount }],
      });
    }
    await audit(tx, dev, ctx.userId, 'sales_docs', cnId, 'create', { docNo, against: doc.doc_no, total: totals.total, refund: p.refund?.amount ?? 0 }, p.input.reason);
    return { id: cnId, docNo, total: totals.total, refundId, refundNo, ...returnPreviewOf(p) };
  });
}

// ---------------------------------------------------------------------
// Outstanding and statement
// ---------------------------------------------------------------------

/** "18" or "1.5" (% per year) -> basis points */
const percentBp = (v: string | undefined) => {
  try {
    return v ? parseScaled(v, 2, 'interest') : 0;
  } catch {
    return 0;
  }
};

const BUCKETS = [
  { key: 'd0_30', max: 30 },
  { key: 'd31_60', max: 60 },
  { key: 'd61_90', max: 90 },
  { key: 'd90_plus', max: Infinity },
] as const;
type BucketKey = (typeof BUCKETS)[number]['key'];
const bucketOf = (days: number): BucketKey => BUCKETS.find((b) => days <= b.max)!.key;

async function outstanding(ex: Exec) {
  const today = todayIST();
  const s = withDefaults(await getSettings(ex));
  const interestBp = percentBp(s['credit.interest_pa']);
  const parties = await all<{ id: string; balance: number }>(ex, `
    SELECT p.id, b.balance_paise AS balance FROM parties p JOIN v_party_balance b ON b.party_id = p.id
    WHERE p.deleted = 0 AND p.party_type IN ('customer','both') AND b.balance_paise > 0 ORDER BY b.balance_paise DESC`);
  const rows = [];
  const totals = { balancePaise: 0, overduePaise: 0, interestPaise: 0, advancePaise: 0, buckets: { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 } as Record<BucketKey, number> };
  for (const pr of parties) {
    const pos = await partyPosition(ex, pr.id, today);
    const buckets: Record<BucketKey, number> = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    let overdue = 0;
    let interest = 0;
    const items = [
      ...(pos.openingDuePaise > 0 ? [{ balancePaise: pos.openingDuePaise, daysOld: pos.openingDays, overdueDays: pos.openingOverdueDays }] : []),
      ...pos.openBills,
    ];
    for (const it of items) {
      buckets[bucketOf(it.daysOld)] += it.balancePaise;
      if (it.overdueDays > 0) {
        overdue += it.balancePaise;
        if (interestBp > 0) interest += roundDiv(it.balancePaise * interestBp * it.overdueDays, 10000 * 365);
      }
    }
    const last = await one<{ d: string | null }>(ex, "SELECT MAX(doc_date) d FROM money_docs WHERE party_id = ? AND doc_type = 'RCPT' AND status = 'active' AND deleted = 0", [pr.id]);
    const oldest = items.reduce((a, it) => Math.max(a, it.daysOld), 0);
    const balance = Number(pr.balance);
    rows.push({
      partyId: pos.party.id, name_en: pos.party.name_en, name_ta: pos.party.name_ta, mobile: pos.party.mobile, lang: pos.party.lang,
      creditDays: pos.creditDays, balancePaise: balance, overduePaise: overdue, buckets, advancePaise: pos.advancePaise,
      interestPaise: interest, lastPaymentDate: last?.d ?? null, oldestDays: oldest, openBills: pos.openBills.length,
    });
    totals.balancePaise += balance;
    totals.overduePaise += overdue;
    totals.interestPaise += interest;
    totals.advancePaise += pos.advancePaise;
    for (const b of BUCKETS) totals.buckets[b.key] += buckets[b.key];
  }
  return { today, interestPa: s['credit.interest_pa'], rows, totals };
}

async function statement(ex: Exec, partyId: string, from: string, to: string) {
  const party = await getParty(ex, partyId);
  if (from > to) throw new UserError('The start date is after the end date');
  const acc = await one<{ id: string }>(ex, 'SELECT id FROM accounts WHERE party_id = ?', [partyId]);
  const accId = acc?.id ?? '';
  const opening = Number((await one<{ b: number }>(ex, 'SELECT COALESCE(SUM(debit_paise - credit_paise),0) b FROM ledger_entries WHERE account_id = ? AND deleted = 0 AND entry_date < ?', [accId, from]))?.b ?? 0);
  const moves = await all<{ entry_date: string; source_type: string; source_id: string; dr: number; cr: number; at: string }>(ex, `
    SELECT entry_date, source_type, source_id, SUM(debit_paise) dr, SUM(credit_paise) cr, MIN(created_at) at
    FROM ledger_entries WHERE account_id = ? AND deleted = 0 AND entry_date BETWEEN ? AND ?
    GROUP BY entry_date, source_type, source_id ORDER BY entry_date, at`, [accId, from, to]);
  let running = opening;
  const lines = [];
  for (const m of moves) {
    let docNo: string | null = null;
    let detail: string | null = null;
    let kind = m.source_type;
    if (m.source_type === 'INV' || m.source_type === 'CN') {
      const d = await one<{ doc_no: string; site: string | null; ref: string | null }>(ex,
        'SELECT d.doc_no, d.site, r.doc_no AS ref FROM sales_docs d LEFT JOIN sales_docs r ON r.id = d.ref_doc_id WHERE d.id = ?', [m.source_id]);
      docNo = d?.doc_no ?? null;
      detail = m.source_type === 'CN' ? d?.ref ?? null : d?.site ?? null;
    } else if (m.source_type === 'RCPT' || m.source_type === 'PAY') {
      const d = await one<{ doc_no: string; mode: string; reference: string | null; refund: number }>(ex, `
        SELECT m.doc_no, m.mode, m.reference,
          EXISTS (SELECT 1 FROM money_allocations a WHERE a.money_doc_id = m.id AND a.sales_doc_id IS NOT NULL AND a.deleted = 0) AS refund
        FROM money_docs m WHERE m.id = ?`, [m.source_id]);
      docNo = d?.doc_no ?? null;
      detail = d ? [d.mode, d.reference].filter(Boolean).join(' ') : null;
      if (m.source_type === 'PAY' && d?.refund) kind = 'REFUND';
    } else if (m.source_type === 'PUR' || m.source_type === 'DN') {
      const d = await one<{ doc_no: string; supplier_bill_no: string | null }>(ex, 'SELECT doc_no, supplier_bill_no FROM purchase_docs WHERE id = ?', [m.source_id]);
      docNo = d?.doc_no ?? null;
      detail = d?.supplier_bill_no ?? null;
    }
    const dr = Number(m.dr);
    const cr = Number(m.cr);
    running += dr - cr;
    lines.push({ date: m.entry_date, kind, sourceId: m.source_id, docNo, detail, debitPaise: dr, creditPaise: cr, balancePaise: running });
  }
  const s = withDefaults(await getSettings(ex));
  const enabled = s['app.languages'].split(',');
  const lang = party.lang && enabled.includes(party.lang) ? party.lang : s['invoice.default_lang'];
  return {
    party, from, to, lang, openingPaise: opening, lines, closingPaise: running,
    totals: { debitPaise: lines.reduce((a, l) => a + l.debitPaise, 0), creditPaise: lines.reduce((a, l) => a + l.creditPaise, 0) },
    balanceTodayPaise: await partyBalance(ex, partyId), settings: s,
  };
}

/** Bills register for the Bills screen: balances, returns and payment state in one list. */
async function billsRegister(ex: Exec, from: string, to: string, q: string) {
  const like = `%${q.trim().toLowerCase()}%`;
  const rows = await all<{ id: string; doc_no: string; doc_date: string; party_id: string; party_name: string; name_en: string; name_ta: string | null; mobile: string | null; site: string | null; total_paise: number; status: string; cancel_reason: string | null; paid: number; returned: number; cns: string | null; lang: string }>(ex, `
    SELECT d.id, d.doc_no, d.doc_date, d.party_id, d.party_name, p.name_en, p.name_ta, p.mobile, d.site, d.total_paise, d.status, d.cancel_reason, d.lang,
      COALESCE((SELECT SUM(a.amount_paise) FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
        WHERE a.sales_doc_id = d.id AND a.deleted = 0 AND m.status = 'active' AND m.deleted = 0), 0) AS paid,
      COALESCE((SELECT SUM(c.total_paise) FROM sales_docs c WHERE c.ref_doc_id = d.id AND c.doc_type = 'CN' AND c.status = 'active' AND c.deleted = 0), 0) AS returned,
      (SELECT json_group_array(json_object('id', c.id, 'docNo', c.doc_no, 'date', c.doc_date, 'totalPaise', c.total_paise))
        FROM sales_docs c WHERE c.ref_doc_id = d.id AND c.doc_type = 'CN' AND c.status = 'active' AND c.deleted = 0) AS cns
    FROM sales_docs d JOIN parties p ON p.id = d.party_id
    WHERE d.doc_type = 'INV' AND d.deleted = 0 AND d.doc_date BETWEEN ? AND ?
      AND (? = '%%' OR lower(d.doc_no) LIKE ? OR lower(d.party_name) LIKE ? OR lower(p.name_en) LIKE ? OR lower(COALESCE(p.name_ta,'')) LIKE ? OR COALESCE(p.mobile,'') LIKE ?)
    ORDER BY d.doc_date DESC, d.created_at DESC`, [from, to, like, like, like, like, like, like]);
  return rows.map((r) => {
    const total = Number(r.total_paise);
    const paid = Number(r.paid);
    const returned = Number(r.returned);
    const balance = r.status === 'cancelled' ? 0 : Math.max(0, total - paid - returned);
    const creditNotes = (JSON.parse(r.cns ?? '[]') as Array<{ id: string | null }>).filter((c) => c.id);
    const state = r.status === 'cancelled' ? 'cancelled' : balance === 0 ? 'paid' : paid > 0 ? 'part_paid' : 'unpaid';
    return {
      id: r.id, docNo: r.doc_no, date: r.doc_date, partyId: r.party_id, partyName: r.party_name, name_en: r.name_en, name_ta: r.name_ta, site: r.site,
      totalPaise: total, paidPaise: paid, returnedPaise: returned, balancePaise: balance, status: r.status, cancelReason: r.cancel_reason,
      state, returned: creditNotes.length > 0, creditNotes, earlierMonth: r.doc_date < monthStart(todayIST()),
    };
  });
}

async function receiptDetail(ex: Exec, id: string) {
  const m = await one<Record<string, unknown>>(ex, `
    SELECT m.*, p.name_en, p.name_ta, p.mobile, p.address, p.gstin, p.lang, u.name AS created_by_name
    FROM money_docs m JOIN parties p ON p.id = m.party_id LEFT JOIN users u ON u.id = m.created_by WHERE m.id = ? AND m.deleted = 0`, [id]);
  if (!m || m.doc_type !== 'RCPT') throw new UserError('Receipt not found', 'NOT_FOUND', 404);
  const allocations = await all(ex, `
    SELECT a.amount_paise, d.id AS bill_id, d.doc_no, d.doc_date, d.total_paise FROM money_allocations a JOIN sales_docs d ON d.id = a.sales_doc_id
    WHERE a.money_doc_id = ? AND a.deleted = 0 ORDER BY d.doc_date`, [id]);
  const balance = await partyBalance(ex, String(m.party_id));
  return { receipt: m, allocations, balanceNowPaise: balance, settings: withDefaults(await getSettings(ex)) };
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

export function registerSalesOps(app: FastifyInstance, db: Db, deviceId: string): void {
  const ctxOf = (req: FastifyRequest): Ctx => ({ deviceId, userId: req.user!.id });
  const idParam = (req: FastifyRequest) => z.object({ id: z.string().min(1) }).parse(req.params).id;
  const Range = z.object({ from: isoDate.optional(), to: isoDate.optional() });
  const Reason = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(300) });

  // ----- cancel a bill (owner) -----
  app.get('/api/bills/:id/cancel-check', async (req) => {
    const c = await cancelCheck(db, idParam(req));
    return { canCancel: c.canCancel, blocker: c.blocker, earlierMonth: c.earlierMonth, docNo: c.bill.doc_no, date: c.bill.doc_date };
  });
  app.post('/api/bills/:id/cancel', async (req) => {
    const { reason } = Reason.parse(req.body ?? {});
    return cancelBill(db, ctxOf(req), idParam(req), reason);
  });

  // ----- returns / credit notes (owner) -----
  app.get('/api/bills/:id/returnable', async (req) => {
    const id = idParam(req);
    const bill = await getInvoice(db, id);
    const lines = await returnableLines(db, id);
    return {
      bill: { id: bill.id, docNo: bill.doc_no, date: bill.doc_date, status: bill.status, totalPaise: Number(bill.total_paise) },
      creditNotes: await activeCreditNotes(db, id),
      lines: lines.map((l) => ({
        lineId: l.id, lineNo: l.line_no, description: l.description, rateUnit: l.rate_unit_code, rateUnitEn: l.rate_unit_en, rateUnitTa: l.rate_unit_ta,
        ratePaise: l.rate_paise, inclusive: !!l.rate_inclusive, gstBp: l.gst_bp, lineTotalPaise: l.line_total_paise,
        soldMilli: l.rate_qty_milli, returnedMilli: l.ret_rate_qty, returnableMilli: l.rate_qty_milli - l.ret_rate_qty,
      })),
    };
  });
  app.post('/api/bills/:id/return/preview', async (req) => returnPreviewOf(await priceReturn(db, idParam(req), req.body)));
  app.post('/api/bills/:id/return', async (req, reply) => reply.status(201).send(await createReturn(db, ctxOf(req), idParam(req), req.body)));

  /** What the invoice print needs beyond the bill: the invoice a credit note is against, returns and refunds. */
  app.get('/api/sales-docs/:id/links', async (req) => {
    const id = idParam(req);
    const d = await one<{ id: string; doc_type: string; ref_doc_id: string | null }>(db, 'SELECT id, doc_type, ref_doc_id FROM sales_docs WHERE id = ? AND deleted = 0', [id]);
    if (!d) throw new UserError('Bill not found', 'NOT_FOUND', 404);
    const ref = d.ref_doc_id ? await one<{ id: string; doc_no: string; doc_date: string }>(db, 'SELECT id, doc_no, doc_date FROM sales_docs WHERE id = ?', [d.ref_doc_id]) : null;
    const creditNotes = d.doc_type === 'INV' ? await activeCreditNotes(db, id) : [];
    const refunded = d.doc_type === 'CN' ? Number((await one<{ s: number }>(db, `
      SELECT COALESCE(SUM(a.amount_paise),0) s FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
      WHERE a.sales_doc_id = ? AND a.deleted = 0 AND m.doc_type = 'PAY' AND m.status = 'active'`, [id]))?.s ?? 0) : 0;
    const reason = d.doc_type === 'CN' ? (await one<{ notes: string | null }>(db, 'SELECT notes FROM sales_docs WHERE id = ?', [id]))?.notes ?? null : null;
    return { docType: d.doc_type, ref, creditNotes, returnedPaise: creditNotes.reduce((a, c) => a + Number(c.total_paise), 0), refundedPaise: refunded, reason };
  });

  app.get('/api/sales/bills', async (req) => {
    const q = Range.extend({ q: z.string().max(60).optional() }).parse(req.query);
    const today = todayIST();
    return billsRegister(db, q.from ?? today, q.to ?? today, q.q ?? '');
  });

  // ----- receipts -----
  app.get('/api/receipts', async (req) => {
    const q = Range.extend({ partyId: z.string().optional() }).parse(req.query);
    const today = todayIST();
    return all(db, `
      SELECT m.id, m.doc_no, m.doc_date, m.party_id, p.name_en, p.name_ta, m.amount_paise, m.mode, m.reference, m.status, m.notes,
        COALESCE((SELECT SUM(a.amount_paise) FROM money_allocations a WHERE a.money_doc_id = m.id AND a.deleted = 0), 0) AS allocated_paise,
        (SELECT group_concat(d.doc_no, ', ') FROM money_allocations a JOIN sales_docs d ON d.id = a.sales_doc_id WHERE a.money_doc_id = m.id AND a.deleted = 0) AS bills
      FROM money_docs m JOIN parties p ON p.id = m.party_id
      WHERE m.doc_type = 'RCPT' AND m.deleted = 0 AND m.doc_date BETWEEN ? AND ? ${q.partyId ? 'AND m.party_id = ?' : ''}
      ORDER BY m.doc_date DESC, m.created_at DESC`, [q.from ?? today, q.to ?? today, ...(q.partyId ? [q.partyId] : [])]);
  });
  app.post('/api/receipts/preview', async (req) => previewOf(await planReceipt(db, req.body)));
  app.post('/api/receipts', async (req, reply) => reply.status(201).send(await createReceipt(db, ctxOf(req), req.body)));
  app.get('/api/receipts/:id', async (req) => receiptDetail(db, idParam(req)));
  app.post('/api/receipts/:id/cancel', async (req) => {
    const { reason } = Reason.parse(req.body ?? {});
    return cancelReceipt(db, ctxOf(req), idParam(req), reason);
  });

  // ----- customer position -----
  app.get('/api/parties/:id/open-bills', async (req) => {
    const pos = await partyPosition(db, idParam(req));
    return {
      party: pos.party, creditDays: pos.creditDays, bills: pos.openBills, openingDuePaise: pos.openingDuePaise, openingDate: pos.openingDate,
      advancePaise: pos.advancePaise, balancePaise: pos.ledgerBalancePaise,
    };
  });
  app.post('/api/parties/:id/apply-advance', async (req) => applyAdvance(db, ctxOf(req), idParam(req)));

  app.get('/api/outstanding', async () => outstanding(db));

  app.get('/api/parties/:id/statement', async (req) => {
    const q = Range.parse(req.query);
    const today = todayIST();
    const to = q.to ?? today;
    return statement(db, idParam(req), q.from ?? `${financialYearStart(to)}`, to);
  });
}

/** 1 April of the financial year containing the date. */
function financialYearStart(d: string) {
  const y = Number(d.slice(0, 4));
  return Number(d.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
}
