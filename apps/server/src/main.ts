import { openDb } from '@tula/db';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { applyProfile, readProfile, setup } from './setup';

/**
 * Configuration comes from environment variables; business data comes from Settings in the app.
 *   TULA_DB      path to the SQLite file          (default: ./data/tula.db)
 *   TULA_PORT    port                              (default: 5000)
 *   TULA_HOST    interface to listen on            (default: 0.0.0.0, so phones on the LAN can connect)
 *   TULA_PRESET  starter catalogue on first run    (e.g. building-materials, blank; default: blank)
 *   TULA_DEMO    "1" to also load the preset's demo business, customers and stock
 *   TULA_PROFILE path to a business profile JSON applied on first run (see docs/03-configuration.md)
 */
const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const dbFile = resolve(env.TULA_DB ?? join(process.cwd(), 'data', 'tula.db'));
const port = Number(env.TULA_PORT ?? 5000);
const host = env.TULA_HOST ?? '0.0.0.0';

mkdirSync(dirname(dbFile), { recursive: true });
const db = await openDb(`file:${dbFile}`);
const profile = env.TULA_PROFILE ? readProfile(resolve(env.TULA_PROFILE)) : null;
const preset = profile?.preset ?? env.TULA_PRESET ?? 'blank';
const s = await setup(db, { preset, demo: env.TULA_DEMO === '1' });
if (!s.skipped) {
  console.log(`First run: set up with preset "${preset}"${env.TULA_DEMO === '1' ? ' + demo data' : ''}. Owner user created with PIN 1234 (PIN login arrives in Milestone 1).`);
  if (profile) console.log('Applied business profile:', await applyProfile(db, profile));
}

const app = await buildApp(db, { webDist: join(here, '..', '..', 'web', 'dist'), logger: true });
await app.listen({ port, host });
console.log(`Tula is running: http://localhost:${port}  (database: ${dbFile})`);
