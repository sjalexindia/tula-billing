import { all, update } from '@tula/db';
import { hashPin } from '../auth';
import { cliSetup, fail, openExisting, positional } from './common';

/**
 * Forgotten PIN, on the shop computer itself (needs access to the data file, so it is as safe as the computer):
 *   node --import tsx apps/server/src/cli/reset-pin.ts [--env-file …]            list people
 *   node --import tsx apps/server/src/cli/reset-pin.ts [--env-file …] "Owner"     set a temporary PIN 1234
 * The person must choose a new PIN at their next sign-in; their open sessions end. Works while Tula runs.
 */
const { args, dbFile } = cliSetup();
const name = positional(args, ['--env-file'])[0];
const db = await openExisting(dbFile);
const users = await all<{ id: string; name: string; role: string; active: number }>(db, 'SELECT id, name, role, active FROM users WHERE deleted = 0 ORDER BY name');
if (!name) {
  console.log('People:');
  for (const u of users) console.log(`  ${u.name}  (${u.role}${u.active ? '' : ', turned off'})`);
  console.log('\nTo reset one:  reset-pin "<name>"');
  process.exit(0);
}
const u = users.find((x) => x.name.toLowerCase() === name.toLowerCase());
if (!u) fail(`No one called "${name}". Run without a name to see the list.`);
const dev = String((await db.execute("SELECT value FROM sync_state WHERE key = 'device_id'")).rows[0]?.[0] ?? '');
const tx = await db.transaction('write');
try {
  await update(tx, 'users', dev, u.id, { pin_hash: hashPin('1234'), pin_set_at: null, active: 1 });
  await tx.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [u.id] });
  await tx.commit();
} catch (e) {
  if (!tx.closed) await tx.rollback();
  throw e;
}
db.close();
console.log(`${u.name}: temporary PIN 1234. They will be asked to choose a new PIN when they sign in.`);
