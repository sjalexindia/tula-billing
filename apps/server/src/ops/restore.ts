import { createClient } from '@libsql/client';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { UserError } from '../context';
import { KEYS, setLocal, unknownMigrations, verifyDbFile, type Verified } from './backup';
import { dataDir, errMessage, lastRestoreFile, pendingRestoreFile, tmpDir } from './util';

/**
 * Restoring replaces the database file, which must never happen while the server has it open.
 * - From the app: the server verifies the backup, takes a safety backup, writes restore-pending.json
 *   and exits; the supervisor calls applyPendingRestore() before starting the server again.
 * - From the command line (server stopped): cli/restore.ts verifies, takes a safety backup and calls swapIn().
 */

export interface PendingRestore {
  /** full path of the backup file to restore */
  backup: string;
  requestedAt: string;
  requestedBy: string | null;
  /** safety backup of the database being replaced */
  safety: string | null;
  /** this computer's settings (backup folder/time) to keep after the swap */
  keep: Record<string, string>;
}

export interface RestoreOutcome { ok: boolean; at: string; backup: string; safety: string | null; error?: string; counts?: Record<string, number> }

/** Copy a backup to a local temp file and check it thoroughly. Returns the temp copy. */
export async function prepareCandidate(backupPath: string, dbFile: string): Promise<{ candidate: string; verified: Verified }> {
  if (!existsSync(backupPath)) throw new UserError(`Backup file not found: ${backupPath}`, 'NOT_FOUND', 404);
  mkdirSync(tmpDir(dbFile), { recursive: true });
  const candidate = join(tmpDir(dbFile), 'restore-candidate.db');
  for (const s of ['', '-wal', '-shm', '-journal']) rmSync(candidate + s, { force: true });
  copyFileSync(backupPath, candidate);
  const verified = await verifyDbFile(candidate);
  const newer = unknownMigrations(verified.migrations);
  if (newer.length) {
    rmSync(candidate, { force: true });
    throw new UserError('This backup was made by a newer version of Tula. Update Tula on this computer first, then restore.', 'NEWER_BACKUP');
  }
  return { candidate, verified };
}

const SIDE_FILES = ['', '-wal', '-shm', '-journal'];

/**
 * Put `candidate` in place of the database. The old database and its -wal/-shm are moved to
 * <data>/before-restore/ (never deleted outright), so a stale WAL can never be replayed onto the restored file.
 * If the final rename fails, the old files are put back.
 */
export async function swapIn(dbFile: string, candidate: string, keep: Record<string, string>, fromName: string, now = new Date()): Promise<void> {
  const keepDir = join(dataDir(dbFile), 'before-restore');
  mkdirSync(keepDir, { recursive: true });
  const base = basename(dbFile);
  for (const s of SIDE_FILES) rmSync(join(keepDir, base + s), { force: true });
  const moved: string[] = [];
  for (const s of SIDE_FILES) {
    if (existsSync(dbFile + s)) {
      renameSync(dbFile + s, join(keepDir, base + s));
      moved.push(s);
    }
  }
  try {
    renameSync(candidate, dbFile);
  } catch (e) {
    for (const s of moved) renameSync(join(keepDir, base + s), dbFile + s);
    throw e;
  }
  const c = createClient({ url: `file:${dbFile}` });
  try {
    await setLocal(c, { ...keep, [KEYS.restoredAt]: now.toISOString(), [KEYS.restoredFrom]: fromName });
  } finally {
    c.close();
  }
}

export function readPending(dbFile: string): PendingRestore | null {
  const f = pendingRestoreFile(dbFile);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as PendingRestore;
  } catch {
    return { backup: '', requestedAt: '', requestedBy: null, safety: null, keep: {} };
  }
}

export function writePending(dbFile: string, p: PendingRestore): void {
  const f = pendingRestoreFile(dbFile);
  writeFileSync(`${f}.partial`, JSON.stringify(p, null, 2));
  renameSync(`${f}.partial`, f);
}

export function readLastRestore(dbFile: string): RestoreOutcome | null {
  try {
    return JSON.parse(readFileSync(lastRestoreFile(dbFile), 'utf8')) as RestoreOutcome;
  } catch {
    return null;
  }
}

/**
 * Called by the supervisor before every start. Does nothing without a marker. On any problem the
 * current database is left untouched, the marker is removed (so the server still starts) and the
 * outcome is written to restore-last.json for the Backup screen.
 */
export async function applyPendingRestore(dbFile: string, log: (m: string) => void = () => {}): Promise<RestoreOutcome | null> {
  const p = readPending(dbFile);
  if (!p) return null;
  const outcome: RestoreOutcome = { ok: false, at: new Date().toISOString(), backup: p.backup, safety: p.safety };
  try {
    if (!p.backup) throw new Error('The restore request was unreadable');
    log(`Restoring ${p.backup} …`);
    const { candidate, verified } = await prepareCandidate(p.backup, dbFile);
    await swapIn(dbFile, candidate, p.keep ?? {}, basename(p.backup));
    outcome.ok = true;
    outcome.counts = verified.counts;
    log(`Restored ${basename(p.backup)}. The previous database is in ${join(dataDir(dbFile), 'before-restore')}${p.safety ? ` and in the safety backup ${p.safety}` : ''}.`);
  } catch (e) {
    outcome.error = errMessage(e);
    log(`Restore failed, keeping the current database: ${outcome.error}`);
  }
  writeFileSync(lastRestoreFile(dbFile), JSON.stringify(outcome, null, 2));
  try { unlinkSync(pendingRestoreFile(dbFile)); } catch { /* gone */ }
  return outcome;
}
