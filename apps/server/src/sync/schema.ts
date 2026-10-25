import type { InStatement, InValue, ResultSet } from '@libsql/client';

/** Anything that can run one statement: a client, a transaction, the hub. */
export interface Runner { execute(stmt: InStatement): Promise<ResultSet> }

/**
 * Tables that never sync. Mirrors LOCAL_ONLY in packages/db plus sync's own bookkeeping
 * (sync_rejects locally, sync_log on the hub). Any table without a device_id column is
 * also treated as local, so a new local-only table added elsewhere never leaks into sync.
 */
export const LOCAL_TABLES = new Set(['sync_outbox', 'sync_state', 'schema_migrations', 'sessions', 'sync_rejects', 'sync_log']);

export interface TableInfo {
  name: string;
  /** single primary-key column: id for most tables, key for settings */
  pk: string;
  columns: Set<string>;
  /** last-writer-wins is possible only when the table has updated_at (audit_log has none: insert-or-ignore) */
  lww: boolean;
}

export type Row = Record<string, unknown>;

/** Turn a libSQL result into plain objects keyed by column name. */
export const rowsOf = (rs: ResultSet): Row[] => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

export async function rows(ex: Runner, sql: string, args: InValue[] = []): Promise<Row[]> {
  return rowsOf(await ex.execute({ sql, args }));
}

/** Every synced table in a database (local or hub), with its columns, read from the schema itself. */
export async function syncedTables(ex: Runner): Promise<Map<string, TableInfo>> {
  const names = await rows(ex, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = new Map<string, TableInfo>();
  for (const { name } of names) {
    const table = String(name);
    if (LOCAL_TABLES.has(table)) continue;
    const cols = await rows(ex, 'SELECT name, pk FROM pragma_table_info(?)', [table]);
    const pks = cols.filter((c) => Number(c.pk) > 0);
    const columns = new Set(cols.map((c) => String(c.name)));
    if (pks.length !== 1 || !columns.has('device_id')) continue;
    out.set(table, { name: table, pk: String(pks[0]!.name), columns, lww: columns.has('updated_at') });
  }
  return out;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function toValue(v: unknown): InValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v); // JSON columns normally arrive as strings already
  return v as InValue;
}

/**
 * INSERT … ON CONFLICT(pk) DO UPDATE … WHERE excluded.updated_at >= current.updated_at
 * using only the columns present in the payload that this database also has
 * (an insert payload may leave out columns with defaults; a device on an older or
 * newer schema may send fewer or more columns). Returns null when the payload has no key.
 */
export function upsertStmt(t: TableInfo, payload: Row): InStatement | null {
  const cols = Object.keys(payload).filter((c) => t.columns.has(c) && payload[c] !== undefined);
  if (!cols.includes(t.pk) || payload[t.pk] === null) return null;
  const set = cols.filter((c) => c !== t.pk);
  let sql = `INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  if (t.lww && cols.includes('updated_at') && set.length) {
    sql += ` ON CONFLICT(${q(t.pk)}) DO UPDATE SET ${set.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`
      + ` WHERE excluded.updated_at >= ${q(t.name)}.updated_at`;
  } else {
    sql += ` ON CONFLICT(${q(t.pk)}) DO NOTHING`;
  }
  return { sql, args: cols.map((c) => toValue(payload[c])) };
}

/** Keyset page through a table, for copying it in full. */
export function pageStmt(t: TableInfo, after: InValue | null, limit: number): InStatement {
  return after === null
    ? { sql: `SELECT * FROM ${q(t.name)} ORDER BY ${q(t.pk)} LIMIT ?`, args: [limit] }
    : { sql: `SELECT * FROM ${q(t.name)} WHERE ${q(t.pk)} > ? ORDER BY ${q(t.pk)} LIMIT ?`, args: [after, limit] };
}

export const isConstraintError = (e: unknown) => {
  const err = e as { code?: string; extendedCode?: string; message?: string };
  return /CONSTRAINT/i.test(`${err?.code ?? ''} ${err?.extendedCode ?? ''} ${err?.message ?? ''}`);
};
