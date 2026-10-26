/// <reference lib="webworker" />
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { runOn } from '@tula/db/wasm';

/*
 * The phone's database, in a Web Worker. SQLite WebAssembly keeps the file in the app's private
 * storage through the "opfs-sahpool" VFS: persistent across restarts, and it needs no special
 * HTTP headers. One database file, one connection; requests arrive one at a time from
 * sqlite-worker.ts.
 */

export type WorkerRequest =
  | { id: number; op: 'open'; file: string }
  | { id: number; op: 'run'; sql: string; args: unknown[] }
  | { id: number; op: 'script'; sql: string }
  | { id: number; op: 'close' };

export type WorkerReply =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { message: string; name: string; code?: string } };

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;

async function open(file: string) {
  sqlite3 ??= await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'tula', directory: '.tula' });
  db = new pool.OpfsSAHPoolDb(file);
  return { sqlite: sqlite3.version.libVersion };
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    let result: unknown;
    if (m.op === 'open') result = await open(m.file);
    else if (!db || !sqlite3) throw new Error('The phone database is not open');
    else if (m.op === 'run') result = runOn(sqlite3, db, m.sql, m.args);
    else if (m.op === 'script') db.exec(m.sql);
    else if (m.op === 'close') { db.close(); db = null; }
    scope.postMessage({ id: m.id, ok: true, result } satisfies WorkerReply);
  } catch (err) {
    const x = err as { message?: string; name?: string; resultCode?: number };
    scope.postMessage({ id: m.id, ok: false, error: { message: String(x?.message ?? err), name: x?.name ?? 'Error', code: x?.resultCode !== undefined ? String(x.resultCode) : undefined } } satisfies WorkerReply);
  }
};
