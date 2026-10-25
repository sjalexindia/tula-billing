import type { Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';

/** Purchase bills, purchase returns (debit notes), supplier payments, expenses, stock corrections. */
export function registerPurchases(_app: FastifyInstance, _db: Db, _deviceId: string): void {
  // filled in by this module's owner
}
