import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A lock file holding the owner's PID. A lock is stale (and taken over) when that process
 * no longer exists, or when it is older than `maxAgeMs` (for short jobs such as a backup).
 */
export interface LockInfo { pid: number; startedAt: string; what: string }

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(file: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/** Who holds the lock right now, or null if it is free or stale. */
export function lockHolder(file: string, maxAgeMs?: number): LockInfo | null {
  const info = readLock(file);
  if (!info) return null;
  if (!pidAlive(info.pid)) return null;
  if (maxAgeMs !== undefined) {
    try {
      if (Date.now() - statSync(file).mtimeMs > maxAgeMs) return null;
    } catch {
      return null;
    }
  }
  return info;
}

export type Acquired = { ok: true; release: () => void } | { ok: false; holder: LockInfo };

export function acquireLock(file: string, what: string, maxAgeMs?: number): Acquired {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), what };
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return {
        ok: true,
        release: () => {
          if (readLock(file)?.pid === process.pid) {
            try { unlinkSync(file); } catch { /* already gone */ }
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = lockHolder(file, maxAgeMs);
      if (holder && holder.pid !== process.pid) return { ok: false, holder };
      try { unlinkSync(file); } catch { /* someone else removed it */ }
    }
  }
  const holder = readLock(file);
  return { ok: false, holder: holder ?? { pid: 0, startedAt: '', what } };
}
