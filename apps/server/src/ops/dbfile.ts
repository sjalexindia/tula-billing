import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { Db } from '@tula/db';
import { createSqliteClient, directBackend } from '@tula/db/wasm';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/*
 * Backup files are checked and edited as copies in memory (SQLite WebAssembly), never through a
 * connection to the file. The libSQL client keeps a file open after close() until garbage collection
 * frees its statements, and Windows cannot delete or replace a file that is open: backups left
 * their temp files behind and a restore could not swap the database in. Here the file is read,
 * worked on in memory and, when asked, written back whole; nothing holds it open afterwards.
 */

let sqlite: Promise<Sqlite3Static> | null = null;
const init = () => (sqlite ??= sqlite3InitModule());

/**
 * Run `fn` on an in-memory copy of a database file. With `save`, the result is written back over
 * the file (through a temp file and a rename, so a crash leaves the old file or the new one).
 */
export async function withDbFile<T>(file: string, fn: (db: Db) => Promise<T>, opts: { save?: boolean } = {}): Promise<T> {
  const sqlite3 = await init();
  const bytes = new Uint8Array(readFileSync(file));
  // A file in WAL mode (header bytes 18-19 = 2) can't be opened from memory; as rollback-journal it can.
  // Only this copy changes: the server turns WAL back on when it opens the database.
  if (bytes.length >= 20 && bytes[18] === 2) { bytes[18] = 1; bytes[19] = 1; }
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const { capi } = sqlite3;
  db.checkRc(capi.sqlite3_deserialize(db.pointer!, 'main', p, bytes.length, bytes.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE));
  const client = createSqliteClient(directBackend(sqlite3, db));
  try {
    const result = await fn(client);
    if (opts.save) {
      const out = capi.sqlite3_js_db_export(db);
      const tmp = `${file}.saving`;
      writeFileSync(tmp, out);
      renameSync(tmp, file); // replaces the old file in one step, on Windows too
    }
    return result;
  } finally {
    db.close();
  }
}
