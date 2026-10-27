import { req, type BillInput, type Preview, type Warning } from '../api';

/* Quotations (apps/server/src/quotes.ts): priced like bills, no stock or accounts effect, become one bill. */

export type QuoteState = 'open' | 'expired' | 'converted' | 'cancelled';
export interface QuoteRow {
  id: string; docNo: string; date: string; party: string; site: string | null; totalPaise: number; validUntil: string | null;
  state: QuoteState; bill: { id: string; docNo: string } | null;
}
export interface QuoteInfo { validUntil: string | null; state: QuoteState; bill: { id: string; docNo: string } | null }
export interface ConvertPreview {
  totals: Preview['totals']; warnings: Warning[]; blocked: boolean; balanceBefore: number;
  lines: Array<{ productId: string; name_en: string; name_ta: string | null; quotedRatePaise: number; ratePaise: number; total: number }>;
}
export type QuoteInput = Omit<BillInput, 'payment' | 'confirmWarnings'> & { validUntil?: string };
export interface Saved { saved: boolean; id?: string; docNo?: string; total?: number; warnings: Warning[]; blocked?: boolean }

export const quotesApi = {
  preview: (q: QuoteInput) => req<Preview>('POST', '/api/quotes/preview', q),
  save: (q: QuoteInput) => req<Saved>('POST', '/api/quotes', q),
  list: (p: { from?: string; to?: string; q?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as Array<[string, string]>);
    return req<QuoteRow[]>('GET', `/api/quotes${qs.size ? `?${qs}` : ''}`);
  },
  info: (id: string) => req<{ quote: QuoteInfo }>('GET', `/api/quotes/${id}`).then((r) => r.quote),
  convertPreview: (id: string, keepRates: boolean) => req<ConvertPreview>('POST', `/api/quotes/${id}/convert/preview`, { keepRates }),
  convert: (id: string, keepRates: boolean, confirmWarnings = false) =>
    req<Saved>('POST', `/api/quotes/${id}/convert`, { keepRates, confirmWarnings }, true),
  cancel: (id: string) => req<{ ok: boolean }>('POST', `/api/quotes/${id}/cancel`, {}),
};
