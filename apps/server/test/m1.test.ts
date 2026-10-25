import { one } from '@tula/db';
import { describe, expect, it } from 'vitest';
import { bootSignedIn, callAs, type Res } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (p: Promise<Res> | PromiseLike<Res>): Promise<any> => (await p).json();

describe('sign-in and roles', () => {
  it('requires sign-in for everything except the sign-in screen', async () => {
    const { app } = await bootSignedIn({ preset: 'blank' });
    expect((await app.inject('/api/catalog')).statusCode).toBe(401);
    expect((await app.inject('/api/public')).statusCode).toBe(200);
    expect((await app.inject('/api/auth/users')).json()).toHaveLength(1);
  });

  it('forces a new PIN after first sign-in and rejects weak PINs', async () => {
    const { app } = await bootSignedIn({ preset: 'blank' });
    const fresh = await bootSignedIn({ preset: 'blank' }); // has a real PIN; use its app to create a user
    const created = await json(fresh.call({ method: 'POST', url: '/api/users', payload: { name: 'Kumar', role: 'billing', pin: '2468' } }));
    const login = await json(fresh.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: created.id, pin: '2468' } }));
    expect(login.user.mustChangePin).toBe(true);
    const kumar = callAs(fresh.app, login.token);
    expect((await kumar({ method: 'POST', url: '/api/bills/preview', payload: {} })).json().error).toBe('CHANGE_PIN');
    expect((await kumar({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: '2468', newPin: '1111' } })).json().error).toBe('WEAK_PIN');
    expect((await kumar({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: '2468', newPin: '5937' } })).statusCode).toBe(200);
    expect(app).toBeTruthy();
  });

  it('locks a user out after five wrong PINs', async () => {
    const { app } = await bootSignedIn({ preset: 'blank' });
    const owner = (await app.inject('/api/auth/users')).json()[0];
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin: '0000' } })).statusCode).toBe(401);
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin: '4826' } });
    expect(locked.statusCode).toBe(429);
  });

  it('lets billing staff bill and add customers, but not change settings, items or credit terms', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const u = await json(b.call({ method: 'POST', url: '/api/users', payload: { name: 'Counter', role: 'billing', pin: '2468' } }));
    const t = (await json(b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin: '2468' } }))).token;
    const staff = callAs(b.app, t);
    await staff({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: '2468', newPin: '5937' } });

    expect((await staff({ method: 'PUT', url: '/api/settings', payload: { 'billing.stock_check': 'off' } })).statusCode).toBe(403);
    expect((await staff({ method: 'PUT', url: '/api/rates/TMT', payload: { rate: '1' } })).statusCode).toBe(403);
    expect((await staff({ method: 'POST', url: '/api/products', payload: {} })).statusCode).toBe(403);
    const cust = await staff({ method: 'POST', url: '/api/parties', payload: { name_en: 'Raja Builders', mobile: '98765 43210' } });
    expect(cust.statusCode).toBe(201);
    expect((await staff({ method: 'POST', url: '/api/parties', payload: { name_en: 'X', creditLimit: '100000' } })).statusCode).toBe(403);

    const walkIn = (await json(staff('/api/parties'))).find((p: { is_walk_in: number }) => p.is_walk_in);
    const item = (await json(staff('/api/catalog'))).find((p: { sku: string }) => p.sku === 'BW-20');
    const bill = await staff({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn.id, lines: [{ productId: item.id, entry: { KG: '2' } }] } });
    expect(bill.statusCode).toBe(201);
    const doc = await one<{ created_by: string }>(b.db, 'SELECT created_by FROM sales_docs');
    expect(doc!.created_by).toBe(u.id); // bill is recorded against the person who made it
  });

  it('keeps at least one owner', async () => {
    const b = await bootSignedIn({ preset: 'blank' });
    const owner = (await json(b.call('/api/users')))[0];
    expect((await json(b.call({ method: 'PUT', url: `/api/users/${owner.id}`, payload: { role: 'billing' } }))).error).toBe('LAST_OWNER');
  });
});

describe('items', () => {
  it('creates an item with larger units and shows it on the bill catalogue', async () => {
    const b = await bootSignedIn({ preset: 'building-materials' });
    const cats = await json(b.call('/api/categories'));
    const res = await b.call({
      method: 'POST', url: '/api/products', payload: {
        sku: 'tile-60', name_en: 'Vitrified tile 600x600', name_ta: 'விட்ரிஃபைட் டைல் 600x600', categoryId: cats[0].id, hsn: '6907', gst: '18',
        baseUnit: 'SQF', minStock: '200', saleRate: '58', units: [{ unit: 'BOX', factor: '15.5' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const item = (await json(b.call('/api/catalog'))).find((p: { sku: string }) => p.sku === 'TILE-60');
    expect(item.units[0]).toMatchObject({ code: 'BOX', factorMilli: 15500 });
    expect(item.ratePaise).toBe(5800);
  });

  it('validates item details clearly', async () => {
    const b = await bootSignedIn({ preset: 'building-materials' });
    const cats = await json(b.call('/api/categories'));
    const base = { sku: 'X1', name_en: 'X', categoryId: cats[0].id, gst: '18', baseUnit: 'NOS' };
    const msg = async (p: object) => (await json(b.call({ method: 'POST', url: '/api/products', payload: { ...base, ...p } }))).message;
    expect(await msg({ gst: '17' })).toMatch(/GST %/);
    expect(await msg({ hsn: '72' })).toMatch(/HSN/);
    expect(await msg({ sku: 'TMT-12' })).toMatch(/already used/);
    expect(await msg({ units: [{ unit: 'NOS', factor: '2' }] })).toMatch(/base unit/);
    expect(await msg({ rateMode: 'daily', rateGroup: 'NOPE' })).toMatch(/daily-rate group/);
  });

  it('will not change the base unit once an item has stock', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const tmt = (await json(b.call('/api/products'))).find((p: { sku: string }) => p.sku === 'TMT-12');
    const full = await json(b.call(`/api/products/${tmt.id}`));
    const res = await json(b.call({ method: 'PUT', url: `/api/products/${tmt.id}`, payload: {
      sku: full.sku, name_en: full.name_en, categoryId: full.category_id, gst: '18', baseUnit: 'TON', rateMode: 'daily', rateGroup: 'TMT',
    } }));
    expect(res.error).toBe('BASE_UNIT_LOCKED');
  });
});

describe('customers and suppliers', () => {
  it('derives the state from the GSTIN and posts the opening balance', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const id = (await json(b.call({ method: 'POST', url: '/api/parties', payload: {
      name_en: 'Kerala Steels', partyType: 'supplier', gstin: '32aaaaa1111a1z5', openingBalance: '-15000',
    } }))).id;
    const p = await json(b.call(`/api/parties/${id}`));
    expect(p.state_code).toBe('32');
    expect(p.balance_paise).toBe(-1_500_000); // we owe them
    // changing the opening balance replaces it rather than adding to it
    await b.call({ method: 'PUT', url: `/api/parties/${id}`, payload: { name_en: 'Kerala Steels', partyType: 'supplier', gstin: '32AAAAA1111A1Z5', openingBalance: '-12000' } });
    expect((await json(b.call(`/api/parties/${id}`))).balance_paise).toBe(-1_200_000);
    const tb = await one<{ dr: number; cr: number }>(b.db, 'SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM ledger_entries WHERE deleted = 0');
    expect(tb!.dr).toBe(tb!.cr);
  });

  it('rejects a duplicate mobile and a GSTIN from another state than the one picked', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    expect((await json(b.call({ method: 'POST', url: '/api/parties', payload: { name_en: 'A', mobile: '9000000001' } }))).error).toBe('DUPLICATE');
    expect((await json(b.call({ method: 'POST', url: '/api/parties', payload: { name_en: 'B', gstin: '33ABCDE1234F1Z5', stateCode: '29' } }))).error).toBe('STATE_MISMATCH');
    expect((await b.call({ method: 'POST', url: '/api/parties', payload: { name_en: 'C', mobile: '12345' } })).statusCode).toBe(400);
  });

  it('applies party-wise rates on the bill', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const builder = (await json(b.call('/api/parties'))).find((p: { name_en: string }) => p.name_en === 'Sample Builders');
    const items = await json(b.call('/api/catalog'));
    const tmt = items.find((p: { sku: string }) => p.sku === 'TMT-12');
    const cem = items.find((p: { sku: string }) => p.sku === 'CEM-OPC53');
    await b.call({ method: 'PUT', url: `/api/parties/${builder.id}/rates`, payload: { rates: [{ productId: tmt.id, adjust: '-1.50' }, { productId: cem.id, rate: '370' }] } });
    const pv = await json(b.call({ method: 'POST', url: '/api/bills/preview', payload: { partyId: builder.id, lines: [{ productId: tmt.id, entry: { KG: '10' } }, { productId: cem.id, entry: { BAG: '1' } }] } }));
    expect(pv.lines.map((l: { ratePaise: number }) => l.ratePaise)).toEqual([5850, 37000]);
    expect(pv.lines.map((l: { rateSource: string }) => l.rateSource)).toEqual(['party', 'party']);
    expect((await json(b.call(`/api/parties/${builder.id}`))).rates).toHaveLength(2);
    // both a rate and an adjustment for one item is ambiguous
    expect((await b.call({ method: 'PUT', url: `/api/parties/${builder.id}/rates`, payload: { rates: [{ productId: tmt.id, rate: '60', adjust: '1' }] } })).statusCode).toBe(400);
  });
});

describe('opening stock', () => {
  it('sets and corrects opening stock, which feeds stock and average cost', async () => {
    const b = await bootSignedIn({ preset: 'building-materials' });
    const items = await json(b.call('/api/stock/opening'));
    const cem = items.find((p: { sku: string }) => p.sku === 'CEM-OPC53');
    await b.call({ method: 'PUT', url: '/api/stock/opening', payload: { lines: [{ productId: cem.product_id, qty: '120', cost: '335' }] } });
    await b.call({ method: 'PUT', url: '/api/stock/opening', payload: { lines: [{ productId: cem.product_id, qty: '100', cost: '330' }] } }); // correction
    const after = (await json(b.call('/api/stock/opening'))).find((p: { sku: string }) => p.sku === 'CEM-OPC53');
    expect(after).toMatchObject({ qty_milli: 100_000, cost_paise: 33000 });
    const cat = (await json(b.call('/api/catalog'))).find((p: { sku: string }) => p.sku === 'CEM-OPC53');
    expect(cat.stockMilli).toBe(100_000);
    const svc = items.find((p: { sku: string }) => p.sku === 'SRV-TRANS');
    expect(svc).toBeUndefined(); // services don't keep stock
  });
});
