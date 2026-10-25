import { amountInWords, formatQty, formatRs, toPaise } from '@tula/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type BillInput, type CatalogItem, type Party, type Preview, type Warning } from '../api';
import { useApp } from '../App';
import { nameIn } from '../i18n';

interface LineState {
  key: number;
  sku: string;
  /** quantities keyed by unit code; the base unit is the "exact" quantity */
  qty: Record<string, string>;
  rate: string; // '' = automatic rate
  discount: string;
}

let keySeq = 1;
const emptyLine = (): LineState => ({ key: keySeq++, sku: '', qty: {}, rate: '', discount: '' });
const billUnits = (p: CatalogItem) => p.units.filter((u) => u.onBill);

/** Quantity entry for the API. A typed base-unit (exact) quantity overrides the other boxes. */
function entryFor(l: LineState, p: CatalogItem): Record<string, string> {
  const exact = l.qty[p.baseUnit]?.trim();
  if (exact) return { [p.baseUnit]: exact };
  const e: Record<string, string> = {};
  for (const u of billUnits(p)) {
    const v = l.qty[u.code]?.trim();
    if (v) e[u.code] = v;
  }
  return e;
}

export function NewBill({ ratesVersion }: { ratesVersion: number }) {
  const { t, i18n } = useTranslation();
  const { settings, langs } = useApp();
  const ui = i18n.language;
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [customerText, setCustomerText] = useState('');
  const [site, setSite] = useState('');
  const [billLang, setBillLang] = useState<string | null>(null); // null = customer's / business default
  const [lines, setLines] = useState<LineState[]>([emptyLine()]);
  const [payMode, setPayMode] = useState<'cash' | 'upi' | 'bank' | 'cheque'>('cash');
  const [paid, setPaid] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [held, setHeld] = useState<{ warnings: Warning[]; blocked: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ id: string; docNo: string } | null>(null);
  const firstItemRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.catalog(), api.parties()])
      .then(([c, p]) => {
        setCatalog(c);
        const customers = p.filter((x) => x.party_type !== 'supplier');
        setParties(customers);
        setCustomerText((cur) => cur || nameIn(ui, customers.find((x) => x.is_walk_in)?.name_en ?? '', customers.find((x) => x.is_walk_in)?.name_ta));
      })
      .catch((e) => setError(e instanceof ApiError && e.status === 0 ? t('errors.network') : (e as Error).message));
  }, [ratesVersion, saved, t, ui]);

  const bySku = useMemo(() => new Map(catalog.map((p) => [p.sku, p])), [catalog]);
  const party = useMemo(
    () => parties.find((p) => [p.name_en, p.name_ta, p.mobile].includes(customerText.trim())),
    [parties, customerText],
  );
  useEffect(() => setBillLang(null), [party?.id]);

  const validLines = lines
    .map((l) => ({ l, p: bySku.get(l.sku) }))
    .filter((x): x is { l: LineState; p: CatalogItem } => !!x.p && Object.keys(entryFor(x.l, x.p)).length > 0);

  const input: BillInput | null = party && validLines.length
    ? {
      partyId: party.id, site: site || undefined, lang: billLang ?? undefined,
      lines: validLines.map(({ l, p }) => ({ productId: p.id, entry: entryFor(l, p), rate: l.rate || undefined, discount: l.discount || undefined })),
      payment: paid.trim() ? { mode: payMode, amount: paid.trim() } : undefined,
    }
    : null;
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    setHeld(null);
    if (!input) { setPreview(null); return; }
    const h = setTimeout(() => {
      api.preview(input).then((p) => { setPreview(p); setError(''); }).catch((e) => { setPreview(null); setError((e as Error).message); });
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineCalc = (key: number) => {
    const idx = validLines.findIndex((x) => x.l.key === key);
    return idx >= 0 ? preview?.lines[idx] : undefined;
  };

  const save = async (confirm = false) => {
    if (!input) return;
    setSaving(true);
    try {
      const r = await api.saveBill({ ...input, confirmWarnings: confirm });
      if (!r.saved) { setHeld({ warnings: r.warnings, blocked: !!r.blocked }); return; }
      setSaved({ id: r.id!, docNo: r.docNo! });
      setLines([emptyLine()]); setPaid(''); setSite(''); setCustomerText(''); setPreview(null); setHeld(null); setBillLang(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const totals = preview?.totals;
  const paidPaise = (() => { try { return paid ? toPaise(paid) : 0; } catch { return 0; } })();
  const owesAfter = preview && totals ? preview.balanceBefore + totals.total - paidPaise : null;
  const activeLang = billLang ?? preview?.lang ?? party?.lang ?? settings?.values['invoice.default_lang'] ?? 'en';
  const setupNeeded = !!settings?.missingForBilling.length;

  return (
    <form className="bill" onSubmit={(e) => { e.preventDefault(); void save(false); }}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(!!held && !held.blocked); } }}>
      {saved && (
        <div className="saved-banner" role="status">
          <strong>{t('bill.saved', { no: saved.docNo })}</strong>
          <a className="btn primary" href={`#/print/${saved.id}`}>{t('bill.print')}</a>
          <button type="button" className="btn" onClick={() => { setSaved(null); firstItemRef.current?.focus(); }}>{t('bill.newBill')}</button>
        </div>
      )}

      <section className="bill-head">
        <div className="field grow">
          <label htmlFor="customer">{t('bill.customer')}</label>
          <input id="customer" list="customers" value={customerText} placeholder={t('bill.pickCustomer')} autoComplete="off"
            onChange={(e) => setCustomerText(e.target.value)} />
          <datalist id="customers">
            {parties.map((p) => <option key={p.id} value={nameIn(ui, p.name_en, p.name_ta)}>{p.mobile ?? ''}</option>)}
          </datalist>
          {party && !party.is_walk_in && (
            <p className="hint">
              {t('bill.outstanding')}: <b className={party.balance_paise > 0 ? 'owed' : ''}>{formatRs(party.balance_paise)}</b>
              {party.credit_limit_paise > 0 && <> &nbsp; {t('bill.creditLimit')}: {formatRs(party.credit_limit_paise)}</>}
            </p>
          )}
        </div>
        <div className="field grow">
          <label htmlFor="site">{t('bill.site')}</label>
          <input id="site" value={site} placeholder={t('bill.sitePlaceholder')} onChange={(e) => setSite(e.target.value)} />
        </div>
        {langs.length > 1 && (
          <div className="field">
            <span className="label" id="bill-lang">{t('bill.billLanguage')}</span>
            <div className="seg" role="group" aria-labelledby="bill-lang">
              {langs.map((l) => (
                <button key={l} type="button" aria-pressed={activeLang === l} onClick={() => setBillLang(l)}>{t(`lang.${l}`)}</button>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="bill-body">
        <section className="lines" aria-label={t('bill.item')}>
          <datalist id="items">
            {catalog.map((p) => <option key={p.id} value={p.sku}>{nameIn(ui, p.nameEn, p.nameTa)}</option>)}
          </datalist>
          {lines.map((l, i) => {
            const p = bySku.get(l.sku);
            const calc = lineCalc(l.key);
            const units = p ? billUnits(p) : [];
            const baseName = p ? nameIn(ui, p.baseUnitEn, p.baseUnitTa) : '';
            const exact = p ? !!l.qty[p.baseUnit]?.trim() : false;
            const calculated = !!p && !exact && units.some((u) => u.theoretical && l.qty[u.code]?.trim());
            const stockWarn = held?.warnings.find((w) => w.code === 'LOW_STOCK' && w.productId === p?.id);
            const setQty = (code: string, v: string, clearExact: boolean) => update(l.key, {
              qty: { ...l.qty, [code]: v, ...(clearExact && p ? { [p.baseUnit]: '' } : {}) },
            });
            return (
              <div className={`line${stockWarn ? ' warn' : ''}`} key={l.key}>
                <div className="field item">
                  <label htmlFor={`item-${l.key}`}>{t('bill.item')}</label>
                  <input id={`item-${l.key}`} ref={i === 0 ? firstItemRef : undefined} list="items" value={l.sku}
                    placeholder={t('bill.pickItem')} autoComplete="off" onChange={(e) => update(l.key, { sku: e.target.value.toUpperCase(), qty: {} })} />
                  {p && (
                    <p className="hint split">
                      <span>{nameIn(ui, p.nameEn, p.nameTa)}</span>
                      {p.stockMilli != null && <span>{t('bill.inStock')} {formatQty(p.stockMilli, { decimals: 0 })} {baseName}</span>}
                    </p>
                  )}
                </div>
                <div className="qty-group">
                  {units.map((u) => (
                    <Num key={u.code} id={`q-${u.code}-${l.key}`} label={nameIn(ui, u.nameEn, u.nameTa)} value={l.qty[u.code] ?? ''}
                      onChange={(v) => setQty(u.code, v, true)} />
                  ))}
                  <Num id={`q-base-${l.key}`} label={units.length ? t('bill.exact', { unit: baseName }) : `${t('bill.qty')}${baseName ? ` (${baseName})` : ''}`}
                    value={p ? l.qty[p.baseUnit] ?? '' : ''} onChange={(v) => p && setQty(p.baseUnit, v, false)} />
                </div>
                <Num id={`rate-${l.key}`} label={`${t('bill.rate')} ₹`} value={l.rate}
                  placeholder={calc ? (calc.ratePaise / 100).toFixed(2) : p ? (p.ratePaise / 100).toFixed(2) : ''}
                  onChange={(v) => update(l.key, { rate: v })} />
                <Num id={`disc-${l.key}`} label={`${t('bill.discount')} ₹`} value={l.discount} onChange={(v) => update(l.key, { discount: v })} />
                <div className="line-amount">
                  <span className="amount">{calc ? formatRs(calc.taxable) : '—'}</span>
                  {calc && units.length > 0 && !exact && (
                    <span className="hint">{t(calculated ? 'bill.calculated' : 'bill.measured', { qty: formatQty(calc.baseQtyMilli, { trimZeros: true }), unit: baseName })}</span>
                  )}
                </div>
                <button type="button" className="icon-btn" aria-label={t('bill.removeLine')} title={t('bill.removeLine')}
                  onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [emptyLine()]))}>×</button>
              </div>
            );
          })}
          <button type="button" className="btn add-line" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ {t('bill.addLine')}</button>
          {!party && <p className="empty">{t('bill.needCustomer')}</p>}
          {party && !validLines.length && <p className="empty">{t('bill.emptyLines')}</p>}
        </section>

        <aside className="totals" aria-live="polite">
          {preview?.supply === 'inter' && <p className="notice">{t('bill.interState')}</p>}
          {preview?.docKind === 'bill_of_supply' && <p className="notice">{t('bill.noGst')}</p>}
          <dl>
            <div><dt>{t('bill.taxable')}</dt><dd>{totals ? formatRs(totals.taxable) : '—'}</dd></div>
            {preview?.docKind !== 'bill_of_supply' && (preview?.supply === 'inter'
              ? <div><dt>{t('bill.igst')}</dt><dd>{formatRs(totals?.igst ?? 0)}</dd></div>
              : <>
                <div><dt>{t('bill.cgst')}</dt><dd>{totals ? formatRs(totals.cgst) : '—'}</dd></div>
                <div><dt>{t('bill.sgst')}</dt><dd>{totals ? formatRs(totals.sgst) : '—'}</dd></div>
              </>)}
            <div><dt>{t('bill.roundOff')}</dt><dd>{totals ? formatRs(totals.roundOff) : '—'}</dd></div>
          </dl>
          <div className="grand">
            <span className="grand-label">{t('bill.total')}</span>
            <span className="grand-value">{totals ? formatRs(totals.total) : '₹0.00'}</span>
            {totals && <span className="grand-words">{amountInWords(totals.total, ui === 'ta' ? 'ta' : 'en')}</span>}
          </div>
          <div className="pay">
            <Num id="paid" label={`${t('bill.paidNow')} ₹`} value={paid} onChange={setPaid} />
            <div className="field">
              <span className="label" id="pay-mode">{t('bill.mode')}</span>
              <div className="seg" role="group" aria-labelledby="pay-mode">
                {(['cash', 'upi', 'bank', 'cheque'] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={payMode === m} onClick={() => setPayMode(m)}>{t(`bill.modes.${m}`)}</button>
                ))}
              </div>
            </div>
          </div>
          {owesAfter != null && party && !party.is_walk_in && (
            <p className="hint owes">{t('bill.balanceAfter')}: <b>{formatRs(owesAfter)}</b></p>
          )}
          {error && !setupNeeded && <p className="field-error" role="alert">{error}</p>}
          {held && (
            <div className="held" role="alert">
              <strong>{held.blocked ? t('bill.blocked') : t('bill.checkFirst')}</strong>
              <ul>{held.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
              {held.blocked && <p>{t('bill.blockedHelp')}</p>}
            </div>
          )}
          {held && !held.blocked
            ? <button type="button" className="btn primary big" disabled={saving} onClick={() => void save(true)}>{saving ? t('bill.saving') : t('bill.saveAnyway')}</button>
            : <button type="submit" className="btn primary big" disabled={!input || saving || setupNeeded || !!held?.blocked}>{saving ? t('bill.saving') : t('bill.save')}</button>}
        </aside>
      </div>
    </form>
  );
}

function Num(props: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="field num">
      <label htmlFor={props.id}>{props.label}</label>
      <input id={props.id} inputMode="decimal" autoComplete="off" value={props.value} placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value.replace(/[^\d.]/g, ''))} />
    </div>
  );
}
