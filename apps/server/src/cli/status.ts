import { existsSync, statSync } from 'node:fs';
import { lanUrls } from '../ops';
import { backupFolders, backupStatusValues, getBackupConfig, listBackups } from '../ops/backup';
import { readLastRestore, readPending } from '../ops/restore';
import { appVersion, errMessage, logDirFor } from '../ops/util';
import { cliSetup, flag, healthOk, mb, openExisting, option, runningInfo } from './common';

/**
 * What the install/status scripts show.
 *   node --import tsx apps/server/src/cli/status.ts [--env-file …] [--json] [--wait SECONDS]
 * --wait: wait until Tula answers (exit 0) or the time runs out (exit 1). Used by install and update.
 */
const { args, dbFile, port } = cliSetup();

const wait = Number(option(args, '--wait') ?? 0);
if (wait > 0) {
  const until = Date.now() + wait * 1000;
  while (Date.now() < until) {
    if (await healthOk(port)) { console.log(`Tula is answering on port ${port}`); process.exit(0); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`Tula did not answer on port ${port} within ${wait} s`);
  process.exit(1);
}

const run = await runningInfo(dbFile, port);
const out: Record<string, unknown> = {
  version: appVersion(), dbFile, dbExists: existsSync(dbFile), dbSizeBytes: [dbFile, `${dbFile}-wal`].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0),
  supervisorPid: run.supervisor?.pid ?? null, answering: run.answering, port,
  localUrl: `http://localhost:${port}`, lanUrls: lanUrls(port), logs: logDirFor(dbFile),
  pendingRestore: readPending(dbFile), lastRestore: readLastRestore(dbFile),
};
if (existsSync(dbFile)) {
  try {
    const db = await openExisting(dbFile);
    const cfg = await getBackupConfig(db, dbFile);
    const v = await backupStatusValues(db);
    const list = backupFolders(cfg, dbFile).flatMap((f) => listBackups(f));
    out.backup = { folder: cfg.folder, enabled: cfg.enabled, time: cfg.time, lastOk: v.lastOk, lastError: v.lastError, count: list.length, newest: list[0]?.path ?? null };
    db.close();
  } catch (e) {
    out.backupError = errMessage(e);
  }
}

if (flag(args, '--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const b = out.backup as { folder: string; enabled: boolean; time: string; lastOk: { at: string } | null; lastError: { at: string; message: string } | null; count: number } | undefined;
  console.log(`Tula ${out.version}`);
  console.log(`Running:      ${run.supervisor ? `yes (supervisor process ${run.supervisor.pid})` : 'no supervisor'}; ${run.answering ? 'answering' : 'NOT answering'} on port ${port}`);
  console.log(`Database:     ${dbFile} (${out.dbExists ? mb(out.dbSizeBytes as number) : 'not created yet'})`);
  console.log(`On this PC:   http://localhost:${port}`);
  for (const u of out.lanUrls as string[]) console.log(`Phones:       ${u}`);
  if (b) {
    console.log(`Backups:      ${b.count} in ${b.folder}; daily at ${b.time}${b.enabled ? '' : ' (TURNED OFF)'}`);
    console.log(`Last backup:  ${b.lastOk ? new Date(b.lastOk.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'never'}`);
    if (b.lastError && (!b.lastOk || b.lastError.at > b.lastOk.at)) console.log(`Last problem: ${b.lastError.message}`);
  }
  if (out.pendingRestore) console.log('A restore is waiting for the next start.');
  console.log(`Logs:         ${out.logs}`);
}
