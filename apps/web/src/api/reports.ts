import { req } from '../api';

export type ColType = 'text' | 'date' | 'money' | 'qty' | 'int' | 'pct' | 'rate' | 'name' | 'alt' | 'code';
export interface Col { key: string; type: ColType; header: string; translate?: boolean }
export type Cell = unknown;
export type Row = Record<string, Cell> & { _cancelled?: boolean; _strong?: boolean; _indent?: boolean; _opening?: boolean };
export interface Table { id: string; title: string; columns: Col[]; rows: Row[]; totals?: Row; sortable?: boolean }
export interface Report {
  id: string; title: string; from: string; to: string;
  business: { name_en: string; name_ta: string; gstin: string; scheme: string; state_code: string };
  tables: Table[];
  summary?: Record<string, number | string | null>;
  notes?: string[];
  warnings?: Array<{ code: string; detail?: string }>;
}

/** How a report picks its period. */
export type PeriodKind = 'range' | 'asOf' | 'month' | 'quarter';
export interface ReportDef {
  id: string;
  group: 'daily' | 'sales' | 'stock' | 'profit' | 'gst';
  endpoint: string;
  period: PeriodKind;
  params?: Record<string, string>;
  /** shown only for these GST schemes */
  schemes?: string[];
}

export const REPORTS: ReportDef[] = [
  { id: 'day-book', group: 'daily', endpoint: 'day-book', period: 'range' },
  { id: 'cash-book', group: 'daily', endpoint: 'cash-book', period: 'range' },
  { id: 'sales-register', group: 'sales', endpoint: 'sales-register', period: 'range' },
  { id: 'purchase-register', group: 'sales', endpoint: 'purchase-register', period: 'range' },
  { id: 'rate-group', group: 'sales', endpoint: 'rate-group', period: 'range' },
  { id: 'stock-summary', group: 'stock', endpoint: 'stock-summary', period: 'asOf' },
  { id: 'profit-loss', group: 'profit', endpoint: 'profit-loss', period: 'range' },
  { id: 'profit-bill', group: 'profit', endpoint: 'profit', period: 'range', params: { by: 'bill' } },
  { id: 'profit-customer', group: 'profit', endpoint: 'profit', period: 'range', params: { by: 'customer' } },
  { id: 'profit-item', group: 'profit', endpoint: 'profit', period: 'range', params: { by: 'item' } },
  { id: 'gstr1', group: 'gst', endpoint: 'gstr1', period: 'month', schemes: ['regular'] },
  { id: 'gstr3b', group: 'gst', endpoint: 'gstr3b', period: 'month', schemes: ['regular'] },
  { id: 'cmp08', group: 'gst', endpoint: 'cmp08', period: 'quarter', schemes: ['composition'] },
];
export const GROUPS: ReportDef['group'][] = ['daily', 'sales', 'stock', 'profit', 'gst'];

export const reportUrl = (def: ReportDef, params: Record<string, string>, xlsx = false) => {
  const qs = new URLSearchParams({ ...def.params, ...params, ...(xlsx ? { format: 'xlsx' } : {}) });
  return `/api/reports/${def.endpoint}?${qs.toString()}`;
};

export const reportsApi = {
  get: (def: ReportDef, params: Record<string, string>) => req<Report>('GET', reportUrl(def, params)),
  rateGroups: () => req<Array<{ code: string; name_en: string; name_ta: string | null }>>('GET', '/api/reports/rate-groups'),
};
