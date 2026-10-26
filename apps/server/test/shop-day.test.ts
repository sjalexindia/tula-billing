/**
 * A whole working day at a building-materials shop, through the API, the way the screens use it.
 * Checks that every module agrees with every other: stock, ledger, outstanding, statement, reports.
 */
import { one } from '@tula/db';
import { describe, expect, it } from 'vitest';
import { bootSignedIn, callAs, type Res } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (p: Promise<Res>): Promise<any> => {
  const r = await p;
  if (r.statusCode >= 400) throw new Error(`${r.statusCode} ${r.body}`);
  return r.json();
};

describe('a full shop day', () => {
  it('purchases, bills, a return, receipts, expenses, a stock count and the reports all agree', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const call = b.call;
    const today = (await j(call('/api/health'))).today as string;
    const catalog = await j(call('/api/catalog'));
    const item = (sku: string) => catalog.find((p: { sku: string }) => p.sku === sku);
    const parties = await j(call('/api/parties'));
    const builder = parties.find((p: { name_en: string }) => p.name_en === 'Sample Builders');
    const walkIn = parties.find((p: { is_walk_in: number }) => p.is_walk_in);
    const supplier = parties.find((p: { party_type: string }) => p.party_type === 'supplier');

    // Morning: today's TMT rate, and a counter user for the day
    await j(call({ method: 'PUT', url: '/api/rates/TMT', payload: { rate: '61.50' } }));
    const kumar = await j(call({ method: 'POST', url: '/api/users', payload: { name: 'Kumar', role: 'billing', pin: '2468' } }));
    const kt = (await j(b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: kumar.id, pin: '2468' } }))).token;
    const counter = callAs(b.app, kt);
    await j(counter({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: '2468', newPin: '5937' } }));

    // A lorry of 12 mm arrives: 5 t by mill weight, freight on the bill, part paid
    const pur = await j(call({ method: 'POST', url: '/api/purchases', payload: {
      supplierId: supplier.id, supplierBillNo: 'MILL-771',
      lines: [{ productId: item('TMT-12').id, entry: { KG: '5000' }, rate: '56' }],
      charges: [{ description: 'Freight', amount: '4000', gst: '18' }],
      payment: { mode: 'bank', amount: '100000' },
    } }));
    expect(pur.docNo ?? pur.doc_no).toBeTruthy();

    // Counter bills: a credit bill to the builder, a cash bill to a walk-in
    const credit = await j(counter({ method: 'POST', url: '/api/bills', payload: {
      partyId: builder.id, site: 'Plot 12', confirmWarnings: true,
      lines: [{ productId: item('TMT-12').id, entry: { BDL: '20' } }, { productId: item('CEM-OPC53').id, entry: { BAG: '40' } }, { productId: item('SRV-TRANS').id, entry: { NOS: '1' }, rate: '800' }],
    } }));
    const cash = await j(counter({ method: 'POST', url: '/api/bills', payload: {
      partyId: walkIn.id, lines: [{ productId: item('BW-20').id, entry: { KG: '12' } }], payment: { mode: 'cash', amount: '1062' },
    } }));
    expect(credit.saved && cash.saved).toBe(true);

    // The builder sends 2 bags back; owner makes a credit note
    const returnable = await j(call(`/api/bills/${credit.id}/returnable`));
    const cementLine = (returnable.lines ?? returnable).find((l: { lineNo: number }) => l.lineNo === 2);
    expect(cementLine.returnableMilli).toBe(40_000);
    const cn = await j(call({ method: 'POST', url: `/api/bills/${credit.id}/return`, payload: { lines: [{ lineId: cementLine.lineId, qty: '2' }], reason: 'Damaged bags' } }));
    expect(cn.docNo ?? cn.doc_no).toMatch(/^CN\//);

    // Counter staff take part payment from the builder
    const rc = await j(counter({ method: 'POST', url: '/api/receipts', payload: { partyId: builder.id, amount: '30000', mode: 'upi', reference: 'UPI-1' } }));
    expect(rc.docNo ?? rc.doc_no).toMatch(/^RC\//);

    // Owner: unloading expense, and an evening count of 32 mm finds 6 kg short
    const heads = await j(call('/api/expense-heads'));
    const unload = (heads.rows ?? heads).find((h: { name_en: string }) => /unload/i.test(h.name_en));
    await j(call({ method: 'POST', url: '/api/expenses', payload: { headId: unload.id, amount: '1500', mode: 'cash', notes: 'Unloading MILL-771' } }));
    await j(call({ method: 'POST', url: '/api/stock/adjustments', payload: { reason: 'count', lines: [{ productId: item('TMT-32').id, counted: '294' }] } }));

    // ---- Everything must agree ----
    const tb = await one<{ dr: number; cr: number }>(b.db, 'SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM ledger_entries WHERE deleted = 0');
    expect(Number(tb!.dr)).toBe(Number(tb!.cr));

    // Stock: 3000 opening + 5000 bought − 20 bundles sold of 12 mm
    const stock = await j(call('/api/catalog'));
    const tmt12 = stock.find((p: { sku: string }) => p.sku === 'TMT-12');
    const bundle = tmt12.units.find((u: { code: string }) => u.code === 'BDL').factorMilli;
    expect(tmt12.stockMilli).toBe(3_000_000 + 5_000_000 - 20 * bundle);
    expect(stock.find((p: { sku: string }) => p.sku === 'CEM-OPC53').stockMilli).toBe(200_000 - 40_000 + 2_000);
    expect(stock.find((p: { sku: string }) => p.sku === 'TMT-32').stockMilli).toBe(294_000);

    // The builder's outstanding equals opening + bill − credit note − receipt, and the statement agrees
    const billDoc = (await j(call(`/api/bills/${credit.id}`))).doc;
    const cnTotal = Number((await one<{ t: number }>(b.db, "SELECT total_paise t FROM sales_docs WHERE doc_type = 'CN'"))!.t);
    const expected = 2_500_000 + billDoc.total_paise - cnTotal - 3_000_000;
    const out = await j(call('/api/outstanding'));
    const row = out.rows.find((r: { partyId: string }) => r.partyId === builder.id);
    expect(row.balancePaise).toBe(expected);
    const st = await j(call(`/api/parties/${builder.id}/statement?from=${today.slice(0, 8)}01&to=${today}`));
    expect(st.closingPaise).toBe(expected);

    // Reports: sales register net of the credit note; P&L gross profit = sales − cost
    const reg = await j(call(`/api/reports/sales-register?from=${today}&to=${today}`));
    const regTaxable = reg.tables[0].totals.taxable;
    const sales = await one<{ t: number }>(b.db, "SELECT SUM(CASE WHEN doc_type = 'CN' THEN -taxable_paise ELSE taxable_paise END) t FROM sales_docs WHERE status = 'active' AND deleted = 0 AND doc_date = ?", [today]);
    expect(regTaxable).toBe(Number(sales!.t));
    const pl = await j(call(`/api/reports/profit-loss?from=${today}&to=${today}`));
    expect(JSON.stringify(pl)).toContain(String(Number(sales!.t)));
    const g1 = await call(`/api/reports/gstr1?month=${today.slice(0, 7)}`);
    expect(g1.statusCode).toBe(200);
    const xlsx = await call(`/api/reports/gstr1?month=${today.slice(0, 7)}&format=xlsx`);
    expect(xlsx.headers['content-type']).toContain('spreadsheet');

    // Counter staff can't see reports or touch purchases
    expect((await counter('/api/reports/profit-loss')).statusCode).toBe(403);
    expect((await counter({ method: 'POST', url: '/api/purchases', payload: {} })).statusCode).toBe(403);

    // Every change is queued for the cloud copy
    const pending = await one<{ n: number }>(b.db, 'SELECT COUNT(*) n FROM sync_outbox');
    expect(Number(pending!.n)).toBeGreaterThan(50);
  });
});
