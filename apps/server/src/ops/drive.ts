import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/*
 * Google Drive for desktop as the backup's way to the cloud (spec UC-32, no monthly cost):
 * Tula writes the daily backup into a folder that Drive for desktop copies to Google Drive.
 * This finds such folders on the shop computer, so the Backup screen can offer one tap.
 *
 * What can be told honestly from here:
 * - "mirror": Drive set to Mirror files keeps a real folder, C:\Users\<name>\My Drive. Tula runs as
 *   the Windows SYSTEM account and can write there. The recommended choice.
 * - "stream": the default Stream files mode shows Drive as a drive letter (G:\My Drive) that exists
 *   only for the signed-in person. Tula as a Windows service cannot see it, so it is offered with a warning.
 * - whether the Drive program (GoogleDriveFS.exe) is running. Not whether it is signed in or up to date.
 */

export type DriveKind = 'mirror' | 'stream';
export interface DriveFolder {
  /** the My Drive folder found */
  root: string;
  /** where Tula would put backups: <root>\Tula backups */
  suggested: string;
  kind: DriveKind;
  /** Windows account it belongs to, when known */
  user: string | null;
}
export interface DriveInfo { folders: DriveFolder[]; appRunning: boolean | null }

export interface DriveEnv {
  platform: NodeJS.Platform;
  /** C:\Users on Windows; scanned for <name>\My Drive and <name>\Google Drive */
  usersDir: string;
  /** this process's home (Linux/macOS, or Tula started by hand on Windows) */
  home: string;
  isDir: (p: string) => boolean;
  list: (p: string) => string[];
}

const nodeEnv = (): DriveEnv => ({
  platform: process.platform,
  usersDir: join(process.env.SystemDrive ?? 'C:', '\\Users'),
  home: homedir(),
  isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  list: (p) => { try { return readdirSync(p); } catch { return []; } },
});

const SKIP_USERS = new Set(['public', 'default', 'default user', 'all users', 'defaultapppool']);

export function findDriveFolders(env: DriveEnv = nodeEnv()): DriveFolder[] {
  const out: DriveFolder[] = [];
  const seen = new Set<string>();
  const add = (root: string, kind: DriveKind, user: string | null) => {
    const key = root.toLowerCase();
    if (seen.has(key) || !env.isDir(root)) return;
    seen.add(key);
    out.push({ root, suggested: join(root, 'Tula backups'), kind, user });
  };
  if (env.platform === 'win32') {
    // Mirror files: C:\Users\<name>\My Drive (current) or \Google Drive (older Backup and Sync)
    for (const user of env.list(env.usersDir)) {
      if (SKIP_USERS.has(user.toLowerCase())) continue;
      for (const name of ['My Drive', 'Google Drive']) add(join(env.usersDir, user, name), 'mirror', user);
    }
    // Stream files: a drive letter with "My Drive" on it (usually G:)
    for (const letter of 'GHIJKLMNOPQRSTUVWXYZDEF') add(`${letter}:\\My Drive`, 'stream', null);
  } else {
    for (const name of ['My Drive', 'Google Drive']) add(join(env.home, name), 'mirror', null);
    // macOS Drive for desktop: ~/Library/CloudStorage/GoogleDrive-<account>/My Drive
    const cloud = join(env.home, 'Library', 'CloudStorage');
    for (const d of env.list(cloud)) if (d.startsWith('GoogleDrive-')) add(join(cloud, d, 'My Drive'), 'stream', d.slice(12));
  }
  // mirror folders first: they are the ones a Windows service can write to
  return out.sort((a, b) => Number(a.kind === 'stream') - Number(b.kind === 'stream'));
}

/** Is Google Drive for desktop running? null when it can't be told (not Windows, or tasklist failed). */
export function driveAppRunning(platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq GoogleDriveFS.exe', '/NH'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : /GoogleDriveFS\.exe/i.test(stdout));
    });
  });
}

export async function driveInfo(): Promise<DriveInfo> {
  return { folders: findDriveFolders(), appRunning: await driveAppRunning() };
}
