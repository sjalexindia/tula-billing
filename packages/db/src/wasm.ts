import type { Client, InArgs, InStatement, InValue, ResultSet, Row, Transaction, TransactionMode } from '@libsql/client';
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

/*
 * A libSQL `Client` on top of the official SQLite WebAssembly build (`@tula/db/wasm`), so the shop
 * computer's code (packages/db, the API routes, the sync engine) runs unchanged inside the phone app.
 * The shop computer also uses it for backup files, because a SQLite WebAssembly database in memory
 * holds no file open (Windows cannot delete or replace a file that is open).
 *
 * The backend runs single statements and scripts; this file adds what the code relies on from
 * libSQL: result rows readable by index and by column name, batches and transactions, and one
 * statement at a time. While a transaction is open, other statements wait for it to finish, just as
 * `queued()` in @tula/db/node does on the shop computer. Code inside a transaction must use the
 * transaction object (the rule there too), or it waits for itself.
 */

/** What a backend returns for one statement. Values are SQLite's: null, number, bigint, string, Uint8Array. */
export interface RawResult { columns: string[]; rows: unknown[][]; rowsAffected: number; lastInsertRowid: number | bigint | null }

export interface SqliteBackend {
  run(sql: string, args: unknown[]): Promise<RawResult>;
  /** several statements separated by semicolons, no results */
  script(sql: string): Promise<void>;
  close(): Promise<void>;
}

const BEGIN: Record<TransactionMode, string> = { write: 'BEGIN IMMEDIATE', read: 'BEGIN DEFERRED', deferred: 'BEGIN DEFERRED' };

function toSql(v: InValue): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.valueOf();
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;
}

function fromSql(v: unknown): unknown {
  if (typeof v !== 'bigint') return v;
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Received integer which cannot be safely represented as a JavaScript number');
  }
  return Number(v);
}

function normalize(stmt: InStatement | [string, InArgs?], args?: InArgs): { sql: string; args: unknown[] } {
  let sql: string;
  let a: InArgs | undefined;
  if (typeof stmt === 'string') [sql, a] = [stmt, args];
  else if (Array.isArray(stmt)) [sql, a] = stmt;
  else [sql, a] = [stmt.sql, stmt.args];
  if (a && !Array.isArray(a)) throw new TypeError('Named SQL arguments are not supported in the phone app; use ? placeholders');
  return { sql, args: (a ?? []).map(toSql) };
}

/** libSQL's row shape: column names enumerable (so `{ ...row }` gives a plain object), indexes not. */
function toRow(values: unknown[], columns: string[]): Row {
  const row = {} as Row;
  Object.defineProperty(row, 'length', { value: values.length });
  values.forEach((raw, i) => {
    const value = fromSql(raw);
    Object.defineProperty(row, i, { value });
    const col = columns[i]!;
    if (!Object.hasOwn(row, col)) Object.defineProperty(row, col, { value, enumerable: true, configurable: true, writable: true });
  });
  return row;
}

function toResultSet(r: RawResult): ResultSet {
  const rows = r.rows.map((v) => toRow(v, r.columns));
  const rowsAffected = r.rowsAffected;
  const lastInsertRowid = r.lastInsertRowid === null ? undefined : BigInt(r.lastInsertRowid);
  return {
    columns: r.columns,
    columnTypes: r.columns.map(() => ''),
    rows,
    rowsAffected,
    lastInsertRowid,
    toJSON: () => ({ columns: r.columns, rows: rows.map((x) => Array.from(x as ArrayLike<unknown>)), rowsAffected, lastInsertRowid: lastInsertRowid?.toString() ?? null }),
  };
}

export function createSqliteClient(backend: SqliteBackend): Client {
  // One statement or transaction at a time: each waits for the previous holder of the lock.
  let tail: Promise<void> = Promise.resolve();
  const lock = async (): Promise<() => void> => {
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const before = tail;
    tail = before.then(() => mine);
    await before;
    return release;
  };
  let closed = false;
  const check = () => { if (closed) throw new Error('The database is closed'); };

  const run = async (stmt: InStatement | [string, InArgs?], args?: InArgs) => {
    const s = normalize(stmt, args);
    return toResultSet(await backend.run(s.sql, s.args));
  };
  const runAll = async (stmts: Array<InStatement | [string, InArgs?]>, mode: TransactionMode) => {
    await backend.run(BEGIN[mode], []);
    try {
      const out: ResultSet[] = [];
      for (const s of stmts) out.push(await run(s));
      await backend.run('COMMIT', []);
      return out;
    } catch (e) {
      await backend.run('ROLLBACK', []).catch(() => undefined);
      throw e;
    }
  };
  const script = async (sql: string) => {
    try {
      await backend.script(sql);
    } catch (e) {
      // a script that failed half-way may leave its own BEGIN open (migrations do)
      await backend.run('ROLLBACK', []).catch(() => undefined);
      throw e;
    }
  };

  const client = {
    get closed() { return closed; },
    protocol: 'file',
    async execute(stmt: InStatement, args?: InArgs) {
      check();
      const release = await lock();
      try { return await run(stmt, args); } finally { release(); }
    },
    async batch(stmts: Array<InStatement | [string, InArgs?]>, mode: TransactionMode = 'deferred') {
      check();
      const release = await lock();
      try { return await runAll(stmts, mode); } finally { release(); }
    },
    async migrate(stmts: InStatement[]) {
      check();
      const release = await lock();
      try {
        await backend.run('PRAGMA foreign_keys = OFF', []);
        try { return await runAll(stmts, 'deferred'); } finally { await backend.run('PRAGMA foreign_keys = ON', []); }
      } finally { release(); }
    },
    async executeMultiple(sql: string) {
      check();
      const release = await lock();
      try { await script(sql); } finally { release(); }
    },
    async transaction(mode: TransactionMode = 'write'): Promise<Transaction> {
      check();
      const release = await lock();
      try {
        await backend.run(BEGIN[mode], []);
      } catch (e) {
        release();
        throw e;
      }
      let done = false;
      const finish = async (sql: 'COMMIT' | 'ROLLBACK') => {
        if (done) throw new Error('The transaction is already closed');
        try {
          await backend.run(sql, []);
        } catch (e) {
          // a refused COMMIT (e.g. a deferred foreign key) leaves the transaction open in SQLite
          if (sql === 'COMMIT') await backend.run('ROLLBACK', []).catch(() => undefined);
          throw e;
        } finally {
          done = true;
          release();
        }
      };
      return {
        get closed() { return done; },
        async execute(stmt: InStatement) {
          if (done) throw new Error('The transaction is closed');
          return run(stmt);
        },
        async batch(stmts: InStatement[]) {
          const out: ResultSet[] = [];
          for (const s of stmts) out.push(await run(s));
          return out;
        },
        executeMultiple: (sql: string) => backend.script(sql),
        commit: () => finish('COMMIT'),
        rollback: () => finish('ROLLBACK'),
        close() {
          if (!done) void finish('ROLLBACK').catch(() => undefined);
        },
      } as Transaction;
    },
    async sync() { return undefined; },
    close() {
      if (closed) return;
      closed = true;
      void tail.then(() => backend.close());
    },
    reconnect() { /* one local file: nothing to reconnect */ },
  };
  return client as unknown as Client;
}

// ---------- running on a database in this thread ----------
// The phone app uses this inside its database worker (apps/web/src/local/db.worker.ts, persistent
// storage); the shop computer uses it for in-memory copies of backup files (apps/server/src/ops/dbfile.ts),
// and tests in Node with an in-memory database.

export function runOn(sqlite3: Sqlite3Static, db: Database, sql: string, args: unknown[]): RawResult {
  const stmt = db.prepare(sql);
  try {
    if (args.length) stmt.bind(args as never);
    const rows: unknown[][] = [];
    if (stmt.columnCount > 0) {
      const columns = stmt.getColumnNames();
      while (stmt.step()) rows.push(stmt.get([]) as unknown[]);
      return { columns, rows, rowsAffected: 0, lastInsertRowid: null };
    }
    stmt.step();
    return { columns: [], rows, rowsAffected: db.changes(), lastInsertRowid: sqlite3.capi.sqlite3_last_insert_rowid(db) as number | bigint };
  } finally {
    stmt.finalize();
  }
}

export function directBackend(sqlite3: Sqlite3Static, db: Database): SqliteBackend {
  return {
    run: async (sql, args) => runOn(sqlite3, db, sql, args),
    script: async (sql) => { db.exec(sql); },
    close: async () => { db.close(); },
  };
}
