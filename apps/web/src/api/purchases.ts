import { todayIST } from '@tula/core';
import { req } from '../api';

export type PayMode = 'cash' | 'upi' | 'bank' | 'cheque';
export type ExpenseMode = PayMode | 'credit';
export const PAY_MODES: PayMode[] = ['cash', 'upi', 'bank', 'cheque'];
export const EXPENSE_MODES: ExpenseMode[] = ['cash', 'upi', 'bank', 'cheque', 'credit'];
export const ADJ_REASONS = ['weight_diff', 'scrap', 'damage', 'count', 'other'] as const;
export type AdjReason = (typeof ADJ_REASONS)[number];
/** GST rates offered in the pickers (percent); the server accepts the same list as items. */
export const GST_CHOICES = ['0', '5', '12', '18', '28'];

// ---------- Purchases ----------
export interface PurchaseLineInput { productId: string; entry: Record<string, string>; rate: string; discount?: string; gst?: string }
export interface PurchaseInput {
  supplierId: string; supplierBillNo: string; date?: string; lines: PurchaseLineInput[];
  charges?: Array<{ description: string; amount: string; gst?: string }>;
  ratesIncludeGst?: boolean; itcEligible?: boolean; payment?: { mode: PayMode; amount: string; reference?: string }; notes?: string;
}
export interface PurchasePreview {
  supply: 'intra' | 'inter'; itc: boolean; itcPossible: boolean; inclusive: boolean; dueDate: string; paid: number; supplierGstin: string | null;
  totals: { taxable: number; cgst: number; sgst: number; igst: number; beforeRoundOff: number; roundOff: number; total: number; chargesPaise: number };
  lines: Array<{ lineNo: number; productId: string; baseQtyMilli: number; ratePaise: number; gstBp: number; taxable: number; cgst: number; sgst: number; igst: number; total: number; chargeShare: number; landed: number; landedPerBase: number }>;
  charges: Array<{ description: string; taxable: number; gstBp: number; tax: number; total: number }>;
}
export interface PurchaseRow {
  id: string; doc_type: 'PUR' | 'DN'; doc_no: string; supplier_bill_no: string | null; doc_date: string; due_date: string | null; party_id: string;
  party_en: string; party_ta: string | null; taxable_paise: number; tax_paise: number; total_paise: number; itc_eligible: number;
  status: 'active' | 'cancelled'; cancel_reason: string | null; ref_doc_no: string | null; due_paise: number;
}
export interface PurchaseDetail {
  doc: PurchaseRow & { supply_type: 'intra' | 'inter'; cgst_paise: number; sgst_paise: number; igst_paise: number; round_off_paise: number; notes: string | null; party_gstin: string | null; ref_doc_id: string | null };
  lines: Array<{
    id: string; line_no: number; product_id: string | null; description: string; sku: string | null; name_en: string | null; name_ta: string | null;
    base_unit: string | null; base_unit_en: string | null; base_unit_ta: string | null; entry_json: Record<string, string> | null;
    base_qty_milli: number; rate_paise: number; taxable_paise: number; gst_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number;
    line_total_paise: number; landed_cost_paise: number | null; charge_share_paise: number; returned_milli: number; remaining_milli: number;
  }>;
  payments: Array<{ id: string; doc_no: string; doc_date: string; mode: PayMode; amount_paise: number }>;
  returns: Array<{ id: string; doc_no: string; doc_date: string; total_paise: number; status: string; notes: string | null }>;
}
export interface Warning { code: string; message: string; productId?: string }

// ---------- Payments ----------
export interface PaymentInput { supplierId: string; amount: string; mode: PayMode; date?: string; reference?: string; notes?: string; allocations?: Array<{ purchaseId: string; amount: string }> }
export interface OpenBill { id: string; doc_no: string; supplier_bill_no: string | null; doc_date: string; due_date: string | null; total_paise: number; due_paise: number }
export interface PaymentPreview {
  amountPaise: number; advancePaise: number; owedBefore: number; owedAfter: number; openBills: OpenBill[];
  allocations: Array<{ purchaseId: string; amountPaise: number; docNo: string; supplierBillNo: string | null; dueBefore: number }>;
}
export interface PaymentRow {
  id: string; doc_no: string; doc_date: string; party_id: string; party_en: string; party_ta: string | null; amount_paise: number; mode: PayMode;
  reference: string | null; notes: string | null; status: 'active' | 'cancelled'; allocated_paise: number; bills: string | null;
}
export interface Payables {
  today: string; totals: { owedPaise: number; overduePaise: number; dueSoonPaise: number };
  suppliers: Array<{ id: string; name_en: string; name_ta: string | null; mobile: string | null; owedPaise: number; overduePaise: number; dueSoonPaise: number; onAccountPaise: number;
    bills: Array<OpenBill & { overdueDays: number; state: 'overdue' | 'soon' | 'later' }> }>;
}

// ---------- Expenses ----------
export interface ExpenseHead { id: string; name_en: string; name_ta: string | null }
export interface ExpenseInput {
  date?: string; headId: string; amount: string; amountIncludesGst?: boolean; gst?: string; vendorGstin?: string | null; itcEligible?: boolean;
  mode: ExpenseMode; partyId?: string | null; reference?: string; notes?: string;
}
export interface ExpensePreview { taxable: number; cgst: number; sgst: number; igst: number; total: number; itc: boolean; cost: number; supply: 'intra' | 'inter'; vendorGstin: string | null }
export interface ExpenseRow {
  id: string; doc_no: string; doc_date: string; head_id: string; head_en: string; head_ta: string | null; party_id: string | null; party_en: string | null; party_ta: string | null;
  vendor_gstin: string | null; taxable_paise: number; gst_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number;
  itc_eligible: number; mode: ExpenseMode; reference: string | null; notes: string | null; status: 'active' | 'cancelled'; cancel_reason: string | null;
}
export interface ExpenseList {
  from: string; to: string; rows: ExpenseRow[]; totalPaise: number; costPaise: number;
  byHead: Array<{ headId: string; name_en: string; name_ta: string | null; count: number; totalPaise: number; costPaise: number; itcPaise: number }>;
}

// ---------- Stock ----------
export type QtyEntry = string | Record<string, string>;
export interface AdjustmentInput { date?: string; reason: AdjReason; notes?: string; lines: Array<{ productId: string; change?: QtyEntry; counted?: QtyEntry }> }
export interface AdjustmentRow {
  id: string; doc_no: string; doc_date: string; reason: AdjReason; notes: string | null; approved_by_name: string | null; value_paise: number;
  lines: Array<{ product_id: string; sku: string; name_en: string; name_ta: string | null; base_unit: string; base_unit_en: string; base_unit_ta: string | null;
    qty_milli: number; system_milli: number | null; counted_milli: number | null; cost_per_base_paise: number; value_paise: number }>;
}
export interface Valuation { totalPaise: number; items: Array<{ product_id: string; sku: string; qty_milli: number; avg_cost_paise: number; value_paise: number }> }
export interface StockLedger {
  product: { id: string; sku: string; name_en: string; name_ta: string | null; base_unit: string; base_unit_en: string; base_unit_ta: string | null };
  openingMilli: number; closingMilli: number; avgCostPaise: number; valuePaise: number;
  rows: Array<{ id: string; date: string; type: 'OPENING' | 'INV' | 'CN' | 'PUR' | 'DN' | 'ADJ'; sourceId: string; docNo: string | null; partyEn: string | null; partyTa: string | null;
    reason: string | null; inMilli: number; outMilli: number; balanceMilli: number; valuePaise: number | null }>;
}

const range = (from?: string, to?: string) => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const purchasesApi = {
  preview: (b: PurchaseInput) => req<PurchasePreview>('POST', '/api/purchases/preview', b),
  save: (b: PurchaseInput) => req<{ id: string; docNo: string; paymentNo: string | null; total: number; dueDate: string }>('POST', '/api/purchases', b),
  list: (from?: string, to?: string) => req<{ from: string; to: string; rows: PurchaseRow[] }>('GET', `/api/purchases${range(from, to)}`),
  get: (id: string) => req<PurchaseDetail>('GET', `/api/purchases/${id}`),
  cancel: (id: string, reason: string, confirmWarnings = false) =>
    req<{ saved: boolean; warnings: Warning[] }>('POST', `/api/purchases/${id}/cancel`, { reason, confirmWarnings }, true),
  returnGoods: (id: string, reason: string, lines: Array<{ lineId: string; qty: string }>, date?: string) =>
    req<{ id: string; docNo: string; total: number }>('POST', `/api/purchases/${id}/return`, { reason, lines, date }),

  paymentPreview: (b: PaymentInput) => req<PaymentPreview>('POST', '/api/supplier-payments/preview', b),
  pay: (b: PaymentInput) => req<{ id: string; docNo: string; advancePaise: number }>('POST', '/api/supplier-payments', b),
  payments: (from?: string, to?: string) => req<{ from: string; to: string; rows: PaymentRow[] }>('GET', `/api/supplier-payments${range(from, to)}`),
  cancelPayment: (id: string, reason: string) => req<{ ok: boolean }>('POST', `/api/supplier-payments/${id}/cancel`, { reason }),
  payables: () => req<Payables>('GET', '/api/payables'),

  heads: () => req<ExpenseHead[]>('GET', '/api/expense-heads'),
  addHead: (h: { name_en: string; name_ta?: string | null }) => req<{ id: string }>('POST', '/api/expense-heads', h),
  updateHead: (id: string, h: { name_en: string; name_ta?: string | null }) => req<{ ok: boolean }>('PUT', `/api/expense-heads/${id}`, h),
  expensePreview: (b: ExpenseInput) => req<ExpensePreview>('POST', '/api/expenses/preview', b),
  saveExpense: (b: ExpenseInput) => req<{ id: string; docNo: string; total: number; itc: boolean }>('POST', '/api/expenses', b),
  expenses: (from?: string, to?: string) => req<ExpenseList>('GET', `/api/expenses${range(from, to)}`),
  cancelExpense: (id: string, reason: string) => req<{ ok: boolean }>('POST', `/api/expenses/${id}/cancel`, { reason }),

  saveAdjustment: (b: AdjustmentInput) => req<{ id: string; docNo: string; valuePaise: number }>('POST', '/api/stock/adjustments', b),
  adjustments: (from?: string, to?: string) => req<{ from: string; to: string; rows: AdjustmentRow[] }>('GET', `/api/stock/adjustments${range(from, to)}`),
  valuation: () => req<Valuation>('GET', '/api/stock/valuation'),
  ledger: (productId: string) => req<StockLedger>('GET', `/api/stock/${productId}/ledger`),
};

// ---------- Small display helpers ----------
/** '2026-10-25' → '25-10-2026' */
export const showDate = (d: string | null | undefined) => (d ? d.split('-').reverse().join('-') : '');

export const today = () => todayIST();
export function daysAgo(n: number): string {
  return new Date(Date.parse(todayIST()) - n * 86400_000).toISOString().slice(0, 10);
}
/** Keep digits and one dot; optionally a leading minus. */
export const cleanNum = (v: string, signed = false) => {
  const s = v.replace(signed ? /[^\d.-]/g : /[^\d.]/g, '');
  return signed ? s.replace(/(?!^)-/g, '') : s;
};
