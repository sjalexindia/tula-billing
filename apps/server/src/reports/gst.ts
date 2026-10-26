import { roundDiv, stateName } from '@tula/core';
import { all, type Exec } from '@tula/db';
import { businessOf, n, posLabel, type Col, type ColType, type Report, type Row, type Table } from './common';

/**
 * B2C (Large) threshold: inter-state invoices to unregistered buyers above this value are reported invoice-wise.
 * ₹2,50,000 until 31 Jul 2024; ₹1,00,000 from 1 Aug 2024 (Notification 12/2024-Central Tax, 10 Jul 2024).
 */
export function b2clLimitPaise(date: string): number {
  return date >= '2024-08-01' ? 1_00_000_00 : 2_50_000_00;
}

interface Line { doc_id: string; gst_bp: number; taxable: number; cgst: number; sgst: number; igst: number; hsn: string; uqc: string; qty: number; product: string }
interface Doc {
  id: string; doc_type: 'INV' | 'CN'; doc_no: string; doc_date: string; party_name: string; legal_name: string; gstin: string;
  pos: string; supply: 'intra' | 'inter'; total: number; taxable: number; cgst: number; sgst: number; igst: number; status: string;
  ref_doc_id: string | null; ref_no: string | null; ref_date: string | null; ref_total: number; ref_supply: string | null; ref_gstin: string;
  lines: Line[];
}

async function loadSales(ex: Exec, from: string, to: string): Promise<Doc[]> {
  const docs = await all<Record<string, unknown>>(ex, `
    SELECT d.id, d.doc_type, d.doc_no, d.doc_date, d.party_name, p.name_en AS legal_name, TRIM(COALESCE(d.party_gstin, '')) AS gstin,
      d.place_of_supply AS pos, d.supply_type AS supply, d.total_paise AS total, d.taxable_paise AS taxable, d.cgst_paise AS cgst,
      d.sgst_paise AS sgst, d.igst_paise AS igst, d.status, d.ref_doc_id, r.doc_no AS ref_no, r.doc_date AS ref_date, r.total_paise AS ref_total,
      r.supply_type AS ref_supply, TRIM(COALESCE(r.party_gstin, '')) AS ref_gstin
    FROM sales_docs d LEFT JOIN parties p ON p.id = d.party_id LEFT JOIN sales_docs r ON r.id = d.ref_doc_id
    WHERE d.deleted = 0 AND d.doc_type IN ('INV','CN') AND d.doc_date BETWEEN ? AND ?
    ORDER BY d.doc_date, d.created_at, d.doc_no`, [from, to]);
  const lines = await all<Record<string, unknown>>(ex, `
    SELECT l.doc_id, l.gst_bp, l.taxable_paise AS taxable, l.cgst_paise AS cgst, l.sgst_paise AS sgst, l.igst_paise AS igst,
      TRIM(COALESCE(l.hsn, p.hsn, '')) AS hsn, COALESCE(u.gst_uqc, 'OTH') AS uqc, l.base_qty_milli AS qty, p.name_en AS product
    FROM sales_doc_lines l JOIN sales_docs d ON d.id = l.doc_id JOIN products p ON p.id = l.product_id JOIN units u ON u.id = p.base_unit_id
    WHERE l.deleted = 0 AND d.deleted = 0 AND d.doc_type IN ('INV','CN') AND d.doc_date BETWEEN ? AND ?
    ORDER BY l.line_no`, [from, to]);
  const byDoc = new Map<string, Line[]>();
  for (const l of lines) {
    const arr = byDoc.get(String(l.doc_id)) ?? [];
    arr.push({ doc_id: String(l.doc_id), gst_bp: n(l.gst_bp), taxable: n(l.taxable), cgst: n(l.cgst), sgst: n(l.sgst), igst: n(l.igst), hsn: String(l.hsn), uqc: String(l.uqc), qty: n(l.qty), product: String(l.product) });
    byDoc.set(String(l.doc_id), arr);
  }
  return docs.map((d) => ({
    id: String(d.id), doc_type: d.doc_type as Doc['doc_type'], doc_no: String(d.doc_no), doc_date: String(d.doc_date), party_name: String(d.party_name),
    legal_name: String(d.legal_name ?? d.party_name), gstin: String(d.gstin ?? ''), pos: String(d.pos), supply: d.supply as Doc['supply'],
    total: n(d.total), taxable: n(d.taxable), cgst: n(d.cgst), sgst: n(d.sgst), igst: n(d.igst), status: String(d.status),
    ref_doc_id: (d.ref_doc_id as string | null) ?? null, ref_no: (d.ref_no as string | null) ?? null, ref_date: (d.ref_date as string | null) ?? null,
    ref_total: n(d.ref_total), ref_supply: (d.ref_supply as string | null) ?? null, ref_gstin: String(d.ref_gstin ?? ''),
    lines: byDoc.get(String(d.id)) ?? [],
  }));
}

/** Sum lines per GST rate. */
function byRate(lines: Line[]) {
  const m = new Map<number, { rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    const a = m.get(l.gst_bp) ?? { rate: l.gst_bp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    a.taxable += l.taxable; a.cgst += l.cgst; a.sgst += l.sgst; a.igst += l.igst;
    m.set(l.gst_bp, a);
  }
  return [...m.values()].sort((a, b) => a.rate - b.rate);
}

type Section = 'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'cdnur';
function sectionOf(d: Doc): Section {
  if (d.doc_type === 'INV') {
    if (d.gstin) return 'b2b';
    return d.supply === 'inter' && d.total > b2clLimitPaise(d.doc_date) ? 'b2cl' : 'b2cs';
  }
  if (d.gstin) return 'cdnr';
  // Unregistered: a note against a B2C (Large) invoice goes to CDNUR; others are netted in B2CS.
  const refLarge = d.ref_doc_id && !d.ref_gstin && d.ref_supply === 'inter' && d.ref_total > b2clLimitPaise(d.ref_date ?? d.doc_date);
  return refLarge ? 'cdnur' : 'b2cs';
}

const C = (key: string, header: string, type: ColType, width?: number): Col => ({ key, header, type, width });
const S = (header: string, key: string, value: number, type: ColType): NonNullable<Table['gst']>['summary'][number] => ({ header, key, value, type });
const distinct = <T,>(xs: T[]) => new Set(xs).size;

/** R-08 GSTR-1 for a month, laid out like the GST offline tool's Excel sheets. */
export async function gstr1(ex: Exec, from: string, to: string): Promise<Report> {
  const { business } = await businessOf(ex);
  const docs = await loadSales(ex, from, to);
  const active = docs.filter((d) => d.status === 'active');
  const warnings: Report['warnings'] = [];

  const b2b: Row[] = [];
  const b2cl: Row[] = [];
  const cdnr: Row[] = [];
  const cdnur: Row[] = [];
  const b2csMap = new Map<string, Row>();
  const nil = { inter_reg: 0, intra_reg: 0, inter_unreg: 0, intra_unreg: 0 };
  const recon = new Map<string, { count: number; taxable: number; igst: number; cgst: number; sgst: number }>();
  const addRecon = (k: string, sign: number, r: { taxable: number; igst: number; cgst: number; sgst: number }, newDoc: boolean) => {
    const a = recon.get(k) ?? { count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    if (newDoc) a.count += 1;
    a.taxable += sign * r.taxable; a.igst += sign * r.igst; a.cgst += sign * r.cgst; a.sgst += sign * r.sgst;
    recon.set(k, a);
  };

  for (const d of active) {
    const sec = sectionOf(d);
    const sign = d.doc_type === 'CN' ? -1 : 1;
    const pos = posLabel(d.pos);
    if (!d.pos) warnings.push({ code: 'noPlaceOfSupply', detail: d.doc_no });
    let first = true;
    for (const r of byRate(d.lines)) {
      if (r.rate === 0) {
        const k = `${d.supply}_${d.gstin ? 'reg' : 'unreg'}` as keyof typeof nil;
        nil[k] += sign * r.taxable;
        addRecon('nil', sign, r, first);
        first = false;
        continue;
      }
      const tax = { igst: r.igst, cgst: r.cgst, sgst: r.sgst };
      const rate = r.rate;
      if (sec === 'b2b') {
        b2b.push({ gstin: d.gstin, receiver: d.legal_name, inv_no: d.doc_no, inv_date: d.doc_date, inv_value: d.total, pos, reverse_charge: 'N', applicable_pct: '', inv_type: 'Regular B2B', ecom_gstin: '', rate, taxable: r.taxable, cess: 0, ...tax });
      } else if (sec === 'b2cl') {
        b2cl.push({ inv_no: d.doc_no, inv_date: d.doc_date, inv_value: d.total, pos, applicable_pct: '', rate, taxable: r.taxable, cess: 0, ecom_gstin: '', ...tax });
      } else if (sec === 'cdnr') {
        cdnr.push({ gstin: d.gstin, receiver: d.legal_name, note_no: d.doc_no, note_date: d.doc_date, note_type: 'C', pos, reverse_charge: 'N', note_supply: 'Regular B2B', note_value: d.total, applicable_pct: '', rate, taxable: r.taxable, cess: 0, ...tax });
      } else if (sec === 'cdnur') {
        cdnur.push({ ur_type: 'B2CL', note_no: d.doc_no, note_date: d.doc_date, note_type: 'C', pos, note_value: d.total, applicable_pct: '', rate, taxable: r.taxable, cess: 0, ...tax });
      } else {
        const k = `${d.pos}|${rate}`;
        const a = b2csMap.get(k) ?? { type: 'OE', pos, applicable_pct: '', rate, taxable: 0, cess: 0, ecom_gstin: '', igst: 0, cgst: 0, sgst: 0 };
        a.taxable = n(a.taxable) + sign * r.taxable;
        a.igst = n(a.igst) + sign * r.igst; a.cgst = n(a.cgst) + sign * r.cgst; a.sgst = n(a.sgst) + sign * r.sgst;
        b2csMap.set(k, a);
      }
      addRecon(sec, sec === 'cdnr' || sec === 'cdnur' ? -1 : sign, r, first);
      first = false;
    }
  }
  const b2cs = [...b2csMap.values()].sort((a, b) => String(a.pos).localeCompare(String(b.pos)) || n(a.rate) - n(b.rate));

  // HSN summary (Table 12), split into B2B and B2C; credit notes reduce the tab of their buyer.
  const hsnTabs = { b2b: new Map<string, Row>(), b2c: new Map<string, Row>() };
  for (const d of active) {
    const sign = d.doc_type === 'CN' ? -1 : 1;
    const tab = d.gstin ? hsnTabs.b2b : hsnTabs.b2c;
    for (const l of d.lines) {
      if (!l.hsn) warnings.push({ code: 'noHsn', detail: `${d.doc_no}: ${l.product}` });
      else if (!/^\d{4,8}$/.test(l.hsn)) warnings.push({ code: 'shortHsn', detail: `${d.doc_no}: ${l.product} (${l.hsn})` });
      const service = l.hsn.startsWith('99');
      const uqc = service ? 'NA' : l.uqc;
      const k = `${l.hsn}|${uqc}|${l.gst_bp}`;
      const a = tab.get(k) ?? { hsn: l.hsn, description: l.product, uqc, qty: 0, total_value: 0, rate: l.gst_bp, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
      if (!service) a.qty = n(a.qty) + sign * l.qty;
      a.taxable = n(a.taxable) + sign * l.taxable;
      a.igst = n(a.igst) + sign * l.igst; a.cgst = n(a.cgst) + sign * l.cgst; a.sgst = n(a.sgst) + sign * l.sgst;
      a.total_value = n(a.taxable) + n(a.igst) + n(a.cgst) + n(a.sgst);
      tab.set(k, a);
    }
  }
  const sortHsn = (m: Map<string, Row>) => [...m.values()].sort((a, b) => String(a.hsn).localeCompare(String(b.hsn)) || n(a.rate) - n(b.rate));
  const hsnB2b = sortHsn(hsnTabs.b2b);
  const hsnB2c = sortHsn(hsnTabs.b2c);

  // Documents issued (Table 13): every number used in the month, cancelled ones counted.
  const series = new Map<string, { nature: string; nos: Array<{ no: string; seq: number }>; cancelled: number }>();
  for (const d of docs) {
    const prefix = d.doc_no.replace(/\d+$/, '');
    const k = `${d.doc_type}|${prefix}`;
    const s = series.get(k) ?? { nature: d.doc_type === 'INV' ? 'Invoices for outward supply' : 'Credit Note', nos: [], cancelled: 0 };
    s.nos.push({ no: d.doc_no, seq: Number(/(\d+)$/.exec(d.doc_no)?.[1] ?? 0) });
    if (d.status === 'cancelled') s.cancelled += 1;
    series.set(k, s);
  }
  const docsRows: Row[] = [...series.values()].map((s) => {
    const sorted = [...s.nos].sort((a, b) => a.seq - b.seq);
    return { nature: s.nature, sr_from: sorted[0]!.no, sr_to: sorted[sorted.length - 1]!.no, total: s.nos.length, cancelled: s.cancelled, net_issued: s.nos.length - s.cancelled };
  }).sort((a, b) => String(a.nature).localeCompare(String(b.nature)));

  const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + n(r[k]), 0);
  const distinctValue = (rows: Row[], idKey: string, valKey: string) => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(String(r[idKey]), n(r[valKey]));
    return [...seen.values()].reduce((a, v) => a + v, 0);
  };
  const hsnCols: Col[] = [
    C('hsn', 'HSN', 'code', 10), C('description', 'Description', 'text', 28), C('uqc', 'UQC', 'code', 8), C('qty', 'Total Quantity', 'qty', 14),
    C('total_value', 'Total Value', 'money', 15), C('rate', 'Rate', 'rate', 7), C('taxable', 'Taxable Value', 'money', 15),
    C('igst', 'Integrated Tax Amount', 'money', 15), C('cgst', 'Central Tax Amount', 'money', 15), C('sgst', 'State/UT Tax Amount', 'money', 15), C('cess', 'Cess Amount', 'money', 11),
  ];
  const hsnSummary = (rows: Row[]) => [
    S('No. of HSN', 'hsn', distinct(rows.map((r) => r.hsn)), 'int'), S('Total Value', 'total_value', sum(rows, 'total_value'), 'money'),
    S('Total Taxable Value', 'taxable', sum(rows, 'taxable'), 'money'), S('Total Integrated Tax', 'igst', sum(rows, 'igst'), 'money'),
    S('Total Central Tax', 'cgst', sum(rows, 'cgst'), 'money'), S('Total State/UT Tax', 'sgst', sum(rows, 'sgst'), 'money'), S('Total Cess', 'cess', 0, 'money'),
  ];

  const reconRows: Row[] = (['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'nil'] as const).map((k) => {
    const a = recon.get(k) ?? { count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    return { section: k, count: a.count, taxable: a.taxable, igst: a.igst, cgst: a.cgst, sgst: a.sgst, tax: a.igst + a.cgst + a.sgst };
  });
  const reconTotals: Row = { count: sum(reconRows, 'count'), taxable: sum(reconRows, 'taxable'), igst: sum(reconRows, 'igst'), cgst: sum(reconRows, 'cgst'), sgst: sum(reconRows, 'sgst'), tax: sum(reconRows, 'tax') };
  const hsnAll = [...hsnB2b, ...hsnB2c];

  const tables: Table[] = [
    {
      id: 'summary', title: 'GSTR-1 summary by section', sheet: 'Summary', rows: reconRows, totals: reconTotals,
      columns: [{ key: 'section', type: 'code', header: 'Section', width: 12, translate: true }, C('count', 'Documents', 'int'), C('taxable', 'Taxable value', 'money'), C('igst', 'IGST', 'money'), C('cgst', 'CGST', 'money'), C('sgst', 'SGST', 'money'), C('tax', 'Total tax', 'money')],
    },
    {
      id: 'b2b', title: 'B2B invoices (4A)', sheet: 'b2b, sez, de', rows: b2b,
      columns: [C('gstin', 'GSTIN/UIN of Recipient', 'code', 18), C('receiver', 'Receiver Name', 'text', 26), C('inv_no', 'Invoice Number', 'code', 16), C('inv_date', 'Invoice date', 'date', 12),
        C('inv_value', 'Invoice Value', 'money'), C('pos', 'Place Of Supply', 'text', 18), C('reverse_charge', 'Reverse Charge', 'code', 9), C('applicable_pct', 'Applicable % of Tax Rate', 'text', 10),
        C('inv_type', 'Invoice Type', 'text', 13), C('ecom_gstin', 'E-Commerce GSTIN', 'code', 12), C('rate', 'Rate', 'rate', 7), C('taxable', 'Taxable Value', 'money'), C('cess', 'Cess Amount', 'money', 11)],
      gst: { summaryTitle: 'Summary For B2B, SEZ, DE (4A, 4B, 6B, 6C)', summary: [
        S('No. of Recipients', 'gstin', distinct(b2b.map((r) => r.gstin)), 'int'), S('No. of Invoices', 'inv_no', distinct(b2b.map((r) => r.inv_no)), 'int'),
        S('Total Invoice Value', 'inv_value', distinctValue(b2b, 'inv_no', 'inv_value'), 'money'), S('Total Taxable Value', 'taxable', sum(b2b, 'taxable'), 'money'), S('Total Cess', 'cess', 0, 'money')] },
    },
    {
      id: 'b2cl', title: 'B2C large invoices (5)', sheet: 'b2cl', rows: b2cl,
      columns: [C('inv_no', 'Invoice Number', 'code', 16), C('inv_date', 'Invoice date', 'date', 12), C('inv_value', 'Invoice Value', 'money'), C('pos', 'Place Of Supply', 'text', 18),
        C('applicable_pct', 'Applicable % of Tax Rate', 'text', 10), C('rate', 'Rate', 'rate', 7), C('taxable', 'Taxable Value', 'money'), C('cess', 'Cess Amount', 'money', 11), C('ecom_gstin', 'E-Commerce GSTIN', 'code', 12)],
      gst: { summaryTitle: 'Summary For B2CL(5)', summary: [
        S('No. of Invoices', 'inv_no', distinct(b2cl.map((r) => r.inv_no)), 'int'), S('Total Inv Value', 'inv_value', distinctValue(b2cl, 'inv_no', 'inv_value'), 'money'),
        S('Total Taxable Value', 'taxable', sum(b2cl, 'taxable'), 'money'), S('Total Cess', 'cess', 0, 'money')] },
    },
    {
      id: 'b2cs', title: 'B2C small (7)', sheet: 'b2cs', rows: b2cs,
      columns: [C('type', 'Type', 'code', 6), C('pos', 'Place Of Supply', 'text', 18), C('applicable_pct', 'Applicable % of Tax Rate', 'text', 10), C('rate', 'Rate', 'rate', 7),
        C('taxable', 'Taxable Value', 'money'), C('cess', 'Cess Amount', 'money', 11), C('ecom_gstin', 'E-Commerce GSTIN', 'code', 12)],
      gst: { summaryTitle: 'Summary For B2CS(7)', summary: [S('Total Taxable Value', 'taxable', sum(b2cs, 'taxable'), 'money'), S('Total Cess', 'cess', 0, 'money')] },
    },
    {
      id: 'cdnr', title: 'Credit notes, registered (9B)', sheet: 'cdnr', rows: cdnr,
      columns: [C('gstin', 'GSTIN/UIN of Recipient', 'code', 18), C('receiver', 'Receiver Name', 'text', 26), C('note_no', 'Note Number', 'code', 16), C('note_date', 'Note Date', 'date', 12),
        C('note_type', 'Note Type', 'code', 7), C('pos', 'Place Of Supply', 'text', 18), C('reverse_charge', 'Reverse Charge', 'code', 9), C('note_supply', 'Note Supply Type', 'text', 13),
        C('note_value', 'Note Value', 'money'), C('applicable_pct', 'Applicable % of Tax Rate', 'text', 10), C('rate', 'Rate', 'rate', 7), C('taxable', 'Taxable Value', 'money'), C('cess', 'Cess Amount', 'money', 11)],
      gst: { summaryTitle: 'Summary For CDNR(9B)', summary: [
        S('No. of Recipients', 'gstin', distinct(cdnr.map((r) => r.gstin)), 'int'), S('No. of Notes', 'note_no', distinct(cdnr.map((r) => r.note_no)), 'int'),
        S('Total Note Value', 'note_value', distinctValue(cdnr, 'note_no', 'note_value'), 'money'), S('Total Taxable Value', 'taxable', sum(cdnr, 'taxable'), 'money'), S('Total Cess', 'cess', 0, 'money')] },
    },
    {
      id: 'cdnur', title: 'Credit notes, unregistered (9B)', sheet: 'cdnur', rows: cdnur,
      columns: [C('ur_type', 'UR Type', 'code', 8), C('note_no', 'Note Number', 'code', 16), C('note_date', 'Note Date', 'date', 12), C('note_type', 'Note Type', 'code', 7),
        C('pos', 'Place Of Supply', 'text', 18), C('note_value', 'Note Value', 'money'), C('applicable_pct', 'Applicable % of Tax Rate', 'text', 10), C('rate', 'Rate', 'rate', 7),
        C('taxable', 'Taxable Value', 'money'), C('cess', 'Cess Amount', 'money', 11)],
      gst: { summaryTitle: 'Summary For CDNUR(9B)', summary: [
        S('No. of Notes/Vouchers', 'note_no', distinct(cdnur.map((r) => r.note_no)), 'int'), S('Total Note Value', 'note_value', distinctValue(cdnur, 'note_no', 'note_value'), 'money'),
        S('Total Taxable Value', 'taxable', sum(cdnur, 'taxable'), 'money'), S('Total Cess', 'cess', 0, 'money')] },
    },
    {
      id: 'exemp', title: 'Nil rated, exempted and non-GST (8)', sheet: 'exemp',
      rows: [
        { description: 'Inter-State supplies to registered persons', nil_rated: nil.inter_reg, exempted: 0, non_gst: 0 },
        { description: 'Intra-State supplies to registered persons', nil_rated: nil.intra_reg, exempted: 0, non_gst: 0 },
        { description: 'Inter-State supplies to unregistered persons', nil_rated: nil.inter_unreg, exempted: 0, non_gst: 0 },
        { description: 'Intra-State supplies to unregistered persons', nil_rated: nil.intra_unreg, exempted: 0, non_gst: 0 },
      ],
      columns: [C('description', 'Description', 'text', 44), C('nil_rated', 'Nil Rated Supplies', 'money'), C('exempted', 'Exempted(other than nil rated/non GST supply)', 'money', 18), C('non_gst', 'Non-GST Supplies', 'money')],
      gst: { summaryTitle: 'Summary For Nil rated, exempted and non GST outward supplies (8)', summary: [
        S('Total Nil Rated Supplies', 'nil_rated', nil.inter_reg + nil.intra_reg + nil.inter_unreg + nil.intra_unreg, 'money'), S('Total Exempted Supplies', 'exempted', 0, 'money'), S('Total Non-GST Supplies', 'non_gst', 0, 'money')] },
    },
    { id: 'hsn_b2b', title: 'HSN summary, B2B (12)', sheet: 'hsn(b2b)', rows: hsnB2b, columns: hsnCols, gst: { summaryTitle: 'Summary For HSN(12)', summary: hsnSummary(hsnB2b) } },
    { id: 'hsn_b2c', title: 'HSN summary, B2C (12)', sheet: 'hsn(b2c)', rows: hsnB2c, columns: hsnCols, gst: { summaryTitle: 'Summary For HSN(12)', summary: hsnSummary(hsnB2c) } },
    {
      id: 'docs', title: 'Documents issued (13)', sheet: 'docs', rows: docsRows,
      columns: [C('nature', 'Nature of Document', 'text', 30), C('sr_from', 'Sr. No. From', 'code', 16), C('sr_to', 'Sr. No. To', 'code', 16), C('total', 'Total Number', 'int', 12), C('cancelled', 'Cancelled', 'int', 10)],
      gst: { summaryTitle: 'Summary of documents issued during the tax period (13)', summary: [S('Total Number', 'total', sum(docsRows, 'total'), 'int'), S('Total Cancelled', 'cancelled', sum(docsRows, 'cancelled'), 'int')] },
    },
  ];
  const hsnTotals = { taxable: sum(hsnAll, 'taxable'), igst: sum(hsnAll, 'igst'), cgst: sum(hsnAll, 'cgst'), sgst: sum(hsnAll, 'sgst') };
  return {
    id: 'gstr1', title: 'GSTR-1', from, to, business, tables,
    summary: { ...Object.fromEntries(Object.entries(reconTotals).map(([k, v]) => [k, n(v)])), hsnTaxable: hsnTotals.taxable, hsnTax: hsnTotals.igst + hsnTotals.cgst + hsnTotals.sgst, b2clLimit: b2clLimitPaise(from) },
    notes: ['b2clLimit', 'b2csNetted', 'hsnSplit', 'hsnDigits', 'noJson'],
    warnings: dedupe(warnings),
  };
}

function dedupe(ws: NonNullable<Report['warnings']>) {
  const seen = new Set<string>();
  return ws.filter((w) => { const k = `${w.code}|${w.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export interface Heads { igst: number; cgst: number; sgst: number }

/**
 * Section 49 / Rule 88A set-off: IGST credit first (IGST, then CGST, then SGST);
 * then CGST credit (CGST, then IGST) and SGST credit (SGST, then IGST). CGST never pays SGST or the reverse.
 */
export function setOff(liability: Heads, credit: Heads) {
  const due = { ...liability };
  const left = { ...credit };
  const used = { igst: 0, cgst: 0, sgst: 0 };
  const use = (from: keyof Heads, to: keyof Heads) => {
    const x = Math.max(0, Math.min(left[from], due[to]));
    left[from] -= x; due[to] -= x; used[to] += x;
  };
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst');
  use('cgst', 'cgst'); use('cgst', 'igst');
  use('sgst', 'sgst'); use('sgst', 'igst');
  return { paidByCredit: used, cash: due, creditLeft: left };
}

/** R-08 GSTR-3B summary for a month: 3.1, 3.2, 4 and tax payable after set-off. */
export async function gstr3b(ex: Exec, from: string, to: string): Promise<Report> {
  const { business } = await businessOf(ex);
  const docs = (await loadSales(ex, from, to)).filter((d) => d.status === 'active');
  const out = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  let nilRated = 0;
  const unreg = new Map<string, { taxable: number; igst: number }>();
  for (const d of docs) {
    const s = d.doc_type === 'CN' ? -1 : 1;
    for (const l of d.lines) {
      if (l.gst_bp === 0) { nilRated += s * l.taxable; continue; }
      out.taxable += s * l.taxable; out.igst += s * l.igst; out.cgst += s * l.cgst; out.sgst += s * l.sgst;
      if (!d.gstin && d.supply === 'inter') {
        const a = unreg.get(d.pos) ?? { taxable: 0, igst: 0 };
        a.taxable += s * l.taxable; a.igst += s * l.igst;
        unreg.set(d.pos, a);
      }
    }
  }
  const pur = (await all<Record<string, number>>(ex, `
    SELECT
      COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN (CASE WHEN doc_type = 'DN' THEN -1 ELSE 1 END) * igst_paise END), 0) igst,
      COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN (CASE WHEN doc_type = 'DN' THEN -1 ELSE 1 END) * cgst_paise END), 0) cgst,
      COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN (CASE WHEN doc_type = 'DN' THEN -1 ELSE 1 END) * sgst_paise END), 0) sgst,
      COALESCE(SUM(CASE WHEN itc_eligible = 0 THEN (CASE WHEN doc_type = 'DN' THEN -1 ELSE 1 END) * (igst_paise + cgst_paise + sgst_paise) END), 0) inelig
    FROM purchase_docs WHERE deleted = 0 AND status = 'active' AND doc_date BETWEEN ? AND ?`, [from, to]))[0]!;
  const exp = (await all<Record<string, number>>(ex, `
    SELECT COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN igst_paise END), 0) igst, COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN cgst_paise END), 0) cgst,
      COALESCE(SUM(CASE WHEN itc_eligible = 1 THEN sgst_paise END), 0) sgst, COALESCE(SUM(CASE WHEN itc_eligible = 0 THEN igst_paise + cgst_paise + sgst_paise END), 0) inelig
    FROM expenses WHERE deleted = 0 AND status = 'active' AND doc_date BETWEEN ? AND ?`, [from, to]))[0]!;
  const itc: Heads = { igst: n(pur.igst) + n(exp.igst), cgst: n(pur.cgst) + n(exp.cgst), sgst: n(pur.sgst) + n(exp.sgst) };
  const so = setOff({ igst: out.igst, cgst: out.cgst, sgst: out.sgst }, itc);

  const money = (k: string, h: string): Col => C(k, h, 'money', 16);
  const t31: Row[] = [
    { nature: '3.1(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', taxable: out.taxable, igst: out.igst, cgst: out.cgst, sgst: out.sgst, cess: 0 },
    { nature: '3.1(b) Outward taxable supplies (zero rated)', taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    { nature: '3.1(c) Other outward supplies (nil rated, exempted)', taxable: nilRated, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    { nature: '3.1(d) Inward supplies (liable to reverse charge)', taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    { nature: '3.1(e) Non-GST outward supplies', taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
  ];
  const t32: Row[] = [...unreg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pos, a]) => ({ pos: posLabel(pos), state: stateName(pos), taxable: a.taxable, igst: a.igst }));
  const t4: Row[] = [
    { detail: '4(A)(5) All other ITC', igst: itc.igst, cgst: itc.cgst, sgst: itc.sgst, cess: 0 },
    { detail: '4(B) ITC reversed', igst: 0, cgst: 0, sgst: 0, cess: 0 },
    { detail: '4(C) Net ITC available (A) − (B)', igst: itc.igst, cgst: itc.cgst, sgst: itc.sgst, cess: 0 },
    { detail: '4(D)(2) Ineligible ITC — others (not claimed)', igst: null, cgst: null, sgst: null, cess: null, total: n(pur.inelig) + n(exp.inelig) },
  ];
  const tPay: Row[] = (['igst', 'cgst', 'sgst'] as const).map((h) => ({
    head: h, payable: out[h], itc: itc[h], paid_by_itc: so.paidByCredit[h], cash: so.cash[h], credit_left: so.creditLeft[h],
  }));
  return {
    id: 'gstr3b', title: 'GSTR-3B', from, to, business,
    summary: { outTaxable: out.taxable, outIgst: out.igst, outCgst: out.cgst, outSgst: out.sgst, itcIgst: itc.igst, itcCgst: itc.cgst, itcSgst: itc.sgst, cash: so.cash.igst + so.cash.cgst + so.cash.sgst },
    tables: [
      { id: 't31', title: '3.1 Outward supplies', sheet: '3.1 Outward', rows: t31, columns: [C('nature', 'Nature of supplies', 'text', 60), money('taxable', 'Total taxable value'), money('igst', 'Integrated tax'), money('cgst', 'Central tax'), money('sgst', 'State/UT tax'), money('cess', 'Cess')] },
      { id: 't32', title: '3.2 Inter-state supplies to unregistered persons', sheet: '3.2 Inter-state', rows: t32, totals: { taxable: t32.reduce((a, r) => a + n(r.taxable), 0), igst: t32.reduce((a, r) => a + n(r.igst), 0) }, columns: [C('pos', 'Place of supply (State/UT)', 'text', 26), money('taxable', 'Total taxable value'), money('igst', 'Amount of integrated tax')] },
      { id: 't4', title: '4 Eligible ITC', sheet: '4 ITC', rows: t4, columns: [C('detail', 'Details', 'text', 46), money('igst', 'Integrated tax'), money('cgst', 'Central tax'), money('sgst', 'State/UT tax'), money('cess', 'Cess'), money('total', 'Total')] },
      {
        id: 'payable', title: 'Tax payable after input credit', sheet: 'Payable', rows: tPay,
        totals: { payable: out.igst + out.cgst + out.sgst, itc: itc.igst + itc.cgst + itc.sgst, paid_by_itc: so.paidByCredit.igst + so.paidByCredit.cgst + so.paidByCredit.sgst, cash: so.cash.igst + so.cash.cgst + so.cash.sgst, credit_left: so.creditLeft.igst + so.creditLeft.cgst + so.creditLeft.sgst },
        columns: [{ key: 'head', type: 'code', header: 'Tax', width: 8, translate: true }, money('payable', 'Output tax'), money('itc', 'Input credit (ITC)'), money('paid_by_itc', 'Paid from ITC'), money('cash', 'To pay in cash'), money('credit_left', 'Credit carried forward')],
      },
    ],
    notes: ['setOff', 'dnNetted', 'reverseCharge'],
  };
}

/** R-08 Composition scheme: CMP-08 quarterly statement (Table 3). rateBp: composition rate, traders 1% (100 bp). */
export async function cmp08(ex: Exec, from: string, to: string, rateBp: number): Promise<Report> {
  const { business } = await businessOf(ex);
  const r = (await all<{ v: number }>(ex, `
    SELECT COALESCE(SUM(CASE WHEN doc_type = 'CN' THEN -taxable_paise ELSE taxable_paise END), 0) v
    FROM sales_docs WHERE deleted = 0 AND status = 'active' AND doc_type IN ('INV','CN') AND doc_date BETWEEN ? AND ?`, [from, to]))[0];
  const value = n(r?.v);
  const half = roundDiv(value * rateBp, 20000);
  const rows: Row[] = [
    { sr: '1', desc: 'Outward supplies (including exempt supplies)', value, igst: 0, cgst: half, sgst: half, cess: 0 },
    { sr: '2', desc: 'Inward supplies attracting reverse charge including import of services', value: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    { sr: '3', desc: 'Tax payable (1+2)', value, igst: 0, cgst: half, sgst: half, cess: 0 },
  ];
  return {
    id: 'cmp08', title: 'CMP-08', from, to, business,
    summary: { value, rateBp, tax: half * 2 },
    tables: [{
      id: 'cmp08', title: 'Summary of self-assessed liability (Table 3)', sheet: 'CMP-08 Table 3', rows,
      columns: [C('sr', 'Sr. No.', 'code', 6), C('desc', 'Description', 'text', 60), C('value', 'Value', 'money', 16), C('igst', 'Integrated tax', 'money', 14), C('cgst', 'Central tax', 'money', 14), C('sgst', 'State/UT tax', 'money', 14), C('cess', 'Cess', 'money', 10)],
    }],
    notes: ['compositionRate', 'reverseCharge'],
  };
}

/** Quarter (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar) containing the date. */
export function quarterOf(date: string): { from: string; to: string } {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  const last = new Date(Date.UTC(Number(y), q0 + 2, 0)).getUTCDate();
  return { from: `${y}-${String(q0).padStart(2, '0')}-01`, to: `${y}-${String(q0 + 2).padStart(2, '0')}-${last}` };
}
