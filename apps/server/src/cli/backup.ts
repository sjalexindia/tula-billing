import { runBackup, type BackupKind } from '../ops/backup';
import { errMessage } from '../ops/util';
import { cliSetup, fail, flag, mb, openExisting, option } from './common';

/**
 * One-off backup (safe while Tula is running).
 *   node --import tsx apps/server/src/cli/backup.ts [--env-file C:\TulaData\tula.env] [--kind manual|safety] [--json]
 * safety backups always go to <data>/backups on this computer (used before an update or a restore).
 */
const { args, dbFile } = cliSetup();
const kind = (option(args, '--kind') ?? 'manual') as BackupKind;
if (!['manual', 'safety'].includes(kind)) fail('--kind must be manual or safety');
try {
  const db = await openExisting(dbFile);
  const r = await runBackup(db, dbFile, { kind });
  db.close();
  if (flag(args, '--json')) console.log(JSON.stringify(r));
  else {
    console.log(`Backup saved: ${r.path} (${mb(r.sizeBytes)})`);
    if (r.warning) console.log(`Note: could not reach ${r.warning}, so the backup was saved on this computer instead.`);
    if (r.removed.length) console.log(`Removed ${r.removed.length} old backup(s).`);
  }
} catch (e) {
  fail(`Backup failed: ${errMessage(e)}`);
}
