import { formatRs } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../App';
import { BUCKETS, dmy, sales, whatsappLink, type Outstanding as OutstandingData } from '../api/sales';
import { nameIn, tFor } from '../i18n';
import type { ScreenProps } from '../nav';
import '../styles/sales.css';

/**
 * WhatsApp reminder in the customer's language (their own, else the business's bill language):
 * business name, balance due and the UPI ID when there is one. Null when there is no usable mobile.
 */
export function reminderLink(party: { name_en: string; name_ta: string | null; mobile: string | null; lang: string | null }, balancePaise: number, s: Record<string, string>) {
  const enabled = (s['app.languages'] ?? 'en').split(',');
  const lang = party.lang && enabled.includes(party.lang) ? party.lang : s['invoice.default_lang'] ?? 'en';
  const t = tFor(lang);
  const upi = s['business.upi_id'];
  const text = t('sales.wa.message', {
    shop: nameIn(lang, s['business.name_en'] ?? '', s['business.name_ta']),
    name: nameIn(lang, party.name_en, party.name_ta),
    amount: formatRs(balancePaise),
    upi: upi ? t('sales.wa.upi', { id: upi }) : '',
  });
  return whatsappLink(party.mobile, text);
}

export function Outstanding(_props: ScreenProps) {
  const { t, i18n } = useTranslation();
  const { settings, me } = useApp();
  const ui = i18n.language;
  const [data, setData] = useState<OutstandingData | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  useEffect(() => { sales.outstanding().then(setData).catch((e) => setError((e as Error).message)); }, []);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => (!overdueOnly || r.overduePaise > 0)
      && (!s || [r.name_en, r.name_ta ?? '', r.mobile ?? ''].some((x) => x.toLowerCase().includes(s))));
  }, [data, q, overdueOnly]);

  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!data) return null;
  const showInterest = Number(data.interestPa) > 0;
  const s = settings?.values ?? {};
  return (
    <section className="page sales">
      <div className="page-head">
        <h1>{t('sales.out.title')}</h1>
        <span className="page-sum owed">{formatRs(data.totals.balancePaise)}</span>
      </div>
      <div className="tiles">
        <div className={`tile${data.totals.overduePaise > 0 ? ' danger' : ''}`}><span>{t('sales.out.overdue')}</span><b>{formatRs(data.totals.overduePaise)}</b></div>
        {BUCKETS.map((k) => <div className="tile" key={k}><span>{t(`sales.out.buckets.${k}`)}</span><b>{formatRs(data.totals.buckets[k])}</b></div>)}
        {showInterest && <div className="tile"><span>{t('sales.out.interest', { rate: data.interestPa })}</span><b>{formatRs(data.totals.interestPaise)}</b></div>}
      </div>
      <div className="toolbar">
        <input className="search" type="search" placeholder={t('parties.search')} aria-label={t('parties.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> {t('sales.out.overdueOnly')}</label>
      </div>
      {rows.length === 0 && <p className="empty">{data.rows.length ? t('sales.bills.noMatch') : t('sales.out.none')}</p>}
      {rows.length > 0 && (
        <table className="grid sales-grid out-grid">
          <thead>
            <tr>
              <th>{t('sales.out.customer')}</th><th className="r">{t('sales.out.balance')}</th><th className="r">{t('sales.out.overdue')}</th>
              {BUCKETS.map((k) => <th key={k} className="r bucket">{t(`sales.out.buckets.${k}`)}</th>)}
              {showInterest && <th className="r bucket">{t('sales.out.interestShort')}</th>}
              <th className="r"><span className="sr-only">{t('sales.bills.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const wa = reminderLink(r, r.balancePaise, s);
              return (
                <tr key={r.partyId}>
                  <td>
                    <a href={`#/statement/${r.partyId}`}>{nameIn(ui, r.name_en, r.name_ta)}</a>
                    <span className="sub">
                      {r.mobile && <span className="mono">{r.mobile} · </span>}
                      {t('sales.out.lastPaid')}: {r.lastPaymentDate ? dmy(r.lastPaymentDate) : t('sales.out.never')}
                      {r.advancePaise > 0 && <> · {t('sales.out.advance')}: {formatRs(r.advancePaise)}</>}
                    </span>
                  </td>
                  <td className="r"><b>{formatRs(r.balancePaise)}</b><span className="sub">{t('sales.out.creditDays', { count: r.creditDays })}</span></td>
                  <td className={`r ${r.overduePaise > 0 ? 'owed' : ''}`}>{r.overduePaise > 0 && <span className="m-label">{t('sales.out.overdue')}: </span>}{r.overduePaise > 0 ? formatRs(r.overduePaise) : '—'}{r.overduePaise > 0 && <span className="sub">{t('sales.out.oldest', { count: r.oldestDays })}</span>}</td>
                  {BUCKETS.map((k) => <td key={k} className="r bucket">{r.buckets[k] ? formatRs(r.buckets[k]) : ''}</td>)}
                  {showInterest && <td className="r bucket">{r.interestPaise ? formatRs(r.interestPaise) : ''}</td>}
                  <td className="r actions">
                    <a className="btn small" href={`#/statement/${r.partyId}`}>{t('sales.out.statement')}</a>
                    {me?.role !== 'viewer' && <a className="btn small" href={`#/receipts/for-${r.partyId}`}>{t('sales.out.takePayment')}</a>}
                    {wa ? <a className="btn small wa" href={wa} target="_blank" rel="noreferrer">{t('sales.out.remind')}</a>
                      : <span className="sub">{t('sales.out.noMobile')}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {showInterest && <p className="hint">{t('sales.out.interestNote')}</p>}
    </section>
  );
}
