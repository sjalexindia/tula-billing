import type { Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';

/** Registers, day book, stock valuation, profit and loss, profit by bill/customer/item, GST return exports. */
export function registerReports(_app: FastifyInstance, _db: Db, _deviceId: string): void {
  // filled in by this module's owner
}
