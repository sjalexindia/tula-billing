import { insert, one, openDb, type Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { setup } from '../src/setup';

let db: Db;
let app: FastifyInstance;
type Item = { id: string; sku: string; ratePaise: number; stockMilli: number | null; units: Array<{ code: string; factorMilli: number }> };
let catalog: Item[];
let parties: Array<{ id: string; name_en: string; balance_paise: number; is_walk_in: number }>;
const sku = (s: string) => catalog.find((p) => p.sku === s)!;
const walkIn = () => parties.find((p) => p.is_walk_in)!;
const builder = () => parties.find((p) => p.name_en === 'Sample Builders')!;

async function boot(opts: Parameters<typeof setup>[1]) {
  db = await openDb(':memory:');
  await setup(db, opts);
  app = await buildApp(db);
  catalog = (await app.inject('/api/catalog')).json();
  parties = (await app.inject('/api/parties')).json();
}

describe('bills (building-materials preset with demo data)', () => {
  beforeEach(() => boot({ preset: 'building-materials', demo: true }));

  it('prices steel from bundles + rods at the daily rate plus size extra', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/bills/preview',
      payload: { partyId: walkIn().id, lines: [{ productId: sku('TMT-12').id, entry: { BDL: '10', ROD: '4' } }, { productId: sku('TMT-08').id, entry: { KG: '47.35' } }] },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.lines[0].baseQtyMilli).toBe(10 * 53335 + 4 * 10667);
    expect(b.lines[0].ratePaise).toBe(6000);
    expect(b.lines[1].ratePaise).toBe(6300);
    expect(b.supply).toBe('intra'); // walk-in customer is billed in the business's own state
    expect(b.lang).toBe('ta'); // business default invoice language from settings
    expect(b.totals.total % 100).toBe(0);
  });

  it('saves a bill: number, stock, ledger and receipt all line up', async () => {
    const before = sku('TMT-12').stockMilli!;
    const res = await app.inject({
      method: 'POST', url: '/api/bills',
      payload: {
        partyId: walkIn().id,
        lines: [{ productId: sku('TMT-12').id, entry: { BDL: '10' } }, { productId: sku('SRV-TRANS').id, entry: { NOS: '1' }, rate: '800' }],
        payment: { mode: 'upi', amount: '10000' },
      },
    });
    expect(res.statusCode).toBe(201);
    const saved = res.json();
    expect(saved.docNo).toMatch(/^DT\/\d{2}-\d{2}\/0001$/); // prefix comes from settings
    expect(saved.receiptNo).toMatch(/^RC\//);

    const bill = (await app.inject(`/api/bills/${saved.id}`)).json();
    expect(bill.doc.party_name).toBe('நேரடி வாடிக்கையாளர்');
    expect(bill.doc.doc_kind).toBe('tax_invoice');
    expect(bill.lines).toHaveLength(2);
    expect(bill.paidPaise).toBe(1_000_000);
    expect(bill.lines[0].cost_per_base_paise).toBe(5550);
    expect(bill.units.find((u: { code: string }) => u.code === 'BDL').name_ta).toBe('கட்டு');

    const after = (await app.inject('/api/catalog')).json().find((p: Item) => p.sku === 'TMT-12').stockMilli;
    expect(before - after).toBe(10 * 53335);

    const tb = await one<{ dr: number; cr: number }>(db, 'SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM ledger_entries');
    expect(tb!.dr).toBe(tb!.cr);
    const w = (await app.inject('/api/parties')).json().find((p: { is_walk_in: number }) => p.is_walk_in);
    expect(w.balance_paise).toBe(saved.total - 1_000_000);

    const second = (await app.inject({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn().id, lines: [{ productId: sku('BW-20').id, entry: { KG: '5' } }] } })).json();
    expect(second.docNo).toMatch(/0002$/);
    const outbox = await one<{ n: number }>(db, 'SELECT COUNT(*) n FROM sync_outbox');
    expect(Number(outbox!.n)).toBeGreaterThan(10);
  });

  it('holds the bill for confirmation when it breaks the credit limit or stock', async () => {
    const payload = { partyId: builder().id, lines: [{ productId: sku('TMT-32').id, entry: { KG: '5000' } }] };
    const held = await app.inject({ method: 'POST', url: '/api/bills', payload });
    expect(held.statusCode).toBe(409);
    expect(held.json().warnings.map((w: { code: string }) => w.code).sort()).toEqual(['CREDIT_LIMIT', 'LOW_STOCK']);
    expect(Number((await one<{ n: number }>(db, 'SELECT COUNT(*) n FROM sales_docs'))!.n)).toBe(0);
    const ok = await app.inject({ method: 'POST', url: '/api/bills', payload: { ...payload, confirmWarnings: true } });
    expect(ok.statusCode).toBe(201);
  });

  it('refuses outright when stock check is set to block', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'billing.stock_check': 'block' } });
    const res = await app.inject({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn().id, confirmWarnings: true, lines: [{ productId: sku('TMT-32').id, entry: { KG: '5000' } }] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().blocked).toBe(true);
  });

  it('charges IGST for an out-of-state customer', async () => {
    const dev = (await one<{ value: string }>(db, "SELECT value FROM sync_state WHERE key='device_id'"))!.value;
    const kerala = await insert(db, 'parties', dev, { party_type: 'customer', name_en: 'Kochi Builders', gstin: '32ABCDE1234F1Z5', state_code: '32' });
    const res = await app.inject({ method: 'POST', url: '/api/bills/preview', payload: { partyId: kerala, lines: [{ productId: sku('TMT-16').id, entry: { KG: '1000' } }] } });
    expect(res.json().supply).toBe('inter');
    expect(res.json().totals.cgst).toBe(0);
    expect(res.json().totals.igst).toBe(1_080_000);
  });

  it('issues a bill of supply without GST for a composition dealer', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'gst.scheme': 'composition' } });
    const res = await app.inject({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn().id, lines: [{ productId: sku('BW-20').id, entry: { KG: '10' } }] } });
    const bill = (await app.inject(`/api/bills/${res.json().id}`)).json();
    expect(bill.doc.doc_kind).toBe('bill_of_supply');
    expect(bill.doc.cgst_paise + bill.doc.sgst_paise + bill.doc.igst_paise).toBe(0);
    expect(bill.doc.total_paise).toBe(75000);
  });

  it('rejects bad input with clear messages', async () => {
    const noQty = await app.inject({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn().id, lines: [{ productId: sku('TMT-12').id, entry: { BDL: '0' } }] } });
    expect(noQty.statusCode).toBe(400);
    expect(noQty.json().message).toMatch(/quantity/i);
    const badRate = await app.inject({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn().id, lines: [{ productId: sku('TMT-12').id, entry: { KG: '1' }, rate: '6O' }] } });
    expect(badRate.statusCode).toBe(400);
    const overpay = await app.inject({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn().id, lines: [{ productId: sku('BW-20').id, entry: { KG: '1' } }], payment: { mode: 'cash', amount: '1000' } } });
    expect(overpay.statusCode).toBe(400);
  });

  it('updates a daily rate and reprices every product in the group', async () => {
    const rates = (await app.inject('/api/rates')).json();
    expect(rates).toEqual([expect.objectContaining({ code: 'TMT', rate_paise: 6000, unit_code: 'KG' })]);
    await app.inject({ method: 'PUT', url: '/api/rates/TMT', payload: { rate: '61.50' } });
    const c = (await app.inject('/api/catalog')).json();
    expect(c.find((p: Item) => p.sku === 'TMT-12').ratePaise).toBe(6150);
    expect(c.find((p: Item) => p.sku === 'TMT-08').ratePaise).toBe(6450);
    expect((await app.inject({ method: 'PUT', url: '/api/rates/NOPE', payload: { rate: '1' } })).statusCode).toBe(404);
  });

  it('will not change the invoice prefix once invoices exist this year', async () => {
    await app.inject({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn().id, lines: [{ productId: sku('BW-20').id, entry: { KG: '1' } }] } });
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'invoice.prefix': 'NEW' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PREFIX_IN_USE');
  });
});

describe('a fresh business (blank preset, no demo)', () => {
  beforeEach(() => boot({ preset: 'blank' }));

  it('has only a walk-in customer, base units and no products', async () => {
    expect(catalog).toEqual([]);
    expect(parties).toHaveLength(1);
    expect(parties[0]!.is_walk_in).toBe(1);
    expect((await app.inject('/api/rates')).json()).toEqual([]);
  });

  it('blocks billing until the business details are filled in', async () => {
    const s = (await app.inject('/api/settings')).json();
    expect(s.missingForBilling.sort()).toEqual(['business.address', 'business.name_en', 'business.state_code', 'gst.gstin']);
    const res = await app.inject({ method: 'POST', url: '/api/bills/preview', payload: { partyId: walkIn().id, lines: [{ productId: 'x', entry: { NOS: '1' } }] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SETUP_INCOMPLETE');
  });

  it('validates settings and rejects inconsistent ones', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'gst.gstin': 'bad' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { unknown: 'x' } })).statusCode).toBe(400);
    const clash = await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'business.state_code': '29', 'gst.gstin': '33ABCDE1234F1Z5' } });
    expect(clash.json().error).toBe('INCONSISTENT');
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', payload: { 'business.name_en': 'Any Traders', 'business.address': 'Bengaluru', 'business.state_code': '29', 'gst.gstin': '29ABCDE1234F1Z5', 'invoice.prefix': 'at' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().missingForBilling).toEqual([]);
    expect(ok.json().values['invoice.prefix']).toBe('AT');
    const schema = (await app.inject('/api/settings/schema')).json();
    expect(schema.states.length).toBeGreaterThan(30);
  });
});
