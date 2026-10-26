import { formatRs } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Party } from '../api';
import { useApp } from '../App';
import { dmy, fyStartOf, monthStartOf, sales, todayLocal, type Statement as StatementData } from '../api/sales';
import { nameIn, tFor } from '../i18n';
import type { ScreenProps } from '../nav';
import { reminderLink } from './Outstanding';
import '../styles/sales.css';
import { PrintShare } from '../components/PrintShare';

/** #/statement/<partyId>: customer statement for a period, printable (A4) and shareable on WhatsApp. */
export function Statement({ id }: ScreenProps) {
  if (!id) return <PickCustomer />;
  return <StatementView partyId={id} />;
}

function PickCustomer() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const [parties, setParties] = useState<Party[]>([]);
  const [text, setText] = useState('');
  useEffect(() => { api.parties().then((p) => setParties(p.filter((x) => x.party_type !== 'supplier'))).catch(() => {}); }, []);
  const party = parties.find((p) => [p.name_en, p.name_ta, p.mobile].includes(text.trim()));
  useEffect(() => { if (party) location.hash = `#/statement/${party.id}`; }, [party]);
  return (
    <section className="page sales">
      <div className="page-head"><h1>{t('sales.st.title')}</h1></div>
      <div className="field grow pick">
        <label htmlFor="st-customer">{t('sales.receipts.customer')}</label>
        <input id="st-customer" list="st-customers" value={text} placeholder={t('bill.pickCustomer')} autoComplete="off" autoFocus onChange={(e) => setText(e.target.value)} />
        <datalist id="st-customers">{parties.map((p) => <option key={p.id} value={nameIn(ui, p.name_en, p.name_ta)}>{p.mobile ?? ''}</option>)}</datalist>
      </div>
    </section>
  );
}

type Period = 'month' | 'fy' | 'custom';

function StatementView({ partyId }: { partyId: string }) {
  const { t: tUi } = useTranslation();
  const { me } = useApp();
  const today = todayLocal();
  const [period, setPeriod] = useState<Period>('fy');
  const [from, setFrom] = useState(fyStartOf(today));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<StatementData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { sales.statement(partyId, from, to).then((d) => { setData(d); setError(''); }).catch((e) => setError((e as Error).message)); }, [partyId, from, to]);
  useEffect(() => { if (data) document.title = `${data.party.name_en} ${data.from}`; }, [data]);

  const choose = (p: Period) => {
    setPeriod(p);
    if (p === 'month') { setFrom(monthStartOf(today)); setTo(today); }
    if (p === 'fy') { setFrom(fyStartOf(today)); setTo(today); }
  };

  const s = data?.settings ?? {};
  const lang = data?.lang ?? 'en';
  const enabled = (s['app.languages'] ?? 'en').split(',');
  const labelLangs = s['invoice.label_mode'] === 'bilingual' ? [lang, ...enabled.filter((l) => l !== lang)] : [lang];
  const t = useMemo(() => (key: string, opts?: Record<string, unknown>) => [...new Set(labelLangs.map((l) => String(tFor(l)(key, opts))))].join(' / '),
    [labelLangs.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <p className="field-error" role="alert">{error}</p>;
  if (!data) return null;
  const p = data.party;
  const wa = data.balanceTodayPaise > 0 ? reminderLink(p, data.balanceTodayPaise, s) : null;
  const shop = nameIn(lang, s['business.name_en'] ?? '', s['business.name_ta']);
  const kindLabel = (k: string) => (['INV', 'CN', 'RCPT', 'PAY', 'REFUND', 'OPEN', 'PUR', 'DN'].includes(k) ? t(`sales.st.kinds.${k}`) : k);
  // Positive = the customer owes; a negative balance is money of theirs we hold (advance).
  const balanceCell = (v: number) => <>{formatRs(Math.abs(v))}{v < 0 && <small> {t('sales.st.cr')}</small>}</>;

  return (
    <div className="print-doc statement-page" lang={lang}>
      <style>{'@page { size: A4; margin: 0; }'}</style>
      <div className="doc-actions no-print">
        <a className="btn" href="#/outstanding">{tUi('sales.st.back')}</a>
        <div className="st-controls">
          <div className="seg" role="group" aria-label={tUi('sales.range.label')}>
            {(['month', 'fy', 'custom'] as const).map((k) => <button key={k} type="button" aria-pressed={period === k} onClick={() => choose(k)}>{tUi(`sales.st.periods.${k}`)}</button>)}
          </div>
          {period === 'custom' && (
            <span className="range-dates">
              <label htmlFor="st-from">{tUi('sales.range.from')}</label>
              <input id="st-from" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
              <label htmlFor="st-to">{tUi('sales.range.to')}</label>
              <input id="st-to" type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
            </span>
          )}
        </div>
        <div className="st-buttons">
          {me?.role !== 'viewer' && data.balanceTodayPaise > 0 && <a className="btn" href={`#/receipts/for-${p.id}`}>{tUi('sales.out.takePayment')}</a>}
          {wa && <a className="btn wa" href={wa} target="_blank" rel="noreferrer">{tUi('sales.st.whatsapp')}</a>}
          <PrintShare target=".statement-doc" fileName={`${p.name_en} ${data.from} ${data.to}`} printLabel={tUi('sales.printBtn')} />
        </div>
      </div>
      {error && <p className="field-error no-print" role="alert">{error}</p>}
      <article className="statement-doc">
        <header className="doc-head">
          <div>
            <h1>{shop}</h1>
            <p>{s['business.address']}</p>
            <p>{s['business.phone'] && <>{t('invoice.phone')}: {s['business.phone']} &nbsp;</>}{s['gst.gstin'] && <>{t('invoice.gstin')}: {s['gst.gstin']}</>}</p>
          </div>
          <div className="doc-title">
            <h2>{t('sales.st.title')}</h2>
            <p>{t('sales.st.period', { from: dmy(data.from), to: dmy(data.to) })}</p>
          </div>
        </header>
        <section className="st-party">
          <div>
            <p className="party-name">{nameIn(lang, p.name_en, p.name_ta)}</p>
            {p.address && <p>{p.address}</p>}
            {p.mobile && <p>{t('invoice.phone')}: {p.mobile}</p>}
            {p.gstin && <p>{t('invoice.gstin')}: {p.gstin}</p>}
          </div>
          <div className="st-due">
            <span>{data.balanceTodayPaise >= 0 ? t('sales.st.dueNow') : t('sales.st.advanceNow')}</span>
            <b>{formatRs(Math.abs(data.balanceTodayPaise))}</b>
          </div>
        </section>
        <table className="st-lines">
          <thead>
            <tr><th>{t('invoice.date')}</th><th>{t('sales.st.particulars')}</th><th className="r">{t('sales.st.debit')}</th><th className="r">{t('sales.st.credit')}</th><th className="r">{t('sales.st.balance')}</th></tr>
          </thead>
          <tbody>
            <tr className="st-open"><td>{dmy(data.from)}</td><td>{t('sales.st.opening')}</td><td /><td /><td className="r">{balanceCell(data.openingPaise)}</td></tr>
            {data.lines.map((l) => (
              <tr key={`${l.kind}-${l.sourceId}`}>
                <td className="nowrap">{dmy(l.date)}</td>
                <td>
                  {kindLabel(l.kind)} {l.docNo && <span className="mono">{l.docNo}</span>}
                  {l.detail && <span className="sub">{l.kind === 'CN' ? t('sales.st.against', { no: l.detail }) : l.kind === 'RCPT' || l.kind === 'REFUND' || l.kind === 'PAY' ? l.detail.replace(/^(cash|upi|bank|cheque)\b/, (m) => t(`bill.modes.${m}`)) : l.detail}</span>}
                </td>
                <td className="r">{l.debitPaise ? formatRs(l.debitPaise, { symbol: false }) : ''}</td>
                <td className="r">{l.creditPaise ? formatRs(l.creditPaise, { symbol: false }) : ''}</td>
                <td className="r nowrap">{balanceCell(l.balancePaise)}</td>
              </tr>
            ))}
            {data.lines.length === 0 && <tr><td colSpan={5} className="muted">{t('sales.st.none')}</td></tr>}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>{t('sales.st.closing')}</th>
              <td className="r">{formatRs(data.totals.debitPaise, { symbol: false })}</td>
              <td className="r">{formatRs(data.totals.creditPaise, { symbol: false })}</td>
              <td className="r nowrap"><b>{balanceCell(data.closingPaise)}</b></td>
            </tr>
          </tfoot>
        </table>
        {s['business.upi_id'] && data.balanceTodayPaise > 0 && <p className="small">{t('sales.st.payUpi', { id: s['business.upi_id'] })}</p>}
        {s['business.bank_details'] && <p className="small">{t('invoice.bank')}: {s['business.bank_details']}</p>}
        <p className="small muted">{t('sales.st.footer')}</p>
      </article>
    </div>
  );
}
