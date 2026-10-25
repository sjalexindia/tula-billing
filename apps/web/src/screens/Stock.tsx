import { formatQty, splitIntoUnits } from '@tula/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type CatalogItem } from '../api';
import { nameIn } from '../i18n';

export function Stock() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  useEffect(() => { api.catalog().then((c) => setItems(c.filter((p) => p.trackStock))).catch(() => setItems([])); }, []);
  if (!items) return null;
  const anyLarger = items.some((p) => p.units.length > 0);
  return (
    <section className="page">
      <div className="page-head"><h1>{t('stock.title')}</h1></div>
      <table className="grid">
        <thead>
          <tr>
            <th>{t('stock.item')}</th><th className="r">{t('stock.onHand')}</th>
            {anyLarger && <th className="r">{t('stock.largerUnit')}</th>}
            <th>{t('stock.status')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const q = p.stockMilli ?? 0;
            const largest = p.units[0]; // units arrive largest first
            const status = q < 0 ? 'NEGATIVE' : q === 0 ? 'OUT' : q <= p.minStockMilli ? 'LOW' : 'OK';
            const split = largest && q > 0 ? splitIntoUnits(q, largest.factorMilli) : null;
            return (
              <tr key={p.id}>
                <td>{nameIn(ui, p.nameEn, p.nameTa)}<span className="sub mono">{p.sku}</span></td>
                <td className="r">{formatQty(q, { decimals: 2 })} {nameIn(ui, p.baseUnitEn, p.baseUnitTa)}</td>
                {anyLarger && <td className="r">{split && largest ? `${split.whole} ${nameIn(ui, largest.nameEn, largest.nameTa)}` : ''}</td>}
                <td><span className={`status ${status.toLowerCase()}`}>{t(`stock.${status}`)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
