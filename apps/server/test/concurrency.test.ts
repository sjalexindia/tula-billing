import { describe, expect, it } from 'vitest';
import { bootSignedIn } from './helpers';

describe('one database connection, many requests', () => {
  it('a request arriving while a transaction is open waits instead of failing', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const tx = await b.db.transaction('write');
    await tx.execute("UPDATE sync_state SET value = value WHERE key = 'device_id'");
    let answered = false;
    const pending = b.call('/api/catalog').then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    expect(answered).toBe(false); // queued behind the transaction
    await tx.commit();
    expect((await pending).statusCode).toBe(200);
  });

  it('two bills saved at the same moment both succeed with different numbers', async () => {
    const b = await bootSignedIn({ preset: 'building-materials', demo: true });
    const cat = (await b.call('/api/catalog')).json();
    const parties = (await b.call('/api/parties')).json();
    const walkIn = parties.find((p: { is_walk_in: number }) => p.is_walk_in);
    const bill = () => b.call({ method: 'POST', url: '/api/bills', payload: {
      partyId: walkIn.id, lines: [{ productId: cat.find((p: { sku: string }) => p.sku === 'CEM-OPC53').id, entry: { BAG: '1' } }], payment: { mode: 'cash', amount: '0' },
    } });
    const [r1, r2] = await Promise.all([bill(), bill()]);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    expect(r1.json().docNo).not.toBe(r2.json().docNo);
  });
});
