import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { RawResult, SqliteBackend } from './sqlite-client';

/*
 * Runs statements on an open SQLite WebAssembly database in this same thread. The phone app uses
 * it inside its database worker (db.worker.ts, persistent storage); tests use it directly in Node
 * with an in-memory database.
 */

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
