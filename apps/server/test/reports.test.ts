import { roundDiv, todayIST } from '@tula/core';
import { all, insert, one, softDelete, update, type Db } from '@tula/db';
import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { accountId, partyAccountId, post } from '../src/accounts';
import { b2clLimitPaise, setOff } from '../src/reports/gst';
import { bootSignedIn, callAs, type Call } from './helpers';

/*
 * A realistic September 2026 for the demo steel dealer (Tamil Nadu, state 33), all amounts hand-checked.
 * Sales go through the bill API; other documents are written directly, following engineering guide §4.
 *
 * Sales (taxable, GST 18%), cost snapshot = opening average cost:
 *   INV1 03-09 Kumar (33, GSTIN)     TMT-12 1000 kg @60   60,000  CGST 5,400 SGST 5,400  total 70,800  cost 55,500
 *   INV2 05-09 Bengaluru (29, GSTIN) Cement 100 bag @380  38,000  IGST 6,840              total 44,840  cost 33,000
 *   INV3 08-09 Kochi (32, no GSTIN)  TMT-16 2000 kg @60  120,000  IGST 21,600 (B2CL)      total 141,600 cost 111,000
 *   INV4 10-09 walk-in               BW-20 10 kg @75         750  CGST 67.50 SGST 67.50   total 885 (paid cash) cost 680
 *   INV5 12-09 Kochi                 TMT-08 100 kg @63     6,300  IGST 1,134 (B2CS)       total 7,434   cost 5,800
 *   INV6 15-09 walk-in               Cement 10 bag — CANCELLED
 *   INV7 20-09 Kumar                 Transport (SAC 9965)  1,000  CGST 90 SGST 90          total 1,180   cost 0
 *   CN1  22-09 Kumar, against INV1   TMT-12 100 kg back    6,000  CGST 540 SGST 540        total 7,080   cost 5,550
 * Net sales 2,20,050; COGS 2,05,980 − 5,550 = 2,00,430; gross profit 19,620.
 * Expenses: rent 15,000 (no GST) + loading 2,000 (+GST with ITC) + fuel 1,000 + 180 GST without ITC = 18,180.
 * Stock correction: 5 kg binding wire scrapped at the average cost then (opening 300 kg @68 + 100 kg @82.60 landed) = 358.25.
 * Net profit = 19,620 − 18,180 − 358.25 = 1,081.75.
 */
const MONTH = { from: '2026-09-01', to: '2026-09-30' };
const q = `from=${MONTH.from}&to=${MONTH.to}`;

let db: Db;
let call: Call;
let dev: string;
let owner: string;
let app: Awaited<ReturnType<typeof bootSignedIn>>['app'];
const ids: Record<string, string> = {};
const pid = async (sku: string) => (await one<{ id: string }>(db, 'SELECT id FROM products WHERE sku = ?', [sku]))!.id;

async function party(body: Record<string, unknown>) {
  const r = await call({ method: 'POST', url: '/api/parties', payload: body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

async function bill(date: string, partyId: string, lines: Array<{ sku: string; entry: Record<string, string>; rate: string }>, payment?: { mode: 'cash'; amount: string }) {
  const payload = { date, partyId, payment, confirmWarnings: true, lines: await Promise.all(lines.map(async (l) => ({ productId: await pid(l.sku), entry: l.entry, rate: l.rate }))) };
  const r = await call({ method: 'POST', url: '/api/bills', payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; docNo: string; total: number };
}

const P = (rupees: number) => Math.round(rupees * 100);

/** Credit note per §4: reverse of the invoice for the returned lines; stock back at the original line's cost. */
async function creditNote(date: string, inv: string, sku: string, qtyMilli: number, ratePaise: number) {
  const orig = (await one<Record<string, unknown>>(db, 'SELECT * FROM sales_docs WHERE id = ?', [inv]))!;
  const product = await pid(sku);
  const line = (await one<Record<string, unknown>>(db, 'SELECT * FROM sales_doc_lines WHERE doc_id = ? AND product_id = ?', [inv, product]))!;
  const taxable = roundDiv(qtyMilli * ratePaise, 1000);
  const half = roundDiv(taxable * 900, 10000);
  const total = taxable + 2 * half;
  const cost = roundDiv(qtyMilli * Number(line.cost_per_base_paise), 1000);
  const id = await insert(db, 'sales_docs', dev, {
    doc_type: 'CN', doc_no: 'CN/26-27/0001', doc_date: date, fy: '26-27', party_id: orig.party_id, party_name: orig.party_name, party_gstin: orig.party_gstin,
    place_of_supply: orig.place_of_supply, supply_type: orig.supply_type, ref_doc_id: inv, lang: 'en', taxable_paise: taxable, cgst_paise: half, sgst_paise: half,
    total_paise: total, created_by: owner,
  });
  const lid = await insert(db, 'sales_doc_lines', dev, {
    doc_id: id, line_no: 1, product_id: product, description: 'TMT 12', hsn: line.hsn, base_qty_milli: qtyMilli, rate_unit_id: line.rate_unit_id, rate_qty_milli: qtyMilli,
    rate_paise: ratePaise, taxable_paise: taxable, gst_bp: 1800, cgst_paise: half, sgst_paise: half, line_total_paise: total, cost_per_base_paise: line.cost_per_base_paise, cost_total_paise: cost,
  });
  await insert(db, 'stock_moves', dev, { move_date: date, product_id: product, qty_milli: qtyMilli, value_paise: cost, source_type: 'CN', source_id: id, source_line_id: lid });
  await post(db, dev, {
    date, sourceType: 'CN', sourceId: id, narration: 'CN/26-27/0001',
    lines: [
      { accountId: await accountId(db, 'SALES'), debit: taxable }, { accountId: await accountId(db, 'OUT_CGST'), debit: half },
      { accountId: await accountId(db, 'OUT_SGST'), debit: half }, { accountId: await partyAccountId(db, dev, String(orig.party_id)), credit: total },
    ],
  });
  return id;
}

/** Purchase / debit note per §4. Lines: [sku | null (freight), qty kg, taxable paise]. Intra-state 18%. */
async function purchase(type: 'PUR' | 'DN', no: string, date: string, partyId: string, itc: boolean, lines: Array<[string | null, number, number]>, refId?: string) {
  const taxable = lines.reduce((a, l) => a + l[2], 0);
  const half = roundDiv(taxable * 900, 10000);
  const total = taxable + 2 * half;
  const id = await insert(db, 'purchase_docs', dev, {
    doc_type: type, doc_no: no, supplier_bill_no: `S-${no}`, doc_date: date, fy: '26-27', party_id: partyId, supply_type: 'intra', ref_doc_id: refId,
    taxable_paise: taxable, cgst_paise: half, sgst_paise: half, total_paise: total, itc_eligible: itc ? 1 : 0, created_by: owner,
  });
  const freight = lines.filter((l) => !l[0]).reduce((a, l) => a + l[2], 0);
  const goods = lines.filter((l) => l[0]);
  for (const [i, [sku, qty, tx]] of lines.entries()) {
    const product = sku ? await pid(sku) : null;
    // landed cost = taxable + freight share (+ tax when no ITC)
    const landed = sku ? tx + roundDiv(freight * tx, goods.reduce((a, l) => a + l[2], 0)) + (itc ? 0 : 2 * roundDiv(tx * 900, 10000)) : null;
    const lid = await insert(db, 'purchase_doc_lines', dev, {
      doc_id: id, line_no: i + 1, product_id: product, description: sku ?? 'Freight', base_qty_milli: qty, rate_qty_milli: qty, taxable_paise: tx, gst_bp: 1800,
      cgst_paise: roundDiv(tx * 900, 10000), sgst_paise: roundDiv(tx * 900, 10000), line_total_paise: tx + 2 * roundDiv(tx * 900, 10000), landed_cost_paise: landed,
    });
    if (product) {
      await insert(db, 'stock_moves', dev, {
        move_date: date, product_id: product, qty_milli: type === 'PUR' ? qty : -qty, value_paise: type === 'PUR' ? landed : null,
        source_type: type, source_id: id, source_line_id: lid,
      });
    }
  }
  const s = type === 'PUR' ? 1 : -1;
  const side = (amt: number, dr: boolean) => ((dr ? s : -s) > 0 ? { debit: amt } : { credit: amt });
  await post(db, dev, {
    date, sourceType: type, sourceId: id, narration: no,
    lines: [
      { accountId: await accountId(db, 'PURCHASES'), ...side(itc ? taxable : total, true) },
      ...(itc ? [{ accountId: await accountId(db, 'IN_CGST'), ...side(half, true) }, { accountId: await accountId(db, 'IN_SGST'), ...side(half, true) }] : []),
      { accountId: await partyAccountId(db, dev, partyId), ...side(total, false) },
    ],
  });
  return id;
}

async function expense(no: string, date: string, head: string, taxable: number, gst: number, itc: boolean, mode: 'cash' | 'bank') {
  const half = roundDiv(taxable * gst * 50, 10000);
  const total = taxable + 2 * half;
  const id = await insert(db, 'expenses', dev, {
    doc_no: no, doc_date: date, fy: '26-27', head_id: head, taxable_paise: taxable, gst_bp: gst * 100, cgst_paise: half, sgst_paise: half, total_paise: total,
    itc_eligible: itc ? 1 : 0, mode, created_by: owner,
  });
  let expAcc = (await one<{ id: string }>(db, 'SELECT id FROM accounts WHERE code = ?', [`EXP:${head}`]))?.id;
  if (!expAcc) expAcc = await insert(db, 'accounts', dev, { code: `EXP:${head}`, name_en: head, kind: 'expense', expense_head_id: head });
  await post(db, dev, {
    date, sourceType: 'EXP', sourceId: id, narration: no,
    lines: [
      { accountId: expAcc, debit: itc ? taxable : total },
      ...(itc ? [{ accountId: await accountId(db, 'IN_CGST'), debit: half }, { accountId: await accountId(db, 'IN_SGST'), debit: half }] : []),
      { accountId: await accountId(db, mode === 'cash' ? 'CASH' : 'BANK'), credit: total },
    ],
  });
}

async function money(type: 'RCPT' | 'PAY', no: string, date: string, partyId: string, amount: number, mode: 'upi' | 'bank') {
  const id = await insert(db, 'money_docs', dev, { doc_type: type, doc_no: no, doc_date: date, fy: '26-27', party_id: partyId, amount_paise: amount, mode, created_by: owner });
  const cash = await accountId(db, mode === 'upi' ? 'UPI' : 'BANK');
  const pacc = await partyAccountId(db, dev, partyId);
  await post(db, dev, { date, sourceType: type, sourceId: id, narration: no, lines: type === 'RCPT' ? [{ accountId: cash, debit: amount }, { accountId: pacc, credit: amount }] : [{ accountId: pacc, debit: amount }, { accountId: cash, credit: amount }] });
}

const get = async (url: string) => {
  const r = await call(url);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cell = any;
type T = { id: string; rows: Array<Record<string, Cell>>; totals: Record<string, Cell> };
const table = (rep: { tables: T[] }, id: string) => rep.tables.find((t) => t.id === id)!;
const ledgerNet = async (code: string, types: string[]) => {
  const r = await one<{ dr: number; cr: number }>(db, `
    SELECT COALESCE(SUM(e.debit_paise),0) dr, COALESCE(SUM(e.credit_paise),0) cr FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
    WHERE e.deleted = 0 AND a.code = ? AND e.entry_date BETWEEN ? AND ? AND e.source_type IN (${types.map(() => '?').join(',')})`, [code, MONTH.from, MONTH.to, ...types]);
  return Number(r!.dr) - Number(r!.cr);
};

beforeAll(async () => {
  const b = await bootSignedIn({ preset: 'building-materials', demo: true });
  db = b.db; call = b.call; app = b.app;
  dev = (await one<{ value: string }>(db, "SELECT value FROM sync_state WHERE key = 'device_id'"))!.value;
  owner = (await one<{ id: string }>(db, "SELECT id FROM users WHERE role = 'owner'"))!.id;
  for (const [d, r] of [['2026-09-01', 5800], ['2026-09-15', 5900]] as const) await insert(db, 'daily_rates', dev, { rate_group: 'TMT', rate_date: d, rate_paise: r });

  ids.kumar = await party({ name_en: 'Kumar Constructions', gstin: '33AAAPK1234C1Z2' });
  ids.blr = await party({ name_en: 'Bengaluru Infra', gstin: '29AABCB5678D1Z9' });
  ids.kochi = await party({ name_en: 'Kochi Builder', stateCode: '32' });
  ids.walkIn = (await one<{ id: string }>(db, 'SELECT id FROM parties WHERE is_walk_in = 1'))!.id;
  ids.supplier = await party({ partyType: 'supplier', name_en: 'Steel Mill Agency', gstin: '33AAACS9999K1Z1' });

  const inv1 = await bill('2026-09-03', ids.kumar, [{ sku: 'TMT-12', entry: { KG: '1000' }, rate: '60' }]);
  await bill('2026-09-05', ids.blr, [{ sku: 'CEM-OPC53', entry: { BAG: '100' }, rate: '380' }]);
  await bill('2026-09-08', ids.kochi, [{ sku: 'TMT-16', entry: { KG: '2000' }, rate: '60' }]);
  await bill('2026-09-10', ids.walkIn, [{ sku: 'BW-20', entry: { KG: '10' }, rate: '75' }], { mode: 'cash', amount: '885' });
  await bill('2026-09-12', ids.kochi, [{ sku: 'TMT-08', entry: { KG: '100' }, rate: '63' }]);
  const inv6 = await bill('2026-09-15', ids.walkIn, [{ sku: 'CEM-OPC53', entry: { BAG: '10' }, rate: '380' }]);
  await bill('2026-09-20', ids.kumar, [{ sku: 'SRV-TRANS', entry: { NOS: '1' }, rate: '1000' }]);
  ids.inv1 = inv1.id;
  // Cancel INV6 per §4: soft-delete its ledger entries and stock moves, mark cancelled.
  await softDelete(db, 'ledger_entries', dev, 'source_id = ?', [inv6.id]);
  await softDelete(db, 'stock_moves', dev, 'source_id = ?', [inv6.id]);
  await update(db, 'sales_docs', dev, inv6.id, { status: 'cancelled', cancel_reason: 'Wrong customer', cancelled_at: '2026-09-15T10:00:00Z', cancelled_by: owner });

  await creditNote('2026-09-22', inv1.id, 'TMT-12', 100_000, 6000);

  const pur1 = await purchase('PUR', 'PU/26-27/0001', '2026-09-02', ids.supplier, true, [['TMT-12', 5_000_000, P(280000)], [null, 0, P(2000)]]);
  await purchase('PUR', 'PU/26-27/0002', '2026-09-06', ids.supplier, false, [['BW-20', 100_000, P(7000)]]);
  await purchase('DN', 'DN/26-27/0001', '2026-09-09', ids.supplier, true, [['TMT-12', 100_000, P(5600)]], pur1);

  const rent = await insert(db, 'expense_heads', dev, { name_en: 'Rent', name_ta: 'வாடகை' });
  const loading = await insert(db, 'expense_heads', dev, { name_en: 'Loading', name_ta: 'ஏற்றுக்கூலி' });
  const fuel = await insert(db, 'expense_heads', dev, { name_en: 'Fuel', name_ta: 'எரிபொருள்' });
  await expense('EX/26-27/0001', '2026-09-01', rent, P(15000), 0, false, 'cash');
  await expense('EX/26-27/0002', '2026-09-18', loading, P(2000), 18, true, 'bank');
  await expense('EX/26-27/0003', '2026-09-19', fuel, P(1000), 18, false, 'cash');

  await money('PAY', 'PY/26-27/0001', '2026-09-25', ids.supplier, P(100000), 'bank');
  await money('RCPT', 'RC/26-27/0100', '2026-09-26', ids.kumar, P(50000), 'upi');

  // Stock correction: 5 kg binding wire scrapped at the average cost of the time.
  const bw = await pid('BW-20');
  const avg = Number((await one<{ a: number }>(db, 'SELECT avg_cost_per_base_paise a FROM v_avg_cost WHERE product_id = ?', [bw]))!.a);
  const adj = await insert(db, 'stock_adjustments', dev, { doc_no: 'AD/26-27/0001', doc_date: '2026-09-28', fy: '26-27', reason: 'scrap', approved_by: owner, created_by: owner });
  const al = await insert(db, 'stock_adjustment_lines', dev, { adjustment_id: adj, product_id: bw, qty_milli: -5000, cost_per_base_paise: avg });
  await insert(db, 'stock_moves', dev, { move_date: '2026-09-28', product_id: bw, qty_milli: -5000, value_paise: -roundDiv(5000 * avg, 1000), source_type: 'ADJ', source_id: adj, source_line_id: al });
});

describe('reports', () => {
  it('ledger still balances after the fixtures', async () => {
    const tb = await one<{ dr: number; cr: number }>(db, 'SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM ledger_entries WHERE deleted = 0');
    expect(tb!.dr).toBe(tb!.cr);
  });

  it('profit and loss matches the hand calculation', async () => {
    // binding wire average after PUR2: (300 kg × 68 + 8,260 landed) ÷ 400 kg = ₹71.65/kg → 5 kg = ₹358.25
    const r = await get(`/api/reports/profit-loss?${q}`);
    expect(r.summary).toMatchObject({ netSales: P(220050), cogs: P(200430), gross: P(19620), expenses: P(18180), stockLoss: 35825, net: 108175 });
    const months = table(r, 'months');
    expect(months.rows).toHaveLength(12);
    expect(months.rows[0]!.month).toBe('2026-04');
    expect(months.rows.find((m) => m.month === '2026-09')!.net).toBe(108175);
    const pnl = table(r, 'pnl');
    expect(pnl.rows.filter((x) => (x.line as unknown as { en?: string }).en).map((x) => (x.line as unknown as { en: string }).en).sort()).toEqual(['Fuel', 'Loading', 'Rent']);
  });

  it('profit by bill, customer and item all add up to gross profit, net of the credit note', async () => {
    for (const by of ['bill', 'customer', 'item']) {
      const r = await get(`/api/reports/profit?by=${by}&${q}`);
      expect(r.summary.profit, by).toBe(P(19620));
      expect(r.summary.sales, by).toBe(P(220050));
    }
    const bills = table(await get(`/api/reports/profit?by=bill&${q}`), 'by_bill');
    const b1 = bills.rows.find((x) => x.date === '2026-09-03')!;
    expect(b1.sales).toBe(P(54000));
    expect(b1.cost).toBe(P(49950));
    expect(b1.margin).toBe(roundDiv(P(4050) * 10000, P(54000)));
    const items = table(await get(`/api/reports/profit?by=item&${q}`), 'by_item');
    expect(items.rows.find((x) => x.sku === 'TMT-12')!.qty).toBe(900_000);
  });

  it('sales register totals to the ledger, credit note negative, cancelled bill shown but not totalled', async () => {
    const r = await get(`/api/reports/sales-register?${q}`);
    const t = table(r, 'sales');
    expect(t.rows).toHaveLength(8);
    const cancelled = t.rows.filter((x) => x._cancelled);
    expect(cancelled).toHaveLength(1);
    expect(t.rows.find((x) => x.type === 'CN')!.total).toBe(-P(7080));
    expect(t.totals!.taxable).toBe(P(220050));
    const types = ['INV', 'CN'];
    expect(t.totals!.taxable).toBe(-(await ledgerNet('SALES', types)));
    expect(t.totals!.cgst).toBe(-(await ledgerNet('OUT_CGST', types)));
    expect(t.totals!.sgst).toBe(-(await ledgerNet('OUT_SGST', types)));
    expect(t.totals!.igst).toBe(-(await ledgerNet('OUT_IGST', types)));
    const partyDr = await one<{ n: number }>(db, `SELECT SUM(e.debit_paise - e.credit_paise) n FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE e.deleted = 0 AND a.party_id IS NOT NULL AND e.source_type IN ('INV','CN') AND e.entry_date BETWEEN ? AND ?`, [MONTH.from, MONTH.to]);
    expect(t.totals!.total).toBe(Number(partyDr!.n));
  });

  it('purchase register totals to the ledger, with the ITC flag', async () => {
    const t = table(await get(`/api/reports/purchase-register?${q}`), 'purchases');
    expect(t.rows.map((x) => x.itc)).toEqual(['yes', 'no', 'yes']);
    expect(t.totals!.taxable).toBe(P(282000 + 7000 - 5600));
    const nonItcTax = t.rows.filter((x) => x.itc === 'no').reduce((a, x) => a + x.cgst + x.sgst + x.igst, 0);
    expect(t.totals!.taxable + nonItcTax).toBe(await ledgerNet('PURCHASES', ['PUR', 'DN']));
    const itcCgst = t.rows.filter((x) => x.itc === 'yes').reduce((a, x) => a + x.cgst, 0);
    expect(itcCgst).toBe(await ledgerNet('IN_CGST', ['PUR', 'DN']));
    const partyCr = await one<{ n: number }>(db, `SELECT SUM(e.credit_paise - e.debit_paise) n FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE e.deleted = 0 AND a.party_id IS NOT NULL AND e.source_type IN ('PUR','DN')`);
    expect(t.totals!.total).toBe(Number(partyCr!.n));
  });

  it('day book lists every document; cancelled is struck through and not totalled', async () => {
    const r = await get(`/api/reports/day-book?${q}`);
    const docs = table(r, 'documents');
    const types = new Set(docs.rows.map((x) => x.type));
    for (const ty of ['INV', 'CN', 'RCPT', 'PAY', 'PUR', 'DN', 'EXP', 'ADJ']) expect(types.has(ty), ty).toBe(true);
    const inv = table(r, 'by_type').rows.find((x) => x.type === 'INV')!;
    expect(inv).toMatchObject({ count: 6, cancelled: 1, amount: P(70800 + 44840 + 141600 + 885 + 7434 + 1180) });
  });

  it('cash and bank book: opening, entries, closing per account', async () => {
    const r = await get(`/api/reports/cash-book?${q}`);
    const s = table(r, 'accounts').rows;
    const cash = s.find((x) => x.code === 'CASH')!;
    expect(cash).toMatchObject({ opening: 0, money_in: P(885), money_out: P(15000 + 1180), closing: P(885 - 16180) });
    expect(s.find((x) => x.code === 'UPI')!.closing).toBe(P(50000));
    expect(s.find((x) => x.code === 'BANK')!.closing).toBe(-P(100000 + 2360));
    const bank = table(r, 'account_bank');
    expect(bank.rows.at(-1)!.balance).toBe(-P(102360));
    expect(bank.rows.some((x) => x.doc_no === 'PY/26-27/0001' && x.party === 'Steel Mill Agency')).toBe(true);
    // the opening balance carries over into the next month
    const oct = await get('/api/reports/cash-book?from=2026-10-01&to=2026-10-31');
    expect(table(oct, 'accounts').rows.find((x) => x.code === 'CASH')!.opening).toBe(P(885 - 16180));
  });

  it('GSTR-1 sections and HSN totals reconcile to the sales register; documents issued counts the cancelled bill', async () => {
    const r = await get('/api/reports/gstr1?month=2026-09');
    const reg = table(await get(`/api/reports/sales-register?${q}`), 'sales').totals!;
    const b2b = table(r, 'b2b');
    expect(new Set(b2b.rows.map((x) => x.inv_no)).size).toBe(3);
    expect(b2b.rows.reduce((a, x) => a + x.taxable, 0)).toBe(P(99000));
    expect(b2b.rows.find((x) => x.gstin === '29AABCB5678D1Z9')!.pos).toBe('29-Karnataka');
    const b2cl = table(r, 'b2cl');
    expect(b2cl.rows).toHaveLength(1);
    expect(b2cl.rows[0]!.inv_value).toBe(P(141600));
    const b2cs = table(r, 'b2cs');
    expect(b2cs.rows.map((x) => [x.pos, x.taxable])).toEqual([['32-Kerala', P(6300)], ['33-Tamil Nadu', P(750)]]);
    expect(table(r, 'cdnr').rows[0]).toMatchObject({ note_no: 'CN/26-27/0001', taxable: P(6000), note_value: P(7080) });
    expect(r.summary.taxable).toBe(reg.taxable);
    expect(r.summary.tax).toBe(reg.cgst + reg.sgst + reg.igst);
    expect(r.summary.hsnTaxable).toBe(reg.taxable);
    expect(r.summary.hsnTax).toBe(reg.cgst + reg.sgst + reg.igst);
    const hb2b = table(r, 'hsn_b2b').rows;
    expect(hb2b.find((x) => x.hsn === '7214')).toMatchObject({ uqc: 'KGS', qty: 900_000, taxable: P(54000) });
    expect(hb2b.find((x) => x.hsn === '9965')).toMatchObject({ uqc: 'NA', qty: 0 });
    expect(table(r, 'hsn_b2c').rows.find((x) => x.hsn === '7214')).toMatchObject({ qty: 2_100_000, taxable: P(126300), igst: P(22734) });
    const docs = table(r, 'docs').rows;
    expect(docs.find((x) => x.nature === 'Invoices for outward supply')).toMatchObject({ total: 7, cancelled: 1, sr_from: 'DT/26-27/0001', sr_to: 'DT/26-27/0007' });
    expect(docs.find((x) => x.nature === 'Credit Note')).toMatchObject({ total: 1, cancelled: 0 });
  });

  it('B2CL limit follows the date of the rule change', () => {
    expect(b2clLimitPaise('2024-07-31')).toBe(250_000_00);
    expect(b2clLimitPaise('2026-09-08')).toBe(100_000_00);
  });

  it('GSTR-3B: 3.1(a) equals the sales register tax, 3.2 by state, ITC from purchases and expenses', async () => {
    const r = await get('/api/reports/gstr3b?month=2026-09');
    const reg = table(await get(`/api/reports/sales-register?${q}`), 'sales').totals!;
    const a = table(r, 't31').rows[0]!;
    expect(a).toMatchObject({ taxable: reg.taxable, igst: reg.igst, cgst: reg.cgst, sgst: reg.sgst });
    expect(table(r, 't32').rows).toEqual([expect.objectContaining({ pos: '32-Kerala', taxable: P(126300), igst: P(22734) })]);
    const itc = table(r, 't4').rows[0]!;
    expect(itc).toMatchObject({ igst: 0, cgst: P(25380 - 504 + 180), sgst: P(25380 - 504 + 180) });
    const pay = table(r, 'payable').rows;
    // No IGST credit, but CGST/SGST credit left after their own heads pays the IGST (Section 49): nothing in cash.
    expect(pay.find((x) => x.head === 'igst')).toMatchObject({ payable: P(6840 + 21600 + 1134), cash: 0 });
    const tot = table(r, 'payable').totals!;
    expect(tot.cash).toBe(0);
    expect(tot.paid_by_itc).toBe(reg.cgst + reg.sgst + reg.igst);
    expect(tot.credit_left).toBe(2 * P(25056) - tot.paid_by_itc);
  });

  it('set-off uses IGST credit first, and CGST never pays SGST', () => {
    const r = setOff({ igst: 100, cgst: 50, sgst: 50 }, { igst: 120, cgst: 10, sgst: 0 });
    expect(r.paidByCredit).toEqual({ igst: 100, cgst: 30, sgst: 0 });
    expect(r.cash).toEqual({ igst: 0, cgst: 20, sgst: 50 });
    expect(r.creditLeft).toEqual({ igst: 0, cgst: 0, sgst: 0 });
  });

  it('stock summary value = Σ quantity × average cost; low and slow-moving lists', async () => {
    const asOf = todayIST() > '2026-09-30' ? todayIST() : '2026-09-30';
    const r = await get(`/api/reports/stock-summary?asOf=${asOf}&slowDays=60`);
    const rows = table(r, 'stock').rows;
    const moves = await all<{ product_id: string; sku: string; q: number }>(db, `SELECT p.id product_id, p.sku, COALESCE(SUM(m.qty_milli),0) q FROM products p
      LEFT JOIN stock_moves m ON m.product_id = p.id AND m.deleted = 0 AND m.move_date <= ? WHERE p.track_stock = 1 AND p.deleted = 0 GROUP BY p.id`, [asOf]);
    const avg = new Map((await all<{ product_id: string; a: number }>(db, 'SELECT product_id, avg_cost_per_base_paise a FROM v_avg_cost')).map((x) => [x.product_id, Number(x.a)]));
    const expected = moves.reduce((a, m) => a + roundDiv(Number(m.q) * (avg.get(m.product_id) ?? 0), 1000), 0);
    expect(r.summary.value).toBe(expected);
    const t12 = rows.find((x) => x.sku === 'TMT-12')!;
    expect(t12.qty).toBe((3000 - 1000 + 100 + 5000 - 100) * 1000);
    expect(t12.avg_cost).toBe(roundDiv((P(166500) + P(5550) + P(282000)) * 1000, 8_100_000));
    expect((t12.larger as unknown as { en: string }).en).toBe('Bundle');
    // TMT-20 has opening stock only: never sold → slow moving; paint has no stock → out (low list)
    expect(table(r, 'slow').rows.some((x) => x.sku === 'TMT-20')).toBe(true);
    expect(table(r, 'low').rows.some((x) => x.sku === 'PNT-EMU-20')).toBe(true);
  });

  it('rate group report: realised rate vs the day\'s base rate + size extra', async () => {
    const r = await get(`/api/reports/rate-group?group=TMT&by=day&${q}`);
    const day = table(r, 'by_period').rows;
    expect(day.find((x) => x.period === '2026-09-03' && x.sku === 'TMT-12')).toMatchObject({ qty: 1_000_000, realised: 6000, base_rate: 5800, diff: 200 });
    expect(day.find((x) => x.period === '2026-09-12' && x.sku === 'TMT-08')).toMatchObject({ realised: 6300, base_rate: 5800 + 300, diff: 200 });
    const item = table(r, 'by_item').rows.find((x) => x.sku === 'TMT-12')!;
    expect(item.qty).toBe(900_000); // net of the credit note
    const month = await get(`/api/reports/rate-group?group=TMT&by=month&${q}`);
    expect(table(month, 'by_period').rows.every((x) => x.period === '2026-09')).toBe(true);
  });

  it('composition scheme: CMP-08 for the quarter', async () => {
    const r = await get('/api/reports/cmp08?from=2026-09-10&rate=1');
    expect(r.from).toBe('2026-07-01');
    expect(r.to).toBe('2026-09-30');
    expect(r.summary.value).toBe(P(220050));
    expect(table(r, 'cmp08').rows[0]).toMatchObject({ cgst: P(1100.25), sgst: P(1100.25) });
  });

  it('billing role gets 403; viewer can read', async () => {
    for (const [name, role] of [['Counter', 'billing'], ['CA', 'viewer']] as const) {
      const u = await call({ method: 'POST', url: '/api/users', payload: { name, role, pin: '5791' } });
      expect(u.statusCode).toBe(201);
      const login = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.json().id, pin: '5791' } })).json();
      const as = callAs(app, login.token);
      for (const path of ['day-book', 'profit-loss', 'gstr1', 'stock-summary']) {
        const res = await as(`/api/reports/${path}?${q}&format=xlsx`);
        expect(res.statusCode, `${role} ${path}`).toBe(role === 'billing' ? 403 : 200);
      }
    }
  });

  it('Excel export is a valid workbook with headers, totals and the GST offline-tool layout', async () => {
    const res = await call(`/api/reports/sales-register?${q}&format=xlsx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toContain('Demo Traders - Sales register - 2026-09-01 to 2026-09-30.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Sales register')!;
    expect(ws.getCell('A3').value).toBe('Date');
    expect(ws.getCell('A3').font.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
    const last = ws.getRow(ws.rowCount);
    expect(last.getCell(1).value).toBe('Total');
    expect(last.getCell(8).value).toBe(220050);
    expect(ws.getCell('H4').numFmt).toContain('₹');

    const g = await call('/api/reports/gstr1?month=2026-09&format=xlsx');
    const gw = new ExcelJS.Workbook();
    await gw.xlsx.load(g.rawPayload as unknown as ArrayBuffer);
    expect(gw.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['b2b, sez, de', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'exemp', 'hsn(b2b)', 'hsn(b2c)', 'docs']));
    const b2b = gw.getWorksheet('b2b, sez, de')!;
    expect(b2b.getCell('A4').value).toBe('GSTIN/UIN of Recipient');
    expect(b2b.getCell('C2').value).toBe('No. of Invoices');
    expect(b2b.getCell('C3').value).toBe(3);
    expect(b2b.getCell('A5').value).toMatch(/^(33AAAPK1234C1Z2|29AABCB5678D1Z9)$/);
    const docsWs = gw.getWorksheet('docs')!;
    expect(docsWs.getCell('A6').value).toBe('Invoices for outward supply');
    expect(docsWs.getCell('E6').value).toBe(1);
  });

  it('rejects a bad period with a plain message', async () => {
    const r = await call('/api/reports/day-book?from=2026-09-30&to=2026-09-01');
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/start date/);
  });
});
