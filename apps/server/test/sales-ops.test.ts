import { todayIST } from '@tula/core';
import { all, insert, one, type Db } from '@tula/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootSignedIn, callAs, type Booted, type Call } from './helpers';

let b: Booted;
let db: Db;
let call: Call;
let dev: string;
type Item = { id: string; sku: string; stockMilli: number | null };
let catalog: Item[];
const sku = (s: string) => catalog.find((p) => p.sku === s)!;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(`${todayIST()}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
const json = async (p: Promise<{ json: () => unknown; statusCode: number }>) => (await p).json() as any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function balanced() {
  const tb = await one<{ dr: number; cr: number }>(db, 'SELECT COALESCE(SUM(debit_paise),0) dr, COALESCE(SUM(credit_paise),0) cr FROM ledger_entries WHERE deleted = 0');
  expect(Number(tb!.dr)).toBe(Number(tb!.cr));
}
const stock = async (s: string) => Number((await one<{ q: number }>(db, 'SELECT COALESCE(SUM(qty_milli),0) q FROM stock_moves WHERE deleted = 0 AND product_id = ?', [sku(s).id]))!.q);
const balanceOf = async (partyId: string) => Number((await one<{ b: number }>(db, 'SELECT COALESCE(balance_paise,0) b FROM v_party_balance WHERE party_id = ?', [partyId]))?.b ?? 0);

async function customer(name: string, extra: Record<string, unknown> = {}) {
  return insert(db, 'parties', dev, { party_type: 'customer', name_en: name, state_code: '33', credit_days: 30, opening_date: todayIST(), ...extra });
}

async function bill(partyId: string, lines: Array<{ sku: string; qty: Record<string, string>; rate?: string; discount?: string }>, opts: { date?: string; paid?: string; mode?: string } = {}) {
  const res = await call({
    method: 'POST', url: '/api/bills', payload: {
      partyId, date: opts.date, confirmWarnings: true,
      lines: lines.map((l) => ({ productId: sku(l.sku).id, entry: l.qty, rate: l.rate, discount: l.discount })),
      payment: opts.paid ? { mode: opts.mode ?? 'cash', amount: opts.paid } : undefined,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; docNo: string; total: number; receiptNo: string | null };
}
const getBill = (id: string) => json(call(`/api/bills/${id}`));
const openBills = (partyId: string) => json(call(`/api/parties/${partyId}/open-bills`));

async function staffCall(): Promise<Call> {
  const u = await json(call({ method: 'POST', url: '/api/users', payload: { name: 'Counter', role: 'billing', pin: '2468' } }));
  const t = (await json(b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin: '2468' } }))).token;
  const staff = callAs(b.app, t);
  await staff({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: '2468', newPin: '5937' } });
  return staff;
}

beforeEach(async () => {
  b = await bootSignedIn({ preset: 'building-materials', demo: true });
  db = b.db;
  call = b.call;
  dev = (await one<{ value: string }>(db, "SELECT value FROM sync_state WHERE key='device_id'"))!.value;
  catalog = (await call('/api/catalog')).json();
});

describe('cancel a bill', () => {
  it('restores stock, reverses the ledger, frees receipts as advance and keeps the number', async () => {
    const ravi = await customer('Ravi');
    const stockBefore = await stock('TMT-12');
    const first = await bill(ravi, [{ sku: 'TMT-12', qty: { KG: '100' } }], { paid: '2000', mode: 'upi' });
    expect(await stock('TMT-12')).toBe(stockBefore - 100_000);

    const check = await json(call(`/api/bills/${first.id}/cancel-check`));
    expect(check).toMatchObject({ canCancel: true, earlierMonth: false });
    const res = await call({ method: 'POST', url: `/api/bills/${first.id}/cancel`, payload: { reason: 'Wrong customer' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', earlierMonth: false, advanceFreedPaise: 200_000 });

    const doc = await one<Record<string, unknown>>(db, 'SELECT * FROM sales_docs WHERE id = ?', [first.id]);
    expect(doc).toMatchObject({ status: 'cancelled', cancel_reason: 'Wrong customer', doc_no: first.docNo });
    expect(doc!.cancelled_at).toBeTruthy();
    expect(doc!.cancelled_by).toBeTruthy();
    expect(await stock('TMT-12')).toBe(stockBefore);
    await balanced();
    // The UPI receipt stays; the customer now has it as an advance.
    expect(await balanceOf(ravi)).toBe(-200_000);
    const ob = await openBills(ravi);
    expect(ob.bills).toHaveLength(0);
    expect(ob.advancePaise).toBe(200_000);
    expect(Number((await one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_log WHERE action = 'cancel' AND entity_id = ?", [first.id]))!.n)).toBe(1);

    // Numbers are never reused.
    const second = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '2' } }]);
    expect(second.docNo).toMatch(/0002$/);
    expect(first.docNo).toMatch(/0001$/);
    // ...and the advance can go against the new bill.
    const applied = await json(call({ method: 'POST', url: `/api/parties/${ravi}/apply-advance` }));
    expect(applied.appliedPaise).toBe(Math.min(200_000, second.total));
    expect((await getBill(second.id)).paidPaise).toBe(Math.min(200_000, second.total));
    await balanced();
  });

  it('refuses a second cancel, a bill with a credit note, and counter staff', async () => {
    const ravi = await customer('Ravi');
    const a = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    expect((await call({ method: 'POST', url: `/api/bills/${a.id}/cancel`, payload: { reason: 'x' } })).statusCode).toBe(200);
    const twice = await call({ method: 'POST', url: `/api/bills/${a.id}/cancel`, payload: { reason: 'x' } });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe('ALREADY_CANCELLED');
    expect((await call({ method: 'POST', url: `/api/bills/${a.id}/cancel`, payload: { reason: '' } })).statusCode).toBe(400);

    const c = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const line = (await json(call(`/api/bills/${c.id}/returnable`))).lines[0];
    expect((await call({ method: 'POST', url: `/api/bills/${c.id}/return`, payload: { reason: 'Rusty', lines: [{ lineId: line.lineId, qty: '1' }] } })).statusCode).toBe(201);
    const withCn = await call({ method: 'POST', url: `/api/bills/${c.id}/cancel`, payload: { reason: 'x' } });
    expect(withCn.statusCode).toBe(409);
    expect(withCn.json().message).toMatch(/return instead/i);
    expect((await json(call(`/api/bills/${c.id}/cancel-check`))).canCancel).toBe(false);

    const staff = await staffCall();
    const d = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '1' } }]);
    expect((await staff({ method: 'POST', url: `/api/bills/${d.id}/cancel`, payload: { reason: 'x' } })).statusCode).toBe(403);
    await balanced();
  });

  it('warns when the bill is from an earlier month', async () => {
    const ravi = await customer('Ravi');
    const old = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '1' } }], { date: daysAgo(40) });
    expect((await json(call(`/api/bills/${old.id}/cancel-check`))).earlierMonth).toBe(true);
    expect((await json(call({ method: 'POST', url: `/api/bills/${old.id}/cancel`, payload: { reason: 'Duplicate' } }))).earlierMonth).toBe(true);
  });
});

describe('sales return (credit note)', () => {
  it('allows partial returns until the sold quantity, and a full return reverses the bill exactly', async () => {
    const ravi = await customer('Ravi');
    const before = { tmt: await stock('TMT-12'), bw: await stock('BW-20') };
    const inv = await bill(ravi, [{ sku: 'TMT-12', qty: { BDL: '3', ROD: '1' }, discount: '137' }, { sku: 'BW-20', qty: { KG: '7' } }]);
    const r = await json(call(`/api/bills/${inv.id}/returnable`));
    const [steel, wire] = r.lines;
    expect(steel.returnedMilli).toBe(0);
    expect(steel.returnableMilli).toBe(steel.soldMilli);

    const ret = (lines: Array<{ lineId: string; qty: string }>, extra = {}) => call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'Excess delivered', lines, ...extra } });
    const firstQty = '50.5';
    const cn1 = await ret([{ lineId: steel.lineId, qty: firstQty }]);
    expect(cn1.statusCode, cn1.body).toBe(201);
    expect(cn1.json().docNo).toMatch(/^CN\//);
    const after1 = await json(call(`/api/bills/${inv.id}/returnable`));
    expect(after1.lines[0].returnedMilli).toBe(50_500);

    const tooMuch = await ret([{ lineId: steel.lineId, qty: String(steel.soldMilli / 1000) }]);
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error).toBe('TOO_MUCH');

    const leftQty = String((steel.soldMilli - 50_500) / 1000);
    const cn2 = await ret([{ lineId: steel.lineId, qty: leftQty }, { lineId: wire.lineId, qty: '7' }]);
    expect(cn2.statusCode, cn2.body).toBe(201);
    expect(cn2.json().docNo).toMatch(/0002$/);
    expect((await ret([{ lineId: wire.lineId, qty: '0.5' }])).statusCode).toBe(400);

    // Everything came back: CN totals equal the bill, stock and balance are back where they were.
    const cns = await all<{ total_paise: number; taxable_paise: number; cgst_paise: number }>(db, "SELECT total_paise, taxable_paise, cgst_paise FROM sales_docs WHERE doc_type = 'CN' AND ref_doc_id = ?", [inv.id]);
    const invDoc = (await getBill(inv.id)).doc;
    expect(cns.reduce((a, c) => a + Number(c.taxable_paise), 0)).toBe(invDoc.taxable_paise);
    expect(cns.reduce((a, c) => a + Number(c.cgst_paise), 0)).toBe(invDoc.cgst_paise);
    expect(Math.abs(cns.reduce((a, c) => a + Number(c.total_paise), 0) - invDoc.total_paise)).toBeLessThanOrEqual(100); // round-off per note
    expect(await stock('TMT-12')).toBe(before.tmt);
    expect(await stock('BW-20')).toBe(before.bw);
    expect((await openBills(ravi)).bills).toHaveLength(0);
    await balanced();

    // Stock value comes back at the original cost; the line keeps the returned cost for profit reports.
    const mv = await one<{ qty_milli: number; value_paise: number }>(db, "SELECT qty_milli, value_paise FROM stock_moves WHERE source_type = 'CN' AND source_id = ? AND product_id = ?", [cn1.json().id, sku('TMT-12').id]);
    const orig = (await getBill(inv.id)).lines[0];
    expect(mv!.value_paise).toBe(Math.round((mv!.qty_milli * orig.cost_per_base_paise) / 1000));
    const cnLine = await one<{ cost_total_paise: number; ref_line_id: string }>(db, 'SELECT cost_total_paise, ref_line_id FROM sales_doc_lines WHERE doc_id = ?', [cn1.json().id]);
    expect(cnLine).toMatchObject({ cost_total_paise: mv!.value_paise, ref_line_id: steel.lineId });
  });

  it('prices a return from a GST-exclusive bill at the original rate and discount share', async () => {
    const ravi = await customer('Ravi');
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' }, discount: '50' }]); // 750 − 50 = 700 taxable
    const line = (await json(call(`/api/bills/${inv.id}/returnable`))).lines[0];
    const p = await json(call({ method: 'POST', url: `/api/bills/${inv.id}/return/preview`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '4' }] } }));
    // 4 kg × 75 = 300, discount share 20 → taxable 280, CGST = SGST = 25.20
    expect(p.lines[0]).toMatchObject({ taxable: 28_000, cgst: 2520, sgst: 2520, igst: 0, total: 33_040 });
    expect(p.totals.total).toBe(33_000);
    expect(p.totals.roundOff).toBe(-40);
    const cn = await json(call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '4' }] } }));
    const doc = (await getBill(cn.id)).doc;
    expect(doc).toMatchObject({ doc_type: 'CN', ref_doc_id: inv.id, total_paise: 33_000, round_off_paise: -40 });
    expect(await balanceOf(ravi)).toBe(inv.total - 33_000);
    expect((await openBills(ravi)).bills[0]).toMatchObject({ returnedPaise: 33_000, balancePaise: inv.total - 33_000 });
    await balanced();
  });

  it('keeps GST-inclusive rates inclusive on the credit note', async () => {
    await call({ method: 'PUT', url: '/api/settings', payload: { 'billing.rates_include_gst': 'true' } });
    const ravi = await customer('Ravi');
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' }, rate: '75' }]);
    expect((await getBill(inv.id)).lines[0].rate_inclusive).toBe(1);
    const line = (await json(call(`/api/bills/${inv.id}/returnable`))).lines[0];
    expect(line.inclusive).toBe(true);
    const cn = await json(call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '4' }] } }));
    // 4 × 75 incl. GST = exactly 300.00; taxable 254.24, tax 45.76 split 22.88 + 22.88
    expect(cn.lines[0]).toMatchObject({ total: 30_000, taxable: 25_424, cgst: 2288, sgst: 2288 });
    expect(cn.total).toBe(30_000);
    await balanced();
  });

  it('reverses IGST for an out-of-state customer', async () => {
    const kochi = await customer('Kochi Builders', { gstin: '32ABCDE1234F1Z5', state_code: '32' });
    const inv = await bill(kochi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const line = (await json(call(`/api/bills/${inv.id}/returnable`))).lines[0];
    const cn = await json(call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '3' }] } }));
    expect(cn.lines[0]).toMatchObject({ taxable: 22_500, cgst: 0, sgst: 0, igst: 4050, total: 26_550 });
    const igst = await one<{ d: number }>(db, "SELECT SUM(e.debit_paise) d FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'OUT_IGST' AND e.source_type = 'CN' AND e.deleted = 0");
    expect(Number(igst!.d)).toBe(4050);
    await balanced();
  });

  it('turns a return on a paid bill into an advance or a cash refund', async () => {
    const ravi = await customer('Ravi');
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: String(inv.total / 100), mode: 'cash' } });
    expect(await balanceOf(ravi)).toBe(0);
    const line = (await json(call(`/api/bills/${inv.id}/returnable`))).lines[0];
    const tooBig = await call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '2' }], refund: { mode: 'cash', amount: '500' } } });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error).toBe('REFUND_TOO_MUCH');
    const res = await json(call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '2' }], refund: { mode: 'cash', amount: '100' } } }));
    expect(res.refundNo).toMatch(/^PY\//);
    expect(res.total).toBe(17_700);
    // Paid 885, returned 177, refunded 100 → 77 stays with the customer as advance.
    expect(await balanceOf(ravi)).toBe(-7_700);
    const ob = await openBills(ravi);
    expect(ob.bills).toHaveLength(0);
    expect(ob.advancePaise).toBe(7_700);
    const cash = await one<{ c: number }>(db, "SELECT SUM(e.credit_paise) c FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'CASH' AND e.source_type = 'PAY' AND e.deleted = 0");
    expect(Number(cash!.c)).toBe(10_000);
    await balanced();
  });

  it('refuses returns on a cancelled bill and by counter staff', async () => {
    const ravi = await customer('Ravi');
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const line = (await json(call(`/api/bills/${inv.id}/returnable`))).lines[0];
    const staff = await staffCall();
    expect((await staff({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '1' }] } })).statusCode).toBe(403);
    await call({ method: 'POST', url: `/api/bills/${inv.id}/cancel`, payload: { reason: 'x' } });
    const r = await call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '1' }] } });
    expect(r.statusCode).toBe(409);
  });
});

describe('receipts', () => {
  it('allocates oldest bills first, keeps the rest as advance, and applies the advance later', async () => {
    const ravi = await customer('Ravi');
    const b1 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { date: daysAgo(20) }); // 885
    const b2 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '20' } }], { date: daysAgo(10) }); // 1770
    const preview = await json(call({ method: 'POST', url: '/api/receipts/preview', payload: { partyId: ravi, amount: '1000', mode: 'cash' } }));
    expect(preview.allocations).toEqual([{ billId: b1.id, docNo: b1.docNo, amountPaise: 88_500 }, { billId: b2.id, docNo: b2.docNo, amountPaise: 11_500 }]);
    expect(preview.advancePaise).toBe(0);

    const r1 = await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '1000', mode: 'cheque', reference: 'CHQ 112233' } });
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json().docNo).toMatch(/^RC\//);
    let ob = await openBills(ravi);
    expect(ob.bills.map((x: { id: string; balancePaise: number }) => [x.id, x.balancePaise])).toEqual([[b2.id, 177_000 - 11_500]]);
    const bank = await one<{ d: number }>(db, "SELECT SUM(e.debit_paise) d FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = 'BANK' AND e.deleted = 0");
    expect(Number(bank!.d)).toBe(100_000); // cheque goes to bank

    // Pays more than owed: the extra is an advance.
    await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '2000', mode: 'upi' } });
    ob = await openBills(ravi);
    expect(ob.bills).toHaveLength(0);
    expect(ob.advancePaise).toBe(200_000 - (177_000 - 11_500));
    expect(ob.balancePaise).toBe(-ob.advancePaise);

    const b3 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '1' } }]); // 89
    expect((await openBills(ravi)).bills).toHaveLength(1);
    const applied = await json(call({ method: 'POST', url: `/api/parties/${ravi}/apply-advance` }));
    expect(applied.appliedPaise).toBe(b3.total);
    expect((await openBills(ravi)).bills).toHaveLength(0);
    expect((await call({ method: 'POST', url: `/api/parties/${ravi}/apply-advance` })).statusCode).toBe(400);
    await balanced();

    const list = await json(call(`/api/receipts?from=${daysAgo(30)}&to=${todayIST()}`));
    expect(list).toHaveLength(2);
    const detail = await json(call(`/api/receipts/${r1.json().id}`));
    expect(detail.allocations).toHaveLength(2);
    expect(detail.receipt.mode).toBe('cheque');
  });

  it('takes explicit allocations and refuses bad ones', async () => {
    const ravi = await customer('Ravi');
    const b1 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { date: daysAgo(5) });
    const b2 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const r = await json(call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '500', mode: 'cash', allocations: [{ billId: b2.id, amount: '400' }] } }));
    expect(r.allocations).toEqual([{ billId: b2.id, docNo: b2.docNo, amountPaise: 40_000 }]);
    expect(r.advancePaise).toBe(10_000);
    const over = await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '100', mode: 'cash', allocations: [{ billId: b1.id, amount: '200' }] } });
    expect(over.statusCode).toBe(400);
    const tooMuch = await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '2000', mode: 'cash', allocations: [{ billId: b1.id, amount: '900' }] } });
    expect(tooMuch.statusCode).toBe(400);
    expect((await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '0', mode: 'cash' } })).statusCode).toBe(400);
  });

  it('pays the opening balance first', async () => {
    const parties = await json(call('/api/parties'));
    const sb = parties.find((p: { name_en: string }) => p.name_en === 'Sample Builders');
    const inv = await bill(sb.id, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const p1 = await json(call({ method: 'POST', url: '/api/receipts/preview', payload: { partyId: sb.id, amount: '10000', mode: 'cash' } }));
    expect(p1).toMatchObject({ toOpeningPaise: 1_000_000, allocations: [], openingDuePaise: 2_500_000 });
    const p2 = await json(call({ method: 'POST', url: '/api/receipts', payload: { partyId: sb.id, amount: '25500', mode: 'cash' } }));
    expect(p2.toOpeningPaise).toBe(2_500_000);
    expect(p2.allocations).toEqual([{ billId: inv.id, docNo: inv.docNo, amountPaise: 50_000 }]);
    const ob = await openBills(sb.id);
    expect(ob.openingDuePaise).toBe(0);
    expect(ob.bills[0].balancePaise).toBe(inv.total - 50_000);
    expect(ob.balancePaise).toBe(inv.total - 50_000);
  });

  it('counts money paid at billing in open-bill balances', async () => {
    const ravi = await customer('Ravi');
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '20' } }], { paid: '1000', mode: 'upi' });
    const ob = await openBills(ravi);
    expect(ob.bills).toHaveLength(1);
    expect(ob.bills[0]).toMatchObject({ id: inv.id, totalPaise: 177_000, paidPaise: 100_000, returnedPaise: 0, balancePaise: 77_000, daysOld: 0, overdueDays: 0 });
    expect(ob.balancePaise).toBe(77_000);
    expect(ob.advancePaise).toBe(0);
  });

  it('cancels a receipt: ledger and allocations go, the bill is open again', async () => {
    const ravi = await customer('Ravi');
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const r = await json(call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '500', mode: 'cash' } }));
    expect(await balanceOf(ravi)).toBe(inv.total - 50_000);
    const staff = await staffCall();
    expect((await staff({ method: 'POST', url: `/api/receipts/${r.id}/cancel`, payload: { reason: 'Cheque bounced' } })).statusCode).toBe(403);
    const c = await call({ method: 'POST', url: `/api/receipts/${r.id}/cancel`, payload: { reason: 'Cheque bounced' } });
    expect(c.statusCode, c.body).toBe(200);
    expect(await balanceOf(ravi)).toBe(inv.total);
    expect((await openBills(ravi)).bills[0].balancePaise).toBe(inv.total);
    expect(Number((await one<{ n: number }>(db, 'SELECT COUNT(*) n FROM money_allocations WHERE money_doc_id = ? AND deleted = 0', [r.id]))!.n)).toBe(0);
    expect((await call({ method: 'POST', url: `/api/receipts/${r.id}/cancel`, payload: { reason: 'again' } })).statusCode).toBe(409);
    const listed = (await json(call('/api/receipts'))).find((x: { id: string }) => x.id === r.id);
    expect(listed.status).toBe('cancelled');
    await balanced();
  });
});

describe('outstanding and statement', () => {
  it('ages open balances, flags overdue bills and shows interest', async () => {
    await call({ method: 'PUT', url: '/api/settings', payload: { 'credit.interest_pa': '18' } });
    const ravi = await customer('Ravi', { mobile: '9876543210', lang: 'ta' });
    const d10 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { date: daysAgo(10) });
    const d45 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { date: daysAgo(45) });
    const d75 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { date: daysAgo(75) });
    const d120 = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { date: daysAgo(120) });
    // Part payment goes to the oldest bill.
    await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '385', mode: 'cash', date: daysAgo(2) } });
    const paidUp = await customer('Paid up');
    await bill(paidUp, [{ sku: 'BW-20', qty: { KG: '1' } }], { paid: '89' });

    const out = await json(call('/api/outstanding'));
    const row = out.rows.find((r: { partyId: string }) => r.partyId === ravi);
    expect(out.rows.find((r: { partyId: string }) => r.partyId === paidUp)).toBeUndefined();
    expect(row.balancePaise).toBe(4 * 88_500 - 38_500);
    expect(row.buckets).toEqual({ d0_30: d10.total, d31_60: d45.total, d61_90: d75.total, d90_plus: d120.total - 38_500 });
    expect(row.overduePaise).toBe(d45.total + d75.total + d120.total - 38_500);
    expect(row.lastPaymentDate).toBe(daysAgo(2));
    expect(row.advancePaise).toBe(0);
    expect(row.oldestDays).toBe(120);
    const interest = Math.round((88_500 * 1800 * 15) / 3_650_000) + Math.round((88_500 * 1800 * 45) / 3_650_000) + Math.round((50_000 * 1800 * 90) / 3_650_000);
    expect(row.interestPaise).toBe(interest);
    // Sample Builders' opening balance (today) is included as the 0–30 bucket.
    const sb = out.rows.find((r: { name_en: string }) => r.name_en === 'Sample Builders');
    expect(sb.buckets.d0_30).toBe(2_500_000);
    expect(out.totals.balancePaise).toBe(out.rows.reduce((a: number, r: { balancePaise: number }) => a + r.balancePaise, 0));
  });

  it('builds a statement whose closing balance equals the ledger', async () => {
    const ravi = await customer('Ravi');
    const old = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { date: daysAgo(40) });
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '20' } }], { date: daysAgo(5), paid: '500' });
    const cancelled = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '3' } }], { date: daysAgo(4) });
    await call({ method: 'POST', url: `/api/bills/${cancelled.id}/cancel`, payload: { reason: 'Typo' } });
    const line = (await json(call(`/api/bills/${inv.id}/returnable`))).lines[0];
    await call({ method: 'POST', url: `/api/bills/${inv.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '2' }] } });
    await call({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '300', mode: 'upi', reference: 'UTR99' } });

    const st = await json(call(`/api/parties/${ravi}/statement?from=${daysAgo(10)}&to=${todayIST()}`));
    expect(st.openingPaise).toBe(old.total);
    expect(st.lines.map((l: { kind: string }) => l.kind)).toEqual(['INV', 'RCPT', 'CN', 'RCPT']);
    expect(st.lines.some((l: { docNo: string }) => l.docNo === cancelled.docNo)).toBe(false);
    expect(st.closingPaise).toBe(await balanceOf(ravi));
    expect(st.closingPaise).toBe(st.balanceTodayPaise);
    expect(st.lines.at(-1).balancePaise).toBe(st.closingPaise);
    expect(st.lines[2].detail).toBe(inv.docNo); // credit note shows the bill it is against

    const full = await json(call(`/api/parties/${ravi}/statement?from=${daysAgo(60)}`));
    expect(full.openingPaise).toBe(0);
    expect(full.closingPaise).toBe(st.closingPaise);
  });
});

describe('permissions and the bills register', () => {
  it('lets counter staff take receipts but nothing else here', async () => {
    const ravi = await customer('Ravi');
    const inv = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const staff = await staffCall();
    expect((await staff({ method: 'POST', url: '/api/receipts/preview', payload: { partyId: ravi, amount: '100', mode: 'cash' } })).statusCode).toBe(200);
    const r = await staff({ method: 'POST', url: '/api/receipts', payload: { partyId: ravi, amount: '100', mode: 'cash' } });
    expect(r.statusCode).toBe(201);
    const rc = await one<{ created_by: string }>(db, 'SELECT created_by FROM money_docs WHERE id = ?', [r.json().id]);
    expect(rc!.created_by).not.toBe((await one<{ created_by: string }>(db, 'SELECT created_by FROM sales_docs WHERE id = ?', [inv.id]))!.created_by);
    expect((await staff({ method: 'POST', url: `/api/parties/${ravi}/apply-advance` })).statusCode).toBe(403);
    expect((await staff({ method: 'POST', url: `/api/bills/${inv.id}/return/preview`, payload: {} })).statusCode).toBe(403);
    expect((await staff(`/api/outstanding`)).statusCode).toBe(200);
    expect((await staff(`/api/parties/${ravi}/statement`)).statusCode).toBe(200);
  });

  it('lists bills with balance, returns and status', async () => {
    const ravi = await customer('Ravi Kumar');
    const paid = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '1' } }], { paid: '89' });
    const part = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }], { paid: '100' });
    const returned = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    const cancelled = await bill(ravi, [{ sku: 'BW-20', qty: { KG: '10' } }]);
    await call({ method: 'POST', url: `/api/bills/${cancelled.id}/cancel`, payload: { reason: 'x' } });
    const line = (await json(call(`/api/bills/${returned.id}/returnable`))).lines[0];
    await call({ method: 'POST', url: `/api/bills/${returned.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.lineId, qty: '1' }] } });

    const rows = await json(call('/api/sales/bills?q=ravi'));
    const by = (id: string) => rows.find((r: { id: string }) => r.id === id);
    expect(by(paid.id).state).toBe('paid');
    expect(by(part.id)).toMatchObject({ state: 'part_paid', balancePaise: 88_500 - 10_000 });
    expect(by(returned.id)).toMatchObject({ returned: true, balancePaise: 88_500 - 8_900 });
    expect(by(returned.id).creditNotes[0].docNo).toMatch(/^CN\//);
    expect(by(cancelled.id)).toMatchObject({ state: 'cancelled', balancePaise: 0 });
    expect(await json(call(`/api/sales/bills?q=${encodeURIComponent(paid.docNo)}`))).toHaveLength(1);
    expect(await json(call('/api/sales/bills?q=nobody'))).toHaveLength(0);

    const links = await json(call(`/api/sales-docs/${by(returned.id).creditNotes[0].id}/links`));
    expect(links).toMatchObject({ docType: 'CN', ref: { id: returned.id, doc_no: returned.docNo } });
  });
});
