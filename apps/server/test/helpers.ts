import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Db } from '@tula/db';
import { loadMigrations, openDb } from '@tula/db/node';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { prepareDb, startRuntime } from '../../web/src/local/runtime';
import { createSqliteClient } from '../../web/src/local/sqlite-client';
import { directBackend } from '../../web/src/local/sqlite-direct';
import { buildApp } from '../src/app';
import { setup, type SetupOptions } from '../src/setup';
import { nodeHubDriver } from '../src/sync/node-hub';

export type Res = Awaited<ReturnType<FastifyInstance['inject']>>;
export type Call = (o: string | InjectOptions) => Promise<Res>;
export interface Booted { db: Db; app: FastifyInstance; call: Call; token: string }

/**
 * TULA_TEST_PHONE=1 runs the same tests on the phone app's stack: SQLite WebAssembly behind the
 * libSQL-compatible client, and the API on the in-process router instead of Fastify
 * (`npm run test:phone`). It proves the phone gives the same answers as the shop computer.
 */
const onPhone = process.env.TULA_TEST_PHONE === '1';

async function phoneApp(db: Db): Promise<FastifyInstance> {
  const { router } = await startRuntime(db, { hub: null, driver: nodeHubDriver });
  const inject = async (o: string | InjectOptions) => {
    const opts = typeof o === 'string' ? { url: o } : o;
    const res = await router.handle({
      method: opts.method ?? 'GET', url: String(opts.url),
      headers: opts.headers as Record<string, string> | undefined, body: opts.payload,
    });
    const binary = res.body instanceof Uint8Array;
    const body = binary || res.body === undefined ? '' : JSON.stringify(res.body);
    return {
      statusCode: res.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...res.headers },
      body,
      rawPayload: binary ? Buffer.from(res.body as Uint8Array) : Buffer.from(body),
      json: () => JSON.parse(body),
    };
  };
  return { inject } as unknown as FastifyInstance;
}

async function freshDb(): Promise<Db> {
  if (!onPhone) return openDb(':memory:');
  const sqlite3 = await sqlite3InitModule();
  const db = createSqliteClient(directBackend(sqlite3, new sqlite3.oo1.DB(':memory:', 'c')));
  await prepareDb(db, loadMigrations());
  return db;
}

/** Fresh in-memory business, signed in as the owner (who has already replaced the first-run PIN). */
export async function bootSignedIn(opts: SetupOptions = {}): Promise<Booted> {
  const db = await freshDb();
  await setup(db, opts);
  const app = onPhone ? await phoneApp(db) : await buildApp(db);
  const users = (await app.inject('/api/auth/users')).json();
  const owner = users.find((u: { role: string }) => u.role === 'owner');
  const login = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin: '1234' } })).json();
  const token = login.token as string;
  await app.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${token}` }, payload: { currentPin: '1234', newPin: '4826' } });
  return { db, app, token, call: callAs(app, token) };
}

export const callAs = (app: FastifyInstance, token: string): Call => (o: string | InjectOptions) => {
  const opts: InjectOptions = typeof o === 'string' ? { url: o } : o;
  return app.inject({ ...opts, headers: { ...(opts.headers ?? {}), authorization: `Bearer ${token}` } });
};
