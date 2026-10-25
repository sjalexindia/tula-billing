import type { Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';

/** Backup and restore, health, and anything the auto-start service needs. */
export function registerOps(_app: FastifyInstance, _db: Db, _deviceId: string): void {
  // filled in by this module's owner
}

/** Background jobs started after the server is listening (e.g. scheduled backups). Return a stop function. */
export function startOpsJobs(_db: Db, _opts: { dbFile: string }): () => void {
  return () => {};
}
