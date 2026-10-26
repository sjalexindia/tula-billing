import { req } from '../api';
import { saveFile, XLSX } from '../files';

/*
 * Excel import and export of items, customers and suppliers, and opening stock
 * (apps/server/src/excel.ts). The workbook is written and read here in the browser with exceljs,
 * loaded only when needed, so it works the same on the shop computer and in the phone app.
 */

export type ExcelKind = 'items' | 'parties' | 'opening-stock';
export type Cell = string | number | null;
export interface RowResult { line: number; key: string; action: 'create' | 'update' | 'skip'; errors: string[]; notes: string[] }
export interface ImportResult { applied: boolean; rows: RowResult[]; created: number; updated: number; skipped: number; failed: number }

const MAX_ROWS = 2000;

export const excelApi = {
  rows: (kind: ExcelKind) => req<{ kind: ExcelKind; columns: string[]; rows: Array<Record<string, Cell>> }>('GET', `/api/excel/${kind}`),
  check: (kind: ExcelKind, rows: Array<Record<string, Cell>>) => req<ImportResult>('POST', `/api/excel/${kind}`, { rows, apply: false }),
  save: (kind: ExcelKind, rows: Array<Record<string, Cell>>) => req<ImportResult>('POST', `/api/excel/${kind}`, { rows, apply: true }),
};

/** Download the current list as a workbook: the template to fill in and import. */
export async function downloadWorkbook(kind: ExcelKind, fileName: string, sheetName: string, help: Array<[string, string]>) {
  const [{ default: ExcelJS }, data] = await Promise.all([import('exceljs'), excelApi.rows(kind)]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = data.columns.map((c) => ({ header: c, key: c, width: Math.max(12, Math.min(40, c.length + 4)) }));
  ws.getRow(1).font = { bold: true };
  for (const r of data.rows) ws.addRow(r);
  const notes = wb.addWorksheet('How to fill');
  notes.columns = [{ header: 'Column', key: 'c', width: 22 }, { header: 'What to write', key: 'w', width: 90 }];
  notes.getRow(1).font = { bold: true };
  for (const [c, w] of help) notes.addRow({ c, w });
  const buf = new Uint8Array(await wb.xlsx.writeBuffer());
  await saveFile(fileName, buf, XLSX);
}

/** Plain text or number from whatever Excel put in a cell (formulas, links, rich text, dates). */
function cellValue(v: unknown): Cell {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }>; hyperlink?: string };
  if (o.richText) return o.richText.map((t) => t.text).join('');
  if ('result' in o) return cellValue(o.result);
  if (o.text !== undefined) return cellValue(o.text);
  return String(v);
}

export class SheetError extends Error {
  constructor(public code: 'NOT_XLSX' | 'EMPTY' | 'TOO_MANY') { super(code); }
}

/** Rows of the first sheet, keyed by the headings in row 1. */
export async function readWorkbook(file: ArrayBuffer): Promise<Array<Record<string, Cell>>> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file);
  } catch {
    throw new SheetError('NOT_XLSX');
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) throw new SheetError('EMPTY');
  if (ws.rowCount - 1 > MAX_ROWS) throw new SheetError('TOO_MANY');
  const headings: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, col) => { headings[col] = String(cellValue(c.value) ?? '').trim(); });
  const rows: Array<Record<string, Cell>> = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const out: Record<string, Cell> = {};
    headings.forEach((h, col) => { if (h) out[h] = cellValue(row.getCell(col).value); });
    rows.push(out);
  }
  return rows;
}
