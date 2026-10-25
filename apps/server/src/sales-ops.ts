import type { Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';

/** Cancel bills, sales returns (credit notes), customer receipts, outstanding and statements. */
export function registerSalesOps(_app: FastifyInstance, _db: Db, _deviceId: string): void {
  // filled in by this module's owner
}
