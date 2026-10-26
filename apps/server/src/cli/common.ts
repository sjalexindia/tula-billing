import { createClient, type Client } from '@libsql/client';
import { existsSync } from 'node:fs';
import { lockHolder } from '../ops/lock';
import { APP_ROOT, loadEnvFileArg, resolveDbFile, supervisorLockFile } from '../ops/util';

/** Shared start-up for the command-line tools: --env-file, the database path, a plain connection (no migrations). */
export function cliSetup(): { args: string[]; dbFile: string; port: number } {
  const args = loadEnvFileArg(process.argv.slice(2));
  return { args, dbFile: resolveDbFile(process.env, APP_ROOT), port: Number(process.env.TULA_PORT ?? 5000) };
}

export async function openExisting(dbFile: string): Promise<Client> {
  if (!existsSync(dbFile)) throw new Error(`No Tula database at ${dbFile}`);
  const c = createClient({ url: `file:${dbFile}` });
  await c.execute('PRAGMA busy_timeout = 5000');
  return c;
}

export async function healthOk(port: number, timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Is Tula running for this database (supervisor lock held by a live process, or the port answers)? */
export async function runningInfo(dbFile: string, port: number) {
  return { supervisor: lockHolder(supervisorLockFile(dbFile)), answering: await healthOk(port) };
}

export const flag = (args: string[], name: string) => args.includes(name);
export function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
export const positional = (args: string[], withValue: string[] = []) =>
  args.filter((a, i) => !a.startsWith('--') && !(i > 0 && withValue.includes(args[i - 1]!)));

export function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

export const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;
