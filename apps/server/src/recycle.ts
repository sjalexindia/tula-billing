import { all, one, update, type Db, type Exec } from '@tula/db';
import { z } from 'zod';
import { requireOwner } from './auth';
import { UserError } from './context';
import type { Req, Router } from './http';
import { audit, inTx } from './masters';

/*
 * Recycle bin (spec UC-33): masters deleted by mistake can be put back. Deleting only hides the row
 * (deleted = 1, synced like any change), and only for masters nothing depends on: an item never
 * billed, bought, counted or given a special rate; a customer or supplier with no documents, balance
 * or special rates; a category with no items; an expense head with no expenses. Anything in use is
 * "marked inactive" instead (the Active switch), so history and stock never lose a row. Documents
 * are never deleted; mistakes in them are corrected with cancellations, credit and debit notes.
 * Units and rate groups are part of how items are measured and priced, so they are not deleted.
 */

export const KINDS = ['products', 'parties', 'categories', 'expense_heads'] as const;
export type Kind = (typeof KINDS)[number];

const LABEL: Record<Kind, string> = { products: 'item', parties: 'customer or supplier', categories: 'category', expense_heads: 'expense head' };

/** Why a master cannot be deleted (in use), or null when it can. */
async function inUse(ex: Exec, kind: Kind, id: string): Promise<string | null> {
  const any = async (sql: string) => !!(await one(ex, `${sql} LIMIT 1`, [id]));
  if (kind === 'products') {
    if (await any('SELECT 1 FROM sales_doc_lines WHERE product_id = ?')) return 'It is on bills. Mark it inactive instead.';
    if (await any('SELECT 1 FROM purchase_doc_lines WHERE product_id = ?')) return 'It is on purchase bills. Mark it inactive instead.';
    if (await any('SELECT 1 FROM stock_moves WHERE product_id = ? AND deleted = 0')) return 'It has stock or stock history. Mark it inactive instead.';
    if (await any('SELECT 1 FROM party_rates WHERE product_id = ? AND deleted = 0')) return 'Customers have special rates for it. Remove those first, or mark it inactive.';
    return null;
  }
  if (kind === 'parties') {
    const p = await one<{ is_walk_in: number }>(ex, 'SELECT is_walk_in FROM parties WHERE id = ?', [id]);
    if (p && Number(p.is_walk_in)) return 'The walk-in customer is needed for cash bills.';
    for (const t of ['sales_docs', 'purchase_docs', 'money_docs', 'expenses']) {
      if (await any(`SELECT 1 FROM ${t} WHERE party_id = ?`)) return 'They have bills, payments or expenses. Mark them inactive instead.';
    }
    if (await any('SELECT 1 FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.party_id = ? AND e.deleted = 0')) return 'They have an opening balance. Set it to 0 first, or mark them inactive.';
    if (await any('SELECT 1 FROM party_rates WHERE party_id = ? AND deleted = 0')) return 'They have special rates. Remove those first, or mark them inactive.';
    return null;
  }
  if (kind === 'categories') {
    return (await any('SELECT 1 FROM products WHERE category_id = ? AND deleted = 0')) ? 'It still has items. Move or delete them first.' : null;
  }
  return (await any('SELECT 1 FROM expenses WHERE head_id = ?')) ? 'Expenses use it.' : null;
}

/** Why a deleted master cannot come back as it is (it would clash with a live one), or null. */
async function clash(ex: Exec, kind: Kind, id: string): Promise<string | null> {
  if (kind === 'products') {
    const p = await one<{ category_id: string }>(ex, 'SELECT category_id FROM products WHERE id = ?', [id]);
    const cat = p && await one<{ deleted: number; name_en: string }>(ex, 'SELECT deleted, name_en FROM categories WHERE id = ?', [p.category_id]);
    if (cat && Number(cat.deleted)) return `Its category "${cat.name_en}" is in the recycle bin too. Restore the category first.`;
    return null;
  }
  if (kind === 'parties') {
    const p = await one<{ mobile: string | null }>(ex, 'SELECT mobile FROM parties WHERE id = ?', [id]);
    const other = p?.mobile && await one<{ name_en: string }>(ex, 'SELECT name_en FROM parties WHERE mobile = ? AND deleted = 0 AND id != ?', [p.mobile, id]);
    return other ? `${other.name_en} now has the same mobile number.` : null;
  }
  if (kind === 'expense_heads') {
    const h = await one<{ name_en: string }>(ex, 'SELECT name_en FROM expense_heads WHERE id = ?', [id]);
    const other = h && await one(ex, 'SELECT 1 FROM expense_heads WHERE lower(name_en) = lower(?) AND deleted = 0 AND id != ?', [h.name_en, id]);
    return other ? `Another expense head is now called "${h!.name_en}".` : null;
  }
  return null;
}

async function remove(db: Db, dev: string, req: Req, kind: Kind, id: string) {
  requireOwner(req);
  await inTx(db, async (tx) => {
    const row = await one<{ deleted: number }>(tx, `SELECT deleted FROM ${kind} WHERE id = ?`, [id]);
    if (!row || Number(row.deleted)) throw new UserError(`No such ${LABEL[kind]}`, 'NOT_FOUND', 404);
    const why = await inUse(tx, kind, id);
    if (why) throw new UserError(`This ${LABEL[kind]} cannot be deleted. ${why}`, 'IN_USE', 409);
    await update(tx, kind, dev, id, { deleted: 1 });
    await audit(tx, dev, req, kind, id, 'delete');
  });
  return { ok: true };
}

export function registerRecycle(app: Router, db: Db, dev: string): void {
  const idOf = (req: Req) => z.object({ id: z.string().min(1) }).parse(req.params).id;
  app.delete('/api/products/:id', (req) => remove(db, dev, req, 'products', idOf(req)));
  app.delete('/api/parties/:id', (req) => remove(db, dev, req, 'parties', idOf(req)));
  app.delete('/api/categories/:id', (req) => remove(db, dev, req, 'categories', idOf(req)));
  app.delete('/api/expense-heads/:id', (req) => remove(db, dev, req, 'expense_heads', idOf(req)));

  /** Everything in the recycle bin, newest first, with who deleted it. */
  app.get('/api/recycle-bin', async (req) => {
    requireOwner(req);
    const rows = await all<{ kind: Kind; id: string; name_en: string; name_ta: string | null; code: string | null; deleted_at: string }>(db, `
      SELECT 'products' AS kind, id, name_en, name_ta, sku AS code, updated_at AS deleted_at FROM products WHERE deleted = 1
      UNION ALL SELECT 'parties', id, name_en, name_ta, mobile, updated_at FROM parties WHERE deleted = 1
      UNION ALL SELECT 'categories', id, name_en, name_ta, NULL, updated_at FROM categories WHERE deleted = 1
      UNION ALL SELECT 'expense_heads', id, name_en, name_ta, NULL, updated_at FROM expense_heads WHERE deleted = 1
      ORDER BY deleted_at DESC`);
    const by = await all<{ entity: string; entity_id: string; name: string | null }>(db, `
      SELECT a.entity, a.entity_id, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete' ORDER BY a.at`);
    const who = new Map(by.map((b) => [`${b.entity}:${b.entity_id}`, b.name]));
    return rows.map((r) => ({ ...r, deleted_by: who.get(`${r.kind}:${r.id}`) ?? null }));
  });

  app.post('/api/recycle-bin/:kind/:id/restore', async (req) => {
    requireOwner(req);
    const { kind, id } = z.object({ kind: z.enum(KINDS), id: z.string().min(1) }).parse(req.params);
    await inTx(db, async (tx) => {
      const row = await one<{ deleted: number }>(tx, `SELECT deleted FROM ${kind} WHERE id = ?`, [id]);
      if (!row || !Number(row.deleted)) throw new UserError('It is not in the recycle bin', 'NOT_FOUND', 404);
      const why = await clash(tx, kind, id);
      if (why) throw new UserError(`It cannot be restored. ${why}`, 'CLASH', 409);
      await update(tx, kind, dev, id, { deleted: 0 });
      await audit(tx, dev, req, kind, id, 'restore');
    });
    return { ok: true };
  });
}
