import { req } from '../api';

export type Mode = 'cash' | 'upi' | 'bank' | 'cheque';
export const MODES: Mode[] = ['cash', 'upi', 'bank', 'cheque'];

export interface RegisterRow {
  id: string; docNo: string; date: string; partyId: string; partyName: string; name_en: string; name_ta: string | null; site: string | null;
  totalPaise: number; paidPaise: number; returnedPaise: number; balancePaise: number; status: 'active' | 'cancelled'; cancelReason: string | null;
  state: 'cancelled' | 'paid' | 'part_paid' | 'unpaid'; returned: boolean; earlierMonth: boolean;
  creditNotes: Array<{ id: string; docNo: string; date: string; totalPaise: number }>;
}

export interface OpenBill {
  id: string; docNo: string; date: string; totalPaise: number; paidPaise: number; returnedPaise: number; balancePaise: number;
  daysOld: number; dueDate: string; overdueDays: number;
}
export interface OpenBills {
  party: { id: string; name_en: string; name_ta: string | null; mobile: string | null; lang: string | null };
  creditDays: number; bills: OpenBill[]; openingDuePaise: number; openingDate: string; advancePaise: number; balancePaise: number;
}

export interface ReceiptInput { partyId: string; date?: string; amount: string; mode: Mode; reference?: string; allocations?: Array<{ billId: string; amount: string }> }
export interface ReceiptPreview {
  amountPaise: number; toOpeningPaise: number; advancePaise: number; advanceBeforePaise: number; openingDuePaise: number;
  balanceBeforePaise: number; balanceAfterPaise: number; allocations: Array<{ billId: string; docNo: string; amountPaise: number }>; openBills: OpenBill[];
}
export interface ReceiptRow {
  id: string; doc_no: string; doc_date: string; party_id: string; name_en: string; name_ta: string | null; amount_paise: number; mode: Mode;
  reference: string | null; status: 'active' | 'cancelled'; notes: string | null; allocated_paise: number; bills: string | null;
}
export interface ReceiptDetail {
  receipt: {
    id: string; doc_no: string; doc_date: string; amount_paise: number; mode: Mode; reference: string | null; status: string; notes: string | null;
    name_en: string; name_ta: string | null; mobile: string | null; address: string | null; gstin: string | null; lang: string | null; created_by_name: string | null;
  };
  allocations: Array<{ amount_paise: number; bill_id: string; doc_no: string; doc_date: string; total_paise: number }>;
  balanceNowPaise: number; settings: Record<string, string>;
}

export interface ReturnableLine {
  lineId: string; lineNo: number; description: string; rateUnit: string; rateUnitEn: string; rateUnitTa: string | null; ratePaise: number;
  inclusive: boolean; gstBp: number; lineTotalPaise: number; soldMilli: number; returnedMilli: number; returnableMilli: number;
}
export interface Returnable {
  bill: { id: string; docNo: string; date: string; status: string; totalPaise: number };
  creditNotes: Array<{ id: string; doc_no: string; doc_date: string; total_paise: number }>; lines: ReturnableLine[];
}
export interface ReturnInput { lines: Array<{ lineId: string; qty: string }>; reason: string; refund?: { mode: Mode; amount: string } }
export interface ReturnPreview {
  totals: { taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number };
  refundablePaise: number; billBalanceBeforePaise: number; billBalanceAfterPaise: number;
  lines: Array<{ lineId: string; rateQtyMilli: number; total: number }>;
}

export type BucketKey = 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus';
export const BUCKETS: BucketKey[] = ['d0_30', 'd31_60', 'd61_90', 'd90_plus'];
export interface OutstandingRow {
  partyId: string; name_en: string; name_ta: string | null; mobile: string | null; lang: string | null; creditDays: number; balancePaise: number;
  overduePaise: number; buckets: Record<BucketKey, number>; advancePaise: number; interestPaise: number; lastPaymentDate: string | null;
  oldestDays: number; openBills: number;
}
export interface Outstanding {
  today: string; interestPa: string; rows: OutstandingRow[];
  totals: { balancePaise: number; overduePaise: number; interestPaise: number; advancePaise: number; buckets: Record<BucketKey, number> };
}

export interface StatementLine {
  date: string; kind: string; sourceId: string; docNo: string | null; detail: string | null; debitPaise: number; creditPaise: number; balancePaise: number;
}
export interface Statement {
  party: { id: string; name_en: string; name_ta: string | null; mobile: string | null; lang: string | null; address: string | null; gstin: string | null };
  from: string; to: string; lang: string; openingPaise: number; closingPaise: number; balanceTodayPaise: number; lines: StatementLine[];
  totals: { debitPaise: number; creditPaise: number }; settings: Record<string, string>;
}

export interface DocLinks {
  docType: 'INV' | 'CN' | 'QT'; ref: { id: string; doc_no: string; doc_date: string } | null;
  creditNotes: Array<{ id: string; doc_no: string; doc_date: string; total_paise: number }>; returnedPaise: number; refundedPaise: number; reason: string | null;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1]));
  return p.toString() ? `?${p}` : '';
};

export const sales = {
  register: (from: string, to: string, q: string) => req<RegisterRow[]>('GET', `/api/sales/bills${qs({ from, to, q: q.trim() || undefined })}`),
  cancelCheck: (id: string) => req<{ canCancel: boolean; blocker: { code: string; message: string } | null; earlierMonth: boolean; docNo: string; date: string }>('GET', `/api/bills/${id}/cancel-check`),
  cancelBill: (id: string, reason: string) => req<{ docNo: string; earlierMonth: boolean; advanceFreedPaise: number }>('POST', `/api/bills/${id}/cancel`, { reason }),
  returnable: (id: string) => req<Returnable>('GET', `/api/bills/${id}/returnable`),
  returnPreview: (id: string, b: ReturnInput) => req<ReturnPreview>('POST', `/api/bills/${id}/return/preview`, b),
  saveReturn: (id: string, b: ReturnInput) => req<ReturnPreview & { id: string; docNo: string; refundNo: string | null }>('POST', `/api/bills/${id}/return`, b),
  links: (id: string) => req<DocLinks>('GET', `/api/sales-docs/${id}/links`),
  receipts: (from: string, to: string) => req<ReceiptRow[]>('GET', `/api/receipts${qs({ from, to })}`),
  receipt: (id: string) => req<ReceiptDetail>('GET', `/api/receipts/${id}`),
  receiptPreview: (b: ReceiptInput) => req<ReceiptPreview>('POST', '/api/receipts/preview', b),
  saveReceipt: (b: ReceiptInput) => req<ReceiptPreview & { id: string; docNo: string }>('POST', '/api/receipts', b),
  cancelReceipt: (id: string, reason: string) => req<{ docNo: string }>('POST', `/api/receipts/${id}/cancel`, { reason }),
  openBills: (partyId: string) => req<OpenBills>('GET', `/api/parties/${partyId}/open-bills`),
  applyAdvance: (partyId: string) => req<{ appliedPaise: number }>('POST', `/api/parties/${partyId}/apply-advance`, {}),
  outstanding: () => req<Outstanding>('GET', '/api/outstanding'),
  statement: (partyId: string, from: string, to: string) => req<Statement>('GET', `/api/parties/${partyId}/statement${qs({ from, to })}`),
};

// ---------- small helpers shared by the sales screens ----------

/** Today in India, as YYYY-MM-DD (the shop's calendar, whatever the computer's zone). */
export const todayLocal = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const monthStartOf = (d: string) => `${d.slice(0, 7)}-01`;
export const fyStartOf = (d: string) => (Number(d.slice(5, 7)) >= 4 ? `${d.slice(0, 4)}-04-01` : `${Number(d.slice(0, 4)) - 1}-04-01`);
/** 2026-10-25 -> 25-10-2026 */
export const dmy = (d: string | null | undefined) => (d ? d.split('-').reverse().join('-') : '');
/** paise -> "1234.50" for an input box */
export const rupeesText = (p: number) => (p / 100).toFixed(2);

/** WhatsApp click-to-chat link for an Indian mobile number; null when the number is unusable. */
export function whatsappLink(mobile: string | null | undefined, text: string): string | null {
  const digits = (mobile ?? '').replace(/\D/g, '');
  const ten = digits.length >= 10 ? digits.slice(-10) : '';
  if (!/^[6-9]\d{9}$/.test(ten)) return null;
  return `https://wa.me/91${ten}?text=${encodeURIComponent(text)}`;
}
