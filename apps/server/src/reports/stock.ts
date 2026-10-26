import { roundDiv, splitIntoUnits } from '@tula/core';
import { all, type Exec } from '@tula/db';
import { businessOf, n, type Report, type Row } from './common';

/** Days between two 'YYYY-MM-DD' dates. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * Average cost per base unit as of a date (paise): all inward value ÷ all inward quantity up to that date,
 * the same rule as v_avg_cost.
 */
export async function avgCostsAsOf(ex: Exec, asOf: string): Promise<Map<string, number>> {
  const rows = await all<{ product_id: string; v: number; q: number }>(ex, `
    SELECT product_id, SUM(value_paise) v, SUM(qty_milli) q FROM stock_moves
    WHERE deleted = 0 AND qty_milli > 0 AND value_paise IS NOT NULL AND move_date <= ?
    GROUP BY product_id`, [asOf]);
  return new Map(rows.map((r) => [r.product_id, n(r.q) > 0 ? roundDiv(n(r.v) * 1000, n(r.q)) : 0]));
}

/** R-03 Stock summary as of a date: quantity (base + largest larger unit), average cost, value; low and slow-moving lists. */
export async function stockSummary(ex: Exec, asOf: string, slowDays: number): Promise<Report> {
  const { business } = await businessOf(ex);
  const products = await all<Record<string, unknown>>(ex, `
    SELECT p.id, p.sku, p.name_en, p.name_ta, p.min_stock_milli, u.code AS unit_code, u.name_en AS unit_en, u.name_ta AS unit_ta,
      COALESCE((SELECT SUM(m.qty_milli) FROM stock_moves m WHERE m.product_id = p.id AND m.deleted = 0 AND m.move_date <= ?), 0) AS qty,
      (SELECT MAX(m.move_date) FROM stock_moves m WHERE m.product_id = p.id AND m.deleted = 0 AND m.source_type = 'INV' AND m.move_date <= ?) AS last_sale
    FROM products p JOIN units u ON u.id = p.base_unit_id
    WHERE p.deleted = 0 AND p.track_stock = 1
    ORDER BY p.sku`, [asOf, asOf]);
  // unit code breaks ties between equal-sized units, so every device shows the same one
  const larger = await all<{ product_id: string; factor_milli: number; name_en: string; name_ta: string | null }>(ex, `
    SELECT pu.product_id, pu.factor_milli, u.name_en, u.name_ta FROM product_units pu JOIN units u ON u.id = pu.unit_id
    WHERE pu.deleted = 0 ORDER BY pu.factor_milli DESC, u.code`);
  const largest = new Map<string, (typeof larger)[number]>();
  for (const l of larger) if (!largest.has(l.product_id)) largest.set(l.product_id, l);
  const costs = await avgCostsAsOf(ex, asOf);

  const rows: Row[] = products.map((p) => {
    const qty = n(p.qty);
    const avg = costs.get(String(p.id)) ?? 0;
    const big = largest.get(String(p.id));
    const split = big && qty > 0 ? splitIntoUnits(qty, n(big.factor_milli)) : null;
    const status = qty < 0 ? 'NEGATIVE' : qty === 0 ? 'OUT' : qty <= n(p.min_stock_milli) ? 'LOW' : 'OK';
    const lastSale = p.last_sale ? String(p.last_sale) : null;
    return {
      sku: p.sku, item: { en: p.name_en, ta: p.name_ta }, qty, unit: { en: p.unit_en, ta: p.unit_ta },
      larger: split && big ? { whole: split.whole, en: big.name_en, ta: big.name_ta } : null,
      avg_cost: avg, value: roundDiv(qty * avg, 1000), min_stock: n(p.min_stock_milli), status,
      last_sale: lastSale, days_since_sale: lastSale ? daysBetween(lastSale, asOf) : null,
    };
  });
  const cols: Report['tables'][number]['columns'] = [
    { key: 'sku', type: 'code', header: 'Code', width: 13 },
    { key: 'item', type: 'name', header: 'Item', width: 28 },
    { key: 'qty', type: 'qty', header: 'Quantity' },
    { key: 'unit', type: 'name', header: 'Unit', width: 8 },
    { key: 'larger', type: 'alt', header: 'In larger unit', width: 14 },
    { key: 'avg_cost', type: 'money', header: 'Average cost' },
    { key: 'value', type: 'money', header: 'Value' },
    { key: 'status', type: 'code', header: 'Status', width: 10, translate: true },
  ];
  const low = rows.filter((r) => r.status !== 'OK');
  const slow = rows.filter((r) => n(r.qty) > 0 && (r.days_since_sale === null || n(r.days_since_sale) >= slowDays));
  const value = rows.reduce((a, r) => a + n(r.value), 0);
  return {
    id: 'stock-summary', title: 'Stock summary', from: asOf, to: asOf, business,
    summary: { value, items: rows.length, low: low.length, slow: slow.length, slowDays },
    tables: [
      { id: 'stock', title: 'Stock summary', columns: cols, rows, totals: { value }, sortable: true },
      {
        id: 'low', title: 'Low stock', rows: low,
        columns: [cols[0]!, cols[1]!, cols[2]!, { key: 'min_stock', type: 'qty', header: 'Minimum' }, cols[3]!, cols[7]!],
      },
      {
        id: 'slow', title: `Slow moving (no sale in ${slowDays} days)`, sheet: 'Slow moving', rows: slow,
        columns: [cols[0]!, cols[1]!, cols[2]!, cols[3]!, cols[6]!, { key: 'last_sale', type: 'date', header: 'Last sale' }, { key: 'days_since_sale', type: 'int', header: 'Days since sale' }],
        totals: { value: slow.reduce((a, r) => a + n(r.value), 0) },
      },
    ],
    notes: ['avgCostAsOf', 'slowMoving'],
  };
}
