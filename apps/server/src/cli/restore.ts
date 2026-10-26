import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { backupFolders, findBackup, getBackupConfig, getLocal, MACHINE_KEYS, readSidecar, runBackup } from '../ops/backup';
import { prepareCandidate, swapIn } from '../ops/restore';
import { errMessage } from '../ops/util';
import { closeDb } from '@tula/db/node';
import { cliSetup, fail, flag, openExisting, positional, runningInfo } from './common';

/**
 * Restore a backup. Tula must be stopped first (Stop-ScheduledTask Tula / systemctl stop tula).
 *   node --import tsx apps/server/src/cli/restore.ts <backup file or name> [--env-file …] [--yes]
 * Checks the backup, takes a safety backup of the current database, then swaps it in
 * (the old database and its -wal/-shm files go to <data>/before-restore/).
 */
const { args, dbFile, port } = cliSetup();
const target = positional(args, ['--env-file'])[0];
if (!target) fail('Give the backup file to restore, e.g. restore.ts "E:\\Tula backups\\tula-2026-10-25-2100.db"');

const run = await runningInfo(dbFile, port);
if (run.supervisor || run.answering) {
  fail(`Tula is running${run.supervisor ? ` (process ${run.supervisor.pid})` : ` on port ${port}`}. Stop it first, then run the restore again.`, 2);
}

try {
  const current = existsSync(dbFile) ? await openExisting(dbFile) : null;
  let path = isAbsolute(target!) || existsSync(target!) ? resolve(target!) : null;
  if (!path && current) path = findBackup(target!, backupFolders(await getBackupConfig(current, dbFile), dbFile))?.path ?? null;
  if (!path || !existsSync(path)) fail(`Backup not found: ${target}`);

  const { candidate, verified } = await prepareCandidate(path, dbFile);
  const side = readSidecar(path);
  console.log(`Backup:   ${path}`);
  console.log(`Made:     ${side?.createdAt ?? 'unknown'}${side ? ` (Tula ${side.appVersion}, ${side.kind})` : ''}`);
  console.log(`Business: ${verified.business ?? '(not set)'}`);
  console.log(`Contents: ${Object.entries(verified.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`Replaces: ${dbFile}`);

  if (!flag(args, '--yes')) {
    if (!process.stdin.isTTY) fail('Add --yes to restore without a question.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type RESTORE to replace the current data with this backup: ');
    rl.close();
    if (answer.trim().toUpperCase() !== 'RESTORE') fail('Nothing changed.', 0);
  }

  let keep: Record<string, string> = {};
  if (current) {
    const safety = await runBackup(current, dbFile, { kind: 'safety' });
    console.log(`Safety backup of the current data: ${safety.path}`);
    keep = await getLocal(current, MACHINE_KEYS);
    await closeDb(current);
  }
  await swapIn(dbFile, candidate, keep, basename(path));
  console.log('Restored. Start Tula again (Start-ScheduledTask Tula, or systemctl start tula).');
} catch (e) {
  fail(`Restore failed; the current data was not changed: ${errMessage(e)}`);
}
