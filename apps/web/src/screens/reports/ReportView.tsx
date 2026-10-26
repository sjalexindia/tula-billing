import { financialYear, financialYearRange, formatQty, formatRs, todayIST } from '@tula/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api';
import { reportsApi, reportUrl, type Report, type ReportDef } from '../../api/reports';
import { runsLocally } from '../../platform';
import { Field } from '../../components/Field';
import { nameIn } from '../../i18n';
import { ReportTable, showDate } from './ReportTable';

type Preset = 'today' | 'month' | 'lastMonth' | 'fy' | 'custom';
const PRESETS: Preset[] = ['today', 'month', 'lastMonth', 'fy', 'custom'];

const lastDay = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, '0')}`;
};
const prevMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
};

export function rangeFor(p: Preset, today = todayIST()): { from: string; to: string } {
  const ym = today.slice(0, 7);
  switch (p) {
    case 'today': return { from: today, to: today };
    case 'lastMonth': { const l = prevMonth(ym); return { from: `${l}-01`, to: lastDay(l) }; }
    case 'fy': return financialYearRange(financialYear(today));
    default: return { from: `${ym}-01`, to: lastDay(ym) };
  }
}

/** Headline figures shown above the tables, per report. */
const CARDS: Record<string, Array<[string, 'money' | 'pct' | 'int' | 'qty']>> = {
  'profit-loss': [['netSales', 'money'], ['gross', 'money'], ['expenses', 'money'], ['net', 'money'], ['margin', 'pct']],
  'profit-bill': [['sales', 'money'], ['profit', 'money'], ['margin', 'pct']],
  'profit-customer': [['sales', 'money'], ['profit', 'money'], ['margin', 'pct']],
  'profit-item': [['sales', 'money'], ['profit', 'money'], ['margin', 'pct']],
  'stock-summary': [['value', 'money'], ['low', 'int'], ['slow', 'int']],
  'gstr1': [['taxable', 'money'], ['tax', 'money']],
  'gstr3b': [['outTaxable', 'money'], ['cash', 'money']],
  'rate-group': [['qty', 'qty'], ['realised', 'money'], ['diffTotal', 'money']],
  'cmp08': [['value', 'money'], ['tax', 'money']],
};

export function ReportView({ def, onBack }: { def: ReportDef; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const today = todayIST();
  const [preset, setPreset] = useState<Preset>('month');
  const [range, setRange] = useState(rangeFor('month'));
  const [asOf, setAsOf] = useState(today);
  const [slowDays, setSlowDays] = useState('60');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [group, setGroup] = useState('');
  const [by, setBy] = useState<'day' | 'month'>('day');
  const [groups, setGroups] = useState<Array<{ code: string; name_en: string; name_ta: string | null }>>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (def.id === 'rate-group') reportsApi.rateGroups().then((g) => { setGroups(g); setGroup((cur) => cur || g[0]?.code || ''); }).catch(() => {});
  }, [def.id]);

  const params: Record<string, string> =
    def.period === 'asOf' ? { asOf, slowDays: /^\d+$/.test(slowDays) && Number(slowDays) > 0 ? slowDays : '60' }
    : def.period === 'month' ? { month }
    : def.period === 'quarter' ? { from: `${month}-01` }
    : { ...range, ...(def.id === 'rate-group' ? { by, ...(group ? { group } : {}) } : {}) };
  const key = JSON.stringify(params);

  useEffect(() => {
    if (def.period === 'range' && range.from > range.to) { setError(t('reports.badRange')); return; }
    let live = true;
    setLoading(true);
    setError('');
    reportsApi.get(def, params)
      .then((r) => { if (live) setReport(r); })
      .catch((e) => { if (live) setError(e instanceof ApiError && e.status === 0 ? t('errors.network') : (e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, key]);

  const thisM = today.slice(0, 7);
  const lastM = def.period === 'quarter' ? prevMonth(prevMonth(prevMonth(thisM))) : prevMonth(thisM);
  const pick = (p: Preset) => { setPreset(p); if (p !== 'custom') setRange(rangeFor(p)); };
  const title = t(`reports.list.${def.id}.title`);
  const period = report ? (report.from === report.to ? showDate(report.from) : `${showDate(report.from)} – ${showDate(report.to)}`) : '';
  const business = report ? nameIn(ui, report.business.name_en, report.business.name_ta) : '';
  const card = (k: string, type: string) => {
    const v = report?.summary?.[k];
    if (v === null || v === undefined) return '—';
    if (type === 'money') return formatRs(Number(v));
    if (type === 'pct') return `${(Number(v) / 100).toFixed(2)}%`;
    if (type === 'qty') return formatQty(Number(v), { decimals: 0 });
    return String(v);
  };

  return (
    <section className="page report-view">
      <div className="page-head no-print">
        <button type="button" className="link back" onClick={onBack}>← {t('reports.allReports')}</button>
      </div>
      <header className="report-head">
        <div>
          <p className="print-only report-business">{business}{report?.business.gstin ? ` · GSTIN ${report.business.gstin}` : ''}</p>
          <h1>{title}</h1>
          <p className="report-period">{period}</p>
        </div>
        <div className="report-actions no-print">
          {!runsLocally && <a className="btn" href={reportUrl(def, params, true)} download>{t('reports.downloadExcel')}</a>}
          <button type="button" className="btn primary" onClick={() => window.print()} disabled={!report}>{t('reports.print')}</button>
        </div>
      </header>

      <div className="report-controls no-print">
        {def.period === 'range' && (
          <>
            <div className="seg presets" role="group" aria-label={t('reports.period')}>
              {PRESETS.map((p) => <button key={p} type="button" aria-pressed={preset === p} onClick={() => pick(p)}>{t(`reports.presets.${p}`)}</button>)}
            </div>
            {preset === 'custom' && (
              <div className="date-pair">
                <Field id="rep-from" label={t('reports.from')}><input id="rep-from" type="date" value={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} /></Field>
                <Field id="rep-to" label={t('reports.to')}><input id="rep-to" type="date" value={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} /></Field>
              </div>
            )}
          </>
        )}
        {def.period === 'asOf' && (
          <div className="date-pair">
            <Field id="rep-asof" label={t('reports.asOf')}><input id="rep-asof" type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></Field>
            <Field id="rep-slow" label={t('reports.slowDays')}><input id="rep-slow" inputMode="numeric" value={slowDays} onChange={(e) => setSlowDays(e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
        )}
        {(def.period === 'month' || def.period === 'quarter') && (
          <div className="date-pair">
            <div className="seg presets" role="group" aria-label={t('reports.period')}>
              <button type="button" aria-pressed={month === thisM} onClick={() => setMonth(thisM)}>{t(def.period === 'month' ? 'reports.presets.month' : 'reports.presets.quarter')}</button>
              <button type="button" aria-pressed={month === lastM} onClick={() => setMonth(lastM)}>{t(def.period === 'month' ? 'reports.presets.lastMonth' : 'reports.presets.lastQuarter')}</button>
            </div>
            <Field id="rep-month" label={t(def.period === 'month' ? 'reports.month' : 'reports.quarterMonth')}><input id="rep-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
          </div>
        )}
        {def.id === 'rate-group' && (
          <div className="date-pair">
            {groups.length > 1 && (
              <Field id="rep-group" label={t('reports.rateGroup')}>
                <select id="rep-group" value={group} onChange={(e) => setGroup(e.target.value)}>
                  {groups.map((g) => <option key={g.code} value={g.code}>{nameIn(ui, g.name_en, g.name_ta)}</option>)}
                </select>
              </Field>
            )}
            <div className="seg" role="group" aria-label={t('reports.groupBy')}>
              {(['day', 'month'] as const).map((b) => <button key={b} type="button" aria-pressed={by === b} onClick={() => setBy(b)}>{t(`reports.by.${b}`)}</button>)}
            </div>
          </div>
        )}
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}
      {loading && !report && <p className="empty">{t('reports.loading')}</p>}
      {report && (
        <div className={loading ? 'report-body stale' : 'report-body'}>
          {CARDS[def.id] && (
            <dl className="report-cards">
              {CARDS[def.id]!.map(([k, type]) => (
                <div key={k} className={k === 'net' || k === 'profit' || k === 'cash' ? 'key' : undefined}>
                  <dt>{t(`reports.summary.${k}`)}</dt>
                  <dd className={typeof report.summary?.[k] === 'number' && Number(report.summary[k]) < 0 ? 'neg' : undefined}>{card(k, type)}</dd>
                </div>
              ))}
            </dl>
          )}
          {report.warnings && report.warnings.length > 0 && (
            <div className="notice report-warnings" role="status">
              <strong>{t('reports.check')}</strong>
              <ul>{report.warnings.slice(0, 20).map((w, i) => <li key={i}>{t(`reports.warnings.${w.code}`, { defaultValue: w.code })}{w.detail ? `: ${w.detail}` : ''}</li>)}</ul>
            </div>
          )}
          {report.tables.map((tb) => (
            <section key={tb.id} className="report-section">
              {report.tables.length > 1 && <h2>{t(`reports.tables.${tb.id}`, { defaultValue: tb.title })}</h2>}
              <ReportTable table={tb} />
            </section>
          ))}
          {report.notes && report.notes.length > 0 && (
            <ul className="report-notes">{report.notes.map((n) => <li key={n}>{t(`reports.notes.${n}`)}</li>)}</ul>
          )}
        </div>
      )}
    </section>
  );
}
