import { Preferences } from '@capacitor/preferences';
import { createClient } from '@libsql/client/web';
import type { Db, Migration } from '@tula/db';
import { openHub, type HubConfig, type HubDriver } from '@tula/server/sync/hub';
import { setRunsLocally, setTransport } from '../platform';
import { isJoined, joinBusiness, prepareDb, startRuntime, type PhoneRuntime } from './runtime';
import { createSqliteClient } from './sqlite-client';
import { openWorkerBackend } from './sqlite-worker';

/*
 * Browser side of "Tula on this phone": the database in a worker, the cloud copy over HTTPS,
 * the settings kept in the app's private storage, and the bridge that answers the web app's
 * /api calls from the in-app router instead of the network.
 */

const sql = import.meta.glob<string>('../../../../packages/db/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
const MIGRATIONS: Migration[] = Object.entries(sql).map(([path, text]) => ({ name: path.split('/').pop()!, sql: text }));

/** The cloud copy (Turso) over HTTPS: libsql:// addresses are spoken over https by the web client. */
export const webHubDriver: HubDriver = {
  connect: (cfg) => createClient({ url: cfg.url, authToken: cfg.token }),
  migrations: () => MIGRATIONS,
};

// ---------- settings kept on the phone (app-private; Preferences uses localStorage in a desktop browser) ----------
export type PhoneMode = 'anywhere' | 'computer';
const MODE = 'tula.mode';
const HUB_URL = 'tula.hub.url';
const HUB_TOKEN = 'tula.hub.token';
const SESSION = 'tula.session';

const get = async (key: string) => (await Preferences.get({ key })).value;
const put = (key: string, value: string | null) => (value === null ? Preferences.remove({ key }) : Preferences.set({ key, value }));

export const getMode = async () => (await get(MODE)) as PhoneMode | null;
export const setMode = (m: PhoneMode | null) => put(MODE, m);

export async function getHub(): Promise<HubConfig | null> {
  const url = await get(HUB_URL);
  return url ? { url, token: (await get(HUB_TOKEN)) ?? undefined } : null;
}
export async function setHub(cfg: HubConfig) {
  await put(HUB_URL, cfg.url.trim());
  await put(HUB_TOKEN, cfg.token?.trim() || null);
}

// ---------- the database ----------
let db: Db | null = null;

/** Open (or create) the phone's database and bring it up to this version. */
export async function openPhoneDb(): Promise<Db> {
  if (db) return db;
  const backend = await openWorkerBackend('/tula.db');
  const client = createSqliteClient(backend);
  await prepareDb(client, MIGRATIONS);
  db = client;
  return client;
}

export const phoneIsJoined = async () => isJoined(await openPhoneDb());

/** First run: copy the business from the cloud copy. Saves the address and token only once it worked. */
export async function joinFromCloud(cfg: HubConfig, name?: string) {
  const d = await openPhoneDb();
  const r = await joinBusiness(d, cfg, webHubDriver, name);
  await setHub(cfg);
  await setMode('anywhere');
  return r;
}

/** A new access token (after it was rotated): check it reaches the cloud copy, save it, restart. */
export async function changeHub(cfg: HubConfig) {
  (await openHub(cfg, webHubDriver)).close();
  await setHub(cfg);
  location.reload();
}

/** Leave this phone's data in place and open Tula from the shop computer instead. */
export async function useShopComputer() {
  await setMode('computer');
  location.href = 'connect/index.html';
}

// ---------- running ----------
let runtime: PhoneRuntime | null = null;

/** Start Tula on this phone and point the web app's /api calls at it. */
export async function startOnPhone(): Promise<PhoneRuntime> {
  if (runtime) return runtime;
  const d = await openPhoneDb();
  runtime = await startRuntime(d, { hub: await getHub(), driver: webHubDriver });
  const router = runtime.router;
  let token = (await get(SESSION)) ?? '';

  setTransport(async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    if (token) headers.authorization = `Bearer ${token}`;
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    const res = await router.handle({ method: init?.method ?? 'GET', url, headers, body });
    // the session lives here instead of a cookie
    if (url === '/api/auth/login') {
      if (res.status === 200) {
        token = String((res.body as { token?: string }).token ?? '');
        await put(SESSION, token);
      }
    } else if (url === '/api/auth/logout' || res.status === 401) {
      token = '';
      await put(SESSION, null);
    }
    const text = res.body === undefined ? '' : JSON.stringify(res.body);
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json', ...res.headers } });
  });
  setRunsLocally(true);

  // copy changes as soon as the app comes back to the front (Android pauses timers in the background)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void runtime?.worker?.runNow();
  });
  return runtime;
}
