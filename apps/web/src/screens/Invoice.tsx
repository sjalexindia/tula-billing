import { amountInWords, formatQty, formatRs, stateName } from '@tula/core';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type BillDetail } from '../api';
import { dmy, sales, type DocLinks } from '../api/sales';
import { PrintShare } from '../components/PrintShare';
import { nameIn, tFor } from '../i18n';

export function Invoice({ id }: { id: string }) {
  const { t: tUi } = useTranslation();
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [qr, setQr] = useState('');
  const [links, setLinks] = useState<DocLinks | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.bill(id).then(setBill).catch((e) => setError((e as Error).message));
    sales.links(id).then(setLinks).catch(() => setLinks(null));
  }, [id]);

  const isCn = links?.docType === 'CN';
  const returned = links?.returnedPaise ?? 0;
  // A credit note is not something to pay; an invoice's due amount is reduced by returns against it.
  const due = bill && links && !isCn && bill.doc.status !== 'cancelled' ? Math.max(0, bill.doc.total_paise - bill.paidPaise - returned) : 0;
  useEffect(() => {
    const s = bill?.settings;
    if (!bill || !s || due <= 0 || !s['business.upi_id'] || s['invoice.show_upi_qr'] !== 'true') { setQr(''); return; }
    const params = new URLSearchParams({
      pa: s['business.upi_id'], pn: s['business.name_en'] ?? '', am: (due / 100).toFixed(2), cu: 'INR', tn: `Bill ${bill.doc.doc_no}`,
    });
    QRCode.toDataURL(`upi://pay?${params.toString()}`, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(''));
  }, [bill, due]);

  useEffect(() => {
    if (bill) document.title = bill.doc.doc_no.replace(/\//g, '-');
  }, [bill]);

  if (error) return <p className="field-error" role="alert">{error}</p>;
  if (!bill) return null;

  const { doc, lines, settings: s, party, units } = bill;
  const lang = doc.lang;
  // Bilingual bills print every label in the bill's language first, then the other enabled language.
  const enabled = (s['app.languages'] ?? 'en').split(',');
  const labelLangs = s['invoice.label_mode'] === 'bilingual' ? [lang, ...enabled.filter((l) => l !== lang)] : [lang];
  const t = (key: string, opts?: Record<string, unknown>) => [...new Set(labelLangs.map((l) => String(tFor(l)(key, opts))))].join(' / ');
  const businessName = nameIn(lang, s['business.name_en'] ?? '', s['business.name_ta']);
  const inter = doc.supply_type === 'inter';
  const taxInvoice = doc.doc_kind === 'tax_invoice';
  const terms = [...new Set(labelLangs.map((l) => s[`invoice.terms_${l}`]).filter(Boolean))];
  const anyInclusive = lines.some((l) => l.rate_inclusive);
  const legal = s['business.legal_name'];
  const stateLabel = (code: string) => `${stateName(code, lang)} (${code})`;
  const unitLabel = (code: string) => {
    const u = units.find((x) => x.code === code);
    return u ? nameIn(lang, u.name_en, u.name_ta) : code;
  };

  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    const e = byRate.get(l.gst_bp) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    e.taxable += l.taxable_paise; e.cgst += l.cgst_paise; e.sgst += l.sgst_paise; e.igst += l.igst_paise;
    byRate.set(l.gst_bp, e);
  }
  /** How the quantity was keyed in, when it was in larger units: "10 Bundle + 4 Rod" */
  const breakdown = (l: BillDetail['lines'][number]) => {
    const parts = Object.entries(l.entry_json).filter(([code]) => code !== l.rate_unit_code).map(([code, q]) => `${q} ${unitLabel(code)}`);
    return parts.join(' + ');
  };
  const unitName = (l: BillDetail['lines'][number]) => (lang === 'ta' && l.rate_unit_ta ? l.rate_unit_ta : l.rate_unit_en);

  return (
    <div className={`invoice-page paper-${(s['invoice.paper'] ?? 'A4').toLowerCase()}`} lang={lang}>
      <style>{`@page { size: ${s['invoice.paper'] === 'A5' ? 'A5' : 'A4'}; margin: 0; }`}</style>
      <div className="invoice-actions no-print">
        <button type="button" className="btn" onClick={() => (history.length > 1 ? history.back() : (location.hash = '#/bills'))}>{tUi('sales.back')}</button>
        <PrintShare target=".invoice" fileName={doc.doc_no} printLabel={tUi('invoice.print')} />
      </div>

      <article className="invoice">
        {doc.status === 'cancelled' && <div className="stamp">{t('invoice.cancelled')}</div>}
        <header className="inv-head">
          <div className="inv-shop">
            <h1>{businessName}</h1>
            {labelLangs.length > 1 && s['business.name_ta'] && <p className="alt-name">{lang === 'ta' ? s['business.name_en'] : s['business.name_ta']}</p>}
            {s['business.tagline'] && <p className="tagline">{s['business.tagline']}</p>}
            {legal && legal !== businessName && <p className="small">{t('invoice.legalName')}: {legal}</p>}
            <p>{s['business.address']}</p>
            <p>
              {s['business.phone'] && <>{t('invoice.phone')}: {s['business.phone']} &nbsp; </>}
              {s['gst.gstin'] && <>{t('invoice.gstin')}: <b>{s['gst.gstin']}</b></>}
            </p>
          </div>
          <div className="inv-title">
            <h2>{isCn ? t('sales.cn.title') : taxInvoice ? t('invoice.title') : t('invoice.billOfSupply')}</h2>
            <p className="muted">{t('invoice.original')}</p>
            <table className="kv">
              <tbody>
                <tr><th>{isCn ? t('sales.cn.no') : t('invoice.no')}</th><td className="mono"><b>{doc.doc_no}</b></td></tr>
                <tr><th>{t('invoice.date')}</th><td>{doc.doc_date.split('-').reverse().join('-')}</td></tr>
                {isCn && links?.ref && <tr><th>{t('sales.cn.againstNo')}</th><td className="mono">{links.ref.doc_no}</td></tr>}
                {isCn && links?.ref && <tr><th>{t('sales.cn.againstDate')}</th><td>{dmy(links.ref.doc_date)}</td></tr>}
                {doc.vehicle_no && <tr><th>{t('invoice.vehicle')}</th><td className="mono">{doc.vehicle_no}</td></tr>}
                {doc.eway_bill_no && <tr><th>{t('invoice.ewayNo')}</th><td className="mono">{doc.eway_bill_no}</td></tr>}
              </tbody>
            </table>
          </div>
        </header>

        <section className="inv-parties">
          <div>
            <h3>{isCn ? t('sales.cn.customer') : t('invoice.billTo')}</h3>
            <p className="party-name">{doc.party_name}</p>
            {doc.party_address && <p>{doc.party_address}</p>}
            {party?.mobile && <p>{t('invoice.phone')}: {party.mobile}</p>}
            {doc.party_gstin && <p>{t('invoice.gstin')}: <b>{doc.party_gstin}</b></p>}
          </div>
          <div>
            {isCn && links?.ref && <><h3>{t('sales.cn.reasonHead')}</h3><p>{t('sales.cn.against', { no: links.ref.doc_no, date: dmy(links.ref.doc_date) })}{links.reason ? ` — ${links.reason}` : ''}</p></>}
            {doc.site && <><h3>{t('invoice.site')}</h3><p>{doc.site}</p></>}
            <h3>{t('invoice.placeOfSupply')}</h3>
            <p>{stateLabel(doc.place_of_supply)}{inter ? ` — ${t('invoice.interState')}` : ''}</p>
          </div>
        </section>

        <div className="inv-lines-wrap">
          <table className="inv-lines">
            <thead>
              <tr>
                <th className="c">{t('invoice.sn')}</th><th>{t('invoice.description')}</th><th>{t('invoice.hsn')}</th>
                <th className="r">{t('invoice.qty')}</th><th className="r">{anyInclusive ? t('invoice.rateIncl') : t('invoice.rate')}</th>
                <th className="r">{t('invoice.disc')}</th><th className="r">{t('invoice.taxable')}</th>
                {taxInvoice && <th className="r">{t('invoice.gst')}</th>}<th className="r">{t('invoice.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.line_no}>
                  <td className="c">{l.line_no}</td>
                  <td>{l.description}{breakdown(l) && <span className="sub">{breakdown(l)}</span>}</td>
                  <td>{l.hsn}</td>
                  <td className="r nowrap">{formatQty(l.rate_qty_milli, { trimZeros: true })} {unitName(l)}</td>
                  <td className="r">{formatRs(l.rate_paise, { symbol: false })}</td>
                  <td className="r">{l.discount_paise ? formatRs(l.discount_paise, { symbol: false }) : ''}</td>
                  <td className="r">{formatRs(l.taxable_paise, { symbol: false })}</td>
                  {taxInvoice && <td className="r">{l.gst_bp / 100}%</td>}
                  <td className="r">{formatRs(l.line_total_paise, { symbol: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="inv-foot">
          <div className="inv-left">
            {taxInvoice && <>
            <h3>{t('invoice.taxSummary')}</h3>
            <table className="tax-sum">
              <thead>
                <tr><th>{t('invoice.gst')}</th><th className="r">{t('invoice.taxable')}</th>
                  {inter ? <th className="r">IGST</th> : <><th className="r">CGST</th><th className="r">SGST</th></>}</tr>
              </thead>
              <tbody>
                {[...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([bp, e]) => (
                  <tr key={bp}>
                    <td>{bp / 100}%</td><td className="r">{formatRs(e.taxable, { symbol: false })}</td>
                    {inter ? <td className="r">{formatRs(e.igst, { symbol: false })}</td>
                      : <><td className="r">{formatRs(e.cgst, { symbol: false })}</td><td className="r">{formatRs(e.sgst, { symbol: false })}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
            </>}
            <h3>{t('invoice.inWords')}</h3>
            <p className="words">{amountInWords(doc.total_paise, lang === 'ta' ? 'ta' : 'en')}</p>
            {s['gst.scheme'] === 'composition' && <p className="small">{t('invoice.compositionNote')}</p>}
            {s['business.bank_details'] && <p className="small">{t('invoice.bank')}: {s['business.bank_details']}</p>}
            {!isCn && terms.map((x) => <p key={x} className="small muted">{x}</p>)}
          </div>
          <div className="inv-right">
            <table className="sums">
              <tbody>
                <tr><th>{t('invoice.taxable')}</th><td>{formatRs(doc.taxable_paise)}</td></tr>
                {!taxInvoice ? null : inter ? <tr><th>IGST</th><td>{formatRs(doc.igst_paise)}</td></tr> : <>
                  <tr><th>CGST</th><td>{formatRs(doc.cgst_paise)}</td></tr>
                  <tr><th>SGST</th><td>{formatRs(doc.sgst_paise)}</td></tr>
                </>}
                {doc.round_off_paise !== 0 && <tr><th>{t('bill.roundOff')}</th><td>{formatRs(doc.round_off_paise)}</td></tr>}
                <tr className="grand-row"><th>{isCn ? t('sales.ret.total') : t('bill.total')}</th><td>{formatRs(doc.total_paise)}</td></tr>
                {!isCn && bill.paidPaise > 0 && <tr><th>{t('invoice.paid')}</th><td>{formatRs(bill.paidPaise)}</td></tr>}
                {!isCn && returned > 0 && <tr><th>{t('sales.cn.returned')}</th><td>{formatRs(returned)}</td></tr>}
                {!isCn && (bill.paidPaise > 0 || returned > 0) && doc.status !== 'cancelled' && <tr><th>{t('invoice.balance')}</th><td><b>{formatRs(due)}</b></td></tr>}
                {isCn && (links?.refundedPaise ?? 0) > 0 && <tr><th>{t('sales.cn.refunded')}</th><td>{formatRs(links!.refundedPaise)}</td></tr>}
              </tbody>
            </table>
            {qr && (
              <figure className="upi">
                <img src={qr} alt="UPI QR" width={120} height={120} />
                <figcaption>{t('invoice.scanToPay')}<br /><b>{formatRs(due)}</b></figcaption>
              </figure>
            )}
            <div className="sign">
              <p>{[...new Set(labelLangs.map((l) => String(tFor(l)('invoice.for', { shop: nameIn(l, s['business.name_en'] ?? '', s['business.name_ta']) }))))].join(' / ')}</p>
              <p className="sign-line">{t('invoice.signatory')}</p>
            </div>
          </div>
        </section>
      </article>
    </div>
  );
}
