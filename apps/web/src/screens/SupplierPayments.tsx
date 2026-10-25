import { formatRs, toPaise } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Party } from '../api';
import { daysAgo, PAY_MODES, purchasesApi, showDate, today, type PayMode, type PaymentInput, type PaymentPreview, type PaymentRow, type Payables } from '../api/purchases';
import { useApp } from '../App';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import { CancelDialog, DateRange, Num } from './Purchases';
import '../styles/purchases.css';

const errText = (e: unknown, network: string) => (e instanceof ApiError && e.status === 0 ? network : (e as Error).message);

export function SupplierPayments({ id }: ScreenProps) {
  if (id) return <NewPayment supplierId={id === 'new' ? undefined : id} />;
  return <PaymentsHome />;
}

function PaymentsHome() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner } = useApp();
  const [payables, setPayables] = useState<Payables | null>(null);
  const [range, setRange] = useState({ from: daysAgo(30), to: today() });
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<PaymentRow | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => { purchasesApi.payables().then(setPayables).catch((e) => setError(errText(e, t('purchases.common.network')))); }, [version, t]);
  useEffect(() => { purchasesApi.payments(range.from, range.to).then((r) => setRows(r.rows)).catch((e) => setError(errText(e, t('purchases.common.network')))); }, [range, version, t]);

  return (
    <div className="stack">
      <section className="page">
        <div className="page-head">
          <h1>{t('purchases.pay.payables')}</h1>
          {isOwner && <a className="btn primary" href="#/payments/new">+ {t('purchases.pay.new')}</a>}
        </div>
        {!isOwner && <p className="hint">{t('purchases.common.readOnly')}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        {payables && <>
          <ul className="pu-chips">
            <li><span className="k">{t('purchases.pay.owed')}</span><span className="v">{formatRs(payables.totals.owedPaise)}</span></li>
            <li className={payables.totals.overduePaise > 0 ? 'danger' : ''}><span className="k">{t('purchases.pay.overdue')}</span><span className="v">{formatRs(payables.totals.overduePaise)}</span></li>
            <li className={payables.totals.dueSoonPaise > 0 ? 'mark' : ''}><span className="k">{t('purchases.pay.dueSoon')}</span><span className="v">{formatRs(payables.totals.dueSoonPaise)}</span></li>
          </ul>
          {payables.suppliers.length === 0 && <p className="empty">{t('purchases.pay.nothingOwed')}</p>}
          {payables.suppliers.map((s) => (
            <details key={s.id} className="pu-supplier" open={s.overduePaise > 0 || payables.suppliers.length <= 3}>
              <summary>
                <span className="name">{nameIn(ui, s.name_en, s.name_ta)}</span>
                {s.overduePaise > 0 && <span className="tag overdue">{t('purchases.pay.overdue')} {formatRs(s.overduePaise)}</span>}
                {s.dueSoonPaise > 0 && <span className="tag soon">{t('purchases.pay.dueSoon')} {formatRs(s.dueSoonPaise)}</span>}
                <span className="owed-amt">{formatRs(Math.max(0, s.owedPaise))}</span>
                {isOwner && s.owedPaise > 0 && <a className="btn small primary" href={`#/payments/${s.id}`} onClick={(e) => e.stopPropagation()}>{t('purchases.pur.pay')}</a>}
              </summary>
              <div className="pu-scroll">
                <table className="grid compact">
                  <thead><tr><th>{t('purchases.pur.ourNo')}</th><th>{t('purchases.pur.billNo')}</th><th>{t('purchases.pur.dueDate')}</th><th className="r">{t('purchases.common.total')}</th><th className="r">{t('purchases.pur.due')}</th></tr></thead>
                  <tbody>
                    {s.bills.map((b) => (
                      <tr key={b.id} className={b.state}>
                        <td><a href={`#/purchases/${b.id}`}>{b.doc_no}</a><span className="sub">{showDate(b.doc_date)}</span></td>
                        <td className="mono">{b.supplier_bill_no}</td>
                        <td className="due-col">{showDate(b.due_date)}{b.overdueDays > 0 && <span className="sub">{t('purchases.pay.daysLate', { days: b.overdueDays })}</span>}</td>
                        <td className="r">{formatRs(b.total_paise)}</td>
                        <td className="r">{formatRs(b.due_paise)}</td>
                      </tr>
                    ))}
                    {s.onAccountPaise !== 0 && (
                      <tr><td colSpan={4}>{s.onAccountPaise > 0 ? t('purchases.pay.onAccount') : t('purchases.pay.advance')}</td><td className="r">{formatRs(s.onAccountPaise)}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </>}
      </section>

      <section className="page">
        <div className="page-head"><h1>{t('purchases.pay.list')}</h1></div>
        <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
        {rows && rows.length === 0 && <p className="empty">{t('purchases.common.none')}</p>}
        {rows && rows.length > 0 && (
          <div className="pu-scroll">
            <table className="grid">
              <thead><tr>
                <th>{t('purchases.common.date')}</th><th>{t('purchases.common.no')}</th><th>{t('purchases.common.supplier')}</th>
                <th>{t('purchases.common.mode')}</th><th className="r">{t('purchases.common.amount')}</th>{isOwner && <th />}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.status === 'cancelled' ? 'cancelled' : ''}>
                    <td className="mono">{showDate(r.doc_date)}</td>
                    <td className="mono">{r.doc_no}</td>
                    <td>{nameIn(ui, r.party_en, r.party_ta)}<span className="sub">{r.bills ? `${t('purchases.pay.allocated')}: ${r.bills}` : r.status === 'active' ? t('purchases.pay.advance') : ''}</span></td>
                    <td>{t(`purchases.modes.${r.mode}`)}{r.reference && <span className="sub mono">{r.reference}</span>}</td>
                    <td className="r">{formatRs(r.amount_paise)}</td>
                    {isOwner && <td className="r">{r.status === 'active' ? <button type="button" className="btn small" onClick={() => setCancelling(r)}>{t('purchases.common.cancel')}</button> : t('purchases.common.cancelled')}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {cancelling && (
        <CancelDialog title={t('purchases.pay.cancelTitle', { no: cancelling.doc_no })} help={t('purchases.pay.cancelHelp')} placeholder={t('purchases.pay.cancelReasonPh')} action={t('purchases.pay.cancelDo')}
          onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); setVersion((v) => v + 1); }}
          run={(reason) => purchasesApi.cancelPayment(cancelling.id, reason)} />
      )}
    </div>
  );
}

function NewPayment({ supplierId }: { supplierId?: string }) {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner } = useApp();
  const [suppliers, setSuppliers] = useState<Party[] | null>(null);
  const [partyId, setPartyId] = useState(supplierId ?? '');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PayMode>('cash');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [manual, setManual] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    api.parties().then((p) => setSuppliers(p.filter((x) => x.party_type !== 'customer' && !x.is_walk_in))).catch((e) => setError(errText(e, t('purchases.common.network'))));
  }, [saved, t]);
  const supplier = useMemo(() => suppliers?.find((s) => s.id === partyId), [suppliers, partyId]);

  const amountOk = (() => { try { return amount.trim() !== '' && toPaise(amount) > 0; } catch { return false; } })();
  const input: PaymentInput | null = partyId && amountOk ? {
    supplierId: partyId, amount, mode, date, reference: reference.trim() || undefined, notes: notes.trim() || undefined,
    allocations: manual ? Object.entries(alloc).filter(([, v]) => v.trim()).map(([purchaseId, a]) => ({ purchaseId, amount: a })) : undefined,
  } : null;
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!input) { setPreview(null); return; }
    const h = setTimeout(() => {
      purchasesApi.paymentPreview(input).then((p) => { setPreview(p); setError(''); }).catch((e) => setError(errText(e, t('purchases.common.network'))));
    }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const startManual = () => {
    setManual(true);
    setAlloc(Object.fromEntries((preview?.allocations ?? []).map((a) => [a.purchaseId, (a.amountPaise / 100).toFixed(2)])));
  };
  const save = async () => {
    if (!input) return;
    setSaving(true);
    try {
      const r = await purchasesApi.pay(input);
      setSaved(r.docNo);
      setAmount(''); setReference(''); setNotes(''); setManual(false); setAlloc({}); setPreview(null);
    } catch (e) {
      setError(errText(e, t('purchases.common.network')));
    } finally {
      setSaving(false);
    }
  };

  if (!isOwner) return <section className="page"><p className="hint">{t('purchases.common.readOnly')}</p></section>;
  const allocBy = new Map((preview?.allocations ?? []).map((a) => [a.purchaseId, a.amountPaise]));
  return (
    <form className="page pu-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head">
        <h1>{t('purchases.pay.new')}</h1>
        <a className="btn" href="#/payments">{t('purchases.common.back')}</a>
      </div>
      {saved && <p className="saved-banner" role="status"><strong>{t('purchases.pay.saved', { no: saved })}</strong></p>}
      <div className="pu-pay-grid">
        <div>
          <div className="form-grid">
            <div className="field wide">
              <label htmlFor="pay-sup">{t('purchases.common.supplier')}</label>
              <select id="pay-sup" value={partyId} onChange={(e) => { setPartyId(e.target.value); setManual(false); setAlloc({}); }}>
                <option value="">{t('purchases.pur.pickSupplier')}</option>
                {(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{nameIn(ui, s.name_en, s.name_ta)}{s.balance_paise < 0 ? ` — ${formatRs(-s.balance_paise)}` : ''}</option>)}
              </select>
            </div>
            <Num id="pay-amt" label={t('purchases.pay.amount')} value={amount} onChange={setAmount} />
            <div className="field"><label htmlFor="pay-date">{t('purchases.common.date')}</label>
              <input id="pay-date" type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
            <div className="field wide">
              <span className="label" id="pay-mode">{t('purchases.common.mode')}</span>
              <div className="seg" role="group" aria-labelledby="pay-mode">
                {PAY_MODES.map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`purchases.modes.${m}`)}</button>)}
              </div>
            </div>
            <div className="field"><label htmlFor="pay-ref">{t('purchases.common.reference')}</label>
              <input id="pay-ref" value={reference} maxLength={40} onChange={(e) => setReference(e.target.value)} /></div>
            <div className="field wide"><label htmlFor="pay-notes">{t('purchases.common.notes')}</label>
              <input id="pay-notes" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>

          {supplier && preview && (
            <div className="pu-alloc">
              <h2>{t('purchases.pay.settles')}</h2>
              {preview.openBills.length === 0 ? <p className="hint">{t('purchases.pay.noOpenBills')}</p> : <>
                <div className="pu-scroll">
                  <table className="grid compact">
                    <thead><tr><th>{t('purchases.pur.ourNo')}</th><th>{t('purchases.pur.dueDate')}</th><th className="r">{t('purchases.pay.dueBefore')}</th><th className="r">{t('purchases.pay.pays')}</th></tr></thead>
                    <tbody>
                      {preview.openBills.map((b) => (
                        <tr key={b.id} className={b.due_date && b.due_date < today() ? 'overdue' : ''}>
                          <td>{b.doc_no}<span className="sub mono">{b.supplier_bill_no}</span></td>
                          <td className="due-col">{showDate(b.due_date)}</td>
                          <td className="r">{formatRs(b.due_paise)}</td>
                          <td className="r">{manual
                            ? <input className="num" inputMode="decimal" aria-label={`${t('purchases.pay.pays')} ${b.doc_no}`} value={alloc[b.id] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [b.id]: e.target.value.replace(/[^\d.]/g, '') }))} />
                            : allocBy.get(b.id) ? <b>{formatRs(allocBy.get(b.id)!)}</b> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button type="button" className="link" onClick={() => (manual ? (setManual(false), setAlloc({})) : startManual())}>{manual ? t('purchases.pay.autoBills') : t('purchases.pay.chooseBills')}</button>
              </>}
            </div>
          )}
        </div>
        <aside className="totals" aria-live="polite">
          <dl>
            <div><dt>{t('purchases.pay.owedBefore')}</dt><dd>{supplier ? formatRs(Math.max(0, -supplier.balance_paise)) : '—'}</dd></div>
            <div><dt>{t('purchases.common.amount')}</dt><dd>{preview ? formatRs(preview.amountPaise) : '—'}</dd></div>
            <div><dt>{t('purchases.pay.owedAfter')}</dt><dd>{preview ? formatRs(Math.max(0, preview.owedAfter)) : '—'}</dd></div>
          </dl>
          {preview && preview.advancePaise > 0 && <p className="notice">{t('purchases.pay.advanceNote', { amount: formatRs(preview.advancePaise) })}</p>}
          {error && <p className="field-error" role="alert">{error}</p>}
          <button type="submit" className="btn primary big" disabled={!input || !preview || saving}>{saving ? t('purchases.common.saving') : t('purchases.pay.save')}</button>
        </aside>
      </div>
    </form>
  );
}
