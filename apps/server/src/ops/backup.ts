import { createClient } from '@libsql/client';
import { all, one, type Exec } from '@tula/db';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { UserError } from '../context';
import { acquireLock } from './lock';
import {
  appVersion, backupLockFile, dataDir, defaultBackupDir, errMessage, istDate, istMonth, istStamp, migrationsDir, tmpDir,
} from './util';

/**
 * Backups are consistent snapshots made with `VACUUM INTO` (safe on the live WAL database while
 * bills are being saved), verified, then copied to the backup folder with a small .json beside them.
 */

export type BackupKind = 'scheduled' | 'manual' | 'safety';

// ---------- Local (this computer only) configuration and status, in sync_state ----------
export const KEYS = {
  folder: 'ops.backup_folder',
  time: 'ops.backup_time',
  enabled: 'ops.backup_enabled',
  lastOkAt: 'ops.backup_last_ok_at',
  lastOkFile: 'ops.backup_last_ok_file',
  lastErrorAt: 'ops.backup_last_error_at',
  lastError: 'ops.backup_last_error',
  lastWarning: 'ops.backup_last_warning',
  lastAutoAt: 'ops.backup_last_auto_at',
  restoredAt: 'ops.restored_at',
  restoredFrom: 'ops.restored_from',
} as const;
/** Machine settings carried over when a backup is restored (the backup may come from another computer). */
export const MACHINE_KEYS = [KEYS.folder, KEYS.time, KEYS.enabled] as const;

export async function getLocal(ex: Exec, keys: readonly string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const rows = await all<{ key: string; value: string }>(ex, `SELECT key, value FROM sync_state WHERE key IN (${keys.map(() => '?').join(',')})`, [...keys]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** sync_state is local-only (never synced), so plain SQL is the right way to write it. */
export async function setLocal(ex: Exec, values: Record<string, string | null>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) await ex.execute({ sql: 'DELETE FROM sync_state WHERE key = ?', args: [key] });
    else await ex.execute({ sql: 'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, value] });
  }
}

export interface BackupConfig { folder: string; time: string; enabled: boolean; isDefaultFolder: boolean }

export const DEFAULT_TIME = '21:00';

export async function getBackupConfig(ex: Exec, dbFile: string): Promise<BackupConfig> {
  const v = await getLocal(ex, [KEYS.folder, KEYS.time, KEYS.enabled]);
  const folder = v[KEYS.folder] || defaultBackupDir(dbFile);
  const time = v[KEYS.time];
  return {
    folder,
    time: time && TIME.test(time) ? time : DEFAULT_TIME,
    enabled: v[KEYS.enabled] !== 'false',
    isDefaultFolder: samePath(folder, defaultBackupDir(dbFile)),
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const BackupConfigInput = z.object({
  folder: z.string().trim().max(400).optional(),
  time: z.string().regex(TIME, 'Time must look like 21:00').optional(),
  enabled: z.boolean().optional(),
});

const samePath = (a: string, b: string) => {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
};
const isInside = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Create the folder if needed and prove we can write to it (write + delete a probe file). */
export function ensureWritable(folder: string): void {
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw new UserError(`Tula cannot create the folder ${folder}. Check that the drive is connected. (${(e as NodeJS.ErrnoException).code ?? errMessage(e)})`, 'FOLDER_UNREACHABLE');
  }
  const probe = join(folder, `.tula-probe-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (e) {
    throw new UserError(`Tula cannot save files in ${folder}. Choose a folder this computer can write to. (${(e as NodeJS.ErrnoException).code ?? errMessage(e)})`, 'FOLDER_NOT_WRITABLE');
  }
}

/**
 * Check a backup folder chosen by the owner. Rules:
 * - a full path (e.g. G:\My Drive\Tula backups, E:\Tula, /media/usb/tula)
 * - not the data folder itself, and not inside it (except the default <data>/backups), because a
 *   second location only helps if it is somewhere else
 * - exists or can be created, and is writable
 * Returns whether it is on the same disk as the database (allowed, but the screen suggests a second place).
 */
export function validateBackupFolder(folder: string, dbFile: string): { folder: string; sameDisk: boolean } {
  const f = folder.trim();
  if (!f) throw new UserError('Choose a folder for backups', 'FOLDER_REQUIRED');
  if (!isAbsolute(f)) throw new UserError('Give the full folder path, for example G:\\My Drive\\Tula backups or E:\\Tula backups', 'FOLDER_NOT_ABSOLUTE');
  const full = resolve(f);
  const data = dataDir(dbFile);
  if (!samePath(full, defaultBackupDir(dbFile))) {
    if (samePath(full, data) || isInside(full, data)) throw new UserError('Choose a folder outside the Tula data folder, such as the Google Drive folder or a USB drive', 'FOLDER_IN_DATA');
  }
  ensureWritable(full);
  let sameDisk = false;
  try { sameDisk = statSync(full).dev === statSync(data).dev; } catch { /* unknown */ }
  return { folder: full, sameDisk };
}

export async function saveBackupConfig(ex: Exec, dbFile: string, input: z.infer<typeof BackupConfigInput>): Promise<BackupConfig> {
  const patch: Record<string, string | null> = {};
  if (input.folder !== undefined) {
    if (!input.folder.trim() || samePath(input.folder.trim(), defaultBackupDir(dbFile))) {
      ensureWritable(defaultBackupDir(dbFile));
      patch[KEYS.folder] = null; // back to the default
    } else {
      patch[KEYS.folder] = validateBackupFolder(input.folder, dbFile).folder;
    }
  }
  if (input.time !== undefined) patch[KEYS.time] = input.time;
  if (input.enabled !== undefined) patch[KEYS.enabled] = input.enabled ? 'true' : 'false';
  await setLocal(ex, patch);
  return getBackupConfig(ex, dbFile);
}

// ---------- Backup files ----------
/** tula-YYYY-MM-DD-HHmm.db (India time), with -2, -3… when two land in the same minute. Nothing else is ever deleted. */
export const BACKUP_NAME = /^tula-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(\d{1,3}))?\.db$/;
export const isBackupName = (name: string) => BACKUP_NAME.test(name);
export const sidecarOf = (file: string) => file.replace(/\.db$/, '.json');

export function timeFromName(name: string): Date | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as number[];
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!) - 330 * 60000);
}

export interface Sidecar {
  app: 'tula'; kind: BackupKind; createdAt: string; sizeBytes: number; sha256: string; appVersion: string;
  migrations: string[]; counts: Record<string, number>; deviceId: string; business: string | null; integrity: 'ok';
}
export interface BackupEntry { file: string; path: string; folder: string; sizeBytes: number; createdAt: string; kind: BackupKind; appVersion: string | null; checked: boolean }

export function readSidecar(path: string): Sidecar | null {
  try {
    const s = JSON.parse(readFileSync(sidecarOf(path), 'utf8')) as Sidecar;
    return s.app === 'tula' ? s : null;
  } catch {
    return null;
  }
}

export function listBackups(folder: string): BackupEntry[] {
  let names: string[];
  try { names = readdirSync(folder); } catch { return []; }
  const out: BackupEntry[] = [];
  for (const file of names) {
    if (!isBackupName(file)) continue;
    const path = join(folder, file);
    let size: number;
    try { size = statSync(path).size; } catch { continue; }
    const side = readSidecar(path);
    out.push({
      file, path, folder, sizeBytes: size,
      createdAt: side?.createdAt ?? timeFromName(file)!.toISOString(),
      kind: side?.kind ?? 'scheduled', appVersion: side?.appVersion ?? null, checked: !!side,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.file.localeCompare(a.file)));
}

// ---------- Retention ----------
export const RETENTION = { daily: 30, monthly: 12, manualDays: 7 };

/**
 * Which backups to keep:
 * - the newest backup of each of the last 30 days that have one,
 * - the first backup of each of the last 12 months,
 * - every manual or safety backup from the last 7 days.
 * Everything else (Tula backups only) can go.
 */
export function retentionPlan(entries: Array<{ file: string; at: Date; kind: BackupKind }>, now: Date): { keep: string[]; remove: string[] } {
  const sorted = [...entries].sort((a, b) => b.at.getTime() - a.at.getTime() || b.file.localeCompare(a.file));
  const keep = new Set<string>();
  const days = new Set<string>();
  for (const e of sorted) {
    const d = istDate(e.at);
    if (days.has(d)) continue;
    if (days.size >= RETENTION.daily) break;
    days.add(d);
    keep.add(e.file);
  }
  const firstOfMonth = new Map<string, string>();
  for (const e of sorted) firstOfMonth.set(istMonth(e.at), e.file); // oldest wins (sorted newest first)
  [...firstOfMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, RETENTION.monthly).forEach(([, f]) => keep.add(f));
  for (const e of sorted) {
    if (e.kind !== 'scheduled' && now.getTime() - e.at.getTime() <= RETENTION.manualDays * 86400000) keep.add(e.file);
  }
  return { keep: sorted.filter((e) => keep.has(e.file)).map((e) => e.file), remove: sorted.filter((e) => !keep.has(e.file)).map((e) => e.file) };
}

export function applyRetention(folder: string, now = new Date()): string[] {
  const list = listBackups(folder);
  const plan = retentionPlan(list.map((b) => ({ file: b.file, at: new Date(b.createdAt), kind: b.kind })), now);
  const removed: string[] = [];
  for (const file of plan.remove) {
    if (!isBackupName(file)) continue; // belt and braces: never delete anything that is not a Tula backup
    try {
      unlinkSync(join(folder, file));
      try { unlinkSync(join(folder, sidecarOf(file))); } catch { /* no sidecar */ }
      removed.push(file);
    } catch { /* try again next time */ }
  }
  return removed;
}

// ---------- Verification ----------
const KEY_TABLES = ['users', 'parties', 'products', 'sales_docs', 'sales_doc_lines', 'purchase_docs', 'money_docs', 'expenses', 'stock_moves', 'ledger_entries', 'audit_log'];

export interface Verified { migrations: string[]; deviceId: string; counts: Record<string, number>; business: string | null }

/**
 * Open a database file (always a local file Tula just made or copied) and prove it is a usable Tula database:
 * integrity_check = ok, schema_migrations present, this device's id present.
 */
export async function verifyDbFile(file: string): Promise<Verified> {
  if (!existsSync(file)) throw new UserError('Backup file not found', 'NOT_FOUND', 404);
  const head = Buffer.alloc(16);
  const fd = openSync(file, 'r');
  try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\0') throw new UserError('This file is not a Tula backup', 'BAD_BACKUP');
  const c = createClient({ url: `file:${file}` });
  try {
    const ic = await c.execute('PRAGMA integrity_check');
    const res = ic.rows.map((r) => String(r[0])).join('; ');
    if (res !== 'ok') throw new UserError(`The backup is damaged (${res.slice(0, 200)})`, 'BAD_BACKUP');
    const tables = new Set((await c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name)));
    if (!tables.has('schema_migrations') || !tables.has('sync_state')) throw new UserError('This file is not a Tula backup', 'BAD_BACKUP');
    const migrations = (await c.execute('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => String(r.name));
    const dev = (await c.execute("SELECT value FROM sync_state WHERE key = 'device_id'")).rows[0];
    if (!dev) throw new UserError('This backup has no device id; it was never set up', 'BAD_BACKUP');
    const counts: Record<string, number> = {};
    for (const t of KEY_TABLES) {
      if (!tables.has(t)) continue;
      const hasDeleted = (await c.execute(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = 'deleted'`)).rows.length > 0;
      counts[t] = Number((await c.execute(`SELECT COUNT(*) AS n FROM ${t}${hasDeleted ? ' WHERE deleted = 0' : ''}`)).rows[0]!.n);
    }
    let business: string | null = null;
    if (tables.has('settings')) {
      const b = (await c.execute("SELECT value FROM settings WHERE key = 'business.name_en'")).rows[0];
      business = b ? String(b.value) || null : null;
    }
    return { migrations, deviceId: String(dev.value), counts, business };
  } finally {
    c.close();
  }
}

/** Migrations in a backup that this version of Tula does not have (backup is from a newer version). */
export function unknownMigrations(migrations: string[]): string[] {
  let known: Set<string>;
  try { known = new Set(readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql'))); } catch { return []; }
  return migrations.filter((m) => !known.has(m));
}

export function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

// ---------- Making a backup ----------
export interface BackupResult { file: string; path: string; folder: string; sizeBytes: number; kind: BackupKind; createdAt: string; warning: string | null; removed: string[] }

function freeName(folder: string, now: Date): string {
  const stamp = istStamp(now);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `tula-${stamp}.db` : `tula-${stamp}-${n}.db`;
    if (!existsSync(join(folder, name)) && !existsSync(join(folder, `${name}.partial`))) return name;
  }
  throw new UserError('Too many backups in one minute', 'BUSY', 409);
}

/**
 * Snapshot `source` (an open connection to the live database) into `folder`:
 * VACUUM INTO a local temp file → verify → copy to the folder as .partial → rename → write the .json.
 * Writing SQLite straight onto a USB stick or the Google Drive folder is avoided; only a finished file is copied there.
 */
export async function snapshotTo(source: Exec, dbFile: string, folder: string, kind: BackupKind, now = new Date()): Promise<Omit<BackupResult, 'warning' | 'removed'>> {
  const tmp = tmpDir(dbFile);
  mkdirSync(tmp, { recursive: true });
  const name = freeName(folder, now);
  const tmpFile = join(tmp, `${name}.partial`);
  try { unlinkSync(tmpFile); } catch { /* none */ }
  try {
    await source.execute({ sql: 'VACUUM INTO ?', args: [tmpFile] });
    const v = await verifyDbFile(tmpFile);
    const sizeBytes = statSync(tmpFile).size;
    const sha256 = await sha256File(tmpFile);
    const dest = join(folder, name);
    copyFileSync(tmpFile, `${dest}.partial`);
    if (statSync(`${dest}.partial`).size !== sizeBytes) throw new Error('The copy in the backup folder is incomplete');
    renameSync(`${dest}.partial`, dest);
    const side: Sidecar = {
      app: 'tula', kind, createdAt: now.toISOString(), sizeBytes, sha256, appVersion: appVersion(),
      migrations: v.migrations, counts: v.counts, deviceId: v.deviceId, business: v.business, integrity: 'ok',
    };
    writeFileSync(`${sidecarOf(dest)}.partial`, JSON.stringify(side, null, 2));
    renameSync(`${sidecarOf(dest)}.partial`, sidecarOf(dest));
    return { file: name, path: dest, folder, sizeBytes, kind, createdAt: side.createdAt };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* gone */ }
    try { unlinkSync(join(folder, `${name}.partial`)); } catch { /* gone */ }
  }
}

const running = new Map<string, Promise<BackupResult>>();
export const isBackupRunning = (dbFile: string) => running.has(resolve(dbFile));

/**
 * Make a backup now, record the outcome in sync_state, and tidy old backups.
 * Never two at once (in this process, and across processes via backup.lock).
 * If the chosen folder (USB drive, Google Drive) cannot be reached, the backup is still made in the
 * default folder on this computer and the outcome carries a warning naming the folder.
 */
export function runBackup(db: Exec, dbFile: string, opts: { kind: BackupKind; now?: Date; auto?: boolean }): Promise<BackupResult> {
  const keyPath = resolve(dbFile);
  if (running.has(keyPath)) return Promise.reject(new UserError('A backup is already running. Try again in a minute.', 'BUSY', 409));
  const job = (async () => {
    const now = opts.now ?? new Date();
    const lock = acquireLock(backupLockFile(dbFile), 'backup', 30 * 60000);
    if (!lock.ok) throw new UserError('A backup is already running. Try again in a minute.', 'BUSY', 409);
    try {
      if (opts.auto) await setLocal(db, { [KEYS.lastAutoAt]: now.toISOString() });
      const cfg = await getBackupConfig(db, dbFile);
      const local = defaultBackupDir(dbFile);
      let folder = opts.kind === 'safety' ? local : cfg.folder;
      let warning: string | null = null;
      try {
        ensureWritable(folder);
      } catch (e) {
        if (samePath(folder, local)) throw e;
        warning = folder;
        folder = local;
        ensureWritable(folder);
      }
      const r = await snapshotTo(db, dbFile, folder, opts.kind, now);
      const removed = applyRetention(folder, now);
      if (opts.kind !== 'safety') {
        await setLocal(db, {
          [KEYS.lastOkAt]: now.toISOString(), [KEYS.lastOkFile]: r.file, [KEYS.lastWarning]: warning,
          ...(warning ? {} : { [KEYS.lastError]: null, [KEYS.lastErrorAt]: null }),
        });
      }
      return { ...r, warning, removed };
    } catch (e) {
      if (opts.kind !== 'safety') {
        await setLocal(db, { [KEYS.lastError]: errMessage(e).slice(0, 500), [KEYS.lastErrorAt]: now.toISOString() }).catch(() => {});
      }
      throw e;
    } finally {
      lock.release();
    }
  })();
  running.set(keyPath, job);
  return job.finally(() => running.delete(keyPath));
}

/** The folders that may hold this computer's backups: the chosen one and the local default (safety copies). */
export function backupFolders(cfg: BackupConfig, dbFile: string): string[] {
  const local = defaultBackupDir(dbFile);
  return samePath(cfg.folder, local) ? [local] : [cfg.folder, local];
}

/** Find a backup by bare file name in the known folders. The name is checked strictly, so no path tricks get through. */
export function findBackup(name: string, folders: string[]): BackupEntry | null {
  if (!isBackupName(name) || basename(name) !== name) return null;
  for (const f of folders) {
    const hit = listBackups(f).find((b) => b.file === name);
    if (hit) return hit;
  }
  return null;
}

export async function backupStatusValues(ex: Exec) {
  const v = await getLocal(ex, Object.values(KEYS));
  return {
    lastOk: v[KEYS.lastOkAt] ? { at: v[KEYS.lastOkAt]!, file: v[KEYS.lastOkFile] ?? null } : null,
    lastError: v[KEYS.lastErrorAt] ? { at: v[KEYS.lastErrorAt]!, message: v[KEYS.lastError] ?? '' } : null,
    lastWarningFolder: v[KEYS.lastWarning] ?? null,
    lastAutoAt: v[KEYS.lastAutoAt] ?? null,
    restored: v[KEYS.restoredAt] ? { at: v[KEYS.restoredAt]!, from: v[KEYS.restoredFrom] ?? '' } : null,
  };
}

export async function readDeviceId(ex: Exec): Promise<string | null> {
  return (await one<{ value: string }>(ex, "SELECT value FROM sync_state WHERE key = 'device_id'"))?.value ?? null;
}
