import { createClient, type Client } from '@libsql/client';
import { migrate } from '@tula/db';
import { basename } from 'node:path';
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

/** Read TULA_SYNC_URL / TULA_SYNC_TOKEN. Tokens live only in the environment. */
export function hubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const url = env.TULA_SYNC_URL?.trim();
  if (!url) return null;
  return { url, token: env.TULA_SYNC_TOKEN?.trim() || undefined };
}

/** What to show for the hub: "my-shop-x.turso.io", or "file hub.db" in tests. Never secrets. */
export function hubLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return `file ${basename(u.pathname)}`;
    return u.hostname;
  } catch {
    return 'invalid address';
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
export async function openHub(cfg: HubConfig): Promise<Hub> {
  const client = createClient({ url: cfg.url, authToken: cfg.token });
  try {
    await migrate(client);
    for (const sql of HUB_SCHEMA) await client.execute(sql);
    const tables = await syncedTables(client);
    return { client, label: hubLabel(cfg.url), tables, close: () => client.close() };
  } catch (e) {
    client.close();
    throw e;
  }
}
