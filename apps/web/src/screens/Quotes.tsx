import { formatRs } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api';
import { useApp } from '../App';
import { dmy } from '../api/sales';
import { quotesApi, type ConvertPreview, type QuoteInfo, type QuoteRow, type QuoteState } from '../api/quotes';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import { NewBill } from './NewBill';
import { RangePicker, rangeFor, Sheet, type Range } from './Bills';
import '../styles/sales.css';
import '../styles/quotes.css';

/** #/quote: the bill screen making a quotation. */
export function NewQuote({ ratesVersion }: ScreenProps) {
  return <NewBill ratesVersion={ratesVersion} mode="quote" />;
}

type Chip = 'all' | QuoteState;
const CHIPS: Chip[] = ['all', 'open', 'expired', 'converted', 'cancelled'];

/** #/quotes: quotations, what became of them, and "Make bill". */
export function Quotes(_props: ScreenProps) {
  const { t } = useTranslation();
  const { me } = useApp();
  const canBill = me?.role !== 'viewer';
  const [range, setRange] = useState<Range>(() => rangeFor('month'));
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [rows, setRows] = useState<QuoteRow[] | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [converting, setConverting] = useState<QuoteRow | null>(null);

  useEffect(() => {
    const h = setTimeout(() => {
      quotesApi.list({ from: range.from, to: range.to, q }).then((r) => { setRows(r); setError(''); }).catch((e) => setError((e as Error).message));
    }, q ? 250 : 0);
    return () => clearTimeout(h);
  }, [range.from, range.to, q, version]);

  const shown = useMemo(() => (rows ?? []).filter((r) => chip === 'all' || r.state === chip), [rows, chip]);
  const counts = useMemo(() => Object.fromEntries(CHIPS.map((c) => [c, (rows ?? []).filter((r) => c === 'all' || r.state === c).length])) as Record<Chip, number>, [rows]);

  const cancel = async (r: QuoteRow) => {
    if (!window.confirm(t('quotes.confirmCancel', { no: r.docNo }))) return;
    try {
      await quotesApi.cancel(r.id);
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="page sales">
      <div className="page-head">
        <h1>{t('quotes.title')}</h1>
        {canBill && <a className="btn primary" href="#/quote">{t('quotes.new')}</a>}
      </div>
      <p className="hint">{t('quotes.help')}</p>
      <div className="toolbar">
        <RangePicker value={range} onChange={setRange} idPrefix="quotes" />
        <input className="search" type="search" placeholder={t('quotes.search')} aria-label={t('quotes.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chips" role="group" aria-label={t('quotes.stateLabel')}>
        {CHIPS.map((c) => (
          <button key={c} type="button" className={`chip ${c}`} aria-pressed={chip === c} onClick={() => setChip(c)}>
            {t(`quotes.state.${c}`)} <span className="chip-n">{counts[c]}</span>
          </button>
        ))}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {rows && shown.length === 0 && <p className="empty">{rows.length === 0 && !q ? t('quotes.none') : t('quotes.noMatch')}</p>}
      {shown.length > 0 && (
        <div className="scroll-x">
          <table className="grid sales-grid">
            <thead><tr><th>{t('quotes.no')}</th><th>{t('quotes.customer')}</th><th className="r">{t('quotes.total')}</th><th>{t('quotes.stateLabel')}</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.state === 'cancelled' ? 'cancelled' : ''}>
                  <td><a className="mono doc-no" href={`#/print/${r.id}`}>{r.docNo}</a><span className="sub">{dmy(r.date)}</span></td>
                  <td>{r.party}{r.site && <span className="sub">{r.site}</span>}</td>
                  <td className="r">{formatRs(r.totalPaise)}</td>
                  <td>
                    <span className={`state ${r.state}`}>{t(`quotes.state.${r.state}`)}</span>
                    {r.bill && <a className="sub mono" href={`#/print/${r.bill.id}`}>{t('quotes.billNo', { no: r.bill.docNo })}</a>}
                    {r.validUntil && r.state === 'open' && <span className="sub">{t('quotes.validTill', { date: dmy(r.validUntil) })}</span>}
                  </td>
                  <td className="actions">
                    {canBill && (r.state === 'open' || r.state === 'expired') && (
                      <>
                        <button type="button" className="btn small primary" onClick={() => setConverting(r)}>{t('quotes.makeBill')}</button>
                        <button type="button" className="btn small" onClick={() => void cancel(r)}>{t('quotes.cancel')}</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {converting && <ConvertSheet id={converting.id} docNo={converting.docNo} onClose={() => setConverting(null)} />}
    </section>
  );
}

/** Make a bill from a quotation: today's rates (or the quoted ones), then the bill opens for printing. */
export function ConvertSheet({ id, docNo, onClose }: { id: string; docNo: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [keep, setKeep] = useState(false);
  const [pv, setPv] = useState<ConvertPreview | null>(null);
  const [held, setHeld] = useState<{ warnings: string[]; blocked: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setHeld(null);
    quotesApi.convertPreview(id, keep).then((p) => { setPv(p); setError(''); }).catch((e) => setError((e as Error).message));
  }, [id, keep]);

  const make = async (confirm: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await quotesApi.convert(id, keep, confirm);
      if (!r.saved) { setHeld({ warnings: r.warnings.map((w) => w.message), blocked: !!r.blocked }); return; }
      location.hash = `#/print/${r.id}`;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changed = pv?.lines.some((l) => l.ratePaise !== l.quotedRatePaise);
  return (
    <Sheet title={t('quotes.convertTitle', { no: docNo })} onClose={onClose}>
      <p className="hint">{t('quotes.convertHelp')}</p>
      <label className="check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> {t('quotes.keepRates')}
      </label>
      {pv && (
        <div className="scroll-x">
          <table className="grid compact">
            <thead><tr><th>{t('quotes.item')}</th><th className="r">{t('quotes.quotedRate')}</th><th className="r">{t('quotes.billRate')}</th><th className="r">{t('quotes.amount')}</th></tr></thead>
            <tbody>
              {pv.lines.map((l, i) => (
                <tr key={i}>
                  <td>{nameIn(i18n.language, l.name_en, l.name_ta)}</td>
                  <td className="r">{formatRs(l.quotedRatePaise)}</td>
                  <td className={`r${l.ratePaise !== l.quotedRatePaise ? ' changed' : ''}`}>{formatRs(l.ratePaise)}</td>
                  <td className="r">{formatRs(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pv && <p className="big-total">{t('quotes.billTotal')}: <b>{formatRs(pv.totals.total)}</b></p>}
      {changed && !keep && <p className="notice">{t('quotes.ratesChanged')}</p>}
      {held && (
        <div className="held" role="alert">
          <strong>{held.blocked ? t('bill.blocked') : t('bill.checkFirst')}</strong>
          <ul>{held.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="form-actions">
        {held && !held.blocked
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => void make(true)}>{t('bill.saveAnyway')}</button>
          : <button type="button" className="btn primary" disabled={busy || !pv || !!held?.blocked} onClick={() => void make(false)}>{busy ? t('bill.saving') : t('quotes.makeBill')}</button>}
        <button type="button" className="btn" onClick={onClose}>{t('quotes.close')}</button>
      </div>
    </Sheet>
  );
}

/** On a printed quotation (Invoice view): what became of it, and Make bill / Cancel for staff. */
export function QuoteActions({ id, docNo }: { id: string; docNo: string }) {
  const { t } = useTranslation();
  const { me } = useApp();
  const [info, setInfo] = useState<QuoteInfo | null>(null);
  const [converting, setConverting] = useState(false);
  useEffect(() => { quotesApi.info(id).then(setInfo).catch(() => setInfo(null)); }, [id]);
  if (!info) return null;
  const canBill = me?.role !== 'viewer' && (info.state === 'open' || info.state === 'expired');
  return (
    <>
      {info.bill && <a className="btn" href={`#/print/${info.bill.id}`}>{t('quotes.billNo', { no: info.bill.docNo })}</a>}
      {info.state === 'cancelled' && <span className="state cancelled">{t('quotes.state.cancelled')}</span>}
      {canBill && <button type="button" className="btn" onClick={() => setConverting(true)}>{t('quotes.makeBill')}</button>}
      {converting && <ConvertSheet id={id} docNo={docNo} onClose={() => setConverting(false)} />}
    </>
  );
}
