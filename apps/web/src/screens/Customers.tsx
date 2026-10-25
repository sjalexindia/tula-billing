import { formatRs, stateFromGstin, STATES } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type CatalogItem, type Party, type PartyInput } from '../api';
import { useApp } from '../App';
import { nameIn } from '../i18n';
import { Field } from './Items';

export function Customers({ id }: { id?: string }) {
  if (id) return <PartyEditor id={id === 'new' ? undefined : id} />;
  return <PartyList />;
}

function PartyList() {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<Party[] | null>(null);
  const [q, setQ] = useState('');
  const { me } = useApp();
  useEffect(() => { api.partiesAll().then(setRows).catch(() => setRows([])); }, []);
  const ui = i18n.language;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !s || [r.name_en, r.name_ta ?? '', r.mobile ?? '', r.gstin ?? ''].some((x) => x.toLowerCase().includes(s)));
  }, [rows, q]);
  if (!rows) return null;
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('parties.title')}</h1>
        {me?.role !== 'viewer' && <a className="btn primary" href="#/customers/new">{t('parties.add')}</a>}
      </div>
      <input className="search" type="search" placeholder={t('parties.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.search')} />
      <table className="grid">
        <thead><tr><th>{t('common.name')}</th><th>{t('parties.mobile')}</th><th>{t('parties.type')}</th><th className="r">{t('parties.balance')}</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className={r.active === 0 ? 'inactive' : ''}>
              <td><a href={`#/customers/${r.id}`}>{nameIn(ui, r.name_en, r.name_ta)}</a>{r.is_walk_in ? <span className="sub">{t('parties.walkIn')}</span> : r.gstin && <span className="sub mono">{r.gstin}</span>}</td>
              <td className="mono">{r.mobile ?? ''}</td>
              <td>{t(`parties.types.${r.party_type}`)}</td>
              <td className={`r ${r.balance_paise > 0 ? 'owed' : ''}`}>{r.balance_paise ? formatRs(r.balance_paise) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PartyEditor({ id }: { id?: string }) {
  const { t, i18n } = useTranslation();
  const { isOwner, me, langs, settings } = useApp();
  const ui = i18n.language;
  const [f, setF] = useState<PartyInput>({ partyType: 'customer', name_en: '', name_ta: '', mobile: '', address: '', gstin: '', stateCode: '', creditLimit: '', creditDays: null, lang: null, openingBalance: '', active: true });
  const [walkIn, setWalkIn] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  const [rates, setRates] = useState<Array<{ key: number; sku: string; rate: string; adjust: string }>>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [ratesMsg, setRatesMsg] = useState('');

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
    if (!id) return;
    api.party(id).then((p) => {
      setF({
        partyType: p.party_type, name_en: p.name_en, name_ta: p.name_ta ?? '', mobile: p.mobile ?? '', address: p.address ?? '', gstin: p.gstin ?? '',
        stateCode: p.state_code, creditLimit: p.credit_limit_paise ? String(p.credit_limit_paise / 100) : '', creditDays: p.credit_days,
        lang: p.lang, openingBalance: p.opening_balance_paise ? String(p.opening_balance_paise / 100) : '', active: !!p.active,
      });
      setWalkIn(!!p.is_walk_in);
      setBalance(p.balance_paise);
      setRates(p.rates.map((r, i) => ({ key: i, sku: r.sku, rate: r.rate_paise != null ? (r.rate_paise / 100).toFixed(2) : '', adjust: r.adjust_paise != null ? String(r.adjust_paise / 100) : '' })));
      setLoaded(true);
    }).catch((e) => setError((e as Error).message));
  }, [id]);

  const set = <K extends keyof PartyInput>(key: K, v: PartyInput[K]) => setF((x) => ({ ...x, [key]: v }));
  const gstState = stateFromGstin(f.gstin);
  const readOnly = me?.role === 'viewer' || (!!id && !isOwner);
  const ownerOnly = !isOwner;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body: PartyInput = {
        ...f, gstin: f.gstin || null, stateCode: gstState ?? (f.stateCode || null), mobile: f.mobile || null,
        creditLimit: ownerOnly ? undefined : f.creditLimit, creditDays: ownerOnly ? undefined : f.creditDays,
        openingBalance: ownerOnly ? undefined : f.openingBalance,
      };
      const r = await api.saveParty(body, id);
      location.hash = id ? '#/customers' : `#/customers/${(r as { id: string }).id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveRates = async () => {
    setRatesMsg('');
    try {
      const list = rates.filter((r) => r.sku).map((r) => {
        const p = catalog.find((c) => c.sku === r.sku.toUpperCase());
        if (!p) throw new Error(`${r.sku}?`);
        return { productId: p.id, rate: r.rate || undefined, adjust: r.adjust || undefined };
      });
      await api.savePartyRates(id!, list);
      setRatesMsg(t('parties.ratesSaved'));
    } catch (e) {
      setRatesMsg((e as Error).message);
    }
  };

  if (!loaded) return error ? <p className="field-error">{error}</p> : null;
  return (
    <div className="stack">
      <form className="page editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="page-head">
          <h1>{id ? nameIn(ui, f.name_en, f.name_ta) : t('parties.add')}</h1>
          {balance != null && <span className={`page-sum ${balance > 0 ? 'owed' : ''}`}>{t('parties.balance')}: {formatRs(balance)}</span>}
          {id && !walkIn && <a className="btn" href={`#/statement/${id}`}>{t('nav.statement')}</a>}
          <a className="btn" href="#/customers">{t('common.back')}</a>
        </div>
        <fieldset disabled={readOnly}>
          <div className="form-grid">
            {!walkIn && isOwner && (
              <Field id="ptype" label={t('parties.type')}>
                <select id="ptype" value={f.partyType} onChange={(e) => set('partyType', e.target.value as PartyInput['partyType'])}>
                  {(['customer', 'supplier', 'both'] as const).map((x) => <option key={x} value={x}>{t(`parties.types.${x}`)}</option>)}
                </select>
              </Field>
            )}
            <Field id="pname" label={t('parties.nameEn')} wide><input id="pname" required value={f.name_en} maxLength={100} onChange={(e) => set('name_en', e.target.value)} /></Field>
            <Field id="pname_ta" label={t('parties.nameTa')} wide><input id="pname_ta" lang="ta" value={f.name_ta ?? ''} maxLength={100} onChange={(e) => set('name_ta', e.target.value)} /></Field>
            {!walkIn && <>
              <Field id="mobile" label={t('parties.mobile')}><input id="mobile" inputMode="tel" value={f.mobile ?? ''} onChange={(e) => set('mobile', e.target.value)} /></Field>
              <Field id="gstin" label={t('parties.gstin')} hint={gstState ? `${t('parties.gstinHelp')}: ${STATES[gstState]?.name}` : undefined}>
                <input id="gstin" className="mono" value={f.gstin ?? ''} maxLength={15} onChange={(e) => set('gstin', e.target.value.toUpperCase())} />
              </Field>
              {!gstState && (
                <Field id="state" label={t('parties.state')}>
                  <select id="state" value={f.stateCode || settings?.values['business.state_code'] || ''} onChange={(e) => set('stateCode', e.target.value)}>
                    {Object.entries(STATES).map(([c, s]) => <option key={c} value={c}>{c} — {s.name}</option>)}
                  </select>
                </Field>
              )}
              <Field id="addr" label={t('parties.address')} wide><textarea id="addr" rows={2} value={f.address ?? ''} maxLength={300} onChange={(e) => set('address', e.target.value)} /></Field>
              {langs.length > 1 && (
                <Field id="plang" label={t('parties.lang')}>
                  <select id="plang" value={f.lang ?? ''} onChange={(e) => set('lang', e.target.value || null)}>
                    <option value="">{t('parties.langDefault')}</option>
                    {langs.map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}
                  </select>
                </Field>
              )}
              {isOwner && <>
                <Field id="climit" label={t('parties.creditLimit')}><input id="climit" inputMode="decimal" value={f.creditLimit ?? ''} onChange={(e) => set('creditLimit', e.target.value)} /></Field>
                <Field id="cdays" label={t('parties.creditDays')}><input id="cdays" inputMode="numeric" value={f.creditDays ?? ''} onChange={(e) => set('creditDays', e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')))} /></Field>
                <Field id="opening" label={t('parties.opening')} hint={t('parties.openingHelp')}><input id="opening" inputMode="decimal" value={f.openingBalance ?? ''} onChange={(e) => set('openingBalance', e.target.value)} /></Field>
                <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> {t('parties.active')}</label>
              </>}
            </>}
          </div>
        </fieldset>
        {error && <p className="field-error" role="alert">{error}</p>}
        {!readOnly && (
          <div className="form-actions">
            <a className="btn" href="#/customers">{t('common.cancel')}</a>
            <button type="submit" className="btn primary" disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
          </div>
        )}
      </form>

      {id && !walkIn && isOwner && f.partyType !== 'supplier' && (
        <section className="page">
          <h2>{t('parties.rates')}</h2>
          <p className="hint">{t('parties.ratesHelp')}</p>
          <datalist id="rate-items">{catalog.map((c) => <option key={c.id} value={c.sku}>{nameIn(ui, c.nameEn, c.nameTa)}</option>)}</datalist>
          {rates.length > 0 && (
            <table className="grid compact">
              <thead><tr><th>{t('parties.item')}</th><th className="r">{t('parties.fixedRate')}</th><th className="r">{t('parties.adjust')}</th><th /></tr></thead>
              <tbody>
                {rates.map((r) => {
                  const p = catalog.find((c) => c.sku === r.sku.toUpperCase());
                  return (
                    <tr key={r.key}>
                      <td><input list="rate-items" aria-label={t('parties.item')} value={r.sku} onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, sku: e.target.value.toUpperCase() } : x)))} />
                        {p && <span className="sub">{nameIn(ui, p.nameEn, p.nameTa)} · {formatRs(p.ratePaise)}</span>}</td>
                      <td className="r"><input className="num" aria-label={t('parties.fixedRate')} inputMode="decimal" value={r.rate} onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, rate: e.target.value, adjust: '' } : x)))} /></td>
                      <td className="r"><input className="num" aria-label={t('parties.adjust')} inputMode="decimal" value={r.adjust} onChange={(e) => setRates((rs) => rs.map((x) => (x.key === r.key ? { ...x, adjust: e.target.value, rate: '' } : x)))} /></td>
                      <td><button type="button" className="icon-btn" aria-label={t('common.remove')} onClick={() => setRates((rs) => rs.filter((x) => x.key !== r.key))}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="form-actions left">
            <button type="button" className="btn small" onClick={() => setRates((rs) => [...rs, { key: Date.now(), sku: '', rate: '', adjust: '' }])}>{t('parties.addRate')}</button>
            <button type="button" className="btn primary" onClick={() => void saveRates()}>{t('parties.saveRates')}</button>
            {ratesMsg && <span role="status">{ratesMsg}</span>}
          </div>
        </section>
      )}
    </div>
  );
}
