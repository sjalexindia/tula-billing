import { stateFromGstin } from '@tula/core';
import { all, insert, one, type Db, type Exec } from '@tula/db';
import { z, ZodError } from 'zod';
import { requireOwner } from './auth';
import { UserError } from './context';
import type { Req, Router } from './http';
import { audit, PartyBody, ProductBody, saveParty, saveProduct, setOpeningStock } from './masters';

/*
 * Excel import and export of the masters a shop types in at go-live: items, customers and
 * suppliers, opening stock. The export is also the template: download, edit in Excel, import.
 * The browser reads and writes the .xlsx file (so this works in the phone app too); the server
 * sees plain rows keyed by the column headings below, and checks them with the same rules as the
 * screens (saveProduct, saveParty, setOpeningStock). Headings stay in English so a file made in
 * one language imports in the other.
 */

export const KINDS = ['items', 'parties', 'opening-stock'] as const;
export type Kind = (typeof KINDS)[number];

export const COLUMNS: Record<Kind, string[]> = {
  items: ['Item code', 'Name (English)', 'Name (Tamil)', 'Category', 'Brand', 'HSN/SAC', 'GST %', 'Base unit', 'Other units', 'Sale rate',
    'Daily rate group', 'Rate extra', 'Min stock', 'Keep stock', 'Active'],
  parties: ['Type', 'Name (English)', 'Name (Tamil)', 'Mobile', 'Address', 'GSTIN', 'State code', 'Credit limit', 'Credit days', 'Opening balance', 'Active'],
  'opening-stock': ['Item code', 'Name (English)', 'Base unit', 'Quantity', 'Cost per unit'],
};

type Cell = string | number | null;
type Row = Record<string, Cell | undefined>;
export interface RowResult { line: number; key: string; action: 'create' | 'update' | 'skip'; errors: string[]; notes: string[] }
export interface ImportResult { applied: boolean; rows: RowResult[]; created: number; updated: number; skipped: number; failed: number }

const MAX_ROWS = 2000;
// Numbers go into the sheet as numbers (rupees, units) so Excel can add them up. At 2-3 decimals
// they come back exactly (String(10.57) is "10.57") and are parsed with toPaise / toMilli again.
const money = (paise: unknown) => (Number(paise) ? Number(paise) / 100 : null);
const qty = (milli: unknown) => (Number(milli) ? Number(milli) / 1000 : null);
const yesNo = (v: unknown) => (Number(v) ? 'Yes' : 'No');
const text = (v: Cell | undefined) => (v === null || v === undefined ? '' : String(v).trim());
const opt = (v: Cell | undefined) => text(v) || null;

function yes(v: Cell | undefined, dflt: boolean): boolean {
  const s = text(v).toLowerCase();
  if (!s) return dflt;
  if (['yes', 'y', 'true', '1', 'ஆம்'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'இல்லை'].includes(s)) return false;
  throw new UserError(`Write Yes or No (found "${text(v)}")`, 'BAD_VALUE');
}

/** "BDL=10; ROD~1.2": units other than the base, with how many base units make one; "~" marks a theoretical weight. */
export function parseUnits(s: string): Array<{ unit: string; factor: string; theoretical: boolean }> {
  return s.split(/[;,]/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^([A-Za-z0-9-]+)\s*([=~])\s*([\d.]+)$/.exec(p);
    if (!m) throw new UserError(`Other units: write them like BDL=10; ROD~1.2 (found "${p}")`, 'BAD_UNIT');
    return { unit: m[1]!.toUpperCase(), factor: m[3]!, theoretical: m[2] === '~' };
  });
}

// ---------- export ----------
/** The sheet rows for a list, or for one item / party (`onlyId`, used to tell whether an import changed it). */
async function exportRows(db: Exec, kind: Kind, onlyId?: string): Promise<Row[]> {
  const only = onlyId ? 'AND p.id = ?' : '';
  const args = onlyId ? [onlyId] : [];
  if (kind === 'items') {
    const items = await all<Record<string, Cell>>(db, `
      SELECT p.id, p.sku, p.name_en, p.name_ta, c.name_en AS category, p.brand, p.hsn, p.gst_bp, u.code AS base_unit, p.sale_rate_paise,
             p.rate_mode, p.rate_group, p.rate_extra_paise, p.min_stock_milli, p.track_stock, p.active
      FROM products p JOIN units u ON u.id = p.base_unit_id JOIN categories c ON c.id = p.category_id
      WHERE p.deleted = 0 ${only} ORDER BY c.sort_order, p.sku`, args);
    const units = await all<{ product_id: string; code: string; factor_milli: number; is_theoretical: number }>(db, `
      SELECT pu.product_id, u.code, pu.factor_milli, pu.is_theoretical FROM product_units pu JOIN units u ON u.id = pu.unit_id
      WHERE pu.deleted = 0 ${onlyId ? 'AND pu.product_id = ?' : ''} ORDER BY pu.factor_milli DESC, u.code`, args);
    return items.map((p) => ({
      'Item code': p.sku, 'Name (English)': p.name_en, 'Name (Tamil)': p.name_ta ?? '', Category: p.category, Brand: p.brand ?? '', 'HSN/SAC': p.hsn ?? '',
      'GST %': Number(p.gst_bp) / 100, 'Base unit': p.base_unit,
      'Other units': units.filter((u) => u.product_id === p.id).map((u) => `${u.code}${u.is_theoretical ? '~' : '='}${Number(u.factor_milli) / 1000}`).join('; '),
      'Sale rate': money(p.sale_rate_paise), 'Daily rate group': p.rate_mode === 'daily' ? (p.rate_group ?? '') : '',
      'Rate extra': money(p.rate_extra_paise), 'Min stock': qty(p.min_stock_milli), 'Keep stock': yesNo(p.track_stock), Active: yesNo(p.active),
    }));
  }
  if (kind === 'parties') {
    const rows = await all<Record<string, Cell>>(db, `
      SELECT party_type, name_en, name_ta, mobile, address, gstin, state_code, credit_limit_paise, credit_days, opening_balance_paise, active
      FROM parties p WHERE deleted = 0 AND is_walk_in = 0 ${only} ORDER BY name_en`, args);
    return rows.map((p) => ({
      Type: String(p.party_type).replace(/^./, (c) => c.toUpperCase()), 'Name (English)': p.name_en, 'Name (Tamil)': p.name_ta ?? '', Mobile: p.mobile ?? '',
      Address: p.address ?? '', GSTIN: p.gstin ?? '', 'State code': p.state_code, 'Credit limit': money(p.credit_limit_paise),
      'Credit days': p.credit_days, 'Opening balance': money(p.opening_balance_paise), Active: yesNo(p.active),
    }));
  }
  const rows = await all<Record<string, Cell>>(db, `
    SELECT p.sku, p.name_en, u.code AS base_unit,
      COALESCE((SELECT SUM(l.qty_milli) FROM stock_adjustment_lines l JOIN stock_adjustments a ON a.id = l.adjustment_id
        WHERE l.product_id = p.id AND a.reason = 'opening' AND l.deleted = 0 AND a.deleted = 0), 0) AS qty_milli,
      (SELECT l.cost_per_base_paise FROM stock_adjustment_lines l JOIN stock_adjustments a ON a.id = l.adjustment_id
        WHERE l.product_id = p.id AND a.reason = 'opening' AND l.deleted = 0 AND a.deleted = 0 ORDER BY l.created_at DESC LIMIT 1) AS cost_paise
    FROM products p JOIN units u ON u.id = p.base_unit_id JOIN categories c ON c.id = p.category_id
    WHERE p.deleted = 0 AND p.track_stock = 1 ${only} ORDER BY c.sort_order, p.sku`, args);
  return rows.map((r) => ({ 'Item code': r.sku, 'Name (English)': r.name_en, 'Base unit': r.base_unit, Quantity: qty(r.qty_milli), 'Cost per unit': money(r.cost_paise) }));
}

// ---------- import ----------
/** Field names in error messages → the column the person filled in. */
const FIELD_COLUMN: Record<string, string> = {
  sku: 'Item code', name_en: 'Name (English)', name_ta: 'Name (Tamil)', categoryId: 'Category', brand: 'Brand', hsn: 'HSN/SAC', gst: 'GST %',
  baseUnit: 'Base unit', units: 'Other units', saleRate: 'Sale rate', rateGroup: 'Daily rate group', rateExtra: 'Rate extra', minStock: 'Min stock',
  partyType: 'Type', mobile: 'Mobile', address: 'Address', gstin: 'GSTIN', stateCode: 'State code', creditLimit: 'Credit limit',
  creditDays: 'Credit days', openingBalance: 'Opening balance',
};

function messages(e: unknown): string[] {
  if (e instanceof ZodError) {
    return e.issues.map((i) => {
      const col = FIELD_COLUMN[String(i.path[0])] ?? i.path.join('.');
      return i.message.includes(col) ? i.message : `${col}: ${i.message}`;
    });
  }
  if (e instanceof UserError || e instanceof RangeError) return [e.message];
  throw e;
}

type Done = { key: string; action: 'create' | 'update' | 'skip'; id?: string };

async function importItem(tx: Exec, dev: string, req: Req, r: Row, notes: string[]): Promise<Done> {
  const sku = text(r['Item code']).toUpperCase();
  const existing = sku ? await one<{ id: string; attrs_json: string }>(tx, 'SELECT id, attrs_json FROM products WHERE sku = ? AND deleted = 0', [sku]) : undefined;
  const catName = text(r.Category);
  if (!catName) throw new UserError('Category: write the category name', 'BAD_CATEGORY');
  let cat = await one<{ id: string }>(tx, 'SELECT id FROM categories WHERE lower(name_en) = lower(?) AND deleted = 0', [catName]);
  if (!cat) {
    cat = { id: await insert(tx, 'categories', dev, { name_en: catName, is_service: 0, sort_order: 0 }) };
    notes.push(`New category "${catName}"`);
  }
  // keep what the sheet doesn't carry: on-bill flags of units, custom fields
  const keptUnits = existing ? await all<{ code: string; on_bill: number }>(tx, 'SELECT u.code, pu.on_bill FROM product_units pu JOIN units u ON u.id = pu.unit_id WHERE pu.product_id = ? AND pu.deleted = 0', [existing.id]) : [];
  const group = text(r['Daily rate group']).toUpperCase();
  const b = ProductBody.parse({
    sku, name_en: text(r['Name (English)']), name_ta: opt(r['Name (Tamil)']), categoryId: cat.id, brand: opt(r.Brand), hsn: opt(r['HSN/SAC']),
    gst: text(r['GST %']) || '0', baseUnit: text(r['Base unit']) || 'NOS', trackStock: yes(r['Keep stock'], true), minStock: opt(r['Min stock']),
    rateMode: group ? 'daily' : 'fixed', rateGroup: group || null, rateExtra: opt(r['Rate extra']), saleRate: opt(r['Sale rate']), active: yes(r.Active, true),
    attrs: existing ? JSON.parse(existing.attrs_json || '{}') : undefined,
    units: parseUnits(text(r['Other units'])).map((u) => ({ ...u, onBill: Number(keptUnits.find((k) => k.code === u.unit)?.on_bill ?? 1) === 1 })),
  });
  const id = await saveProduct(tx, dev, b, existing?.id);
  await audit(tx, dev, req, 'products', id, existing ? 'update' : 'create', { sku: b.sku, via: 'excel' });
  return { key: b.sku, action: existing ? 'update' : 'create', id };
}

/** The same party: the same mobile number, else the same name (never the walk-in account). */
async function findParty(tx: Exec, mobile: string | null, name: string) {
  const q = 'SELECT id, lang FROM parties WHERE deleted = 0 AND is_walk_in = 0 AND ';
  return (mobile ? await one<{ id: string; lang: string | null }>(tx, `${q} mobile = ?`, [mobile]) : undefined)
    ?? one<{ id: string; lang: string | null }>(tx, `${q} lower(name_en) = lower(?)`, [name]);
}

async function importParty(tx: Exec, dev: string, req: Req, r: Row): Promise<Done> {
  const type = text(r.Type).toLowerCase() || 'customer';
  const b = PartyBody.parse({
    partyType: type, name_en: text(r['Name (English)']), name_ta: opt(r['Name (Tamil)']), mobile: opt(r.Mobile), address: opt(r.Address),
    gstin: opt(r.GSTIN), stateCode: opt(r['State code'])?.padStart(2, '0') ?? null, creditLimit: opt(r['Credit limit']),
    creditDays: text(r['Credit days']) ? Number(text(r['Credit days'])) : null,
    // blank keeps the opening balance as it is
    openingBalance: text(r['Opening balance']) ? text(r['Opening balance']) : undefined, active: yes(r.Active, true),
  });
  const existing = await findParty(tx, b.mobile, b.name_en);
  if (existing) b.lang = existing.lang;
  if (!b.stateCode && !b.gstin && existing) b.stateCode = (await one<{ state_code: string }>(tx, 'SELECT state_code FROM parties WHERE id = ?', [existing.id]))!.state_code;
  if (b.gstin && !stateFromGstin(b.gstin)) throw new UserError('GSTIN: must be 15 characters, starting with the 2-digit state code', 'BAD_GSTIN');
  const id = await saveParty(tx, dev, b, existing?.id);
  await audit(tx, dev, req, 'parties', id, existing ? 'update' : 'create', { name: b.name_en, via: 'excel' });
  return { key: b.name_en, action: existing ? 'update' : 'create', id };
}

async function importOpening(tx: Exec, dev: string, req: Req, r: Row): Promise<Done> {
  const sku = text(r['Item code']).toUpperCase();
  const p = await one<{ id: string }>(tx, 'SELECT id FROM products WHERE sku = ? AND deleted = 0', [sku]);
  if (!p) throw new UserError(`Item code: no item ${sku || '(blank)'}`, 'NOT_FOUND');
  if (!text(r.Quantity) && !text(r['Cost per unit'])) return { key: sku, action: 'skip' };
  await setOpeningStock(tx, dev, req, [{ productId: p.id, qty: text(r.Quantity) || '0', cost: text(r['Cost per unit']) || '0' }]);
  return { key: sku, action: 'update', id: p.id };
}

/** What the sheet would show for the record this row matches, before it is saved (same matching as the import). */
async function rowsBefore(tx: Exec, kind: Kind, r: Row): Promise<Row[]> {
  let id: string | undefined;
  if (kind === 'parties') {
    const mobile = PartyBody.shape.mobile.safeParse(opt(r.Mobile));
    id = (await findParty(tx, mobile.success ? mobile.data : null, text(r['Name (English)'])))?.id;
  } else {
    id = (await one<{ id: string }>(tx, 'SELECT id FROM products WHERE sku = ? AND deleted = 0', [text(r['Item code']).toUpperCase()]))?.id;
  }
  return id ? exportRows(tx, kind, id) : [];
}

/**
 * Check every row (and save them when `apply`): all rows go through one transaction, each in its
 * own savepoint, so a row is checked exactly as it would be saved, including clashes with rows
 * above it. Nothing is kept unless `apply` is set and no row has an error.
 */
export async function importRows(db: Db, dev: string, req: Req, kind: Kind, rows: Row[], apply: boolean): Promise<ImportResult> {
  const results: RowResult[] = [];
  const tx = await db.transaction('write');
  try {
    for (const [i, r] of rows.entries()) {
      const line = i + 2; // the sheet's row number: row 1 is the headings
      const notes: string[] = [];
      if (Object.values(r).every((v) => !text(v))) continue;
      await tx.execute('SAVEPOINT row');
      try {
        const sheet = JSON.stringify(await rowsBefore(tx, kind, r));
        const done = kind === 'items' ? await importItem(tx, dev, req, r, notes) : kind === 'parties' ? await importParty(tx, dev, req, r) : await importOpening(tx, dev, req, r);
        // a row that changes nothing is not saved: no audit entry, nothing for other devices to copy
        if (done.action === 'update' && done.id && sheet === JSON.stringify(await exportRows(tx, kind, done.id))) {
          await tx.execute('ROLLBACK TO row');
          done.action = 'skip';
        }
        await tx.execute('RELEASE row');
        results.push({ line, key: done.key, action: done.action, errors: [], notes });
      } catch (e) {
        await tx.execute('ROLLBACK TO row');
        await tx.execute('RELEASE row');
        results.push({ line, key: text(r['Item code']) || text(r['Name (English)']), action: 'skip', errors: messages(e), notes });
      }
    }
    const failed = results.filter((r) => r.errors.length).length;
    const applied = apply && failed === 0 && results.length > 0;
    if (applied) await tx.commit();
    else await tx.rollback();
    return {
      applied, rows: results, failed,
      created: results.filter((r) => r.action === 'create' && !r.errors.length).length,
      updated: results.filter((r) => r.action === 'update' && !r.errors.length).length,
      skipped: results.filter((r) => r.action === 'skip' && !r.errors.length).length,
    };
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

export function registerExcel(app: Router, db: Db, dev: string): void {
  const kindOf = (req: Req) => z.object({ kind: z.enum(KINDS) }).parse(req.params).kind;

  /** The rows to put in the workbook (the browser writes the .xlsx). Owner only: it carries balances and costs. */
  app.get('/api/excel/:kind', async (req) => {
    requireOwner(req);
    const kind = kindOf(req);
    return { kind, columns: COLUMNS[kind], rows: await exportRows(db, kind) };
  });

  /** Check (apply: false) or save (apply: true) rows read from a workbook. Owner only (writes are, by default). */
  app.post('/api/excel/:kind', async (req) => {
    requireOwner(req);
    const kind = kindOf(req);
    const b = z.object({
      apply: z.boolean().default(false),
      rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(MAX_ROWS, `At most ${MAX_ROWS} rows at a time`),
    }).parse(req.body);
    const missing = b.rows.length ? REQUIRED[kind].filter((c) => !(c in b.rows[0]!)) : [];
    if (missing.length) throw new UserError(`The sheet has no column ${missing.map((m) => `"${m}"`).join(', ')}. Start from the downloaded workbook.`, 'BAD_SHEET');
    return importRows(db, dev, req, kind, b.rows, b.apply);
  });
}

/** Columns an imported sheet must have (the others may be left out). */
const REQUIRED: Record<Kind, string[]> = {
  items: ['Item code', 'Name (English)', 'Category', 'GST %', 'Base unit'],
  parties: ['Name (English)'],
  'opening-stock': ['Item code', 'Quantity', 'Cost per unit'],
};
