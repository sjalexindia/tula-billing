import { scrypt as nobleScrypt } from '@noble/hashes/scrypt.js';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { one, uuidv7, type Db } from '@tula/db';
import { loadMigrations, openDb } from '@tula/db/node';
import type { FastifyInstance } from 'fastify';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalRouter } from '../../web/src/local/router';
import { isJoined, joinBusiness, prepareDb, startRuntime, type PhoneRuntime } from '../../web/src/local/runtime';
import { createSqliteClient } from '../../web/src/local/sqlite-client';
import { directBackend } from '../../web/src/local/sqlite-direct';
import { buildApp } from '../src/app';
import { hashPin, useScrypt, verifyPin } from '../src/auth';
import { setup } from '../src/setup';
import { syncOnce } from '../src/sync/engine';
import { openHub, type Hub } from '../src/sync/hub';
import { nextPhoneCode } from '../src/sync/join';
import { nodeHubDriver } from '../src/sync/node-hub';
import { callAs, type Call } from './helpers';

/**
 * The phone app's stack, run in Node: SQLite WebAssembly behind the libSQL-compatible client,
 * the shop computer's API on the in-process router, and join + sync through a file hub.
 * The phone talks to the hub with @libsql/client/web in the app; here with the Node client,
 * because a file hub stands in for Turso (same API, as in sync.test.ts).
 */
const dir = mkdtempSync(join(tmpdir(), 'tula-phone-'));
const hubUrl = `file:${join(dir, 'hub.db')}`;
const quiet = () => {};

let hub: Hub;
let pcDb: Db;
let pc: FastifyInstance;
let pcCall: Call;
let pcDevice: string;
let phoneDb: Db;
let phone: PhoneRuntime;
let phoneToken = '';

async function openPhoneDb(): Promise<Db> {
  const sqlite3 = await sqlite3InitModule();
  const db = createSqliteClient(directBackend(sqlite3, new sqlite3.oo1.DB(':memory:', 'c')));
  await prepareDb(db, loadMigrations());
  return db;
}

interface Res { status: number; json: () => any }
const phoneCall = async (o: string | { method: string; url: string; payload?: unknown }): Promise<Res> => {
  const r = typeof o === 'string' ? { method: 'GET', url: o } : o;
  const res = await phone.router.handle({ method: r.method, url: r.url, body: 'payload' in r ? r.payload : undefined, headers: phoneToken ? { authorization: `Bearer ${phoneToken}` } : {} });
  // as JSON, like the fetch bridge in the app (and Fastify on the shop computer)
  const text = res.body === undefined ? undefined : JSON.stringify(res.body);
  return { status: res.status, json: () => (text === undefined ? undefined : JSON.parse(text)) };
};

async function walkInBill(call: (o: any) => Promise<{ json: () => any; status?: number; statusCode?: number }>, sku = 'TMT-12') {
  const catalog = (await call('/api/catalog')).json() as Array<{ id: string; sku: string }>;
  const parties = (await call('/api/parties')).json() as Array<{ id: string; is_walk_in: number }>;
  const res = await call({
    method: 'POST', url: '/api/bills',
    payload: { partyId: parties.find((p) => p.is_walk_in)!.id, lines: [{ productId: catalog.find((p) => p.sku === sku)!.id, entry: { BDL: '1' } }], payment: { mode: 'cash', amount: '100' } },
  });
  expect(res.status ?? res.statusCode).toBe(201);
  return res.json() as { id: string; docNo: string };
}

beforeAll(async () => {
  pcDb = await openDb(`file:${join(dir, 'pc.db')}`);
  await setup(pcDb, { preset: 'building-materials', demo: true });
  pc = await buildApp(pcDb);
  const owner = (await pc.inject('/api/auth/users')).json().find((u: { role: string }) => u.role === 'owner');
  const token = (await pc.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin: '1234' } })).json().token;
  await pc.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${token}` }, payload: { currentPin: '1234', newPin: '4826' } });
  pcCall = callAs(pc, token);
  pcDevice = (await one<{ value: string }>(pcDb, "SELECT value FROM sync_state WHERE key = 'device_id'"))!.value;
  hub = await openHub({ url: hubUrl }, nodeHubDriver);
  await syncOnce(pcDb, hub, pcDevice);
});

afterAll(() => {
  phone?.stop();
  hub?.close();
  pcDb?.close();
  phoneDb?.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps closed SQLite files locked for a moment */ }
});

/** The phone's scrypt (@noble/hashes), so the test does not depend on what app.ts plugged in. */
const jsOnly = (p: Uint8Array, s: Uint8Array, n: number) => nobleScrypt(p, s, { N: 2 ** 14, r: 8, p: 1, dkLen: n });

describe('PINs', () => {
  it('hashes made by Node scrypt verify with the JS scrypt the phone uses, and the other way round', () => {
    const salt = randomBytes(16);
    const fromNode = `scrypt$${salt.toString('hex')}$${scryptSync('4826', salt, 32).toString('hex')}`;
    useScrypt(jsOnly); // the phone's scrypt
    try {
      expect(verifyPin('4826', fromNode)).toBe(true);
      expect(verifyPin('4827', fromNode)).toBe(false);
      const [, s, h] = hashPin('4826').split('$');
      expect(scryptSync('4826', Buffer.from(s!, 'hex'), 32).toString('hex')).toBe(h);
    } finally {
      useScrypt((p, s2, n) => scryptSync(p, s2, n));
    }
  });
});

describe('phone database (SQLite WebAssembly behind the libSQL client)', () => {
  it('runs the migrations and gives rows by name and by index, like libSQL', async () => {
    phoneDb = await openPhoneDb();
    const r = await phoneDb.execute("SELECT 1 AS one, 'x' AS two");
    expect(r.columns).toEqual(['one', 'two']);
    expect(r.rows[0]![0]).toBe(1);
    expect(r.rows[0]!.two).toBe('x');
    expect({ ...r.rows[0] }).toEqual({ one: 1, two: 'x' });
    expect(await isJoined(phoneDb)).toBe(false);
  });

  it('rolls a transaction back, and makes other statements wait while one is open', async () => {
    await phoneDb.execute('CREATE TEMP TABLE t (v INTEGER)');
    const tx = await phoneDb.transaction('write');
    await tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [1] });
    let answered = false;
    const outside = phoneDb.execute('SELECT COUNT(*) FROM t').then((x) => { answered = true; return Number(x.rows[0]![0]); });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    await tx.rollback();
    expect(await outside).toBe(0);
  });

  it('reports a UNIQUE clash as a constraint error, as the sync engine expects', async () => {
    await phoneDb.execute('CREATE TEMP TABLE u (v INTEGER UNIQUE)');
    await phoneDb.execute('INSERT INTO u VALUES (1)');
    await expect(phoneDb.execute('INSERT INTO u VALUES (1)')).rejects.toThrow(/CONSTRAINT/i);
  });
});

describe('joining from the cloud copy', () => {
  it('copies the business and becomes "Phone 1" with bill series M1', async () => {
    const r = await joinBusiness(phoneDb, { url: hubUrl }, nodeHubDriver, undefined, quiet);
    expect(r.seriesCode).toBe('M1');
    expect(r.name).toBe('Phone 1');
    expect(r.rows).toBeGreaterThan(50);
    expect(await isJoined(phoneDb)).toBe(true);
    expect(nextPhoneCode(['', 'C2', 'M1'])).toBe('M2');
  });

  it('signs in on the phone with the PIN set on the shop computer', async () => {
    phone = await startRuntime(phoneDb, { hub: null, driver: nodeHubDriver });
    const users = (await phoneCall('/api/auth/users')).json();
    const owner = users.find((u: { role: string }) => u.role === 'owner');
    const wrong = await phoneCall({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin: '1234' } });
    expect(wrong.status).toBe(401);
    const login = await phoneCall({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin: '4826' } });
    expect(login.status).toBe(200);
    phoneToken = login.json().token;
    expect((await phoneCall('/api/auth/me')).json().user.role).toBe('owner');
  });

  it('refuses requests without a session, and unknown routes', async () => {
    const saved = phoneToken;
    phoneToken = '';
    expect((await phoneCall('/api/catalog')).status).toBe(401);
    phoneToken = saved;
    expect((await phoneCall('/api/nothing-here')).status).toBe(404);
    expect((await phoneCall({ method: 'POST', url: '/api/bills', payload: { lines: 'x' } })).status).toBe(400);
  });
});

describe('billing on the phone with no shop computer and no internet, then syncing', () => {
  let phoneBill: { id: string; docNo: string };

  it('makes a bill numbered in the phone series', async () => {
    phoneBill = await walkInBill(phoneCall);
    expect(phoneBill.docNo).toMatch(/M1/);
    expect((await phoneCall(`/api/bills/${phoneBill.id}`)).status).toBe(200);
  });

  it('the shop computer bills at the same time in its own series', async () => {
    const b = await walkInBill(pcCall, 'TMT-08');
    expect(b.docNo).not.toMatch(/M1/);
  });

  it('after syncing, each side has the other\'s bill and the books agree exactly', async () => {
    await syncOnce(phoneDb, hub, phone.deviceId);
    await syncOnce(pcDb, hub, pcDevice);
    await syncOnce(phoneDb, hub, phone.deviceId);

    expect((await pcCall(`/api/bills/${phoneBill.id}`)).statusCode).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    for (const url of [
      '/api/parties', '/api/catalog', '/api/stock', '/api/outstanding', '/api/products', '/api/rates',
      `/api/bills?from=2000-01-01&to=${today}`, `/api/reports/day-book?from=2000-01-01&to=${today}`,
      `/api/reports/sales-register?from=2000-01-01&to=${today}`, `/api/reports/profit-loss?from=2000-01-01&to=${today}`,
      `/api/reports/stock-summary?asOf=${today}`, `/api/reports/gstr1?month=${today.slice(0, 7)}`,
    ]) {
      const a = await pcCall(url);
      const b = await phoneCall(url);
      expect(b.status, url).toBe(a.statusCode);
      expect(b.json(), url).toEqual(a.json());
    }
  });
});

describe('router', () => {
  it('passes params, repeated query keys and status codes through', async () => {
    const r = new LocalRouter();
    r.get('/api/x/:id', async (req) => ({ params: req.params, query: req.query }));
    r.post('/api/y', async (_req, reply) => reply.status(201).header('X-A', '1').send({ ok: true }));
    const a = await r.handle({ method: 'GET', url: '/api/x/a%20b?k=1&k=2&z=3' });
    expect(a.body).toEqual({ params: { id: 'a b' }, query: { k: ['1', '2'], z: '3' } });
    const b = await r.handle({ method: 'POST', url: '/api/y', body: {} });
    expect(b).toEqual({ status: 201, headers: { 'x-a': '1' }, body: { ok: true } });
  });
});

describe('ids', () => {
  it('sort in the order they were made, even within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
