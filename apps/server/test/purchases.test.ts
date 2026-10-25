import { roundDiv, todayIST } from '@tula/core';
import { all, one, type Db } from '@tula/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, apportion } from '../src/purchases';
import { bootSignedIn, callAs, type Booted, type Call, type Res } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const json = async (p: Promise<Res>): Promise<Any> => (await p).json();

let b: Booted;
let db: Db;
let call: Call;
let catalog: Array<{ id: string; sku: string; units: Array<{ code: string; factorMilli: number }> }>;
const sku = (s: string) => catalog.find((p) => p.sku === s)!.id;
const today = todayIST();

async function supplier(name: string, gstin?: string, creditDays = 15): Promise<string> {
  const r = await call({ method: 'POST', url: '/api/parties', payload: { partyType: 'supplier', name_en: name, gstin, creditDays } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id;
}
const demoSupplier = async () => (await json(call('/api/parties'))).find((p: Any) => p.name_en === 'Sample Steel Distributor').id as string;

const stock = async (productId: string) => Number((await one<{ q: number }>(db, 'SELECT COALESCE(SUM(qty_milli),0) q FROM stock_moves WHERE product_id = ? AND deleted = 0', [productId]))!.q);
const avg = async (productId: string) => Number((await one<{ c: number }>(db, 'SELECT avg_cost_per_base_paise c FROM v_avg_cost WHERE product_id = ?', [productId]))?.c ?? 0);
const balance = async (partyId: string) => Number((await one<{ b: number }>(db, 'SELECT COALESCE(balance_paise,0) b FROM v_party_balance WHERE party_id = ?', [partyId]))?.b ?? 0);
/** Debit (+) or credit (−) total on a system account, over non-deleted rows, optionally for one document. */
async function acc(code: string, sourceId?: string) {
  const r = await one<{ v: number }>(db, `SELECT COALESCE(SUM(e.debit_paise - e.credit_paise),0) v FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
    WHERE a.code = ? AND e.deleted = 0 ${sourceId ? 'AND e.source_id = ?' : ''}`, sourceId ? [code, sourceId] : [code]);
  return Number(r!.v);
}
async function expectBalanced() {
  const r = await one<{ dr: number; cr: number }>(db, 'SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM ledger_entries WHERE deleted = 0');
  expect(Number(r!.dr)).toBe(Number(r!.cr));
}

async function purchase(payload: Any, status = 201) {
  const r = await call({ method: 'POST', url: '/api/purchases', payload });
  expect(r.statusCode, r.body).toBe(status);
  return r.json();
}

beforeEach(async () => {
  b = await bootSignedIn({ preset: 'building-materials', demo: true });
  db = b.db;
  call = b.call;
  catalog = await json(call('/api/catalog'));
});

describe('helpers', () => {
  it('apportions exactly, by weight', () => {
    expect(apportion(2000, [50000, 150000])).toEqual([500, 1500]);
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportion(7, [0, 0])).toEqual([7, 0]);
    expect(addDays('2026-10-25', 15)).toBe('2026-11-09');
  });
});

describe('purchase bills', () => {
  it('spreads freight into landed cost and updates the average cost', async () => {
    const sup = await supplier('Steel Mill Agency', '33AAACS1234A1Z1');
    const body = {
      supplierId: sup, supplierBillNo: 'SM-101', date: today,
      lines: [{ productId: sku('TMT-12'), entry: { KG: '1000' }, rate: '50' }, { productId: sku('TMT-16'), entry: { KG: '3000' }, rate: '50' }],
      charges: [{ description: 'Lorry freight', amount: '2000' }],
    };
    const pv = await json(call({ method: 'POST', url: '/api/purchases/preview', payload: body }));
    expect(pv.itc).toBe(true);
    expect(pv.supply).toBe('intra');
    expect(pv.lines.map((l: Any) => l.chargeShare)).toEqual([50_000, 150_000]); // ₹500 + ₹1,500 by value
    expect(pv.lines[0].landed).toBe(5_050_000);
    expect(pv.lines[0].landedPerBase).toBe(5050); // ₹50.50 per kg
    expect(pv.totals.total).toBe(23_800_000);

    const before = await stock(sku('TMT-12'));
    const saved = await purchase(body);
    expect(saved.docNo).toMatch(/^PU\/\d{2}-\d{2}\/0001$/);
    expect(saved.dueDate).toBe(addDays(today, 15));
    expect(await stock(sku('TMT-12'))).toBe(before + 1_000_000);
    // opening 3000 kg @ ₹55.50 + 1000 kg landed ₹50,500 → (1,66,500 + 50,500) / 4000 = ₹54.25
    expect(await avg(sku('TMT-12'))).toBe(5425);

    const doc = await json(call(`/api/purchases/${saved.id}`));
    expect(doc.lines).toHaveLength(3);
    const freight = doc.lines.find((l: Any) => l.product_id === null);
    expect(freight).toMatchObject({ description: 'Lorry freight', taxable_paise: 200_000 });
    const move = await one<{ value_paise: number }>(db, "SELECT value_paise FROM stock_moves WHERE source_type = 'PUR' AND product_id = ?", [sku('TMT-12')]);
    expect(Number(move!.value_paise)).toBe(5_050_000);

    expect(await acc('PURCHASES', saved.id)).toBe(20_200_000);
    expect(await acc('IN_CGST', saved.id)).toBe(1_800_000);
    expect(await acc('IN_SGST', saved.id)).toBe(1_800_000);
    expect(await balance(sup)).toBe(-23_800_000); // we owe the supplier
    await expectBalanced();
  });

  it('puts the tax into cost when input tax cannot be claimed', async () => {
    const sup = await demoSupplier(); // no GSTIN
    const body = { supplierId: sup, supplierBillNo: '77', lines: [{ productId: sku('TMT-12'), entry: { KG: '1000' }, rate: '50' }] };
    const refused = await call({ method: 'POST', url: '/api/purchases', payload: { ...body, itcEligible: true } });
    expect(refused.json().error).toBe('NO_ITC');
    const saved = await purchase(body);
    const line = (await json(call(`/api/purchases/${saved.id}`))).lines[0];
    expect(line.landed_cost_paise).toBe(5_900_000); // ₹50,000 + ₹9,000 GST
    expect(await acc('PURCHASES', saved.id)).toBe(5_900_000);
    expect(await acc('IN_CGST', saved.id)).toBe(0);
    expect((await one<{ itc_eligible: number }>(db, 'SELECT itc_eligible FROM purchase_docs WHERE id = ?', [saved.id]))!.itc_eligible).toBe(0);

    // A GST-registered supplier, but the owner says the ITC is not claimable (e.g. blocked credit)
    const reg = await supplier('Registered Co', '33AAACR1111A1Z1');
    const noItc = await purchase({ ...body, supplierId: reg, itcEligible: false });
    expect(await acc('PURCHASES', noItc.id)).toBe(5_900_000);
    await expectBalanced();
  });

  it('charges IGST on an inter-state bill and rounds to the rupee', async () => {
    const sup = await supplier('Karnataka Steels', '29AAACK1234A1Z5');
    const saved = await purchase({ supplierId: sup, supplierBillNo: 'KS/9', lines: [{ productId: sku('TMT-12'), entry: { KG: '10.5' }, rate: '55.55' }] });
    const doc = (await json(call(`/api/purchases/${saved.id}`))).doc;
    expect(doc.supply_type).toBe('inter');
    expect(doc.cgst_paise).toBe(0);
    expect(doc.igst_paise).toBe(10_499); // 18% of ₹583.28
    expect(doc.total_paise % 100).toBe(0);
    expect(doc.round_off_paise).toBe(doc.total_paise - (58_328 + 10_499));
    expect(await acc('IN_IGST', saved.id)).toBe(10_499);
    expect(await acc('ROUND_OFF', saved.id)).toBe(doc.round_off_paise);
    await expectBalanced();
  });

  it('accepts bundles and rods, GST-inclusive rates and a GST % per line', async () => {
    const sup = await supplier('Inclusive Traders', '33AAACI1111A1Z1');
    const pv = await json(call({ method: 'POST', url: '/api/purchases/preview', payload: {
      supplierId: sup, supplierBillNo: 'I-1', ratesIncludeGst: true,
      lines: [{ productId: sku('TMT-12'), entry: { BDL: '2', ROD: '1' }, rate: '59' }, { productId: sku('CEM-PPC'), entry: { BAG: '10' }, rate: '350', gst: '28' }],
    } }));
    expect(pv.lines[0].baseQtyMilli).toBe(2 * 53_335 + 10_667);
    expect(pv.lines[0].total).toBe(roundDiv(pv.lines[0].baseQtyMilli * 5900, 1000)); // inclusive: pays exactly the quoted amount
    expect(pv.lines[1].gstBp).toBe(2800);
    expect(pv.lines[1].taxable + pv.lines[1].cgst + pv.lines[1].sgst).toBe(350_000);
  });

  it('refuses the same supplier bill number twice, but allows it again after cancelling', async () => {
    const sup = await demoSupplier();
    const body = { supplierId: sup, supplierBillNo: 'A-55', lines: [{ productId: sku('BW-20'), entry: { KG: '50' }, rate: '60' }] };
    const first = await purchase(body);
    const again = await call({ method: 'POST', url: '/api/purchases', payload: { ...body, supplierBillNo: ' a-55 ' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('DUPLICATE');
    expect(again.json().message).toContain(first.docNo);
    await purchase({ ...body, supplierId: await supplier('Other Supplier') }); // another supplier may use the same number
    expect((await call({ method: 'POST', url: `/api/purchases/${first.id}/cancel`, payload: { reason: 'Wrong rate' } })).statusCode).toBe(200);
    await purchase(body);
    expect((await call({ method: 'POST', url: '/api/purchases', payload: { ...body, supplierBillNo: '' } })).json().error).toBe('NO_BILL_NO');
  });

  it('refuses a customer as supplier, a future date and payment above the total', async () => {
    const cust = (await json(call('/api/parties'))).find((p: Any) => p.name_en === 'Sample Builders').id;
    const line = [{ productId: sku('BW-20'), entry: { KG: '10' }, rate: '60' }];
    expect((await call({ method: 'POST', url: '/api/purchases', payload: { supplierId: cust, supplierBillNo: '1', lines: line } })).json().error).toBe('NOT_SUPPLIER');
    const sup = await demoSupplier();
    expect((await call({ method: 'POST', url: '/api/purchases', payload: { supplierId: sup, supplierBillNo: '1', date: addDays(today, 2), lines: line } })).json().error).toBe('FUTURE_DATE');
    expect((await call({ method: 'POST', url: '/api/purchases', payload: { supplierId: sup, supplierBillNo: '1', lines: line, payment: { mode: 'cash', amount: '100000' } } })).json().error).toBe('OVERPAID');
  });
});

describe('supplier payments and payables', () => {
  it('pays part at purchase, then settles oldest bills first, the rest as advance', async () => {
    const sup = await demoSupplier();
    const line = (kg: string) => [{ productId: sku('BW-20'), entry: { KG: kg }, rate: '50', gst: '0' }];
    const old = await purchase({ supplierId: sup, supplierBillNo: 'OLD', date: addDays(today, -40), lines: line('100') }); // ₹5,000, overdue
    const recent = await purchase({ supplierId: sup, supplierBillNo: 'NEW', lines: line('200'), payment: { mode: 'upi', amount: '1000' } }); // ₹10,000, ₹1,000 paid
    expect(recent.paymentNo).toMatch(/^PY\//);
    expect(await balance(sup)).toBe(-1_400_000);

    const pv = await json(call({ method: 'POST', url: '/api/supplier-payments/preview', payload: { supplierId: sup, amount: '6000', mode: 'cash' } }));
    expect(pv.allocations.map((a: Any) => [a.docNo, a.amountPaise])).toEqual([[old.docNo, 500_000], [recent.docNo, 100_000]]);
    expect(pv.advancePaise).toBe(0);

    const pay = await json(call({ method: 'POST', url: '/api/supplier-payments', payload: { supplierId: sup, amount: '20000', mode: 'bank', reference: 'UTR123' } }));
    expect(pay.allocations.map((a: Any) => a.amountPaise)).toEqual([500_000, 900_000]);
    expect(pay.advancePaise).toBe(600_000);
    expect(await balance(sup)).toBe(600_000); // advance: the supplier now owes us goods
    expect(await acc('BANK', pay.id)).toBe(-2_000_000);
    expect((await json(call(`/api/purchases/${old.id}`))).doc.due_paise).toBe(0);

    // explicit allocation that is too large is refused
    const third = await purchase({ supplierId: sup, supplierBillNo: 'THIRD', lines: line('10') });
    const bad = await call({ method: 'POST', url: '/api/supplier-payments', payload: { supplierId: sup, amount: '600', mode: 'cash', allocations: [{ purchaseId: third.id, amount: '600' }] } });
    expect(bad.json().error).toBe('BAD_ALLOCATION');

    // cancelling a payment brings the dues back
    const list = await json(call('/api/supplier-payments'));
    expect(list.rows).toHaveLength(2);
    expect((await call({ method: 'POST', url: `/api/supplier-payments/${pay.id}/cancel`, payload: { reason: 'Bounced' } })).statusCode).toBe(200);
    expect((await json(call(`/api/purchases/${old.id}`))).doc.due_paise).toBe(500_000);
    expect(await balance(sup)).toBe(-1_450_000);
    const audit = await one<{ reason: string }>(db, "SELECT reason FROM audit_log WHERE entity = 'money_docs' AND action = 'cancel'");
    expect(audit!.reason).toBe('Bounced');
    await expectBalanced();
  });

  it('lists what we owe, bill by bill, with overdue and due in the next 7 days', async () => {
    const sup = await demoSupplier(); // 15 credit days
    const line = [{ productId: sku('BW-20'), entry: { KG: '100' }, rate: '50', gst: '0' }]; // ₹5,000 each
    await purchase({ supplierId: sup, supplierBillNo: 'P1', date: addDays(today, -40), lines: line }); // due 25 days ago
    await purchase({ supplierId: sup, supplierBillNo: 'P2', date: addDays(today, -10), lines: line }); // due in 5 days
    await purchase({ supplierId: sup, supplierBillNo: 'P3', date: today, lines: line }); // due in 15 days
    const p = await json(call('/api/payables'));
    const s = p.suppliers.find((x: Any) => x.id === sup);
    expect(s.owedPaise).toBe(1_500_000);
    expect(s.bills.map((x: Any) => [x.supplier_bill_no, x.state])).toEqual([['P1', 'overdue'], ['P2', 'soon'], ['P3', 'later']]);
    expect(s.bills[0].overdueDays).toBe(25);
    expect(s.overduePaise).toBe(500_000);
    expect(s.dueSoonPaise).toBe(500_000);
    expect(p.totals).toMatchObject({ owedPaise: 1_500_000, overduePaise: 500_000, dueSoonPaise: 500_000 });
    expect(p.suppliers.some((x: Any) => x.name_en === 'Sample Builders')).toBe(false);
  });
});

describe('purchase returns and cancellation', () => {
  it('returns part of a line at its landed cost, never more than remains', async () => {
    const sup = await supplier('Return Steels', '33AAACT1111A1Z1');
    const saved = await purchase({
      supplierId: sup, supplierBillNo: 'R-1',
      lines: [{ productId: sku('TMT-12'), entry: { KG: '1000' }, rate: '50' }], charges: [{ description: 'Freight', amount: '1000', gst: '18' }],
    });
    const doc = await json(call(`/api/purchases/${saved.id}`));
    const line = doc.lines.find((l: Any) => l.product_id);
    expect(line.landed_cost_paise).toBe(5_100_000); // ITC claimed, so freight's GST is not cost
    const before = await stock(sku('TMT-12'));
    const avgBefore = await avg(sku('TMT-12'));

    const dn = await call({ method: 'POST', url: `/api/purchases/${saved.id}/return`, payload: { reason: 'Rusted rods', lines: [{ lineId: line.id, qty: '300' }] } });
    expect(dn.statusCode, dn.body).toBe(201);
    const d1 = dn.json();
    expect(d1.docNo).toMatch(/^DN\//);
    expect(d1.total).toBe(1_770_000); // ₹15,000 + 18%
    expect(await stock(sku('TMT-12'))).toBe(before - 300_000);
    const mv = await one<{ value_paise: number }>(db, "SELECT value_paise FROM stock_moves WHERE source_type = 'DN' AND source_id = ?", [d1.id]);
    expect(Number(mv!.value_paise)).toBe(-1_530_000); // 30% of the landed ₹51,000
    expect(await avg(sku('TMT-12'))).toBe(avgBefore);
    expect(await acc('PURCHASES', d1.id)).toBe(-1_500_000);
    expect(await acc('IN_CGST', d1.id)).toBe(-135_000);
    expect(await balance(sup)).toBe(-(6_018_000 - 1_770_000));

    const tooMuch = await call({ method: 'POST', url: `/api/purchases/${saved.id}/return`, payload: { reason: 'x', lines: [{ lineId: line.id, qty: '701' }] } });
    expect(tooMuch.json().error).toBe('TOO_MUCH');
    expect((await call({ method: 'POST', url: `/api/purchases/${saved.id}/return`, payload: { lines: [{ lineId: line.id, qty: '1' }] } })).json().error).toBe('NO_REASON');
    await call({ method: 'POST', url: `/api/purchases/${saved.id}/return`, payload: { reason: 'Rest', lines: [{ lineId: line.id, qty: '700' }] } });
    const after = await json(call(`/api/purchases/${saved.id}`));
    expect(after.lines.find((l: Any) => l.id === line.id).remaining_milli).toBe(0);
    expect(after.returns).toHaveLength(2);
    const dnTaxable = await one<{ t: number }>(db, "SELECT SUM(taxable_paise) t FROM purchase_docs WHERE doc_type = 'DN'");
    expect(Number(dnTaxable!.t)).toBe(5_000_000); // parts add up exactly to the line
    // the purchase can't be cancelled while debit notes stand
    expect((await call({ method: 'POST', url: `/api/purchases/${saved.id}/cancel`, payload: { reason: 'x' } })).json().error).toBe('HAS_RETURNS');
    await expectBalanced();
  });

  it('cancels a purchase: stock and ledger reversed, payment becomes an advance, warns before stock goes below zero', async () => {
    const sup = await demoSupplier();
    const bw = sku('BW-20'); // 300 kg opening
    const saved = await purchase({ supplierId: sup, supplierBillNo: 'C-1', lines: [{ productId: bw, entry: { KG: '100' }, rate: '60', gst: '0' }], payment: { mode: 'cash', amount: '2000' } });
    expect(await stock(bw)).toBe(400_000);
    await call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'scrap', lines: [{ productId: bw, change: '-350' }] } });

    const warn = await call({ method: 'POST', url: `/api/purchases/${saved.id}/cancel`, payload: { reason: 'Entered twice' } });
    expect(warn.statusCode).toBe(409);
    expect(warn.json().warnings[0].code).toBe('LOW_STOCK');
    expect((await call({ method: 'POST', url: `/api/purchases/${saved.id}/cancel`, payload: {} })).json().error).toBe('NO_REASON');
    const ok = await call({ method: 'POST', url: `/api/purchases/${saved.id}/cancel`, payload: { reason: 'Entered twice', confirmWarnings: true } });
    expect(ok.statusCode).toBe(200);

    expect(await stock(bw)).toBe(-50_000);
    expect(await acc('PURCHASES', saved.id)).toBe(0);
    expect(await balance(sup)).toBe(200_000); // the ₹2,000 paid is now an advance with the supplier
    const doc = (await json(call(`/api/purchases/${saved.id}`))).doc;
    expect(doc).toMatchObject({ status: 'cancelled', cancel_reason: 'Entered twice' });
    expect((await call({ method: 'POST', url: `/api/purchases/${saved.id}/cancel`, payload: { reason: 'again' } })).json().error).toBe('ALREADY_CANCELLED');
    const list = await json(call('/api/purchases'));
    expect(list.rows[0]).toMatchObject({ status: 'cancelled', due_paise: 0 });
    await expectBalanced();
  });
});

describe('expenses', () => {
  it('seeds the usual expense heads once, in English and Tamil', async () => {
    const heads = await json(call('/api/expense-heads'));
    expect(heads).toHaveLength(9);
    expect(heads.find((h: Any) => h.name_en === 'Rent').name_ta).toBe('வாடகை');
    expect(await json(call('/api/expense-heads'))).toHaveLength(9);
    expect((await call({ method: 'POST', url: '/api/expense-heads', payload: { name_en: 'rent' } })).json().error).toBe('DUPLICATE');
    const r = await call({ method: 'POST', url: '/api/expense-heads', payload: { name_en: 'Tea / snacks', name_ta: 'டீ / சிற்றுண்டி' } });
    expect(r.statusCode).toBe(201);
    expect((await call({ method: 'PUT', url: `/api/expense-heads/${r.json().id}`, payload: { name_en: 'Tea and snacks', name_ta: 'டீ' } })).statusCode).toBe(200);
    expect(await json(call('/api/expense-heads'))).toHaveLength(10);
  });

  it('records expenses with and without input tax, and on credit to a party', async () => {
    const heads = await json(call('/api/expense-heads'));
    const head = (n: string) => heads.find((h: Any) => h.name_en === n).id;

    const gst = await json(call({ method: 'POST', url: '/api/expenses', payload: { headId: head('Shop maintenance'), amount: '1000', gst: '18', vendorGstin: '33AAACV1111A1Z1', mode: 'cash', notes: 'Shutter repair' } }));
    expect(gst.docNo).toMatch(/^EX\//);
    expect(gst.itc).toBe(true);
    expect(await acc(`EXP:${head('Shop maintenance')}`, gst.id)).toBe(100_000);
    expect(await acc('IN_CGST', gst.id)).toBe(9_000);
    expect(await acc('CASH', gst.id)).toBe(-118_000);

    const noGstin = await json(call({ method: 'POST', url: '/api/expenses', payload: { headId: head('Shop maintenance'), amount: '1000', gst: '18', mode: 'upi' } }));
    expect(noGstin.itc).toBe(false);
    expect(await acc(`EXP:${head('Shop maintenance')}`, noGstin.id)).toBe(118_000);
    expect((await call({ method: 'POST', url: '/api/expenses', payload: { headId: head('Rent'), amount: '1000', gst: '18', mode: 'upi', itcEligible: true } })).json().error).toBe('NO_ITC');

    const rent = await json(call({ method: 'POST', url: '/api/expenses', payload: { headId: head('Rent'), amount: '15000', mode: 'bank' } }));
    expect(rent.total).toBe(1_500_000);

    expect((await call({ method: 'POST', url: '/api/expenses', payload: { headId: head('Loading / unloading'), amount: '800', mode: 'credit' } })).json().error).toBe('NO_PARTY');
    const lorry = await supplier('Murugan Lorry Service');
    const credit = await json(call({ method: 'POST', url: '/api/expenses', payload: { headId: head('Loading / unloading'), amount: '800', mode: 'credit', partyId: lorry } }));
    expect(await balance(lorry)).toBe(-80_000);
    const pay = await call({ method: 'POST', url: '/api/supplier-payments', payload: { supplierId: lorry, amount: '800', mode: 'cash' } });
    expect(pay.json().advancePaise).toBe(80_000); // not a purchase bill, so nothing to allocate
    expect(await balance(lorry)).toBe(0);

    const list = await json(call('/api/expenses'));
    expect(list.rows).toHaveLength(4);
    expect(list.totalPaise).toBe(118_000 + 118_000 + 1_500_000 + 80_000);
    expect(list.costPaise).toBe(100_000 + 118_000 + 1_500_000 + 80_000);
    expect(list.byHead[0]).toMatchObject({ name_en: 'Rent', totalPaise: 1_500_000, count: 1 });
    expect(list.byHead.find((h: Any) => h.name_en === 'Shop maintenance')).toMatchObject({ count: 2, itcPaise: 18_000 });

    expect((await call({ method: 'POST', url: `/api/expenses/${credit.id}/cancel`, payload: { reason: 'Wrong head' } })).statusCode).toBe(200);
    expect(await balance(lorry)).toBe(80_000);
    expect((await json(call('/api/expenses'))).totalPaise).toBe(118_000 + 118_000 + 1_500_000);
    await expectBalanced();
  });
});

describe('stock corrections and the item stock ledger', () => {
  it('corrects by a signed change in any unit, valued at average cost', async () => {
    const t12 = sku('TMT-12');
    const cost = await avg(t12); // ₹55.50
    expect(cost).toBe(5550);
    const r = await json(call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'damage', notes: 'Rusted', lines: [{ productId: t12, change: { ROD: '-2' } }] } }));
    expect(r.docNo).toMatch(/^AD\//);
    expect(r.lines[0].changeMilli).toBe(-21_334);
    expect(r.valuePaise).toBe(roundDiv(-21_334 * 5550, 1000));
    expect(await stock(t12)).toBe(3_000_000 - 21_334);

    const bw = sku('BW-20');
    const up = await json(call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'weight_diff', lines: [{ productId: bw, change: '5' }] } }));
    expect(up.valuePaise).toBe(5 * 6800);
    expect(await avg(bw)).toBe(6800); // a gain at average cost leaves the average unchanged
    expect((await call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'other', lines: [{ productId: bw, change: '1' }] } })).json().error).toBe('NO_NOTES');
    expect((await call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'opening', lines: [{ productId: bw, change: '1' }] } })).statusCode).toBe(400);
    expect((await call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'count', lines: [{ productId: sku('SRV-TRANS'), change: '1' }] } })).json().error).toBe('NO_STOCK');
    const adj = await one<{ approved_by: string }>(db, "SELECT approved_by FROM stock_adjustments WHERE reason = 'damage'");
    const owner = await one<{ id: string }>(db, "SELECT id FROM users WHERE role = 'owner'");
    expect(adj!.approved_by).toBe(owner!.id);
  });

  it('corrects by physical count: the system works out the difference', async () => {
    const t10 = sku('TMT-10'); // 2000 kg @ ₹56.50
    const r = await json(call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'count', lines: [{ productId: t10, counted: '1990' }, { productId: sku('TMT-08'), counted: '1500' }] } }));
    expect(r.lines).toHaveLength(1); // TMT-08 already matches
    expect(r.lines[0]).toMatchObject({ changeMilli: -10_000, valuePaise: -56_500 });
    expect(await stock(t10)).toBe(1_990_000);
    const line = await one<{ system_milli: number; counted_milli: number }>(db, 'SELECT system_milli, counted_milli FROM stock_adjustment_lines WHERE product_id = ? AND counted_milli IS NOT NULL', [t10]);
    expect(line).toMatchObject({ system_milli: 2_000_000, counted_milli: 1_990_000 });
    expect((await call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'count', lines: [{ productId: t10, counted: '1990' }] } })).json().error).toBe('NO_CHANGE');
    const list = await json(call('/api/stock/adjustments'));
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].lines[0]).toMatchObject({ sku: 'TMT-10', qty_milli: -10_000 });
  });

  it('shows the item stock ledger with a running balance, and the total stock value', async () => {
    const t12 = sku('TMT-12');
    const sup = await supplier('Ledger Steels', '33AAACL1111A1Z1');
    const p = await purchase({ supplierId: sup, supplierBillNo: 'L1', lines: [{ productId: t12, entry: { KG: '1000' }, rate: '50' }] });
    const walkIn = (await json(call('/api/parties'))).find((x: Any) => x.is_walk_in).id;
    const bill = await call({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn, lines: [{ productId: t12, entry: { KG: '500' } }] } });
    expect(bill.statusCode, bill.body).toBe(201);
    await call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'scrap', lines: [{ productId: t12, change: '-12.5' }] } });

    const led = await json(call(`/api/stock/${t12}/ledger`));
    expect(led.rows.map((r: Any) => r.type)).toEqual(['OPENING', 'PUR', 'INV', 'ADJ']);
    expect(led.rows.map((r: Any) => r.balanceMilli)).toEqual([3_000_000, 4_000_000, 3_500_000, 3_487_500]);
    expect(led.rows[1]).toMatchObject({ docNo: p.docNo, inMilli: 1_000_000, outMilli: 0, valuePaise: 5_000_000, partyEn: 'Ledger Steels' });
    expect(led.rows[2].outMilli).toBe(500_000);
    expect(led.rows[2].valuePaise).toBeLessThan(0); // cost of goods sold
    expect(led.closingMilli).toBe(await stock(t12));

    const v = await json(call('/api/stock/valuation'));
    const item = v.items.find((i: Any) => i.product_id === t12);
    expect(item.value_paise).toBe(roundDiv(3_487_500 * item.avg_cost_paise, 1000));
    expect(v.totalPaise).toBe(v.items.reduce((a: number, i: Any) => a + i.value_paise, 0));
    await expectBalanced();
  });
});

describe('who can do what', () => {
  it('refuses every purchase, payment, expense and stock write for billing staff, but lets them read', async () => {
    const u = await json(call({ method: 'POST', url: '/api/users', payload: { name: 'Counter', role: 'billing', pin: '2468' } }));
    const t = (await json(b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin: '2468' } }))).token;
    const staff = callAs(b.app, t);
    await staff({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: '2468', newPin: '5937' } });
    const sup = await demoSupplier();
    const p = await purchase({ supplierId: sup, supplierBillNo: 'X', lines: [{ productId: sku('BW-20'), entry: { KG: '1' }, rate: '1' }] });
    const writes: Array<[string, string]> = [
      ['POST', '/api/purchases/preview'], ['POST', '/api/purchases'], [`POST`, `/api/purchases/${p.id}/cancel`], ['POST', `/api/purchases/${p.id}/return`],
      ['POST', '/api/supplier-payments/preview'], ['POST', '/api/supplier-payments'], ['POST', '/api/supplier-payments/x/cancel'],
      ['POST', '/api/expense-heads'], ['PUT', '/api/expense-heads/x'], ['POST', '/api/expenses/preview'], ['POST', '/api/expenses'], ['POST', '/api/expenses/x/cancel'],
      ['POST', '/api/stock/adjustments'],
    ];
    for (const [method, url] of writes) expect((await staff({ method: method as 'POST', url, payload: {} })).statusCode, url).toBe(403);
    for (const url of ['/api/purchases', '/api/payables', '/api/expenses', '/api/expense-heads', '/api/stock/adjustments', '/api/stock/valuation', `/api/stock/${sku('BW-20')}/ledger`]) {
      expect((await staff(url)).statusCode, url).toBe(200);
    }
    expect(await all(db, "SELECT id FROM purchase_docs WHERE status = 'cancelled'")).toHaveLength(0);
  });
});

describe('supplier payments vs customer refunds', () => {
  it('keeps customer refunds out of the supplier payment list and its cancel', async () => {
    const { bootSignedIn } = await import('./helpers');
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const walkIn = (await b.call('/api/parties')).json().find((p: { is_walk_in: number }) => p.is_walk_in);
    const wire = (await b.call('/api/catalog')).json().find((p: { sku: string }) => p.sku === 'BW-20');
    const bill = (await b.call({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn.id, lines: [{ productId: wire.id, entry: { KG: '10' } }], payment: { mode: 'cash', amount: '885' } } })).json();
    const line = (await b.call(`/api/bills/${bill.id}/returnable`)).json();
    const lines = (line.lines ?? line).map((l: { lineId?: string; id?: string }) => ({ lineId: l.lineId ?? l.id, qty: '2' }));
    const ret = await b.call({ method: 'POST', url: `/api/bills/${bill.id}/return`, payload: { lines, reason: 'damaged', refund: { mode: 'cash', amount: '100' } } });
    expect(ret.statusCode).toBe(201);
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const list = (await b.call(`/api/supplier-payments?from=2000-01-01&to=${today}`)).json();
    expect(list.rows).toHaveLength(0);
    const refund = (await b.db.execute("SELECT id FROM money_docs WHERE doc_type = 'PAY'")).rows[0]!;
    const cancel = await b.call({ method: 'POST', url: `/api/supplier-payments/${refund.id}/cancel`, payload: { reason: 'x' } });
    expect(cancel.statusCode).toBe(404);
  });
});
