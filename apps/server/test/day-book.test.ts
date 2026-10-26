import { one } from '@tula/db';
import { describe, expect, it } from 'vitest';
import { bootSignedIn } from './helpers';

/** Day book and cash book name parties in both languages, whatever language each bill was printed in. */
describe('day book and cash book party names', () => {
  it('gives English and Tamil names, and shows opening stock apart from stock corrections', async () => {
    const { db, call } = await bootSignedIn({ preset: 'building-materials', demo: true });
    const parties = (await call('/api/parties')).json() as Array<{ id: string; name_en: string; is_walk_in: number }>;
    const builder = parties.find((p) => p.name_en === 'Sample Builders')!;
    const walkIn = parties.find((p) => p.is_walk_in)!;
    const cement = (await one<{ id: string }>(db, 'SELECT id FROM products WHERE sku = ?', ['CEM-OPC53']))!.id;
    const line = { productId: cement, entry: { BAG: '2' } };
    // The builder's bills print in Tamil (customer language); the walk-in pays cash.
    const a = await call({ method: 'POST', url: '/api/bills', payload: { partyId: builder.id, lines: [line], confirmWarnings: true } });
    expect(a.statusCode, a.body).toBe(201);
    const b = await call({ method: 'POST', url: '/api/bills', payload: { partyId: walkIn.id, lines: [line], payment: { mode: 'cash', amount: '897' }, confirmWarnings: true } });
    expect(b.statusCode, b.body).toBe(201);

    const date = (await one<{ d: string }>(db, 'SELECT doc_date d FROM sales_docs LIMIT 1'))!.d;
    const r = (await call(`/api/reports/day-book?from=${date}&to=${date}`)).json();
    const docs = r.tables.find((t: { id: string }) => t.id === 'documents');
    expect(docs.columns.find((c: { key: string }) => c.key === 'party').type).toBe('name');
    const inv = docs.rows.find((x: { doc_no: string }) => x.doc_no === a.json().docNo);
    expect(inv.party).toEqual({ en: 'Sample Builders', ta: 'சாம்பிள் பில்டர்ஸ்' });
    const rcpt = docs.rows.find((x: { type: string }) => x.type === 'RCPT');
    expect(rcpt.party.en).toBe('Walk-in customer');

    // Opening stock is its own type, not a stock correction.
    const opening = docs.rows.find((x: { type: string }) => x.type === 'OPEN');
    expect(opening.party).toMatchObject({ code: 'opening' });
    const byType = r.tables.find((t: { id: string }) => t.id === 'by_type').rows.map((x: { type: string }) => x.type);
    expect(byType).toContain('OPEN');
    expect(byType).not.toContain('ADJ');

    const cash = (await call(`/api/reports/cash-book?from=${date}&to=${date}`)).json();
    const cashRows = cash.tables.find((t: { id: string }) => t.id === 'account_cash').rows;
    expect(cashRows.some((x: { party: { en?: string } }) => x.party?.en === 'Walk-in customer')).toBe(true);

    // The Excel file still opens with the new cells.
    const x = await call(`/api/reports/day-book?from=${date}&to=${date}&format=xlsx`);
    expect(x.statusCode).toBe(200);
  });
});
