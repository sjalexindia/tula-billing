import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock } from './ops/lock';
import { applyPendingRestore, type RestoreOutcome } from './ops/restore';
import {
  APP_ROOT, dataDir, errMessage, istDate, loadEnvFileArg, logDirFor, pendingRestoreFile, resolveDbFile, RESTORE_EXIT_CODE, supervisorLockFile,
} from './ops/util';
import { existsSync } from 'node:fs';

/**
 * The supervisor is what the auto-start (Windows Scheduled Task, systemd) runs. It:
 * - applies a pending restore, then starts the server as a child process;
 * - restarts it when it exits (2 s, 5 s, 15 s, 30 s, then every 60 s; back to 2 s after 10 healthy minutes);
 * - asks GET /api/health every 30 s and restarts the server after 3 failures in a row (hung);
 * - writes everything to <data>/logs/tula-YYYY-MM-DD.log, keeping 14 days;
 * - refuses to run twice (lock file with its PID; a lock left by a dead process is taken over);
 * - stops the server cleanly on Ctrl+C / service stop.
 *
 *   node --import tsx apps/server/src/supervisor.ts [--env-file C:\TulaData\tula.env]
 */

export interface SupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  dbFile: string;
  /** null: no health checks */
  healthUrl: string | null;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  maxHealthFails?: number;
  /** failures before the server first answers are ignored for this long (first start can be slow) */
  startupGraceMs?: number;
  backoffMs?: number[];
  healthyResetMs?: number;
  stopTimeoutMs?: number;
  log?: (line: string) => void;
  output?: (chunk: string) => void;
}

export const DEFAULTS = {
  healthIntervalMs: 30000, healthTimeoutMs: 5000, maxHealthFails: 3, startupGraceMs: 120000,
  backoffMs: [2000, 5000, 15000, 30000, 60000], healthyResetMs: 10 * 60000, stopTimeoutMs: 10000,
};

export class Supervisor extends EventEmitter {
  private o: Required<Omit<SupervisorOptions, 'healthUrl'>> & { healthUrl: string | null };
  child: ChildProcess | null = null;
  private startedAt = 0;
  private attempt = 0;
  private healthFails = 0;
  private answered = false;
  private checking = false;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private launching = false;
  private killing: ChildProcess | null = null;
  restarts = 0;

  constructor(opts: SupervisorOptions) {
    super();
    this.o = { ...DEFAULTS, log: () => {}, output: () => {}, ...opts };
  }

  private log(m: string) { this.o.log(m); }

  async start(): Promise<void> {
    this.healthTimer = setInterval(() => void this.checkHealth(), this.o.healthIntervalMs);
    await this.launch();
  }

  private async launch(): Promise<void> {
    if (this.stopping || this.child || this.launching) return;
    this.launching = true;
    try {
      const r: RestoreOutcome | null = await applyPendingRestore(this.o.dbFile, (m) => this.log(m));
      if (r) this.emit('restore', r);
    } catch (e) {
      this.log(`Restore step failed: ${errMessage(e)}`);
    }
    this.launching = false;
    if (this.stopping) return;
    const child = spawn(this.o.command, this.o.args, {
      cwd: this.o.cwd, env: { ...this.o.env, TULA_SUPERVISED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    this.child = child;
    this.startedAt = Date.now();
    this.healthFails = 0;
    this.answered = false;
    child.stdout?.on('data', (d: Buffer) => this.o.output(d.toString()));
    child.stderr?.on('data', (d: Buffer) => this.o.output(d.toString()));
    child.on('error', (e) => this.log(`Could not start Tula: ${e.message}`));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    this.log(`Started Tula (process ${child.pid ?? '?'})`);
    this.emit('spawn', child.pid);
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (this.child !== child) return;
    this.child = null;
    this.emit('exit', { code, signal });
    if (this.stopping) { this.emit('stopped'); return; }
    const uptime = Date.now() - this.startedAt;
    if (uptime >= this.o.healthyResetMs) this.attempt = 0;
    const restore = code === RESTORE_EXIT_CODE || existsSync(pendingRestoreFile(this.o.dbFile));
    const delay = restore ? 0 : this.o.backoffMs[Math.min(this.attempt, this.o.backoffMs.length - 1)]!;
    if (!restore) this.attempt++;
    this.restarts++;
    this.log(restore ? 'Tula stopped to restore a backup; restoring and starting again'
      : `Tula stopped (${signal ? `signal ${signal}` : `exit code ${code}`}) after ${Math.round(uptime / 1000)} s; starting again in ${Math.round(delay / 1000)} s`);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; void this.launch(); }, delay);
  }

  private async checkHealth(): Promise<void> {
    const child = this.child;
    if (!this.o.healthUrl || !child || this.checking || this.stopping || this.killing === child) return;
    this.checking = true;
    let ok = false;
    try {
      const res = await fetch(this.o.healthUrl, { signal: AbortSignal.timeout(this.o.healthTimeoutMs) });
      ok = res.ok;
    } catch { ok = false; }
    this.checking = false;
    if (this.child !== child || this.stopping || this.killing === child) return;
    if (ok) { this.healthFails = 0; this.answered = true; return; }
    if (!this.answered && Date.now() - this.startedAt < this.o.startupGraceMs) return;
    this.healthFails++;
    this.log(`Tula did not answer the health check (${this.healthFails} of ${this.o.maxHealthFails})`);
    if (this.healthFails >= this.o.maxHealthFails) {
      this.log('Tula is not answering; restarting it');
      this.emit('hung', child.pid);
      this.healthFails = 0;
      this.kill(child);
    }
  }

  /** Ask politely, then force after stopTimeoutMs (a frozen process cannot handle SIGTERM). */
  private kill(child: ChildProcess) {
    this.killing = child;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        this.log('Tula did not stop in time; forcing it');
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    }, this.o.stopTimeoutMs);
    t.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    const child = this.child;
    if (!child) return;
    this.log('Stopping Tula');
    await new Promise<void>((res) => {
      this.once('stopped', res);
      this.kill(child);
    });
  }
}

// ---------- Logs: <data>/logs/tula-YYYY-MM-DD.log, 14 days ----------
export class DailyLog {
  private day = '';
  private stream: WriteStream | null = null;
  constructor(private dir: string, private keepDays = 14, private now = () => new Date()) {
    mkdirSync(dir, { recursive: true });
  }

  write(text: string) {
    const day = istDate(this.now());
    if (day !== this.day) {
      this.stream?.end();
      this.day = day;
      this.stream = createWriteStream(join(this.dir, `tula-${day}.log`), { flags: 'a' });
      this.prune();
    }
    this.stream!.write(text);
  }

  line(msg: string) {
    this.write(`${new Date().toISOString()} [supervisor] ${msg}\n`);
  }

  prune() {
    const cutoff = istDate(new Date(this.now().getTime() - this.keepDays * 86400000));
    for (const f of readdirSync(this.dir)) {
      const m = /^tula-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1]! < cutoff) {
        try { unlinkSync(join(this.dir, f)); } catch { /* in use */ }
      }
    }
  }

  close(): Promise<void> {
    return new Promise((res) => (this.stream ? this.stream.end(res) : res()));
  }
}

// ---------- Run as a program ----------
async function main() {
  loadEnvFileArg(process.argv.slice(2));
  const dbFile = resolveDbFile(process.env, APP_ROOT);
  process.env.TULA_DB = dbFile; // the server gets the same absolute path
  mkdirSync(dataDir(dbFile), { recursive: true });
  const logs = new DailyLog(logDirFor(dbFile));
  const tty = process.stdout.isTTY;
  const say = (m: string) => { logs.line(m); if (tty) console.log(m); };

  const lock = acquireLock(supervisorLockFile(dbFile), 'supervisor');
  if (!lock.ok) {
    const msg = `Tula is already running (process ${lock.holder.pid}, since ${lock.holder.startedAt}). Not starting a second copy.`;
    logs.line(msg);
    console.error(msg);
    await logs.close();
    process.exit(3);
  }

  const port = Number(process.env.TULA_PORT ?? 5000);
  const sup = new Supervisor({
    command: process.execPath,
    args: ['--import', 'tsx', join(APP_ROOT, 'apps', 'server', 'src', 'main.ts')],
    cwd: APP_ROOT,
    env: process.env,
    dbFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    // for testing only; the defaults (every 30 s, 3 failures) suit the shop
    ...(process.env.TULA_HEALTH_INTERVAL_MS ? { healthIntervalMs: Number(process.env.TULA_HEALTH_INTERVAL_MS) } : {}),
    log: say,
    output: (c) => { logs.write(c); if (tty) process.stdout.write(c); },
  });

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    say(`Stopping (${why})`);
    await sup.stop();
    say('Stopped');
    if (lock.ok) lock.release();
    await logs.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig));
  process.on('uncaughtException', (e) => say(`Supervisor error: ${e.stack ?? e.message}`));
  process.on('exit', () => { if (lock.ok) lock.release(); });

  say(`Tula supervisor starting: database ${dbFile}, port ${port}, logs ${logDirFor(dbFile)}`);
  await sup.start();
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`Tula supervisor could not start: ${errMessage(e)}`);
    process.exit(1);
  });
}
