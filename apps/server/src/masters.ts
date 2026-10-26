import { financialYear, parseScaled, roundDiv, stateFromGstin, STATES, todayIST, toMilli, toPaise, withDefaults } from '@tula/core';
import { all, getSettings, insert, nowIso, one, softDelete, update, type Db, type Exec } from '@tula/db';
import type { Router, Req } from './http';
import { z } from 'zod';
import { accountId, partyAccountId, partyBalance, post } from './accounts';
import { requireOwner } from './auth';
import { UserError } from './context';

/** GST rates in force or still seen on old stock (percent). */
export const GST_RATES = ['0', '0.1', '0.25', '1.5', '3', '5', '12', '18', '28', '40'];

const dec = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const optDec = dec.optional().nullable();
const code = z.string().trim().min(1).max(12).transform((s) => s.toUpperCase()).refine((s) => /^[A-Z0-9-]+$/.test(s), 'Use letters, digits and - only');
const idOf = (req: Req) => z.object({ id: z.string().min(1) }).parse(req.params).id;

async function unitId(ex: Exec, c: string) {
  const u = await one<{ id: string }>(ex, 'SELECT id FROM units WHERE code = ? AND deleted = 0', [c]);
  if (!u) throw new UserError(`Unknown unit ${c}`, 'BAD_UNIT');
  return u.id;
}

export async function audit(ex: Exec, dev: string, req: Req, entity: string, entityId: string, action: string, after?: unknown) {
  await insert(ex, 'audit_log', dev, { at: nowIso(), user_id: req.user?.id, entity, entity_id: entityId, action, after_json: after ?? null });
}

export async function inTx<T>(db: Db, fn: (tx: Exec) => Promise<T>): Promise<T> {
  const tx = await db.transaction('write');
  try {
    const r = await fn(tx);
    await tx.commit();
    return r;
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

// ---------------- Products ----------------
export const ProductBody = z.object({
  sku: z.string().trim().min(1).max(20).transform((v) => v.toUpperCase()).refine((v) => /^[A-Z0-9-]+$/.test(v), 'Item code: letters, digits and - only'),
  name_en: z.string().trim().min(1).max(120),
  name_ta: z.string().trim().max(120).nullable().optional(),
  categoryId: z.string().min(1),
  brand: z.string().trim().max(40).nullable().optional(),
  hsn: z.string().trim().nullable().optional().refine((v) => !v || /^\d{4}(\d{2}){0,2}$/.test(v), 'HSN/SAC must be 4, 6 or 8 digits'),
  gst: dec.refine((v) => GST_RATES.includes(String(Number(v))), `GST % must be one of ${GST_RATES.join(', ')}`),
  baseUnit: code,
  trackStock: z.boolean().default(true),
  minStock: optDec,
  rateMode: z.enum(['fixed', 'daily']).default('fixed'),
  rateGroup: z.string().nullable().optional(),
  rateExtra: optDec,
  saleRate: optDec,
  active: z.boolean().default(true),
  attrs: z.record(z.string(), z.unknown()).optional(),
  units: z.array(z.object({ unit: code, factor: dec, onBill: z.boolean().default(true), theoretical: z.boolean().default(false) })).max(6).default([]),
});
export type ProductBody = z.infer<typeof ProductBody>;

export async function saveProduct(ex: Exec, dev: string, b: ProductBody, existingId?: string) {
  // item codes are unique even among deleted items (they stay in the recycle bin)
  const dupe = await one<{ id: string; deleted: number }>(ex, 'SELECT id, deleted FROM products WHERE sku = ?', [b.sku]);
  if (dupe && dupe.id !== existingId) {
    if (Number(dupe.deleted)) throw new UserError(`Item code ${b.sku} belongs to a deleted item. Restore it from the recycle bin, or use another code.`, 'DUPLICATE');
    throw new UserError(`Item code ${b.sku} is already used`, 'DUPLICATE');
  }
  if (!(await one(ex, 'SELECT id FROM categories WHERE id = ? AND deleted = 0', [b.categoryId]))) throw new UserError('Pick a category', 'BAD_CATEGORY');
  const base = await unitId(ex, b.baseUnit);
  if (b.rateMode === 'daily') {
    if (!b.rateGroup || !(await one(ex, 'SELECT id FROM rate_groups WHERE code = ? AND deleted = 0', [b.rateGroup]))) throw new UserError('Pick the daily-rate group this item follows', 'BAD_RATE_GROUP');
  }
  const seen = new Set<string>();
  for (const u of b.units) {
    if (u.unit === b.baseUnit) throw new UserError(`${u.unit} is already the base unit`, 'BAD_UNIT');
    if (seen.has(u.unit)) throw new UserError(`${u.unit} is listed twice`, 'BAD_UNIT');
    seen.add(u.unit);
    if (toMilli(u.factor) <= 0) throw new UserError(`How many ${b.baseUnit} make one ${u.unit}? It must be more than 0`, 'BAD_UNIT');
  }
  if (existingId) {
    const cur = await one<{ base_unit_id: string }>(ex, 'SELECT base_unit_id FROM products WHERE id = ? AND deleted = 0', [existingId]);
    if (!cur) throw new UserError('Item not found', 'NOT_FOUND', 404);
    if (cur.base_unit_id !== base && (await one(ex, 'SELECT id FROM stock_moves WHERE product_id = ? AND deleted = 0 LIMIT 1', [existingId]))) {
      throw new UserError('The base unit cannot change once the item has stock or sales', 'BASE_UNIT_LOCKED');
    }
  }
  const row = {
    sku: b.sku, name_en: b.name_en, name_ta: b.name_ta || null, category_id: b.categoryId, brand: b.brand || null, hsn: b.hsn || null,
    gst_bp: toPaise(b.gst), base_unit_id: base, track_stock: b.trackStock ? 1 : 0, min_stock_milli: b.minStock ? toMilli(b.minStock) : 0,
    rate_mode: b.rateMode, rate_group: b.rateMode === 'daily' ? b.rateGroup : null,
    rate_extra_paise: b.rateExtra ? toPaise(b.rateExtra) : 0, sale_rate_paise: b.saleRate ? toPaise(b.saleRate) : 0,
    rate_unit_id: base, active: b.active ? 1 : 0, attrs_json: b.attrs ?? {},
  };
  const id = existingId ?? (await insert(ex, 'products', dev, row));
  if (existingId) await update(ex, 'products', dev, existingId, row);

  // Units: replace the set, keeping ids of units that stay.
  const current = await all<{ id: string; code: string }>(ex, 'SELECT pu.id, u.code FROM product_units pu JOIN units u ON u.id = pu.unit_id WHERE pu.product_id = ? AND pu.deleted = 0', [id]);
  for (const c of current) if (!seen.has(c.code)) await update(ex, 'product_units', dev, c.id, { deleted: 1 });
  for (const u of b.units) {
    const values = { factor_milli: toMilli(u.factor), on_bill: u.onBill ? 1 : 0, is_theoretical: u.theoretical ? 1 : 0 };
    const c = current.find((x) => x.code === u.unit);
    if (c) await update(ex, 'product_units', dev, c.id, values);
    else await insert(ex, 'product_units', dev, { product_id: id, unit_id: await unitId(ex, u.unit), ...values });
  }
  return id;
}

// ---------------- Parties ----------------
export const PartyBody = z.object({
  partyType: z.enum(['customer', 'supplier', 'both']).default('customer'),
  name_en: z.string().trim().min(1).max(100),
  name_ta: z.string().trim().max(100).nullable().optional(),
  mobile: z.string().trim().nullable().optional().transform((v) => (v ? v.replace(/[\s-]/g, '').replace(/^(\+91|0)/, '') : null))
    .refine((v) => !v || /^[6-9]\d{9}$/.test(v), 'Mobile number must be 10 digits'),
  address: z.string().trim().max(300).nullable().optional(),
  gstin: z.string().trim().toUpperCase().nullable().optional().refine((v) => !v || !!stateFromGstin(v), 'GSTIN must be 15 characters, starting with the 2-digit state code'),
  stateCode: z.string().nullable().optional().refine((v) => !v || !!STATES[v], 'Unknown state'),
  creditLimit: optDec,
  creditDays: z.number().int().min(0).max(365).nullable().optional(),
  lang: z.string().nullable().optional(),
  openingBalance: optDec, // + the party owes us, - we owe the party
  active: z.boolean().default(true),
});
export type PartyBody = z.infer<typeof PartyBody>;

async function postOpeningBalance(ex: Exec, dev: string, partyId: string, amountPaise: number) {
  // Opening balances are set-up data: replace any earlier opening entry for this party.
  await softDelete(ex, 'ledger_entries', dev, "source_type = 'OPEN' AND source_id = ?", [partyId]);
  if (!amountPaise) return;
  const acc = await partyAccountId(ex, dev, partyId);
  const open = await accountId(ex, 'OPENING');
  await post(ex, dev, {
    date: todayIST(), sourceType: 'OPEN', sourceId: partyId, narration: 'Opening balance',
    lines: amountPaise > 0 ? [{ accountId: acc, debit: amountPaise }, { accountId: open, credit: amountPaise }] : [{ accountId: open, debit: -amountPaise }, { accountId: acc, credit: -amountPaise }],
  });
}

export async function saveParty(ex: Exec, dev: string, b: PartyBody, existingId?: string) {
  const s = withDefaults(await getSettings(ex));
  const fromGstin = stateFromGstin(b.gstin);
  if (fromGstin && b.stateCode && b.stateCode !== fromGstin) throw new UserError("The GSTIN's state doesn't match the state chosen", 'STATE_MISMATCH');
  const state = fromGstin ?? b.stateCode ?? s['business.state_code'];
  if (!state) throw new UserError('Pick the state', 'NO_STATE');
  if (b.mobile) {
    const dupe = await one<{ id: string; name_en: string }>(ex, 'SELECT id, name_en FROM parties WHERE mobile = ? AND deleted = 0 AND is_walk_in = 0', [b.mobile]);
    if (dupe && dupe.id !== existingId) throw new UserError(`${dupe.name_en} already has this mobile number`, 'DUPLICATE');
  }
  const row = {
    party_type: b.partyType, name_en: b.name_en, name_ta: b.name_ta || null, mobile: b.mobile, address: b.address || null, gstin: b.gstin || null,
    state_code: state, credit_limit_paise: b.creditLimit ? toPaise(b.creditLimit) : 0,
    credit_days: b.creditDays ?? Number(s['credit.default_days']), lang: b.lang || null, active: b.active ? 1 : 0,
  };
  let id: string;
  if (existingId) {
    const cur = await one<{ is_walk_in: number }>(ex, 'SELECT is_walk_in FROM parties WHERE id = ? AND deleted = 0', [existingId]);
    if (!cur) throw new UserError('Not found', 'NOT_FOUND', 404);
    if (cur.is_walk_in) {
      // The walk-in account can only be renamed.
      await update(ex, 'parties', dev, existingId, { name_en: b.name_en, name_ta: b.name_ta || null });
      return existingId;
    }
    await update(ex, 'parties', dev, existingId, row);
    id = existingId;
  } else {
    id = await insert(ex, 'parties', dev, { ...row, opening_date: todayIST() });
    await partyAccountId(ex, dev, id);
  }
  if (b.openingBalance !== undefined && b.openingBalance !== null) {
    const amt = b.openingBalance === '' ? 0 : toPaise(b.openingBalance);
    await update(ex, 'parties', dev, id, { opening_balance_paise: amt, opening_date: todayIST() });
    await postOpeningBalance(ex, dev, id, amt);
  }
  return id;
}

export function registerMasters(app: Router, db: Db, dev: string) {
  // ---------- Lookups ----------
  app.get('/api/units', async () => all(db, 'SELECT id, code, name_en, name_ta, gst_uqc FROM units WHERE deleted = 0 ORDER BY code'));
  app.post('/api/units', async (req, reply) => {
    const b = z.object({ code, name_en: z.string().trim().min(1).max(30), name_ta: z.string().trim().max(30).nullable().optional(), uqc: z.string().trim().max(3).nullable().optional() }).parse(req.body);
    if (await one(db, 'SELECT id FROM units WHERE code = ?', [b.code])) throw new UserError(`Unit ${b.code} already exists`, 'DUPLICATE');
    const id = await insert(db, 'units', dev, { code: b.code, name_en: b.name_en, name_ta: b.name_ta || null, gst_uqc: b.uqc ? b.uqc.toUpperCase() : 'OTH' });
    return reply.status(201).send({ id });
  });

  app.get('/api/categories', async () => all(db, 'SELECT id, name_en, name_ta, is_service, sort_order FROM categories WHERE deleted = 0 ORDER BY sort_order, name_en'));
  const CatBody = z.object({ name_en: z.string().trim().min(1).max(60), name_ta: z.string().trim().max(60).nullable().optional(), isService: z.boolean().default(false), sortOrder: z.number().int().default(0) });
  app.post('/api/categories', async (req, reply) => {
    const b = CatBody.parse(req.body);
    const id = await insert(db, 'categories', dev, { name_en: b.name_en, name_ta: b.name_ta || null, is_service: b.isService ? 1 : 0, sort_order: b.sortOrder });
    return reply.status(201).send({ id });
  });
  app.put('/api/categories/:id', async (req) => {
    const b = CatBody.parse(req.body);
    if (!(await update(db, 'categories', dev, idOf(req), { name_en: b.name_en, name_ta: b.name_ta || null, is_service: b.isService ? 1 : 0, sort_order: b.sortOrder }))) throw new UserError('Not found', 'NOT_FOUND', 404);
    return { ok: true };
  });

  app.get('/api/rate-groups', async () => all(db, `
    SELECT g.id, g.code, g.name_en, g.name_ta, g.show_on_topbar, u.code AS unit FROM rate_groups g LEFT JOIN units u ON u.id = g.unit_id
    WHERE g.deleted = 0 ORDER BY g.sort_order, g.code`));
  const GroupBody = z.object({ code, name_en: z.string().trim().min(1).max(40), name_ta: z.string().trim().max(40).nullable().optional(), unit: code, showOnTopbar: z.boolean().default(true) });
  app.post('/api/rate-groups', async (req, reply) => {
    const b = GroupBody.parse(req.body);
    if (await one(db, 'SELECT id FROM rate_groups WHERE code = ?', [b.code])) throw new UserError(`Rate group ${b.code} already exists`, 'DUPLICATE');
    const id = await insert(db, 'rate_groups', dev, { code: b.code, name_en: b.name_en, name_ta: b.name_ta || null, unit_id: await unitId(db, b.unit), show_on_topbar: b.showOnTopbar ? 1 : 0 });
    return reply.status(201).send({ id });
  });
  app.put('/api/rate-groups/:id', async (req) => {
    const b = GroupBody.omit({ code: true }).parse(req.body);
    if (!(await update(db, 'rate_groups', dev, idOf(req), { name_en: b.name_en, name_ta: b.name_ta || null, unit_id: await unitId(db, b.unit), show_on_topbar: b.showOnTopbar ? 1 : 0 }))) throw new UserError('Not found', 'NOT_FOUND', 404);
    return { ok: true };
  });

  // ---------- Products ----------
  app.get('/api/products', async () => all(db, `
    SELECT p.id, p.sku, p.category_id, p.name_en, p.name_ta, p.brand, p.hsn, p.gst_bp, p.active, p.track_stock, p.rate_mode, p.rate_group,
           p.rate_extra_paise, p.sale_rate_paise, u.code AS base_unit, c.name_en AS category_en, c.name_ta AS category_ta,
           COALESCE((SELECT SUM(qty_milli) FROM stock_moves m WHERE m.product_id = p.id AND m.deleted = 0), 0) AS stock_milli
    FROM products p JOIN units u ON u.id = p.base_unit_id JOIN categories c ON c.id = p.category_id
    WHERE p.deleted = 0 ORDER BY c.sort_order, p.sku`));

  app.get('/api/products/:id', async (req) => {
    const id = idOf(req);
    const p = await one<Record<string, unknown>>(db, 'SELECT p.*, u.code AS base_unit FROM products p JOIN units u ON u.id = p.base_unit_id WHERE p.id = ? AND p.deleted = 0', [id]);
    if (!p) throw new UserError('Item not found', 'NOT_FOUND', 404);
    const units = await all(db, `SELECT u.code AS unit, pu.factor_milli, pu.on_bill, pu.is_theoretical FROM product_units pu JOIN units u ON u.id = pu.unit_id
      WHERE pu.product_id = ? AND pu.deleted = 0 ORDER BY pu.factor_milli DESC`, [id]);
    return { ...p, attrs: JSON.parse(String(p.attrs_json ?? '{}')), units };
  });

  app.post('/api/products', async (req, reply) => {
    const b = ProductBody.parse(req.body);
    const id = await inTx(db, async (tx) => {
      const id = await saveProduct(tx, dev, b);
      await audit(tx, dev, req, 'products', id, 'create', { sku: b.sku });
      return id;
    });
    return reply.status(201).send({ id });
  });

  app.put('/api/products/:id', async (req) => {
    const id = idOf(req);
    const b = ProductBody.parse(req.body);
    await inTx(db, async (tx) => {
      await saveProduct(tx, dev, b, id);
      await audit(tx, dev, req, 'products', id, 'update', { sku: b.sku });
    });
    return { ok: true };
  });

  // ---------- Parties ----------
  app.get('/api/parties/:id', async (req) => {
    const id = idOf(req);
    const p = await one<Record<string, unknown>>(db, 'SELECT * FROM parties WHERE id = ? AND deleted = 0', [id]);
    if (!p) throw new UserError('Not found', 'NOT_FOUND', 404);
    const rates = await all(db, `SELECT r.product_id, p.sku, p.name_en, p.name_ta, r.rate_paise, r.adjust_paise
      FROM party_rates r JOIN products p ON p.id = r.product_id WHERE r.party_id = ? AND r.deleted = 0 ORDER BY p.sku`, [id]);
    return { ...p, balance_paise: await partyBalance(db, id), rates };
  });

  app.post('/api/parties', async (req, reply) => {
    const b = PartyBody.parse(req.body);
    if (req.user?.role !== 'owner') {
      // Counter staff can add customers on the spot, but credit terms and opening balances are the owner's call.
      if (b.partyType !== 'customer' || b.creditLimit || b.openingBalance || b.creditDays != null) throw new UserError('Only the owner can set credit terms, opening balances or add suppliers', 'FORBIDDEN', 403);
    }
    const id = await inTx(db, async (tx) => {
      const id = await saveParty(tx, dev, b);
      await audit(tx, dev, req, 'parties', id, 'create', { name: b.name_en });
      return id;
    });
    return reply.status(201).send({ id });
  });

  app.put('/api/parties/:id', async (req) => {
    const id = idOf(req);
    const b = PartyBody.parse(req.body);
    await inTx(db, async (tx) => {
      await saveParty(tx, dev, b, id);
      await audit(tx, dev, req, 'parties', id, 'update', { name: b.name_en });
    });
    return { ok: true };
  });

  /** Party-wise rates: a fixed rate, or an adjustment (+/-) on the normal rate. Replaces the whole list. */
  app.put('/api/parties/:id/rates', async (req) => {
    requireOwner(req);
    const id = idOf(req);
    const b = z.object({ rates: z.array(z.object({ productId: z.string(), rate: optDec, adjust: optDec })).max(500) }).parse(req.body);
    await inTx(db, async (tx) => {
      if (!(await one(tx, 'SELECT id FROM parties WHERE id = ? AND deleted = 0', [id]))) throw new UserError('Not found', 'NOT_FOUND', 404);
      const keep = new Set<string>();
      for (const r of b.rates) {
        const hasRate = r.rate != null && r.rate !== '';
        const hasAdj = r.adjust != null && r.adjust !== '';
        if (hasRate === hasAdj) throw new UserError('Give either a fixed rate or an adjustment for each item', 'BAD_RATE');
        if (!(await one(tx, 'SELECT id FROM products WHERE id = ? AND deleted = 0', [r.productId]))) throw new UserError('Unknown item in rates', 'NOT_FOUND', 404);
        keep.add(r.productId);
        const values = { rate_paise: hasRate ? toPaise(r.rate!) : null, adjust_paise: hasAdj ? toPaise(r.adjust!) : null };
        if (hasRate && values.rate_paise! < 0) throw new UserError('Rate cannot be negative', 'BAD_RATE');
        const cur = await one<{ id: string }>(tx, 'SELECT id FROM party_rates WHERE party_id = ? AND product_id = ?', [id, r.productId]);
        if (cur) await update(tx, 'party_rates', dev, cur.id, { ...values, deleted: 0 });
        else await insert(tx, 'party_rates', dev, { party_id: id, product_id: r.productId, ...values });
      }
      const existing = await all<{ id: string; product_id: string }>(tx, 'SELECT id, product_id FROM party_rates WHERE party_id = ? AND deleted = 0', [id]);
      for (const e of existing) if (!keep.has(e.product_id)) await update(tx, 'party_rates', dev, e.id, { deleted: 1 });
      await audit(tx, dev, req, 'party_rates', id, 'update', { count: b.rates.length });
    });
    return { ok: true };
  });

  // ---------- Opening stock ----------
  app.get('/api/stock/opening', async () => all(db, `
    SELECT p.id AS product_id, p.sku, p.name_en, p.name_ta, u.code AS base_unit,
      COALESCE((SELECT SUM(l.qty_milli) FROM stock_adjustment_lines l JOIN stock_adjustments a ON a.id = l.adjustment_id
        WHERE l.product_id = p.id AND a.reason = 'opening' AND l.deleted = 0 AND a.deleted = 0), 0) AS qty_milli,
      (SELECT l.cost_per_base_paise FROM stock_adjustment_lines l JOIN stock_adjustments a ON a.id = l.adjustment_id
        WHERE l.product_id = p.id AND a.reason = 'opening' AND l.deleted = 0 AND a.deleted = 0 ORDER BY l.created_at DESC LIMIT 1) AS cost_paise
    FROM products p JOIN units u ON u.id = p.base_unit_id JOIN categories c ON c.id = p.category_id
    WHERE p.deleted = 0 AND p.track_stock = 1 ORDER BY c.sort_order, p.sku`));

  /** Set opening stock per item (quantity in base unit and cost per base unit). Replaces earlier opening figures for those items. */
  app.put('/api/stock/opening', async (req) => {
    const b = z.object({ lines: z.array(z.object({ productId: z.string(), qty: dec, cost: dec })).min(1).max(2000) }).parse(req.body);
    return inTx(db, (tx) => setOpeningStock(tx, dev, req, b.lines));
  });
}

/** Opening stock for some items; replaces their earlier opening figures. Used by the Opening stock screen and Excel import. */
export async function setOpeningStock(tx: Exec, dev: string, req: Req, lines: Array<{ productId: string; qty: string; cost: string }>) {
  const today = todayIST();
  const fy = financialYear(today);
  const n0 = await one<{ n: number }>(tx, "SELECT COUNT(*) n FROM stock_adjustments WHERE fy = ? AND reason = 'opening'", [fy]);
  const adj = await insert(tx, 'stock_adjustments', dev, { doc_no: `OPEN-${Number(n0?.n ?? 0) + 1}`, doc_date: today, fy, reason: 'opening', notes: 'Opening stock', created_by: req.user!.id, approved_by: req.user!.id });
  let n = 0;
  for (const l of lines) {
    const p = await one<{ track_stock: number }>(tx, 'SELECT track_stock FROM products WHERE id = ? AND deleted = 0', [l.productId]);
    if (!p) throw new UserError('Unknown item', 'NOT_FOUND', 404);
    if (!p.track_stock) throw new UserError('This item does not keep stock', 'NO_STOCK');
    const qty = toMilli(l.qty);
    const cost = parseScaled(l.cost, 2, 'cost');
    if (qty < 0 || cost < 0) throw new UserError('Opening quantity and cost cannot be negative', 'BAD_VALUE');
    // replace earlier opening figures for this item
    const old = await all<{ id: string; adjustment_id: string }>(tx, `SELECT l.id, l.adjustment_id FROM stock_adjustment_lines l JOIN stock_adjustments a ON a.id = l.adjustment_id
      WHERE l.product_id = ? AND a.reason = 'opening' AND l.deleted = 0`, [l.productId]);
    for (const o of old) {
      await update(tx, 'stock_adjustment_lines', dev, o.id, { deleted: 1 });
      await softDelete(tx, 'stock_moves', dev, "source_type = 'ADJ' AND source_line_id = ?", [o.id]);
    }
    if (qty > 0) {
      const line = await insert(tx, 'stock_adjustment_lines', dev, { adjustment_id: adj, product_id: l.productId, qty_milli: qty, cost_per_base_paise: cost });
      await insert(tx, 'stock_moves', dev, { move_date: today, product_id: l.productId, qty_milli: qty, value_paise: roundDiv(qty * cost, 1000), source_type: 'ADJ', source_id: adj, source_line_id: line });
    }
    n += 1;
  }
  await audit(tx, dev, req, 'stock_adjustments', adj, 'create', { opening: n });
  return { ok: true, items: n };
}
