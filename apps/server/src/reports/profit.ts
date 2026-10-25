import { financialYear, financialYearRange, roundDiv } from '@tula/core';
import { all, type Exec } from '@tula/db';
import { businessOf, marginBp, monthRange, n, sumRows, type Col, type Report, type Row } from './common';
import { avgCostsAsOf } from './stock';

export interface Pnl {
  sales: number; // INV taxable
  returns: number; // CN taxable
  netSales: number;
  cogs: number; // INV line costs − CN line costs
  gross: number;
  expenses: Array<{ headId: string; name_en: string; name_ta: string | null; amount: number }>;
  totalExpenses: number;
  stockLoss: number; // net of stock found
  net: number;
}

const ACTIVE_SALES = `d.deleted = 0 AND d.status = 'active' AND d.doc_date BETWEEN ? AND ?`;

/**
 * Profit and loss from documents (engineering guide §4):
 * sales (taxable, INV − CN) − COGS (INV line costs − CN line costs) = gross profit;
 * − expenses (taxable + non-ITC tax) − stock-correction losses = net profit.
 */
export async function computePnl(ex: Exec, from: string, to: string, costs?: Map<string, number>): Promise<Pnl> {
  const s = (await all<{ inv: number; cn: number }>(ex, `
    SELECT COALESCE(SUM(CASE WHEN d.doc_type = 'INV' THEN d.taxable_paise END), 0) inv,
           COALESCE(SUM(CASE WHEN d.doc_type = 'CN' THEN d.taxable_paise END), 0) cn
    FROM sales_docs d WHERE d.doc_type IN ('INV','CN') AND ${ACTIVE_SALES}`, [from, to]))[0];
  const c = (await all<{ inv: number; cn: number }>(ex, `
    SELECT COALESCE(SUM(CASE WHEN d.doc_type = 'INV' THEN l.cost_total_paise END), 0) inv,
           COALESCE(SUM(CASE WHEN d.doc_type = 'CN' THEN l.cost_total_paise END), 0) cn
    FROM sales_doc_lines l JOIN sales_docs d ON d.id = l.doc_id
    WHERE l.deleted = 0 AND d.doc_type IN ('INV','CN') AND ${ACTIVE_SALES}`, [from, to]))[0];
  const expenses = await all<{ head_id: string; name_en: string; name_ta: string | null; amount: number }>(ex, `
    SELECT e.head_id, h.name_en, h.name_ta,
      SUM(e.taxable_paise + CASE WHEN e.itc_eligible = 1 THEN 0 ELSE e.cgst_paise + e.sgst_paise + e.igst_paise END) amount
    FROM expenses e LEFT JOIN expense_heads h ON h.id = e.head_id
    WHERE e.deleted = 0 AND e.status = 'active' AND e.doc_date BETWEEN ? AND ?
    GROUP BY e.head_id ORDER BY h.name_en`, [from, to]);
  const moves = await all<{ product_id: string; qty_milli: number; value_paise: number | null }>(ex, `
    SELECT m.product_id, m.qty_milli, m.value_paise FROM stock_moves m JOIN stock_adjustments a ON a.id = m.source_id
    WHERE m.deleted = 0 AND m.source_type = 'ADJ' AND a.deleted = 0 AND a.reason != 'opening' AND m.move_date BETWEEN ? AND ?`, [from, to]);
  let stockLoss = 0;
  if (moves.length) {
    const avg = costs ?? (await avgCostsAsOf(ex, to));
    for (const m of moves) {
      const q = n(m.qty_milli);
      if (q < 0) stockLoss += m.value_paise !== null ? Math.abs(n(m.value_paise)) : roundDiv(-q * (avg.get(m.product_id) ?? 0), 1000);
      else stockLoss -= n(m.value_paise);
    }
  }
  const netSales = n(s?.inv) - n(s?.cn);
  const cogs = n(c?.inv) - n(c?.cn);
  const gross = netSales - cogs;
  const totalExpenses = expenses.reduce((a, e) => a + n(e.amount), 0);
  return {
    sales: n(s?.inv), returns: n(s?.cn), netSales, cogs, gross,
    expenses: expenses.map((e) => ({ headId: e.head_id, name_en: e.name_en ?? e.head_id, name_ta: e.name_ta, amount: n(e.amount) })),
    totalExpenses, stockLoss, net: gross - totalExpenses - stockLoss,
  };
}

/** R-07 Profit and loss for the period, with a month-by-month view of the financial year. */
export async function profitLoss(ex: Exec, from: string, to: string): Promise<Report> {
  const { business } = await businessOf(ex);
  const p = await computePnl(ex, from, to);
  const L = (code: string, amount: number, extra: Row = {}): Row => ({ line: { code }, amount, ...extra });
  const rows: Row[] = [
    L('sales', p.sales),
    L('returns', -p.returns),
    L('netSales', p.netSales, { _strong: true }),
    L('cogs', -p.cogs),
    L('gross', p.gross, { _strong: true }),
    ...p.expenses.map((e) => ({ line: { en: e.name_en, ta: e.name_ta }, amount: -e.amount, _indent: true })),
    L('totalExpenses', -p.totalExpenses),
    L('stockLoss', -p.stockLoss),
    L('net', p.net, { _strong: true }),
  ];
  const fy = financialYear(to);
  const fyr = financialYearRange(fy);
  const months: Row[] = [];
  const costs = await avgCostsAsOf(ex, fyr.to);
  for (let i = 0; i < 12; i++) {
    const y = Number(fyr.from.slice(0, 4)) + (i >= 9 ? 1 : 0);
    const m = ((i + 3) % 12) + 1;
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const r = monthRange(ym);
    const mp = await computePnl(ex, r.from, r.to, costs);
    months.push({ month: ym, sales: mp.netSales, cogs: mp.cogs, gross: mp.gross, expenses: mp.totalExpenses, stock_loss: mp.stockLoss, net: mp.net, margin: marginBp(mp.net, mp.netSales) });
  }
  const mt = sumRows(months, ['sales', 'cogs', 'gross', 'expenses', 'stock_loss', 'net']);
  mt.margin = marginBp(n(mt.net), n(mt.sales));
  return {
    id: 'profit-loss', title: 'Profit and loss', from, to, business,
    summary: { netSales: p.netSales, cogs: p.cogs, gross: p.gross, expenses: p.totalExpenses, stockLoss: p.stockLoss, net: p.net, margin: marginBp(p.net, p.netSales), fy },
    tables: [
      { id: 'pnl', title: 'Profit and loss', columns: [{ key: 'line', type: 'name', header: 'Item', width: 34 }, { key: 'amount', type: 'money', header: 'Amount', width: 16 }], rows },
      {
        id: 'months', title: `Month by month, FY ${fy}`, sheet: `Months FY ${fy}`, rows: months, totals: mt,
        columns: [
          { key: 'month', type: 'code', header: 'Month', width: 10 },
          { key: 'sales', type: 'money', header: 'Sales' },
          { key: 'cogs', type: 'money', header: 'Cost of goods sold' },
          { key: 'gross', type: 'money', header: 'Gross profit' },
          { key: 'expenses', type: 'money', header: 'Expenses' },
          { key: 'stock_loss', type: 'money', header: 'Stock correction loss' },
          { key: 'net', type: 'money', header: 'Net profit' },
          { key: 'margin', type: 'pct', header: 'Net margin' },
        ],
      },
    ],
    notes: ['pnlFormula', 'stockLossNet'],
  };
}

export type ProfitBy = 'bill' | 'customer' | 'item';

/** R-06 Profit by bill, customer or item: taxable sales − cost snapshot, net of credit notes. */
export async function profitBy(ex: Exec, from: string, to: string, by: ProfitBy): Promise<Report> {
  const { business } = await businessOf(ex);
  const key = by === 'bill' ? `CASE WHEN d.doc_type = 'INV' THEN d.id ELSE COALESCE(d.ref_doc_id, d.id) END`
    : by === 'customer' ? 'd.party_id' : 'l.product_id';
  const sign = `CASE WHEN d.doc_type = 'CN' THEN -1 ELSE 1 END`;
  const agg = await all<{ k: string; sales: number; cost: number; qty: number; returns: number }>(ex, `
    SELECT ${key} AS k, SUM(${sign} * l.taxable_paise) sales, SUM(${sign} * COALESCE(l.cost_total_paise, 0)) cost,
      SUM(${sign} * l.base_qty_milli) qty, SUM(CASE WHEN d.doc_type = 'CN' THEN l.taxable_paise ELSE 0 END) returns
    FROM sales_doc_lines l JOIN sales_docs d ON d.id = l.doc_id
    WHERE l.deleted = 0 AND d.doc_type IN ('INV','CN') AND ${ACTIVE_SALES}
    GROUP BY k`, [from, to]);
  const ids = agg.map((a) => a.k);
  const marks = ids.map(() => '?').join(',') || "''";
  const base = (r: (typeof agg)[number]): Row => ({
    sales: n(r.sales), cost: n(r.cost), profit: n(r.sales) - n(r.cost), margin: marginBp(n(r.sales) - n(r.cost), n(r.sales)), returns: n(r.returns),
  });
  let rows: Row[];
  let cols: Col[];
  if (by === 'bill') {
    const docs = new Map((await all<Record<string, unknown>>(ex, `SELECT id, doc_no, doc_date, party_name FROM sales_docs WHERE id IN (${marks})`, ids)).map((d) => [String(d.id), d]));
    rows = agg.map((a) => {
      const d = docs.get(a.k);
      return { date: d?.doc_date, doc_no: d?.doc_no, party: d?.party_name, outside: !!d && (String(d.doc_date) < from || String(d.doc_date) > to), ...base(a) };
    }).sort((x, y) => String(x.date).localeCompare(String(y.date)) || String(x.doc_no).localeCompare(String(y.doc_no)));
    cols = [{ key: 'date', type: 'date', header: 'Date' }, { key: 'doc_no', type: 'code', header: 'Bill', width: 17 }, { key: 'party', type: 'text', header: 'Customer', width: 28 }];
  } else if (by === 'customer') {
    const ps = new Map((await all<Record<string, unknown>>(ex, `SELECT id, name_en, name_ta FROM parties WHERE id IN (${marks})`, ids)).map((p) => [String(p.id), p]));
    rows = agg.map((a): Row => ({ party: { en: ps.get(a.k)?.name_en ?? '', ta: ps.get(a.k)?.name_ta ?? null }, ...base(a) }))
      .sort((x: Row, y: Row) => n(y.profit) - n(x.profit));
    cols = [{ key: 'party', type: 'name', header: 'Customer', width: 30 }];
  } else {
    const ps = new Map((await all<Record<string, unknown>>(ex, `
      SELECT p.id, p.sku, p.name_en, p.name_ta, u.name_en AS unit_en, u.name_ta AS unit_ta FROM products p JOIN units u ON u.id = p.base_unit_id
      WHERE p.id IN (${marks})`, ids)).map((p) => [String(p.id), p]));
    rows = agg.map((a): Row => {
      const p = ps.get(a.k);
      return { sku: p?.sku ?? '', item: { en: p?.name_en ?? '', ta: p?.name_ta ?? null }, qty: n(a.qty), unit: { en: p?.unit_en ?? '', ta: p?.unit_ta ?? null }, ...base(a) };
    }).sort((x: Row, y: Row) => n(y.profit) - n(x.profit));
    cols = [{ key: 'sku', type: 'code', header: 'Code', width: 13 }, { key: 'item', type: 'name', header: 'Item', width: 28 }, { key: 'qty', type: 'qty', header: 'Quantity sold' }, { key: 'unit', type: 'name', header: 'Unit', width: 8 }];
  }
  cols = [...cols,
    { key: 'sales', type: 'money', header: 'Sales (taxable)' },
    { key: 'returns', type: 'money', header: 'Of which returned' },
    { key: 'cost', type: 'money', header: 'Cost' },
    { key: 'profit', type: 'money', header: 'Profit' },
    { key: 'margin', type: 'pct', header: 'Margin' },
  ];
  const totals = sumRows(rows, ['sales', 'returns', 'cost', 'profit']);
  totals.margin = marginBp(n(totals.profit), n(totals.sales));
  const title = { bill: 'Profit by bill', customer: 'Profit by customer', item: 'Profit by item' }[by];
  return {
    id: `profit-${by}`, title, from, to, business,
    tables: [{ id: `by_${by}`, title, columns: cols, rows, totals, sortable: true }],
    summary: { sales: n(totals.sales), cost: n(totals.cost), profit: n(totals.profit), margin: n(totals.margin) },
  };
}
