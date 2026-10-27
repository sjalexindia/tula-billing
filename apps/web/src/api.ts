import { apiFetch } from './platform';
import { errorText } from './server-text';

export interface CatalogUnit { code: string; nameEn: string; nameTa: string | null; factorMilli: number; theoretical: boolean; onBill: boolean }
export interface CatalogItem {
  id: string; sku: string; nameEn: string; nameTa: string | null; hsn: string | null; gstBp: number;
  categoryEn: string; categoryTa: string | null;
  baseUnit: string; baseUnitEn: string; baseUnitTa: string | null; trackStock: boolean; attrs: Record<string, unknown>;
  units: CatalogUnit[]; ratePaise: number; rateSource: string; rateGroup: string | null; stockMilli: number | null; minStockMilli: number;
}
export interface Party {
  id: string; party_type: string; name_en: string; name_ta: string | null; mobile: string | null; gstin: string | null;
  state_code: string; credit_limit_paise: number; credit_days: number; balance_paise: number; lang: string | null; is_walk_in: number; active?: number;
}
export interface RateGroup {
  code: string; name_en: string; name_ta: string | null; show_on_topbar: number; unit_code: string | null; unit_en: string | null; unit_ta: string | null;
  rate_paise: number | null; rate_date: string | null;
}
export interface SettingsState { values: Record<string, string>; missingForBilling: string[]; issues: string[] }
export interface SettingsSchema {
  settings: Array<{ key: string; group: string; default: string; requiredForBilling?: boolean; kind: { type: string; values?: string[]; max?: number } }>;
  languages: string[];
  states: Array<{ code: string; name: string; name_ta: string }>;
}
export interface Totals { taxable: number; cgst: number; sgst: number; igst: number; beforeRoundOff: number; roundOff: number; total: number }
/** `message` is English; show it with warningText() (server-text.ts), which writes it from code + params. */
export interface Warning { code: string; message: string; productId?: string; thresholdPaise?: number; params?: Record<string, string | number> }
export interface Preview {
  supply: 'intra' | 'inter'; docKind: 'tax_invoice' | 'bill_of_supply'; lang: string; totals: Totals; balanceBefore: number; warnings: Warning[]; blocked: boolean;
  lines: Array<{ lineNo: number; productId: string; baseQtyMilli: number; rateQtyMilli: number; ratePaise: number; inclusive: boolean; rateSource: string; taxable: number; total: number }>;
}
export interface BillLineInput { productId: string; entry: Record<string, string>; rate?: string; discount?: string }
export interface BillInput {
  partyId: string; site?: string; vehicleNo?: string; lang?: string; lines: BillLineInput[];
  payment?: { mode: 'cash' | 'upi' | 'bank' | 'cheque'; amount: string }; confirmWarnings?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

/** Called whenever the server says the session is gone, so the app can show the sign-in screen. */
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };

export type Role = 'owner' | 'billing' | 'viewer';
export interface Me { id: string; name: string; role: Role; lang: string | null; mustChangePin: boolean }
export interface UserRow { id: string; name: string; role: Role; lang: string | null; active: number; pin_set: number }
export interface Category { id: string; name_en: string; name_ta: string | null; is_service: number; sort_order: number }
export interface Unit { id: string; code: string; name_en: string; name_ta: string | null; gst_uqc: string | null }
export interface RateGroupRow { id: string; code: string; name_en: string; name_ta: string | null; show_on_topbar: number; unit: string | null }
export interface ProductRow {
  id: string; sku: string; name_en: string; name_ta: string | null; brand: string | null; hsn: string | null; gst_bp: number; active: number;
  track_stock: number; rate_mode: 'fixed' | 'daily'; rate_group: string | null; rate_extra_paise: number; sale_rate_paise: number;
  base_unit: string; category_en: string; category_ta: string | null; stock_milli: number;
}
export interface ProductDetail extends ProductRow {
  category_id: string; min_stock_milli: number; attrs: Record<string, unknown>;
  units: Array<{ unit: string; factor_milli: number; on_bill: number; is_theoretical: number }>;
}
export interface ProductInput {
  sku: string; name_en: string; name_ta?: string | null; categoryId: string; brand?: string | null; hsn?: string | null; gst: string;
  baseUnit: string; trackStock: boolean; minStock?: string; rateMode: 'fixed' | 'daily'; rateGroup?: string | null; rateExtra?: string;
  saleRate?: string; active: boolean; units: Array<{ unit: string; factor: string; onBill: boolean; theoretical: boolean }>;
}
export interface PartyDetail {
  id: string; party_type: 'customer' | 'supplier' | 'both'; name_en: string; name_ta: string | null; mobile: string | null; address: string | null;
  gstin: string | null; state_code: string; credit_limit_paise: number; credit_days: number; lang: string | null; active: number; is_walk_in: number;
  opening_balance_paise: number; balance_paise: number;
  rates: Array<{ product_id: string; sku: string; name_en: string; name_ta: string | null; rate_paise: number | null; adjust_paise: number | null }>;
}
export interface PartyInput {
  partyType: 'customer' | 'supplier' | 'both'; name_en: string; name_ta?: string | null; mobile?: string | null; address?: string | null;
  gstin?: string | null; stateCode?: string | null; creditLimit?: string; creditDays?: number | null; lang?: string | null;
  openingBalance?: string; active: boolean;
}
export interface OpeningRow { product_id: string; sku: string; name_en: string; name_ta: string | null; base_unit: string; qty_milli: number; cost_paise: number | null }

export async function req<T>(method: string, url: string, body?: unknown, allow409 = false): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('network', 0, 'NETWORK');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !url.startsWith('/api/auth/login')) onSignedOut();
  if (!res.ok && !(allow409 && res.status === 409 && (data as { saved?: boolean })?.saved === false)) {
    const d = data as { message?: string; error?: string } | null;
    throw new ApiError(d?.message ? errorText(d.error, d.message) : res.statusText, res.status, d?.error);
  }
  return data as T;
}

export const api = {
  publicInfo: () => req<{ name_en: string; name_ta: string; languages: string[]; defaultLang: string }>('GET', '/api/public'),
  loginUsers: () => req<Array<{ id: string; name: string; role: Role; lang: string | null }>>('GET', '/api/auth/users'),
  login: (userId: string, pin: string) => req<{ user: Me }>('POST', '/api/auth/login', { userId, pin }),
  logout: () => req('POST', '/api/auth/logout', {}),
  me: () => req<{ user: Me }>('GET', '/api/auth/me'),
  changePin: (currentPin: string, newPin: string) => req('POST', '/api/auth/pin', { currentPin, newPin }),
  users: () => req<UserRow[]>('GET', '/api/users'),
  addUser: (u: { name: string; role: Role; pin: string; lang?: string | null }) => req<{ id: string }>('POST', '/api/users', u),
  updateUser: (id: string, u: Partial<{ name: string; role: Role; pin: string; active: boolean; lang: string | null }>) => req('PUT', `/api/users/${id}`, u),
  categories: () => req<Category[]>('GET', '/api/categories'),
  addCategory: (c: { name_en: string; name_ta?: string | null; isService: boolean }) => req<{ id: string }>('POST', '/api/categories', c),
  units: () => req<Unit[]>('GET', '/api/units'),
  rateGroups: () => req<RateGroupRow[]>('GET', '/api/rate-groups'),
  products: () => req<ProductRow[]>('GET', '/api/products'),
  product: (id: string) => req<ProductDetail>('GET', `/api/products/${id}`),
  saveProduct: (p: ProductInput, id?: string) => (id ? req<{ ok: boolean }>('PUT', `/api/products/${id}`, p) : req<{ id: string }>('POST', '/api/products', p)),
  party: (id: string) => req<PartyDetail>('GET', `/api/parties/${id}`),
  saveParty: (p: PartyInput, id?: string) => (id ? req<{ ok: boolean }>('PUT', `/api/parties/${id}`, p) : req<{ id: string }>('POST', '/api/parties', p)),
  savePartyRates: (id: string, rates: Array<{ productId: string; rate?: string; adjust?: string }>) => req('PUT', `/api/parties/${id}/rates`, { rates }),
  opening: () => req<OpeningRow[]>('GET', '/api/stock/opening'),
  saveOpening: (lines: Array<{ productId: string; qty: string; cost: string }>) => req<{ items: number }>('PUT', '/api/stock/opening', { lines }),
  settings: () => req<SettingsState>('GET', '/api/settings'),
  settingsSchema: () => req<SettingsSchema>('GET', '/api/settings/schema'),
  saveSettings: (values: Record<string, string>) => req<SettingsState>('PUT', '/api/settings', values),
  catalog: () => req<CatalogItem[]>('GET', '/api/catalog'),
  parties: () => req<Party[]>('GET', '/api/parties'),
  partiesAll: () => req<Party[]>('GET', '/api/parties?all=1'),
  rates: () => req<RateGroup[]>('GET', '/api/rates'),
  setRate: (group: string, rate: string) => req('PUT', `/api/rates/${group}`, { rate }),
  preview: (b: BillInput) => req<Preview>('POST', '/api/bills/preview', b),
  saveBill: (b: BillInput) => req<{ saved: boolean; blocked?: boolean; id?: string; docNo?: string; total?: number; warnings: Warning[] }>('POST', '/api/bills', b, true),
  bills: () => req<Array<{ id: string; doc_no: string; doc_date: string; party_name: string; site: string | null; total_paise: number; balance_paise: number; status: string }>>('GET', '/api/bills'),
  bill: (id: string) => req<BillDetail>('GET', `/api/bills/${id}`),
};

export interface BillDetail {
  doc: {
    id: string; doc_no: string; doc_date: string; doc_kind: 'tax_invoice' | 'bill_of_supply'; party_name: string; party_gstin: string | null;
    party_address: string | null; place_of_supply: string; supply_type: 'intra' | 'inter'; site: string | null; vehicle_no: string | null; eway_bill_no: string | null; lang: string;
    taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; round_off_paise: number; total_paise: number; status: string;
  };
  lines: Array<{
    line_no: number; description: string; hsn: string | null; entry_json: Record<string, string>; base_qty_milli: number;
    rate_qty_milli: number; rate_unit_code: string; rate_unit_en: string; rate_unit_ta: string | null; rate_paise: number; rate_inclusive: number;
    discount_paise: number; taxable_paise: number; gst_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number; line_total_paise: number;
  }>;
  party: { name_en: string; name_ta: string | null; mobile: string | null; gstin: string | null; address: string | null; state_code: string; is_walk_in: number } | null;
  units: Array<{ code: string; name_en: string; name_ta: string | null }>;
  paidPaise: number;
  settings: Record<string, string>;
}
