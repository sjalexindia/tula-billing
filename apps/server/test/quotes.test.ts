import { one } from '@tula/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootSignedIn, callAs, type Booted, type Call } from './helpers';

/* Quotations: priced like bills, no stock / ledger / GST effect, one quotation becomes one bill. */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let b: Booted;
let tmt12: Any;
let customer: Any;
const json = async (p: Promise<{ json: () => Any; statusCode: number }>) => (await p).json();
const count = async (sql: string, args: string[] = []) => Number((await one<{ n: number }>(b.db, sql, args))!.n);

async function quote(call: Call, extra: Any = {}) {
  const res = await call({ method: 'POST', url: '/api/quotes', payload: { partyId: customer.id, site: 'New house, Anna Nagar', lines: [{ productId: tmt12.id, entry: { BDL: '2' } }], ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; docNo: string; total: number };
}

beforeAll(async () => {
  b = await bootSignedIn({ preset: 'building-materials', demo: true });
  tmt12 = (await json(b.call('/api/catalog'))).find((p: Any) => p.sku === 'TMT-12');
  customer = (await json(b.call('/api/parties'))).find((p: Any) => !p.is_walk_in && p.party_type !== 'supplier');
});

describe('quotations', () => {
  it('are numbered in their own series and change no stock, ledger or reports', async () => {
    const before = {
      moves: await count('SELECT COUNT(*) n FROM stock_moves'), ledger: await count('SELECT COUNT(*) n FROM ledger_entries'),
      balance: (await json(b.call(`/api/parties/${customer.id}`))).balance_paise,
    };
    const q = await quote(b.call, { validUntil: '2099-12-31' });
    expect(q.docNo).toMatch(/^QT/);
    expect(q.total).toBeGreaterThan(0);
    expect(await count('SELECT COUNT(*) n FROM stock_moves')).toBe(before.moves);
    expect(await count('SELECT COUNT(*) n FROM ledger_entries')).toBe(before.ledger);
    expect((await json(b.call(`/api/parties/${customer.id}`))).balance_paise).toBe(before.balance);

    const today = new Date().toISOString().slice(0, 10);
    const reg = await json(b.call(`/api/reports/sales-register?from=2000-01-01&to=${today}`));
    expect(JSON.stringify(reg)).not.toContain(q.docNo);
    const bills = await json(b.call(`/api/sales/bills?from=2000-01-01&to=${today}`));
    expect(JSON.stringify(bills)).not.toContain(q.docNo);
    const gstr1 = await json(b.call(`/api/reports/gstr1?month=${today.slice(0, 7)}`));
    expect(JSON.stringify(gstr1)).not.toContain(q.docNo);
  });

  it('are listed with their state, and open like a bill for printing', async () => {
    const q = await quote(b.call);
    const list = await json(b.call('/api/quotes'));
    expect(list.find((x: Any) => x.id === q.id)).toMatchObject({ docNo: q.docNo, state: 'open', bill: null, site: 'New house, Anna Nagar' });
    const view = await json(b.call(`/api/quotes/${q.id}`));
    expect(view.doc).toMatchObject({ doc_type: 'QT', doc_no: q.docNo });
    expect(view.lines).toHaveLength(1);
    expect(view.quote.state).toBe('open');
  });

  it('become a bill at today\'s rate, or at the quoted rate when kept, and only once', async () => {
    const q = await quote(b.call);
    const quotedRate = (await json(b.call(`/api/quotes/${q.id}`))).lines[0].rate_paise;
    // the day's steel rate goes up after the quotation
    const rates = await json(b.call('/api/rates'));
    const tmt = rates.find((r: Any) => r.code === 'TMT');
    await b.call({ method: 'PUT', url: '/api/rates/TMT', payload: { rate: String(tmt.rate_paise / 100 + 5) } });

    const pv = await json(b.call({ method: 'POST', url: `/api/quotes/${q.id}/convert/preview`, payload: {} }));
    expect(pv.lines[0].quotedRatePaise).toBe(quotedRate);
    expect(pv.lines[0].ratePaise).toBe(quotedRate + 500);
    const kept = await json(b.call({ method: 'POST', url: `/api/quotes/${q.id}/convert/preview`, payload: { keepRates: true } }));
    expect(kept.lines[0].ratePaise).toBe(quotedRate);

    const res = await b.call({ method: 'POST', url: `/api/quotes/${q.id}/convert`, payload: { confirmWarnings: true } });
    expect(res.statusCode, res.body).toBe(201);
    const bill = res.json();
    expect(bill.docNo).not.toMatch(/^QT/);
    const billView = await json(b.call(`/api/bills/${bill.id}`));
    expect(billView.lines[0].rate_paise).toBe(quotedRate + 500);
    expect(billView.doc.ref_doc_id).toBeNull(); // the link is on the quotation, not on the bill
    expect(await count("SELECT COUNT(*) n FROM stock_moves WHERE source_id = ?", [bill.id])).toBe(1);

    expect((await json(b.call(`/api/quotes/${q.id}`))).quote).toMatchObject({ state: 'converted', bill: { id: bill.id, docNo: bill.docNo } });
    const again = await b.call({ method: 'POST', url: `/api/quotes/${q.id}/convert`, payload: { confirmWarnings: true } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('QUOTE_CONVERTED');
    expect((await b.call({ method: 'POST', url: `/api/quotes/${q.id}/cancel`, payload: {} })).statusCode).toBe(409);

    // once that bill is cancelled, the quotation can become a bill again
    expect((await b.call({ method: 'POST', url: `/api/bills/${bill.id}/cancel`, payload: { reason: 'Wrong customer' } })).statusCode).toBe(200);
    expect((await json(b.call(`/api/quotes/${q.id}`))).quote.state).toBe('open');
    const third = await b.call({ method: 'POST', url: `/api/quotes/${q.id}/convert`, payload: { keepRates: true, confirmWarnings: true } });
    expect(third.statusCode, third.body).toBe(201);
    expect((await json(b.call(`/api/bills/${third.json().id}`))).lines[0].rate_paise).toBe(quotedRate);
  });

  it('a cancelled quotation cannot become a bill', async () => {
    const q = await quote(b.call);
    expect((await b.call({ method: 'POST', url: `/api/quotes/${q.id}/cancel`, payload: {} })).statusCode).toBe(200);
    expect((await json(b.call('/api/quotes'))).find((x: Any) => x.id === q.id).state).toBe('cancelled');
    const res = await b.call({ method: 'POST', url: `/api/quotes/${q.id}/convert`, payload: { confirmWarnings: true } });
    expect(res.statusCode).toBe(409);
  });

  it('show as expired after their "valid until" date, and refuse one before the quotation date', async () => {
    const q = await quote(b.call, { date: '2026-01-05', validUntil: '2026-01-20' });
    expect((await json(b.call('/api/quotes?from=2026-01-01'))).find((x: Any) => x.id === q.id).state).toBe('expired');
    const bad = await b.call({ method: 'POST', url: '/api/quotes', payload: { partyId: customer.id, date: '2026-01-05', validUntil: '2026-01-01', lines: [{ productId: tmt12.id, entry: { BDL: '1' } }] } });
    expect(bad.statusCode).toBe(400);
  });

  it('counter staff can make quotations and turn them into bills; a viewer cannot', async () => {
    const mk = async (role: string, pin: string) => {
      const u = await json(b.call({ method: 'POST', url: '/api/users', payload: { name: `Q ${role}`, role, pin } }));
      const login = await json(b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin } }));
      const call = callAs(b.app, login.token);
      await call({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: pin, newPin: `${pin.slice(1)}${pin[0]}` } }); // first sign-in: own PIN
      return call;
    };
    const clerk = await mk('billing', '2468');
    const q = await quote(clerk);
    expect((await clerk({ method: 'POST', url: `/api/quotes/${q.id}/convert`, payload: { confirmWarnings: true } })).statusCode).toBe(201);
    const viewer = await mk('viewer', '3579');
    expect((await viewer({ method: 'POST', url: '/api/quotes', payload: { partyId: customer.id, lines: [{ productId: tmt12.id, entry: { BDL: '1' } }] } })).statusCode).toBe(403);
    expect((await viewer('/api/quotes')).statusCode).toBe(200);
  });
});
