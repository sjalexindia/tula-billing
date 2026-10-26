import { all, type Exec } from '@tula/db';
import { businessOf, DOC_TYPES, DOCS_SQL, n, type Col, type Report, type Row } from './common';

const ADJ_REASON: Record<string, string> = { opening: 'Opening stock', weight_diff: 'Weight difference', scrap: 'Scrap', damage: 'Damage', count: 'Count correction', other: 'Stock correction' };

/** Party in both languages; a stock correction shows its reason, translated on screen from the code. */
function partyCell(d: Record<string, unknown>): Row[string] {
  if (d.doc_type === 'ADJ' || d.doc_type === 'OPEN') {
    const reason = String(d.party_name ?? 'other');
    return { code: reason, en: ADJ_REASON[reason] ?? reason };
  }
  return d.party_name ? { en: String(d.party_name), ta: (d.party_name_ta as string | null) ?? null } : '';
}

/** R-01 Day book: every document in the period, cancelled ones struck through and left out of totals. */
export async function dayBook(ex: Exec, from: string, to: string): Promise<Report> {
  const { business } = await businessOf(ex);
  const docs = await all<Record<string, unknown>>(ex, `
    SELECT * FROM (${DOCS_SQL}) WHERE doc_date BETWEEN ? AND ?
    ORDER BY doc_date, created_at, doc_no`, [from, to]);
  const rows: Row[] = docs.map((d) => ({
    date: d.doc_date, type: d.doc_type, doc_no: d.doc_no, party: partyCell(d), amount: n(d.amount_paise),
    status: d.status, _cancelled: d.status === 'cancelled',
  }));
  const byType: Row[] = DOC_TYPES.map((type) => {
    const of = rows.filter((r) => r.type === type);
    return {
      type, count: of.filter((r) => !r._cancelled).length, cancelled: of.filter((r) => r._cancelled).length,
      amount: of.filter((r) => !r._cancelled).reduce((a, r) => a + n(r.amount), 0),
    };
  }).filter((r) => n(r.count) + n(r.cancelled) > 0);
  const cols: Col[] = [
    { key: 'date', type: 'date', header: 'Date' },
    { key: 'type', type: 'code', header: 'Type', width: 8, translate: true },
    { key: 'doc_no', type: 'code', header: 'Number', width: 18 },
    { key: 'party', type: 'name', header: 'Party / details', width: 32 },
    { key: 'amount', type: 'money', header: 'Amount' },
    { key: 'status', type: 'code', header: 'Status', width: 11, translate: true },
  ];
  return {
    id: 'day-book', title: 'Day book', from, to, business,
    tables: [
      { id: 'documents', title: 'Day book', columns: cols, rows },
      {
        id: 'by_type', title: 'Totals by document type', sheet: 'By type', rows: byType,
        columns: [
          { key: 'type', type: 'code', header: 'Type', width: 10, translate: true },
          { key: 'count', type: 'int', header: 'Documents' },
          { key: 'cancelled', type: 'int', header: 'Cancelled' },
          { key: 'amount', type: 'money', header: 'Amount' },
        ],
      },
    ],
    notes: ['cancelledNotTotalled'],
  };
}

const MONEY_ACCOUNTS = ['CASH', 'UPI', 'BANK'] as const;

/** R-01 Cash & bank book: opening, every entry, closing — one table per account. */
export async function cashBook(ex: Exec, from: string, to: string): Promise<Report> {
  const { business } = await businessOf(ex);
  const summary: Row[] = [];
  const tables: Report['tables'] = [];
  for (const code of MONEY_ACCOUNTS) {
    const acc = (await all<{ id: string; name_en: string; name_ta: string | null }>(ex, 'SELECT id, name_en, name_ta FROM accounts WHERE code = ?', [code]))[0];
    if (!acc) continue;
    const live = `e.deleted = 0 AND e.account_id = ? AND (d.status IS NULL OR d.status = 'active')`;
    const join = `FROM ledger_entries e LEFT JOIN (${DOCS_SQL}) d ON d.id = e.source_id`;
    const op = (await all<{ b: number }>(ex, `SELECT COALESCE(SUM(e.debit_paise - e.credit_paise), 0) b ${join} WHERE ${live} AND e.entry_date < ?`, [acc.id, from]))[0];
    const opening = n(op?.b);
    const entries = await all<Record<string, unknown>>(ex, `
      SELECT e.entry_date, e.source_type, e.debit_paise, e.credit_paise, e.narration, d.doc_no, d.party_name, d.party_name_ta
      ${join} WHERE ${live} AND e.entry_date BETWEEN ? AND ?
      ORDER BY e.entry_date, e.created_at`, [acc.id, from, to]);
    let bal = opening;
    const rows: Row[] = [{ date: from, type: '', doc_no: '', party: '', narration: 'Opening balance', money_in: null, money_out: null, balance: opening, _opening: true }];
    for (const e of entries) {
      bal += n(e.debit_paise) - n(e.credit_paise);
      rows.push({
        date: e.entry_date, type: e.source_type, doc_no: e.doc_no ?? '', party: e.party_name ? { en: String(e.party_name), ta: (e.party_name_ta as string | null) ?? null } : '', narration: e.narration ?? '',
        money_in: n(e.debit_paise) || null, money_out: n(e.credit_paise) || null, balance: bal,
      });
    }
    const moneyIn = entries.reduce((a, e) => a + n(e.debit_paise), 0);
    const moneyOut = entries.reduce((a, e) => a + n(e.credit_paise), 0);
    summary.push({ account: { en: acc.name_en, ta: acc.name_ta }, code, opening, money_in: moneyIn, money_out: moneyOut, closing: bal });
    tables.push({
      id: `account_${code.toLowerCase()}`, title: acc.name_en, sheet: acc.name_en,
      columns: [
        { key: 'date', type: 'date', header: 'Date' },
        { key: 'type', type: 'code', header: 'Type', width: 8, translate: true },
        { key: 'doc_no', type: 'code', header: 'Number', width: 18 },
        { key: 'party', type: 'name', header: 'Party', width: 28 },
        { key: 'narration', type: 'text', header: 'Details', width: 30 },
        { key: 'money_in', type: 'money', header: 'Money in' },
        { key: 'money_out', type: 'money', header: 'Money out' },
        { key: 'balance', type: 'money', header: 'Balance' },
      ],
      rows,
      totals: { money_in: moneyIn, money_out: moneyOut, balance: bal },
    });
  }
  return {
    id: 'cash-book', title: 'Cash and bank book', from, to, business,
    tables: [
      {
        id: 'accounts', title: 'Cash and bank summary', sheet: 'Summary', rows: summary,
        columns: [
          { key: 'account', type: 'name', header: 'Account', width: 20 },
          { key: 'opening', type: 'money', header: 'Opening' },
          { key: 'money_in', type: 'money', header: 'Money in' },
          { key: 'money_out', type: 'money', header: 'Money out' },
          { key: 'closing', type: 'money', header: 'Closing' },
        ],
        totals: { opening: summary.reduce((a, r) => a + n(r.opening), 0), money_in: summary.reduce((a, r) => a + n(r.money_in), 0), money_out: summary.reduce((a, r) => a + n(r.money_out), 0), closing: summary.reduce((a, r) => a + n(r.closing), 0) },
      },
      ...tables,
    ],
  };
}
