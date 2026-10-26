import { migrate, type Db, type Migration } from '@tula/db';
import { registerApi } from '@tula/server/api';
import { localDeviceId } from '@tula/server/context';
import { openHub, type HubConfig, type HubDriver } from '@tula/server/sync/hub';
import { joinFromHub, type JoinResult } from '@tula/server/sync/join';
import { registerSyncRoutes } from '@tula/server/sync/routes';
import { getState } from '@tula/server/sync/state';
import { SyncWorker, type WorkerOptions } from '@tula/server/sync/worker';
import { LocalRouter } from './router';

/*
 * Tula running on the phone itself: its own database, the shop computer's API routes answering
 * in-process, and the sync worker copying changes to and from the cloud copy whenever there is
 * internet. Runtime-neutral (no DOM): phone.ts supplies the browser pieces, tests supply Node ones.
 */

export interface PhoneRuntime {
  router: LocalRouter;
  deviceId: string;
  worker: SyncWorker | null;
  stop(): void;
}

/** Bring a freshly opened phone database up to this version of Tula. */
export async function prepareDb(db: Db, migrations: Migration[]): Promise<void> {
  await db.execute('PRAGMA foreign_keys = ON');
  await migrate(db, migrations);
}

/** True once this phone has joined a business (it then has a device id). */
export const isJoined = async (db: Db) => !!(await getState(db, 'device_id'));

/**
 * First run: copy the business from the cloud copy and become a new phone device with its own
 * bill series (M1, M2…). The phone needs internet for this step only.
 */
export async function joinBusiness(db: Db, cfg: HubConfig, driver: HubDriver, name?: string, log?: (m: string) => void): Promise<JoinResult> {
  const hub = await openHub(cfg, driver);
  try {
    return await joinFromHub(db, hub, { mode: 'new', kind: 'phone', name, log });
  } finally {
    hub.close();
  }
}

export async function startRuntime(db: Db, opts: { hub: HubConfig | null; driver: HubDriver; worker?: WorkerOptions }): Promise<PhoneRuntime> {
  const deviceId = await localDeviceId(db);
  const router = new LocalRouter();
  registerApi(router, db, deviceId);
  const worker = opts.hub ? new SyncWorker(db, opts.hub, opts.driver, opts.worker).start() : null;
  registerSyncRoutes(router, db, deviceId, () => worker ?? undefined);
  return { router, deviceId, worker, stop: () => worker?.stop() };
}
