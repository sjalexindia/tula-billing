import { formatQty, formatRs, largerUnitText } from '@tula/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type CatalogItem } from '../api';
import { purchasesApi, showDate, type StockLedger, type Valuation } from '../api/purchases';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import '../styles/purchases.css';

export function Stock({ id }: Partial<ScreenProps> = {}) {
  if (id) return <ItemLedger productId={id} />;
  return <StockList />;
}

function StockList() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [value, setValue] = useState<Valuation | null>(null);
  useEffect(() => {
    api.catalog().then((c) => setItems(c.filter((p) => p.trackStock))).catch(() => setItems([]));
    purchasesApi.valuation().then(setValue).catch(() => setValue(null));
  }, []);
  if (!items) return null;
  const anyLarger = items.some((p) => p.units.length > 0);
  const valueOf = new Map((value?.items ?? []).map((v) => [v.product_id, v]));
  return (
    <section className="page">
      <div className="page-head pu-stock-head">
        <h1>{t('stock.title')}</h1>
        {value && <span className="page-sum">{t('purchases.stock.value')}: {formatRs(value.totalPaise)}<small>{t('purchases.stock.valueHelp')}</small></span>}
      </div>
      <div className="pu-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>{t('stock.item')}</th><th className="r">{t('stock.onHand')}</th>
              {anyLarger && <th className="r">{t('stock.largerUnit')}</th>}
              <th className="r">{t('purchases.stock.avgCost')}</th><th className="r">{t('purchases.common.value')}</th>
              <th>{t('stock.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const q = p.stockMilli ?? 0;
              const largest = p.units[0]; // units arrive largest first
              const status = q < 0 ? 'NEGATIVE' : q === 0 ? 'OUT' : q <= p.minStockMilli ? 'LOW' : 'OK';
              const v = valueOf.get(p.id);
              const unit = nameIn(ui, p.baseUnitEn, p.baseUnitTa);
              return (
                <tr key={p.id}>
                  <td><a href={`#/stock/${p.id}`} title={t('purchases.stock.ledger')}>{nameIn(ui, p.nameEn, p.nameTa)}</a><span className="sub mono">{p.sku}</span></td>
                  <td className="r">{formatQty(q, { decimals: 2 })} {unit}</td>
                  {anyLarger && <td className="r">{largest ? largerUnitText(q, largest.factorMilli, nameIn(ui, largest.nameEn, largest.nameTa), unit, largest.theoretical) : ''}</td>}
                  <td className="r">{v?.avg_cost_paise ? `${formatRs(v.avg_cost_paise)}${t('purchases.common.perUnit', { unit })}` : ''}</td>
                  <td className="r">{v?.value_paise ? formatRs(v.value_paise) : ''}</td>
                  <td><span className={`status ${status.toLowerCase()}`}>{t(`stock.${status}`)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Where to open the document behind a stock movement, when there is a screen for it. */
function docLink(type: string, sourceId: string): string | null {
  if (type === 'INV') return `#/print/${sourceId}`;
  if (type === 'PUR') return `#/purchases/${sourceId}`;
  if (type === 'ADJ') return '#/adjustments';
  return null;
}

function ItemLedger({ productId }: { productId: string }) {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const [d, setD] = useState<StockLedger | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { purchasesApi.ledger(productId).then(setD).catch((e) => setError((e as Error).message)); }, [productId]);
  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!d) return null;
  const unit = nameIn(ui, d.product.base_unit_en, d.product.base_unit_ta);
  const q = (m: number) => (m ? formatQty(m, { trimZeros: true }) : '');
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('purchases.stock.ledgerOf', { name: nameIn(ui, d.product.name_en, d.product.name_ta) })}</h1>
        <a className="btn" href="#/stock">{t('purchases.common.back')}</a>
      </div>
      <ul className="pu-chips">
        <li><span className="k">{t('purchases.stock.closing')}</span><span className="v">{formatQty(d.closingMilli, { trimZeros: true })} {unit}</span></li>
        <li><span className="k">{t('purchases.stock.avgCost')}</span><span className="v">{formatRs(d.avgCostPaise)}{t('purchases.common.perUnit', { unit })}</span></li>
        <li className="mark"><span className="k">{t('purchases.stock.value')}</span><span className="v">{formatRs(d.valuePaise)}</span></li>
      </ul>
      {d.rows.length === 0 ? <p className="empty">{t('purchases.stock.noMoves')}</p> : (
        <div className="pu-scroll">
          <table className="grid">
            <thead><tr>
              <th>{t('purchases.common.date')}</th><th>{t('purchases.stock.document')}</th><th>{t('purchases.stock.party')}</th>
              <th className="r">{t('purchases.stock.in')}</th><th className="r">{t('purchases.stock.out')}</th>
              <th className="r">{t('purchases.stock.balance')} ({unit})</th><th className="r">{t('purchases.common.value')}</th>
            </tr></thead>
            <tbody>
              {d.openingMilli !== 0 && <tr className="pu-opening"><td colSpan={5}>{t('purchases.stock.opening')}</td><td className="r">{q(d.openingMilli)}</td><td /></tr>}
              {d.rows.map((r) => {
                const link = docLink(r.type, r.sourceId);
                return (
                  <tr key={r.id}>
                    <td className="mono">{showDate(r.date)}</td>
                    <td>{t(`purchases.stock.types.${r.type}`)}
                      <span className="sub mono">{link ? <a href={link}>{r.docNo}</a> : r.docNo}{r.type === 'ADJ' && r.reason ? ` · ${t(`purchases.adj.reasons.${r.reason}`)}` : ''}</span></td>
                    <td>{r.partyEn ? nameIn(ui, r.partyEn, r.partyTa) : ''}</td>
                    <td className="r pos">{q(r.inMilli)}</td>
                    <td className="r neg">{q(r.outMilli)}</td>
                    <td className="r"><b>{formatQty(r.balanceMilli, { trimZeros: true })}</b></td>
                    <td className={`r ${r.valuePaise != null && r.valuePaise < 0 ? 'neg' : ''}`}>{r.valuePaise != null ? formatRs(r.valuePaise) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
