import type { InValue } from '@libsql/client';
import { nowIso } from '@tula/db';
import type { Runner } from './schema';

/**
 * Sync bookkeeping lives in the local-only sync_state table (never synced), so writing it
 * with raw SQL is allowed. Keys:
 *   device_id            this computer's device id (written by setup or join)
 *   sync.cursor          highest hub sync_log.seq already applied here
 *   sync.last_push_at    sync.last_pull_at    sync.pending    sync.joined_at / sync.join_mode
 *   sync.last_error      plain-English message of the last failure ('' when fine)
 *   sync.last_error_code OFFLINE | AUTH | BAD_URL | UPDATE_APP | REVOKED | OTHER
 *   sync.last_error_at
 */
export async function getState(ex: Runner, key: string): Promise<string | null> {
  const r = await ex.execute({ sql: 'SELECT value FROM sync_state WHERE key = ?', args: [key] });
  return r.rows[0] ? String(r.rows[0][0]) : null;
}

export async function getStates(ex: Runner, prefix: string): Promise<Record<string, string>> {
  const r = await ex.execute({ sql: 'SELECT key, value FROM sync_state WHERE key LIKE ?', args: [`${prefix}%`] });
  return Object.fromEntries(r.rows.map((row) => [String(row[0]), String(row[1])]));
}

export async function setState(ex: Runner, key: string, value: InValue): Promise<void> {
  await ex.execute({
    sql: 'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, String(value ?? '')],
  });
}

export type SyncErrorCode = 'OFFLINE' | 'AUTH' | 'BAD_URL' | 'UPDATE_APP' | 'REVOKED' | 'EMPTY_HUB' | 'OTHER';

/** An error whose message is already written for the shop owner. */
export class SyncError extends Error {
  constructor(public code: SyncErrorCode, message: string) {
    super(message);
  }
}

/** Translate whatever the libSQL client threw into a code and a sentence the owner can act on. Never includes the token. */
export function describeError(e: unknown, token?: string): { code: SyncErrorCode; message: string } {
  if (e instanceof SyncError) return { code: e.code, message: e.message };
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const text = `${err?.code ?? ''} ${err?.message ?? String(e)} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`;
  let code: SyncErrorCode = 'OTHER';
  let message = 'Copying to the cloud failed. Tula will keep trying.';
  // Turso answers 400 to a token it cannot read and 401 to an expired or invalidated one. No internet is
  // "fetch failed" in Node and "Failed to fetch" / "NetworkError" / "Load failed" in browsers (the phone app).
  if (/URL_INVALID|URL_SCHEME|Invalid URL|unsupported.*scheme/i.test(text)) {
    code = 'BAD_URL';
    message = 'The cloud address (TULA_SYNC_URL) is not valid. Check it in the shop computer\'s settings file.';
  } else if (/\b401\b|\b403\b|HTTP status 400|unauthori[sz]ed|forbidden|auth.*token|jwt|SERVER_ERROR.*auth/i.test(text)) {
    code = 'AUTH';
    message = 'The cloud refused the access token. Create a new token and put it in TULA_SYNC_TOKEN.';
  } else if (/fetch failed|Failed to fetch|NetworkError|Load failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|network|socket|timed? ?out|unable to open database|SQLITE_CANTOPEN/i.test(text)) {
    code = 'OFFLINE';
    message = 'Cannot reach the cloud copy. Check the internet connection; Tula will keep trying.';
  }
  let detail = (err?.message ?? String(e)).slice(0, 300);
  if (token) detail = detail.split(token).join('***');
  return { code, message: code === 'OTHER' ? `${message} (${detail})` : message };
}

export async function recordError(ex: Runner, e: unknown, token?: string) {
  const d = describeError(e, token);
  await setState(ex, 'sync.last_error', d.message);
  await setState(ex, 'sync.last_error_code', d.code);
  await setState(ex, 'sync.last_error_at', nowIso());
  return d;
}

export async function clearError(ex: Runner) {
  await setState(ex, 'sync.last_error', '');
  await setState(ex, 'sync.last_error_code', '');
}
