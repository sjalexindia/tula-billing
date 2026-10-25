import { all, one, type Exec } from '@tula/db';

export interface ProductRow {
  id: string;
  sku: string;
  name_en: string;
  name_ta: string | null;
  hsn: string | null;
  gst_bp: number;
  base_unit_id: string;
  base_unit_code: string;
  track_stock: number;
  min_stock_milli: number;
  rate_mode: 'fixed' | 'daily';
  rate_group: string | null;
  rate_extra_paise: number;
  sale_rate_paise: number;
  rate_unit_id: string | null;
  attrs_json: string;
}

export interface ProductUnit {
  unit_id: string;
  code: string;
  name_en: string;
  name_ta: string | null;
  factor_milli: number;
  is_theoretical: number;
  on_bill: number;
}

export async function getProduct(ex: Exec, id: string): Promise<ProductRow | undefined> {
  return one<ProductRow>(ex, `
    SELECT p.*, u.code AS base_unit_code
    FROM products p JOIN units u ON u.id = p.base_unit_id
    WHERE p.id = ? AND p.deleted = 0`, [id]);
}

export async function productUnits(ex: Exec, productId: string): Promise<ProductUnit[]> {
  return all<ProductUnit>(ex, `
    SELECT pu.unit_id, u.code, u.name_en, u.name_ta, pu.factor_milli, pu.is_theoretical, pu.on_bill
    FROM product_units pu JOIN units u ON u.id = pu.unit_id
    WHERE pu.product_id = ? AND pu.deleted = 0 ORDER BY pu.factor_milli DESC`, [productId]);
}

/** Latest daily rate on or before the date. */
export async function dailyRate(ex: Exec, group: string, date: string): Promise<number | null> {
  const r = await one<{ rate_paise: number }>(ex, `
    SELECT rate_paise FROM daily_rates
    WHERE rate_group = ? AND rate_date <= ? AND deleted = 0
    ORDER BY rate_date DESC LIMIT 1`, [group, date]);
  return r ? Number(r.rate_paise) : null;
}

/**
 * Rate resolution (per rate unit, excl. GST):
 *   party-wise rate → party's price level → today's group rate + size extra, or fixed rate.
 */
export async function resolveRate(ex: Exec, p: ProductRow, partyId: string | null, date: string): Promise<{ ratePaise: number; source: string }> {
  let base: number;
  if (p.rate_mode === 'daily' && p.rate_group) {
    const r = await dailyRate(ex, p.rate_group, date);
    if (r === null) return { ratePaise: 0, source: 'missing_daily_rate' };
    base = r + Number(p.rate_extra_paise);
  } else {
    base = Number(p.sale_rate_paise);
  }
  if (partyId) {
    const pr = await one<{ rate_paise: number | null; adjust_paise: number | null }>(ex,
      'SELECT rate_paise, adjust_paise FROM party_rates WHERE party_id = ? AND product_id = ? AND deleted = 0', [partyId, p.id]);
    if (pr) return { ratePaise: pr.rate_paise != null ? Number(pr.rate_paise) : base + Number(pr.adjust_paise ?? 0), source: 'party' };
    const lv = await one<{ rate_paise: number | null; adjust_paise: number | null }>(ex, `
      SELECT pp.rate_paise, pp.adjust_paise FROM product_prices pp
      JOIN parties pa ON pa.price_level_id = pp.price_level_id
      WHERE pa.id = ? AND pp.product_id = ? AND pp.deleted = 0`, [partyId, p.id]);
    if (lv) return { ratePaise: lv.rate_paise != null ? Number(lv.rate_paise) : base + Number(lv.adjust_paise ?? 0), source: 'price_level' };
  }
  return { ratePaise: base, source: p.rate_mode === 'daily' ? 'daily' : 'fixed' };
}

export async function stockOnHand(ex: Exec, productId: string): Promise<number> {
  const r = await one<{ q: number }>(ex, 'SELECT COALESCE(SUM(qty_milli),0) q FROM stock_moves WHERE product_id = ? AND deleted = 0', [productId]);
  return Number(r?.q ?? 0);
}

export async function avgCost(ex: Exec, productId: string): Promise<number> {
  const r = await one<{ c: number }>(ex, 'SELECT avg_cost_per_base_paise c FROM v_avg_cost WHERE product_id = ?', [productId]);
  return Number(r?.c ?? 0);
}

/** Everything the New Bill screen needs about products, with today's resolved rate and stock. */
export async function catalog(ex: Exec, date: string) {
  const prods = await all<ProductRow & { category_en: string; category_ta: string | null; base_unit_en: string; base_unit_ta: string | null }>(ex, `
    SELECT p.*, u.code AS base_unit_code, u.name_en AS base_unit_en, u.name_ta AS base_unit_ta,
           c.name_en AS category_en, c.name_ta AS category_ta
    FROM products p JOIN units u ON u.id = p.base_unit_id JOIN categories c ON c.id = p.category_id
    WHERE p.deleted = 0 AND p.active = 1 ORDER BY c.sort_order, p.sku`);
  const out = [];
  for (const p of prods) {
    const rate = await resolveRate(ex, p, null, date);
    out.push({
      id: p.id, sku: p.sku, nameEn: p.name_en, nameTa: p.name_ta, hsn: p.hsn, gstBp: Number(p.gst_bp),
      categoryEn: p.category_en, categoryTa: p.category_ta,
      baseUnit: p.base_unit_code, baseUnitEn: p.base_unit_en, baseUnitTa: p.base_unit_ta, trackStock: !!p.track_stock,
      attrs: JSON.parse(p.attrs_json || '{}'),
      units: (await productUnits(ex, p.id)).map((u) => ({ code: u.code, nameEn: u.name_en, nameTa: u.name_ta, factorMilli: Number(u.factor_milli), theoretical: !!u.is_theoretical, onBill: !!u.on_bill })),
      ratePaise: rate.ratePaise, rateSource: rate.source, rateGroup: p.rate_mode === 'daily' ? p.rate_group : null,
      stockMilli: p.track_stock ? await stockOnHand(ex, p.id) : null,
      minStockMilli: Number(p.min_stock_milli),
    });
  }
  return out;
}
