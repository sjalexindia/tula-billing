import { openDb, type Db } from '@tula/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app';
import { setup, type SetupOptions } from '../src/setup';

export type Res = Awaited<ReturnType<FastifyInstance['inject']>>;
export type Call = (o: string | InjectOptions) => Promise<Res>;
export interface Booted { db: Db; app: FastifyInstance; call: Call; token: string }

/** Fresh in-memory business, signed in as the owner (who has already replaced the first-run PIN). */
export async function bootSignedIn(opts: SetupOptions = {}): Promise<Booted> {
  const db = await openDb(':memory:');
  await setup(db, opts);
  const app = await buildApp(db);
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
