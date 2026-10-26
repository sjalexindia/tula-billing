import { createClient } from '@libsql/client';
import { loadMigrations } from '@tula/db/node';
import type { HubConfig, HubDriver } from './hub';

/** Shop computer: reach the hub with @libsql/client (libsql://, https:// or file: in tests). */
export const nodeHubDriver: HubDriver = {
  connect: (cfg) => createClient({ url: cfg.url, authToken: cfg.token }),
  migrations: () => loadMigrations(),
};

/** Read TULA_SYNC_URL / TULA_SYNC_TOKEN. Tokens live only in the environment. */
export function hubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const url = env.TULA_SYNC_URL?.trim();
  if (!url) return null;
  return { url, token: env.TULA_SYNC_TOKEN?.trim() || undefined };
}
