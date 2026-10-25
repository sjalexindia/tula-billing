export interface CatalogUnit { code: string; nameEn: string; nameTa: string | null; factorMilli: number; theoretical: boolean; onBill: boolean }
export interface CatalogItem {
  id: string; sku: string; nameEn: string; nameTa: string | null; hsn: string | null; gstBp: number;
  categoryEn: string; categoryTa: string | null;
  baseUnit: string; baseUnitEn: string; baseUnitTa: string | null; trackStock: boolean; attrs: Record<string, unknown>;
  units: CatalogUnit[]; ratePaise: number; rateSource: string; rateGroup: string | null; stockMilli: number | null; minStockMilli: number;
}
export interface Party {
  id: string; party_type: string; name_en: string; name_ta: string | null; mobile: string | null; gstin: string | null;
  state_code: string; credit_limit_paise: number; credit_days: number; balance_paise: number; lang: string | null; is_walk_in: number;
}
export interface RateGroup {
  code: string; name_en: string; name_ta: string | null; show_on_topbar: number; unit_code: string | null; unit_en: string | null; unit_ta: string | null;
  rate_paise: number | null; rate_date: string | null;
}
export interface SettingsState { values: Record<string, string>; missingForBilling: string[]; issues: string[] }
export interface SettingsSchema {
  settings: Array<{ key: string; group: string; default: string; requiredForBilling?: boolean; kind: { type: string; values?: string[]; max?: number } }>;
  languages: string[];
  states: Array<{ code: string; name: string }>;
}
export interface Totals { taxable: number; cgst: number; sgst: number; igst: number; beforeRoundOff: number; roundOff: number; total: number }
export interface Warning { code: string; message: string; productId?: string; thresholdPaise?: number }
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

async function req<T>(method: string, url: string, body?: unknown, allow409 = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('network', 0, 'NETWORK');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok && !(allow409 && res.status === 409 && (data as { saved?: boolean })?.saved === false)) {
    const d = data as { message?: string; error?: string } | null;
    throw new ApiError(d?.message ?? res.statusText, res.status, d?.error);
  }
  return data as T;
}

export const api = {
  settings: () => req<SettingsState>('GET', '/api/settings'),
  settingsSchema: () => req<SettingsSchema>('GET', '/api/settings/schema'),
  saveSettings: (values: Record<string, string>) => req<SettingsState>('PUT', '/api/settings', values),
  catalog: () => req<CatalogItem[]>('GET', '/api/catalog'),
  parties: () => req<Party[]>('GET', '/api/parties'),
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
