import { all, insert, nowIso, one, update, type Db, type Exec } from '@tula/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { UserError } from './context';

export type Role = 'owner' | 'billing' | 'viewer';
export interface SessionUser { id: string; name: string; role: Role; lang: string | null; mustChangePin: boolean }

declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser }
}

const COOKIE = 'tula_session';
const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const LOCK_MINUTES = 5;

// ---------- PINs ----------
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export const PinSchema = z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits');
const WEAK = new Set(['0000', '1111', '1234', '12345', '123456', '4321', '2580']);

function checkNewPin(pin: string) {
  PinSchema.parse(pin);
  if (WEAK.has(pin) || /^(\d)\1+$/.test(pin)) throw new UserError('Choose a PIN that is harder to guess', 'WEAK_PIN');
}

// ---------- Lockout (in memory: resets when the server restarts, which is fine for a shop PC) ----------
const failures = new Map<string, { count: number; until: number }>();

function assertNotLocked(userId: string) {
  const f = failures.get(userId);
  if (f && f.until > Date.now()) {
    const mins = Math.ceil((f.until - Date.now()) / 60000);
    throw new UserError(`Too many wrong PINs. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`, 'LOCKED', 429);
  }
}
function recordFailure(userId: string) {
  const f = failures.get(userId) ?? { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MINUTES * 60000; f.count = 0; }
  failures.set(userId, f);
}

// ---------- Sessions ----------
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function tokenFrom(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers.cookie ?? '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function userForToken(db: Db, token: string): Promise<SessionUser | null> {
  const row = await one<{ id: string; name: string; role: Role; lang: string | null; pin_set_at: string | null; expires_at: string; active: number }>(db, `
    SELECT u.id, u.name, u.role, u.lang, u.pin_set_at, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.deleted = 0`, [sha256(token)]);
  if (!row || !row.active || row.expires_at < nowIso()) return null;
  await db.execute({ sql: 'UPDATE sessions SET last_seen = ? WHERE token_hash = ?', args: [nowIso(), sha256(token)] });
  return { id: row.id, name: row.name, role: row.role, lang: row.lang, mustChangePin: !row.pin_set_at };
}

/**
 * What each role may change. Everyone signed in may read (GET).
 * Owner: everything. Billing: make bills and add customers. Viewer: read only.
 */
const BILLING_WRITES: Array<[string, RegExp]> = [
  ['POST', /^\/api\/bills(\/preview)?$/],
  ['POST', /^\/api\/parties$/],
  ['POST', /^\/api\/receipts(\/preview)?$/],
];
const ANY_ROLE_WRITES: Array<[string, RegExp]> = [
  ['POST', /^\/api\/auth\/(logout|pin)$/],
];
const PUBLIC: Array<[string, RegExp]> = [
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/public$/],
  ['GET', /^\/api\/auth\/users$/],
  ['POST', /^\/api\/auth\/login$/],
];
const matches = (rules: Array<[string, RegExp]>, method: string, path: string) => rules.some(([m, r]) => m === method && r.test(path));

export function canWrite(role: Role, method: string, path: string) {
  if (role === 'owner') return true;
  if (matches(ANY_ROLE_WRITES, method, path)) return true;
  return role === 'billing' && matches(BILLING_WRITES, method, path);
}

export function requireOwner(req: FastifyRequest) {
  if (req.user?.role !== 'owner') throw new UserError('Only the owner can do this', 'FORBIDDEN', 403);
}

async function countOwners(ex: Exec, excludingId?: string) {
  const r = await one<{ n: number }>(ex, "SELECT COUNT(*) n FROM users WHERE role = 'owner' AND active = 1 AND deleted = 0 AND id != ?", [excludingId ?? '']);
  return Number(r?.n ?? 0);
}

export function registerAuth(app: FastifyInstance, db: Db, deviceId: string) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || matches(PUBLIC, req.method, path)) return;
    const token = tokenFrom(req);
    const user = token ? await userForToken(db, token) : null;
    if (!user) return reply.status(401).send({ error: 'NOT_SIGNED_IN', message: 'Please sign in' });
    req.user = user;
    if (req.method !== 'GET' && !canWrite(user.role, req.method, path)) {
      return reply.status(403).send({ error: 'FORBIDDEN', message: 'Your role cannot do this' });
    }
    // A user still on the first-run PIN may only change it.
    if (user.mustChangePin && req.method !== 'GET' && !/^\/api\/auth\//.test(path)) {
      return reply.status(403).send({ error: 'CHANGE_PIN', message: 'Set a new PIN first' });
    }
  });

  /** Names on the sign-in screen (no PINs, no roles beyond what the picker needs). */
  app.get('/api/auth/users', async () => all(db, "SELECT id, name, role, lang FROM users WHERE active = 1 AND deleted = 0 ORDER BY role = 'owner' DESC, name"));

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ userId: z.string(), pin: z.string() }).parse(req.body);
    const u = await one<{ id: string; pin_hash: string; active: number }>(db, 'SELECT id, pin_hash, active FROM users WHERE id = ? AND deleted = 0', [body.userId]);
    if (!u || !u.active) throw new UserError('Unknown user', 'BAD_LOGIN', 401);
    assertNotLocked(u.id);
    if (!verifyPin(body.pin, u.pin_hash)) {
      recordFailure(u.id);
      await insert(db, 'audit_log', deviceId, { at: nowIso(), user_id: u.id, entity: 'users', entity_id: u.id, action: 'login', reason: 'wrong PIN' });
      throw new UserError('Wrong PIN', 'BAD_LOGIN', 401);
    }
    failures.delete(u.id);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await db.execute({ sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?,?,?,?,?)', args: [sha256(token), u.id, nowIso(), expires, nowIso()] });
    await insert(db, 'audit_log', deviceId, { at: nowIso(), user_id: u.id, entity: 'users', entity_id: u.id, action: 'login' });
    reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
    return { user: await userForToken(db, token), token };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = tokenFrom(req);
    if (token) await db.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [sha256(token)] });
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

  app.post('/api/auth/pin', async (req) => {
    const body = z.object({ currentPin: z.string(), newPin: z.string() }).parse(req.body);
    const u = await one<{ pin_hash: string }>(db, 'SELECT pin_hash FROM users WHERE id = ?', [req.user!.id]);
    assertNotLocked(req.user!.id);
    if (!u || !verifyPin(body.currentPin, u.pin_hash)) { recordFailure(req.user!.id); throw new UserError('Current PIN is wrong', 'BAD_LOGIN', 401); }
    checkNewPin(body.newPin);
    await update(db, 'users', deviceId, req.user!.id, { pin_hash: hashPin(body.newPin), pin_set_at: nowIso() });
    await insert(db, 'audit_log', deviceId, { at: nowIso(), user_id: req.user!.id, entity: 'users', entity_id: req.user!.id, action: 'update', reason: 'PIN changed' });
    return { ok: true };
  });

  // ---------- Users (owner) ----------
  app.get('/api/users', async (req) => {
    requireOwner(req);
    return all(db, 'SELECT id, name, role, lang, active, pin_set_at IS NOT NULL AS pin_set FROM users WHERE deleted = 0 ORDER BY name');
  });

  const UserBody = z.object({
    name: z.string().trim().min(1).max(40),
    role: z.enum(['owner', 'billing', 'viewer']),
    lang: z.string().nullable().optional(),
    active: z.boolean().optional(),
    pin: z.string().optional(),
  });

  app.post('/api/users', async (req, reply) => {
    requireOwner(req);
    const b = UserBody.parse(req.body);
    if (!b.pin) throw new UserError('Give the new user a starting PIN');
    PinSchema.parse(b.pin);
    if (await one(db, 'SELECT id FROM users WHERE name = ? AND deleted = 0', [b.name])) throw new UserError('A user with this name already exists', 'DUPLICATE');
    // A PIN set by the owner is temporary: the user is asked to choose their own at first sign-in.
    const id = await insert(db, 'users', deviceId, { name: b.name, role: b.role, lang: b.lang ?? null, pin_hash: hashPin(b.pin), active: 1 });
    await insert(db, 'audit_log', deviceId, { at: nowIso(), user_id: req.user!.id, entity: 'users', entity_id: id, action: 'create', after_json: { name: b.name, role: b.role } });
    return reply.status(201).send({ id });
  });

  app.put('/api/users/:id', async (req) => {
    requireOwner(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = UserBody.partial().parse(req.body);
    const u = await one<{ role: string; active: number }>(db, 'SELECT role, active FROM users WHERE id = ? AND deleted = 0', [id]);
    if (!u) throw new UserError('User not found', 'NOT_FOUND', 404);
    const losingOwner = u.role === 'owner' && ((b.role && b.role !== 'owner') || b.active === false);
    if (losingOwner && (await countOwners(db, id)) === 0) throw new UserError('There must always be at least one active owner', 'LAST_OWNER');
    const patch: Record<string, string | number | null> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.role !== undefined) patch.role = b.role;
    if (b.lang !== undefined) patch.lang = b.lang ?? null;
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.pin !== undefined) { PinSchema.parse(b.pin); patch.pin_hash = hashPin(b.pin); patch.pin_set_at = null; }
    if (!Object.keys(patch).length) return { ok: true };
    await update(db, 'users', deviceId, id, patch);
    if (b.active === false || b.pin !== undefined || b.role !== undefined) await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [id] });
    await insert(db, 'audit_log', deviceId, { at: nowIso(), user_id: req.user!.id, entity: 'users', entity_id: id, action: 'update', after_json: { ...b, pin: b.pin ? 'reset' : undefined } });
    return { ok: true };
  });
}
