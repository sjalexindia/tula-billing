import {
  calcLine, financialYear, roundDiv, roundToRupee, stateFromGstin, supplyTypeFor, taxFor, toBaseMilli, toMilli, toPaise, todayIST,
  withDefaults, type Settings, type SupplyType,
} from '@tula/core';
import { all, getSettings, insert, nowIso, one, softDelete, update, type Db, type Exec } from '@tula/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accountId, partyAccountId, partyBalance, post } from './accounts';
import { nextNumber } from './bills';
import { avgCost, getProduct, productUnits, stockOnHand, type ProductRow } from './catalog';
import { UserError, type Ctx } from './context';
import { GST_RATES } from './masters';

// =====================================================================
// Shared helpers
// =====================================================================
const decimal = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const payMode = z.enum(['cash', 'upi', 'bank', 'cheque']);
type PayMode = z.infer<typeof payMode>;
/** Where money goes out from, per payment mode. A cheque clears through the bank. */
const CASH_ACCOUNT: Record<PayMode, string> = { cash: 'CASH', upi: 'UPI', bank: 'BANK', cheque: 'BANK' };
const idOf = (req: FastifyRequest) => z.object({ id: z.string().min(1) }).parse(req.params).id;
const has = (v: string | undefined | null): v is string => v != null && v !== '';

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

async function audit(ex: Exec, ctx: Ctx, entity: string, entityId: string, action: string, after?: unknown, reason?: string) {
  await insert(ex, 'audit_log', ctx.deviceId, { at: nowIso(), user_id: ctx.userId, entity, entity_id: entityId, action, after_json: after ?? null, reason: reason ?? null });
}

async function loadSettings(ex: Exec): Promise<Settings> {
  return withDefaults(await getSettings(ex));
}

/** GST percent text ("18", "2.5") to basis points, limited to the rates in use. */
function gstBp(v: string, what: string): number {
  if (!GST_RATES.includes(String(Number(v)))) throw new UserError(`${what}: GST % must be one of ${GST_RATES.join(', ')}`, 'BAD_GST');
  return toPaise(v);
}

function checkDate(date: string, what = 'date') {
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new UserError(`The ${what} is not a real date`, 'BAD_DATE');
  if (date > todayIST()) throw new UserError(`The ${what} cannot be in the future`, 'FUTURE_DATE');
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Split `total` across `weights` in proportion, so the parts add up exactly (largest remainder). */
export function apportion(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const parts = weights.map((w) => Math.floor((abs * w) / sum));
  let left = abs - parts.reduce((a, p) => a + p, 0);
  const order = weights.map((w, i) => ({ i, rem: (abs * w) % sum })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    parts[o.i]! += 1;
    left -= 1;
  }
  return parts.map((p) => p * sign);
}

/** The ledger account for an expense head, created the first time it is used. */
export async function expenseAccountId(ex: Exec, deviceId: string, headId: string): Promise<string> {
  const code = `EXP:${headId}`;
  const r = await one<{ id: string }>(ex, 'SELECT id FROM accounts WHERE code = ?', [code]);
  if (r) return r.id;
  const h = await one<{ name_en: string; name_ta: string | null }>(ex, 'SELECT name_en, name_ta FROM expense_heads WHERE id = ? AND deleted = 0', [headId]);
  if (!h) throw new UserError('Expense head not found', 'NOT_FOUND', 404);
  return insert(ex, 'accounts', deviceId, { code, name_en: h.name_en, name_ta: h.name_ta, kind: 'expense', expense_head_id: headId });
}

interface PartyRow { id: string; party_type: string; name_en: string; name_ta: string | null; gstin: string | null; state_code: string; credit_days: number; is_walk_in: number }
async function getParty(ex: Exec, id: string): Promise<PartyRow | undefined> {
  return one<PartyRow>(ex, 'SELECT id, party_type, name_en, name_ta, gstin, state_code, credit_days, is_walk_in FROM parties WHERE id = ? AND deleted = 0', [id]);
}
async function getSupplier(ex: Exec, id: string): Promise<PartyRow> {
  const p = await getParty(ex, id);
  if (!p) throw new UserError('Supplier not found', 'NO_PARTY', 404);
  if (p.party_type === 'customer') throw new UserError(`${p.name_en} is a customer. Mark them as a supplier on the Customers screen first.`, 'NOT_SUPPLIER');
  return p;
}

/** Quantity typed in any of the item's units (signed allowed) to base-unit thousandths. */
async function entryToBase(ex: Exec, p: ProductRow, entry: Record<string, string>): Promise<{ baseQty: number; entry: Record<string, string> }> {
  const units = await productUnits(ex, p.id);
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry)) if (v.trim() !== '' && v.trim() !== '0') clean[k] = v.trim();
  const milli = Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, toMilli(v)]));
  const baseQty = toBaseMilli(milli, units.map((u) => ({ unitCode: u.code, factorMilli: Number(u.factor_milli) })), p.base_unit_code);
  return { baseQty, entry: clean };
}

// =====================================================================
// Purchase bills
// =====================================================================
const PurchaseInput = z.object({
  supplierId: z.string().min(1),
  /** the number printed on the supplier's invoice */
  supplierBillNo: z.string().max(30).default(''),
  date: isoDate.optional(),
  lines: z.array(z.object({
    productId: z.string().min(1),
    /** quantities keyed by unit code, e.g. { KG: "2466.5" } (mill weight) or { BDL: "10" } */
    entry: z.record(z.string(), decimal),
    /** ₹ per rate unit, excl. GST unless ratesIncludeGst */
    rate: decimal,
    discount: decimal.optional(),
    /** GST % on this line; defaults to the item's rate */
    gst: decimal.optional(),
  })).min(1).max(100),
  /** freight, loading etc. on the supplier's bill: not stock, spread over the items' landed cost by value */
  charges: z.array(z.object({ description: z.string().trim().min(1).max(80), amount: decimal, gst: decimal.optional() })).max(10).optional(),
  ratesIncludeGst: z.boolean().optional(),
  itcEligible: z.boolean().optional(),
  payment: z.object({ mode: payMode, amount: decimal, reference: z.string().max(40).optional() }).optional(),
  notes: z.string().max(500).optional(),
});
export type PurchaseInput = z.input<typeof PurchaseInput>;

/** Whether input tax can be claimed: regular GST scheme and a supplier with a GSTIN. */
function itcAllowed(settings: Settings, gstin: string | null): { ok: boolean; why?: string } {
  if (settings['gst.scheme'] !== 'regular') return { ok: false, why: 'Your business is not on the regular GST scheme, so input tax cannot be claimed' };
  if (!gstin) return { ok: false, why: "Input tax can be claimed only on a bill from a GST-registered supplier. Add the supplier's GSTIN first." };
  return { ok: true };
}

interface PricedItem {
  lineNo: number; product: ProductRow; entry: Record<string, string>; baseQty: number; rateUnitId: string; rateQty: number; ratePaise: number; gstBp: number;
  gross: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; total: number; tax: number;
  /** taxable + tax when no ITC */ cost: number; /** share of freight/loading */ share: number; landed: number; landedPerBase: number;
}

export async function pricePurchase(ex: Exec, raw: unknown) {
  const input = PurchaseInput.parse(raw);
  const date = input.date ?? todayIST();
  checkDate(date, 'bill date');
  const settings = await loadSettings(ex);
  const businessState = settings['business.state_code'];
  if (!businessState) throw new UserError('Set the business state in Settings first', 'SETUP_INCOMPLETE', 409);
  const supplier = await getSupplier(ex, input.supplierId);
  const supplierState = stateFromGstin(supplier.gstin) ?? supplier.state_code ?? businessState;
  const supply: SupplyType = supplyTypeFor(businessState, supplierState);

  const allowed = itcAllowed(settings, supplier.gstin);
  if (input.itcEligible === true && !allowed.ok) throw new UserError(allowed.why!, 'NO_ITC');
  const itc = input.itcEligible ?? allowed.ok;
  const inclusive = !!input.ratesIncludeGst;

  const supplierBillNo = input.supplierBillNo.trim();
  if (!supplierBillNo) throw new UserError("Enter the supplier's bill number", 'NO_BILL_NO');
  const dupe = await one<{ doc_no: string }>(ex, `SELECT doc_no FROM purchase_docs WHERE doc_type = 'PUR' AND party_id = ? AND upper(trim(supplier_bill_no)) = upper(?)
    AND status = 'active' AND deleted = 0`, [supplier.id, supplierBillNo]);
  if (dupe) throw new UserError(`Bill ${supplierBillNo} from ${supplier.name_en} is already entered as ${dupe.doc_no}`, 'DUPLICATE', 409);

  const items: PricedItem[] = [];
  for (const [i, l] of input.lines.entries()) {
    const n = i + 1;
    const p = await getProduct(ex, l.productId);
    if (!p) throw new UserError(`Line ${n}: item not found`, 'NO_PRODUCT', 404);
    const { baseQty, entry } = await entryToBase(ex, p, l.entry);
    if (baseQty <= 0) throw new UserError(`Line ${n}: enter the quantity of ${p.name_en}`, 'NO_QTY');
    const rateUnitId = p.rate_unit_id ?? p.base_unit_id;
    let rateQty = baseQty;
    if (rateUnitId !== p.base_unit_id) {
      const ru = (await productUnits(ex, p.id)).find((u) => u.unit_id === rateUnitId);
      if (!ru) throw new UserError(`Line ${n}: rate unit not set up for ${p.name_en}`);
      rateQty = roundDiv(baseQty * 1000, Number(ru.factor_milli));
    }
    if (!has(l.rate)) throw new UserError(`Line ${n}: enter the rate of ${p.name_en}`, 'NO_RATE');
    const ratePaise = toPaise(l.rate);
    const bp = has(l.gst) ? gstBp(l.gst, `Line ${n}`) : Number(p.gst_bp);
    let amounts;
    try {
      amounts = calcLine({ rateQtyMilli: rateQty, ratePaise, discountPaise: has(l.discount) ? toPaise(l.discount) : 0, gstBp: bp, inclusive }, supply);
    } catch (e) {
      throw new UserError(`Line ${n}: ${(e as Error).message}`);
    }
    const tax = amounts.cgst + amounts.sgst + amounts.igst;
    items.push({ lineNo: n, product: p, entry, baseQty, rateUnitId, rateQty, ratePaise, gstBp: bp, ...amounts, tax, cost: amounts.taxable + (itc ? 0 : tax), share: 0, landed: 0, landedPerBase: 0 });
  }

  const charges = (input.charges ?? []).filter((c) => has(c.amount)).map((c, i) => {
    const taxable = toPaise(c.amount);
    if (taxable <= 0) throw new UserError(`${c.description}: amount must be more than 0`, 'BAD_AMOUNT');
    const bp = has(c.gst) ? gstBp(c.gst, c.description) : 0;
    const t = taxFor(taxable, bp, supply);
    const tax = t.cgst + t.sgst + t.igst;
    return { lineNo: items.length + i + 1, description: c.description, taxable, gstBp: bp, ...t, tax, total: taxable + tax, cost: taxable + (itc ? 0 : tax) };
  });

  // Landed cost: each stock item's own cost plus its share of the charges, by taxable value.
  const chargeCost = charges.reduce((a, c) => a + c.cost, 0);
  const stockItems = items.filter((x) => x.product.track_stock);
  const shares = apportion(chargeCost, stockItems.map((x) => x.taxable || 0));
  stockItems.forEach((x, i) => { x.share = shares[i] ?? 0; });
  for (const x of items) {
    x.landed = x.cost + x.share;
    x.landedPerBase = roundDiv(x.landed * 1000, x.baseQty);
  }

  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => items.reduce((a, x) => a + x[k], 0) + charges.reduce((a, c) => a + c[k], 0);
  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const beforeRoundOff = taxable + cgst + sgst + igst;
  const { roundOff, total } = roundToRupee(beforeRoundOff);
  const totals = { taxable, cgst, sgst, igst, beforeRoundOff, roundOff, total, chargesPaise: charges.reduce((a, c) => a + c.taxable, 0) };

  const paid = input.payment && has(input.payment.amount) ? toPaise(input.payment.amount) : 0;
  if (paid < 0) throw new UserError('Payment cannot be negative', 'BAD_AMOUNT');
  if (paid > total) throw new UserError('Payment is more than the bill total. Record the extra as a separate supplier payment.', 'OVERPAID');

  const dueDate = addDays(date, Number(supplier.credit_days ?? 0));
  return { input, date, supplier, supplierBillNo, supply, itc, itcPossible: allowed.ok, inclusive, items, charges, totals, paid, dueDate, settings };
}

async function createPurchase(db: Db, ctx: Ctx, raw: unknown) {
  return inTx(db, async (tx) => {
    const pr = await pricePurchase(tx, raw);
    const { date, supplier, items, charges, totals, itc, supply, settings } = pr;
    const dev = ctx.deviceId;
    const fy = financialYear(date);
    const docNo = await nextNumber(tx, dev, 'PUR', fy, settings);
    const docId = await insert(tx, 'purchase_docs', dev, {
      doc_type: 'PUR', doc_no: docNo, supplier_bill_no: pr.supplierBillNo, doc_date: date, fy, party_id: supplier.id, supply_type: supply,
      taxable_paise: totals.taxable, cgst_paise: totals.cgst, sgst_paise: totals.sgst, igst_paise: totals.igst, round_off_paise: totals.roundOff,
      total_paise: totals.total, itc_eligible: itc ? 1 : 0, due_date: pr.dueDate, notes: pr.input.notes ?? null, created_by: ctx.userId,
    });
    for (const x of items) {
      const lineId = await insert(tx, 'purchase_doc_lines', dev, {
        doc_id: docId, line_no: x.lineNo, product_id: x.product.id, description: [x.product.brand, x.product.name_en].filter(Boolean).join(' '),
        entry_json: x.entry, base_qty_milli: x.baseQty, rate_unit_id: x.rateUnitId, rate_qty_milli: x.rateQty, rate_paise: x.ratePaise,
        discount_paise: x.discount, taxable_paise: x.taxable, gst_bp: x.gstBp, cgst_paise: x.cgst, sgst_paise: x.sgst, igst_paise: x.igst,
        line_total_paise: x.total, landed_cost_paise: x.landed, charge_share_paise: x.share,
      });
      if (x.product.track_stock) {
        await insert(tx, 'stock_moves', dev, { move_date: date, product_id: x.product.id, qty_milli: x.baseQty, value_paise: x.landed, source_type: 'PUR', source_id: docId, source_line_id: lineId });
      }
    }
    for (const c of charges) {
      await insert(tx, 'purchase_doc_lines', dev, {
        doc_id: docId, line_no: c.lineNo, product_id: null, description: c.description, taxable_paise: c.taxable, gst_bp: c.gstBp,
        cgst_paise: c.cgst, sgst_paise: c.sgst, igst_paise: c.igst, line_total_paise: c.total, landed_cost_paise: null,
      });
    }
    const tax = totals.cgst + totals.sgst + totals.igst;
    const partyAcc = await partyAccountId(tx, dev, supplier.id);
    await post(tx, dev, {
      date, sourceType: 'PUR', sourceId: docId, narration: `${docNo} (${pr.supplierBillNo})`,
      lines: [
        { accountId: await accountId(tx, 'PURCHASES'), debit: totals.taxable + (itc ? 0 : tax) },
        { accountId: await accountId(tx, 'IN_CGST'), debit: itc ? totals.cgst : 0 },
        { accountId: await accountId(tx, 'IN_SGST'), debit: itc ? totals.sgst : 0 },
        { accountId: await accountId(tx, 'IN_IGST'), debit: itc ? totals.igst : 0 },
        { accountId: await accountId(tx, 'ROUND_OFF'), debit: totals.roundOff },
        { accountId: partyAcc, credit: totals.total },
      ],
    });
    let paymentNo: string | null = null;
    if (pr.paid > 0 && pr.input.payment) {
      const p = await savePayment(tx, ctx, {
        partyId: supplier.id, amountPaise: pr.paid, mode: pr.input.payment.mode, reference: pr.input.payment.reference, date,
        notes: `Paid with purchase ${docNo}`, allocations: [{ purchaseId: docId, amountPaise: pr.paid }],
      });
      paymentNo = p.docNo;
    }
    await audit(tx, ctx, 'purchase_docs', docId, 'create', { docNo, supplierBillNo: pr.supplierBillNo, total: totals.total, itc });
    return { id: docId, docNo, paymentNo, total: totals.total, dueDate: pr.dueDate };
  });
}

/** What is still owed on each active purchase bill: total − payments allocated − debit notes. */
const DUE_SQL = `
  d.total_paise
  - COALESCE((SELECT SUM(a.amount_paise) FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
      WHERE a.purchase_doc_id = d.id AND a.deleted = 0 AND m.status = 'active' AND m.deleted = 0), 0)
  - COALESCE((SELECT SUM(n.total_paise) FROM purchase_docs n
      WHERE n.ref_doc_id = d.id AND n.doc_type = 'DN' AND n.status = 'active' AND n.deleted = 0), 0)`;

interface OpenBill { id: string; doc_no: string; supplier_bill_no: string | null; doc_date: string; due_date: string | null; total_paise: number; due_paise: number }
async function openBills(ex: Exec, partyId: string): Promise<OpenBill[]> {
  const rows = await all<OpenBill>(ex, `
    SELECT d.id, d.doc_no, d.supplier_bill_no, d.doc_date, d.due_date, d.total_paise, ${DUE_SQL} AS due_paise
    FROM purchase_docs d WHERE d.doc_type = 'PUR' AND d.status = 'active' AND d.deleted = 0 AND d.party_id = ?
    ORDER BY COALESCE(d.due_date, d.doc_date), d.doc_date, d.doc_no`, [partyId]);
  return rows.map((r) => ({ ...r, total_paise: Number(r.total_paise), due_paise: Number(r.due_paise) })).filter((r) => r.due_paise > 0);
}

async function getPurchase(ex: Exec, id: string) {
  const doc = await one<Record<string, unknown>>(ex, `
    SELECT d.*, p.name_en AS party_en, p.name_ta AS party_ta, p.gstin AS party_gstin, r.doc_no AS ref_doc_no, ${DUE_SQL} AS due_paise
    FROM purchase_docs d JOIN parties p ON p.id = d.party_id LEFT JOIN purchase_docs r ON r.id = d.ref_doc_id
    WHERE d.id = ? AND d.deleted = 0`, [id]);
  if (!doc) throw new UserError('Purchase not found', 'NOT_FOUND', 404);
  const lines = await all<Record<string, unknown>>(ex, `
    SELECT l.*, pr.sku, pr.name_en, pr.name_ta, u.code AS base_unit, u.name_en AS base_unit_en, u.name_ta AS base_unit_ta,
      COALESCE((SELECT SUM(x.base_qty_milli) FROM purchase_doc_lines x JOIN purchase_docs n ON n.id = x.doc_id
        WHERE x.ref_line_id = l.id AND x.deleted = 0 AND n.status = 'active' AND n.deleted = 0), 0) AS returned_milli
    FROM purchase_doc_lines l LEFT JOIN products pr ON pr.id = l.product_id LEFT JOIN units u ON u.id = pr.base_unit_id
    WHERE l.doc_id = ? AND l.deleted = 0 ORDER BY l.line_no`, [id]);
  const payments = await all(ex, `
    SELECT m.id, m.doc_no, m.doc_date, m.mode, a.amount_paise FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
    WHERE a.purchase_doc_id = ? AND a.deleted = 0 AND m.status = 'active' AND m.deleted = 0 ORDER BY m.doc_date`, [id]);
  const returns = await all(ex, `SELECT id, doc_no, doc_date, total_paise, status, notes FROM purchase_docs WHERE ref_doc_id = ? AND doc_type = 'DN' AND deleted = 0 ORDER BY doc_date, doc_no`, [id]);
  return {
    doc: { ...doc, due_paise: Math.max(0, Number(doc.due_paise)) },
    lines: lines.map((l) => ({ ...l, entry_json: l.entry_json ? JSON.parse(String(l.entry_json)) : null, remaining_milli: Number(l.base_qty_milli) - Number(l.returned_milli) })),
    payments, returns,
  };
}

const CancelInput = z.object({ reason: z.string().trim().max(200).default(''), confirmWarnings: z.boolean().optional() });

async function cancelPurchase(db: Db, ctx: Ctx, id: string, raw: unknown) {
  const b = CancelInput.parse(raw ?? {});
  if (!b.reason) throw new UserError('Say why the purchase is being cancelled', 'NO_REASON');
  return inTx(db, async (tx) => {
    const doc = await one<{ id: string; doc_type: string; doc_no: string; status: string; ref_doc_id: string | null }>(tx, 'SELECT id, doc_type, doc_no, status, ref_doc_id FROM purchase_docs WHERE id = ? AND deleted = 0', [id]);
    if (!doc) throw new UserError('Purchase not found', 'NOT_FOUND', 404);
    if (doc.status === 'cancelled') throw new UserError(`${doc.doc_no} is already cancelled`, 'ALREADY_CANCELLED');
    if (doc.doc_type === 'PUR') {
      const dn = await one<{ doc_no: string }>(tx, "SELECT doc_no FROM purchase_docs WHERE ref_doc_id = ? AND doc_type = 'DN' AND status = 'active' AND deleted = 0", [id]);
      if (dn) throw new UserError(`Cancel debit note ${dn.doc_no} first`, 'HAS_RETURNS');
    }
    // Stock check: removing goods that came in may take stock below zero (they may already be sold).
    const moves = await all<{ product_id: string; q: number; sku: string; name_en: string }>(tx, `
      SELECT m.product_id, SUM(m.qty_milli) q, p.sku, p.name_en FROM stock_moves m JOIN products p ON p.id = m.product_id
      WHERE m.source_type = ? AND m.source_id = ? AND m.deleted = 0 GROUP BY m.product_id`, [doc.doc_type, id]);
    const warnings = [];
    for (const m of moves) {
      const after = (await stockOnHand(tx, m.product_id)) - Number(m.q);
      if (after < 0) warnings.push({ code: 'LOW_STOCK', productId: m.product_id, message: `${m.name_en}: stock would be ${after / 1000} after cancelling` });
    }
    if (warnings.length && !b.confirmWarnings) return { saved: false as const, warnings };

    await softDelete(tx, 'stock_moves', ctx.deviceId, 'source_type = ? AND source_id = ?', [doc.doc_type, id]);
    await softDelete(tx, 'ledger_entries', ctx.deviceId, 'source_type = ? AND source_id = ?', [doc.doc_type, id]);
    // Payments against this bill stay, as an advance to the supplier.
    if (doc.doc_type === 'PUR') await softDelete(tx, 'money_allocations', ctx.deviceId, 'purchase_doc_id = ?', [id]);
    await update(tx, 'purchase_docs', ctx.deviceId, id, { status: 'cancelled', cancel_reason: b.reason, cancelled_at: nowIso(), cancelled_by: ctx.userId });
    await audit(tx, ctx, 'purchase_docs', id, 'cancel', { docNo: doc.doc_no, warningsAccepted: warnings.length }, b.reason);
    return { saved: true as const, warnings };
  });
}

// ---------- Purchase return (debit note) ----------
const ReturnInput = z.object({
  date: isoDate.optional(),
  reason: z.string().trim().max(200).default(''),
  /** qty in the item's base unit */
  lines: z.array(z.object({ lineId: z.string().min(1), qty: decimal })).min(1).max(100),
});

async function createReturn(db: Db, ctx: Ctx, purchaseId: string, raw: unknown) {
  const b = ReturnInput.parse(raw);
  if (!b.reason) throw new UserError('Say why the goods are going back', 'NO_REASON');
  const date = b.date ?? todayIST();
  checkDate(date, 'return date');
  return inTx(db, async (tx) => {
    const dev = ctx.deviceId;
    const doc = await one<{ id: string; doc_no: string; doc_type: string; status: string; party_id: string; supply_type: SupplyType; itc_eligible: number; supplier_bill_no: string | null; doc_date: string }>(tx,
      'SELECT id, doc_no, doc_type, status, party_id, supply_type, itc_eligible, supplier_bill_no, doc_date FROM purchase_docs WHERE id = ? AND deleted = 0', [purchaseId]);
    if (!doc || doc.doc_type !== 'PUR') throw new UserError('Purchase not found', 'NOT_FOUND', 404);
    if (doc.status !== 'active') throw new UserError(`${doc.doc_no} is cancelled`, 'CANCELLED');
    if (date < doc.doc_date) throw new UserError('The return date cannot be before the purchase date', 'BAD_DATE');
    const itc = !!doc.itc_eligible;

    const out = [];
    const seen = new Set<string>();
    for (const r of b.lines) {
      if (seen.has(r.lineId)) throw new UserError('An item is listed twice in the return', 'DUPLICATE');
      seen.add(r.lineId);
      const qty = toMilli(r.qty);
      if (qty === 0) continue;
      const l = await one<{ id: string; product_id: string | null; description: string; base_qty_milli: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; landed_cost_paise: number; gst_bp: number; rate_unit_id: string | null; rate_paise: number; rate_qty_milli: number }>(tx,
        'SELECT * FROM purchase_doc_lines WHERE id = ? AND doc_id = ? AND deleted = 0', [r.lineId, purchaseId]);
      if (!l || !l.product_id) throw new UserError('That line is not an item on this purchase', 'BAD_LINE');
      const done = await one<{ q: number }>(tx, `SELECT COALESCE(SUM(x.base_qty_milli),0) q FROM purchase_doc_lines x JOIN purchase_docs n ON n.id = x.doc_id
        WHERE x.ref_line_id = ? AND x.deleted = 0 AND n.status = 'active' AND n.deleted = 0`, [l.id]);
      const before = Number(done?.q ?? 0);
      const base = Number(l.base_qty_milli);
      const remaining = base - before;
      if (qty < 0 || qty > remaining) throw new UserError(`${l.description}: you can return up to ${remaining / 1000}`, 'TOO_MUCH');
      // Amounts by cumulative share, so returning everything in parts adds up exactly to the original line.
      const part = (v: number) => roundDiv(Number(v) * (before + qty), base) - roundDiv(Number(v) * before, base);
      const p = (await getProduct(tx, l.product_id))!;
      out.push({
        ref: l, product: p, qty, taxable: part(l.taxable_paise), cgst: part(l.cgst_paise), sgst: part(l.sgst_paise), igst: part(l.igst_paise),
        landed: part(l.landed_cost_paise ?? 0), rateQty: roundDiv(Number(l.rate_qty_milli) * qty, base),
      });
    }
    if (!out.length) throw new UserError('Enter the quantity going back', 'NO_QTY');

    const taxable = out.reduce((a, x) => a + x.taxable, 0);
    const cgst = out.reduce((a, x) => a + x.cgst, 0);
    const sgst = out.reduce((a, x) => a + x.sgst, 0);
    const igst = out.reduce((a, x) => a + x.igst, 0);
    const { roundOff, total } = roundToRupee(taxable + cgst + sgst + igst);
    const settings = await loadSettings(tx);
    const fy = financialYear(date);
    const docNo = await nextNumber(tx, dev, 'DN', fy, settings);
    const dnId = await insert(tx, 'purchase_docs', dev, {
      doc_type: 'DN', doc_no: docNo, supplier_bill_no: doc.supplier_bill_no, doc_date: date, fy, party_id: doc.party_id, supply_type: doc.supply_type,
      ref_doc_id: doc.id, taxable_paise: taxable, cgst_paise: cgst, sgst_paise: sgst, igst_paise: igst, round_off_paise: roundOff, total_paise: total,
      itc_eligible: itc ? 1 : 0, notes: b.reason, created_by: ctx.userId,
    });
    for (const [i, x] of out.entries()) {
      const lineId = await insert(tx, 'purchase_doc_lines', dev, {
        doc_id: dnId, line_no: i + 1, product_id: x.product.id, description: x.ref.description, base_qty_milli: x.qty, rate_unit_id: x.ref.rate_unit_id,
        rate_qty_milli: x.rateQty, rate_paise: x.ref.rate_paise, taxable_paise: x.taxable, gst_bp: x.ref.gst_bp, cgst_paise: x.cgst, sgst_paise: x.sgst,
        igst_paise: x.igst, line_total_paise: x.taxable + x.cgst + x.sgst + x.igst, landed_cost_paise: x.landed, ref_line_id: x.ref.id,
      });
      if (x.product.track_stock) {
        await insert(tx, 'stock_moves', dev, { move_date: date, product_id: x.product.id, qty_milli: -x.qty, value_paise: -x.landed, source_type: 'DN', source_id: dnId, source_line_id: lineId });
      }
    }
    const tax = cgst + sgst + igst;
    await post(tx, dev, {
      date, sourceType: 'DN', sourceId: dnId, narration: `${docNo} against ${doc.doc_no}`,
      lines: [
        { accountId: await partyAccountId(tx, dev, doc.party_id), debit: total },
        { accountId: await accountId(tx, 'PURCHASES'), credit: taxable + (itc ? 0 : tax) },
        { accountId: await accountId(tx, 'IN_CGST'), credit: itc ? cgst : 0 },
        { accountId: await accountId(tx, 'IN_SGST'), credit: itc ? sgst : 0 },
        { accountId: await accountId(tx, 'IN_IGST'), credit: itc ? igst : 0 },
        { accountId: await accountId(tx, 'ROUND_OFF'), credit: roundOff },
      ],
    });
    await audit(tx, ctx, 'purchase_docs', dnId, 'create', { docNo, against: doc.doc_no, total }, b.reason);
    return { id: dnId, docNo, total };
  });
}

// =====================================================================
// Supplier payments
// =====================================================================
const PaymentInput = z.object({
  supplierId: z.string().min(1),
  amount: decimal,
  mode: payMode,
  date: isoDate.optional(),
  reference: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(300).optional(),
  /** bills to settle; when left out, the oldest due bills are settled first */
  allocations: z.array(z.object({ purchaseId: z.string().min(1), amount: decimal })).max(100).optional(),
});

/** Work out which bills a payment settles. The unallocated remainder is an advance. */
async function planPayment(ex: Exec, raw: unknown) {
  const b = PaymentInput.parse(raw);
  const date = b.date ?? todayIST();
  checkDate(date, 'payment date');
  const supplier = await getSupplier(ex, b.supplierId);
  const amountPaise = toPaise(b.amount);
  if (amountPaise <= 0) throw new UserError('Enter the amount paid', 'BAD_AMOUNT');
  const bills = await openBills(ex, supplier.id);
  let allocations: Array<{ purchaseId: string; amountPaise: number; docNo: string; supplierBillNo: string | null; dueBefore: number }> = [];
  if (b.allocations) {
    for (const a of b.allocations) {
      const amt = toPaise(a.amount);
      if (amt === 0) continue;
      const bill = bills.find((x) => x.id === a.purchaseId);
      if (!bill) throw new UserError('That bill has nothing due, or belongs to another supplier', 'BAD_ALLOCATION');
      if (amt < 0 || amt > bill.due_paise) throw new UserError(`${bill.doc_no}: at most ${bill.due_paise / 100} is due`, 'BAD_ALLOCATION');
      if (allocations.some((x) => x.purchaseId === bill.id)) throw new UserError(`${bill.doc_no} is listed twice`, 'BAD_ALLOCATION');
      allocations.push({ purchaseId: bill.id, amountPaise: amt, docNo: bill.doc_no, supplierBillNo: bill.supplier_bill_no, dueBefore: bill.due_paise });
    }
    if (allocations.reduce((s, x) => s + x.amountPaise, 0) > amountPaise) throw new UserError('The bills add up to more than the amount paid', 'BAD_ALLOCATION');
  } else {
    let left = amountPaise;
    allocations = [];
    for (const bill of bills) {
      if (left <= 0) break;
      const amt = Math.min(left, bill.due_paise);
      allocations.push({ purchaseId: bill.id, amountPaise: amt, docNo: bill.doc_no, supplierBillNo: bill.supplier_bill_no, dueBefore: bill.due_paise });
      left -= amt;
    }
  }
  const allocated = allocations.reduce((s, x) => s + x.amountPaise, 0);
  const balance = await partyBalance(ex, supplier.id);
  return { input: b, date, supplier, amountPaise, allocations, advancePaise: amountPaise - allocated, owedBefore: -balance, owedAfter: -balance - amountPaise, openBills: bills };
}

async function savePayment(tx: Exec, ctx: Ctx, p: { partyId: string; amountPaise: number; mode: PayMode; reference?: string; date: string; notes?: string; allocations: Array<{ purchaseId: string; amountPaise: number }> }) {
  const dev = ctx.deviceId;
  const fy = financialYear(p.date);
  const docNo = await nextNumber(tx, dev, 'PAY', fy, await loadSettings(tx));
  const id = await insert(tx, 'money_docs', dev, {
    doc_type: 'PAY', doc_no: docNo, doc_date: p.date, fy, party_id: p.partyId, amount_paise: p.amountPaise, mode: p.mode,
    reference: p.reference || null, notes: p.notes || null, created_by: ctx.userId,
  });
  for (const a of p.allocations) if (a.amountPaise > 0) await insert(tx, 'money_allocations', dev, { money_doc_id: id, purchase_doc_id: a.purchaseId, amount_paise: a.amountPaise });
  await post(tx, dev, {
    date: p.date, sourceType: 'PAY', sourceId: id, narration: docNo,
    lines: [{ accountId: await partyAccountId(tx, dev, p.partyId), debit: p.amountPaise }, { accountId: await accountId(tx, CASH_ACCOUNT[p.mode]), credit: p.amountPaise }],
  });
  await audit(tx, ctx, 'money_docs', id, 'create', { docNo, amount: p.amountPaise, allocations: p.allocations.length });
  return { id, docNo };
}

async function payables(ex: Exec) {
  const today = todayIST();
  const soon = addDays(today, 7);
  const suppliers = await all<{ id: string; name_en: string; name_ta: string | null; mobile: string | null; credit_days: number; balance_paise: number }>(ex, `
    SELECT p.id, p.name_en, p.name_ta, p.mobile, p.credit_days, COALESCE(b.balance_paise, 0) balance_paise
    FROM parties p LEFT JOIN v_party_balance b ON b.party_id = p.id
    WHERE p.deleted = 0 AND p.party_type IN ('supplier','both') ORDER BY p.name_en`);
  const out = [];
  const totals = { owedPaise: 0, overduePaise: 0, dueSoonPaise: 0 };
  for (const s of suppliers) {
    const owed = -Number(s.balance_paise);
    const bills = (await openBills(ex, s.id)).map((b) => {
      const due = b.due_date ?? b.doc_date;
      const overdueDays = due < today ? Math.round((Date.parse(today) - Date.parse(due)) / 86400000) : 0;
      return { ...b, overdueDays, state: due < today ? 'overdue' : due <= soon ? 'soon' : 'later' };
    });
    if (owed <= 0 && !bills.length) continue;
    const overdue = bills.filter((b) => b.state === 'overdue').reduce((a, b) => a + b.due_paise, 0);
    const dueSoon = bills.filter((b) => b.state === 'soon').reduce((a, b) => a + b.due_paise, 0);
    const billed = bills.reduce((a, b) => a + b.due_paise, 0);
    totals.owedPaise += Math.max(owed, 0);
    totals.overduePaise += overdue;
    totals.dueSoonPaise += dueSoon;
    // owed − bills due: + an opening balance not tied to a bill, − an advance paid on account
    out.push({ id: s.id, name_en: s.name_en, name_ta: s.name_ta, mobile: s.mobile, owedPaise: owed, overduePaise: overdue, dueSoonPaise: dueSoon, onAccountPaise: owed - billed, bills });
  }
  return { today, totals, suppliers: out };
}

// =====================================================================
// Expenses
// =====================================================================
export const DEFAULT_EXPENSE_HEADS: Array<[string, string]> = [
  ['Rent', 'வாடகை'],
  ['Salary / wages', 'சம்பளம் / கூலி'],
  ['Electricity', 'மின் கட்டணம்'],
  ['Loading / unloading', 'ஏற்று / இறக்கு கூலி'],
  ['Inward freight', 'சரக்கு வண்டி வாடகை'],
  ['Vehicle / fuel', 'வண்டி / எரிபொருள்'],
  ['Shop maintenance', 'கடை பராமரிப்பு'],
  ['Telephone / internet', 'போன் / இணையம்'],
  ['Miscellaneous', 'இதர செலவு'],
];

const HeadInput = z.object({ name_en: z.string().trim().min(1, 'Enter the name').max(60), name_ta: z.string().trim().max(60).nullable().optional() });

const ExpenseInput = z.object({
  date: isoDate.optional(),
  headId: z.string().min(1),
  /** amount before GST, or the full amount when amountIncludesGst */
  amount: decimal,
  amountIncludesGst: z.boolean().optional(),
  gst: decimal.optional(),
  vendorGstin: z.string().trim().toUpperCase().max(15).optional().nullable(),
  itcEligible: z.boolean().optional(),
  mode: z.enum(['cash', 'upi', 'bank', 'cheque', 'credit']),
  partyId: z.string().optional().nullable(),
  reference: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(300).optional(),
});

async function priceExpense(ex: Exec, raw: unknown) {
  const b = ExpenseInput.parse(raw);
  const date = b.date ?? todayIST();
  checkDate(date, 'expense date');
  const settings = await loadSettings(ex);
  const head = await one<{ id: string; name_en: string }>(ex, 'SELECT id, name_en FROM expense_heads WHERE id = ? AND deleted = 0', [b.headId]);
  if (!head) throw new UserError('Pick what the expense is for', 'NO_HEAD');
  const party = has(b.partyId) ? await getParty(ex, b.partyId) : undefined;
  if (has(b.partyId) && !party) throw new UserError('Party not found', 'NO_PARTY', 404);
  if (b.mode === 'credit' && !party) throw new UserError('Pick who the money is owed to', 'NO_PARTY');
  if (party?.is_walk_in && b.mode === 'credit') throw new UserError('Pick a named party for an expense on credit', 'NO_PARTY');
  const vendorGstin = b.vendorGstin || party?.gstin || null;
  if (vendorGstin && !stateFromGstin(vendorGstin)) throw new UserError('GSTIN must be 15 characters, starting with the 2-digit state code', 'BAD_GSTIN');
  const amount = toPaise(b.amount);
  if (amount <= 0) throw new UserError('Enter the amount', 'BAD_AMOUNT');
  const bp = has(b.gst) ? gstBp(b.gst, 'Expense') : 0;
  const businessState = settings['business.state_code'];
  const supply: SupplyType = supplyTypeFor(businessState, stateFromGstin(vendorGstin) ?? businessState);
  const l = calcLine({ rateQtyMilli: 1000, ratePaise: amount, gstBp: bp, inclusive: !!b.amountIncludesGst }, supply);
  const tax = l.cgst + l.sgst + l.igst;
  const allowed = tax > 0 ? itcAllowed(settings, vendorGstin) : { ok: false, why: 'There is no GST on this expense to claim' };
  if (b.itcEligible === true && !allowed.ok) throw new UserError(allowed.why!, 'NO_ITC');
  const itc = b.itcEligible ?? allowed.ok;
  return { b, date, head, party, vendorGstin, gstBp: bp, supply, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, tax, total: l.total, itc, cost: l.taxable + (itc ? 0 : tax), settings };
}

async function createExpense(db: Db, ctx: Ctx, raw: unknown) {
  return inTx(db, async (tx) => {
    const e = await priceExpense(tx, raw);
    const dev = ctx.deviceId;
    const fy = financialYear(e.date);
    const docNo = await nextNumber(tx, dev, 'EXP', fy, e.settings);
    const id = await insert(tx, 'expenses', dev, {
      doc_no: docNo, doc_date: e.date, fy, head_id: e.head.id, party_id: e.party?.id ?? null, vendor_gstin: e.vendorGstin, taxable_paise: e.taxable,
      gst_bp: e.gstBp, cgst_paise: e.cgst, sgst_paise: e.sgst, igst_paise: e.igst, total_paise: e.total, itc_eligible: e.itc ? 1 : 0,
      mode: e.b.mode, reference: e.b.reference || null, notes: e.b.notes || null, created_by: ctx.userId,
    });
    const credit = e.b.mode === 'credit' ? await partyAccountId(tx, dev, e.party!.id) : await accountId(tx, CASH_ACCOUNT[e.b.mode as PayMode]);
    await post(tx, dev, {
      date: e.date, sourceType: 'EXP', sourceId: id, narration: `${docNo} ${e.head.name_en}`,
      lines: [
        { accountId: await expenseAccountId(tx, dev, e.head.id), debit: e.cost },
        { accountId: await accountId(tx, 'IN_CGST'), debit: e.itc ? e.cgst : 0 },
        { accountId: await accountId(tx, 'IN_SGST'), debit: e.itc ? e.sgst : 0 },
        { accountId: await accountId(tx, 'IN_IGST'), debit: e.itc ? e.igst : 0 },
        { accountId: credit, credit: e.total },
      ],
    });
    await audit(tx, ctx, 'expenses', id, 'create', { docNo, total: e.total, head: e.head.name_en });
    return { id, docNo, total: e.total, itc: e.itc };
  });
}

async function listExpenses(ex: Exec, from: string, to: string) {
  const rows = await all<Record<string, unknown> & { head_id: string; status: string; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; itc_eligible: number }>(ex, `
    SELECT e.id, e.doc_no, e.doc_date, e.head_id, h.name_en AS head_en, h.name_ta AS head_ta, e.party_id, p.name_en AS party_en, p.name_ta AS party_ta,
      e.vendor_gstin, e.taxable_paise, e.gst_bp, e.cgst_paise, e.sgst_paise, e.igst_paise, e.total_paise, e.itc_eligible, e.mode, e.reference, e.notes,
      e.status, e.cancel_reason
    FROM expenses e JOIN expense_heads h ON h.id = e.head_id LEFT JOIN parties p ON p.id = e.party_id
    WHERE e.deleted = 0 AND e.doc_date BETWEEN ? AND ? ORDER BY e.doc_date DESC, e.doc_no DESC`, [from, to]);
  const byHead = new Map<string, { headId: string; name_en: string; name_ta: string | null; count: number; totalPaise: number; costPaise: number; itcPaise: number }>();
  let total = 0;
  let cost = 0;
  for (const r of rows) {
    if (r.status !== 'active') continue;
    const tax = Number(r.cgst_paise) + Number(r.sgst_paise) + Number(r.igst_paise);
    const c = Number(r.taxable_paise) + (r.itc_eligible ? 0 : tax);
    const h = byHead.get(r.head_id) ?? { headId: r.head_id, name_en: String(r.head_en), name_ta: (r.head_ta as string | null) ?? null, count: 0, totalPaise: 0, costPaise: 0, itcPaise: 0 };
    h.count += 1;
    h.totalPaise += Number(r.total_paise);
    h.costPaise += c;
    h.itcPaise += r.itc_eligible ? tax : 0;
    byHead.set(r.head_id, h);
    total += Number(r.total_paise);
    cost += c;
  }
  return { from, to, rows, byHead: [...byHead.values()].sort((a, b) => b.totalPaise - a.totalPaise), totalPaise: total, costPaise: cost };
}

// =====================================================================
// Stock corrections
// =====================================================================
const qtyEntry = z.union([decimal, z.record(z.string(), decimal)]);
const AdjustmentInput = z.object({
  date: isoDate.optional(),
  reason: z.enum(['weight_diff', 'scrap', 'damage', 'count', 'other']),
  notes: z.string().trim().max(300).optional(),
  lines: z.array(z.object({
    productId: z.string().min(1),
    /** signed change: a base-unit quantity ("-12.5") or per unit ({ BDL: "-1", KG: "-3" }) */
    change: qtyEntry.optional(),
    /** physical count; the system works out the change */
    counted: qtyEntry.optional(),
  })).min(1).max(500),
});

async function createAdjustment(db: Db, ctx: Ctx, raw: unknown) {
  const b = AdjustmentInput.parse(raw);
  const date = b.date ?? todayIST();
  checkDate(date, 'date');
  if (b.reason === 'other' && !b.notes) throw new UserError('Write a note saying why the stock is being corrected', 'NO_NOTES');
  return inTx(db, async (tx) => {
    const dev = ctx.deviceId;
    const lines = [];
    const seen = new Set<string>();
    for (const [i, l] of b.lines.entries()) {
      const p = await getProduct(tx, l.productId);
      if (!p) throw new UserError(`Line ${i + 1}: item not found`, 'NO_PRODUCT', 404);
      if (!p.track_stock) throw new UserError(`${p.name_en} does not keep stock`, 'NO_STOCK');
      if (seen.has(p.id)) throw new UserError(`${p.name_en} is listed twice`, 'DUPLICATE');
      seen.add(p.id);
      const given = (v: typeof l.change) => v !== undefined && (typeof v === 'string' ? v !== '' : Object.values(v).some((x) => x !== '' && x !== '0'));
      if (given(l.change) === given(l.counted)) throw new UserError(`${p.name_en}: give either the change or the counted quantity`, 'BAD_LINE');
      const toBase = async (v: string | Record<string, string>) => (typeof v === 'string' ? toMilli(v) : (await entryToBase(tx, p, v)).baseQty);
      const system = await stockOnHand(tx, p.id);
      let change: number;
      let counted: number | null = null;
      if (given(l.counted)) {
        counted = await toBase(l.counted!);
        if (counted < 0) throw new UserError(`${p.name_en}: the counted quantity cannot be negative`, 'BAD_QTY');
        change = counted - system;
      } else {
        change = await toBase(l.change!);
      }
      if (change === 0) continue;
      const cost = await avgCost(tx, p.id);
      lines.push({ p, change, system, counted, cost, value: roundDiv(change * cost, 1000) });
    }
    if (!lines.length) throw new UserError('Nothing to correct: the stock already matches', 'NO_CHANGE');
    const fy = financialYear(date);
    const docNo = await nextNumber(tx, dev, 'ADJ', fy, await loadSettings(tx));
    const adjId = await insert(tx, 'stock_adjustments', dev, { doc_no: docNo, doc_date: date, fy, reason: b.reason, notes: b.notes || null, approved_by: ctx.userId, created_by: ctx.userId });
    for (const l of lines) {
      const lineId = await insert(tx, 'stock_adjustment_lines', dev, {
        adjustment_id: adjId, product_id: l.p.id, qty_milli: l.change, cost_per_base_paise: l.cost, system_milli: l.system, counted_milli: l.counted, value_paise: l.value,
      });
      await insert(tx, 'stock_moves', dev, { move_date: date, product_id: l.p.id, qty_milli: l.change, value_paise: l.value, source_type: 'ADJ', source_id: adjId, source_line_id: lineId });
    }
    await audit(tx, ctx, 'stock_adjustments', adjId, 'create', { docNo, reason: b.reason, lines: lines.length, value: lines.reduce((a, l) => a + l.value, 0) });
    return { id: adjId, docNo, valuePaise: lines.reduce((a, l) => a + l.value, 0), lines: lines.map((l) => ({ productId: l.p.id, changeMilli: l.change, valuePaise: l.value })) };
  });
}

async function listAdjustments(ex: Exec, from: string, to: string) {
  const docs = await all<Record<string, unknown> & { id: string }>(ex, `
    SELECT a.id, a.doc_no, a.doc_date, a.reason, a.notes, u.name AS approved_by_name,
      COALESCE((SELECT SUM(l.value_paise) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id AND l.deleted = 0), 0) AS value_paise
    FROM stock_adjustments a LEFT JOIN users u ON u.id = a.approved_by
    WHERE a.deleted = 0 AND a.reason != 'opening' AND a.doc_date BETWEEN ? AND ? ORDER BY a.doc_date DESC, a.doc_no DESC`, [from, to]);
  const lines = docs.length ? await all<Record<string, unknown> & { adjustment_id: string }>(ex, `
    SELECT l.adjustment_id, l.product_id, p.sku, p.name_en, p.name_ta, u.code AS base_unit, u.name_en AS base_unit_en, u.name_ta AS base_unit_ta,
      l.qty_milli, l.system_milli, l.counted_milli, l.cost_per_base_paise, l.value_paise
    FROM stock_adjustment_lines l JOIN products p ON p.id = l.product_id JOIN units u ON u.id = p.base_unit_id
    WHERE l.deleted = 0 AND l.adjustment_id IN (${docs.map(() => '?').join(',')})`, docs.map((d) => d.id)) : [];
  return docs.map((d) => ({ ...d, value_paise: Number(d.value_paise), lines: lines.filter((l) => l.adjustment_id === d.id) }));
}

// =====================================================================
// Stock value and item stock ledger
// =====================================================================
async function stockValuation(ex: Exec) {
  const rows = await all<{ product_id: string; sku: string; name_en: string; name_ta: string | null; qty_milli: number; avg_cost_paise: number }>(ex, `
    SELECT p.id AS product_id, p.sku, p.name_en, p.name_ta,
      COALESCE((SELECT SUM(m.qty_milli) FROM stock_moves m WHERE m.product_id = p.id AND m.deleted = 0), 0) AS qty_milli,
      COALESCE(c.avg_cost_per_base_paise, 0) AS avg_cost_paise
    FROM products p LEFT JOIN v_avg_cost c ON c.product_id = p.id
    WHERE p.deleted = 0 AND p.track_stock = 1 ORDER BY p.sku`);
  const items = rows.map((r) => {
    const q = Number(r.qty_milli);
    const c = Number(r.avg_cost_paise);
    return { ...r, qty_milli: q, avg_cost_paise: c, value_paise: q > 0 ? roundDiv(q * c, 1000) : 0 };
  });
  return { totalPaise: items.reduce((a, i) => a + i.value_paise, 0), items };
}

async function stockLedger(ex: Exec, productId: string, from?: string, to?: string) {
  const p = await one<Record<string, unknown>>(ex, `SELECT p.id, p.sku, p.name_en, p.name_ta, p.track_stock, u.code AS base_unit, u.name_en AS base_unit_en, u.name_ta AS base_unit_ta
    FROM products p JOIN units u ON u.id = p.base_unit_id WHERE p.id = ? AND p.deleted = 0`, [productId]);
  if (!p) throw new UserError('Item not found', 'NOT_FOUND', 404);
  const moves = await all<{ id: string; move_date: string; qty_milli: number; value_paise: number | null; source_type: string; source_id: string; doc_no: string | null; party_en: string | null; party_ta: string | null; reason: string | null; cost_total_paise: number | null }>(ex, `
    SELECT m.id, m.move_date, m.qty_milli, m.value_paise, m.source_type, m.source_id,
      COALESCE(s.doc_no, pd.doc_no, sa.doc_no) AS doc_no,
      COALESCE(sp.name_en, pp.name_en) AS party_en, COALESCE(sp.name_ta, pp.name_ta) AS party_ta,
      sa.reason, sl.cost_total_paise
    FROM stock_moves m
    LEFT JOIN sales_docs s ON m.source_type IN ('INV','CN') AND s.id = m.source_id
    LEFT JOIN parties sp ON sp.id = s.party_id
    LEFT JOIN sales_doc_lines sl ON m.source_type IN ('INV','CN') AND sl.id = m.source_line_id
    LEFT JOIN purchase_docs pd ON m.source_type IN ('PUR','DN') AND pd.id = m.source_id
    LEFT JOIN parties pp ON pp.id = pd.party_id
    LEFT JOIN stock_adjustments sa ON m.source_type = 'ADJ' AND sa.id = m.source_id
    WHERE m.product_id = ? AND m.deleted = 0
    ORDER BY m.move_date, m.created_at, m.id`, [productId]);
  let balance = 0;
  let opening = 0;
  const rows = [];
  for (const m of moves) {
    const q = Number(m.qty_milli);
    balance += q;
    if (from && m.move_date < from) { opening = balance; continue; }
    if (to && m.move_date > to) continue;
    const cost = m.cost_total_paise != null ? Number(m.cost_total_paise) : null;
    const value = m.value_paise != null ? Number(m.value_paise) : cost != null ? (q < 0 ? -cost : cost) : null;
    rows.push({
      id: m.id, date: m.move_date, type: m.source_type === 'ADJ' && m.reason === 'opening' ? 'OPENING' : m.source_type, sourceId: m.source_id,
      docNo: m.doc_no, partyEn: m.party_en, partyTa: m.party_ta, reason: m.reason, inMilli: q > 0 ? q : 0, outMilli: q < 0 ? -q : 0, balanceMilli: balance, valuePaise: value,
    });
  }
  const avg = await avgCost(ex, productId);
  return { product: p, openingMilli: opening, rows, closingMilli: balance, avgCostPaise: avg, valuePaise: balance > 0 ? roundDiv(balance * avg, 1000) : 0 };
}

// =====================================================================
// Routes
// =====================================================================
const Range = z.object({ from: isoDate.optional(), to: isoDate.optional() });
function rangeOf(req: FastifyRequest) {
  const q = Range.parse(req.query);
  const today = todayIST();
  return { from: q.from ?? addDays(today, -30), to: q.to ?? today };
}

/** Purchase bills, purchase returns (debit notes), supplier payments, expenses, stock corrections. */
export function registerPurchases(app: FastifyInstance, db: Db, deviceId: string): void {
  const ctxOf = (req: FastifyRequest): Ctx => ({ deviceId, userId: req.user!.id });

  // ---------- Purchase bills ----------
  app.post('/api/purchases/preview', async (req) => {
    const p = await pricePurchase(db, req.body);
    return {
      supply: p.supply, itc: p.itc, itcPossible: p.itcPossible, inclusive: p.inclusive, totals: p.totals, dueDate: p.dueDate, paid: p.paid,
      supplierGstin: p.supplier.gstin,
      lines: p.items.map((x) => ({
        lineNo: x.lineNo, productId: x.product.id, baseQtyMilli: x.baseQty, rateQtyMilli: x.rateQty, ratePaise: x.ratePaise, gstBp: x.gstBp,
        taxable: x.taxable, cgst: x.cgst, sgst: x.sgst, igst: x.igst, total: x.total, chargeShare: x.share, landed: x.landed, landedPerBase: x.landedPerBase,
      })),
      charges: p.charges.map((c) => ({ description: c.description, taxable: c.taxable, gstBp: c.gstBp, tax: c.tax, total: c.total })),
    };
  });

  app.post('/api/purchases', async (req, reply) => reply.status(201).send(await createPurchase(db, ctxOf(req), req.body)));

  app.get('/api/purchases', async (req) => {
    const { from, to } = rangeOf(req);
    const rows = await all(db, `
      SELECT d.id, d.doc_type, d.doc_no, d.supplier_bill_no, d.doc_date, d.due_date, d.party_id, p.name_en AS party_en, p.name_ta AS party_ta,
        d.taxable_paise, d.cgst_paise + d.sgst_paise + d.igst_paise AS tax_paise, d.total_paise, d.itc_eligible, d.status, d.cancel_reason,
        r.doc_no AS ref_doc_no, CASE WHEN d.doc_type = 'PUR' AND d.status = 'active' THEN MAX(0, ${DUE_SQL}) ELSE 0 END AS due_paise
      FROM purchase_docs d JOIN parties p ON p.id = d.party_id LEFT JOIN purchase_docs r ON r.id = d.ref_doc_id
      WHERE d.deleted = 0 AND d.doc_date BETWEEN ? AND ? ORDER BY d.doc_date DESC, d.doc_no DESC`, [from, to]);
    return { from, to, rows };
  });

  app.get('/api/purchases/:id', async (req) => getPurchase(db, idOf(req)));

  app.post('/api/purchases/:id/cancel', async (req, reply) => {
    const r = await cancelPurchase(db, ctxOf(req), idOf(req), req.body);
    return reply.status(r.saved ? 200 : 409).send(r);
  });

  app.post('/api/purchases/:id/return', async (req, reply) => reply.status(201).send(await createReturn(db, ctxOf(req), idOf(req), req.body)));

  // ---------- Supplier payments ----------
  app.post('/api/supplier-payments/preview', async (req) => {
    const p = await planPayment(db, req.body);
    return { amountPaise: p.amountPaise, allocations: p.allocations, advancePaise: p.advancePaise, owedBefore: p.owedBefore, owedAfter: p.owedAfter, openBills: p.openBills };
  });

  app.post('/api/supplier-payments', async (req, reply) => {
    const r = await inTx(db, async (tx) => {
      const p = await planPayment(tx, req.body);
      const saved = await savePayment(tx, ctxOf(req), {
        partyId: p.supplier.id, amountPaise: p.amountPaise, mode: p.input.mode, reference: p.input.reference, date: p.date, notes: p.input.notes,
        allocations: p.allocations,
      });
      return { ...saved, allocations: p.allocations, advancePaise: p.advancePaise };
    });
    return reply.status(201).send(r);
  });

  app.get('/api/supplier-payments', async (req) => {
    const { from, to } = rangeOf(req);
    const rows = await all(db, `
      SELECT m.id, m.doc_no, m.doc_date, m.party_id, p.name_en AS party_en, p.name_ta AS party_ta, m.amount_paise, m.mode, m.reference, m.notes, m.status,
        COALESCE((SELECT SUM(a.amount_paise) FROM money_allocations a WHERE a.money_doc_id = m.id AND a.deleted = 0), 0) AS allocated_paise,
        (SELECT group_concat(d.doc_no, ', ') FROM money_allocations a JOIN purchase_docs d ON d.id = a.purchase_doc_id WHERE a.money_doc_id = m.id AND a.deleted = 0) AS bills
      FROM money_docs m JOIN parties p ON p.id = m.party_id
      -- customer refunds (credit notes) are also PAY documents; they belong to the sales side
      WHERE m.doc_type = 'PAY' AND m.deleted = 0 AND NOT EXISTS (SELECT 1 FROM money_allocations ra WHERE ra.money_doc_id = m.id AND ra.sales_doc_id IS NOT NULL)
        AND m.doc_date BETWEEN ? AND ? ORDER BY m.doc_date DESC, m.doc_no DESC`, [from, to]);
    return { from, to, rows };
  });

  app.post('/api/supplier-payments/:id/cancel', async (req) => {
    const id = idOf(req);
    const b = CancelInput.parse(req.body ?? {});
    if (!b.reason) throw new UserError('Say why the payment is being cancelled', 'NO_REASON');
    const ctx = ctxOf(req);
    return inTx(db, async (tx) => {
      const m = await one<{ doc_no: string; status: string }>(tx, "SELECT doc_no, status FROM money_docs m WHERE id = ? AND doc_type = 'PAY' AND deleted = 0 AND NOT EXISTS (SELECT 1 FROM money_allocations ra WHERE ra.money_doc_id = m.id AND ra.sales_doc_id IS NOT NULL)", [id]);
      if (!m) throw new UserError('Payment not found', 'NOT_FOUND', 404);
      if (m.status === 'cancelled') throw new UserError(`${m.doc_no} is already cancelled`, 'ALREADY_CANCELLED');
      await softDelete(tx, 'ledger_entries', deviceId, "source_type = 'PAY' AND source_id = ?", [id]);
      await softDelete(tx, 'money_allocations', deviceId, 'money_doc_id = ?', [id]);
      await update(tx, 'money_docs', deviceId, id, { status: 'cancelled', cancel_reason: b.reason, cancelled_at: nowIso(), cancelled_by: ctx.userId });
      // money_docs has no cancel columns; the reason, who and when are in the audit log.
      await audit(tx, ctx, 'money_docs', id, 'cancel', { docNo: m.doc_no }, b.reason);
      return { ok: true };
    });
  });

  app.get('/api/payables', async () => payables(db));

  // ---------- Expenses ----------
  app.get('/api/expense-heads', async () => {
    const q = 'SELECT id, name_en, name_ta FROM expense_heads WHERE deleted = 0 ORDER BY name_en';
    let rows = await all(db, q);
    if (!rows.length) {
      await inTx(db, async (tx) => {
        if (await one(tx, 'SELECT id FROM expense_heads LIMIT 1')) return; // someone else seeded them
        for (const [en, ta] of DEFAULT_EXPENSE_HEADS) await insert(tx, 'expense_heads', deviceId, { name_en: en, name_ta: ta });
      });
      rows = await all(db, q);
    }
    return rows;
  });

  app.post('/api/expense-heads', async (req, reply) => {
    const b = HeadInput.parse(req.body);
    const id = await inTx(db, async (tx) => {
      if (await one(tx, 'SELECT id FROM expense_heads WHERE lower(name_en) = lower(?) AND deleted = 0', [b.name_en])) throw new UserError(`"${b.name_en}" already exists`, 'DUPLICATE');
      const id = await insert(tx, 'expense_heads', deviceId, { name_en: b.name_en, name_ta: b.name_ta || null });
      await audit(tx, ctxOf(req), 'expense_heads', id, 'create', b);
      return id;
    });
    return reply.status(201).send({ id });
  });

  app.put('/api/expense-heads/:id', async (req) => {
    const id = idOf(req);
    const b = HeadInput.parse(req.body);
    await inTx(db, async (tx) => {
      const dupe = await one<{ id: string }>(tx, 'SELECT id FROM expense_heads WHERE lower(name_en) = lower(?) AND deleted = 0', [b.name_en]);
      if (dupe && dupe.id !== id) throw new UserError(`"${b.name_en}" already exists`, 'DUPLICATE');
      if (!(await update(tx, 'expense_heads', deviceId, id, { name_en: b.name_en, name_ta: b.name_ta || null }))) throw new UserError('Not found', 'NOT_FOUND', 404);
      const acc = await one<{ id: string }>(tx, 'SELECT id FROM accounts WHERE code = ?', [`EXP:${id}`]);
      if (acc) await update(tx, 'accounts', deviceId, acc.id, { name_en: b.name_en, name_ta: b.name_ta || null });
      await audit(tx, ctxOf(req), 'expense_heads', id, 'update', b);
    });
    return { ok: true };
  });

  app.post('/api/expenses/preview', async (req) => {
    const e = await priceExpense(db, req.body);
    return { taxable: e.taxable, cgst: e.cgst, sgst: e.sgst, igst: e.igst, total: e.total, itc: e.itc, cost: e.cost, supply: e.supply, vendorGstin: e.vendorGstin };
  });
  app.post('/api/expenses', async (req, reply) => reply.status(201).send(await createExpense(db, ctxOf(req), req.body)));
  app.get('/api/expenses', async (req) => {
    const { from, to } = rangeOf(req);
    return listExpenses(db, from, to);
  });
  app.post('/api/expenses/:id/cancel', async (req) => {
    const id = idOf(req);
    const b = CancelInput.parse(req.body ?? {});
    if (!b.reason) throw new UserError('Say why the expense is being cancelled', 'NO_REASON');
    const ctx = ctxOf(req);
    return inTx(db, async (tx) => {
      const e = await one<{ doc_no: string; status: string }>(tx, 'SELECT doc_no, status FROM expenses WHERE id = ? AND deleted = 0', [id]);
      if (!e) throw new UserError('Expense not found', 'NOT_FOUND', 404);
      if (e.status === 'cancelled') throw new UserError(`${e.doc_no} is already cancelled`, 'ALREADY_CANCELLED');
      await softDelete(tx, 'ledger_entries', deviceId, "source_type = 'EXP' AND source_id = ?", [id]);
      await update(tx, 'expenses', deviceId, id, { status: 'cancelled', cancel_reason: b.reason, cancelled_at: nowIso(), cancelled_by: ctx.userId });
      await audit(tx, ctx, 'expenses', id, 'cancel', { docNo: e.doc_no }, b.reason);
      return { ok: true };
    });
  });

  // ---------- Stock corrections, value and item ledger ----------
  app.post('/api/stock/adjustments', async (req, reply) => reply.status(201).send(await createAdjustment(db, ctxOf(req), req.body)));
  app.get('/api/stock/adjustments', async (req) => {
    const { from, to } = rangeOf(req);
    return { from, to, rows: await listAdjustments(db, from, to) };
  });
  app.get('/api/stock/valuation', async () => stockValuation(db));
  app.get('/api/stock/:productId/ledger', async (req) => {
    const { productId } = z.object({ productId: z.string().min(1) }).parse(req.params);
    const q = Range.parse(req.query);
    return stockLedger(db, productId, q.from, q.to);
  });
}
