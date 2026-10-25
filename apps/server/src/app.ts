import {
  checkSettingsConsistency, financialYear, isSettingKey, missingForBilling, SETTINGS, STATES, SUPPORTED_LANGS, todayIST, toPaise,
  validateSetting, withDefaults,
} from '@tula/core';
import { all, getSettings, insert, nowIso, one, setSetting, type Db } from '@tula/db';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { createBill, getBill, listBills, priceBill } from './bills';
import { catalog } from './catalog';
import { localDeviceId, UserError, type Ctx } from './context';

export async function buildApp(db: Db, opts: { webDist?: string; logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const deviceId = await localDeviceId(db);

  // Release 1 M0: single owner user. M1 replaces this with PIN login + roles.
  const owner = await one<{ id: string }>(db, "SELECT id FROM users WHERE role = 'owner' AND deleted = 0 ORDER BY created_at LIMIT 1");
  const ctx: Ctx = { deviceId, userId: owner!.id };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof RangeError) return reply.status(400).send({ error: 'BAD_VALUE', message: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Something went wrong' });
  });

  const settings = async () => withDefaults(await getSettings(db));

  app.get('/api/health', async () => ({ ok: true, today: todayIST() }));

  // ---------- Settings ----------
  /** Current values (with defaults), plus what is still missing before billing. */
  app.get('/api/settings', async () => {
    const s = await settings();
    return { values: s, missingForBilling: missingForBilling(s), issues: checkSettingsConsistency(s) };
  });

  /** The registry, so the Settings screen is generated from data rather than hard-coded. */
  app.get('/api/settings/schema', async () => ({
    settings: Object.entries(SETTINGS).map(([key, def]) => ({ key, ...def })),
    languages: SUPPORTED_LANGS,
    states: Object.entries(STATES).map(([code, s]) => ({ code, name: s.name })),
  }));

  app.put('/api/settings', async (req) => {
    const body = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).parse(req.body);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) clean[k] = validateSetting(k, v);
    const merged = withDefaults({ ...(await getSettings(db)), ...clean });
    const issues = checkSettingsConsistency(merged);
    if (issues.length) throw new UserError(issues.join('; '), 'INCONSISTENT');

    const tx = await db.transaction('write');
    try {
      if (clean['invoice.prefix'] !== undefined) {
        // Changing the prefix mid-year would break the consecutive series the GST rules require.
        const fy = financialYear(todayIST());
        const used = await one<{ next_no: number; prefix: string }>(tx,
          "SELECT next_no, prefix FROM number_series WHERE doc_type = 'INV' AND owner_device = ? AND fy = ? AND deleted = 0", [deviceId, fy]);
        if (used && Number(used.next_no) > 1 && used.prefix !== clean['invoice.prefix']) {
          throw new UserError(`Invoices already issued this financial year with prefix ${used.prefix}. The new prefix can start from next financial year.`, 'PREFIX_IN_USE');
        }
        if (used) await tx.execute({ sql: "UPDATE number_series SET prefix = ?, updated_at = ? WHERE doc_type = 'INV' AND owner_device = ? AND fy = ?", args: [clean['invoice.prefix'], nowIso(), deviceId, fy] });
      }
      for (const [k, v] of Object.entries(clean)) {
        if (!isSettingKey(k)) continue;
        await setSetting(tx, deviceId, k, v);
      }
      await insert(tx, 'audit_log', deviceId, { at: nowIso(), user_id: ctx.userId, entity: 'settings', entity_id: Object.keys(clean).join(','), action: 'update', after_json: clean });
      await tx.commit();
    } catch (e) {
      if (!tx.closed) await tx.rollback();
      throw e;
    }
    const s = await settings();
    return { values: s, missingForBilling: missingForBilling(s), issues: checkSettingsConsistency(s) };
  });

  // ---------- Catalog and parties ----------
  app.get('/api/catalog', async (req) => {
    const q = z.object({ date: z.string().optional() }).parse(req.query);
    return catalog(db, q.date ?? todayIST());
  });

  app.get('/api/parties', async () => all(db, `
    SELECT p.id, p.party_type, p.name_en, p.name_ta, p.mobile, p.gstin, p.state_code, p.credit_limit_paise, p.credit_days,
           p.lang, p.is_walk_in, COALESCE(b.balance_paise, 0) AS balance_paise
    FROM parties p LEFT JOIN v_party_balance b ON b.party_id = p.id
    WHERE p.deleted = 0 AND p.active = 1 ORDER BY p.is_walk_in DESC, p.name_en`));

  // ---------- Daily rates (any number of rate groups, defined as data) ----------
  app.get('/api/rates', async () => all(db, `
    SELECT g.code, g.name_en, g.name_ta, g.show_on_topbar, u.code AS unit_code, u.name_en AS unit_en, u.name_ta AS unit_ta,
      (SELECT rate_paise FROM daily_rates d WHERE d.rate_group = g.code AND d.deleted = 0 AND d.rate_date <= ? ORDER BY d.rate_date DESC LIMIT 1) AS rate_paise,
      (SELECT rate_date FROM daily_rates d WHERE d.rate_group = g.code AND d.deleted = 0 AND d.rate_date <= ? ORDER BY d.rate_date DESC LIMIT 1) AS rate_date
    FROM rate_groups g LEFT JOIN units u ON u.id = g.unit_id
    WHERE g.deleted = 0 ORDER BY g.sort_order, g.code`, [todayIST(), todayIST()]));

  app.put('/api/rates/:group', async (req) => {
    const { group } = z.object({ group: z.string().min(1) }).parse(req.params);
    const body = z.object({ rate: z.union([z.string(), z.number()]), date: z.string().optional() }).parse(req.body);
    if (!(await one(db, 'SELECT id FROM rate_groups WHERE code = ? AND deleted = 0', [group]))) throw new UserError(`Unknown rate group ${group}`, 'NOT_FOUND', 404);
    const date = body.date ?? todayIST();
    const ratePaise = toPaise(body.rate);
    if (ratePaise < 0) throw new UserError('Rate cannot be negative');
    const tx = await db.transaction('write');
    try {
      const existing = await one<{ id: string }>(tx, 'SELECT id FROM daily_rates WHERE rate_group = ? AND rate_date = ?', [group, date]);
      if (existing) {
        await tx.execute({ sql: 'UPDATE daily_rates SET rate_paise = ?, updated_at = ?, device_id = ? WHERE id = ?', args: [ratePaise, nowIso(), deviceId, existing.id] });
        await tx.execute({ sql: 'INSERT INTO sync_outbox (table_name,row_id,op,payload_json,created_at) VALUES (?,?,?,?,?)', args: ['daily_rates', existing.id, 'upsert', JSON.stringify({ id: existing.id, rate_paise: ratePaise }), nowIso()] });
      } else {
        await insert(tx, 'daily_rates', deviceId, { rate_group: group, rate_date: date, rate_paise: ratePaise });
      }
      await insert(tx, 'audit_log', deviceId, { at: nowIso(), user_id: ctx.userId, entity: 'daily_rates', entity_id: `${group}:${date}`, action: 'update', after_json: { ratePaise } });
      await tx.commit();
    } catch (e) {
      if (!tx.closed) await tx.rollback();
      throw e;
    }
    return { group, date, ratePaise };
  });

  // ---------- Bills ----------
  /** Live totals while the bill is being typed — nothing is saved. */
  app.post('/api/bills/preview', async (req) => {
    const p = await priceBill(db, req.body as never);
    return {
      supply: p.supply, docKind: p.docKind, lang: p.lang, totals: p.totals, balanceBefore: p.balanceBefore, warnings: p.warnings, blocked: p.blocked,
      lines: p.lines.map((l) => ({ lineNo: l.lineNo, productId: l.product.id, baseQtyMilli: l.baseQty, rateQtyMilli: l.rateQty, ratePaise: l.ratePaise, rateSource: l.rateSource, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total })),
    };
  });

  app.post('/api/bills', async (req, reply) => {
    const r = await createBill(db, ctx, req.body as never);
    return reply.status(r.saved ? 201 : 409).send(r);
  });

  app.get('/api/bills', async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const today = todayIST();
    return listBills(db, q.from ?? today, q.to ?? today);
  });

  app.get('/api/bills/:id', async (req) => getBill(db, z.object({ id: z.string() }).parse(req.params).id));

  app.get('/api/stock', async () => all(db, 'SELECT * FROM v_stock_on_hand ORDER BY sku'));

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ error: 'NOT_FOUND' }) : reply.sendFile('index.html')));
  }
  return app;
}
