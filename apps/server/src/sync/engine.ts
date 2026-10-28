import type { InStatement } from '@libsql/client';
import { nowIso, type Db } from '@tula/db';
import type { Hub } from './hub';
import { isConstraintError, rows, syncedTables, upsertStmt, type Row, type Runner, type TableInfo } from './schema';
import { clearError, getState, setState, SyncError } from './state';

export const PUSH_BATCH = 200;
export const PULL_PAGE = 500;

interface OutboxRow { seq: number; table_name: string; row_id: string; op: string; payload_json: string }

async function reject(ex: Runner, direction: 'push' | 'pull', table: string, rowId: string, payload: string, error: unknown) {
  await ex.execute({
    sql: 'INSERT INTO sync_rejects (direction, table_name, row_id, payload_json, error, at) VALUES (?,?,?,?,?,?)',
    args: [direction, table, rowId, payload, String((error as Error)?.message ?? error).slice(0, 500), nowIso()],
  });
}

const logStmt = (deviceId: string, r: OutboxRow, at: string): InStatement => ({
  sql: 'INSERT INTO sync_log (device_id, table_name, row_id, op, payload_json, received_at) VALUES (?,?,?,?,?,?)',
  args: [deviceId, r.table_name, r.row_id, r.op, r.payload_json, at],
});

/** Statements that apply one outbox row to the hub: LWW upsert of the hub's copy + append to sync_log. */
function hubStatements(hub: Hub, deviceId: string, r: OutboxRow, at: string): InStatement[] | Error {
  const t = hub.tables.get(r.table_name);
  if (!t) return new Error(`The cloud copy has no table ${r.table_name}`);
  let payload: Row;
  try {
    payload = JSON.parse(r.payload_json) as Row;
  } catch (e) {
    return e as Error;
  }
  const up = upsertStmt(t, payload);
  if (!up) return new Error('Change has no key');
  return [up, logStmt(deviceId, r, at)];
}

/**
 * Push local sync_outbox to the hub, oldest first, in batches. Each batch is ONE hub
 * batch(…, 'write') — atomic, over HTTP too — and only after it succeeds are those outbox
 * rows deleted here. If the computer dies between the two, the batch is pushed again:
 * the upserts are idempotent (same row, same updated_at) and the duplicate sync_log
 * entries are harmless because every apply is last-writer-wins.
 *
 * A batch the hub refuses because of a constraint (e.g. two computers created the same
 * daily rate under different ids) is retried row by row; rows that still fail go to the
 * local sync_rejects table so the rest keeps flowing. Network errors are thrown.
 */
export async function push(db: Db, hub: Hub, deviceId: string, batchSize = PUSH_BATCH): Promise<{ pushed: number; rejected: number }> {
  let pushed = 0;
  let rejected = 0;
  for (;;) {
    const batch = (await rows(db, 'SELECT seq, table_name, row_id, op, payload_json FROM sync_outbox ORDER BY seq LIMIT ?', [batchSize])) as unknown as OutboxRow[];
    if (!batch.length) break;
    const at = nowIso();
    const stmts: InStatement[] = ['PRAGMA defer_foreign_keys = ON'];
    const bad: Array<[OutboxRow, Error]> = [];
    for (const r of batch) {
      const s = hubStatements(hub, deviceId, r, at);
      if (s instanceof Error) bad.push([r, s]);
      else stmts.push(...s);
    }
    try {
      await hub.client.batch(stmts, 'write');
      for (const [r, err] of bad) await reject(db, 'push', r.table_name, r.row_id, r.payload_json, err);
      rejected += bad.length;
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      rejected += await pushOneByOne(db, hub, deviceId, batch);
    }
    const last = batch[batch.length - 1]!.seq;
    await db.execute({ sql: 'DELETE FROM sync_outbox WHERE seq <= ?', args: [last] });
    pushed += batch.length;
  }
  await setState(db, 'sync.last_push_at', nowIso());
  return { pushed, rejected };
}

async function pushOneByOne(db: Db, hub: Hub, deviceId: string, batch: OutboxRow[]): Promise<number> {
  let rejected = 0;
  for (const r of batch) {
    const s = hubStatements(hub, deviceId, r, nowIso());
    try {
      if (s instanceof Error) throw s;
      await hub.client.batch(['PRAGMA defer_foreign_keys = ON', ...s], 'write');
    } catch (e) {
      if (!(s instanceof Error) && !isConstraintError(e)) {
        // a network failure part-way: forget what is already on the hub, keep the rest for next time
        await db.execute({ sql: 'DELETE FROM sync_outbox WHERE seq < ?', args: [r.seq] });
        throw e;
      }
      await reject(db, 'push', r.table_name, r.row_id, r.payload_json, e);
      rejected++;
    }
  }
  return rejected;
}

interface LogRow { seq: number; table_name: string; row_id: string; op: string; payload_json: string }

/**
 * Pull other devices' changes from the hub's sync_log (seq > cursor), page by page.
 *
 * THE ONE ALLOWED EXCEPTION to "write synced tables only through insert/update/softDelete":
 * pulled rows are written here with raw SQL so they do NOT go into this computer's
 * sync_outbox (they came from the hub; pushing them back would echo forever). The same
 * last-writer-wins rule on updated_at as the hub is applied. Each page is one local
 * transaction that also advances sync.cursor, so a crash never applies a page twice
 * or skips one (and applying twice would be harmless anyway).
 */
export async function pull(db: Db, hub: Hub, deviceId: string, pageSize = PULL_PAGE): Promise<{ applied: number; rejected: number }> {
  const local = await syncedTables(db);
  let applied = 0;
  let rejected = 0;
  for (;;) {
    const cursor = Number((await getState(db, 'sync.cursor')) ?? 0);
    let page = (await rows(hub.client, 'SELECT seq, table_name, row_id, op, payload_json FROM sync_log WHERE seq > ? AND device_id != ? ORDER BY seq LIMIT ?', [cursor, deviceId, pageSize])) as unknown as LogRow[];
    if (!page.length) break;
    const unknownAt = page.findIndex((r) => !local.has(r.table_name));
    let stopAfter = false;
    if (unknownAt >= 0) {
      page = page.slice(0, unknownAt);
      stopAfter = true;
    }
    if (page.length) {
      try {
        rejected += await applyPage(db, local, page, true);
      } catch {
        rejected += await applyRowByRow(db, local, page);
      }
      applied += page.length;
    }
    if (stopAfter) {
      throw new SyncError('UPDATE_APP', 'Another computer is on a newer version of Tula. Update Tula on this computer to receive its changes.');
    }
    if (page.length < pageSize) break;
  }
  await setState(db, 'sync.last_pull_at', nowIso());
  return { applied, rejected };
}

async function applyPage(db: Db, local: Map<string, TableInfo>, page: LogRow[], deferFk: boolean): Promise<number> {
  const tx = await db.transaction('write');
  let rejected = 0;
  try {
    if (deferFk) await tx.execute('PRAGMA defer_foreign_keys = ON');
    for (const r of page) {
      const t = local.get(r.table_name)!;
      let stmt: InStatement | null = null;
      try {
        stmt = upsertStmt(t, JSON.parse(r.payload_json) as Row);
        if (!stmt) throw new Error('Change has no key');
        await tx.execute(stmt);
      } catch (e) {
        // A single statement failing (e.g. UNIQUE) is rolled back by SQLite on its own; the transaction goes on.
        // A payload that cannot be read at all (no statement) is set aside too.
        if (stmt && !isConstraintError(e)) throw e;
        await reject(tx, 'pull', r.table_name, r.row_id, r.payload_json, e);
        rejected++;
      }
    }
    await setState(tx, 'sync.cursor', page[page.length - 1]!.seq);
    await tx.commit();
    return rejected;
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

/** Fallback when a page cannot commit (e.g. a deferred foreign key): one row per transaction, refused rows set aside. */
async function applyRowByRow(db: Db, local: Map<string, TableInfo>, page: LogRow[]): Promise<number> {
  let rejected = 0;
  for (const r of page) {
    try {
      rejected += await applyPage(db, local, [r], false);
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      await reject(db, 'pull', r.table_name, r.row_id, r.payload_json, e);
      await setState(db, 'sync.cursor', r.seq);
      rejected++;
    }
  }
  return rejected;
}

export async function pendingCount(db: Db): Promise<number> {
  const r = await db.execute('SELECT COUNT(*) FROM sync_outbox');
  return Number(r.rows[0]?.[0] ?? 0);
}

export async function isRevoked(db: Db, deviceId: string): Promise<boolean> {
  const r = await db.execute({ sql: 'SELECT revoked FROM devices WHERE id = ?', args: [deviceId] });
  return Number(r.rows[0]?.[0] ?? 0) === 1;
}

/**
 * True when the cloud copy now holds a different business: it has devices, and not one of them is
 * a device this database knows. That happens when the cloud copy was emptied and filled again from
 * a fresh start (a demo replaced by real books, say). Pushing or pulling then would mix the two
 * businesses. A device that joined but never got its own row up still knows the others, so it is
 * not mistaken for this.
 */
export async function businessReplaced(db: Db, hub: Hub): Promise<boolean> {
  const ids = (await rows(hub.client, 'SELECT id FROM devices WHERE deleted = 0')).map((r) => String(r.id));
  if (!ids.length) return false;
  const known = await db.execute({ sql: `SELECT COUNT(*) FROM devices WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids });
  return Number(known.rows[0]?.[0] ?? 0) === 0;
}

/** One full round: push, then pull. Throws on failure (the worker records it). */
export async function syncOnce(db: Db, hub: Hub, deviceId: string) {
  if (await isRevoked(db, deviceId)) {
    throw new SyncError('REVOKED', 'This computer was marked as lost on the Devices screen, so it no longer copies data to or from the cloud.');
  }
  if (await businessReplaced(db, hub)) {
    throw new SyncError('REPLACED', 'The cloud copy now holds a different business (it was started afresh). Nothing was sent or received, so the two are not mixed.');
  }
  const p = await push(db, hub, deviceId);
  const l = await pull(db, hub, deviceId);
  await setState(db, 'sync.pending', await pendingCount(db));
  await clearError(db);
  return { pushed: p.pushed, pulled: l.applied, rejected: p.rejected + l.rejected };
}
