import { roundDiv, todayIST, withDefaults, type Settings } from '@tula/core';
import { getSettings, type Exec } from '@tula/db';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserError } from '../context';

/**
 * Every report is a list of tables described by typed columns, so one renderer draws them on screen,
 * one prints them and one writes them to Excel. Money is paise, quantity is milli, rates are basis points.
 */
export type ColType =
  | 'text' // plain string
  | 'date' // 'YYYY-MM-DD'
  | 'money' // paise
  | 'qty' // thousandths of a unit
  | 'int' // count
  | 'pct' // basis points of a percentage (12.34% = 1234), e.g. margin
  | 'rate' // GST rate in basis points (18% = 1800); Excel writes 18
  | 'name' // { en, ta } or a string
  | 'alt' // { whole, en, ta } — stock in the largest larger unit
  | 'code'; // short code shown as is (doc type, GSTIN, HSN); translated on screen when the column says so

export interface Col {
  key: string;
  type: ColType;
  /** English header: used in Excel (GST sheets use the GST offline tool's exact headers) */
  header: string;
  /** Excel column width in characters */
  width?: number;
  /** screen: translate the cell value with reports.values.<key>.<value> */
  translate?: boolean;
}

export type Row = Record<string, unknown> & { _cancelled?: boolean };

export interface Table {
  id: string;
  title: string;
  columns: Col[];
  rows: Row[];
  /** totals row (excludes cancelled documents) */
  totals?: Row;
  /** the screen lets people sort by any column */
  sortable?: boolean;
  /** GST offline-tool layout in Excel: summary rows on top, column headers on row 4, no totals row */
  gst?: { summaryTitle: string; summary: Array<{ header: string; key: string; value: number; type: ColType }> };
  /** Excel sheet name (max 31 chars); defaults to the title */
  sheet?: string;
}

export interface Report {
  id: string;
  title: string;
  from: string;
  to: string;
  business: { name_en: string; name_ta: string; gstin: string; scheme: string; state_code: string };
  tables: Table[];
  /** headline figures, e.g. net profit */
  summary?: Record<string, number | string | null>;
  /** codes the screen translates (reports.notes.<code>) and Excel writes in English */
  notes?: string[];
  warnings?: Array<{ code: string; detail?: string }>;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-25');

export const PeriodQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  format: z.enum(['json', 'xlsx']).optional(),
});

export function monthRange(ym: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) throw new UserError('Pick a month like 2026-10', 'BAD_MONTH');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new UserError('Pick a month like 2026-10', 'BAD_MONTH');
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

/** from/to from the query; default is this month (IST). */
export function period(q: { from?: string; to?: string }): { from: string; to: string } {
  const month = monthRange(todayIST().slice(0, 7));
  const from = q.from ?? month.from;
  const to = q.to ?? (q.from && !q.to ? todayIST() : month.to);
  if (from > to) throw new UserError('The start date is after the end date', 'BAD_PERIOD');
  return { from, to };
}

/** Reports are for the owner and viewers (family, CA). Counter staff may not see profit. */
export function requireReportRole(req: FastifyRequest) {
  if (!req.user || req.user.role === 'billing') throw new UserError('Reports are for the owner and viewers', 'FORBIDDEN', 403);
}

export async function businessOf(ex: Exec): Promise<{ settings: Settings; business: Report['business'] }> {
  const settings = withDefaults(await getSettings(ex));
  return {
    settings,
    business: {
      name_en: settings['business.name_en'], name_ta: settings['business.name_ta'], gstin: settings['gst.gstin'],
      scheme: settings['gst.scheme'], state_code: settings['business.state_code'],
    },
  };
}

export const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** profit ÷ sales as basis points of a percentage; null when there are no sales */
export const marginBp = (profit: number, sales: number): number | null => (sales === 0 ? null : roundDiv(profit * 10000, sales));

export function sumRows(rows: Row[], keys: string[]): Row {
  const t: Row = {};
  for (const k of keys) t[k] = rows.filter((r) => !r._cancelled).reduce((a, r) => a + n(r[k]), 0);
  return t;
}

/**
 * Every document as one row: type, number, date, party, amount, status.
 * Used by the day book and to label cash/bank entries. Deleted rows are excluded.
 * ADJ amount = value of the stock moved (+ found, − lost), excluding nothing else.
 */
export const DOCS_SQL = `
  SELECT d.id, d.doc_type, d.doc_no, d.doc_date, d.party_id, d.party_name, d.total_paise AS amount_paise, d.status, d.created_at
  FROM sales_docs d WHERE d.deleted = 0 AND d.doc_type IN ('INV','CN')
  UNION ALL
  SELECT m.id, m.doc_type, m.doc_no, m.doc_date, m.party_id, p.name_en, m.amount_paise, m.status, m.created_at
  FROM money_docs m LEFT JOIN parties p ON p.id = m.party_id WHERE m.deleted = 0
  UNION ALL
  SELECT u.id, u.doc_type, u.doc_no, u.doc_date, u.party_id, p.name_en, u.total_paise, u.status, u.created_at
  FROM purchase_docs u LEFT JOIN parties p ON p.id = u.party_id WHERE u.deleted = 0
  UNION ALL
  SELECT e.id, 'EXP', e.doc_no, e.doc_date, e.party_id, COALESCE(p.name_en, h.name_en), e.total_paise, e.status, e.created_at
  FROM expenses e LEFT JOIN parties p ON p.id = e.party_id LEFT JOIN expense_heads h ON h.id = e.head_id WHERE e.deleted = 0
  UNION ALL
  SELECT a.id, 'ADJ', a.doc_no, a.doc_date, NULL, a.reason,
    COALESCE((SELECT SUM(CASE WHEN m.qty_milli >= 0 THEN COALESCE(m.value_paise, 0) ELSE -ABS(COALESCE(m.value_paise, 0)) END)
      FROM stock_moves m WHERE m.source_type = 'ADJ' AND m.source_id = a.id AND m.deleted = 0), 0),
    'active', a.created_at
  FROM stock_adjustments a WHERE a.deleted = 0`;

export const DOC_TYPES = ['INV', 'CN', 'RCPT', 'PAY', 'PUR', 'DN', 'EXP', 'ADJ'] as const;

/** Safe filename part: keeps letters in any script, digits, spaces, - and _. */
export const fileSafe = (s: string) => s.replace(/[^\p{L}\p{M}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim();
