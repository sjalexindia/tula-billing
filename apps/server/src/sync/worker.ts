import type { Db } from '@tula/db';
import { openHub, type Hub, type HubConfig, type HubDriver } from './hub';
import { pendingCount, syncOnce } from './engine';
import { getState, recordError, setState } from './state';

export interface WorkerOptions {
  /** full round (push + pull) every … ms; default 30 s */
  intervalMs?: number;
  /** after local changes appear in the outbox, sync this much later; default 3 s */
  activityDelayMs?: number;
  /** how often the outbox count is checked; default 1 s */
  pollMs?: number;
  /** first retry delay after a failure, doubled each time; default 5 s */
  backoffStartMs?: number;
  /** longest wait between retries; default 5 min */
  maxBackoffMs?: number;
  log?: (msg: string) => void;
}

export interface RunResult { ok: boolean; pushed?: number; pulled?: number; rejected?: number; error?: string }

/**
 * Background sync for one database. Never throws into the server: every failure is caught,
 * recorded in sync_state (sync.last_error…) and retried with exponential backoff.
 */
export class SyncWorker {
  readonly cfg: HubConfig;
  private hub: Hub | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<RunResult> | null = null;
  private stopped = false;
  private failures = 0;
  private nextRunAt = 0;
  private activityAt = 0;
  private lastPending = -1;
  private lastLogged = '';
  private readonly o: Required<Omit<WorkerOptions, 'log'>> & { log: (m: string) => void };

  constructor(private db: Db, cfg: HubConfig, private driver: HubDriver, opts: WorkerOptions = {}) {
    this.cfg = cfg;
    this.o = {
      intervalMs: opts.intervalMs ?? 30_000,
      activityDelayMs: opts.activityDelayMs ?? 3_000,
      pollMs: opts.pollMs ?? 1_000,
      backoffStartMs: opts.backoffStartMs ?? 5_000,
      maxBackoffMs: opts.maxBackoffMs ?? 300_000,
      log: opts.log ?? ((m) => console.log(m)),
    };
  }

  get running() { return !!this.current; }
  get hubLabel() { return this.hub?.label ?? null; }
  get consecutiveFailures() { return this.failures; }

  start() {
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
    return this;
  }

  private async tick() {
    if (this.stopped || this.current) return;
    try {
      const now = Date.now();
      const pending = await pendingCount(this.db);
      if (pending > this.lastPending && pending > 0) this.activityAt = now;
      this.lastPending = pending;
      const activityDue = this.failures === 0 && pending > 0 && this.activityAt > 0 && now >= this.activityAt + this.o.activityDelayMs;
      if (now >= this.nextRunAt || activityDue) await this.runNow();
    } catch {
      /* the database may be closing; the next tick tries again */
    }
  }

  /** Run one round now (or wait for the one already running). Used by "Sync now". */
  runNow(): Promise<RunResult> {
    if (this.stopped) return Promise.resolve({ ok: false, error: 'stopped' });
    if (!this.current) this.current = this.run().finally(() => { this.current = null; });
    return this.current;
  }

  private async run(): Promise<RunResult> {
    try {
      const deviceId = await getState(this.db, 'device_id');
      if (!deviceId) return { ok: false, error: 'not set up' };
      if (!this.hub) this.hub = await openHub(this.cfg, this.driver);
      const r = await syncOnce(this.db, this.hub, deviceId);
      if (this.failures) this.o.log(`sync: working again (${this.hub.label})`);
      this.failures = 0;
      this.lastLogged = '';
      this.nextRunAt = Date.now() + this.o.intervalMs;
      this.activityAt = 0;
      this.lastPending = await pendingCount(this.db);
      return { ok: true, ...r };
    } catch (e) {
      this.failures++;
      const wait = Math.min(this.o.maxBackoffMs, this.o.backoffStartMs * 2 ** (this.failures - 1));
      this.nextRunAt = Date.now() + wait;
      this.activityAt = 0;
      // reconnect next time: the hub may have moved, the token changed, or the connection broken
      try { this.hub?.close(); } catch { /* already closed */ }
      this.hub = null;
      let message = 'sync failed';
      try {
        const d = await recordError(this.db, e, this.cfg.token);
        await setState(this.db, 'sync.pending', await pendingCount(this.db));
        message = d.message;
      } catch { /* database closing */ }
      if (message !== this.lastLogged) {
        this.o.log(`sync: ${message} Next try in ${Math.round(wait / 1000)} s.`);
        this.lastLogged = message;
      }
      return { ok: false, error: message };
    }
  }

  /** Stop the timer; an in-flight round finishes on its own. */
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const close = () => { try { this.hub?.close(); } catch { /* ignore */ } this.hub = null; };
    if (this.current) void this.current.finally(close);
    else close();
  }

  /** Wait for an in-flight round (tests, shutdown). */
  async idle() {
    while (this.current) await this.current.catch(() => {});
  }
}
