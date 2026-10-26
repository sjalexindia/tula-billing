import ExcelJS from 'exceljs';
import { stateName } from '@tula/core';
import type { Col, Report, Row, Table } from './common';
import { fileSafe, n } from './common';

// Excel applies the computer's digit grouping (lakh/crore on an Indian-locale PC) to #,##0.
const RS = '"₹"#,##0.00;[Red]-"₹"#,##0.00';
const PLAIN_MONEY = '0.00';
const QTY = '#,##0.000';

const NOTE_TEXT: Record<string, string> = {
  cancelledNotTotalled: 'Cancelled documents are listed but not included in totals.',
  creditNotesNegative: 'Credit notes and debit notes are shown as negative rows.',
  pnlFormula: 'Sales (taxable, net of credit notes) − cost of goods sold (average cost at the time of sale) = gross profit; − expenses (taxable + GST without input credit) − stock correction losses = net profit. Round-off is not included.',
  avgCostAsOf: 'Average cost = all inward value ÷ all inward quantity up to the date.',
  b2clLimit: 'B2C (Large): inter-state invoices to unregistered buyers above ₹1,00,000 (Notification 12/2024-CT, from 1 Aug 2024).',
  b2csNetted: 'Credit notes to unregistered buyers (other than against B2C Large invoices) are netted in B2CS, as the GST portal expects.',
  hsnSplit: 'HSN summary is split into B2B and B2C tables (GSTR-1 Table 12, from the May 2025 return period).',
  hsnDigits: 'HSN codes need at least 4 digits when last year\'s turnover was up to ₹5 crore, and 6 digits above ₹5 crore.',
  noJson: 'JSON upload file is not produced. Import these sheets into the GST offline tool, or let your CA enter them.',
  setOff: 'Set-off follows Section 49: IGST credit first against IGST, then CGST, then SGST; CGST and SGST credit against their own head, then IGST. Your CA may choose a different split.',
  dnNetted: 'Debit notes (purchase returns) are netted in 4(A)(5).',
  reverseCharge: 'Inward supplies under reverse charge are not recorded in Tula; add them if any.',
  compositionRate: 'Composition tax is worked out at the rate given (traders: 1%, half CGST and half SGST). Confirm with your CA.',
  rateExtraToday: 'Base rate = that day\'s rate for the group + the item\'s current size extra.',
  slowMoving: 'Slow moving: stock on hand with no sale in the number of days given.',
  stockLossNet: 'Stock correction losses are net of stock found in counts.',
};
export const noteText = (code: string) => NOTE_TEXT[code] ?? code;

const EN_VALUES: Record<string, string> = { yes: 'Yes', no: 'No', active: 'Active', cancelled: 'Cancelled', OK: 'OK', LOW: 'Low', OUT: 'Out of stock', NEGATIVE: 'Negative', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', nil: 'Nil rated', OPEN: 'Opening' };
const LINE_EN: Record<string, string> = { sales: 'Sales', returns: 'Sales returns', netSales: 'Net sales', cogs: 'Cost of goods sold', gross: 'Gross profit', totalExpenses: 'Total expenses', stockLoss: 'Stock correction loss', net: 'Net profit' };

function cellValue(c: Col, v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null;
  if (c.translate && typeof v === 'string') return EN_VALUES[v] ?? v;
  switch (c.type) {
    case 'money': return n(v) / 100;
    case 'qty': return n(v) / 1000;
    case 'int': return n(v);
    case 'pct': return n(v) / 10000;
    case 'rate': return n(v) / 100;
    case 'date': {
      const [y, m, d] = String(v).split('-').map(Number);
      return new Date(Date.UTC(y!, m! - 1, d!));
    }
    case 'name': {
      if (typeof v !== 'object') return String(v);
      const o = v as { en?: string; code?: string };
      return o.code ? LINE_EN[o.code] ?? o.en ?? o.code : String(o.en ?? '');
    }
    case 'alt': {
      const a = v as { whole: number; en: string };
      return `${a.whole} ${a.en}`;
    }
    default: return String(v);
  }
}

function numFmt(c: Col, gst: boolean): string | undefined {
  switch (c.type) {
    case 'money': return gst ? PLAIN_MONEY : RS;
    case 'qty': return gst ? '0.00' : QTY;
    case 'pct': return '0.00%';
    case 'rate': return '0.00';
    case 'int': return '0';
    case 'date': return gst ? 'dd-mmm-yyyy' : 'dd-mm-yyyy';
    default: return undefined;
  }
}

const defaultWidth = (c: Col) => c.width ?? ({ money: 15, qty: 13, int: 9, pct: 10, rate: 8, date: 12, name: 28, alt: 14, code: 14, text: 22 } as const)[c.type];

function sheetName(t: Table, used: Set<string>) {
  let base = (t.sheet ?? t.title).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

function addTable(wb: ExcelJS.Workbook, r: Report, t: Table, used: Set<string>) {
  const ws = wb.addWorksheet(sheetName(t, used));
  ws.columns = t.columns.map((c) => ({ key: c.key, width: defaultWidth(c) }));
  let headerRow: number;
  if (t.gst) {
    // GST offline tool layout: row 1 summary title, row 2 summary headers, row 3 summary values, row 4 column headers.
    ws.getCell(1, 1).value = t.gst.summaryTitle;
    ws.getCell(1, 1).font = { bold: true };
    t.gst.summary.forEach((s, i) => {
      const col = t.columns.findIndex((c) => c.key === s.key);
      const at = col >= 0 ? col + 1 : i + 1;
      ws.getCell(2, at).value = s.header;
      ws.getCell(2, at).font = { bold: true };
      const fake: Col = { key: s.key, type: s.type, header: s.header };
      ws.getCell(3, at).value = cellValue(fake, s.value) ?? 0;
      const f = numFmt(fake, true);
      if (f) ws.getCell(3, at).numFmt = f;
    });
    headerRow = 4;
  } else {
    ws.getCell(1, 1).value = `${r.business.name_en} — ${t.title}`;
    ws.getCell(1, 1).font = { bold: true, size: 13 };
    ws.getCell(2, 1).value = r.from === r.to ? r.from : `${r.from} to ${r.to}`;
    headerRow = 3;
  }
  const hdr = ws.getRow(headerRow);
  t.columns.forEach((c, i) => {
    const cell = hdr.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: t.gst ? 'FF0070C0' : 'FFE7ECEF' } };
    if (t.gst) cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true, horizontal: ['money', 'qty', 'int', 'pct', 'rate'].includes(c.type) ? 'right' : 'left' };
  });
  hdr.height = 30;
  ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 0 }];

  let at = headerRow + 1;
  for (const row of t.rows) {
    const xr = ws.getRow(at++);
    t.columns.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      cell.value = cellValue(c, row[c.key]);
      const f = numFmt(c, !!t.gst);
      if (f) cell.numFmt = f;
      if (row._cancelled) cell.font = { strike: true, color: { argb: 'FF7F7F7F' } };
    });
  }
  if (t.totals && !t.gst) {
    const xr = ws.getRow(at++);
    t.columns.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      const v = t.totals![c.key];
      cell.value = i === 0 && v === undefined ? 'Total' : cellValue(c, v);
      const f = numFmt(c, false);
      if (f) cell.numFmt = f;
      cell.font = { bold: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    });
  }
  return ws;
}

export async function reportWorkbook(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tula';
  wb.created = new Date();
  const used = new Set<string>();
  for (const t of r.tables) addTable(wb, r, t, used);
  if (r.notes?.length || r.warnings?.length) {
    const ws = wb.addWorksheet(sheetName({ id: 'notes', title: 'Notes', columns: [], rows: [] }, used));
    ws.columns = [{ width: 120 }];
    ws.getCell(1, 1).value = `${r.business.name_en}${r.business.gstin ? ` (GSTIN ${r.business.gstin})` : ''} — ${r.title}, ${r.from} to ${r.to}`;
    ws.getCell(1, 1).font = { bold: true };
    let i = 3;
    for (const code of r.notes ?? []) ws.getCell(i++, 1).value = noteText(code);
    for (const w of r.warnings ?? []) ws.getCell(i++, 1).value = `Check: ${w.code}${w.detail ? ` — ${w.detail}` : ''}`;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function xlsxFilename(r: Report): string {
  const name = fileSafe(r.business.name_en || 'Tula');
  const span = r.from === r.to ? r.from : `${r.from} to ${r.to}`;
  return `${name} - ${fileSafe(r.title)} - ${span}.xlsx`;
}

export const posLabel = (code: string) => (code ? `${code}-${stateName(code)}` : '');

/** Rows/values helpers used by GST sheets */
export const yesNo = (b: unknown) => (b ? 'Yes' : 'No');
export type { Row };
