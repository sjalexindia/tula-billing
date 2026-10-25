import { roundDiv } from '@tula/core';
import { all, type Exec } from '@tula/db';
import { UserError } from '../context';
import { businessOf, n, type Report, type Row } from './common';

/**
 * R-09 Rate group report (e.g. TMT bars per kg): quantity sold per item per day or month, and the average
 * realised rate against that day's base rate + the item's size extra. Credit notes are netted.
 */
export async function rateGroupReport(ex: Exec, from: string, to: string, groupCode: string | undefined, by: 'day' | 'month'): Promise<Report> {
  const { business, settings } = await businessOf(ex);
  const groups = await all<{ code: string; name_en: string; name_ta: string | null; unit_en: string | null; unit_ta: string | null }>(ex, `
    SELECT g.code, g.name_en, g.name_ta, u.name_en AS unit_en, u.name_ta AS unit_ta FROM rate_groups g LEFT JOIN units u ON u.id = g.unit_id
    WHERE g.deleted = 0 ORDER BY g.sort_order, g.code`);
  const group = groupCode ? groups.find((g) => g.code === groupCode) : groups[0];
  if (groupCode && !group) throw new UserError(`Unknown rate group ${groupCode}`, 'NOT_FOUND', 404);
  // When rates are quoted including GST, compare against the GST-inclusive amount.
  const inclusive = settings['billing.rates_include_gst'] === 'true';
  const lines = group ? await all<Record<string, unknown>>(ex, `
    SELECT d.doc_date, d.doc_type, l.product_id, p.sku, p.name_en, p.name_ta, p.rate_extra_paise, l.base_qty_milli, l.taxable_paise, l.line_total_paise,
      (SELECT r.rate_paise FROM daily_rates r WHERE r.rate_group = p.rate_group AND r.deleted = 0 AND r.rate_date <= d.doc_date ORDER BY r.rate_date DESC LIMIT 1) AS base_rate
    FROM sales_doc_lines l JOIN sales_docs d ON d.id = l.doc_id JOIN products p ON p.id = l.product_id
    WHERE l.deleted = 0 AND d.deleted = 0 AND d.status = 'active' AND d.doc_type IN ('INV','CN') AND p.rate_group = ?
      AND d.doc_date BETWEEN ? AND ?
    ORDER BY d.doc_date, p.sku`, [group.code, from, to]) : [];

  type Acc = { period: string; sku: string; item: { en: string; ta: string | null }; qty: number; amount: number; expected: number; ratedQty: number };
  const byKey = new Map<string, Acc>();
  const byItem = new Map<string, Acc>();
  for (const l of lines) {
    const s = l.doc_type === 'CN' ? -1 : 1;
    const qty = s * n(l.base_qty_milli);
    const amount = s * n(inclusive ? l.line_total_paise : l.taxable_paise);
    const hasRate = l.base_rate !== null && l.base_rate !== undefined;
    const expected = hasRate ? roundDiv(qty * (n(l.base_rate) + n(l.rate_extra_paise)), 1000) : 0;
    const p = by === 'day' ? String(l.doc_date) : String(l.doc_date).slice(0, 7);
    for (const [map, k, periodLabel] of [[byKey, `${p}|${l.sku}`, p], [byItem, String(l.sku), '']] as const) {
      const a = map.get(k) ?? { period: periodLabel, sku: String(l.sku), item: { en: String(l.name_en), ta: (l.name_ta as string | null) ?? null }, qty: 0, amount: 0, expected: 0, ratedQty: 0 };
      a.qty += qty; a.amount += amount;
      if (hasRate) { a.expected += expected; a.ratedQty += qty; }
      map.set(k, a);
    }
  }
  const toRow = (a: Acc): Row => {
    const realised = a.qty ? roundDiv(a.amount * 1000, a.qty) : null;
    const baseRate = a.ratedQty ? roundDiv(a.expected * 1000, a.ratedQty) : null;
    return {
      period: a.period, sku: a.sku, item: a.item, qty: a.qty, amount: a.amount, realised, base_rate: baseRate,
      diff: realised !== null && baseRate !== null ? realised - baseRate : null,
      diff_amount: a.ratedQty ? a.amount - a.expected : null,
    };
  };
  const rows = [...byKey.values()].map(toRow);
  const items = [...byItem.values()].map(toRow);
  const tq = items.reduce((x, r) => x + n(r.qty), 0);
  const ta = items.reduce((x, r) => x + n(r.amount), 0);
  const unit = group?.unit_en ?? 'unit';
  const cols: Report['tables'][number]['columns'] = [
    { key: 'period', type: by === 'day' ? 'date' : 'code', header: by === 'day' ? 'Date' : 'Month', width: 11 },
    { key: 'sku', type: 'code', header: 'Code', width: 12 },
    { key: 'item', type: 'name', header: 'Item', width: 26 },
    { key: 'qty', type: 'qty', header: `Quantity (${unit})` },
    { key: 'amount', type: 'money', header: inclusive ? 'Amount incl. GST' : 'Taxable value' },
    { key: 'realised', type: 'money', header: `Realised rate per ${unit}` },
    { key: 'base_rate', type: 'money', header: `Base rate + extra per ${unit}` },
    { key: 'diff', type: 'money', header: `Difference per ${unit}` },
    { key: 'diff_amount', type: 'money', header: 'Difference total' },
  ];
  const diffTotal = items.reduce((x, r) => x + n(r.diff_amount), 0);
  return {
    id: 'rate-group', title: `${group?.name_en ?? 'Rate group'} sales and rates`, from, to, business,
    summary: { group: group?.code ?? null, qty: tq, amount: ta, realised: tq ? roundDiv(ta * 1000, tq) : null, diffTotal, inclusive: inclusive ? 1 : 0 },
    tables: [
      { id: 'by_period', title: by === 'day' ? 'By day' : 'By month', columns: cols, rows, totals: { qty: tq, amount: ta, diff_amount: diffTotal }, sortable: true },
      { id: 'by_item', title: 'By item', columns: cols.slice(1), rows: items, totals: { qty: tq, amount: ta, realised: tq ? roundDiv(ta * 1000, tq) : null, diff_amount: diffTotal }, sortable: true },
    ],
    notes: ['rateExtraToday'],
    warnings: group ? [] : [{ code: 'noRateGroup' }],
  };
}

export async function rateGroupsList(ex: Exec) {
  return all(ex, 'SELECT code, name_en, name_ta FROM rate_groups WHERE deleted = 0 ORDER BY sort_order, code');
}
