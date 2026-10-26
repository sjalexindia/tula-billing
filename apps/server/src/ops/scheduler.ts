import { istAt } from './util';

/**
 * When to make an automatic backup. Pure, so the rules are tested with a fake clock.
 *
 * - daily: once the day's backup time (India time) has passed and no automatic backup was tried since then;
 * - startup: once, shortly after the server starts, if the last good backup is older than 24 hours
 *   (shop PCs are often switched off before the daily time);
 * - retry: a failed automatic backup is tried once more 10 minutes later.
 */
export interface ScheduleConfig { enabled: boolean; time: string }
export interface ScheduleState {
  lastOkAt: Date | null;
  /** last automatic attempt (success or failure) */
  lastAutoAt: Date | null;
  retryAt: Date | null;
  startupChecked: boolean;
}
export type RunReason = 'retry' | 'daily' | 'startup';

export const RETRY_AFTER_MS = 10 * 60000;
export const STALE_MS = 24 * 3600000;

export function decide(now: Date, cfg: ScheduleConfig, st: ScheduleState): RunReason | null {
  if (!cfg.enabled) return null;
  if (st.retryAt && now >= st.retryAt) return 'retry';
  const slot = istAt(now, cfg.time);
  if (now >= slot && (!st.lastAutoAt || st.lastAutoAt < slot)) return 'daily';
  if (!st.startupChecked && (!st.lastOkAt || now.getTime() - st.lastOkAt.getTime() >= STALE_MS)) return 'startup';
  return null;
}

/** When the next automatic backup is expected (for the Backup screen). */
export function nextRunAt(now: Date, cfg: ScheduleConfig, st: ScheduleState): Date | null {
  if (!cfg.enabled) return null;
  const soon = decide(now, cfg, st);
  if (soon) return now;
  const slot = istAt(now, cfg.time);
  const next = now < slot ? slot : istAt(now, cfg.time, 1);
  return st.retryAt && st.retryAt < next ? st.retryAt : next;
}

export interface SchedulerDeps {
  now: () => Date;
  config: () => Promise<ScheduleConfig>;
  /** persisted state (last good backup, last automatic attempt) */
  persisted: () => Promise<{ lastOkAt: Date | null; lastAutoAt: Date | null }>;
  /** make the backup; throw on failure */
  run: (reason: RunReason) => Promise<unknown>;
  log?: (msg: string) => void;
}

/** Holds the in-memory part of the state (retry, startup check) and runs at most one backup at a time. */
export class BackupScheduler {
  retryAt: Date | null = null;
  startupChecked = false;
  busy = false;
  constructor(private deps: SchedulerDeps) {}

  async state(): Promise<ScheduleState> {
    const p = await this.deps.persisted();
    return { ...p, retryAt: this.retryAt, startupChecked: this.startupChecked };
  }

  /** One check; returns what it ran (if anything). Errors never escape: billing must not be affected. */
  async tick(): Promise<RunReason | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const now = this.deps.now();
      const cfg = await this.deps.config();
      const reason = decide(now, cfg, await this.state());
      this.startupChecked = true;
      if (!reason) return null;
      if (reason === 'retry') this.retryAt = null;
      try {
        await this.deps.run(reason);
        this.retryAt = null;
        this.deps.log?.(`Backup done (${reason})`);
      } catch (e) {
        // Retry once, ten minutes later; a failed retry waits for the next daily time.
        if (reason !== 'retry') this.retryAt = new Date(now.getTime() + RETRY_AFTER_MS);
        this.deps.log?.(`Backup failed (${reason}): ${(e as Error).message}`);
      }
      return reason;
    } catch (e) {
      this.deps.log?.(`Backup check failed: ${(e as Error).message}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Check after `firstMs`, then every `everyMs`. Returns stop(). */
  start(firstMs = 30000, everyMs = 60000): () => void {
    let interval: NodeJS.Timeout | undefined;
    const first = setTimeout(() => {
      void this.tick();
      interval = setInterval(() => void this.tick(), everyMs);
      interval.unref();
    }, firstMs);
    first.unref();
    return () => { clearTimeout(first); if (interval) clearInterval(interval); };
  }
}
