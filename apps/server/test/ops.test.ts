import { createClient } from '@libsql/client';
import { insert, openDb, type Db } from '@tula/db';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { setRestartForRestore } from '../src/ops';
import {
  applyRetention, getBackupConfig, KEYS, listBackups, retentionPlan, runBackup, setLocal, validateBackupFolder, verifyDbFile, type BackupKind,
} from '../src/ops/backup';
import { acquireLock } from '../src/ops/lock';
import { applyPendingRestore, readLastRestore, writePending } from '../src/ops/restore';
import { BackupScheduler, decide, nextRunAt, type ScheduleState } from '../src/ops/scheduler';
import { istAt, istStamp, parseEnvFile, pendingRestoreFile } from '../src/ops/util';
import { setup } from '../src/setup';
import { DailyLog, Supervisor } from '../src/supervisor';
import { callAs } from './helpers';

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tula-ops-'));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A real database file (WAL, like the shop), set up with demo data, owner signed in. */
async function bootFile() {
  const dir = tempDir();
  const dbFile = join(dir, 'data', 'tula.db');
  mkdirSync(join(dir, 'data'));
  const db = await openDb(`file:${dbFile}`);
  await setup(db, { preset: 'building-materials', demo: true });
  const app = await buildApp(db);
  const owner = (await app.inject('/api/auth/users')).json().find((u: { role: string }) => u.role === 'owner');
  const token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: owner.id, pin: '1234' } })).json().token as string;
  await app.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${token}` }, payload: { currentPin: '1234', newPin: '4826' } });
  return { dir, dbFile, db, app, call: callAs(app, token), ownerId: owner.id as string };
}

const count = async (db: Db, sql: string) => Number((await db.execute(sql)).rows[0]![0]);

describe('backups', () => {
  it('makes a verified copy of the live WAL database, with a .json beside it', async () => {
    const { db, dbFile, call } = await bootFile();
    expect((await call({ method: 'POST', url: '/api/ops/backup/run' })).statusCode).toBe(200);
    expect(String((await db.execute('PRAGMA journal_mode')).rows[0]![0])).toBe('wal');
    const dev = String((await db.execute("SELECT value FROM sync_state WHERE key='device_id'")).rows[0]![0]);
    await insert(db, 'audit_log', dev, { at: new Date().toISOString(), entity: 'test', entity_id: 'x', action: 'update', reason: 'before backup' });
    // an open write transaction elsewhere must not stop the backup
    const tx = await db.transaction('write');
    await tx.execute("UPDATE sync_state SET value = value WHERE key = 'device_id'");
    // (a bill being saved while the backup runs: released shortly after the backup starts)
    setTimeout(() => void tx.rollback(), 300);
    const { file } = await runBackup(db, dbFile, { kind: 'manual' });
    expect(file).toMatch(/^tula-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.db$/);
    const path = join(dbFile, '..', 'backups', file);
    const v = await verifyDbFile(path);
    expect(v.deviceId).toBe(dev);
    expect(v.counts.products).toBeGreaterThan(0);
    expect(v.counts.audit_log).toBe(await count(db, 'SELECT COUNT(*) FROM audit_log'));
    expect(v.migrations).toContain('0001_init.sql');
    const side = JSON.parse(readFileSync(path.replace(/\.db$/, '.json'), 'utf8'));
    expect(side).toMatchObject({ app: 'tula', kind: 'manual', integrity: 'ok', deviceId: dev });
    expect(side.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(dbFile, '..', 'tmp'))).toEqual([]); // temp copy cleaned up

    const s = (await call('/api/ops/backup')).json();
    expect(s.lastOk.file).toBe(file);
    expect(s.backups[0]).toMatchObject({ file, kind: 'manual' });
    expect(s.lastError).toBeNull();
  });

  it('never runs two backups at once', async () => {
    const { db, dbFile } = await bootFile();
    const a = runBackup(db, dbFile, { kind: 'manual' });
    await expect(runBackup(db, dbFile, { kind: 'manual' })).rejects.toMatchObject({ code: 'BUSY' });
    await a;
    // another live process holding the lock (e.g. the backup command) also blocks it
    const lockFile = join(dbFile, '..', 'backup.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: '', what: 'backup' }));
    await expect(runBackup(db, dbFile, { kind: 'manual' })).rejects.toMatchObject({ code: 'BUSY' });
    // a lock left by a dead process is stale and taken over
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: '', what: 'backup' }));
    await expect(runBackup(db, dbFile, { kind: 'manual' })).resolves.toMatchObject({ kind: 'manual' });
  });

  it('saves on this computer, with a warning, when the chosen folder cannot be reached', async () => {
    const { db, dbFile } = await bootFile();
    const usb = join(tempDir(), 'usb');
    mkdirSync(usb);
    await setLocal(db, { [KEYS.folder]: usb });
    rmSync(usb, { recursive: true });
    writeFileSync(usb, 'not a folder'); // the "drive" is gone
    const r = await runBackup(db, dbFile, { kind: 'scheduled' });
    expect(r.warning).toBe(usb);
    expect(r.folder).toBe(join(dbFile, '..', 'backups'));
  });

  it('records a failed backup without throwing out of the scheduler, and retries once after 10 minutes', async () => {
    let now = istAt(new Date('2026-10-25T00:00:00Z'), '21:05');
    const runs: string[] = [];
    let failNext = 2;
    let lastAuto: Date | null = null;
    const s = new BackupScheduler({
      now: () => now,
      config: async () => ({ enabled: true, time: '21:00' }),
      persisted: async () => ({ lastOkAt: new Date(now.getTime() - 3600000), lastAutoAt: lastAuto }),
      run: async (reason) => { runs.push(reason); lastAuto = now; if (failNext-- > 0) throw new Error('disk full'); },
    });
    expect(await s.tick()).toBe('daily');
    expect(s.retryAt?.getTime()).toBe(now.getTime() + 600000);
    now = new Date(now.getTime() + 5 * 60000);
    expect(await s.tick()).toBeNull();
    now = new Date(now.getTime() + 5 * 60000);
    expect(await s.tick()).toBe('retry');
    expect(s.retryAt).toBeNull(); // only one retry
    now = new Date(now.getTime() + 30 * 60000);
    expect(await s.tick()).toBeNull();
    expect(runs).toEqual(['daily', 'retry']);
  });
});

describe('retention', () => {
  const at = (iso: string) => new Date(iso);
  const name = (d: Date, n = '') => `tula-${istStamp(d)}${n}.db`;

  it('keeps 30 daily, 12 monthly and recent manual backups', () => {
    const now = at('2026-10-25T16:00:00Z');
    const entries: Array<{ file: string; at: Date; kind: BackupKind }> = [];
    // two backups a day for 400 days
    for (let i = 0; i < 400; i++) {
      const d = new Date(now.getTime() - i * 86400000 - 3600000);
      entries.push({ file: name(d), at: d, kind: 'scheduled' });
      const m = new Date(d.getTime() - 4 * 3600000);
      entries.push({ file: name(m), at: m, kind: i < 10 ? 'manual' : 'scheduled' });
    }
    const plan = retentionPlan(entries, now);
    const keep = new Set(plan.keep);
    // newest of each of the last 30 days
    for (let i = 0; i < 30; i++) expect(keep.has(entries[i * 2]!.file)).toBe(true);
    expect(keep.has(entries[30 * 2]!.file)).toBe(false);
    // manual backups from the last 7 days, not older ones
    for (let i = 0; i < 10; i++) expect(keep.has(entries[i * 2 + 1]!.file)).toBe(i <= 6);
    // 12 monthly: the first backup of each month
    const months = new Map<string, string>();
    for (const e of [...entries].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      const k = istStamp(e.at).slice(0, 7);
      if (!months.has(k)) months.set(k, e.file);
    }
    const recentMonths = [...months.keys()].sort().reverse().slice(0, 12);
    for (const m of recentMonths) expect(keep.has(months.get(m)!)).toBe(true);
    expect(keep.has(months.get([...months.keys()].sort().reverse()[12]!)!)).toBe(false);
    expect(plan.keep.length).toBe(30 + 7 + 12); // the first backup of a month is the oldest of its day, so never a daily keep
    expect(plan.keep.length + plan.remove.length).toBe(800);
  });

  it('deletes only Tula backups in the folder', () => {
    const dir = tempDir();
    const now = at('2026-10-25T16:00:00Z');
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, name(new Date(now.getTime() - i * 86400000))), 'x');
    writeFileSync(join(dir, 'tula.db'), 'live');
    writeFileSync(join(dir, 'tula-notes.db'), 'mine');
    writeFileSync(join(dir, 'photo.jpg'), 'mine');
    const removed = applyRetention(dir, now);
    expect(removed.length).toBeGreaterThan(0);
    const left = readdirSync(dir);
    expect(left).toEqual(expect.arrayContaining(['tula.db', 'tula-notes.db', 'photo.jpg']));
    expect(listBackups(dir).length).toBeLessThan(40);
  });
});

describe('schedule', () => {
  const day = new Date('2026-10-25T06:00:00Z'); // 11:30 India time
  const st = (p: Partial<ScheduleState> = {}): ScheduleState => ({ lastOkAt: null, lastAutoAt: null, retryAt: null, startupChecked: true, ...p });
  const cfg = { enabled: true, time: '21:00' };

  it('runs at the daily time, once', () => {
    const slot = istAt(day, '21:00');
    expect(slot.toISOString()).toBe('2026-10-25T15:30:00.000Z');
    expect(decide(new Date(slot.getTime() - 60000), cfg, st({ lastOkAt: day }))).toBeNull();
    expect(decide(slot, cfg, st({ lastOkAt: day }))).toBe('daily');
    expect(decide(new Date(slot.getTime() + 60000), cfg, st({ lastOkAt: slot, lastAutoAt: slot }))).toBeNull();
    // a manual backup does not replace the daily one
    expect(decide(new Date(slot.getTime() + 60000), cfg, st({ lastOkAt: slot, lastAutoAt: new Date(slot.getTime() - 86400000) }))).toBe('daily');
  });

  it('catches up at startup when the last good backup is older than 24 hours', () => {
    const morning = new Date('2026-10-26T04:00:00Z'); // 09:30, PC was off at 21:00
    expect(decide(morning, cfg, st({ startupChecked: false, lastOkAt: new Date(morning.getTime() - 25 * 3600000) }))).toBe('startup');
    expect(decide(morning, cfg, st({ startupChecked: false, lastOkAt: new Date(morning.getTime() - 20 * 3600000) }))).toBeNull();
    expect(decide(morning, cfg, st({ startupChecked: false }))).toBe('startup'); // never backed up
    expect(decide(morning, cfg, st({ startupChecked: true }))).toBeNull();
  });

  it('does nothing when turned off, and reports the next run', () => {
    expect(decide(istAt(day, '22:00'), { ...cfg, enabled: false }, st())).toBeNull();
    expect(nextRunAt(day, { ...cfg, enabled: false }, st())).toBeNull();
    expect(nextRunAt(day, cfg, st({ lastOkAt: day }))!.toISOString()).toBe('2026-10-25T15:30:00.000Z');
    const after = istAt(day, '21:30');
    expect(nextRunAt(after, cfg, st({ lastOkAt: after, lastAutoAt: after }))!.toISOString()).toBe('2026-10-26T15:30:00.000Z');
  });
});

describe('backup settings', () => {
  it('validates the folder and time', async () => {
    const { call, dbFile } = await bootFile();
    const bad = async (folder: string, code: string) => {
      const r = await call({ method: 'PUT', url: '/api/ops/backup', payload: { folder } });
      expect(r.statusCode, folder).toBe(400);
      expect(r.json().error).toBe(code);
    };
    await bad('backups', 'FOLDER_NOT_ABSOLUTE');
    await bad(join(dbFile, '..'), 'FOLDER_IN_DATA');
    await bad(join(dbFile, '..', 'logs'), 'FOLDER_IN_DATA');
    const file = join(tempDir(), 'file');
    writeFileSync(file, 'x');
    await bad(join(file, 'sub'), 'FOLDER_UNREACHABLE');
    expect((await call({ method: 'PUT', url: '/api/ops/backup', payload: { time: '25:00' } })).statusCode).toBe(400);

    const drive = join(tempDir(), 'My Drive', 'Tula backups');
    const ok = await call({ method: 'PUT', url: '/api/ops/backup', payload: { folder: drive, time: '19:30', enabled: false } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ folder: drive, time: '19:30', enabled: false, isDefaultFolder: false });
    expect(existsSync(drive)).toBe(true);
    expect(validateBackupFolder(drive, dbFile).folder).toBe(drive);
    // empty folder = back to the default
    const back = (await call({ method: 'PUT', url: '/api/ops/backup', payload: { folder: '' } })).json();
    expect(back.isDefaultFolder).toBe(true);
  });

  it('keeps settings in the local-only sync_state table, not in synced settings', async () => {
    const { call, db, dbFile } = await bootFile();
    await call({ method: 'PUT', url: '/api/ops/backup', payload: { time: '20:15' } });
    expect((await getBackupConfig(db, dbFile)).time).toBe('20:15');
    expect(await count(db, "SELECT COUNT(*) FROM settings WHERE key LIKE 'ops.%'")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) FROM sync_outbox WHERE row_id LIKE 'ops.%'")).toBe(0);
  });
});

describe('downloads', () => {
  it('streams a backup and refuses anything that is not a backup name', async () => {
    const { call } = await bootFile();
    const { file } = (await call({ method: 'POST', url: '/api/ops/backup/run' })).json();
    const r = await call(`/api/ops/backup/${file}/download`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain(file);
    expect(r.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
    for (const evil of ['..%2F..%2Fdata%2Ftula.db', '..%2Ftula.db', 'tula.db', '%2Fetc%2Fpasswd', `${file.replace('.db', '')}%2F..%2F..%2Ftula.db`, 'tula-2026-10-25-2100.db%00.txt', 'tula-2099-01-01-0000.db']) {
      const x = await call(`/api/ops/backup/${evil}/download`);
      expect(x.statusCode, evil).toBeGreaterThanOrEqual(400);
      expect(x.rawPayload.subarray(0, 15).toString()).not.toBe('SQLite format 3');
    }
  });
});

describe('roles', () => {
  it('refuses backup and restore to billing staff', async () => {
    const { app, call } = await bootFile();
    const u = (await call({ method: 'POST', url: '/api/users', payload: { name: 'Counter', role: 'billing', pin: '2468' } })).json();
    const t = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { userId: u.id, pin: '2468' } })).json().token;
    await app.inject({ method: 'POST', url: '/api/auth/pin', headers: { authorization: `Bearer ${t}` }, payload: { currentPin: '2468', newPin: '5937' } });
    const staff = callAs(app, t);
    expect((await staff('/api/ops/backup')).statusCode).toBe(403);
    expect((await staff('/api/ops/info')).statusCode).toBe(403);
    expect((await staff({ method: 'POST', url: '/api/ops/backup/run' })).statusCode).toBe(403);
    expect((await staff({ method: 'PUT', url: '/api/ops/backup', payload: { time: '10:00' } })).statusCode).toBe(403);
    expect((await staff({ method: 'POST', url: '/api/ops/restore', payload: { file: 'x', pin: '5937' } })).statusCode).toBe(403);
    const { file } = (await call({ method: 'POST', url: '/api/ops/backup/run' })).json();
    expect((await staff(`/api/ops/backup/${file}/download`)).statusCode).toBe(403);
  });

  it('shows machine info to the owner', async () => {
    const { call, dbFile } = await bootFile();
    const i = (await call('/api/ops/info')).json();
    expect(i).toMatchObject({ dbFile, version: '0.1.0', supervised: false });
    expect(i.dbSizeBytes).toBeGreaterThan(0);
    expect(i.disk?.freeBytes).toBeGreaterThan(0);
  });
});

describe('restore', () => {
  it('swaps the backup in before start, keeping this computer settings and the old files', async () => {
    const { db, dbFile, call } = await bootFile();
    const { file } = (await call({ method: 'POST', url: '/api/ops/backup/run' })).json();
    const before = await count(db, 'SELECT COUNT(*) FROM audit_log');
    const dev = String((await db.execute("SELECT value FROM sync_state WHERE key='device_id'")).rows[0]![0]);
    for (let i = 0; i < 3; i++) await insert(db, 'audit_log', dev, { at: new Date().toISOString(), entity: 'test', entity_id: String(i), action: 'update', reason: 'after backup' });
    await setLocal(db, { [KEYS.time]: '18:45' }); // changed after the backup: must survive the restore
    db.close();
    writePending(dbFile, { backup: join(dbFile, '..', 'backups', file), requestedAt: '', requestedBy: null, safety: null, keep: { [KEYS.time]: '18:45' } });

    const out = await applyPendingRestore(dbFile);
    expect(out).toMatchObject({ ok: true });
    expect(existsSync(pendingRestoreFile(dbFile))).toBe(false);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(join(dbFile, '..', 'before-restore', 'tula.db'))).toBe(true);
    const restored = await openDb(`file:${dbFile}`);
    expect(await count(restored, 'SELECT COUNT(*) FROM audit_log')).toBe(before);
    expect(String((await restored.execute(`SELECT value FROM sync_state WHERE key='${KEYS.time}'`)).rows[0]![0])).toBe('18:45');
    expect(String((await restored.execute(`SELECT value FROM sync_state WHERE key='${KEYS.restoredFrom}'`)).rows[0]![0])).toBe(file);
    restored.close();
    expect(readLastRestore(dbFile)?.ok).toBe(true);
    // nothing pending: nothing happens
    expect(await applyPendingRestore(dbFile)).toBeNull();
  });

  it('leaves the current database alone when the backup is damaged or from a newer version', async () => {
    const { db, dbFile, call } = await bootFile();
    const { file } = (await call({ method: 'POST', url: '/api/ops/backup/run' })).json();
    const path = join(dbFile, '..', 'backups', file);
    const n = await count(db, 'SELECT COUNT(*) FROM products');
    db.close();

    const damaged = path.replace('.db', '-9.db');
    const bytes = readFileSync(path);
    bytes.fill(0x41, 5000, 9000);
    writeFileSync(damaged, bytes);
    writePending(dbFile, { backup: damaged, requestedAt: '', requestedBy: null, safety: null, keep: {} });
    expect((await applyPendingRestore(dbFile))?.ok).toBe(false);

    const newer = path.replace('.db', '-8.db');
    writeFileSync(newer, readFileSync(path));
    const c = createClient({ url: `file:${newer}` });
    await c.execute("INSERT INTO schema_migrations VALUES ('9999_future.sql', '')");
    c.close();
    writePending(dbFile, { backup: newer, requestedAt: '', requestedBy: null, safety: null, keep: {} });
    const out = await applyPendingRestore(dbFile);
    expect(out?.ok).toBe(false);
    expect(out?.error).toMatch(/newer version/);

    const still = await openDb(`file:${dbFile}`);
    expect(await count(still, 'SELECT COUNT(*) FROM products')).toBe(n);
    still.close();
  });

  it('from the app: re-asks the PIN, takes a safety backup, leaves a marker and restarts', async () => {
    const { call, dbFile } = await bootFile();
    const { file } = (await call({ method: 'POST', url: '/api/ops/backup/run' })).json();
    expect((await call({ method: 'POST', url: '/api/ops/restore', payload: { file, pin: '4826' } })).json().error).toBe('NOT_SUPERVISED');
    process.env.TULA_SUPERVISED = '1';
    let restarted = 0;
    setRestartForRestore(() => { restarted++; });
    try {
      expect((await call({ method: 'POST', url: '/api/ops/restore', payload: { file, pin: '0000' } })).json().error).toBe('BAD_PIN');
      expect((await call('/api/ops/backup')).statusCode).toBe(200); // still signed in
      expect((await call({ method: 'POST', url: '/api/ops/restore', payload: { file: '../tula.db', pin: '4826' } })).statusCode).toBe(404);
      expect(restarted).toBe(0);
      const r = await call({ method: 'POST', url: '/api/ops/restore', payload: { file, pin: '4826' } });
      expect(r.statusCode).toBe(202);
      expect(restarted).toBe(1);
      const marker = JSON.parse(readFileSync(pendingRestoreFile(dbFile), 'utf8'));
      expect(marker.backup).toBe(join(dbFile, '..', 'backups', file));
      expect(existsSync(marker.safety)).toBe(true);
      expect(listBackups(join(dbFile, '..', 'backups')).find((b) => b.kind === 'safety')).toBeTruthy();
    } finally {
      delete process.env.TULA_SUPERVISED;
    }
  });
});

describe('supervisor', () => {
  const fakeChild = (dir: string) => {
    const f = join(dir, 'fake-server.mjs');
    writeFileSync(f, `
import http from 'node:http';
import fs from 'node:fs';
const log = process.env.FAKE_LOG;
fs.appendFileSync(log, 'start ' + process.pid + ' db=' + fs.readFileSync(process.env.TULA_DB, 'utf8').slice(0, 20) + ' supervised=' + process.env.TULA_SUPERVISED + '\\n');
const mode = process.env.FAKE_MODE;
const server = http.createServer((req, res) => { if (mode !== 'hang') res.end('{"ok":true}'); });
server.listen(Number(process.env.FAKE_PORT || 0), '127.0.0.1');
if (mode === 'crash-once' && !fs.existsSync(log + '.crashed')) { fs.writeFileSync(log + '.crashed', '1'); setTimeout(() => process.exit(1), 50); }
process.on('SIGTERM', () => process.exit(0));
`);
    return f;
  };
  const waitFor = async (fn: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const fast = { backoffMs: [50, 100], stopTimeoutMs: 500, healthIntervalMs: 100, healthTimeoutMs: 100, maxHealthFails: 3, startupGraceMs: 0 };

  it('restarts a crashed server and applies a pending restore before starting', async () => {
    const dir = tempDir();
    const dbFile = join(dir, 'tula.db');
    writeFileSync(dbFile, 'CURRENT-DB');
    // a pending restore whose backup is not a real database: refused, current file kept, server still starts
    writePending(dbFile, { backup: join(dir, 'missing.db'), requestedAt: '', requestedBy: null, safety: null, keep: {} });
    const log = join(dir, 'fake.log');
    const sup = new Supervisor({
      command: process.execPath, args: [fakeChild(dir)], cwd: dir, dbFile, healthUrl: null, ...fast,
      env: { ...process.env, TULA_DB: dbFile, FAKE_LOG: log, FAKE_MODE: 'crash-once' },
    });
    const events: string[] = [];
    sup.on('restore', (r) => events.push(`restore:${r.ok}`));
    sup.on('exit', (e) => events.push(`exit:${e.code}`));
    await sup.start();
    await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').split('\n').filter(Boolean).length >= 2);
    await sup.stop();
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines[0]).toContain('db=CURRENT-DB');
    expect(lines[0]).toContain('supervised=1');
    expect(events.slice(0, 2)).toEqual(['restore:false', 'exit:1']);
    expect(sup.restarts).toBe(1);
    expect(existsSync(pendingRestoreFile(dbFile))).toBe(false);
  });

  it('swaps in a real backup before the server starts', async () => {
    const { db, dbFile, call } = await bootFile();
    const { file } = (await call({ method: 'POST', url: '/api/ops/backup/run' })).json();
    db.close();
    writePending(dbFile, { backup: join(dbFile, '..', 'backups', file), requestedAt: '', requestedBy: null, safety: null, keep: {} });
    const dir = tempDir();
    const log = join(dir, 'fake.log');
    const sup = new Supervisor({ command: process.execPath, args: [fakeChild(dir)], cwd: dir, dbFile, healthUrl: null, ...fast, env: { ...process.env, TULA_DB: dbFile, FAKE_LOG: log } });
    let restoredBeforeSpawn = false;
    sup.on('spawn', () => { restoredBeforeSpawn = !existsSync(pendingRestoreFile(dbFile)) && existsSync(join(dbFile, '..', 'before-restore', 'tula.db')); });
    await sup.start();
    await waitFor(() => existsSync(log));
    await sup.stop();
    expect(restoredBeforeSpawn).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('db=SQLite format 3');
  });

  it('restarts a server that stops answering', async () => {
    const dir = tempDir();
    const dbFile = join(dir, 'tula.db');
    writeFileSync(dbFile, 'x');
    const port = 52000 + Math.floor(Math.random() * 2000);
    const log = join(dir, 'fake.log');
    const sup = new Supervisor({
      command: process.execPath, args: [fakeChild(dir)], cwd: dir, dbFile, healthUrl: `http://127.0.0.1:${port}/api/health`, ...fast,
      env: { ...process.env, TULA_DB: dbFile, FAKE_LOG: log, FAKE_MODE: 'hang', FAKE_PORT: String(port) },
    });
    let hung = 0;
    sup.on('hung', () => hung++);
    await sup.start();
    await waitFor(() => hung >= 1 && existsSync(log) && readFileSync(log, 'utf8').trim().split('\n').length >= 2, 10000);
    await sup.stop();
    expect(hung).toBeGreaterThanOrEqual(1);
  });

  it('refuses a second copy, but takes over a lock left by a dead process', () => {
    const dir = tempDir();
    const lockFile = join(dir, 'tula-supervisor.lock');
    const first = acquireLock(lockFile, 'supervisor');
    expect(first.ok).toBe(true);
    const fakeOther = JSON.parse(readFileSync(lockFile, 'utf8'));
    fakeOther.pid = process.ppid; // a live process that is not us
    writeFileSync(lockFile, JSON.stringify(fakeOther));
    const second = acquireLock(lockFile, 'supervisor');
    expect(second.ok).toBe(false);
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: '', what: 'supervisor' }));
    const third = acquireLock(lockFile, 'supervisor');
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it('writes a log per day and keeps 14 days', async () => {
    const dir = tempDir();
    for (let i = 1; i <= 20; i++) writeFileSync(join(dir, `tula-2026-10-${String(i).padStart(2, '0')}.log`), 'old');
    writeFileSync(join(dir, 'other.log'), 'keep');
    const l = new DailyLog(dir, 14, () => new Date('2026-10-25T06:00:00Z'));
    l.line('hello');
    await l.close();
    const files = readdirSync(dir).sort();
    expect(files).toContain('other.log');
    expect(files).toContain('tula-2026-10-11.log');
    expect(files).not.toContain('tula-2026-10-10.log');
    expect(readFileSync(join(dir, 'tula-2026-10-25.log'), 'utf8')).toContain('[supervisor] hello');
  });

  it('reads tula.env files', () => {
    expect(parseEnvFile('# comment\nTULA_PORT=5000\nTULA_DB="C:\\TulaData\\tula.db"\n bad line\nTULA_SYNC_TOKEN=\n')).toEqual({
      TULA_PORT: '5000', TULA_DB: 'C:\\TulaData\\tula.db', TULA_SYNC_TOKEN: '',
    });
  });
});
