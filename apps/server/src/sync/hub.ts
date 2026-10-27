import type { Client } from '@libsql/client';
import { migrate, type Migration } from '@tula/db';
import { syncedTables, type TableInfo } from './schema';

/**
 * The hub is the cloud libSQL database (Turso in production, a local file in tests).
 * It holds a full copy of every synced table, plus sync_log: every change any device
 * pushed, in the order the hub received it. Devices pull from sync_log by seq.
 */
export interface Hub {
  client: Client;
  /** host only, safe to show (never the token or query string) */
  label: string;
  tables: Map<string, TableInfo>;
  close(): void;
}

export interface HubConfig { url: string; token?: string }

/**
 * How this runtime reaches a hub: the shop computer uses @libsql/client (sync/node-hub.ts), the
 * phone app @libsql/client/web over HTTPS. Both bring the hub up to the same migrations.
 */
export interface HubDriver {
  connect(cfg: HubConfig): Client;
  migrations(): Migration[];
}

/** What to show for the hub: "my-shop-x.turso.io", or "file hub.db" in tests. Never secrets. */
export function hubLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return `file ${u.pathname.split(/[\\/]/).pop()}`;
    return u.hostname;
  } catch {
    return 'invalid address';
  }
}

/**
 * When a Turso access token stops working: the `exp` claim of the JWT (read, not verified), or null
 * for a token without one (`--expiration never`) or one that can't be read. Turso can't revoke a
 * single token, so a phone gets its own token with an expiry (docs/07); this lets the Devices
 * screen warn before it runs out. Only the date leaves this function, never the token.
 */
export function tokenExpiry(token: string | undefined): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))) as { exp?: unknown };
    return typeof json.exp === 'number' ? new Date(json.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export const HUB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sync_log (
     seq          INTEGER PRIMARY KEY AUTOINCREMENT,
     device_id    TEXT NOT NULL,
     table_name   TEXT NOT NULL,
     row_id       TEXT NOT NULL,
     op           TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     received_at  TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS ix_sync_log_device ON sync_log(device_id, seq)',
  'CREATE INDEX IF NOT EXISTS ix_sync_log_row ON sync_log(table_name, row_id)',
];

/** Connect, bring the hub's schema up to this version of Tula (same migrations), and read its tables. */
export async function openHub(cfg: HubConfig, driver: HubDriver): Promise<Hub> {
  const client = driver.connect(cfg);
  try {
    await migrate(client, driver.migrations());
    for (const sql of HUB_SCHEMA) await client.execute(sql);
    const tables = await syncedTables(client);
    return { client, label: hubLabel(cfg.url), tables, close: () => client.close() };
  } catch (e) {
    client.close();
    throw e;
  }
}
