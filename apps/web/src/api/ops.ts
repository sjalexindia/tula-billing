import { req } from '../api';
import { apiFetch } from '../platform';

export type BackupKind = 'scheduled' | 'manual' | 'safety';
export interface BackupItem { file: string; sizeBytes: number; createdAt: string; kind: BackupKind; appVersion: string | null; checked: boolean; where: 'chosen' | 'local' }
export interface BackupStatus {
  folder: string; defaultFolder: string; isDefaultFolder: boolean; enabled: boolean; time: string;
  folderError: string | null; sameDisk: boolean; running: boolean;
  lastOk: { at: string; file: string | null } | null;
  lastError: { at: string; message: string } | null;
  lastWarningFolder: string | null;
  nextRunAt: string | null;
  restored: { at: string; from: string } | null;
  lastRestore: { ok: boolean; at: string; backup: string; error?: string } | null;
  canRestoreHere: boolean;
  backups: BackupItem[];
}
export interface MachineInfo {
  version: string; node: string; os: string; hostname: string; dbFile: string; dbSizeBytes: number; dataDir: string; uptimeSec: number;
  disk: { freeBytes: number; totalBytes: number } | null; port: number; lanUrls: string[]; supervised: boolean;
}

export const opsApi = {
  status: () => req<BackupStatus>('GET', '/api/ops/backup'),
  saveConfig: (c: { folder?: string; time?: string; enabled?: boolean }) => req<BackupStatus>('PUT', '/api/ops/backup', c),
  runNow: () => req<{ file: string; sizeBytes: number; createdAt: string; warningFolder: string | null }>('POST', '/api/ops/backup/run', {}),
  restore: (file: string, pin: string) => req<{ restarting: boolean; safety: string }>('POST', '/api/ops/restore', { file, pin }),
  info: () => req<MachineInfo>('GET', '/api/ops/info'),
  downloadUrl: (file: string) => `/api/ops/backup/${encodeURIComponent(file)}/download`,
  /** true when the server answers (used while it restarts after a restore) */
  alive: async () => {
    try {
      const r = await apiFetch('/api/health', { cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  },
};
