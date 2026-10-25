import { insert, nowIso, update, uuidv7, type Db } from '@tula/db';
import type { Hub } from './hub';
import { push } from './engine';
import { pageStmt, rows, rowsOf, syncedTables, upsertStmt } from './schema';
import { getState, setState, SyncError } from './state';

export type JoinMode = 'new' | 'replace';

export interface JoinOptions {
  mode: JoinMode;
  /** replace: the device id this computer takes over (TULA_JOIN_DEVICE) */
  replaceDeviceId?: string;
  /** new: name shown on the Devices screen (TULA_DEVICE_NAME), default "Computer 2" etc. */
  name?: string;
  log?: (msg: string) => void;
}

export interface JoinResult { deviceId: string; seriesCode: string; name: string; mode: JoinMode; rows: number; cursor: number }

const COPY_PAGE = 1000;

/** Series codes for extra computers: C2…C9 then CA…CZ — two characters, so invoice numbers stay within 16. */
export function nextComputerCode(used: Iterable<string>): string {
  const taken = new Set(used);
  for (const ch of '23456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (!taken.has(`C${ch}`)) return `C${ch}`;
  }
  throw new SyncError('OTHER', 'No free series code left for another computer');
}

/**
 * Set this (empty) computer up from the cloud copy instead of running first-run setup.
 *   new      a second computer: new device row + its own invoice series code (C2, C3…)
 *   replace  this computer takes over an existing device id (dead/replaced PC), so the same
 *            invoice series continues. Refused unless that device exists on the hub.
 * Rows are copied with raw SQL (not into the outbox — they are already on the hub); FKs are
 * deferred to the end of the one local transaction. The cursor is set to the hub's max seq
 * read BEFORE copying, so anything that changes during the copy is pulled again (LWW makes that safe).
 */
export async function joinFromHub(db: Db, hub: Hub, opts: JoinOptions): Promise<JoinResult> {
  const log = opts.log ?? (() => {});
  if (await getState(db, 'device_id')) throw new SyncError('OTHER', 'This computer is already set up; joining is only for a new, empty database.');

  const devices = await rows(hub.client, 'SELECT id, name, series_code, revoked, deleted FROM devices');
  const live = devices.filter((d) => !Number(d.deleted));
  if (!live.length) throw new SyncError('EMPTY_HUB', 'The cloud copy has no business in it yet. Start the main computer with sync turned on first, then join.');

  let deviceId: string;
  let seriesCode: string;
  let name: string;
  if (opts.mode === 'replace') {
    const target = live.find((d) => d.id === opts.replaceDeviceId);
    if (!target) {
      const list = live.map((d) => `${d.id} (${d.name}${d.series_code ? `, series ${d.series_code}` : ''})`).join('; ');
      throw new SyncError('OTHER', `TULA_JOIN=replace needs TULA_JOIN_DEVICE set to the id of the computer being replaced. Devices in the cloud copy: ${list}`);
    }
    deviceId = String(target.id);
    seriesCode = String(target.series_code);
    name = String(target.name);
  } else {
    deviceId = '';
    seriesCode = nextComputerCode(devices.map((d) => String(d.series_code)));
    name = opts.name?.trim() || `Computer ${seriesCode.slice(1)}`;
  }

  const cursor = Number((await hub.client.execute('SELECT COALESCE(MAX(seq), 0) FROM sync_log')).rows[0]?.[0] ?? 0);
  const local = await syncedTables(db);
  let copied = 0;
  const tx = await db.transaction('write');
  try {
    await tx.execute('PRAGMA defer_foreign_keys = ON');
    for (const [table, hubTable] of hub.tables) {
      const t = local.get(table);
      if (!t) {
        log(`sync: join skipped table ${table} (not in this version of Tula)`);
        continue;
      }
      let after: string | number | null = null;
      for (;;) {
        const page = rowsOf(await hub.client.execute(pageStmt(hubTable, after, COPY_PAGE)));
        for (const row of page) {
          const stmt = upsertStmt(t, row);
          if (stmt) await tx.execute(stmt);
        }
        copied += page.length;
        if (page.length < COPY_PAGE) break;
        after = page[page.length - 1]![hubTable.pk] as string | number;
      }
    }
    if (opts.mode === 'new') {
      deviceId = uuidv7();
      await insert(tx, 'devices', deviceId, { id: deviceId, name, series_code: seriesCode, is_primary: 0 });
    } else {
      // un-mark it if it was marked lost, and announce the takeover (pushed below)
      await update(tx, 'devices', deviceId, deviceId, { revoked: 0 });
    }
    await tx.execute({ sql: "INSERT INTO sync_state (key, value) VALUES ('device_id', ?)", args: [deviceId] });
    await setState(tx, 'sync.cursor', cursor);
    await setState(tx, 'sync.joined_at', nowIso());
    await setState(tx, 'sync.join_mode', opts.mode);
    await tx.commit();
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
  await push(db, hub, deviceId);
  log(opts.mode === 'new'
    ? `sync: joined the business from ${hub.label} as a NEW computer "${name}" (device ${deviceId}, invoice series code ${seriesCode}); copied ${copied} rows.`
    : `sync: this computer REPLACED device "${name}" (${deviceId}${seriesCode ? `, series ${seriesCode}` : ', main series'}) from ${hub.label}; copied ${copied} rows. Do not switch the old computer back on.`);
  return { deviceId, seriesCode, name, mode: opts.mode, rows: copied, cursor };
}
