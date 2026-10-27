import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { driveAppRunning, findDriveFolders, type DriveEnv } from '../src/ops/drive';
import { bootSignedIn } from './helpers';

/* Finding Google Drive for desktop folders for the backup (ops/drive.ts), on a pretend computer. */

/** A pretend file system holding `dirs` (either slash; tests run on Windows and Linux). */
const fake = (platform: NodeJS.Platform, dirs: string[], home = 'C:\\Users\\Shop'): DriveEnv => {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const set = new Set(dirs.map(norm));
  return {
    platform, usersDir: 'C:\\Users', home,
    isDir: (p) => set.has(norm(p)),
    list: (p) => [...new Set(dirs.filter((d) => norm(d).startsWith(`${norm(p)}/`)).map((d) => d.replace(/\\/g, '/').slice(p.length + 1).split('/')[0]!))],
  };
};

describe('Google Drive folders', () => {
  it('finds Mirror folders of every Windows account first, then a streamed drive letter', () => {
    const f = findDriveFolders(fake('win32', ['C:\\Users\\Shop\\My Drive', 'C:\\Users\\Owner\\Google Drive', 'C:\\Users\\Public\\My Drive', 'G:\\My Drive']));
    expect(f.map((x) => [x.kind, x.user, x.root])).toEqual([
      ['mirror', 'Shop', join('C:\\Users', 'Shop', 'My Drive')],
      ['mirror', 'Owner', join('C:\\Users', 'Owner', 'Google Drive')],
      ['stream', null, 'G:\\My Drive'],
    ]);
    expect(f[0]!.suggested).toBe(join('C:\\Users', 'Shop', 'My Drive', 'Tula backups'));
  });

  it('finds nothing when Drive for desktop is not installed', () => {
    expect(findDriveFolders(fake('win32', ['C:\\Users\\Shop\\Documents']))).toEqual([]);
  });

  it('looks in the home folder on Linux and macOS', () => {
    const home = '/home/shop';
    const f = findDriveFolders(fake('darwin', [`${home}/Library/CloudStorage/GoogleDrive-shop@gmail.com/My Drive`, `${home}/Library/CloudStorage`], home));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'stream', user: 'shop@gmail.com' });
  });

  it('cannot tell whether the Drive program runs outside Windows', async () => {
    expect(await driveAppRunning('linux')).toBeNull();
  });

  it('is offered to the owner by the API', async () => {
    const b = await bootSignedIn({ preset: 'blank' });
    const r = await b.call('/api/ops/drive');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ folders: expect.any(Array) });
  });
});
