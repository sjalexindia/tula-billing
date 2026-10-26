import { amountInWords, formatRs } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Party } from '../api';
import { useApp } from '../App';
import { dmy, MODES, rupeesText, sales, todayLocal, type Mode, type OpenBills, type ReceiptDetail, type ReceiptInput, type ReceiptPreview, type ReceiptRow } from '../api/sales';
import { nameIn, tFor } from '../i18n';
import type { ScreenProps } from '../nav';
import { paiseOrNull, RangePicker, rangeFor, Sheet, type Range } from './Bills';
import '../styles/sales.css';

/**
 * #/receipts            list for a date range, with "New receipt"
 * #/receipts/new        new receipt form
 * #/receipts/for-<id>   new receipt for that customer (from Outstanding)
 * #/receipts/<id>       printable receipt
 */
export function Receipts({ id }: ScreenProps) {
  if (id === 'new') return <NewReceipt />;
  if (id?.startsWith('for-')) return <NewReceipt partyId={id.slice(4)} />;
  if (id) return <ReceiptPrint id={id} />;
  return <ReceiptList />;
}

function ReceiptList() {
  const { t, i18n } = useTranslation();
  const { isOwner, me } = useApp();
  const ui = i18n.language;
  const [range, setRange] = useState<Range>(() => rangeFor('today'));
  const [rows, setRows] = useState<ReceiptRow[] | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [cancelling, setCancelling] = useState<ReceiptRow | null>(null);
  useEffect(() => { sales.receipts(range.from, range.to).then(setRows).catch((e) => setError((e as Error).message)); }, [range.from, range.to, version]);
  const total = (rows ?? []).filter((r) => r.status === 'active').reduce((a, r) => a + r.amount_paise, 0);
  const byMode = MODES.map((m) => [m, (rows ?? []).filter((r) => r.status === 'active' && r.mode === m).reduce((a, r) => a + r.amount_paise, 0)] as const).filter(([, v]) => v > 0);

  return (
    <section className="page sales">
      <div className="page-head">
        <h1>{t('sales.receipts.title')}</h1>
        {me?.role !== 'viewer' && <a className="btn primary" href="#/receipts/new">{t('sales.receipts.new')}</a>}
      </div>
      <div className="toolbar">
        <RangePicker value={range} onChange={setRange} idPrefix="rc" />
        {rows && rows.length > 0 && (
          <p className="mode-sums">
            <b>{formatRs(total)}</b>
            {byMode.map(([m, v]) => <span key={m}>{t(`bill.modes.${m}`)} {formatRs(v)}</span>)}
          </p>
        )}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {rows && rows.length === 0 && <p className="empty">{t('sales.receipts.none')}</p>}
      {rows && rows.length > 0 && (
        <table className="grid sales-grid">
          <thead>
            <tr><th>{t('sales.receipts.no')}</th><th>{t('sales.receipts.customer')}</th><th>{t('sales.mode')}</th><th className="r">{t('sales.receipts.amount')}</th><th className="r"><span className="sr-only">{t('sales.bills.actions')}</span></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'is-cancelled' : ''}>
                <td><a className="mono doc-no" href={`#/receipts/${r.id}`}>{r.doc_no}</a><span className="sub">{dmy(r.doc_date)}</span></td>
                <td>
                  {nameIn(ui, r.name_en, r.name_ta)}
                  {r.bills && <span className="sub">{t('sales.receipts.forBills', { bills: r.bills })}</span>}
                  {r.status === 'active' && r.amount_paise > r.allocated_paise && <span className="sub">{t('sales.receipts.onAccount', { amount: formatRs(r.amount_paise - r.allocated_paise) })}</span>}
                </td>
                <td>{t(`bill.modes.${r.mode}`)}{r.reference && <span className="sub mono">{r.reference}</span>}</td>
                <td className="r">{formatRs(r.amount_paise)}{r.status === 'cancelled' && <span className="tag cancelled">{t('sales.status.cancelled')}</span>}</td>
                <td className="r actions">
                  <a className="btn small" href={`#/receipts/${r.id}`}>{t('sales.bills.print')}</a>
                  {isOwner && r.status === 'active' && <button type="button" className="btn small danger" onClick={() => setCancelling(r)}>{t('sales.bills.cancel')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cancelling && <CancelReceipt row={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); setVersion((v) => v + 1); }} />}
    </section>
  );
}

function CancelReceipt({ row, onClose, onDone }: { row: ReceiptRow; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const confirm = async () => {
    if (!reason.trim()) { setError(t('sales.cancel.needReason')); return; }
    try {
      await sales.cancelReceipt(row.id, reason.trim());
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Sheet title={t('sales.receipts.cancelTitle', { no: row.doc_no })} onClose={onClose}>
      <p className="sheet-sub">{row.name_en} · {dmy(row.doc_date)} · {formatRs(row.amount_paise)}</p>
      <p className="hint">{t('sales.receipts.cancelHelp')}</p>
      <div className="field">
        <label htmlFor="rc-cancel-reason">{t('sales.cancel.reason')}</label>
        <input id="rc-cancel-reason" value={reason} placeholder={t('sales.receipts.cancelPlaceholder')} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }} />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>{t('sales.cancel.keep')}</button>
        <button type="button" className="btn danger-solid" onClick={() => void confirm()}>{t('sales.receipts.cancelConfirm')}</button>
      </div>
    </Sheet>
  );
}

function NewReceipt({ partyId }: { partyId?: string }) {
  const { t, i18n } = useTranslation();
  const { isOwner } = useApp();
  const ui = i18n.language;
  const [parties, setParties] = useState<Party[]>([]);
  const [customerText, setCustomerText] = useState('');
  const [open, setOpen] = useState<OpenBills | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<Mode>('cash');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayLocal());
  /** null = oldest bills first (automatic); otherwise the amounts typed per bill */
  const [manual, setManual] = useState<Record<string, string> | null>(null);
  const [preview, setPreview] = useState<ReceiptPreview | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState('');

  useEffect(() => {
    api.parties().then((ps) => {
      const customers = ps.filter((p) => p.party_type !== 'supplier');
      setParties(customers);
      const pre = partyId && customers.find((p) => p.id === partyId);
      if (pre) setCustomerText(nameIn(ui, pre.name_en, pre.name_ta));
    }).catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId]);

  const party = useMemo(() => parties.find((p) => [p.name_en, p.name_ta, p.mobile].includes(customerText.trim())), [parties, customerText]);
  useEffect(() => {
    setOpen(null); setManual(null); setPreview(null);
    if (party) sales.openBills(party.id).then(setOpen).catch((e) => setError((e as Error).message));
  }, [party?.id, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountPaise = paiseOrNull(amount);
  const input: ReceiptInput | null = party && amountPaise && amountPaise > 0 ? {
    partyId: party.id, amount: amount.trim(), mode, reference: reference.trim() || undefined, date: date !== todayLocal() ? date : undefined,
    allocations: manual ? Object.entries(manual).filter(([, v]) => v.trim() && paiseOrNull(v)).map(([billId, v]) => ({ billId, amount: v.trim() })) : undefined,
  } : null;
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!input) { setPreview(null); return; }
    const h = setTimeout(() => {
      sales.receiptPreview(input).then((p) => { setPreview(p); setError(''); }).catch((e) => setError((e as Error).message));
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const allocFor = (billId: string) => {
    if (manual) return manual[billId] ?? '';
    const a = preview?.allocations.find((x) => x.billId === billId);
    return a ? rupeesText(a.amountPaise) : '';
  };
  const setAlloc = (billId: string, v: string) => {
    const base: Record<string, string> = manual ?? Object.fromEntries((preview?.allocations ?? []).map((a) => [a.billId, rupeesText(a.amountPaise)]));
    setManual({ ...base, [billId]: v.replace(/[^\d.]/g, '') });
  };

  const save = async () => {
    if (!input) return;
    setSaving(true);
    try {
      const r = await sales.saveReceipt(input);
      location.hash = `#/receipts/${r.id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const applyAdvance = async () => {
    if (!party) return;
    try {
      const r = await sales.applyAdvance(party.id);
      setNote(t('sales.receipts.applied', { amount: formatRs(r.appliedPaise) }));
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const bills = open?.bills ?? [];
  return (
    <form className="page sales receipt-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head">
        <h1>{t('sales.receipts.new')}</h1>
        <a className="btn" href="#/receipts">{t('sales.receipts.backToList')}</a>
      </div>
      <div className="receipt-head">
        <div className="field grow">
          <label htmlFor="rc-customer">{t('sales.receipts.customer')}</label>
          <input id="rc-customer" list="rc-customers" value={customerText} placeholder={t('bill.pickCustomer')} autoComplete="off" autoFocus={!partyId}
            onChange={(e) => setCustomerText(e.target.value)} />
          <datalist id="rc-customers">
            {parties.map((p) => <option key={p.id} value={nameIn(ui, p.name_en, p.name_ta)}>{p.mobile ?? ''}</option>)}
          </datalist>
          {open && (
            <p className="hint">
              {t('sales.receipts.owes')}: <b className={open.balancePaise > 0 ? 'owed' : ''}>{formatRs(open.balancePaise)}</b>
              {open.advancePaise > 0 && <> · {t('sales.receipts.advanceWithUs')}: <b>{formatRs(open.advancePaise)}</b></>}
            </p>
          )}
        </div>
        <div className="field num amount-field">
          <label htmlFor="rc-amount">{t('sales.receipts.amountReceived')}</label>
          <input id="rc-amount" inputMode="decimal" autoComplete="off" value={amount} autoFocus={!!partyId} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
        <div className="field">
          <span className="label" id="rc-mode">{t('sales.mode')}</span>
          <div className="seg" role="group" aria-labelledby="rc-mode">
            {MODES.map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`bill.modes.${m}`)}</button>)}
          </div>
        </div>
        <div className="field ref-field">
          <label htmlFor="rc-ref">{mode === 'cheque' ? t('sales.receipts.chequeNo') : t('sales.receipts.reference')}</label>
          <input id="rc-ref" value={reference} maxLength={60} autoComplete="off" onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="field date-field">
          <label htmlFor="rc-date">{t('sales.receipts.date')}</label>
          <input id="rc-date" type="date" value={date} max={todayLocal()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
      </div>

      {note && <p className="saved-note" role="status">{note}</p>}
      {party && open && (
        <section className="open-bills" aria-labelledby="ob-title">
          <div className="section-head">
            <h2 id="ob-title">{t('sales.receipts.openBills')}</h2>
            {bills.length > 0 && (
              <button type="button" className="link" disabled={!manual} onClick={() => setManual(null)}>{t('sales.receipts.auto')}</button>
            )}
          </div>
          {bills.length === 0 && open.openingDuePaise === 0 && <p className="empty">{t('sales.receipts.noOpenBills')}</p>}
          {(bills.length > 0 || open.openingDuePaise > 0) && (
            <table className="grid compact sales-grid">
              <thead>
                <tr><th>{t('sales.receipts.bill')}</th><th className="r">{t('sales.receipts.billTotal')}</th><th className="r">{t('sales.receipts.left')}</th><th className="r">{t('sales.receipts.against')}</th></tr>
              </thead>
              <tbody>
                {open.openingDuePaise > 0 && (
                  <tr>
                    <td>{t('sales.receipts.opening')}<span className="sub">{t('sales.receipts.openingHelp')}</span></td>
                    <td className="r">—</td>
                    <td className="r owed"><span className="m-label">{t('sales.receipts.left')}: </span>{formatRs(open.openingDuePaise)}</td>
                    <td className="r"><span className="m-label">{t('sales.receipts.against')}: </span>{preview ? formatRs(preview.toOpeningPaise) : '—'}</td>
                  </tr>
                )}
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <span className="mono">{b.docNo}</span>
                      <span className="sub">{dmy(b.date)} · {b.overdueDays > 0 ? <span className="late">{t('sales.receipts.late', { n: b.overdueDays })}</span> : (b.daysOld === 0 ? t('sales.receipts.today') : t('sales.receipts.daysOld', { count: b.daysOld }))}</span>
                    </td>
                    <td className="r">{formatRs(b.totalPaise)}{(b.paidPaise > 0 || b.returnedPaise > 0) && <span className="sub">{t('sales.receipts.paidSoFar', { amount: formatRs(b.paidPaise + b.returnedPaise) })}</span>}</td>
                    <td className="r"><span className="m-label">{t('sales.receipts.left')}: </span>{formatRs(b.balancePaise)}</td>
                    <td className="r"><span className="m-label">{t('sales.receipts.against')}: </span><input className="num" inputMode="decimal" aria-label={t('sales.receipts.againstBill', { no: b.docNo })} value={allocFor(b.id)} placeholder="0.00" onChange={(e) => setAlloc(b.id, e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {isOwner && open.advancePaise > 0 && bills.length > 0 && (
            <p className="hint">{t('sales.receipts.advanceHint', { amount: formatRs(open.advancePaise) })} <button type="button" className="link" onClick={() => void applyAdvance()}>{t('sales.receipts.applyAdvance')}</button></p>
          )}
        </section>
      )}

      {preview && (
        <dl className="receipt-sum">
          {preview.toOpeningPaise > 0 && <div><dt>{t('sales.receipts.toOpening')}</dt><dd>{formatRs(preview.toOpeningPaise)}</dd></div>}
          <div><dt>{t('sales.receipts.toBills')}</dt><dd>{formatRs(preview.allocations.reduce((a, x) => a + x.amountPaise, 0))}</dd></div>
          {preview.advancePaise > 0 && <div><dt>{t('sales.receipts.keptAsAdvance')}</dt><dd>{formatRs(preview.advancePaise)}</dd></div>}
          <div className="strong"><dt>{t('sales.receipts.balanceAfter')}</dt><dd>{formatRs(preview.balanceAfterPaise)}</dd></div>
        </dl>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="form-actions">
        {amountPaise != null && amountPaise > 0 && <p className="words-line">{amountInWords(amountPaise, ui === 'ta' ? 'ta' : 'en')}</p>}
        <button type="submit" className="btn primary" disabled={!input || !preview || saving}>{saving ? t('sales.saving') : t('sales.receipts.save')}</button>
      </div>
    </form>
  );
}

/** Small printable receipt (A5 portrait), labels in the customer's language like the bill. */
function ReceiptPrint({ id }: { id: string }) {
  const { t: tUi } = useTranslation();
  const { me } = useApp();
  const [d, setD] = useState<ReceiptDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { sales.receipt(id).then(setD).catch((e) => setError((e as Error).message)); }, [id]);
  useEffect(() => { if (d) document.title = d.receipt.doc_no.replace(/\//g, '-'); }, [d]);
  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!d) return null;
  const { receipt: r, allocations, settings: s } = d;
  const enabled = (s['app.languages'] ?? 'en').split(',');
  const partyLang = r.lang;
  const lang = partyLang && enabled.includes(partyLang) ? partyLang : s['invoice.default_lang'] ?? 'en';
  const labelLangs = s['invoice.label_mode'] === 'bilingual' ? [lang, ...enabled.filter((l) => l !== lang)] : [lang];
  const t = (key: string, opts?: Record<string, unknown>) => [...new Set(labelLangs.map((l) => String(tFor(l)(key, opts))))].join(' / ');
  const shop = nameIn(lang, s['business.name_en'] ?? '', s['business.name_ta']);
  const allocated = allocations.reduce((a, x) => a + Number(x.amount_paise), 0);
  return (
    <div className="print-doc receipt-page" lang={lang}>
      <style>{'@page { size: A5 portrait; margin: 0; }'}</style>
      <div className="doc-actions no-print">
        <a className="btn" href="#/receipts">{tUi('sales.receipts.backToList')}</a>
        {me?.role !== 'viewer' && <a className="btn" href="#/receipts/new">{tUi('sales.receipts.another')}</a>}
        <button type="button" className="btn primary" onClick={() => window.print()}>{tUi('sales.printBtn')}</button>
      </div>
      <article className="receipt-doc">
        {r.status === 'cancelled' && <div className="stamp">{t('invoice.cancelled')}</div>}
        <header className="doc-head">
          <div>
            <h1>{shop}</h1>
            <p>{s['business.address']}</p>
            <p>{s['business.phone'] && <>{t('invoice.phone')}: {s['business.phone']} &nbsp;</>}{s['gst.gstin'] && <>{t('invoice.gstin')}: {s['gst.gstin']}</>}</p>
          </div>
          <div className="doc-title">
            <h2>{t('sales.rp.title')}</h2>
            <table className="kv"><tbody>
              <tr><th>{t('sales.rp.no')}</th><td className="mono"><b>{r.doc_no}</b></td></tr>
              <tr><th>{t('invoice.date')}</th><td>{dmy(r.doc_date)}</td></tr>
            </tbody></table>
          </div>
        </header>
        <p className="rp-line">{t('sales.rp.from')}: <b>{nameIn(lang, r.name_en, r.name_ta)}</b>{r.mobile && <> · {r.mobile}</>}</p>
        <div className="rp-amount">
          <span className="rp-figure">{formatRs(r.amount_paise)}</span>
          <span className="rp-words">{amountInWords(r.amount_paise, lang === 'ta' ? 'ta' : 'en')}</span>
        </div>
        <p className="rp-line">{t('sales.rp.by')}: <b>{t(`bill.modes.${r.mode}`)}</b>{r.reference && <> · {r.reference}</>}</p>
        {allocations.length > 0 && (
          <table className="rp-bills">
            <thead><tr><th>{t('sales.rp.towards')}</th><th>{t('invoice.date')}</th><th className="r">{t('sales.rp.billAmount')}</th><th className="r">{t('sales.rp.paidNow')}</th></tr></thead>
            <tbody>
              {allocations.map((a) => (
                <tr key={a.bill_id}><td className="mono">{a.doc_no}</td><td>{dmy(a.doc_date)}</td><td className="r">{formatRs(Number(a.total_paise))}</td><td className="r">{formatRs(Number(a.amount_paise))}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {r.amount_paise > allocated && <p className="rp-line">{t('sales.rp.onAccount')}: <b>{formatRs(r.amount_paise - allocated)}</b></p>}
        <p className="rp-line">{t('sales.rp.balance')}: <b>{formatRs(d.balanceNowPaise)}</b></p>
        <div className="sign">
          <p>{[...new Set(labelLangs.map((l) => String(tFor(l)('invoice.for', { shop: nameIn(l, s['business.name_en'] ?? '', s['business.name_ta']) }))))].join(' / ')}</p>
          <p className="sign-line">{t('invoice.signatory')}</p>
        </div>
      </article>
    </div>
  );
}
