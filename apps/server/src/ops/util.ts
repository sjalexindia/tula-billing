import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared helpers for backups, restore, the supervisor and the command-line tools.
 * Nothing here touches the database.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server */
export const SERVER_ROOT = resolve(here, '..', '..');
/** repository / install root (C:\Tula\app, /opt/tula/app) */
export const APP_ROOT = resolve(SERVER_ROOT, '..', '..');

/** Exit code the server uses to ask the supervisor to apply a pending restore and start again. */
export const RESTORE_EXIT_CODE = 75;

export function appVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** Folder holding the migration .sql files of @tula/db (used to refuse backups from a newer version). */
export function migrationsDir(): string {
  const req = createRequire(import.meta.url);
  return join(dirname(req.resolve('@tula/db/package.json')), 'migrations');
}

// ---------- Paths (all derived from the database file) ----------
export function resolveDbFile(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return resolve(cwd, env.TULA_DB ?? join('data', 'tula.db'));
}
export const dataDir = (dbFile: string) => dirname(resolve(dbFile));
export const defaultBackupDir = (dbFile: string) => join(dataDir(dbFile), 'backups');
export const tmpDir = (dbFile: string) => join(dataDir(dbFile), 'tmp');
export const logDirFor = (dbFile: string, env: NodeJS.ProcessEnv = process.env) => resolve(env.TULA_LOG_DIR ?? join(dataDir(dbFile), 'logs'));
export const pendingRestoreFile = (dbFile: string) => join(dataDir(dbFile), 'restore-pending.json');
export const lastRestoreFile = (dbFile: string) => join(dataDir(dbFile), 'restore-last.json');
export const supervisorLockFile = (dbFile: string) => join(dataDir(dbFile), 'tula-supervisor.lock');
export const backupLockFile = (dbFile: string) => join(dataDir(dbFile), 'backup.lock');

// ---------- India time (no daylight saving: always UTC+05:30) ----------
const IST_OFFSET_MIN = 330;
export interface IstParts { y: number; mo: number; d: number; h: number; mi: number }
export function istParts(at: Date): IstParts {
  const t = new Date(at.getTime() + IST_OFFSET_MIN * 60000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
}
const p2 = (n: number) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' in India time */
export function istDate(at: Date): string {
  const p = istParts(at);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}`;
}
/** 'YYYY-MM' in India time */
export const istMonth = (at: Date) => istDate(at).slice(0, 7);
/** The UTC instant of HH:MM India time on the India-time day of `at`, shifted by `addDays`. */
export function istAt(at: Date, hhmm: string, addDays = 0): Date {
  const p = istParts(at);
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(p.y, p.mo - 1, p.d + addDays, h, m) - IST_OFFSET_MIN * 60000);
}
export function istStamp(at: Date): string {
  const p = istParts(at);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)}-${p2(p.h)}${p2(p.mi)}`;
}

// ---------- tula.env ----------
/** Parse KEY=VALUE lines (# comments, optional quotes). Used for C:\TulaData\tula.env and /etc/tula/tula.env. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/**
 * If argv has `--env-file <path>`, load it into process.env (values already set in the
 * environment win) and return the remaining arguments.
 */
export function loadEnvFileArg(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env-file') {
      const file = argv[++i];
      if (!file || !existsSync(file)) throw new Error(`Settings file not found: ${file ?? '(none given)'}`);
      for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) if (process.env[k] === undefined && v !== '') process.env[k] = v;
    } else rest.push(argv[i]!);
  }
  return rest;
}

export const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
