import { createClient, type Client, type Transaction } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { migrate, type Db, type Migration } from './index';

/* Shop-computer only: open a database file with one queued connection, and read the migrations folder. */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Every migration in packages/db/migrations, read from disk. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/** Open (or create) the local SQLite database. url examples: "file:tula.db", ":memory:" */
export async function openDb(url: string): Promise<Db> {
  // One connection: the client otherwise pools several, and per-connection settings (foreign keys,
  // busy timeout) would only apply to the first. Requests queue on it, which suits one shop computer.
  const db = queued(createClient({ url, concurrency: 1, timeout: 5000 }));
  if (url !== ':memory:') await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute('PRAGMA busy_timeout = 5000');
  await migrate(db, loadMigrations());
  return db;
}


const inTx = new AsyncLocalStorage<boolean>();

/**
 * With one connection, a statement sent while a transaction is open is refused (TRANSACTION_ACTIVE).
 * This wrapper makes such statements, and further transactions, wait their turn instead, so a GET
 * arriving while a bill is being saved simply waits a few milliseconds. Code running inside the
 * transaction's own async context is passed straight through (it should use the transaction).
 */
export function queued(client: Client): Client {
  let busy: Promise<void> | null = null;
  const turn = async () => {
    if (inTx.getStore()) return;
    while (busy) await busy;
  };
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    await turn();
    return fn(...a);
  };
  const transaction = async (...a: Parameters<Client['transaction']>): Promise<Transaction> => {
    await turn();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    busy = mine;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      if (busy === mine) busy = null;
      release();
    };
    let tx: Transaction;
    try {
      tx = await inTx.run(true, () => client.transaction(...a));
    } catch (e) {
      end();
      throw e;
    }
    const after = <F extends (...x: never[]) => unknown>(f: F) => ((...x: Parameters<F>) => {
      const r = f.apply(tx, x);
      return Promise.resolve(r).finally(end);
    }) as unknown as F;
    return new Proxy(tx, {
      get(target, prop) {
        if (prop === 'commit' || prop === 'rollback') return after(target[prop] as never);
        if (prop === 'close') return () => { try { target.close(); } finally { end(); } };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'transaction') return transaction;
      if (prop === 'execute' || prop === 'batch' || prop === 'executeMultiple' || prop === 'migrate') {
        return wrap((target[prop] as (...x: unknown[]) => Promise<unknown>).bind(target));
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

let collect: (() => void) | null = null;

/**
 * Close a database and let go of the file at once. The libSQL client keeps the file open after
 * close() until garbage collection frees its prepared statements, and on Windows an open file
 * cannot be renamed or deleted (restore, CLI tools, tests). Collecting garbage here frees them.
 */
export async function closeDb(db: Pick<Db, 'close'>): Promise<void> {
  db.close();
  if (!collect) {
    v8.setFlagsFromString('--expose-gc');
    collect = runInNewContext('gc') as () => void;
  }
  collect();
  await new Promise((r) => setTimeout(r, 0));
}
