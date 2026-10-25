import { formatRs } from '@tula/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

export function Bills() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.bills>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.bills().then(setRows).catch((e) => setError((e as Error).message)); }, []);

  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!rows) return null;
  const total = rows.filter((r) => r.status === 'active').reduce((a, r) => a + r.total_paise, 0);
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('bills.title')}</h1>
        {rows.length > 0 && <span className="page-sum">{formatRs(total)}</span>}
      </div>
      {rows.length === 0 ? <p className="empty">{t('bills.none')}</p> : (
        <table className="grid">
          <thead><tr><th>{t('bills.no')}</th><th>{t('bills.customer')}</th><th className="r">{t('bills.total')}</th><th className="r">{t('bills.balance')}</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'cancelled' : ''}>
                <td className="mono">{r.doc_no}</td>
                <td>{r.party_name}{r.site && <span className="sub">{r.site}</span>}</td>
                <td className="r">{formatRs(r.total_paise)}</td>
                <td className="r">{r.balance_paise > 0 ? formatRs(r.balance_paise) : <span className="paid">{t('bills.paid')}</span>}</td>
                <td className="r"><a className="btn small" href={`#/print/${r.id}`}>{t('bills.open')}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
