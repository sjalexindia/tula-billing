import { all, type Exec } from '@tula/db';
import { businessOf, n, sumRows, type Col, type Report, type Row } from './common';
import { posLabel } from './xlsx';

const MONEY = ['taxable', 'cgst', 'sgst', 'igst', 'round_off', 'total'];

/** R-02 Sales register: one row per invoice / credit note (negative). Cancelled invoices listed, not totalled. */
export async function salesRegister(ex: Exec, from: string, to: string): Promise<Report> {
  const { business } = await businessOf(ex);
  const docs = await all<Record<string, unknown>>(ex, `
    SELECT d.*, r.doc_no AS ref_no FROM sales_docs d LEFT JOIN sales_docs r ON r.id = d.ref_doc_id
    WHERE d.deleted = 0 AND d.doc_type IN ('INV','CN') AND d.doc_date BETWEEN ? AND ?
    ORDER BY d.doc_date, d.created_at, d.doc_no`, [from, to]);
  const rows: Row[] = docs.map((d) => {
    const s = d.doc_type === 'CN' ? -1 : 1;
    return {
      date: d.doc_date, type: d.doc_type, doc_no: d.doc_no, ref_no: d.ref_no ?? '', party: d.party_name, gstin: d.party_gstin ?? '',
      pos: posLabel(String(d.place_of_supply)), taxable: s * n(d.taxable_paise), cgst: s * n(d.cgst_paise), sgst: s * n(d.sgst_paise),
      igst: s * n(d.igst_paise), round_off: s * n(d.round_off_paise), total: s * n(d.total_paise), status: d.status,
      _cancelled: d.status === 'cancelled',
    };
  });
  const cols: Col[] = [
    { key: 'date', type: 'date', header: 'Date' },
    { key: 'type', type: 'code', header: 'Type', width: 7, translate: true },
    { key: 'doc_no', type: 'code', header: 'Number', width: 17 },
    { key: 'ref_no', type: 'code', header: 'Against bill', width: 17 },
    { key: 'party', type: 'text', header: 'Customer', width: 28 },
    { key: 'gstin', type: 'code', header: 'GSTIN', width: 17 },
    { key: 'pos', type: 'text', header: 'Place of supply', width: 18 },
    { key: 'taxable', type: 'money', header: 'Taxable value' },
    { key: 'cgst', type: 'money', header: 'CGST' },
    { key: 'sgst', type: 'money', header: 'SGST' },
    { key: 'igst', type: 'money', header: 'IGST' },
    { key: 'round_off', type: 'money', header: 'Round off', width: 11 },
    { key: 'total', type: 'money', header: 'Total' },
  ];
  return {
    id: 'sales-register', title: 'Sales register', from, to, business,
    tables: [{ id: 'sales', title: 'Sales register', columns: cols, rows, totals: sumRows(rows, MONEY) }],
    notes: ['creditNotesNegative', 'cancelledNotTotalled'],
  };
}

/** R-02 Purchase register: purchase bills and debit notes (negative), with the ITC flag. */
export async function purchaseRegister(ex: Exec, from: string, to: string): Promise<Report> {
  const { business } = await businessOf(ex);
  const docs = await all<Record<string, unknown>>(ex, `
    SELECT d.*, p.name_en AS party_name, p.gstin AS party_gstin, p.state_code AS party_state, r.doc_no AS ref_no
    FROM purchase_docs d LEFT JOIN parties p ON p.id = d.party_id LEFT JOIN purchase_docs r ON r.id = d.ref_doc_id
    WHERE d.deleted = 0 AND d.doc_date BETWEEN ? AND ?
    ORDER BY d.doc_date, d.created_at, d.doc_no`, [from, to]);
  const rows: Row[] = docs.map((d) => {
    const s = d.doc_type === 'DN' ? -1 : 1;
    return {
      date: d.doc_date, type: d.doc_type, doc_no: d.doc_no, supplier_bill_no: d.supplier_bill_no ?? '', ref_no: d.ref_no ?? '',
      party: d.party_name ?? '', gstin: d.party_gstin ?? '', pos: posLabel(String(d.party_state ?? '')),
      taxable: s * n(d.taxable_paise), cgst: s * n(d.cgst_paise), sgst: s * n(d.sgst_paise), igst: s * n(d.igst_paise),
      round_off: s * n(d.round_off_paise), total: s * n(d.total_paise), itc: n(d.itc_eligible) ? 'yes' : 'no',
      status: d.status, _cancelled: d.status === 'cancelled',
    };
  });
  const cols: Col[] = [
    { key: 'date', type: 'date', header: 'Date' },
    { key: 'type', type: 'code', header: 'Type', width: 7, translate: true },
    { key: 'doc_no', type: 'code', header: 'Our number', width: 15 },
    { key: 'supplier_bill_no', type: 'code', header: 'Supplier bill no.', width: 16 },
    { key: 'ref_no', type: 'code', header: 'Against bill', width: 15 },
    { key: 'party', type: 'text', header: 'Supplier', width: 28 },
    { key: 'gstin', type: 'code', header: 'GSTIN', width: 17 },
    { key: 'pos', type: 'text', header: 'Supplier state', width: 16 },
    { key: 'taxable', type: 'money', header: 'Taxable value' },
    { key: 'cgst', type: 'money', header: 'CGST' },
    { key: 'sgst', type: 'money', header: 'SGST' },
    { key: 'igst', type: 'money', header: 'IGST' },
    { key: 'round_off', type: 'money', header: 'Round off', width: 11 },
    { key: 'total', type: 'money', header: 'Total' },
    { key: 'itc', type: 'code', header: 'ITC eligible', width: 9, translate: true },
  ];
  return {
    id: 'purchase-register', title: 'Purchase register', from, to, business,
    tables: [{ id: 'purchases', title: 'Purchase register', columns: cols, rows, totals: sumRows(rows, MONEY) }],
    notes: ['creditNotesNegative', 'cancelledNotTotalled'],
  };
}
