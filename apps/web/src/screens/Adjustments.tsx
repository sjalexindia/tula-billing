import { formatQty, formatRs, roundDiv, toBaseMilli, toMilli } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type CatalogItem } from '../api';
import { ADJ_REASONS, daysAgo, purchasesApi, showDate, today, type AdjReason, type AdjustmentInput, type AdjustmentRow } from '../api/purchases';
import { useApp } from '../App';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import { DateRange, Num } from './Purchases';
import '../styles/purchases.css';

const errText = (e: unknown, network: string) => (e instanceof ApiError && e.status === 0 ? network : (e as Error).message);

export function Adjustments({ id }: ScreenProps) {
  if (id === 'new') return <NewAdjustment />;
  return <AdjustmentList />;
}

function AdjustmentList() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner } = useApp();
  const [range, setRange] = useState({ from: daysAgo(30), to: today() });
  const [rows, setRows] = useState<AdjustmentRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    purchasesApi.adjustments(range.from, range.to).then((r) => { setRows(r.rows); setError(''); }).catch((e) => setError(errText(e, t('purchases.common.network'))));
  }, [range, t]);
  const total = (rows ?? []).reduce((a, r) => a + r.value_paise, 0);
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('purchases.adj.title')}</h1>
        {isOwner && <a className="btn primary" href="#/adjustments/new">+ {t('purchases.adj.new')}</a>}
      </div>
      {!isOwner && <p className="hint">{t('purchases.common.readOnly')}</p>}
      <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      {error && <p className="field-error" role="alert">{error}</p>}
      {rows && rows.length === 0 && <p className="empty">{t('purchases.common.none')}</p>}
      {rows && rows.length > 0 && <>
        <ul className="pu-chips">
          <li className={total < 0 ? 'danger' : ''}><span className="k">{total < 0 ? t('purchases.adj.loss') : t('purchases.adj.gain')}</span><span className="v">{formatRs(Math.abs(total))}</span></li>
        </ul>
        <div className="pu-scroll">
          <table className="grid">
            <thead><tr>
              <th>{t('purchases.common.date')}</th><th>{t('purchases.common.no')}</th><th>{t('purchases.adj.reason')}</th>
              <th>{t('purchases.common.item')}</th><th className="r">{t('purchases.adj.change')}</th><th className="r">{t('purchases.common.value')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => r.lines.map((l, i) => (
                <tr key={`${r.id}-${l.product_id}`}>
                  {i === 0 && <>
                    <td rowSpan={r.lines.length} className="mono">{showDate(r.doc_date)}</td>
                    <td rowSpan={r.lines.length} className="mono">{r.doc_no}{r.approved_by_name && <span className="sub">{t('purchases.adj.approved', { name: r.approved_by_name })}</span>}</td>
                    <td rowSpan={r.lines.length}>{t(`purchases.adj.reasons.${r.reason}`)}{r.notes && <span className="sub">{r.notes}</span>}</td>
                  </>}
                  <td><a href={`#/stock/${l.product_id}`}>{nameIn(ui, l.name_en, l.name_ta)}</a>
                    {l.counted_milli != null && <span className="sub">{t('purchases.adj.system')} {formatQty(l.system_milli ?? 0, { trimZeros: true })} → {t('purchases.adj.counted')} {formatQty(l.counted_milli, { trimZeros: true })}</span>}</td>
                  <td className={`r ${l.qty_milli < 0 ? 'neg' : 'pos'}`}>{l.qty_milli > 0 ? '+' : ''}{formatQty(l.qty_milli, { trimZeros: true })} {nameIn(ui, l.base_unit_en, l.base_unit_ta)}</td>
                  <td className={`r ${l.value_paise < 0 ? 'neg' : ''}`}>{formatRs(l.value_paise)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </>}
    </section>
  );
}

interface LineState { key: number; sku: string; qty: Record<string, string>; sign: -1 | 1 }
let seq = 1;
const emptyLine = (): LineState => ({ key: seq++, sku: '', qty: {}, sign: -1 });

function NewAdjustment() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner } = useApp();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [avg, setAvg] = useState<Map<string, number>>(new Map());
  const [reason, setReason] = useState<AdjReason>('count');
  const [mode, setMode] = useState<'change' | 'count'>('count');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineState[]>([emptyLine()]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ no: string; value: number } | null>(null);

  useEffect(() => {
    Promise.all([api.catalog(), purchasesApi.valuation()])
      .then(([c, v]) => { setCatalog(c.filter((p) => p.trackStock)); setAvg(new Map(v.items.map((i) => [i.product_id, i.avg_cost_paise]))); })
      .catch((e) => setError(errText(e, t('purchases.common.network'))));
  }, [saved, t]);
  const bySku = useMemo(() => new Map(catalog.map((p) => [p.sku, p])), [catalog]);
  const update = (k: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  /** Typed boxes to base-unit thousandths (null when nothing usable is typed). */
  const baseOf = (l: LineState, p: CatalogItem): number | null => {
    try {
      const entry: Record<string, number> = {};
      for (const [k, v] of Object.entries(l.qty)) if (v.trim()) entry[k] = toMilli(v);
      if (!Object.keys(entry).length) return null;
      return toBaseMilli(entry, p.units.map((u) => ({ unitCode: u.code, factorMilli: u.factorMilli })), p.baseUnit);
    } catch {
      return null;
    }
  };
  const calc = lines.map((l) => {
    const p = bySku.get(l.sku);
    if (!p) return { l, p, change: null as number | null };
    const q = baseOf(l, p);
    const change = q == null ? null : mode === 'count' ? q - (p.stockMilli ?? 0) : l.sign * q;
    return { l, p, change };
  });
  const ready = calc.filter((c) => c.p && c.change != null && c.change !== 0);
  const totalValue = ready.reduce((a, c) => a + roundDiv(c.change! * (avg.get(c.p!.id) ?? 0), 1000), 0);

  const save = async () => {
    if (reason === 'other' && !notes.trim()) { setError(t('purchases.adj.notesRequired')); return; }
    if (!ready.length) { setError(t('purchases.adj.nothing')); return; }
    const body: AdjustmentInput = {
      date, reason, notes: notes.trim() || undefined,
      lines: ready.map(({ l, p }) => {
        const entry = Object.fromEntries(Object.entries(l.qty).filter(([, v]) => v.trim()).map(([k, v]) => [k, mode === 'change' && l.sign < 0 ? `-${v}` : v]));
        return mode === 'count' ? { productId: p!.id, counted: entry } : { productId: p!.id, change: entry };
      }),
    };
    setSaving(true);
    try {
      const r = await purchasesApi.saveAdjustment(body);
      setSaved({ no: r.docNo, value: r.valuePaise });
      setLines([emptyLine()]); setNotes(''); setError('');
    } catch (e) {
      setError(errText(e, t('purchases.common.network')));
    } finally {
      setSaving(false);
    }
  };

  if (!isOwner) return <section className="page"><p className="hint">{t('purchases.common.readOnly')}</p></section>;
  return (
    <form className="page pu-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head">
        <h1>{t('purchases.adj.new')}</h1>
        <a className="btn" href="#/adjustments">{t('purchases.common.back')}</a>
      </div>
      {saved && <p className="saved-banner" role="status"><strong>{t('purchases.adj.saved', { no: saved.no })} {formatRs(saved.value)}</strong></p>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="adj-reason">{t('purchases.adj.reason')}</label>
          <select id="adj-reason" value={reason} onChange={(e) => { const r = e.target.value as AdjReason; setReason(r); setMode(r === 'count' ? 'count' : 'change'); }}>
            {ADJ_REASONS.map((r) => <option key={r} value={r}>{t(`purchases.adj.reasons.${r}`)}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="adj-date">{t('purchases.common.date')}</label>
          <input id="adj-date" type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
        <div className="field wide">
          <span className="label" id="adj-mode">&nbsp;</span>
          <div className="seg" role="group" aria-labelledby="adj-mode">
            <button type="button" aria-pressed={mode === 'count'} onClick={() => setMode('count')}>{t('purchases.adj.modeCount')}</button>
            <button type="button" aria-pressed={mode === 'change'} onClick={() => setMode('change')}>{t('purchases.adj.modeChange')}</button>
          </div>
        </div>
        <div className="field wide"><label htmlFor="adj-notes">{t('purchases.common.notes')}</label>
          <input id="adj-notes" value={notes} maxLength={300} placeholder={t('purchases.adj.notesPh')} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>
      <p className="hint">{t(mode === 'count' ? 'purchases.adj.modeHelpCount' : 'purchases.adj.modeHelpChange')}</p>

      <datalist id="adj-items">{catalog.map((p) => <option key={p.id} value={p.sku}>{nameIn(ui, p.nameEn, p.nameTa)}</option>)}</datalist>
      {calc.map(({ l, p, change }) => {
        const baseName = p ? nameIn(ui, p.baseUnitEn, p.baseUnitTa) : '';
        const units = p ? p.units.filter((u) => u.onBill) : [];
        const value = p && change ? roundDiv(change * (avg.get(p.id) ?? 0), 1000) : null;
        return (
          <div className="pu-adj-line" key={l.key}>
            <div className="field item">
              <label htmlFor={`ai-${l.key}`}>{t('purchases.common.item')}</label>
              <input id={`ai-${l.key}`} list="adj-items" value={l.sku} placeholder={t('purchases.common.pickItem')} autoComplete="off" onChange={(e) => update(l.key, { sku: e.target.value.toUpperCase(), qty: {} })} />
              {p && <p className="hint">{nameIn(ui, p.nameEn, p.nameTa)}</p>}
            </div>
            <div className="stat">
              <span className="hint">{t('purchases.adj.system')}</span><br />
              {p ? `${formatQty(p.stockMilli ?? 0, { trimZeros: true })} ${baseName}` : '—'}
            </div>
            <div className="qty-group">
              {mode === 'change' && (
                <div className="field">
                  <span className="label">&nbsp;</span>
                  <div className="seg" role="group" aria-label={t('purchases.adj.change')}>
                    <button type="button" aria-pressed={l.sign < 0} onClick={() => update(l.key, { sign: -1 })}>− {t('purchases.adj.minus')}</button>
                    <button type="button" aria-pressed={l.sign > 0} onClick={() => update(l.key, { sign: 1 })}>+ {t('purchases.adj.plus')}</button>
                  </div>
                </div>
              )}
              {units.map((u) => <Num key={u.code} id={`aq-${u.code}-${l.key}`} label={nameIn(ui, u.nameEn, u.nameTa)} value={l.qty[u.code] ?? ''} onChange={(v) => update(l.key, { qty: { ...l.qty, [u.code]: v } })} />)}
              <Num id={`aq-base-${l.key}`} label={`${mode === 'count' ? t('purchases.adj.counted') : t('purchases.common.qty')} ${baseName ? `(${baseName})` : ''}`}
                value={p ? l.qty[p.baseUnit] ?? '' : ''} onChange={(v) => p && update(l.key, { qty: { ...l.qty, [p.baseUnit]: v } })} />
            </div>
            <div className="stat">
              <span className="hint">{t('purchases.adj.difference')}</span><br />
              <span className={change && change < 0 ? 'neg' : change ? 'pos' : ''}>{change != null ? `${change > 0 ? '+' : ''}${formatQty(change, { trimZeros: true })} ${baseName}` : '—'}</span>
              {p && change != null && Math.abs(change) * 4 > Math.max(p.stockMilli ?? 0, 1) && <span className="hint neg"><br />{t('purchases.adj.bigDiff')}</span>}
            </div>
            <div className="stat">
              <span className="hint">{t('purchases.common.value')}</span><br />
              <span className={value && value < 0 ? 'neg' : ''}>{value != null ? formatRs(value) : '—'}</span>
            </div>
            <button type="button" className="icon-btn" aria-label={t('purchases.common.removeLine')} title={t('purchases.common.removeLine')}
              onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [emptyLine()]))}>×</button>
          </div>
        );
      })}
      <button type="button" className="btn add-line" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ {t('purchases.common.addLine')}</button>
      <div className="form-actions">
        <p className="hint">{t('purchases.adj.valueAt')}: <b className={totalValue < 0 ? 'neg' : ''}>{formatRs(totalValue)}</b></p>
        {error && <span className="field-error" role="alert">{error}</span>}
        <button type="submit" className="btn primary" disabled={saving}>{saving ? t('purchases.common.saving') : t('purchases.adj.save')}</button>
      </div>
    </form>
  );
}
