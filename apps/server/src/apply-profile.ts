/** Usage: npm run apply-profile -w apps/server -- path/to/profile.json   (uses TULA_DB like the server) */
import { openDb } from '@tula/db/node';
import { join, resolve } from 'node:path';
import { applyProfile, readProfile, setup } from './setup';

const file = process.argv[2];
if (!file) {
  console.error('Usage: apply-profile <profile.json>');
  process.exit(1);
}
const profile = readProfile(resolve(file));
const db = await openDb(`file:${resolve(process.env.TULA_DB ?? join(process.cwd(), 'data', 'tula.db'))}`);
await setup(db, { preset: profile.preset ?? 'blank' });
console.log(await applyProfile(db, profile));
