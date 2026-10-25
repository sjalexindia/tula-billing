import {
  financialYear, roundDiv, steelRodWeightMilli, toMilli, toPaise, todayIST, validateSetting,
} from '@tula/core';
import { insert, one, setSetting, uuidv7, type Db, type Exec } from '@tula/db';
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountId, ensureSystemAccounts, partyAccountId, post } from './accounts';

export const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');

// ---------- Preset file format (all business data lives in these JSON files) ----------
interface PresetUnit { code: string; name_en: string; name_ta?: string; uqc?: string }
interface PresetProductUnit {
  unit: string;
  /** base-unit quantity in ONE of this unit, e.g. "6" (metres per length) */
  factor?: string;
  /** theoretical steel rod weight in kg = d² / 162 × length */
  steelRod?: { diameterMm: number; lengthM: string };
  /** N of another unit of the same product, e.g. bundle = 5 rods */
  multipleOf?: string;
  count?: number;
}
interface PresetProduct {
  sku: string; name_en: string; name_ta?: string; category: string; hsn?: string; gst: string; unit: string;
  rate?: { group: string; extra?: string } | { fixed: string };
  minStock?: string; units?: PresetProductUnit[]; attrs?: Record<string, unknown>; service?: boolean; brand?: string;
}
interface PresetParty {
  party_type: 'customer' | 'supplier' | 'both'; name_en: string; name_ta?: string; mobile?: string; address?: string;
  gstin?: string; state_code: string; credit_limit?: string; credit_days?: number; opening_balance?: string; lang?: string;
}
export interface Preset {
  id: string; name?: string; description?: string;
  units?: PresetUnit[];
  walkIn?: { name_en: string; name_ta?: string };
  rateGroups?: Array<{ code: string; name_en: string; name_ta?: string; unit: string }>;
  categories?: Array<{ key: string; name_en: string; name_ta?: string; service?: boolean }>;
  products?: PresetProduct[];
  demo?: {
    settings?: Record<string, string>;
    rates?: Record<string, string>;
    fixedRates?: Record<string, string>;
    parties?: PresetParty[];
    openingStock?: Array<[sku: string, qty: string, costPerUnit: string]>;
  };
}

export function listPresets(): Array<{ id: string; name: string; description: string }> {
  return readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => {
    const p = loadPreset(f.replace(/\.json$/, ''));
    return { id: p.id, name: p.name ?? p.id, description: p.description ?? '' };
  });
}

export function loadPreset(id: string): Preset {
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`Invalid preset id "${id}"`);
  return JSON.parse(readFileSync(join(PRESETS_DIR, `${id}.json`), 'utf8')) as Preset;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

export interface SetupOptions {
  /** preset to load, e.g. "building-materials" or "blank" */
  preset?: string;
  /** also load the preset's demo business, customers, rates and opening stock */
  demo?: boolean;
  ownerName?: string;
  ownerPin?: string;
}

/**
 * First-run setup. Creates this device, the owner, system accounts, the base
 * units, a walk-in customer and the chosen preset. Does nothing if already set up.
 */
export async function setup(db: Db, opts: SetupOptions = {}) {
  if (await one(db, "SELECT value FROM sync_state WHERE key = 'device_id'")) return { skipped: true as const };
  const tx = await db.transaction('write');
  try {
    const dev = uuidv7();
    await tx.execute({ sql: "INSERT INTO sync_state (key, value) VALUES ('device_id', ?)", args: [dev] });
    await insert(tx, 'devices', dev, { id: dev, name: 'Main computer', series_code: '', is_primary: 1 });
    const owner = await insert(tx, 'users', dev, { name: opts.ownerName ?? 'Owner', pin_hash: hashPin(opts.ownerPin ?? '1234'), role: 'owner' });
    await ensureSystemAccounts(tx, dev);

    const base = loadPreset('_base');
    await applyCatalog(tx, dev, base);
    const walkIn = await insert(tx, 'parties', dev, {
      party_type: 'customer', name_en: base.walkIn?.name_en ?? 'Walk-in customer', name_ta: base.walkIn?.name_ta,
      state_code: '', is_walk_in: 1,
    });
    await partyAccountId(tx, dev, walkIn);

    const preset = opts.preset ? loadPreset(opts.preset) : null;
    if (preset) await applyCatalog(tx, dev, preset);
    if (preset && opts.demo && preset.demo) await applyDemo(tx, dev, owner, preset);

    await tx.commit();
    return { skipped: false as const, deviceId: dev, ownerId: owner };
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

const idOf = async (ex: Exec, table: string, col: string, val: string) => {
  const r = await one<{ id: string }>(ex, `SELECT id FROM ${table} WHERE ${col} = ? AND deleted = 0`, [val]);
  if (!r) throw new Error(`${table}.${col} "${val}" not found`);
  return r.id;
};

/** Units, rate groups, categories and products from a preset. Safe to apply to an existing business. */
export async function applyCatalog(ex: Exec, dev: string, p: Preset) {
  for (const u of p.units ?? []) {
    if (!(await one(ex, 'SELECT id FROM units WHERE code = ?', [u.code]))) {
      await insert(ex, 'units', dev, { code: u.code, name_en: u.name_en, name_ta: u.name_ta, gst_uqc: u.uqc });
    }
  }
  for (const [i, g] of (p.rateGroups ?? []).entries()) {
    if (!(await one(ex, 'SELECT id FROM rate_groups WHERE code = ?', [g.code]))) {
      await insert(ex, 'rate_groups', dev, { code: g.code, name_en: g.name_en, name_ta: g.name_ta, unit_id: await idOf(ex, 'units', 'code', g.unit), sort_order: i });
    }
  }
  const cats = new Map<string, string>();
  for (const [i, c] of (p.categories ?? []).entries()) {
    cats.set(c.key, await insert(ex, 'categories', dev, { name_en: c.name_en, name_ta: c.name_ta, is_service: c.service ? 1 : 0, sort_order: i }));
  }
  for (const pr of p.products ?? []) {
    if (await one(ex, 'SELECT id FROM products WHERE sku = ?', [pr.sku])) continue;
    const catId = cats.get(pr.category);
    if (!catId) throw new Error(`Product ${pr.sku}: unknown category "${pr.category}"`);
    const baseUnit = await idOf(ex, 'units', 'code', pr.unit);
    const daily = pr.rate && 'group' in pr.rate ? pr.rate : null;
    const fixed = pr.rate && 'fixed' in pr.rate ? pr.rate : null;
    const gstBp = toPaise(pr.gst); // "18" -> 1800: a percentage with 2 decimals is basis points
    const pid = await insert(ex, 'products', dev, {
      sku: pr.sku, name_en: pr.name_en, name_ta: pr.name_ta, category_id: catId, brand: pr.brand, hsn: pr.hsn, gst_bp: gstBp,
      base_unit_id: baseUnit, track_stock: pr.service ? 0 : 1, min_stock_milli: pr.minStock ? toMilli(pr.minStock) : 0,
      rate_mode: daily ? 'daily' : 'fixed', rate_group: daily?.group, rate_extra_paise: daily?.extra ? toPaise(daily.extra) : 0,
      sale_rate_paise: fixed ? toPaise(fixed.fixed) : 0, rate_unit_id: baseUnit, attrs_json: pr.attrs ?? {},
    });
    const factors = new Map<string, number>();
    for (const u of pr.units ?? []) {
      let factor: number;
      let theoretical = 0;
      if (u.steelRod) { factor = steelRodWeightMilli(u.steelRod.diameterMm, u.steelRod.lengthM); theoretical = 1; }
      else if (u.multipleOf) {
        const of = factors.get(u.multipleOf);
        if (!of || !u.count) throw new Error(`Product ${pr.sku}: unit ${u.unit} needs multipleOf an earlier unit and a count`);
        factor = of * u.count; theoretical = 1;
      } else if (u.factor) factor = toMilli(u.factor);
      else throw new Error(`Product ${pr.sku}: unit ${u.unit} needs factor, steelRod or multipleOf`);
      factors.set(u.unit, factor);
      await insert(ex, 'product_units', dev, { product_id: pid, unit_id: await idOf(ex, 'units', 'code', u.unit), factor_milli: factor, is_theoretical: theoretical });
    }
  }
}

async function applyDemo(ex: Exec, dev: string, owner: string, p: Preset) {
  const d = p.demo!;
  for (const [k, v] of Object.entries(d.settings ?? {})) await setSetting(ex, dev, k, validateSetting(k, v));
  const today = todayIST();
  const fy = financialYear(today);
  for (const [group, rate] of Object.entries(d.rates ?? {})) await insert(ex, 'daily_rates', dev, { rate_group: group, rate_date: today, rate_paise: toPaise(rate) });
  for (const [sku, rate] of Object.entries(d.fixedRates ?? {})) {
    await ex.execute({ sql: 'UPDATE products SET sale_rate_paise = ? WHERE sku = ?', args: [toPaise(rate), sku] });
  }
  for (const pa of d.parties ?? []) {
    const id = await insert(ex, 'parties', dev, {
      party_type: pa.party_type, name_en: pa.name_en, name_ta: pa.name_ta, mobile: pa.mobile, address: pa.address, gstin: pa.gstin,
      state_code: pa.state_code, credit_limit_paise: pa.credit_limit ? toPaise(pa.credit_limit) : 0, credit_days: pa.credit_days ?? 0,
      opening_balance_paise: pa.opening_balance ? toPaise(pa.opening_balance) : 0, opening_date: today, lang: pa.lang,
    });
    const acc = await partyAccountId(ex, dev, id);
    if (pa.opening_balance) {
      const amt = toPaise(pa.opening_balance);
      await post(ex, dev, { date: today, sourceType: 'OPEN', sourceId: id, narration: 'Opening balance', lines: [{ accountId: acc, debit: amt }, { accountId: await accountId(ex, 'OPENING'), credit: amt }] });
    }
  }
  if (d.openingStock?.length) {
    const adj = await insert(ex, 'stock_adjustments', dev, { doc_no: 'OPENING', doc_date: today, fy, reason: 'opening', notes: 'Opening stock', created_by: owner });
    for (const [sku, qty, cost] of d.openingStock) {
      const pid = await idOf(ex, 'products', 'sku', sku);
      const q = toMilli(qty);
      const c = toPaise(cost);
      const line = await insert(ex, 'stock_adjustment_lines', dev, { adjustment_id: adj, product_id: pid, qty_milli: q, cost_per_base_paise: c });
      await insert(ex, 'stock_moves', dev, { move_date: today, product_id: pid, qty_milli: q, value_paise: roundDiv(q * c, 1000), source_type: 'ADJ', source_id: adj, source_line_id: line });
    }
  }
}
