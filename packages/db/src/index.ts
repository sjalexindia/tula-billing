import type { Client, InValue, Transaction } from '@libsql/client';

/*
 * Runtime-neutral database helpers: they run on the shop computer (Node) and inside the phone app
 * (WebView). Nothing here may import node:* — opening a database file and reading the migrations
 * folder live in ./node.ts (`@tula/db/node`).
 */

export type Db = Client;
export type Tx = Transaction;
export type Exec = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
export type Row = Record<string, unknown>;

/** One SQL migration file: name (e.g. "0001_init.sql", the sort key) and its text. */
export interface Migration { name: string; sql: string }

/** Apply the migrations this database has not had yet, in name order. Returns the names applied. */
export async function migrate(db: Pick<Client, 'execute' | 'executeMultiple'>, migrations: Migration[]): Promise<string[]> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.execute('SELECT name FROM schema_migrations')).rows.map((r) => String(r.name)));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    await db.executeMultiple(`BEGIN;\n${m.sql}\nINSERT INTO schema_migrations VALUES ('${m.name}', '${nowIso()}');\nCOMMIT;`);
    applied.push(m.name);
  }
  return applied;
}

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7: time-ordered, so ids sort by creation time and index well. Ids made in the same
 * millisecond still sort in the order they were made: the 12 bits after the version hold a
 * counter (RFC 9562 §6.2, method 1), so "ORDER BY created_at, id" is the order things happened.
 */
export function uuidv7(): string {
  let now = Date.now();
  if (now <= lastMs) {
    now = lastMs;
    if (++seq > 0xfff) { now = ++lastMs; seq = 0; }
  } else {
    lastMs = now;
    seq = 0;
  }
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[0] = Math.floor(now / 2 ** 40) & 0xff;
  b[1] = Math.floor(now / 2 ** 32) & 0xff;
  b[2] = Math.floor(now / 2 ** 24) & 0xff;
  b[3] = Math.floor(now / 2 ** 16) & 0xff;
  b[4] = Math.floor(now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const nowIso = () => new Date().toISOString();

/** Tables that never sync (local bookkeeping). */
const LOCAL_ONLY = new Set(['sync_outbox', 'sync_state', 'schema_migrations', 'sessions', 'sync_rejects']);

/**
 * Insert a row into a synced table, filling id / timestamps / device_id,
 * and record it in the sync outbox in the same transaction.
 */
export async function insert(ex: Exec, table: string, deviceId: string, row: Row): Promise<string> {
  const ts = nowIso();
  const full: Row = { id: row.id ?? uuidv7(), created_at: ts, updated_at: ts, device_id: deviceId, ...row };
  if (table === 'audit_log') {
    delete full.created_at;
    delete full.updated_at;
  }
  const cols = Object.keys(full);
  await ex.execute({
    sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    args: cols.map((c) => toArg(full[c])),
  });
  if (!LOCAL_ONLY.has(table)) {
    await ex.execute({
      sql: 'INSERT INTO sync_outbox (table_name, row_id, op, payload_json, created_at) VALUES (?,?,?,?,?)',
      args: [table, String(full.id ?? full.key), 'upsert', JSON.stringify(full), ts],
    });
  }
  return String(full.id ?? full.key);
}

export async function setSetting(ex: Exec, deviceId: string, key: string, value: string): Promise<void> {
  const ts = nowIso();
  await ex.execute({
    sql: `INSERT INTO settings (key, value, updated_at, device_id) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, device_id = excluded.device_id`,
    args: [key, value, ts, deviceId],
  });
  await ex.execute({
    sql: 'INSERT INTO sync_outbox (table_name, row_id, op, payload_json, created_at) VALUES (?,?,?,?,?)',
    args: ['settings', key, 'upsert', JSON.stringify({ key, value, updated_at: ts, device_id: deviceId }), ts],
  });
}

export async function getSettings(ex: Exec): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(ex, 'SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function toArg(v: unknown): InValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v as InValue;
}

export async function all<T = Row>(ex: Exec, sql: string, args: InValue[] = []): Promise<T[]> {
  const r = await ex.execute({ sql, args });
  return r.rows.map((row) => ({ ...row }) as T);
}

export async function one<T = Row>(ex: Exec, sql: string, args: InValue[] = []): Promise<T | undefined> {
  return (await all<T>(ex, sql, args))[0];
}

/**
 * Update columns of one synced row, stamping updated_at / device_id, and queue the full row for sync.
 * Returns false if the row doesn't exist.
 */
export async function update(ex: Exec, table: string, deviceId: string, id: string, patch: Row): Promise<boolean> {
  const cols = Object.keys(patch).filter((c) => patch[c] !== undefined);
  const ts = nowIso();
  const r = await ex.execute({
    sql: `UPDATE ${table} SET ${[...cols.map((c) => `${c} = ?`), 'updated_at = ?', 'device_id = ?'].join(', ')} WHERE id = ?`,
    args: [...cols.map((c) => toArg(patch[c])), ts, deviceId, id],
  });
  if (!r.rowsAffected) return false;
  if (!LOCAL_ONLY.has(table)) {
    const row = await one(ex, `SELECT * FROM ${table} WHERE id = ?`, [id]);
    await ex.execute({
      sql: 'INSERT INTO sync_outbox (table_name, row_id, op, payload_json, created_at) VALUES (?,?,?,?,?)',
      args: [table, id, 'upsert', JSON.stringify(row), ts],
    });
  }
  return true;
}

/** Soft-delete matching rows (deleted = 1) so the deletion syncs too. Returns how many. */
export async function softDelete(ex: Exec, table: string, deviceId: string, where: string, args: InValue[]): Promise<number> {
  const rows = await all<{ id: string }>(ex, `SELECT id FROM ${table} WHERE deleted = 0 AND (${where})`, args);
  for (const r of rows) await update(ex, table, deviceId, r.id, { deleted: 1 });
  return rows.length;
}
