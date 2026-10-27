import { formatQty, formatRs, roundDiv, toPaise } from '@tula/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type CatalogItem, type Party } from '../api';
import {
  cleanNum, daysAgo, GST_CHOICES, PAY_MODES, purchasesApi, showDate, today, type PayMode, type PurchaseDetail, type PurchaseInput,
  type PurchasePreview, type PurchaseRow, type Warning,
} from '../api/purchases';
import { useApp } from '../App';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import '../styles/purchases.css';
import { warningText } from '../server-text';

export function Purchases({ id }: ScreenProps) {
  if (id === 'new') return <NewPurchase />;
  if (id) return <PurchaseView id={id} />;
  return <PurchaseList />;
}

const errText = (e: unknown, network: string) => (e instanceof ApiError && e.status === 0 ? network : (e as Error).message);

/** From / To date pickers shared by the list screens. */
export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="pu-filters">
      <div className="field"><label htmlFor="r-from">{t('purchases.common.from')}</label>
        <input id="r-from" type="date" value={from} max={to} onChange={(e) => e.target.value && onChange(e.target.value, to)} /></div>
      <div className="field"><label htmlFor="r-to">{t('purchases.common.to')}</label>
        <input id="r-to" type="date" value={to} min={from} max={today()} onChange={(e) => e.target.value && onChange(from, e.target.value)} /></div>
    </div>
  );
}

// =====================================================================
// List
// =====================================================================
function PurchaseList() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner } = useApp();
  const [range, setRange] = useState({ from: daysAgo(30), to: today() });
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    purchasesApi.list(range.from, range.to).then((r) => { setRows(r.rows); setError(''); }).catch((e) => setError(errText(e, t('purchases.common.network'))));
  }, [range, t]);
  const active = (rows ?? []).filter((r) => r.status === 'active');
  const total = active.filter((r) => r.doc_type === 'PUR').reduce((a, r) => a + r.total_paise, 0) - active.filter((r) => r.doc_type === 'DN').reduce((a, r) => a + r.total_paise, 0);
  const due = active.reduce((a, r) => a + r.due_paise, 0);
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('purchases.pur.title')}</h1>
        {isOwner && <a className="btn primary" href="#/purchases/new">+ {t('purchases.pur.new')}</a>}
      </div>
      {!isOwner && <p className="hint">{t('purchases.common.readOnly')}</p>}
      <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      {error && <p className="field-error" role="alert">{error}</p>}
      {rows && rows.length > 0 && (
        <ul className="pu-chips">
          <li><span className="k">{t('purchases.common.total')}</span><span className="v">{formatRs(total)}</span></li>
          <li className={due > 0 ? 'danger' : ''}><span className="k">{t('purchases.pur.due')}</span><span className="v">{formatRs(due)}</span></li>
        </ul>
      )}
      {rows && rows.length === 0 && <p className="empty">{t('purchases.common.none')}</p>}
      {rows && rows.length > 0 && (
        <div className="pu-scroll">
          <table className="grid">
            <thead><tr>
              <th>{t('purchases.common.date')}</th><th>{t('purchases.pur.ourNo')}</th><th>{t('purchases.common.supplier')}</th>
              <th className="r">{t('purchases.common.total')}</th><th className="r">{t('purchases.pur.due')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const link = r.doc_type === 'PUR' ? r.id : null;
                return (
                  <tr key={r.id} className={r.status === 'cancelled' ? 'cancelled' : ''}>
                    <td className="mono">{showDate(r.doc_date)}</td>
                    <td>
                      {link ? <a href={`#/purchases/${link}`}>{r.doc_no}</a> : <span className="mono">{r.doc_no}</span>}
                      <span className="sub">{r.doc_type === 'DN' ? `${t('purchases.pur.debitNote')} ${t('purchases.pur.against', { no: r.ref_doc_no })}` : `${t('purchases.pur.billNo')}: ${r.supplier_bill_no ?? ''}`}</span>
                    </td>
                    <td>{nameIn(ui, r.party_en, r.party_ta)}</td>
                    <td className="r">{r.doc_type === 'DN' ? `−${formatRs(r.total_paise)}` : formatRs(r.total_paise)}</td>
                    <td className={`r ${r.due_paise > 0 ? 'owed' : ''}`}>
                      {r.status === 'cancelled' ? t('purchases.common.cancelled') : r.doc_type === 'PUR' ? (r.due_paise > 0 ? formatRs(r.due_paise) : <span className="paid">{t('purchases.pur.paid')}</span>) : ''}
                      {r.due_paise > 0 && r.due_date && <span className="sub">{t('purchases.pay.dueOn', { date: showDate(r.due_date) })}</span>}
                    </td>
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

// =====================================================================
// New purchase
// =====================================================================
interface LineState { key: number; sku: string; qty: Record<string, string>; rate: string; gst: string }
interface ChargeState { key: number; description: string; amount: string; gst: string }
let seq = 1;
const emptyLine = (): LineState => ({ key: seq++, sku: '', qty: {}, rate: '', gst: '' });
const qtyUnits = (p: CatalogItem) => p.units.filter((u) => u.onBill);

function entryFor(l: LineState, p: CatalogItem): Record<string, string> {
  const exact = l.qty[p.baseUnit]?.trim();
  if (exact) return { [p.baseUnit]: exact };
  const e: Record<string, string> = {};
  for (const u of qtyUnits(p)) {
    const v = l.qty[u.code]?.trim();
    if (v) e[u.code] = v;
  }
  return e;
}

export function Num(props: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; signed?: boolean }) {
  return (
    <div className="field num">
      <label htmlFor={props.id}>{props.label}</label>
      <input id={props.id} inputMode="decimal" autoComplete="off" value={props.value} placeholder={props.placeholder}
        onChange={(e) => props.onChange(cleanNum(e.target.value, props.signed))} />
    </div>
  );
}

const suppliersOf = (ps: Party[]) => ps.filter((p) => p.party_type !== 'customer' && !p.is_walk_in);

function NewPurchase() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { settings, isOwner } = useApp();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [suppliers, setSuppliers] = useState<Party[] | null>(null);
  const [supplierText, setSupplierText] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today());
  const [inclusive, setInclusive] = useState(false);
  const [itc, setItc] = useState<boolean | null>(null); // null = automatic
  const [lines, setLines] = useState<LineState[]>([emptyLine()]);
  const [charges, setCharges] = useState<ChargeState[]>([]);
  const [paid, setPaid] = useState('');
  const [payMode, setPayMode] = useState<PayMode>('cash');
  const [preview, setPreview] = useState<PurchasePreview | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ id: string; docNo: string; paymentNo: string | null } | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.catalog(), api.parties()])
      .then(([c, p]) => { setCatalog(c); setSuppliers(suppliersOf(p)); })
      .catch((e) => setError(errText(e, t('purchases.common.network'))));
  }, [saved, t]);

  const bySku = useMemo(() => new Map(catalog.map((p) => [p.sku, p])), [catalog]);
  const supplier = useMemo(() => (suppliers ?? []).find((p) => [p.name_en, p.name_ta].includes(supplierText.trim())), [suppliers, supplierText]);
  useEffect(() => setItc(null), [supplier?.id]);

  const valid = lines.map((l) => ({ l, p: bySku.get(l.sku) })).filter((x): x is { l: LineState; p: CatalogItem } => !!x.p && Object.keys(entryFor(x.l, x.p)).length > 0 && x.l.rate.trim() !== '');
  const input: PurchaseInput | null = supplier && valid.length ? {
    supplierId: supplier.id, supplierBillNo: billNo.trim() || '?', date, ratesIncludeGst: inclusive, itcEligible: itc ?? undefined,
    lines: valid.map(({ l, p }) => ({ productId: p.id, entry: entryFor(l, p), rate: l.rate, gst: l.gst || undefined })),
    charges: charges.filter((c) => c.amount.trim()).map((c) => ({ description: c.description.trim() || t('purchases.pur.chargeDefault'), amount: c.amount, gst: c.gst || undefined })),
    payment: paid.trim() ? { mode: payMode, amount: paid.trim() } : undefined,
  } : null;
  const key = JSON.stringify(input);

  useEffect(() => {
    if (!input) { setPreview(null); return; }
    const h = setTimeout(() => {
      purchasesApi.preview(input).then((p) => { setPreview(p); setError(''); }).catch((e) => { setPreview(null); setError(errText(e, t('purchases.common.network'))); });
    }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = (k: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const updateCharge = (k: number, patch: Partial<ChargeState>) => setCharges((cs) => cs.map((c) => (c.key === k ? { ...c, ...patch } : c)));
  const calcFor = (k: number) => {
    const i = valid.findIndex((x) => x.l.key === k);
    return i >= 0 ? preview?.lines[i] : undefined;
  };

  const save = async () => {
    if (!input) return;
    if (!billNo.trim()) { setError(t('purchases.pur.needBillNo')); return; }
    setSaving(true);
    try {
      const r = await purchasesApi.save({ ...input, supplierBillNo: billNo.trim() });
      setSaved({ id: r.id, docNo: r.docNo, paymentNo: r.paymentNo });
      setLines([emptyLine()]); setCharges([]); setPaid(''); setBillNo(''); setSupplierText(''); setPreview(null); setItc(null); setInclusive(false);
      window.scrollTo(0, 0);
    } catch (e) {
      setError(errText(e, t('purchases.common.network')));
    } finally {
      setSaving(false);
    }
  };

  if (!isOwner) return <section className="page"><p className="hint">{t('purchases.common.readOnly')}</p></section>;
  const sv = settings?.values ?? {};
  const saleInclusive = sv['billing.rates_include_gst'] === 'true' && sv['gst.scheme'] === 'regular';
  const totals = preview?.totals;
  const tax = totals ? totals.cgst + totals.sgst + totals.igst : 0;
  const paidPaise = (() => { try { return paid ? toPaise(paid) : 0; } catch { return 0; } })();
  const itcOn = preview ? preview.itc : itc ?? false;
  const noItcWhy = sv['gst.scheme'] !== 'regular' ? 'noItcScheme' : supplier && !supplier.gstin ? 'noItcGstin' : null;

  return (
    <form className="bill pu-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {saved && (
        <div className="saved-banner" role="status">
          <strong>{t('purchases.pur.saved', { no: saved.docNo })}{saved.paymentNo && ` ${t('purchases.pur.savedPaid', { no: saved.paymentNo })}`}</strong>
          <a className="btn" href={`#/purchases/${saved.id}`}>{t('purchases.pur.view')}</a>
          <button type="button" className="btn primary" onClick={() => { setSaved(null); firstRef.current?.focus(); }}>{t('purchases.pur.another')}</button>
        </div>
      )}
      <div className="page-head">
        <h1>{t('purchases.pur.new')}</h1>
        <a className="btn" href="#/purchases">{t('purchases.common.back')}</a>
      </div>
      <section className="bill-head">
        <div className="field grow">
          <label htmlFor="supplier">{t('purchases.common.supplier')}</label>
          <input id="supplier" ref={firstRef} list="suppliers" value={supplierText} placeholder={t('purchases.pur.pickSupplier')} autoComplete="off" onChange={(e) => setSupplierText(e.target.value)} />
          <datalist id="suppliers">{(suppliers ?? []).map((p) => <option key={p.id} value={nameIn(ui, p.name_en, p.name_ta)}>{p.gstin ?? ''}</option>)}</datalist>
          {suppliers && suppliers.length === 0 && <p className="hint">{t('purchases.pur.noSuppliers')}</p>}
          {supplier && <p className="hint">{supplier.gstin && <span className="mono">{supplier.gstin} · </span>}{t('purchases.pur.supplierHint', { amount: formatRs(Math.max(0, -supplier.balance_paise)), days: supplier.credit_days })}</p>}
        </div>
        <div className="field">
          <label htmlFor="billno">{t('purchases.pur.billNo')}</label>
          <input id="billno" value={billNo} maxLength={30} autoComplete="off" onChange={(e) => setBillNo(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="billdate">{t('purchases.pur.billDate')}</label>
          <input id="billdate" type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <div className="pu-head-checks">
          <label className="check"><input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> {t('purchases.pur.ratesInclGst')}</label>
          <label className="check" title={t('purchases.pur.itcHelp')}>
            <input type="checkbox" checked={itcOn} disabled={!!noItcWhy} onChange={(e) => setItc(e.target.checked)} /> {t('purchases.pur.itc')}
          </label>
        </div>
      </section>

      <div className="bill-body">
        <section className="lines" aria-label={t('purchases.pur.linesTitle')}>
          <datalist id="pu-items">{catalog.map((p) => <option key={p.id} value={p.sku}>{nameIn(ui, p.nameEn, p.nameTa)}</option>)}</datalist>
          {lines.map((l) => {
            const p = bySku.get(l.sku);
            const calc = calcFor(l.key);
            const units = p ? qtyUnits(p) : [];
            const baseName = p ? nameIn(ui, p.baseUnitEn, p.baseUnitTa) : '';
            const setQty = (code: string, v: string, clearExact: boolean) => update(l.key, { qty: { ...l.qty, [code]: v, ...(clearExact && p ? { [p.baseUnit]: '' } : {}) } });
            // Margin hint: landed cost per base unit against today's sale rate (taken out of GST when sale rates include it).
            let margin: { cls: string; text: string } | null = null;
            if (p && calc) {
              const sale = saleInclusive ? roundDiv(p.ratePaise * 10000, 10000 + p.gstBp) : p.ratePaise;
              const unit = { unit: baseName };
              if (!sale) margin = { cls: '', text: t('purchases.pur.noSaleRate') };
              else {
                const m = sale - calc.landedPerBase;
                const pct = calc.landedPerBase > 0 ? (roundDiv(m * 1000, calc.landedPerBase) / 10).toFixed(1) : '0';
                margin = m >= 0
                  ? { cls: 'ok', text: t('purchases.pur.margin', { sale: formatRs(sale) + t('purchases.common.perUnit', unit), margin: formatRs(m), pct }) }
                  : { cls: 'loss', text: t('purchases.pur.loss', { sale: formatRs(sale) + t('purchases.common.perUnit', unit), margin: formatRs(-m) }) };
              }
            }
            return (
              <div className="pu-line" key={l.key}>
                <div className="field item">
                  <label htmlFor={`pi-${l.key}`}>{t('purchases.common.item')}</label>
                  <input id={`pi-${l.key}`} list="pu-items" value={l.sku} placeholder={t('purchases.common.pickItem')} autoComplete="off"
                    onChange={(e) => update(l.key, { sku: e.target.value.toUpperCase(), qty: {} })} />
                  {p && <p className="hint split"><span>{nameIn(ui, p.nameEn, p.nameTa)}</span>{p.stockMilli != null && <span>{t('purchases.common.inStock')} {formatQty(p.stockMilli, { decimals: 0 })} {baseName}</span>}</p>}
                </div>
                <div className="qty-group">
                  {units.map((u) => <Num key={u.code} id={`pq-${u.code}-${l.key}`} label={nameIn(ui, u.nameEn, u.nameTa)} value={l.qty[u.code] ?? ''} onChange={(v) => setQty(u.code, v, true)} />)}
                  <Num id={`pq-base-${l.key}`} label={units.length ? t('purchases.common.exact', { unit: baseName }) : `${t('purchases.common.qty')}${baseName ? ` (${baseName})` : ''}`}
                    value={p ? l.qty[p.baseUnit] ?? '' : ''} onChange={(v) => p && setQty(p.baseUnit, v, false)} />
                </div>
                <Num id={`pr-${l.key}`} label={t(inclusive ? 'purchases.pur.rateBaseIncl' : 'purchases.pur.rateBase', { unit: baseName || '…' })} value={l.rate} onChange={(v) => update(l.key, { rate: v })} />
                <div className="field">
                  <label htmlFor={`pg-${l.key}`}>{t('purchases.common.gst')}</label>
                  <select id={`pg-${l.key}`} value={l.gst || (p ? String(p.gstBp / 100) : '')} onChange={(e) => update(l.key, { gst: e.target.value })}>
                    {[...new Set([...GST_CHOICES, ...(p ? [String(p.gstBp / 100)] : [])])].map((g) => <option key={g} value={g}>{g}%</option>)}
                  </select>
                </div>
                <div className="line-amount">
                  <span className="amount">{calc ? formatRs(calc.taxable) : '—'}</span>
                  {calc && units.length > 0 && <span className="hint">{formatQty(calc.baseQtyMilli, { trimZeros: true })} {baseName}</span>}
                  {calc && p?.trackStock && <span className="hint" title={t('purchases.pur.landedHelp')}>{t('purchases.pur.landed', { amount: formatRs(calc.landedPerBase), unit: baseName })}</span>}
                  {margin && <span className={`hint pu-margin ${margin.cls}`}>{margin.text}</span>}
                </div>
                <button type="button" className="icon-btn" aria-label={t('purchases.common.removeLine')} title={t('purchases.common.removeLine')}
                  onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [emptyLine()]))}>×</button>
              </div>
            );
          })}
          <button type="button" className="btn add-line" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ {t('purchases.common.addLine')}</button>
          {!supplier && <p className="empty">{t('purchases.pur.needSupplier')}</p>}
          {supplier && !valid.length && <p className="empty">{t('purchases.pur.emptyLines')}</p>}

          <div className="pu-charges">
            <h2>{t('purchases.pur.charges')}</h2>
            <p className="hint">{t('purchases.pur.chargesHelp')}</p>
            {charges.map((c) => (
              <div className="pu-charge" key={c.key}>
                <div className="field"><label htmlFor={`cn-${c.key}`}>{t('purchases.pur.chargeName')}</label>
                  <input id={`cn-${c.key}`} value={c.description} maxLength={80} onChange={(e) => updateCharge(c.key, { description: e.target.value })} /></div>
                <Num id={`ca-${c.key}`} label={t('purchases.pur.chargeAmount')} value={c.amount} onChange={(v) => updateCharge(c.key, { amount: v })} />
                <div className="field"><label htmlFor={`cg-${c.key}`}>{t('purchases.common.gst')}</label>
                  <select id={`cg-${c.key}`} value={c.gst || '0'} onChange={(e) => updateCharge(c.key, { gst: e.target.value })}>
                    {GST_CHOICES.map((g) => <option key={g} value={g}>{g}%</option>)}
                  </select></div>
                <span className="amount">{preview?.charges[charges.filter((x) => x.amount.trim()).indexOf(c)] ? formatRs(preview.charges[charges.filter((x) => x.amount.trim()).indexOf(c)]!.total) : ''}</span>
                <button type="button" className="icon-btn" aria-label={t('purchases.common.removeLine')} onClick={() => setCharges((cs) => cs.filter((x) => x.key !== c.key))}>×</button>
              </div>
            ))}
            <button type="button" className="btn small add-line" onClick={() => setCharges((cs) => [...cs, { key: seq++, description: t('purchases.pur.chargeDefault'), amount: '', gst: '0' }])}>+ {t('purchases.pur.addCharge')}</button>
          </div>
        </section>

        <aside className="totals" aria-live="polite">
          {preview?.supply === 'inter' && <p className="notice">{t('purchases.pur.interState')}</p>}
          {noItcWhy && supplier && <p className="notice">{t(`purchases.pur.${noItcWhy}`)}</p>}
          <dl>
            <div><dt>{t('purchases.pur.itemsTotal')}</dt><dd>{totals ? formatRs(totals.taxable - totals.chargesPaise) : '—'}</dd></div>
            {totals && totals.chargesPaise > 0 && <div><dt>{t('purchases.pur.chargesTotal')}</dt><dd>{formatRs(totals.chargesPaise)}</dd></div>}
            {preview?.supply === 'inter'
              ? <div><dt>{t('purchases.common.igst')}</dt><dd>{formatRs(totals?.igst ?? 0)}</dd></div>
              : <>
                <div><dt>{t('purchases.common.cgst')}</dt><dd>{totals ? formatRs(totals.cgst) : '—'}</dd></div>
                <div><dt>{t('purchases.common.sgst')}</dt><dd>{totals ? formatRs(totals.sgst) : '—'}</dd></div>
              </>}
            {totals && tax > 0 && !itcOn && <div><dt /><dd className="hint">{t('purchases.pur.taxInCost')}</dd></div>}
            <div><dt>{t('purchases.common.roundOff')}</dt><dd>{totals ? formatRs(totals.roundOff) : '—'}</dd></div>
          </dl>
          <div className="grand">
            <span className="grand-label">{t('purchases.pur.totals')}</span>
            <span className="grand-value">{totals ? formatRs(totals.total) : '₹0.00'}</span>
            {preview && <span className="grand-words">{t('purchases.pur.dueDate')}: {showDate(preview.dueDate)}</span>}
          </div>
          <div className="pay">
            <Num id="pu-paid" label={t('purchases.pur.payNow')} value={paid} onChange={setPaid} />
            <div className="field">
              <span className="label" id="pu-mode">{t('purchases.common.mode')}</span>
              <div className="seg" role="group" aria-labelledby="pu-mode">
                {PAY_MODES.map((m) => <button key={m} type="button" aria-pressed={payMode === m} onClick={() => setPayMode(m)}>{t(`purchases.modes.${m}`)}</button>)}
              </div>
            </div>
          </div>
          {totals && <p className="hint owes">{t('purchases.pur.owesAfter', { amount: formatRs(Math.max(0, -(supplier?.balance_paise ?? 0)) + totals.total - paidPaise) })}</p>}
          {error && <p className="field-error" role="alert">{error}</p>}
          <button type="submit" className="btn primary big" disabled={!input || saving || !preview}>{saving ? t('purchases.common.saving') : t('purchases.pur.save')}</button>
        </aside>
      </div>
    </form>
  );
}

// =====================================================================
// One purchase: lines, payments, returns; return goods and cancel
// =====================================================================
function PurchaseView({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner } = useApp();
  const [d, setD] = useState<PurchaseDetail | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [dialog, setDialog] = useState<'return' | 'cancel' | null>(null);
  const load = () => purchasesApi.get(id).then(setD).catch((e) => setError(errText(e, t('purchases.common.network'))));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [id]);
  if (error && !d) return <p className="field-error" role="alert">{error}</p>;
  if (!d) return null;
  const doc = d.doc;
  const items = d.lines.filter((l) => l.product_id);
  const charges = d.lines.filter((l) => !l.product_id);
  const active = doc.status === 'active';
  const party = nameIn(ui, doc.party_en, doc.party_ta);
  const unitOf = (l: PurchaseDetail['lines'][number]) => nameIn(ui, l.base_unit_en ?? '', l.base_unit_ta);
  const canReturn = active && items.some((l) => l.remaining_milli > 0);
  const hasActiveReturns = d.returns.some((r) => r.status === 'active');

  return (
    <section className="page">
      <div className="page-head">
        <h1>{doc.doc_no}</h1>
        <div className="pu-actions">
          {isOwner && active && doc.due_paise > 0 && <a className="btn primary" href={`#/payments/${doc.party_id}`}>{t('purchases.pur.pay')}</a>}
          {isOwner && canReturn && <button type="button" className="btn" onClick={() => setDialog('return')}>{t('purchases.pur.returnGoods')}</button>}
          {isOwner && active && <button type="button" className="btn" disabled={hasActiveReturns} title={hasActiveReturns ? t('purchases.pur.hasReturns') : undefined} onClick={() => setDialog('cancel')}>{t('purchases.common.cancel')}</button>}
          <a className="btn" href="#/purchases">{t('purchases.common.back')}</a>
        </div>
      </div>
      {msg && <p className="saved-banner" role="status">{msg}</p>}
      {!active && <p className="pu-note cancelled">{t('purchases.pur.cancelledNote', { reason: doc.cancel_reason ?? '' })}</p>}
      <dl className="pu-kv">
        <div><dt>{t('purchases.common.supplier')}</dt><dd>{party}{doc.party_gstin && <span className="sub mono">{doc.party_gstin}</span>}</dd></div>
        <div><dt>{t('purchases.pur.billNo')}</dt><dd className="mono">{doc.supplier_bill_no}</dd></div>
        <div><dt>{t('purchases.pur.billDate')}</dt><dd className="mono">{showDate(doc.doc_date)}</dd></div>
        <div><dt>{t('purchases.pur.dueDate')}</dt><dd className="mono">{showDate(doc.due_date)}</dd></div>
        <div><dt>{t('purchases.pur.due')}</dt><dd className={doc.due_paise > 0 ? 'owed' : ''}>{formatRs(doc.due_paise)}</dd></div>
        <div><dt>{t('purchases.pur.itc')}</dt><dd>{doc.itc_eligible ? t('common.yes') : t('common.no')}</dd></div>
      </dl>
      <div className="pu-scroll">
        <table className="grid">
          <thead><tr>
            <th>{t('purchases.common.item')}</th><th className="r">{t('purchases.common.qty')}</th><th className="r">{t('purchases.common.rate')}</th>
            <th className="r">{t('purchases.common.taxable')}</th><th className="r">{t('purchases.common.gst')}</th><th className="r">{t('purchases.pur.landedCol')}</th>
          </tr></thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id}>
                <td>{nameIn(ui, l.name_en ?? l.description, l.name_ta)}<span className="sub mono">{l.sku}</span></td>
                <td className="r">{formatQty(l.base_qty_milli, { trimZeros: true })} {unitOf(l)}
                  {l.returned_milli > 0 && <span className="sub">{t('purchases.pur.returned')}: {formatQty(l.returned_milli, { trimZeros: true })}</span>}</td>
                <td className="r">{formatRs(l.rate_paise)}</td>
                <td className="r">{formatRs(l.taxable_paise)}</td>
                <td className="r">{l.gst_bp / 100}%<span className="sub">{formatRs(l.cgst_paise + l.sgst_paise + l.igst_paise)}</span></td>
                <td className="r">{l.landed_cost_paise != null ? formatRs(roundDiv(l.landed_cost_paise * 1000, l.base_qty_milli)) : ''}
                  {l.charge_share_paise > 0 && <span className="sub">+{formatRs(l.charge_share_paise)}</span>}</td>
              </tr>
            ))}
            {charges.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td><td /><td />
                <td className="r">{formatRs(l.taxable_paise)}</td>
                <td className="r">{l.gst_bp / 100}%<span className="sub">{formatRs(l.cgst_paise + l.sgst_paise + l.igst_paise)}</span></td><td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="pu-sums">
        <div><dt>{t('purchases.common.taxable')}</dt><dd>{formatRs(doc.taxable_paise)}</dd></div>
        {doc.supply_type === 'inter'
          ? <div><dt>{t('purchases.common.igst')}</dt><dd>{formatRs(doc.igst_paise)}</dd></div>
          : <><div><dt>{t('purchases.common.cgst')}</dt><dd>{formatRs(doc.cgst_paise)}</dd></div><div><dt>{t('purchases.common.sgst')}</dt><dd>{formatRs(doc.sgst_paise)}</dd></div></>}
        <div><dt>{t('purchases.common.roundOff')}</dt><dd>{formatRs(doc.round_off_paise)}</dd></div>
        <div className="grand-row"><dt>{t('purchases.common.total')}</dt><dd>{formatRs(doc.total_paise)}</dd></div>
      </dl>

      <h2>{t('purchases.pur.payments')}</h2>
      {d.payments.length === 0 ? <p className="hint">{t('purchases.pur.noPayments')}</p> : (
        <table className="grid compact"><tbody>
          {d.payments.map((p) => <tr key={p.id}><td className="mono">{showDate(p.doc_date)}</td><td className="mono">{p.doc_no}</td><td>{t(`purchases.modes.${p.mode}`)}</td><td className="r">{formatRs(p.amount_paise)}</td></tr>)}
        </tbody></table>
      )}
      {d.returns.length > 0 && <>
        <h2>{t('purchases.pur.returns')}</h2>
        <table className="grid compact"><tbody>
          {d.returns.map((r) => <tr key={r.id} className={r.status === 'cancelled' ? 'cancelled' : ''}><td className="mono">{showDate(r.doc_date)}</td><td className="mono">{r.doc_no}</td><td>{r.notes}</td><td className="r">{formatRs(r.total_paise)}</td></tr>)}
        </tbody></table>
      </>}

      {dialog === 'return' && <ReturnDialog d={d} onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); setMsg(m); void load(); }} />}
      {dialog === 'cancel' && (
        <CancelDialog title={t('purchases.pur.cancelTitle', { no: doc.doc_no })} help={t('purchases.pur.cancelHelp')} placeholder={t('purchases.pur.cancelReasonPh')} action={t('purchases.pur.cancelDo')}
          onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }}
          run={(reason, confirm) => purchasesApi.cancel(doc.id, reason, confirm)} />
      )}
    </section>
  );
}

/** Native modal dialog: Esc and the backdrop close it, focus stays inside. */
export function Modal({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => { if (el?.open) el.close(); };
  }, []);
  return <dialog ref={ref} className="pu-dialog" aria-label={label} onCancel={(e) => { e.preventDefault(); onClose(); }}>{children}</dialog>;
}

function ReturnDialog({ d, onClose, onDone }: { d: PurchaseDetail; onClose: () => void; onDone: (msg: string) => void }) {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const items = d.lines.filter((l) => l.product_id && l.remaining_milli > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const title = t('purchases.pur.returnTitle', { name: nameIn(ui, d.doc.party_en, d.doc.party_ta) });
  const submit = async () => {
    if (!reason.trim()) { setError(t('purchases.common.reasonNeeded')); return; }
    setBusy(true);
    try {
      const r = await purchasesApi.returnGoods(d.doc.id, reason.trim(), Object.entries(qty).filter(([, v]) => v.trim()).map(([lineId, q]) => ({ lineId, qty: q })));
      onDone(t('purchases.pur.returnSaved', { no: r.docNo, amount: formatRs(r.total) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={title}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2>{title}</h2>
        <div className="pu-scroll">
          <table className="grid compact">
            <thead><tr><th>{t('purchases.common.item')}</th><th className="r">{t('purchases.common.qty')}</th></tr></thead>
            <tbody>
              {items.map((l) => {
                const unit = nameIn(ui, l.base_unit_en ?? '', l.base_unit_ta);
                return (
                  <tr key={l.id}>
                    <td>{nameIn(ui, l.name_en ?? l.description, l.name_ta)}<span className="sub">{t('purchases.pur.canReturn', { qty: `${formatQty(l.remaining_milli, { trimZeros: true })} ${unit}` })}</span></td>
                    <td className="r"><input className="num" inputMode="decimal" aria-label={t('purchases.pur.returnQty', { unit })} placeholder={unit}
                      value={qty[l.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.id]: cleanNum(e.target.value) }))} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="field">
          <label htmlFor="ret-reason">{t('purchases.pur.returnReason')}</label>
          <textarea id="ret-reason" rows={2} maxLength={200} value={reason} placeholder={t('purchases.pur.returnReasonPh')} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>{t('purchases.common.close')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? t('purchases.common.saving') : t('purchases.pur.saveReturn')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Ask for a reason, then cancel. If the server warns (e.g. stock below zero), show the warnings and ask again. */
export function CancelDialog(props: {
  title: string; help: string; placeholder: string; action: string; onClose: () => void; onDone: () => void;
  run: (reason: string, confirm: boolean) => Promise<{ saved?: boolean; warnings?: Warning[] } | { ok: boolean }>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [warnings, setWarnings] = useState<Warning[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason.trim()) { setError(t('purchases.common.reasonNeeded')); return; }
    setBusy(true);
    try {
      const r = await props.run(reason.trim(), !!warnings);
      if ('saved' in r && r.saved === false) { setWarnings(r.warnings ?? []); return; }
      props.onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={props.onClose} label={props.title}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2>{props.title}</h2>
        <p className="hint">{props.help}</p>
        <div className="field">
          <label htmlFor="cancel-reason">{t('purchases.common.reason')}</label>
          <textarea id="cancel-reason" rows={2} maxLength={200} value={reason} placeholder={props.placeholder} onChange={(e) => { setReason(e.target.value); setWarnings(null); }} />
        </div>
        {warnings && (
          <div className="held" role="alert">
            <strong>{t('purchases.common.stockWarn')}</strong>
            <ul>{warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}</ul>
          </div>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={props.onClose}>{t('purchases.common.close')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? t('purchases.common.saving') : warnings ? t('purchases.common.confirmCancel') : props.action}</button>
        </div>
      </form>
    </Modal>
  );
}
