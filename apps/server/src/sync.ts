import type { Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';
import { hubConfigFromEnv, hubLabel, openHub, type HubConfig } from './sync/hub';
import { joinFromHub, type JoinMode } from './sync/join';
import { registerSyncRoutes } from './sync/routes';
import { getState } from './sync/state';
import { SyncWorker, type WorkerOptions } from './sync/worker';

/**
 * Cloud replica sync (Turso), joining a new computer from the replica, device management.
 * Design and limits: docs/07-sync-and-phones.md. Pieces:
 *   sync/hub.ts     connect + hub schema (same migrations + sync_log)
 *   sync/engine.ts  push (outbox → hub) and pull (hub sync_log → local, last-writer-wins)
 *   sync/join.ts    set up a new/replacement computer from the hub
 *   sync/worker.ts  background loop with backoff
 *   sync/routes.ts  /api/sync/*, /api/devices, /api/network
 */

/** One worker per open database (tests run several in one process). */
const workers = new WeakMap<Db, SyncWorker>();

export function registerSync(app: FastifyInstance, db: Db, deviceId: string): void {
  registerSyncRoutes(app, db, deviceId, () => workers.get(db));
}

export interface JoinEnvOptions {
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

/**
 * Called before first-run setup. Joins only when TULA_JOIN is "new" or "replace", sync is
 * configured, and this database has no device yet. Returns true when it joined (setup is
 * then skipped). Throws with a plain message when asked to join but it cannot — starting a
 * fresh, empty business instead would be worse.
 */
export async function maybeJoin(db: Db, opts: JoinEnvOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  const mode = env.TULA_JOIN?.trim().toLowerCase();
  if (!mode) return false;
  if (mode !== 'new' && mode !== 'replace') throw new Error(`TULA_JOIN must be "new" or "replace" (got "${env.TULA_JOIN}")`);
  if (await getState(db, 'device_id')) {
    log('sync: TULA_JOIN is set but this computer is already set up; ignoring it. Remove TULA_JOIN from the settings file.');
    return false;
  }
  const cfg = hubConfigFromEnv(env);
  if (!cfg) throw new Error('TULA_JOIN needs the cloud copy: set TULA_SYNC_URL (and TULA_SYNC_TOKEN) as well.');
  const hub = await openHub(cfg);
  try {
    log(`sync: joining from the cloud copy at ${hub.label} (mode: ${mode})…`);
    await joinFromHub(db, hub, { mode: mode as JoinMode, replaceDeviceId: env.TULA_JOIN_DEVICE?.trim(), name: env.TULA_DEVICE_NAME, log });
    return true;
  } finally {
    hub.close();
  }
}

export interface StartSyncOptions extends WorkerOptions {
  /** defaults to TULA_SYNC_URL / TULA_SYNC_TOKEN from the environment */
  config?: HubConfig | null;
}

/** Background sync worker, started after the server is listening. Does nothing unless sync is configured. */
export function startSync(db: Db, opts: StartSyncOptions = {}): () => void {
  const cfg = opts.config === undefined ? hubConfigFromEnv() : opts.config;
  if (!cfg) return () => {};
  workers.get(db)?.stop();
  const w = new SyncWorker(db, cfg, opts).start();
  workers.set(db, w);
  (opts.log ?? console.log)(`sync: copying changes to the cloud copy at ${hubLabel(cfg.url)}`);
  return () => {
    w.stop();
    if (workers.get(db) === w) workers.delete(db);
  };
}

/** The running worker for a database, if any (tests). */
export const syncWorkerOf = (db: Db) => workers.get(db);
