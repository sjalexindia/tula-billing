import { all, insert, one, type Exec } from '@tula/db';

export const SYSTEM_ACCOUNTS = [
  { code: 'CASH', name_en: 'Cash', name_ta: 'ரொக்கம்', kind: 'asset' },
  { code: 'UPI', name_en: 'UPI receipts', name_ta: 'UPI வரவு', kind: 'asset' },
  { code: 'BANK', name_en: 'Bank', name_ta: 'வங்கி', kind: 'asset' },
  { code: 'SALES', name_en: 'Sales', name_ta: 'விற்பனை', kind: 'income' },
  { code: 'PURCHASES', name_en: 'Purchases', name_ta: 'கொள்முதல்', kind: 'expense' },
  { code: 'OUT_CGST', name_en: 'Output CGST', name_ta: 'வெளியீட்டு CGST', kind: 'liability' },
  { code: 'OUT_SGST', name_en: 'Output SGST', name_ta: 'வெளியீட்டு SGST', kind: 'liability' },
  { code: 'OUT_IGST', name_en: 'Output IGST', name_ta: 'வெளியீட்டு IGST', kind: 'liability' },
  { code: 'IN_CGST', name_en: 'Input CGST', name_ta: 'உள்ளீட்டு CGST', kind: 'asset' },
  { code: 'IN_SGST', name_en: 'Input SGST', name_ta: 'உள்ளீட்டு SGST', kind: 'asset' },
  { code: 'IN_IGST', name_en: 'Input IGST', name_ta: 'உள்ளீட்டு IGST', kind: 'asset' },
  { code: 'ROUND_OFF', name_en: 'Round off', name_ta: 'முழுமையாக்கல்', kind: 'income' },
  { code: 'OPENING', name_en: 'Opening balances', name_ta: 'தொடக்க இருப்பு', kind: 'equity' },
  { code: 'STOCK_ADJ', name_en: 'Stock adjustment', name_ta: 'இருப்பு சரிசெய்தல்', kind: 'expense' },
] as const;

export type SystemAccountCode = (typeof SYSTEM_ACCOUNTS)[number]['code'];

export async function ensureSystemAccounts(ex: Exec, deviceId: string) {
  for (const a of SYSTEM_ACCOUNTS) {
    const exists = await one(ex, 'SELECT id FROM accounts WHERE code = ?', [a.code]);
    if (!exists) await insert(ex, 'accounts', deviceId, { ...a, is_system: 1 });
  }
}

export async function accountId(ex: Exec, code: string): Promise<string> {
  const r = await one<{ id: string }>(ex, 'SELECT id FROM accounts WHERE code = ?', [code]);
  if (!r) throw new Error(`Account ${code} missing`);
  return r.id;
}

export async function partyAccountId(ex: Exec, deviceId: string, partyId: string): Promise<string> {
  const code = `PARTY:${partyId}`;
  const r = await one<{ id: string }>(ex, 'SELECT id FROM accounts WHERE code = ?', [code]);
  if (r) return r.id;
  const p = await one<{ name_en: string; name_ta: string | null }>(ex, 'SELECT name_en, name_ta FROM parties WHERE id = ?', [partyId]);
  if (!p) throw new Error('Party not found');
  return insert(ex, 'accounts', deviceId, { code, name_en: p.name_en, name_ta: p.name_ta, kind: 'asset', party_id: partyId });
}

export interface Posting {
  accountId: string;
  debit?: number;
  credit?: number;
}

/** Post a balanced voucher. Throws if debits ≠ credits. Zero lines are skipped. */
export async function post(
  ex: Exec,
  deviceId: string,
  v: { date: string; sourceType: string; sourceId: string; narration?: string; lines: Posting[] },
) {
  const lines = v.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  const dr = lines.reduce((a, l) => a + (l.debit ?? 0), 0);
  const cr = lines.reduce((a, l) => a + (l.credit ?? 0), 0);
  if (dr !== cr) throw new Error(`Unbalanced voucher ${v.sourceType}: Dr ${dr} ≠ Cr ${cr}`);
  for (const l of lines) {
    let debit = l.debit ?? 0;
    let credit = l.credit ?? 0;
    // a negative amount flips side (e.g. negative round-off)
    if (debit < 0) [debit, credit] = [0, -debit];
    if (credit < 0) [debit, credit] = [-credit, 0];
    await insert(ex, 'ledger_entries', deviceId, {
      entry_date: v.date, account_id: l.accountId, debit_paise: debit, credit_paise: credit,
      source_type: v.sourceType, source_id: v.sourceId, narration: v.narration,
    });
  }
}

export async function partyBalance(ex: Exec, partyId: string): Promise<number> {
  const r = await one<{ b: number }>(ex, 'SELECT COALESCE(balance_paise,0) AS b FROM v_party_balance WHERE party_id = ?', [partyId]);
  return Number(r?.b ?? 0);
}

export async function trialBalanceCheck(ex: Exec) {
  return all<{ dr: number; cr: number }>(ex, 'SELECT SUM(debit_paise) dr, SUM(credit_paise) cr FROM ledger_entries WHERE deleted = 0');
}
