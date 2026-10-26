import { financialYear, todayIST } from '@tula/core';
import { all, insert, nowIso, one, update, type Db, type Exec } from '@tula/db';
import { z } from 'zod';
import { BillInput, createBill, getBill, nextNumber, priceBill } from './bills';
import { UserError, type Ctx } from './context';
import type { Req, Router } from './http';

/*
 * Quotations / estimates (UC-03). A quotation is a sales_docs row with doc_type 'QT': the same
 * pricing as a bill (priceBill), its own number series per device (QT/26-27/0001), and no stock,
 * ledger or GST effect: every report reads only INV and CN. "Convert to bill" makes a normal bill
 * from its lines, at today's rates unless the quoted rates are kept, and records the bill on the
 * quotation (converted_bill_id), so one quotation becomes one bill.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const QuoteInput = BillInput.omit({ payment: true, confirmWarnings: true }).extend({ validUntil: day.optional() });
type QuoteInput = z.input<typeof QuoteInput>;

const ConvertInput = z.object({
  /** keep the quoted rates instead of today's (a price agreed with the customer) */
  keepRates: z.boolean().default(false),
  payment: BillInput.shape.payment,
  confirmWarnings: z.boolean().optional(),
});

/** Price a quotation: like a bill, but stock and credit don't matter yet (they are checked when it becomes a bill). */
async function priceQuote(ex: Exec, raw: QuoteInput) {
  const input = QuoteInput.parse(raw);
  const { validUntil, ...bill } = input;
  if (validUntil && validUntil < (input.date ?? todayIST())) throw new UserError('"Valid until" is before the quotation date', 'BAD_DATE');
  const p = await priceBill(ex, bill);
  return { ...p, validUntil, warnings: p.warnings.filter((w) => w.code === 'RATE_MISSING'), blocked: false };
}

export async function createQuote(db: Db, ctx: Ctx, raw: QuoteInput) {
  const tx = await db.transaction('write');
  try {
    const p = await priceQuote(tx, raw);
    const fy = financialYear(p.date);
    const docNo = await nextNumber(tx, ctx.deviceId, 'QT', fy, p.settings);
    const dev = ctx.deviceId;
    const id = await insert(tx, 'sales_docs', dev, {
      doc_type: 'QT', doc_kind: p.docKind, doc_no: docNo, doc_date: p.date, fy, party_id: p.party.id,
      party_name: p.lang === 'ta' && p.party.name_ta ? p.party.name_ta : p.party.name_en,
      party_gstin: p.party.gstin, party_address: p.party.address, place_of_supply: p.placeOfSupply, supply_type: p.supply,
      site: p.input.site, vehicle_no: null, lang: p.lang, taxable_paise: p.totals.taxable, cgst_paise: p.totals.cgst, sgst_paise: p.totals.sgst,
      igst_paise: p.totals.igst, round_off_paise: p.totals.roundOff, total_paise: p.totals.total, notes: p.input.notes,
      valid_until: p.validUntil ?? null, created_by: ctx.userId,
    });
    for (const l of p.lines) {
      await insert(tx, 'sales_doc_lines', dev, {
        doc_id: id, line_no: l.lineNo, product_id: l.product.id,
        description: [l.product.brand, p.lang === 'ta' && l.product.name_ta ? l.product.name_ta : l.product.name_en].filter(Boolean).join(' '),
        hsn: l.product.hsn, entry_json: l.entryJson, base_qty_milli: l.baseQty, rate_unit_id: l.rateUnitId,
        rate_qty_milli: l.rateQty, rate_paise: l.ratePaise, rate_inclusive: l.inclusive ? 1 : 0, discount_paise: l.discount, taxable_paise: l.taxable,
        gst_bp: l.gstBp, cgst_paise: l.cgst, sgst_paise: l.sgst, igst_paise: l.igst, line_total_paise: l.total,
      });
    }
    await insert(tx, 'audit_log', dev, { at: nowIso(), user_id: ctx.userId, entity: 'sales_docs', entity_id: id, action: 'create', after_json: { docNo, total: p.totals.total, quote: true } });
    await tx.commit();
    return { saved: true as const, id, docNo, total: p.totals.total, warnings: p.warnings };
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

interface QuoteRow { id: string; doc_no: string; status: string; party_id: string; site: string | null; lang: string; notes: string | null; converted_bill_id: string | null; valid_until: string | null }

async function getQuote(ex: Exec, id: string): Promise<QuoteRow> {
  const q = await one<QuoteRow>(ex, "SELECT id, doc_no, status, party_id, site, lang, notes, converted_bill_id, valid_until FROM sales_docs WHERE id = ? AND doc_type = 'QT' AND deleted = 0", [id]);
  if (!q) throw new UserError('Quotation not found', 'NOT_FOUND', 404);
  return q;
}

/** open / converted (to a bill that stands) / cancelled; expired is an open quotation past its date. */
async function stateOf(ex: Exec, q: Pick<QuoteRow, 'status' | 'converted_bill_id' | 'valid_until'>) {
  const bill = q.converted_bill_id ? await one<{ id: string; doc_no: string; status: string }>(ex, 'SELECT id, doc_no, status FROM sales_docs WHERE id = ?', [q.converted_bill_id]) : undefined;
  const converted = !!bill && bill.status !== 'cancelled';
  const state = q.status === 'cancelled' ? 'cancelled' : converted ? 'converted' : q.valid_until && q.valid_until < todayIST() ? 'expired' : 'open';
  return { state, bill: converted ? { id: bill!.id, docNo: bill!.doc_no } : null };
}

/** The quotation's lines as a bill, at today's rates or the quoted ones. */
async function billFromQuote(ex: Exec, id: string, keepRates: boolean): Promise<{ quote: QuoteRow; input: BillInput; quoted: Array<{ productId: string; ratePaise: number }> }> {
  const quote = await getQuote(ex, id);
  const lines = await all<{ product_id: string; entry_json: string; rate_paise: number; rate_inclusive: number; discount_paise: number }>(ex,
    'SELECT product_id, entry_json, rate_paise, rate_inclusive, discount_paise FROM sales_doc_lines WHERE doc_id = ? AND deleted = 0 ORDER BY line_no', [id]);
  const rupees = (p: number) => (Number(p) / 100).toFixed(2);
  return {
    quote,
    quoted: lines.map((l) => ({ productId: l.product_id, ratePaise: Number(l.rate_paise) })),
    input: {
      partyId: quote.party_id, site: quote.site ?? undefined, lang: quote.lang, notes: quote.notes ?? undefined,
      lines: lines.map((l) => ({
        productId: l.product_id, entry: JSON.parse(l.entry_json || '{}') as Record<string, string>,
        rate: keepRates ? rupees(l.rate_paise) : undefined,
        discount: Number(l.discount_paise) ? rupees(l.discount_paise) : undefined, inclusive: !!Number(l.rate_inclusive),
      })),
    },
  };
}

export function registerQuotes(app: Router, db: Db, deviceId: string): void {
  const ctxOf = (req: Req): Ctx => ({ deviceId, userId: req.user!.id });
  const idOf = (req: Req) => z.object({ id: z.string().min(1) }).parse(req.params).id;

  /** Live totals while the quotation is typed. */
  app.post('/api/quotes/preview', async (req) => {
    const p = await priceQuote(db, req.body as QuoteInput);
    return {
      supply: p.supply, docKind: p.docKind, lang: p.lang, totals: p.totals, balanceBefore: p.balanceBefore, warnings: p.warnings, blocked: false,
      lines: p.lines.map((l) => ({ lineNo: l.lineNo, productId: l.product.id, baseQtyMilli: l.baseQty, rateQtyMilli: l.rateQty, ratePaise: l.ratePaise, inclusive: l.inclusive, rateSource: l.rateSource, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total })),
    };
  });

  app.post('/api/quotes', async (req, reply) => reply.status(201).send(await createQuote(db, ctxOf(req), req.body as QuoteInput)));

  app.get('/api/quotes', async (req) => {
    const q = z.object({ from: day.optional(), to: day.optional(), q: z.string().max(60).optional() }).parse(req.query);
    const to = q.to ?? todayIST();
    const from = q.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
    const like = `%${(q.q ?? '').trim().toLowerCase()}%`;
    const rows = await all<QuoteRow & { doc_date: string; party_name: string; total_paise: number }>(db, `
      SELECT d.id, d.doc_no, d.doc_date, d.party_name, d.site, d.total_paise, d.status, d.party_id, d.lang, d.notes, d.converted_bill_id, d.valid_until
      FROM sales_docs d WHERE d.doc_type = 'QT' AND d.deleted = 0 AND d.doc_date BETWEEN ? AND ?
        AND (? = '%%' OR lower(d.doc_no) LIKE ? OR lower(d.party_name) LIKE ? OR lower(COALESCE(d.site, '')) LIKE ?)
      ORDER BY d.doc_date DESC, d.created_at DESC`, [from, to, like, like, like, like]);
    const out = [];
    for (const r of rows) {
      const s = await stateOf(db, r);
      out.push({ id: r.id, docNo: r.doc_no, date: r.doc_date, party: r.party_name, site: r.site, totalPaise: Number(r.total_paise), validUntil: r.valid_until, ...s });
    }
    return out;
  });

  /** The quotation for viewing / printing (same shape as a bill) and what became of it. */
  app.get('/api/quotes/:id', async (req) => {
    const id = idOf(req);
    const q = await getQuote(db, id);
    return { ...(await getBill(db, id)), quote: { validUntil: q.valid_until, ...(await stateOf(db, q)) } };
  });

  /** What the bill would be: per line, the quoted rate and today's. */
  app.post('/api/quotes/:id/convert/preview', async (req) => {
    const b = ConvertInput.parse(req.body ?? {});
    const { input, quoted } = await billFromQuote(db, idOf(req), b.keepRates);
    const today = await priceBill(db, { ...input, payment: b.payment });
    return {
      totals: today.totals, warnings: today.warnings, blocked: today.blocked, balanceBefore: today.balanceBefore,
      lines: today.lines.map((l, i) => ({ productId: l.product.id, name_en: l.product.name_en, name_ta: l.product.name_ta, quotedRatePaise: quoted[i]!.ratePaise, ratePaise: l.ratePaise, total: l.total })),
    };
  });

  /** Make the bill. 409 with warnings when stock / credit need confirming, as for a bill. */
  app.post('/api/quotes/:id/convert', async (req, reply) => {
    const id = idOf(req);
    const b = ConvertInput.parse(req.body ?? {});
    const { quote, input } = await billFromQuote(db, id, b.keepRates);
    if (quote.status === 'cancelled') throw new UserError(`Quotation ${quote.doc_no} is cancelled`, 'QUOTE_CANCELLED', 409);
    const r = await createBill(db, ctxOf(req), { ...input, payment: b.payment, confirmWarnings: b.confirmWarnings }, { fromQuote: id });
    return reply.status(r.saved ? 201 : 409).send(r);
  });

  app.post('/api/quotes/:id/cancel', async (req) => {
    const id = idOf(req);
    const q = await getQuote(db, id);
    if (q.status === 'cancelled') return { ok: true };
    if ((await stateOf(db, q)).state === 'converted') throw new UserError(`Quotation ${q.doc_no} is already a bill; cancel the bill instead`, 'QUOTE_CONVERTED', 409);
    const tx = await db.transaction('write');
    try {
      await update(tx, 'sales_docs', deviceId, id, { status: 'cancelled', cancelled_at: nowIso(), cancelled_by: req.user!.id });
      await insert(tx, 'audit_log', deviceId, { at: nowIso(), user_id: req.user!.id, entity: 'sales_docs', entity_id: id, action: 'cancel', after_json: { docNo: q.doc_no, quote: true } });
      await tx.commit();
    } catch (e) {
      if (!tx.closed) await tx.rollback();
      throw e;
    }
    return { ok: true };
  });
}
