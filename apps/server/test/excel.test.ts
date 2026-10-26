import { one } from '@tula/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseUnits } from '../src/excel';
import { bootSignedIn, callAs, type Booted } from './helpers';

/* Excel import and export: the export is the template, rows are checked like the screens' forms. */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let b: Booted;
const json = async (p: Promise<{ json: () => Any; statusCode: number }>) => (await p).json();
const exp = (kind: string) => json(b.call(`/api/excel/${kind}`));
const imp = (kind: string, rows: Any[], apply = false) => b.call({ method: 'POST', url: `/api/excel/${kind}`, payload: { rows, apply } });

beforeAll(async () => {
  b = await bootSignedIn({ preset: 'building-materials', demo: true });
});

describe('export', () => {
  it('gives items with their units, rates and categories, as plain numbers', async () => {
    const x = await exp('items');
    expect(x.columns).toContain('Other units');
    const t12 = x.rows.find((r: Any) => r['Item code'] === 'TMT-12');
    expect(t12).toMatchObject({ 'GST %': 18, 'Base unit': 'KG', 'Daily rate group': 'TMT', 'Keep stock': 'Yes', Active: 'Yes' });
    expect(t12['Other units']).toBe('BDL~53.335; ROD~10.667'); // a bundle of 5 rods; both theoretical weights
  });

  it('leaves out the walk-in customer', async () => {
    const x = await exp('parties');
    expect(x.rows.length).toBeGreaterThan(0);
    expect(x.rows.some((r: Any) => /walk/i.test(r['Name (English)']))).toBe(false);
  });
});

describe('import', () => {
  it('re-importing the export unchanged leaves every row alone: no audit entries, nothing to sync', async () => {
    const count = async (t: string) => Number((await one<{ n: number }>(b.db, `SELECT COUNT(*) n FROM ${t}`))!.n);
    for (const kind of ['items', 'parties', 'opening-stock']) {
      const before = await exp(kind);
      const [outbox, audits] = [await count('sync_outbox'), await count('audit_log')];
      const r = await json(imp(kind, before.rows, true));
      expect(r.failed, JSON.stringify(r.rows.filter((x: Any) => x.errors.length))).toBe(0);
      expect(r, kind).toMatchObject({ created: 0, updated: 0, skipped: before.rows.length });
      expect((await exp(kind)).rows).toEqual(before.rows);
      expect([await count('sync_outbox'), await count('audit_log')], kind).toEqual([outbox, audits]);
    }
    const tb = await one<{ dr: number; cr: number }>(b.db, 'SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM ledger_entries WHERE deleted = 0');
    expect(tb!.dr).toBe(tb!.cr);
  });

  it('checks without saving, then saves new items and a new category', async () => {
    const rows = [
      { 'Item code': 'pvc-25', 'Name (English)': 'PVC pipe 25mm', Category: 'Hardware', 'GST %': 18, 'Base unit': 'NOS', 'Sale rate': 120.5, 'Other units': 'BDL=10' },
      { 'Item code': 'TMT-12', 'Name (English)': 'TMT bar 12mm Fe550D', Category: 'TMT bars', 'GST %': '18', 'Base unit': 'KG', 'Daily rate group': 'TMT', 'Rate extra': 2, 'Other units': 'BDL~53.335; ROD~10.667' },
    ];
    const check = await json(imp('items', rows));
    expect(check.applied).toBe(false);
    expect(check.rows.map((r: Any) => [r.key, r.action])).toEqual([['PVC-25', 'create'], ['TMT-12', 'update']]);
    expect(check.rows[0].notes).toEqual(['New category "Hardware"']);
    expect((await json(b.call('/api/products'))).some((p: Any) => p.sku === 'PVC-25')).toBe(false);

    const saved = await json(imp('items', rows, true));
    expect(saved).toMatchObject({ applied: true, created: 1, updated: 1, failed: 0 });
    const pvc = (await json(b.call('/api/products'))).find((p: Any) => p.sku === 'PVC-25');
    expect(pvc).toMatchObject({ sale_rate_paise: 12050, base_unit: 'NOS', category_en: 'Hardware' });
    const detail = await json(b.call(`/api/products/${pvc.id}`));
    expect(detail.units).toEqual([expect.objectContaining({ unit: 'BDL', factor_milli: 10000, on_bill: 1 })]);
  });

  it('names the column for each mistake, and saves nothing when any row is wrong', async () => {
    const rows = [
      { 'Item code': 'OK-1', 'Name (English)': 'Fine item', Category: 'Hardware', 'GST %': 18, 'Base unit': 'NOS' },
      { 'Item code': 'BAD-1', 'Name (English)': 'Odd GST', Category: 'Hardware', 'GST %': 17, 'Base unit': 'NOS' },
      { 'Item code': 'BAD-2', 'Name (English)': 'Odd unit', Category: 'Hardware', 'GST %': 18, 'Base unit': 'XYZ' },
      { 'Item code': 'BAD-3', 'Name (English)': 'Odd units', Category: 'Hardware', 'GST %': 18, 'Base unit': 'NOS', 'Other units': 'BOX: 10' },
      { 'Item code': 'BAD-4', 'Name (English)': '', Category: 'Hardware', 'GST %': 18, 'Base unit': 'NOS', Active: 'maybe' },
    ];
    const r = await json(imp('items', rows, true));
    expect(r.applied).toBe(false);
    expect(r.failed).toBe(4);
    expect(r.rows.map((x: Any) => x.line)).toEqual([2, 3, 4, 5, 6]);
    expect(r.rows[1].errors[0]).toMatch(/^GST % must be one of/); // names the column once, not "GST %: GST % must…"
    expect(r.rows[2].errors[0]).toMatch(/Unknown unit XYZ/);
    expect(r.rows[3].errors[0]).toMatch(/^Other units: /);
    expect(r.rows[4].errors[0]).toMatch(/Yes or No/);
    expect((await json(b.call('/api/products'))).some((p: Any) => p.sku === 'OK-1')).toBe(false);
  });

  it('refuses a sheet without the needed columns', async () => {
    const res = await imp('items', [{ Something: 'x' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/"Item code"/);
  });

  it('adds customers with opening balances and finds existing ones by mobile', async () => {
    const r = await json(imp('parties', [
      { Type: 'Customer', 'Name (English)': 'Excel Builders', Mobile: '98400 12345', 'State code': 33, 'Credit limit': 50000, 'Credit days': 30, 'Opening balance': 1500.75 },
      { Type: 'supplier', 'Name (English)': 'Excel Steels', GSTIN: '33AAACE1234F1Z5' },
    ], true));
    expect(r).toMatchObject({ applied: true, created: 2, failed: 0 });
    const parties = await json(b.call('/api/parties?all=1'));
    const c = parties.find((p: Any) => p.name_en === 'Excel Builders');
    expect(c).toMatchObject({ mobile: '9840012345', credit_limit_paise: 5000000, balance_paise: 150075 });

    const again = await json(imp('parties', [{ 'Name (English)': 'Excel Builders & Co', Mobile: '9840012345', 'Opening balance': '' }], true));
    expect(again).toMatchObject({ created: 0, updated: 1 });
    const c2 = (await json(b.call(`/api/parties/${c.id}`)));
    expect(c2).toMatchObject({ name_en: 'Excel Builders & Co', balance_paise: 150075 }); // blank opening balance: kept
  });

  it('refuses two rows that clash with each other', async () => {
    const r = await json(imp('parties', [
      { 'Name (English)': 'First Person', Mobile: '9000000771' },
      { 'Name (English)': 'Second Person', Mobile: '9000000771' },
    ], true));
    // the second row is the same mobile, so it updates the first one rather than adding a duplicate
    expect(r.rows.map((x: Any) => x.action)).toEqual(['create', 'update']);
  });

  it('sets opening stock from the sheet; blank rows are left alone', async () => {
    const x = await exp('opening-stock');
    const rows = x.rows.map((row: Any) => (row['Item code'] === 'PVC-25' ? { ...row, Quantity: 40, 'Cost per unit': 95 } : { ...row, Quantity: null, 'Cost per unit': null }));
    const r = await json(imp('opening-stock', rows, true));
    expect(r).toMatchObject({ applied: true, updated: 1, failed: 0 });
    const pvc = (await json(b.call('/api/products'))).find((p: Any) => p.sku === 'PVC-25');
    expect(pvc.stock_milli).toBe(40000);
    expect((await exp('opening-stock')).rows.find((row: Any) => row['Item code'] === 'PVC-25')).toMatchObject({ Quantity: 40, 'Cost per unit': 95 });
  });

  it('is for the owner only', async () => {
    const u = await json(b.call({ method: 'POST', url: '/api/users', payload: { name: 'Counter', role: 'billing', pin: '2468' } }));
    expect(u.id).toBeTruthy();
    const login = await json(b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin: '2468' } }));
    const clerk = callAs(b.app, login.token);
    expect((await clerk('/api/excel/items')).statusCode).toBe(403);
    expect((await clerk({ method: 'POST', url: '/api/excel/items', payload: { rows: [] } })).statusCode).toBe(403);
  });
});

describe('other units', () => {
  it('reads "=" as an exact unit and "~" as a theoretical weight', () => {
    expect(parseUnits('BDL=10; rod~1.2, BOX = 4')).toEqual([
      { unit: 'BDL', factor: '10', theoretical: false }, { unit: 'ROD', factor: '1.2', theoretical: true }, { unit: 'BOX', factor: '4', theoretical: false },
    ]);
    expect(parseUnits('')).toEqual([]);
  });
});
