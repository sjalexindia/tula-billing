import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorText, serverText, warningText } from '../../web/src/server-text';
import { bootSignedIn, type Booted } from './helpers';
import { serverMessages, ZOD_MESSAGES } from './server-messages';

/* Server messages reach Tamil users translated: every message has a Tamil template, and the web turns them into Tamil. */

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ta = JSON.parse(readFileSync(join(__dirname, '..', '..', 'web', 'src', 'locales', 'ta', 'server.json'), 'utf8')) as { serverText: Record<string, string>; serverTextZod: Record<string, string> };
const holes = (s: string) => new Set([...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!));

describe('the Tamil catalog of server messages', () => {
  const messages = serverMessages();

  it('has a Tamil template for every message the server can send', () => {
    const missing = [...messages].filter(([t]) => !(t in ta.serverText)).map(([t, f]) => `${f}: ${t}`);
    expect(missing, 'add these to apps/web/src/locales/ta/server.json').toEqual([]);
  });

  it('has no templates for messages the server no longer sends', () => {
    const stale = Object.keys(ta.serverText).filter((t) => !messages.has(t));
    expect(stale, 'remove or update these in apps/web/src/locales/ta/server.json').toEqual([]);
  });

  it('covers zod\'s own messages', () => {
    expect(Object.keys(ta.serverTextZod).sort()).toEqual([...ZOD_MESSAGES].sort());
  });

  it('uses only values the English message has (a plural "s" may be dropped)', () => {
    for (const [en, tamil] of Object.entries({ ...ta.serverText, ...ta.serverTextZod })) {
      const extra = [...holes(tamil)].filter((h) => !holes(en).has(h));
      expect(extra, en).toEqual([]);
    }
  });
});

describe('the web shows server messages in Tamil', () => {
  it('translates a message with values, and messages nested in another', () => {
    expect(serverText('Item code TMT-12 is already used', 'ta')).toBe('பொருள் குறியீடு TMT-12 ஏற்கனவே பயன்பாட்டில் உள்ளது');
    expect(serverText('Line 2: Invalid amount: "1.2.3"', 'ta')).toBe('வரி 2: சரியில்லாத மதிப்பு: "1.2.3"');
    expect(serverText('Something new the server says', 'ta')).toBe('Something new the server says');
    expect(serverText('Item code TMT-12 is already used', 'en')).toBe('Item code TMT-12 is already used');
  });

  it('translates validation errors: own messages alone, zod\'s with the field name', () => {
    expect(errorText('VALIDATION', 'mobile: Mobile number must be 10 digits', 'ta')).toBe('மொபைல் எண் 10 இலக்கங்கள் இருக்க வேண்டும்');
    expect(errorText('VALIDATION', 'name_en: Too small: expected string to have >=1 characters', 'ta')).toBe('பெயர் (ஆங்கிலம்): குறைந்தது 1 எழுத்துகள் வேண்டும்');
  });

  it('names settings by their screen label', () => {
    expect(serverText('invoice.prefix must be up to 6 letters, digits or -', 'ta')).not.toContain('invoice.prefix');
  });

  it('translates ledger narrations and GST rows', () => {
    expect(serverText('RC/26-27/0001 against DT/26-27/0004', 'ta')).toBe('DT/26-27/0004-க்கு எதிராக RC/26-27/0001');
    expect(serverText('Opening balance', 'ta')).toBe('தொடக்க இருப்பு');
    expect(serverText('3.1(e) Non-GST outward supplies', 'ta')).toMatch(/^3\.1\(e\) GST இல்லாத/);
  });
});

describe('bill warnings carry their values', () => {
  let b: Booted;
  beforeAll(async () => { b = await bootSignedIn({ preset: 'building-materials', demo: true }); });

  it('low stock and credit limit come with quantities and amounts, and read in Tamil', async () => {
    const cat = (await b.call('/api/catalog')).json() as Any[];
    const parties = (await b.call('/api/parties')).json() as Any[];
    const party = parties.find((p) => p.credit_limit_paise > 0)!;
    const t12 = cat.find((p) => p.sku === 'TMT-12')!;
    const res = (await b.call({ method: 'POST', url: '/api/bills/preview', payload: { partyId: party.id, lines: [{ productId: t12.id, entry: { BDL: '900' } }] } })).json();
    const low = res.warnings.find((w: Any) => w.code === 'LOW_STOCK');
    const credit = res.warnings.find((w: Any) => w.code === 'CREDIT_LIMIT');
    expect(low.params).toEqual({ billingMilli: expect.any(Number), stockMilli: expect.any(Number) });
    expect(credit.params).toEqual({ outstandingPaise: expect.any(Number), limitPaise: party.credit_limit_paise });
    expect(low.message).toMatch(/billing/); // English stays for other clients
    const tamil = warningText(low, cat, 'ta');
    expect(tamil).toContain(t12.nameTa);
    expect(tamil).toContain('இருப்பு');
    expect(warningText(credit, cat, 'ta')).toContain('₹');
  });
});
