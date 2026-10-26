import { insert, nowIso, one, update, type Db } from '@tula/db';
import type { Router } from '../http';
import { z } from 'zod';
import { requireOwner } from '../auth';
import { UserError } from '../context';
import { pendingCount } from './engine';
import { hubLabel, tokenExpiry } from './hub';
import { rows } from './schema';
import { getStates } from './state';
import type { SyncWorker } from './worker';

export interface SyncStatus {
  configured: boolean;
  running: boolean;
  /** host of the cloud copy only — never the token or the full URL */
  hub: string | null;
  /** when the access token stops working (its exp claim), null if it never does; never the token itself */
  tokenExpiresAt: string | null;
  device: { id: string; name: string; seriesCode: string; revoked: boolean };
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: { code: string; message: string; at: string | null } | null;
  pending: number;
  rejected: number;
  joinedAt: string | null;
  joinMode: string | null;
}

export async function syncStatus(db: Db, deviceId: string, worker: SyncWorker | undefined): Promise<SyncStatus> {
  const s = await getStates(db, 'sync.');
  const cfg = worker?.cfg;
  const dev = await one<{ name: string; series_code: string; revoked: number }>(db, 'SELECT name, series_code, revoked FROM devices WHERE id = ?', [deviceId]);
  const rejected = await one<{ n: number }>(db, 'SELECT COUNT(*) n FROM sync_rejects');
  return {
    configured: !!cfg,
    running: !!worker,
    hub: cfg ? hubLabel(cfg.url) : null,
    tokenExpiresAt: tokenExpiry(cfg?.token),
    device: { id: deviceId, name: dev?.name ?? '', seriesCode: dev?.series_code ?? '', revoked: !!dev?.revoked },
    lastPushAt: s['sync.last_push_at'] || null,
    lastPullAt: s['sync.last_pull_at'] || null,
    lastError: s['sync.last_error'] ? { code: s['sync.last_error_code'] || 'OTHER', message: s['sync.last_error'], at: s['sync.last_error_at'] || null } : null,
    pending: await pendingCount(db),
    rejected: Number(rejected?.n ?? 0),
    joinedAt: s['sync.joined_at'] || null,
    joinMode: s['sync.join_mode'] || null,
  };
}

export function registerSyncRoutes(app: Router, db: Db, deviceId: string, workerOf: () => SyncWorker | undefined) {
  app.get('/api/sync/status', async (req) => {
    requireOwner(req);
    return syncStatus(db, deviceId, workerOf());
  });

  /** Run a round now and return the fresh status. Owner only (writes are owner-only by default in auth.ts). */
  app.post('/api/sync/now', async (req) => {
    requireOwner(req);
    const w = workerOf();
    if (!w) throw new UserError('Cloud copy is not set up on this computer. See "How to set it up" below.', 'SYNC_OFF', 409);
    const result = await w.runNow();
    return { result: { ok: result.ok }, status: await syncStatus(db, deviceId, w) };
  });

  app.get('/api/devices', async (req) => {
    requireOwner(req);
    const list = await rows(db, 'SELECT id, name, series_code, is_primary, revoked, created_at, updated_at FROM devices WHERE deleted = 0 ORDER BY created_at, id');
    return list.map((d) => ({ ...d, is_primary: Number(d.is_primary), revoked: Number(d.revoked), this_device: d.id === deviceId }));
  });

  app.put('/api/devices/:id', async (req) => {
    requireOwner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(40).optional(), revoked: z.boolean().optional() }).parse(req.body);
    const d = await one<{ name: string; revoked: number }>(db, 'SELECT name, revoked FROM devices WHERE id = ? AND deleted = 0', [id]);
    if (!d) throw new UserError('Device not found', 'NOT_FOUND', 404);
    if (b.revoked === true && id === deviceId) throw new UserError('You cannot mark this computer as lost from itself. Do it from another computer.', 'THIS_DEVICE');
    const patch: Record<string, string | number> = {};
    if (b.name !== undefined && b.name !== d.name) patch.name = b.name;
    if (b.revoked !== undefined && Number(b.revoked) !== Number(d.revoked)) patch.revoked = b.revoked ? 1 : 0;
    if (!Object.keys(patch).length) return { ok: true };
    const tx = await db.transaction('write');
    try {
      await update(tx, 'devices', deviceId, id, patch);
      await insert(tx, 'audit_log', deviceId, { at: nowIso(), user_id: req.user!.id, entity: 'devices', entity_id: id, action: 'update', before_json: { name: d.name, revoked: d.revoked }, after_json: patch });
      await tx.commit();
    } catch (e) {
      if (!tx.closed) await tx.rollback();
      throw e;
    }
    return { ok: true };
  });
}
