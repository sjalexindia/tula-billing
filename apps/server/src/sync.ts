import type { Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';

/** Cloud replica sync (Turso), joining a new computer from the replica, device management. */
export function registerSync(_app: FastifyInstance, _db: Db, _deviceId: string): void {
  // filled in by this module's owner
}

/**
 * Called before first-run setup. If this computer should join an existing business from the cloud
 * replica instead of starting a new one, do that here and return true (setup is then skipped).
 */
export async function maybeJoin(_db: Db): Promise<boolean> {
  return false;
}

/** Background sync worker, started after the server is listening. Return a stop function. */
export function startSync(_db: Db): () => void {
  return () => {};
}
