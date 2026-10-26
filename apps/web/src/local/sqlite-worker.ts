import type { WorkerReply, WorkerRequest } from './db.worker';
import type { RawResult, SqliteBackend } from './sqlite-client';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** Talks to db.worker.ts: one message per statement, answered in order. */
export async function openWorkerBackend(file: string): Promise<SqliteBackend> {
  const worker = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let next = 1;
  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const r = e.data;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(Object.assign(new Error(r.error.message), { name: r.error.name, code: r.error.code }));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The phone database stopped'));
    pending.clear();
  };
  const call = (m: Req) => new Promise<unknown>((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...m, id });
  });

  await call({ op: 'open', file });
  return {
    run: async (sql, args) => (await call({ op: 'run', sql, args })) as RawResult,
    script: async (sql) => { await call({ op: 'script', sql }); },
    close: async () => { await call({ op: 'close' }); worker.terminate(); },
  };
}
