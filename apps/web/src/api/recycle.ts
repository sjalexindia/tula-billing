import { req } from '../api';

/** Recycle bin (apps/server/src/recycle.ts): delete unused masters, see them, put them back. */
export type BinKind = 'products' | 'parties' | 'categories' | 'expense_heads';
export interface BinRow { kind: BinKind; id: string; name_en: string; name_ta: string | null; code: string | null; deleted_at: string; deleted_by: string | null }

const PATH: Record<BinKind, string> = { products: 'products', parties: 'parties', categories: 'categories', expense_heads: 'expense-heads' };

export const recycleApi = {
  list: () => req<BinRow[]>('GET', '/api/recycle-bin'),
  remove: (kind: BinKind, id: string) => req<{ ok: true }>('DELETE', `/api/${PATH[kind]}/${id}`),
  restore: (kind: BinKind, id: string) => req<{ ok: true }>('POST', `/api/recycle-bin/${kind}/${id}/restore`, {}),
};
