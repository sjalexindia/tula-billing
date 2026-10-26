import { one, type Db } from '@tula/db';
import type { FastifyInstance } from 'fastify';
import { createReadStream, statSync, statfsSync } from 'node:fs';
import { arch, hostname, networkInterfaces, release, type as osType } from 'node:os';
import { z } from 'zod';
import { requireOwner, verifyPin } from './auth';
import { UserError } from './context';
import {
  BackupConfigInput, backupFolders, backupStatusValues, findBackup, getBackupConfig, getLocal, isBackupRunning, listBackups,
  MACHINE_KEYS, runBackup, saveBackupConfig, type BackupKind,
} from './ops/backup';
import { prepareCandidate, readLastRestore, writePending } from './ops/restore';
import { BackupScheduler, nextRunAt } from './ops/scheduler';
import { appVersion, dataDir, defaultBackupDir, errMessage, resolveDbFile, RESTORE_EXIT_CODE } from './ops/util';

/** Backup and restore, machine info, and what the supervisor (auto-start) needs. */

let scheduler: BackupScheduler | null = null;
/** How the server leaves after a restore is requested. Tests replace it. */
let restartForRestore: (app: FastifyInstance, db: Db) => void = (app, db) => {
  setTimeout(() => {
    void (async () => {
      try { await app.close(); } catch { /* closing anyway */ }
      try { db.close(); } catch { /* closing anyway */ }
      process.exit(RESTORE_EXIT_CODE);
    })();
  }, 300);
};
export const setRestartForRestore = (fn: typeof restartForRestore) => { restartForRestore = fn; };

/** The database file behind this connection (PRAGMA database_list), or TULA_DB for an in-memory database. */
async function dbFileOf(db: Db): Promise<string> {
  const r = await one<{ file: string }>(db, "SELECT file FROM pragma_database_list WHERE name = 'main'");
  return r?.file ? r.file : resolveDbFile();
}

export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      if (/^(docker|br-|veth|vEthernet|VirtualBox|VMware)/i.test(name)) continue;
      out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

const supervised = () => process.env.TULA_SUPERVISED === '1';

// Wrong PINs at restore count separately from sign-in; three strikes, five minutes.
const restoreFails = { count: 0, until: 0 };

export function registerOps(app: FastifyInstance, db: Db, _deviceId: string): void {
  let dbFileP: Promise<string> | null = null;
  const dbFile = () => (dbFileP ??= dbFileOf(db));

  const status = async () => {
    const file = await dbFile();
    const cfg = await getBackupConfig(db, file);
    const v = await backupStatusValues(db);
    let folderError: string | null = null;
    let sameDisk = false;
    try {
      statSync(cfg.folder);
      sameDisk = statSync(cfg.folder).dev === statSync(dataDir(file)).dev;
    } catch (e) {
      folderError = cfg.isDefaultFolder ? null : errMessage(e);
    }
    const st = scheduler ? await scheduler.state() : {
      lastOkAt: v.lastOk ? new Date(v.lastOk.at) : null, lastAutoAt: v.lastAutoAt ? new Date(v.lastAutoAt) : null, retryAt: null, startupChecked: true,
    };
    const folders = backupFolders(cfg, file);
    const backups = folders.flatMap((f) => listBackups(f).map((b) => ({
      file: b.file, sizeBytes: b.sizeBytes, createdAt: b.createdAt, kind: b.kind, appVersion: b.appVersion, checked: b.checked,
      where: f === cfg.folder ? 'chosen' : 'local',
    }))).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return {
      folder: cfg.folder, defaultFolder: defaultBackupDir(file), isDefaultFolder: cfg.isDefaultFolder, enabled: cfg.enabled, time: cfg.time,
      folderError, sameDisk, running: isBackupRunning(file),
      lastOk: v.lastOk, lastError: v.lastError && (!v.lastOk || v.lastError.at > v.lastOk.at) ? v.lastError : null,
      lastWarningFolder: v.lastWarningFolder,
      nextRunAt: nextRunAt(new Date(), { enabled: cfg.enabled, time: cfg.time }, st)?.toISOString() ?? null,
      restored: v.restored, lastRestore: readLastRestore(file),
      canRestoreHere: supervised(), backups,
    };
  };

  app.get('/api/ops/backup', async (req) => {
    requireOwner(req);
    return status();
  });

  app.put('/api/ops/backup', async (req) => {
    const body = BackupConfigInput.parse(req.body);
    await saveBackupConfig(db, await dbFile(), body);
    return status();
  });

  app.post('/api/ops/backup/run', async () => {
    const r = await runBackup(db, await dbFile(), { kind: 'manual' });
    return { file: r.file, sizeBytes: r.sizeBytes, createdAt: r.createdAt, warningFolder: r.warning };
  });

  app.get('/api/ops/backup/:file/download', async (req, reply) => {
    requireOwner(req);
    const { file } = z.object({ file: z.string().max(80) }).parse(req.params);
    const f = await dbFile();
    const hit = findBackup(file, backupFolders(await getBackupConfig(db, f), f));
    if (!hit) throw new UserError('Backup not found', 'NOT_FOUND', 404);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${hit.file}"`);
    reply.header('content-length', String(hit.sizeBytes));
    return reply.send(createReadStream(hit.path));
  });

  app.post('/api/ops/restore', async (req, reply) => {
    requireOwner(req);
    const body = z.object({ file: z.string().max(80), pin: z.string().max(12) }).parse(req.body);
    if (restoreFails.until > Date.now()) throw new UserError('Too many wrong PINs. Try again in a few minutes.', 'LOCKED', 429);
    const u = await one<{ pin_hash: string }>(db, 'SELECT pin_hash FROM users WHERE id = ? AND deleted = 0', [req.user!.id]);
    if (!u || !verifyPin(body.pin, u.pin_hash)) {
      restoreFails.count += 1;
      if (restoreFails.count >= 3) { restoreFails.count = 0; restoreFails.until = Date.now() + 5 * 60000; }
      // not 401: the app treats 401 as "signed out"
      throw new UserError('Wrong PIN', 'BAD_PIN', 403);
    }
    restoreFails.count = 0;
    if (!supervised()) {
      throw new UserError('Restoring from the app needs Tula to run as the installed service. Stop Tula and use the restore command instead (see the install guide).', 'NOT_SUPERVISED', 409);
    }
    const f = await dbFile();
    const hit = findBackup(body.file, backupFolders(await getBackupConfig(db, f), f));
    if (!hit) throw new UserError('Backup not found', 'NOT_FOUND', 404);
    await prepareCandidate(hit.path, f); // refuse a damaged or newer backup now, while the owner is watching
    const safety = await runBackup(db, f, { kind: 'safety' });
    writePending(f, {
      backup: hit.path, requestedAt: new Date().toISOString(), requestedBy: req.user!.id, safety: safety.path,
      keep: await getLocal(db, MACHINE_KEYS),
    });
    app.log.warn(`Restore of ${hit.file} requested; restarting`);
    await reply.status(202).send({ restarting: true, safety: safety.file });
    restartForRestore(app, db);
    return reply;
  });

  app.get('/api/ops/info', async (req) => {
    requireOwner(req);
    const f = await dbFile();
    const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
    let disk: { freeBytes: number; totalBytes: number } | null = null;
    try {
      const s = statfsSync(dataDir(f));
      disk = { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch { /* not available */ }
    const port = Number(process.env.TULA_PORT ?? 5000);
    return {
      version: appVersion(), node: process.version, os: `${osType()} ${release()} (${arch()})`, hostname: hostname(),
      dbFile: f, dbSizeBytes: size(f) + size(`${f}-wal`), dataDir: dataDir(f), uptimeSec: Math.round(process.uptime()),
      disk, port, lanUrls: lanUrls(port), supervised: supervised(),
    };
  });
}

function requireOwnerLocal(req: { user?: { role: string } }) {
  if (req.user?.role !== 'owner') throw new UserError('Only the owner can do this', 'FORBIDDEN', 403);
}

/** Background jobs started after the server is listening: scheduled backups. Returns stop(). */
export function startOpsJobs(db: Db, opts: { dbFile: string }): () => void {
  const log = (m: string) => console.log(`[ops] ${m}`);
  scheduler = new BackupScheduler({
    now: () => new Date(),
    config: async () => getBackupConfig(db, opts.dbFile),
    persisted: async () => {
      const v = await backupStatusValues(db);
      return { lastOkAt: v.lastOk ? new Date(v.lastOk.at) : null, lastAutoAt: v.lastAutoAt ? new Date(v.lastAutoAt) : null };
    },
    run: async (reason) => {
      const kind: BackupKind = 'scheduled';
      const r = await runBackup(db, opts.dbFile, { kind, auto: true });
      log(`Backup ${r.file} (${reason}) saved in ${r.folder}${r.warning ? `; could not reach ${r.warning}` : ''}`);
    },
    log,
  });
  const stopScheduler = scheduler.start(Number(process.env.TULA_BACKUP_FIRST_CHECK_MS ?? 30000));

  // Under the supervisor: if the supervisor goes away, do not linger holding the port.
  const onDisconnect = () => { log('Supervisor gone; stopping'); process.emit('SIGTERM'); };
  if (supervised() && process.send) process.on('disconnect', onDisconnect);

  // Test hook for the supervisor's hang detection: freeze the event loop after N ms.
  const hangMs = Number(process.env.TULA_TEST_HANG_AFTER_MS ?? 0);
  if (hangMs > 0) setTimeout(() => { log('TEST: freezing'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }, hangMs);

  return () => {
    stopScheduler();
    process.off('disconnect', onDisconnect);
    scheduler = null;
  };
}
