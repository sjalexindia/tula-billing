import { one } from '@tula/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootSignedIn, callAs, type Booted } from './helpers';

/* Recycle bin (UC-33), settings that save what they can, stock in the larger unit. */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let b: Booted;
const json = async (p: Promise<{ json: () => Any }>) => (await p).json();
const post = (url: string, payload: object) => b.call({ method: 'POST', url, payload });
const del = (url: string) => b.call({ method: 'DELETE', url });
const bin = () => json(b.call('/api/recycle-bin'));

beforeAll(async () => {
  b = await bootSignedIn({ preset: 'building-materials', demo: true });
});

describe('recycle bin', () => {
  it('deletes an unused item, lists it with who deleted it, and restores it', async () => {
    const cats = await json(b.call('/api/categories'));
    const { id } = await json(post('/api/products', { sku: 'MISTAKE-1', name_en: 'Typed by mistake', categoryId: cats[0].id, gst: '18', baseUnit: 'NOS' }));
    expect((await del(`/api/products/${id}`)).statusCode).toBe(200);
    expect((await json(b.call('/api/products'))).some((p: Any) => p.id === id)).toBe(false);
    expect((await json(b.call('/api/catalog'))).some((p: Any) => p.id === id)).toBe(false);
    const item = (await bin()).find((r: Any) => r.id === id);
    expect(item).toMatchObject({ kind: 'products', code: 'MISTAKE-1', name_en: 'Typed by mistake', deleted_by: 'Owner' });

    // the code stays taken while the item is in the bin, with a message that says so
    const again = await post('/api/products', { sku: 'MISTAKE-1', name_en: 'Again', categoryId: cats[0].id, gst: '18', baseUnit: 'NOS' });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/deleted item.*recycle bin/);

    expect((await post(`/api/recycle-bin/products/${id}/restore`, {})).statusCode).toBe(200);
    expect((await json(b.call('/api/products'))).some((p: Any) => p.id === id)).toBe(true);
    expect((await bin()).some((r: Any) => r.id === id)).toBe(false);
    const audits = await one<{ n: number }>(b.db, "SELECT COUNT(*) n FROM audit_log WHERE entity = 'products' AND entity_id = ? AND action IN ('delete', 'restore')", [id]);
    expect(Number(audits!.n)).toBe(2);
    // both changes go to the other devices
    const outbox = await one<{ n: number }>(b.db, "SELECT COUNT(*) n FROM sync_outbox WHERE table_name = 'products' AND row_id = ?", [id]);
    expect(Number(outbox!.n)).toBeGreaterThanOrEqual(3);
  });

  it('refuses to delete masters that are in use, and says what to do instead', async () => {
    const products = await json(b.call('/api/products'));
    const used = products.find((p: Any) => p.sku === 'TMT-12'); // has opening stock in the demo
    const r = await del(`/api/products/${used.id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/inactive/);

    const parties = await json(b.call('/api/parties?all=1'));
    const walkIn = parties.find((p: Any) => p.is_walk_in);
    expect((await del(`/api/parties/${walkIn.id}`)).json().error).toBe('IN_USE');
    const withBalance = parties.find((p: Any) => !p.is_walk_in && p.balance_paise !== 0);
    expect((await del(`/api/parties/${withBalance.id}`)).statusCode).toBe(409);

    const cats = await json(b.call('/api/categories'));
    expect((await del(`/api/categories/${cats[0].id}`)).json().message).toMatch(/still has items/);
  });

  it('will not restore a party whose mobile number is now someone else\'s, nor an item whose category is deleted', async () => {
    const a = await json(post('/api/parties', { name_en: 'Old Contact', mobile: '9876500011' }));
    expect((await del(`/api/parties/${a.id}`)).statusCode).toBe(200);
    await post('/api/parties', { name_en: 'New Contact', mobile: '9876500011' });
    const r = await post(`/api/recycle-bin/parties/${a.id}/restore`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/New Contact now has the same mobile number/);

    const cat = await json(post('/api/categories', { name_en: 'Short lived' }));
    const p = await json(post('/api/products', { sku: 'SL-1', name_en: 'In short lived', categoryId: cat.id, gst: '5', baseUnit: 'NOS' }));
    await del(`/api/products/${p.id}`);
    expect((await del(`/api/categories/${cat.id}`)).statusCode).toBe(200);
    const blocked = await post(`/api/recycle-bin/products/${p.id}/restore`, {});
    expect(blocked.json().message).toMatch(/Restore the category first/);
    await post(`/api/recycle-bin/categories/${cat.id}/restore`, {});
    expect((await post(`/api/recycle-bin/products/${p.id}/restore`, {})).statusCode).toBe(200);
  });

  it('deletes and restores an unused expense head', async () => {
    const h = await json(post('/api/expense-heads', { name_en: 'Never used head' }));
    expect((await del(`/api/expense-heads/${h.id}`)).statusCode).toBe(200);
    expect((await json(b.call('/api/expense-heads'))).some((x: Any) => x.id === h.id)).toBe(false);
    expect((await post(`/api/recycle-bin/expense_heads/${h.id}/restore`, {})).statusCode).toBe(200);
    expect((await post(`/api/recycle-bin/expense_heads/${h.id}/restore`, {})).statusCode).toBe(404);
  });

  it('is for the owner only', async () => {
    const u = await json(post('/api/users', { name: 'Counter B', role: 'billing', pin: '2468' }));
    const login = await json(b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin: '2468' } }));
    const clerk = callAs(b.app, login.token);
    expect((await clerk('/api/recycle-bin')).statusCode).toBe(403);
    const products = await json(b.call('/api/products'));
    expect((await clerk({ method: 'DELETE', url: `/api/products/${products[0].id}` })).statusCode).toBe(403);
  });
});

describe('settings save what they can', () => {
  it('saves the good changes and names the refused ones with the reason', async () => {
    const r = await b.call({ method: 'PUT', url: '/api/settings', payload: { 'business.tagline': 'Steel and more', 'gst.gstin': 'bad', 'credit.interest_pa': '18' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.saved.sort()).toEqual(['business.tagline', 'credit.interest_pa']);
    expect(Object.keys(body.refused)).toEqual(['gst.gstin']);
    expect(body.refused['gst.gstin']).toMatch(/15 characters/);
    expect(body.values['business.tagline']).toBe('Steel and more');
  });

  it('refuses only the changes that contradict each other, keeping the settings consistent', async () => {
    const before = (await json(b.call('/api/settings'))).values;
    const r = await b.call({ method: 'PUT', url: '/api/settings', payload: { 'business.phone': '044 1234 5678', 'gst.gstin': '29ABCDE1234F1Z5' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().saved).toEqual(['business.phone']);
    expect(r.json().refused['gst.gstin']).toMatch(/does not match the business state/);
    expect(r.json().values['gst.gstin']).toBe(before['gst.gstin']);
    expect(r.json().issues).toEqual([]);
  });

  it('keeps the invoice numbering locked once bills exist, while saving the rest', async () => {
    const cat = await json(b.call('/api/catalog'));
    const walkIn = (await json(b.call('/api/parties'))).find((p: Any) => p.is_walk_in);
    await post('/api/bills', { partyId: walkIn.id, lines: [{ productId: cat.find((p: Any) => p.sku === 'BW-20').id, entry: { KG: '1' } }] });
    const r = await b.call({ method: 'PUT', url: '/api/settings', payload: { 'invoice.prefix': 'ZZ', 'invoice.terms_en': 'Goods once sold…' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().saved).toEqual(['invoice.terms_en']);
    expect(r.json().refused['invoice.prefix']).toMatch(/financial year/);
    expect(r.json().values['invoice.prefix']).not.toBe('ZZ');
  });

  it('when nothing can be saved, fails with the reasons per setting', async () => {
    const r = await b.call({ method: 'PUT', url: '/api/settings', payload: { 'gst.gstin': 'bad', unknown: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(Object.keys(r.json().details.refused).sort()).toEqual(['gst.gstin', 'unknown']);
  });
});

describe('stock in the larger unit', () => {
  it('shows whole larger units and the rest in the base unit, with ≈ for theoretical weights', async () => {
    const t12 = (await json(b.call('/api/products'))).find((p: Any) => p.sku === 'TMT-12');
    await b.call({ method: 'PUT', url: '/api/stock/opening', payload: { lines: [{ productId: t12.id, qty: '2466.67', cost: '55' }] } });
    const today = (await json(b.call('/api/health'))).today;
    const r = await json(b.call(`/api/reports/stock-summary?asOf=${today}`));
    const row = r.tables.find((t: Any) => t.id === 'stock').rows.find((x: Any) => x.sku === 'TMT-12');
    // steel bundles are calculated weights, so the report marks them as an estimate
    expect(row.larger).toMatchObject({ qtyMilli: row.qty, theoretical: true, en: 'Bundle', baseEn: expect.any(String) });
    expect(row.larger.whole).toBe(Math.floor(row.qty / row.larger.factorMilli));
    expect(row.larger.whole).toBeGreaterThan(0);
    const { largerUnitText } = await import('@tula/core');
    expect(largerUnitText(row.qty, row.larger.factorMilli, 'Bundle', 'Kg', true)).toMatch(/^≈ \d+ Bundle \+ [\d.]+ Kg$/);
  });
});
