import { formatQty, formatRs, toMilli, toPaise } from '@tula/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../App';
import { dmy, MODES, monthStartOf, rupeesText, sales, todayLocal, type Mode, type RegisterRow, type Returnable, type ReturnInput, type ReturnPreview } from '../api/sales';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import '../styles/sales.css';

// ---------------------------------------------------------------------
// Pieces shared by the sales screens (bills, receipts, outstanding, statement)
// ---------------------------------------------------------------------

export type RangeKind = 'today' | 'month' | 'custom';
export interface Range { kind: RangeKind; from: string; to: string }
export const rangeFor = (kind: RangeKind, cur?: Range): Range => {
  const today = todayLocal();
  if (kind === 'today') return { kind, from: today, to: today };
  if (kind === 'month') return { kind, from: monthStartOf(today), to: today };
  return { kind, from: cur?.from ?? monthStartOf(today), to: cur?.to ?? today };
};

/** Today / This month / Custom dates. */
export function RangePicker({ value, onChange, idPrefix }: { value: Range; onChange: (r: Range) => void; idPrefix: string }) {
  const { t } = useTranslation();
  return (
    <div className="range">
      <div className="seg" role="group" aria-label={t('sales.range.label')}>
        {(['today', 'month', 'custom'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={value.kind === k} onClick={() => onChange(rangeFor(k, value))}>{t(`sales.range.${k}`)}</button>
        ))}
      </div>
      {value.kind === 'custom' && (
        <span className="range-dates">
          <label htmlFor={`${idPrefix}-from`}>{t('sales.range.from')}</label>
          <input id={`${idPrefix}-from`} type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
          <label htmlFor={`${idPrefix}-to`}>{t('sales.range.to')}</label>
          <input id={`${idPrefix}-to`} type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
        </span>
      )}
    </div>
  );
}

/** A panel over the screen for one focused job (cancel, return). Escape or the backdrop closes it. */
export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, button:not(.sheet-close)')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={ref}>
        <div className="sheet-head">
          <h2 id="sheet-title">{title}</h2>
          <button type="button" className="icon-btn sheet-close" aria-label={t('sales.close')} onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Money typed by a person: paise, or null when the text isn't a valid amount yet. */
export const paiseOrNull = (s: string) => {
  try {
    return s.trim() ? toPaise(s) : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------
// Bills register
// ---------------------------------------------------------------------

type Chip = 'all' | 'unpaid' | 'part_paid' | 'paid' | 'returned' | 'cancelled';
const CHIPS: Chip[] = ['all', 'unpaid', 'part_paid', 'paid', 'returned', 'cancelled'];
const matchesChip = (r: RegisterRow, c: Chip) => c === 'all' || (c === 'returned' ? r.returned : r.state === c);

export function Bills(_props: ScreenProps) {
  const { t, i18n } = useTranslation();
  const { isOwner } = useApp();
  const ui = i18n.language;
  const [range, setRange] = useState<Range>(() => rangeFor('today'));
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [rows, setRows] = useState<RegisterRow[] | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [cancelling, setCancelling] = useState<RegisterRow | null>(null);
  const [returning, setReturning] = useState<RegisterRow | null>(null);
  const [note, setNote] = useState<ReactNode>(null);

  useEffect(() => {
    const h = setTimeout(() => {
      sales.register(range.from, range.to, q).then((r) => { setRows(r); setError(''); }).catch((e) => setError((e as Error).message));
    }, q ? 250 : 0);
    return () => clearTimeout(h);
  }, [range.from, range.to, q, version]);

  const shown = useMemo(() => (rows ?? []).filter((r) => matchesChip(r, chip)), [rows, chip]);
  const counts = useMemo(() => Object.fromEntries(CHIPS.map((c) => [c, (rows ?? []).filter((r) => matchesChip(r, c)).length])) as Record<Chip, number>, [rows]);
  const total = shown.filter((r) => r.status === 'active').reduce((a, r) => a + r.totalPaise - r.returnedPaise, 0);
  const due = shown.reduce((a, r) => a + r.balancePaise, 0);
  const title = range.kind === 'today' ? t('sales.bills.titleToday') : t('sales.bills.title');

  return (
    <section className="page sales">
      <div className="page-head">
        <h1>{title}</h1>
        {shown.length > 0 && (
          <span className="page-sum">
            {formatRs(total)}
            {due > 0 && <small className="sum-due">{t('sales.bills.dueOf', { amount: formatRs(due) })}</small>}
          </span>
        )}
      </div>
      <div className="toolbar">
        <RangePicker value={range} onChange={setRange} idPrefix="bills" />
        <input className="search" type="search" placeholder={t('sales.bills.search')} aria-label={t('sales.bills.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chips" role="group" aria-label={t('sales.status.label')}>
        {CHIPS.map((c) => (
          <button key={c} type="button" className={`chip ${c}`} aria-pressed={chip === c} onClick={() => setChip(c)}>
            {t(`sales.status.${c}`)} <span className="chip-n">{counts[c]}</span>
          </button>
        ))}
      </div>
      {note && <div className="saved-banner" role="status">{note}<button type="button" className="btn small" onClick={() => setNote(null)}>{t('sales.close')}</button></div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {rows && shown.length === 0 && <p className="empty">{rows.length === 0 && !q ? t('sales.bills.none') : t('sales.bills.noMatch')}</p>}
      {shown.length > 0 && (
        <table className="grid sales-grid bills-grid">
          <thead>
            <tr>
              <th>{t('sales.bills.no')}</th><th>{t('sales.bills.customer')}</th><th className="r">{t('sales.bills.total')}</th>
              <th className="r">{t('sales.bills.balance')}</th><th className="r actions-h"><span className="sr-only">{t('sales.bills.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'is-cancelled' : ''}>
                <td>
                  <a className="mono doc-no" href={`#/print/${r.id}`}>{r.docNo}</a>
                  <span className="sub">{dmy(r.date)}</span>
                </td>
                <td>
                  {nameIn(ui, r.name_en, r.name_ta)}
                  {r.site && <span className="sub">{r.site}</span>}
                  {r.creditNotes.map((c) => (
                    <a key={c.id} className="sub cn-link" href={`#/print/${c.id}`}>{t('sales.bills.creditNote', { no: c.docNo, amount: formatRs(c.totalPaise) })}</a>
                  ))}
                  {r.cancelReason && <span className="sub">{t('sales.bills.cancelledReason', { reason: r.cancelReason })}</span>}
                </td>
                <td className="r">{formatRs(r.totalPaise)}</td>
                <td className="r">
                  {r.status === 'cancelled' ? <span className="tag cancelled">{t('sales.status.cancelled')}</span>
                    : r.balancePaise > 0 ? <><b className="owed">{formatRs(r.balancePaise)}</b>{r.paidPaise > 0 && <span className="tag part_paid">{t('sales.status.part_paid')}</span>}</>
                      : <span className="tag paid">{t('sales.status.paid')}</span>}
                  {r.returned && r.status !== 'cancelled' && <span className="tag returned">{t('sales.status.returned')}</span>}
                </td>
                <td className="r actions">
                  <a className="btn small" href={`#/print/${r.id}`}>{t('sales.bills.print')}</a>
                  {isOwner && r.status === 'active' && <button type="button" className="btn small" onClick={() => setReturning(r)}>{t('sales.bills.return')}</button>}
                  {isOwner && r.status === 'active' && !r.returned && <button type="button" className="btn small danger" onClick={() => setCancelling(r)}>{t('sales.bills.cancel')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cancelling && (
        <CancelBill row={cancelling} onClose={() => setCancelling(null)} onDone={(msg) => { setCancelling(null); setNote(msg); setVersion((v) => v + 1); }} />
      )}
      {returning && (
        <ReturnGoods row={returning} onClose={() => setReturning(null)} onDone={(msg) => { setReturning(null); setNote(msg); setVersion((v) => v + 1); }} />
      )}
    </section>
  );
}

function CancelBill({ row, onClose, onDone }: { row: RegisterRow; onClose: () => void; onDone: (msg: ReactNode) => void }) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<Awaited<ReturnType<typeof sales.cancelCheck>> | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { sales.cancelCheck(row.id).then(setCheck).catch((e) => setError((e as Error).message)); }, [row.id]);

  const confirm = async () => {
    if (!reason.trim()) { setError(t('sales.cancel.needReason')); return; }
    setSaving(true);
    try {
      const r = await sales.cancelBill(row.id, reason.trim());
      onDone(<strong>{t('sales.cancel.done', { no: r.docNo })}{r.advanceFreedPaise > 0 && <> — {t('sales.cancel.freed', { amount: formatRs(r.advanceFreedPaise) })}</>}</strong>);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={t('sales.cancel.title', { no: row.docNo })} onClose={onClose}>
      <p className="sheet-sub">{row.partyName} · {dmy(row.date)} · {formatRs(row.totalPaise)}</p>
      {check?.earlierMonth && <p className="notice warn" role="alert">{t('sales.cancel.earlierMonth')}</p>}
      {check && !check.canCancel && <p className="field-error" role="alert">{check.blocker?.code === 'HAS_RETURN' ? t('sales.cancel.hasReturn') : check.blocker?.message}</p>}
      <p className="hint">{t('sales.cancel.help')}</p>
      {row.paidPaise > 0 && <p className="hint">{t('sales.cancel.paidHelp', { amount: formatRs(row.paidPaise) })}</p>}
      <div className="field">
        <label htmlFor="cancel-reason">{t('sales.cancel.reason')}</label>
        <input id="cancel-reason" value={reason} maxLength={300} placeholder={t('sales.cancel.reasonPlaceholder')} onChange={(e) => { setReason(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void confirm(); }} />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>{t('sales.cancel.keep')}</button>
        <button type="button" className="btn danger-solid" disabled={!check?.canCancel || saving} onClick={() => void confirm()}>
          {saving ? t('sales.saving') : check?.earlierMonth ? t('sales.cancel.confirmAnyway') : t('sales.cancel.confirm')}
        </button>
      </div>
    </Sheet>
  );
}

function ReturnGoods({ row, onClose, onDone }: { row: RegisterRow; onClose: () => void; onDone: (msg: ReactNode) => void }) {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const [data, setData] = useState<Returnable | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [refundOn, setRefundOn] = useState(false);
  const [refundMode, setRefundMode] = useState<Mode>('cash');
  const [refundAmt, setRefundAmt] = useState('');
  const [preview, setPreview] = useState<ReturnPreview | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { sales.returnable(row.id).then(setData).catch((e) => setError((e as Error).message)); }, [row.id]);

  const lines = Object.entries(qty).filter(([, v]) => {
    try { return v.trim() !== '' && toMilli(v) > 0; } catch { return false; }
  }).map(([lineId, v]) => ({ lineId, qty: v.trim() }));
  const body: ReturnInput = { lines, reason: reason.trim() || '-', refund: refundOn && refundAmt.trim() ? { mode: refundMode, amount: refundAmt.trim() } : undefined };
  const key = JSON.stringify({ lines, refund: body.refund });

  useEffect(() => {
    if (!lines.length) { setPreview(null); return; }
    const h = setTimeout(() => {
      sales.returnPreview(row.id, { ...body, refund: undefined }).then((p) => { setPreview(p); setError(''); }).catch((e) => { setPreview(null); setError((e as Error).message); });
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Offer the full refundable amount by default once a refund is switched on.
  useEffect(() => { if (refundOn && preview && !refundAmt) setRefundAmt(rupeesText(preview.refundablePaise)); }, [refundOn, preview, refundAmt]);

  const save = async () => {
    if (!reason.trim()) { setError(t('sales.ret.needReason')); return; }
    setSaving(true);
    try {
      const r = await sales.saveReturn(row.id, { ...body, reason: reason.trim() });
      onDone(<>
        <strong>{t('sales.ret.saved', { no: r.docNo, amount: formatRs(r.totals.total) })}{r.refundNo && <> — {t('sales.ret.refundSaved', { no: r.refundNo })}</>}</strong>
        <a className="btn primary small" href={`#/print/${r.id}`}>{t('sales.ret.printCn')}</a>
      </>);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const unitName = (l: Returnable['lines'][number]) => nameIn(ui, l.rateUnitEn, l.rateUnitTa);
  const nothingLeft = data && data.lines.every((l) => l.returnableMilli <= 0);
  const refundable = preview?.refundablePaise ?? 0;

  return (
    <Sheet title={t('sales.ret.title', { no: row.docNo })} onClose={onClose} wide>
      <p className="sheet-sub">{row.partyName} · {dmy(row.date)} · {formatRs(row.totalPaise)}</p>
      <p className="hint">{t('sales.ret.help')}</p>
      {data && data.creditNotes.length > 0 && (
        <p className="hint">{t('sales.ret.earlier')}: {data.creditNotes.map((c) => `${c.doc_no} (${formatRs(c.total_paise)})`).join(', ')}</p>
      )}
      {nothingLeft && <p className="notice">{t('sales.ret.nothing')}</p>}
      {data && !nothingLeft && (
        <table className="grid compact return-lines">
          <thead>
            <tr><th>{t('sales.ret.item')}</th><th className="r">{t('sales.ret.sold')}</th><th className="r">{t('sales.ret.canReturn')}</th><th className="r">{t('sales.ret.qty')}</th><th className="r">{t('sales.ret.amount')}</th></tr>
          </thead>
          <tbody>
            {data.lines.map((l) => {
              const p = preview?.lines.find((x) => x.lineId === l.lineId);
              let over = false;
              try { over = !!qty[l.lineId]?.trim() && toMilli(qty[l.lineId]!) > l.returnableMilli; } catch { over = true; }
              return (
                <tr key={l.lineId} className={l.returnableMilli <= 0 ? 'inactive' : ''}>
                  <td>{l.description}<span className="sub">{formatRs(l.ratePaise)} / {unitName(l)}{l.inclusive ? ` · ${t('sales.ret.inclGst')}` : ''}</span></td>
                  <td className="r nowrap">{formatQty(l.soldMilli, { trimZeros: true })} {unitName(l)}{l.returnedMilli > 0 && <span className="sub">{t('sales.ret.already', { qty: formatQty(l.returnedMilli, { trimZeros: true }) })}</span>}</td>
                  <td className="r nowrap">{formatQty(l.returnableMilli, { trimZeros: true })}</td>
                  <td className="r">
                    <input className={`num${over ? ' bad' : ''}`} inputMode="decimal" aria-label={t('sales.ret.qtyFor', { item: l.description })} disabled={l.returnableMilli <= 0}
                      value={qty[l.lineId] ?? ''} placeholder="0" onChange={(e) => setQty((x) => ({ ...x, [l.lineId]: e.target.value.replace(/[^\d.]/g, '') }))} />
                    {l.returnableMilli > 0 && (
                      <button type="button" className="link" onClick={() => setQty((x) => ({ ...x, [l.lineId]: formatQty(l.returnableMilli, { trimZeros: true }).replace(/,/g, '') }))}>{t('sales.ret.all')}</button>
                    )}
                  </td>
                  <td className="r">{p ? formatRs(p.total) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="field">
        <label htmlFor="ret-reason">{t('sales.ret.reason')}</label>
        <input id="ret-reason" value={reason} maxLength={300} placeholder={t('sales.ret.reasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
      </div>
      {preview && (
        <div className="return-sum">
          <dl>
            <div><dt>{t('sales.ret.taxable')}</dt><dd>{formatRs(preview.totals.taxable)}</dd></div>
            <div><dt>{t('sales.ret.gst')}</dt><dd>{formatRs(preview.totals.cgst + preview.totals.sgst + preview.totals.igst)}</dd></div>
            {preview.totals.roundOff !== 0 && <div><dt>{t('sales.ret.roundOff')}</dt><dd>{formatRs(preview.totals.roundOff)}</dd></div>}
            <div className="grand-line"><dt>{t('sales.ret.total')}</dt><dd>{formatRs(preview.totals.total)}</dd></div>
            <div><dt>{t('sales.ret.billBalanceAfter')}</dt><dd>{formatRs(preview.billBalanceAfterPaise)}</dd></div>
          </dl>
          {refundable > 0 ? (
            <div className="refund">
              <label className="check"><input type="checkbox" checked={refundOn} onChange={(e) => { setRefundOn(e.target.checked); if (!e.target.checked) setRefundAmt(''); }} /> {t('sales.ret.refund', { amount: formatRs(refundable) })}</label>
              {refundOn && (
                <div className="refund-row">
                  <div className="field num">
                    <label htmlFor="refund-amt">{t('sales.ret.refundAmount')}</label>
                    <input id="refund-amt" inputMode="decimal" value={refundAmt} onChange={(e) => setRefundAmt(e.target.value.replace(/[^\d.]/g, ''))} />
                  </div>
                  <div className="field">
                    <span className="label" id="refund-mode">{t('sales.mode')}</span>
                    <div className="seg" role="group" aria-labelledby="refund-mode">
                      {MODES.map((m) => <button key={m} type="button" aria-pressed={refundMode === m} onClick={() => setRefundMode(m)}>{t(`bill.modes.${m}`)}</button>)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : <p className="hint">{t('sales.ret.noRefund')}</p>}
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>{t('sales.cancelBtn')}</button>
        <button type="button" className="btn primary" disabled={!preview || saving || !lines.length} onClick={() => void save()}>{saving ? t('sales.saving') : t('sales.ret.save')}</button>
      </div>
    </Sheet>
  );
}
