import {
  calcBill, calcLine, financialYear, formatDocNo, missingForBilling, roundDiv, supplyTypeFor, toBaseMilli, toMilli, toPaise,
  todayIST, withDefaults, type LineAmounts, type Settings,
} from '@tula/core';
import { all, getSettings, insert, one, type Db, type Exec } from '@tula/db';
import { z } from 'zod';
import { accountId, partyAccountId, partyBalance, post } from './accounts';
import { avgCost, getProduct, productUnits, resolveRate, stockOnHand } from './catalog';
import { UserError, type Ctx } from './context';

const decimal = z.union([z.string(), z.number()]).transform(String);

export const BillInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  partyId: z.string().min(1),
  site: z.string().max(120).optional(),
  /** vehicle carrying the goods, printed on the bill and needed for an e-way bill */
  vehicleNo: z.string().max(20).optional(),
  /** bill language; defaults to the customer's, then the business default */
  lang: z.string().optional(),
  notes: z.string().max(500).optional(),
  lines: z.array(z.object({
    productId: z.string().min(1),
    /** quantities keyed by unit code, e.g. { BDL: "10", ROD: "4" } or { KG: "147.35" } */
    entry: z.record(z.string(), decimal),
    /** override the auto rate (₹ per rate unit, excl. GST) */
    rate: decimal.optional(),
    discount: decimal.optional(),
    inclusive: z.boolean().optional(),
  })).min(1).max(50),
  payment: z.object({ mode: z.enum(['cash', 'upi', 'bank', 'cheque']), amount: decimal, reference: z.string().optional() }).optional(),
  /** owner confirms saving despite warnings (stock / credit limit) */
  confirmWarnings: z.boolean().optional(),
});
export type BillInput = z.input<typeof BillInput>;

/** EWAY and RATE_MISSING are information only; LOW_STOCK and CREDIT_LIMIT need confirmation (or block, per settings). */
export interface BillWarning { code: 'LOW_STOCK' | 'CREDIT_LIMIT' | 'RATE_MISSING' | 'EWAY'; message: string; productId?: string; thresholdPaise?: number }
const INFO_ONLY = new Set<BillWarning['code']>(['RATE_MISSING', 'EWAY']);

/** Default prefixes for documents other than invoices (the invoice prefix is a setting). */
export const DEFAULT_PREFIXES: Record<string, string> = { QT: 'QT', CN: 'CN', RCPT: 'RC', PAY: 'PY', PUR: 'PU', DN: 'DN', EXP: 'EX', ADJ: 'AD' };

/** Next document number for this device; creates the series for a new financial year automatically. */
export async function nextNumber(ex: Exec, deviceId: string, docType: string, fy: string, settings: Settings) {
  const q = 'SELECT id, prefix, next_no, pad FROM number_series WHERE doc_type = ? AND owner_device = ? AND fy = ? AND deleted = 0';
  let s = await one<{ id: string; prefix: string; next_no: number; pad: number }>(ex, q, [docType, deviceId, fy]);
  if (!s) {
    const inv = docType === 'INV';
    const prefix = inv ? settings['invoice.prefix'] : DEFAULT_PREFIXES[docType] ?? docType;
    // New financial year: numbering restarts at 1 (the start-number setting only applies to the year it was set in).
    const pad = inv ? Number(settings['invoice.seq_digits']) : 4;
    await insert(ex, 'number_series', deviceId, { doc_type: docType, owner_device: deviceId, fy, prefix, next_no: 1, pad });
    s = (await one<{ id: string; prefix: string; next_no: number; pad: number }>(ex, q, [docType, deviceId, fy]))!;
  }
  const dev = await one<{ series_code: string }>(ex, 'SELECT series_code FROM devices WHERE id = ?', [deviceId]);
  const format = docType === 'INV' ? settings['invoice.number_format'] : undefined;
  const docNo = formatDocNo({ prefix: s.prefix, fy, seriesCode: dev?.series_code ?? '', pad: Number(s.pad), format }, Number(s.next_no));
  await ex.execute({ sql: 'UPDATE number_series SET next_no = next_no + 1, updated_at = ? WHERE id = ?', args: [new Date().toISOString(), s.id] });
  return docNo;
}

/**
 * Apply the invoice numbering settings to this device's current-year series.
 * GST needs a consecutive series, so this refuses once the year's first invoice exists.
 */
export async function applyNumberingSettings(ex: Exec, deviceId: string, settings: Settings, changing: string[]) {
  const fy = financialYear(todayIST());
  const issued = await one<{ n: number }>(ex, "SELECT COUNT(*) n FROM sales_docs WHERE doc_type = 'INV' AND fy = ? AND device_id = ?", [fy, deviceId]);
  if (Number(issued?.n ?? 0) > 0) {
    throw new UserError(`Invoices already issued this financial year, so ${changing.join(', ')} can only change from next financial year.`, 'NUMBERING_IN_USE');
  }
  const values = { prefix: settings['invoice.prefix'], pad: Number(settings['invoice.seq_digits']), next_no: Number(settings['invoice.start_number']) };
  const existing = await one<{ id: string }>(ex, "SELECT id FROM number_series WHERE doc_type = 'INV' AND owner_device = ? AND fy = ? AND deleted = 0", [deviceId, fy]);
  if (existing) {
    await ex.execute({ sql: 'UPDATE number_series SET prefix = ?, pad = ?, next_no = ?, updated_at = ? WHERE id = ?', args: [values.prefix, values.pad, values.next_no, new Date().toISOString(), existing.id] });
  } else {
    await insert(ex, 'number_series', deviceId, { doc_type: 'INV', owner_device: deviceId, fy, ...values });
  }
}

/** Price and validate a bill without saving it (used for live totals and before save). */
export async function priceBill(ex: Exec, raw: BillInput) {
  const input = BillInput.parse(raw);
  const date = input.date ?? todayIST();
  const settings = withDefaults(await getSettings(ex));
  const missing = missingForBilling(settings);
  if (missing.length) throw new UserError(`Finish setup before billing: ${missing.join(', ')}`, 'SETUP_INCOMPLETE', 409);
  const party = await one<{ id: string; name_en: string; name_ta: string | null; gstin: string | null; address: string | null; state_code: string; credit_limit_paise: number; lang: string | null; is_walk_in: number }>(
    ex, 'SELECT id, name_en, name_ta, gstin, address, state_code, credit_limit_paise, lang, is_walk_in FROM parties WHERE id = ? AND deleted = 0', [input.partyId]);
  if (!party) throw new UserError('Customer not found', 'NO_PARTY', 404);
  const businessState = settings['business.state_code'];
  const placeOfSupply = party.is_walk_in || !party.state_code ? businessState : party.state_code;
  const supply = supplyTypeFor(businessState, placeOfSupply);
  const enabledLangs = settings['app.languages'].split(',');
  const lang = input.lang ?? (party.lang && enabledLangs.includes(party.lang) ? party.lang : settings['invoice.default_lang']);
  if (!enabledLangs.includes(lang)) throw new UserError(`Language "${lang}" is not enabled`);
  const charge = settings['gst.scheme'] === 'regular'; // composition / unregistered: bill of supply, no GST
  const stockCheck = settings['billing.stock_check'];
  const creditCheck = settings['billing.credit_check'];
  // GST-inclusive rates only make sense when GST is charged.
  const inclusiveDefault = charge && settings['billing.rates_include_gst'] === 'true';
  const warnings: BillWarning[] = [];

  const lines = [];
  for (const [i, l] of input.lines.entries()) {
    const p = await getProduct(ex, l.productId);
    if (!p) throw new UserError(`Line ${i + 1}: product not found`, 'NO_PRODUCT', 404);
    const units = await productUnits(ex, p.id);
    const entryMilli = Object.fromEntries(Object.entries(l.entry).filter(([, v]) => v !== '' && v !== '0').map(([k, v]) => [k, toMilli(v)]));
    const baseQty = toBaseMilli(entryMilli, units.map((u) => ({ unitCode: u.code, factorMilli: Number(u.factor_milli) })), p.base_unit_code);
    if (baseQty <= 0) throw new UserError(`Line ${i + 1}: enter a quantity for ${p.name_en}`, 'NO_QTY');

    const rateUnitId = p.rate_unit_id ?? p.base_unit_id;
    let rateQty = baseQty;
    if (rateUnitId !== p.base_unit_id) {
      const ru = units.find((u) => u.unit_id === rateUnitId);
      if (!ru) throw new UserError(`Line ${i + 1}: rate unit not configured for ${p.name_en}`);
      rateQty = roundDiv(baseQty * 1000, Number(ru.factor_milli));
    }

    const auto = await resolveRate(ex, p, party.id, date);
    const ratePaise = l.rate !== undefined && l.rate !== '' ? toPaise(l.rate) : auto.ratePaise;
    if (ratePaise === 0 && auto.source === 'missing_daily_rate') warnings.push({ code: 'RATE_MISSING', message: `Today's ${p.rate_group} rate is not set`, productId: p.id });

    let amounts: LineAmounts;
    try {
      amounts = calcLine({ rateQtyMilli: rateQty, ratePaise, discountPaise: l.discount ? toPaise(l.discount) : 0, gstBp: charge ? Number(p.gst_bp) : 0, inclusive: charge && (l.inclusive ?? inclusiveDefault) }, supply);
    } catch (e) {
      throw new UserError(`Line ${i + 1}: ${(e as Error).message}`);
    }

    if (p.track_stock && stockCheck !== 'off') {
      const onHand = await stockOnHand(ex, p.id);
      if (baseQty > onHand) warnings.push({ code: 'LOW_STOCK', message: `${p.name_en}: billing ${baseQty / 1000}, stock ${onHand / 1000}`, productId: p.id });
    }
    lines.push({
      lineNo: i + 1, product: p, entryJson: Object.fromEntries(Object.entries(l.entry).filter(([, v]) => v !== '' && v !== '0')),
      baseQty, rateUnitId, rateQty, ratePaise, rateSource: l.rate ? 'manual' : auto.source, autoRatePaise: auto.ratePaise,
      gstBp: charge ? Number(p.gst_bp) : 0, inclusive: charge && (l.inclusive ?? inclusiveDefault), ...amounts,
    });
  }
  const totals = calcBill(lines);

  const balanceBefore = await partyBalance(ex, party.id);
  const paid = input.payment ? toPaise(input.payment.amount) : 0;
  const limit = Number(party.credit_limit_paise);
  if (creditCheck !== 'off' && limit > 0 && balanceBefore + totals.total - paid > limit) {
    warnings.push({ code: 'CREDIT_LIMIT', message: `Outstanding would be ${(balanceBefore + totals.total - paid) / 100} against limit ${limit / 100}` });
  }
  if (paid > totals.total) throw new UserError('Payment is more than the bill total. Record the extra as a separate receipt.');

  // E-way bill reminder: value of goods (not services) moved, including tax, against the state / inter-state threshold.
  if (settings['eway.warn'] === 'true') {
    const goodsValue = lines.filter((l) => l.product.track_stock).reduce((a, l) => a + l.total, 0);
    const threshold = toPaise(settings[supply === 'inter' ? 'eway.threshold_inter' : 'eway.threshold_intra']);
    if (threshold > 0 && goodsValue > threshold) {
      warnings.push({ code: 'EWAY', message: `Goods worth more than ${threshold / 100}: an e-way bill is needed if they are transported`, thresholdPaise: threshold });
    }
  }
  const blocked = warnings.some((w) => (w.code === 'LOW_STOCK' && stockCheck === 'block') || (w.code === 'CREDIT_LIMIT' && creditCheck === 'block'));
  return { input, date, lang, party, placeOfSupply, supply, docKind: charge ? 'tax_invoice' : 'bill_of_supply', lines, totals, balanceBefore, paid, warnings, blocked, settings };
}

export async function createBill(db: Db, ctx: Ctx, raw: BillInput) {
  const tx = await db.transaction('write');
  try {
    const priced = await priceBill(tx, raw);
    const { input, date, lang, party, placeOfSupply, supply, docKind, lines, totals, paid, warnings, blocked, settings } = priced;
    const needsConfirm = warnings.some((w) => !INFO_ONLY.has(w.code));
    if (blocked || (needsConfirm && !input.confirmWarnings)) {
      await tx.rollback();
      return { saved: false as const, blocked, warnings };
    }
    const fy = financialYear(date);
    const docNo = await nextNumber(tx, ctx.deviceId, 'INV', fy, settings);
    const dev = ctx.deviceId;

    const docId = await insert(tx, 'sales_docs', dev, {
      doc_type: 'INV', doc_kind: docKind, doc_no: docNo, doc_date: date, fy, party_id: party.id,
      party_name: lang === 'ta' && party.name_ta ? party.name_ta : party.name_en,
      party_gstin: party.gstin, party_address: party.address, place_of_supply: placeOfSupply, supply_type: supply,
      site: input.site, vehicle_no: input.vehicleNo?.toUpperCase().replace(/\s+/g, ' ').trim() || null, lang, taxable_paise: totals.taxable, cgst_paise: totals.cgst, sgst_paise: totals.sgst,
      igst_paise: totals.igst, round_off_paise: totals.roundOff, total_paise: totals.total, notes: input.notes, created_by: ctx.userId,
    });

    for (const l of lines) {
      const cost = l.product.track_stock ? await avgCost(tx, l.product.id) : 0;
      const costTotal = roundDiv(l.baseQty * cost, 1000);
      const lineId = await insert(tx, 'sales_doc_lines', dev, {
        doc_id: docId, line_no: l.lineNo, product_id: l.product.id,
        description: [l.product.brand, lang === 'ta' && l.product.name_ta ? l.product.name_ta : l.product.name_en].filter(Boolean).join(' '),
        hsn: l.product.hsn, entry_json: l.entryJson, base_qty_milli: l.baseQty, rate_unit_id: l.rateUnitId,
        rate_qty_milli: l.rateQty, rate_paise: l.ratePaise, rate_inclusive: l.inclusive ? 1 : 0, discount_paise: l.discount, taxable_paise: l.taxable,
        gst_bp: l.gstBp, cgst_paise: l.cgst, sgst_paise: l.sgst, igst_paise: l.igst, line_total_paise: l.total,
        cost_per_base_paise: cost, cost_total_paise: costTotal,
      });
      if (l.product.track_stock) {
        await insert(tx, 'stock_moves', dev, {
          move_date: date, product_id: l.product.id, qty_milli: -l.baseQty, source_type: 'INV', source_id: docId, source_line_id: lineId,
        });
      }
      if (l.rateSource === 'manual' && l.ratePaise !== l.autoRatePaise) {
        await insert(tx, 'audit_log', dev, {
          at: new Date().toISOString(), user_id: ctx.userId, entity: 'sales_doc_lines', entity_id: lineId, action: 'override',
          before_json: { ratePaise: l.autoRatePaise }, after_json: { ratePaise: l.ratePaise }, reason: 'Rate changed on bill',
        });
      }
    }

    const partyAcc = await partyAccountId(tx, dev, party.id);
    await post(tx, dev, {
      date, sourceType: 'INV', sourceId: docId, narration: docNo,
      lines: [
        { accountId: partyAcc, debit: totals.total },
        { accountId: await accountId(tx, 'SALES'), credit: totals.taxable },
        { accountId: await accountId(tx, 'OUT_CGST'), credit: totals.cgst },
        { accountId: await accountId(tx, 'OUT_SGST'), credit: totals.sgst },
        { accountId: await accountId(tx, 'OUT_IGST'), credit: totals.igst },
        { accountId: await accountId(tx, 'ROUND_OFF'), credit: totals.roundOff },
      ],
    });

    let receiptNo: string | null = null;
    if (paid > 0 && input.payment) {
      receiptNo = await nextNumber(tx, dev, 'RCPT', fy, settings);
      const rcId = await insert(tx, 'money_docs', dev, {
        doc_type: 'RCPT', doc_no: receiptNo, doc_date: date, fy, party_id: party.id, amount_paise: paid,
        mode: input.payment.mode, reference: input.payment.reference, notes: `Paid at billing ${docNo}`, created_by: ctx.userId,
      });
      await insert(tx, 'money_allocations', dev, { money_doc_id: rcId, sales_doc_id: docId, amount_paise: paid });
      const cashCode = { cash: 'CASH', upi: 'UPI', bank: 'BANK', cheque: 'BANK' }[input.payment.mode];
      await post(tx, dev, {
        date, sourceType: 'RCPT', sourceId: rcId, narration: `${receiptNo} against ${docNo}`,
        lines: [{ accountId: await accountId(tx, cashCode), debit: paid }, { accountId: partyAcc, credit: paid }],
      });
    }

    await insert(tx, 'audit_log', dev, {
      at: new Date().toISOString(), user_id: ctx.userId, entity: 'sales_docs', entity_id: docId, action: 'create',
      after_json: { docNo, total: totals.total, warningsAccepted: warnings.map((w) => w.code) },
    });
    await tx.commit();
    return { saved: true as const, id: docId, docNo, receiptNo, total: totals.total, warnings };
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

/** Full invoice for printing / PDF. */
export async function getBill(ex: Exec, id: string) {
  const doc = await one<Record<string, unknown>>(ex, 'SELECT * FROM sales_docs WHERE id = ? AND deleted = 0', [id]);
  if (!doc) throw new UserError('Bill not found', 'NOT_FOUND', 404);
  const lines = await all<Record<string, unknown>>(ex, `
    SELECT l.*, u.code AS rate_unit_code, u.name_en AS rate_unit_en, u.name_ta AS rate_unit_ta
    FROM sales_doc_lines l JOIN units u ON u.id = l.rate_unit_id
    WHERE l.doc_id = ? AND l.deleted = 0 ORDER BY l.line_no`, [id]);
  const paid = await one<{ p: number }>(ex, `
    SELECT COALESCE(SUM(a.amount_paise),0) p FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
    WHERE a.sales_doc_id = ? AND a.deleted = 0 AND m.status = 'active'`, [id]);
  const party = await one<Record<string, unknown>>(ex, 'SELECT name_en, name_ta, mobile, gstin, address, state_code, is_walk_in FROM parties WHERE id = ?', [String(doc.party_id)]);
  const units = await all<{ code: string; name_en: string; name_ta: string | null }>(ex, 'SELECT code, name_en, name_ta FROM units WHERE deleted = 0');
  const settings = withDefaults(await getSettings(ex));
  return {
    doc, lines: lines.map((l) => ({ ...l, entry_json: JSON.parse(String(l.entry_json ?? '{}')) })), party, units,
    paidPaise: Number(paid?.p ?? 0), settings,
  };
}

export async function listBills(ex: Exec, from: string, to: string) {
  return all(ex, `
    SELECT d.id, d.doc_no, d.doc_date, d.party_name, d.site, d.total_paise, d.status,
      d.total_paise - COALESCE((SELECT SUM(a.amount_paise) FROM money_allocations a JOIN money_docs m ON m.id = a.money_doc_id
        WHERE a.sales_doc_id = d.id AND a.deleted = 0 AND m.status = 'active'), 0) AS balance_paise
    FROM sales_docs d WHERE d.doc_type = 'INV' AND d.deleted = 0 AND d.doc_date BETWEEN ? AND ?
    ORDER BY d.doc_date DESC, d.doc_no DESC`, [from, to]);
}
