import { all, getSettings, insert, one, softDelete, update, type Db } from '@tula/db';
import { openDb } from '@tula/db/node';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { setup } from '../src/setup';
import { maybeJoin, startSync, syncWorkerOf } from '../src/sync';
import { pull, push, syncOnce } from '../src/sync/engine';
import { openHub, type Hub } from '../src/sync/hub';
import { nodeHubDriver } from '../src/sync/node-hub';
import { nextComputerCode } from '../src/sync/join';
import { callAs, type Call } from './helpers';

/**
 * Two shop computers (A, B) and a hub, all local libSQL files. The hub stands in for Turso:
 * the client API is the same; only the URL differs (file: instead of libsql://…turso.io).
 */
const dir = mkdtempSync(join(tmpdir(), 'tula-sync-'));
const hubUrl = `file:${join(dir, 'hub.db')}`;
const quiet = () => {};

interface Node { db: Db; app: FastifyInstance; call: Call; deviceId: string }

async function signIn(app: FastifyInstance, pin: string, newPin?: string): Promise<Call> {
  const users = (await app.inject('/api/auth/users')).json();
  const owner = users.find((u: { role: string }) => u.role === 'owner');
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin } });
  expect(login.statusCode).toBe(200);
  const token = login.json().token as string;
  if (newPin) await app.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${token}` }, payload: { currentPin: pin, newPin } });
  return callAs(app, token);
}

async function node(db: Db, pin: string, newPin?: string): Promise<Node> {
  const app = await buildApp(db);
  const call = await signIn(app, pin, newPin);
  const deviceId = (await one<{ value: string }>(db, "SELECT value FROM sync_state WHERE key = 'device_id'"))!.value;
  return { db, app, call, deviceId };
}

const count = async (db: Db | Hub['client'], sql: string, args: Array<string | number> = []) =>
  Number((await db.execute({ sql, args })).rows[0]![0]);
const outbox = (db: Db) => count(db, 'SELECT COUNT(*) FROM sync_outbox');
const sync = (n: Node) => syncOnce(n.db, hub, n.deviceId);

async function makeBill(n: Node, bundles = '1') {
  const catalog = (await n.call('/api/catalog')).json() as Array<{ id: string; sku: string }>;
  const parties = (await n.call('/api/parties')).json() as Array<{ id: string; is_walk_in: number }>;
  const res = await n.call({
    method: 'POST', url: '/api/bills',
    payload: { partyId: parties.find((p) => p.is_walk_in)!.id, lines: [{ productId: catalog.find((p) => p.sku === 'TMT-12')!.id, entry: { BDL: bundles } }], payment: { mode: 'cash', amount: '100' } },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; docNo: string };
}

let hub: Hub;
let A: Node;
let B: Node;

beforeAll(async () => {
  const dbA = await openDb(`file:${join(dir, 'a.db')}`);
  await setup(dbA, { preset: 'building-materials', demo: true });
  A = await node(dbA, '1234', '4826');
  hub = await openHub({ url: hubUrl }, nodeHubDriver);
});

afterAll(() => {
  hub?.close();
  A?.db.close();
  B?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cloud replica sync', () => {
  it('pushes everything from A, including a bill, to the hub copy and change log', async () => {
    const bill = await makeBill(A);
    const pending = await outbox(A.db);
    expect(pending).toBeGreaterThan(50);

    const r = await push(A.db, hub, A.deviceId);
    expect(r).toEqual({ pushed: pending, rejected: 0 });
    expect(await outbox(A.db)).toBe(0);
    expect(await count(hub.client, 'SELECT COUNT(*) FROM sync_log WHERE device_id = ?', [A.deviceId])).toBe(pending);

    for (const t of ['products', 'parties', 'accounts', 'ledger_entries', 'stock_moves', 'sales_doc_lines', 'users', 'settings', 'audit_log', 'devices']) {
      expect(await count(hub.client, `SELECT COUNT(*) FROM ${t}`), t).toBe(await count(A.db, `SELECT COUNT(*) FROM ${t}`));
    }
    const hubBill = (await hub.client.execute({ sql: 'SELECT doc_no, total_paise FROM sales_docs WHERE id = ?', args: [bill.id] })).rows[0]!;
    expect(hubBill.doc_no).toBe(bill.docNo);
    // the hub's ledger balances too
    const bal = (await hub.client.execute('SELECT SUM(debit_paise) - SUM(credit_paise) FROM ledger_entries WHERE deleted = 0')).rows[0]![0];
    expect(Number(bal)).toBe(0);
  });

  it('re-pushing a batch after a crash (hub committed, outbox not cleared) is harmless', async () => {
    const p = (await A.call('/api/catalog')).json().find((x: { sku: string }) => x.sku === 'TMT-08');
    await update(A.db, 'products', A.deviceId, p.id, { name_en: 'TMT 8 mm (crash test)' });
    const saved = await all(A.db, 'SELECT table_name, row_id, op, payload_json, created_at FROM sync_outbox ORDER BY seq');
    await push(A.db, hub, A.deviceId);
    // simulate the crash: put the same outbox rows back and push again
    for (const r of saved) await A.db.execute({ sql: 'INSERT INTO sync_outbox (table_name, row_id, op, payload_json, created_at) VALUES (?,?,?,?,?)', args: [r.table_name, r.row_id, r.op, r.payload_json, r.created_at] as string[] });
    const before = await count(hub.client, 'SELECT COUNT(*) FROM products');
    const r = await push(A.db, hub, A.deviceId);
    expect(r).toEqual({ pushed: saved.length, rejected: 0 });
    expect(await count(hub.client, 'SELECT COUNT(*) FROM products')).toBe(before);
    expect((await hub.client.execute({ sql: 'SELECT name_en FROM products WHERE id = ?', args: [p.id] })).rows[0]!.name_en).toBe('TMT 8 mm (crash test)');
    expect(await count(A.db, 'SELECT COUNT(*) FROM sync_rejects')).toBe(0);
  });

  it('B joins as a NEW computer: copies everything, gets its own device and series C2', async () => {
    const dbB = await openDb(`file:${join(dir, 'b.db')}`);
    const joined = await maybeJoin(dbB, { env: { TULA_JOIN: 'new', TULA_SYNC_URL: hubUrl, TULA_DEVICE_NAME: 'Back office PC' }, log: quiet });
    expect(joined).toBe(true);
    // the new device row was pushed straight away, and nothing else is pending (signing in below adds an audit row)
    expect(await outbox(dbB)).toBe(0);
    // first-run setup now does nothing
    expect((await setup(dbB, { preset: 'building-materials' })).skipped).toBe(true);
    B = await node(dbB, '4826'); // the owner's own PIN came across with the users table
    expect(B.deviceId).not.toBe(A.deviceId);

    for (const t of ['products', 'parties', 'accounts', 'ledger_entries', 'sales_docs', 'users', 'settings', 'number_series']) {
      expect(await count(B.db, `SELECT COUNT(*) FROM ${t}`), t).toBe(await count(A.db, `SELECT COUNT(*) FROM ${t}`));
    }
    const me = await one<{ series_code: string; name: string; device_id: string }>(B.db, 'SELECT series_code, name, device_id FROM devices WHERE id = ?', [B.deviceId]);
    expect(me).toEqual({ series_code: 'C2', name: 'Back office PC', device_id: B.deviceId });
    expect(await count(hub.client, 'SELECT COUNT(*) FROM devices WHERE id = ?', [B.deviceId])).toBe(1);
    // cursor starts at the hub's end, so B does not re-apply history
    expect(Number((await one<{ value: string }>(B.db, "SELECT value FROM sync_state WHERE key = 'sync.cursor'"))!.value)).toBeGreaterThan(0);

    // A learns about B
    await sync(A);
    expect(((await A.call('/api/devices')).json() as Array<{ id: string }>).map((d) => d.id)).toContain(B.deviceId);
  });

  it('a bill made on B uses its own series and reaches A; pulling never writes B\'s outbox', async () => {
    const bill = await makeBill(B, '2');
    expect(bill.docNo).toMatch(/\/C20001$/);
    await sync(B);
    await sync(A);
    expect(((await A.call(`/api/bills/${bill.id}`)).json()).doc.doc_no).toBe(bill.docNo);

    // A changes many things; B pulls them all without queueing anything to push back
    await makeBill(A);
    await sync(A);
    expect(await outbox(B.db)).toBe(0);
    const r = await pull(B.db, hub, B.deviceId);
    expect(r.applied).toBeGreaterThan(5);
    expect(await outbox(B.db)).toBe(0);
    expect(await count(B.db, 'SELECT COUNT(*) FROM sales_docs')).toBe(await count(A.db, 'SELECT COUNT(*) FROM sales_docs'));
    // stock is derived, so it converges by itself
    const stock = async (n: Node) => (await n.call('/api/stock')).json().find((s: { sku: string }) => s.sku === 'TMT-12').qty_milli;
    expect(await stock(B)).toBe(await stock(A));
  });

  const productId = async () => (await one<{ id: string }>(A.db, "SELECT id FROM products WHERE sku = 'TMT-10'"))!.id;
  const nameOn = async (n: Node, id: string) => (await one<{ name_en: string }>(n.db, 'SELECT name_en FROM products WHERE id = ?', [id]))!.name_en;
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('last writer wins: A edits earlier, B later — B wins on both, whoever syncs first', async () => {
    const id = await productId();
    await update(A.db, 'products', A.deviceId, id, { name_en: 'TMT 10 (A, earlier)' });
    await tick();
    await update(B.db, 'products', B.deviceId, id, { name_en: 'TMT 10 (B, later)' });
    await sync(B); // the later change reaches the hub first
    await sync(A); // the earlier one arrives after it and must not overwrite it
    await sync(B);
    expect(await nameOn(A, id)).toBe('TMT 10 (B, later)');
    expect(await nameOn(B, id)).toBe('TMT 10 (B, later)');
    expect((await hub.client.execute({ sql: 'SELECT name_en FROM products WHERE id = ?', args: [id] })).rows[0]!.name_en).toBe('TMT 10 (B, later)');
  });

  it('last writer wins: B edits earlier, A later — A wins on both', async () => {
    const id = await productId();
    await update(B.db, 'products', B.deviceId, id, { name_en: 'TMT 10 (B, earlier)' });
    await tick();
    await update(A.db, 'products', A.deviceId, id, { name_en: 'TMT 10 (A, later)' });
    await sync(A);
    await sync(B);
    await sync(A);
    expect(await nameOn(A, id)).toBe('TMT 10 (A, later)');
    expect(await nameOn(B, id)).toBe('TMT 10 (A, later)');
  });

  it('settings sync', async () => {
    const res = await A.call({ method: 'PUT', url: '/api/settings', payload: { 'business.name_en': 'Synced Traders' } });
    expect(res.statusCode).toBe(200);
    await sync(A);
    await sync(B);
    expect((await getSettings(B.db))['business.name_en']).toBe('Synced Traders');
    expect((await B.call('/api/public')).json().name_en).toBe('Synced Traders');
  });

  it('soft deletes sync', async () => {
    const id = await insert(A.db, 'parties', A.deviceId, { party_type: 'customer', name_en: 'Short-lived Co', state_code: '33' });
    await sync(A);
    await sync(B);
    expect((await one<{ deleted: number }>(B.db, 'SELECT deleted FROM parties WHERE id = ?', [id]))!.deleted).toBe(0);
    expect(await softDelete(A.db, 'parties', A.deviceId, 'id = ?', [id])).toBe(1);
    await sync(A);
    await sync(B);
    expect((await one<{ deleted: number }>(B.db, 'SELECT deleted FROM parties WHERE id = ?', [id]))!.deleted).toBe(1);
  });

  it('a change the hub refuses (duplicate daily rate) is set aside, the rest keeps flowing', async () => {
    const date = '2030-01-01';
    await insert(A.db, 'daily_rates', A.deviceId, { rate_group: 'TMT', rate_date: date, rate_paise: 6000 });
    await insert(B.db, 'daily_rates', B.deviceId, { rate_group: 'TMT', rate_date: date, rate_paise: 6100 });
    const other = await insert(B.db, 'parties', B.deviceId, { party_type: 'customer', name_en: 'After the clash', state_code: '33' });
    await sync(A);
    const r = await sync(B);
    expect(r.rejected).toBe(2); // B's own rate refused by the hub + A's rate clashing with it on B
    expect(await outbox(B.db)).toBe(0);
    expect(await count(B.db, "SELECT COUNT(*) FROM sync_rejects WHERE direction = 'push' AND table_name = 'daily_rates'")).toBe(1);
    expect(await count(hub.client, 'SELECT COUNT(*) FROM parties WHERE id = ?', [other])).toBe(1);
    // A's version is pulled by B but clashes locally with B's own row: set aside, not stuck
    expect(await count(B.db, "SELECT COUNT(*) FROM sync_rejects WHERE direction = 'pull'")).toBe(1);
    expect((await B.call('/api/sync/status')).json().rejected).toBe(2);
  });

  it('device rename and "mark as lost"; a lost computer stops syncing', async () => {
    expect((await A.call({ method: 'PUT', url: `/api/devices/${A.deviceId}`, payload: { revoked: true } })).statusCode).toBe(400);
    expect((await A.call({ method: 'PUT', url: `/api/devices/${B.deviceId}`, payload: { name: 'Old back office PC', revoked: true } })).statusCode).toBe(200);
    await sync(A);
    await sync(B); // B learns it was marked lost
    await expect(sync(B)).rejects.toMatchObject({ code: 'REVOKED' });
    // undo, so the other tests keep a working B
    expect((await A.call({ method: 'PUT', url: `/api/devices/${B.deviceId}`, payload: { revoked: false } })).statusCode).toBe(200);
    await sync(A);
    await B.db.execute({ sql: 'UPDATE devices SET revoked = 0 WHERE id = ?', args: [B.deviceId] }); // as an owner would after re-joining
    await sync(B);
    const list = (await B.call('/api/devices')).json() as Array<{ id: string; name: string; this_device: boolean }>;
    expect(list.find((d) => d.id === B.deviceId)).toMatchObject({ name: 'Old back office PC', this_device: true });
  });

  it('replace refuses without a valid TULA_JOIN_DEVICE, and takes over the device id with one', async () => {
    const env = { TULA_JOIN: 'replace', TULA_SYNC_URL: hubUrl };
    const dbC = await openDb(`file:${join(dir, 'c.db')}`);
    try {
      await expect(maybeJoin(dbC, { env, log: quiet })).rejects.toThrow(/TULA_JOIN_DEVICE/);
      await expect(maybeJoin(dbC, { env: { ...env, TULA_JOIN_DEVICE: 'not-a-device' }, log: quiet })).rejects.toThrow(/TULA_JOIN_DEVICE/);
      expect(await one(dbC, "SELECT value FROM sync_state WHERE key = 'device_id'")).toBeUndefined();
      expect(await count(dbC, 'SELECT COUNT(*) FROM products')).toBe(0);
      await expect(maybeJoin(dbC, { env: { TULA_JOIN: 'new' }, log: quiet })).rejects.toThrow(/TULA_SYNC_URL/);

      expect(await maybeJoin(dbC, { env: { ...env, TULA_JOIN_DEVICE: A.deviceId }, log: quiet })).toBe(true);
      const dev = (await one<{ value: string }>(dbC, "SELECT value FROM sync_state WHERE key = 'device_id'"))!.value;
      expect(dev).toBe(A.deviceId);
      expect(await count(dbC, 'SELECT COUNT(*) FROM sales_docs')).toBe(await count(A.db, 'SELECT COUNT(*) FROM sales_docs'));
      // the same invoice series continues: next number on C follows A's last one
      const lastA = await one<{ next_no: number }>(A.db, "SELECT next_no FROM number_series WHERE doc_type = 'INV' AND owner_device = ?", [A.deviceId]);
      const onC = await one<{ next_no: number }>(dbC, "SELECT next_no FROM number_series WHERE doc_type = 'INV' AND owner_device = ?", [A.deviceId]);
      expect(onC).toEqual(lastA);
      // already set up: a second join is ignored
      expect(await maybeJoin(dbC, { env: { ...env, TULA_JOIN_DEVICE: A.deviceId }, log: quiet })).toBe(false);
    } finally {
      dbC.close();
    }
  });

  it('the worker survives a broken hub, records the error and backs off', async () => {
    const dbW = await openDb(`file:${join(dir, 'w.db')}`);
    try {
      await setup(dbW, {});
      const logs: string[] = [];
      const stop = startSync(dbW, { config: { url: 'http://127.0.0.1:9', token: 'tok-SECRET-123' }, pollMs: 60_000, log: (m) => logs.push(m) });
      const w = syncWorkerOf(dbW)!;
      const r1 = await w.runNow();
      expect(r1.ok).toBe(false);
      const r2 = await w.runNow();
      expect(r2.ok).toBe(false);
      expect(w.consecutiveFailures).toBeGreaterThanOrEqual(2);
      const err = await one<{ value: string }>(dbW, "SELECT value FROM sync_state WHERE key = 'sync.last_error_code'");
      expect(err!.value).toBe('OFFLINE');
      expect(logs.join('\n')).not.toContain('tok-SECRET-123');
      // the same error is logged once, not on every retry
      expect(logs.filter((l) => l.includes('Cannot reach')).length).toBe(1);
      stop();
      expect((await w.runNow()).ok).toBe(false); // stopped workers do nothing and do not throw

      const bad = startSync(dbW, { config: { url: 'not a url' }, pollMs: 60_000, log: quiet });
      expect((await syncWorkerOf(dbW)!.runNow()).ok).toBe(false);
      expect((await one<{ value: string }>(dbW, "SELECT value FROM sync_state WHERE key = 'sync.last_error_code'"))!.value).toBe('BAD_URL');
      bad();
    } finally {
      dbW.close();
    }
  });

  it('the worker syncs on its own after local activity', async () => {
    const stop = startSync(A.db, { config: { url: hubUrl }, pollMs: 20, activityDelayMs: 50, intervalMs: 60_000, log: quiet });
    try {
      const w = syncWorkerOf(A.db)!;
      await w.runNow();
      await insert(A.db, 'parties', A.deviceId, { party_type: 'customer', name_en: 'Worker Co', state_code: '33' });
      expect(await outbox(A.db)).toBeGreaterThan(0);
      for (let i = 0; i < 100 && (await outbox(A.db)) > 0; i++) await new Promise((r) => setTimeout(r, 20));
      await w.idle();
      expect(await outbox(A.db)).toBe(0);
      expect(await count(hub.client, "SELECT COUNT(*) FROM parties WHERE name_en = 'Worker Co'")).toBe(1);
    } finally {
      stop();
    }
  });

  it('status shows the hub host only, never the token; "Sync now" works for the owner', async () => {
    const token = 'eyJhbGciOi-very-secret-token';
    const stop = startSync(A.db, { config: { url: `${hubUrl}?authToken=${token}`, token }, pollMs: 60_000, log: quiet });
    try {
      const now = await A.call({ method: 'POST', url: '/api/sync/now', payload: {} });
      const s = await A.call('/api/sync/status');
      expect(s.statusCode).toBe(200);
      for (const body of [s.body, now.body]) {
        expect(body).not.toContain(token);
        expect(body).not.toContain('authToken');
      }
      const st = s.json();
      expect(st).toMatchObject({ configured: true, running: true, hub: 'file hub.db', pending: 0, device: { id: A.deviceId, seriesCode: '' } });
      expect(st.lastPushAt).toBeTruthy();
    } finally {
      stop();
    }
    expect((await A.call({ method: 'POST', url: '/api/sync/now', payload: {} })).statusCode).toBe(409);
    expect(nextComputerCode(['', 'C2', 'C3'])).toBe('C4');
  });

  it('network lists LAN addresses with full URLs', async () => {
    const r = (await A.call('/api/network')).json();
    expect(typeof r.port).toBe('number');
    for (const a of r.addresses) expect(a.url).toBe(`http://${a.address}:${r.port}`);
  });

  it('billing staff cannot see or run sync or change devices', async () => {
    expect((await A.call({ method: 'POST', url: '/api/users', payload: { name: 'Counter', role: 'billing', pin: '2468' } })).statusCode).toBe(201);
    const users = (await A.app.inject('/api/auth/users')).json();
    const u = users.find((x: { name: string }) => x.name === 'Counter');
    const token = (await A.app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin: '2468' } })).json().token;
    const staff = callAs(A.app, token);
    await staff({ method: 'POST', url: '/api/auth/pin', payload: { currentPin: '2468', newPin: '8642' } });
    expect((await staff('/api/sync/status')).statusCode).toBe(403);
    expect((await staff('/api/devices')).statusCode).toBe(403);
    expect((await staff('/api/network')).statusCode).toBe(403);
    expect((await staff({ method: 'POST', url: '/api/sync/now', payload: {} })).statusCode).toBe(403);
    expect((await staff({ method: 'PUT', url: `/api/devices/${B.deviceId}`, payload: { name: 'x' } })).statusCode).toBe(403);
  });
});
