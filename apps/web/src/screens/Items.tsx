import { formatQty, formatRs, steelRodWeightMilli } from '@tula/core';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Category, type ProductInput, type ProductRow, type RateGroupRow, type Unit } from '../api';
import { useApp } from '../App';
import { DeleteButton } from '../components/DeleteButton';
import { nameIn } from '../i18n';

const GST_RATES = ['0', '5', '18', '40', '3', '0.25', '12', '28'];

export function Items({ id }: { id?: string }) {
  if (id) return <ItemEditor id={id === 'new' ? undefined : id} />;
  return <ItemList />;
}

function ItemList() {
  const { t, i18n } = useTranslation();
  const { isOwner } = useApp();
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [q, setQ] = useState('');
  const [units, setUnits] = useState<Map<string, Unit>>(new Map());
  useEffect(() => {
    api.products().then(setRows).catch(() => setRows([]));
    api.units().then((u) => setUnits(new Map(u.map((x) => [x.code, x])))).catch(() => {});
  }, []);
  const ui = i18n.language;
  const unitName = (code: string) => { const u = units.get(code); return u ? nameIn(ui, u.name_en, u.name_ta) : code; };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !s || [r.sku, r.name_en, r.name_ta ?? '', r.brand ?? ''].some((x) => x.toLowerCase().includes(s)));
  }, [rows, q]);
  if (!rows) return null;
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('items.title')}</h1>
        {isOwner && <a className="btn primary" href="#/items/new">{t('items.add')}</a>}
      </div>
      <input className="search" type="search" placeholder={t('items.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.search')} />
      {rows.length === 0 ? <p className="empty">{t('items.none')}</p> : shown.length === 0 ? <p className="empty">{t('items.noMatch')}</p> : (
        <div className="scroll-x"><table className="grid">
          <thead>
            <tr><th>{t('items.code')}</th><th>{t('common.name')}</th><th>{t('items.category')}</th><th className="r">{t('bill.rate')}</th><th>{t('items.gst')}</th><th className="r">{t('items.stock')}</th></tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'inactive'}>
                <td className="mono"><a href={`#/items/${r.id}`}>{r.sku}</a></td>
                <td>{[r.brand, nameIn(ui, r.name_en, r.name_ta)].filter(Boolean).join(' ')}{!r.active && <span className="sub">{t('items.inactive')}</span>}</td>
                <td>{nameIn(ui, r.category_en, r.category_ta)}</td>
                <td className="r">{r.rate_mode === 'daily' ? <span className="sub-inline">{r.rate_group}{r.rate_extra_paise ? ` +${formatRs(r.rate_extra_paise)}` : ''}</span> : formatRs(r.sale_rate_paise)}</td>
                <td>{r.gst_bp / 100}%</td>
                <td className="r">{r.track_stock ? `${formatQty(r.stock_milli, { decimals: 0 })} ${unitName(r.base_unit)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

interface UnitRow { key: number; unit: string; factor: string; onBill: boolean; theoretical: boolean }
let k = 1;

function ItemEditor({ id }: { id?: string }) {
  const { t, i18n } = useTranslation();
  const { isOwner } = useApp();
  const ui = i18n.language;
  const [cats, setCats] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [groups, setGroups] = useState<RateGroupRow[]>([]);
  const [f, setF] = useState<Omit<ProductInput, 'units'>>({
    sku: '', name_en: '', name_ta: '', categoryId: '', brand: '', hsn: '', gst: '18', baseUnit: 'NOS', trackStock: true, minStock: '',
    rateMode: 'fixed', rateGroup: null, rateExtra: '', saleRate: '', active: true,
  });
  const [uRows, setURows] = useState<UnitRow[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!id);

  useEffect(() => {
    Promise.all([api.categories(), api.units(), api.rateGroups()]).then(([c, u, g]) => {
      setCats(c); setUnits(u); setGroups(g);
      // a new item starts without a category so it is chosen, not inherited from the first in the list
    }).catch((e) => setError((e as Error).message));
    if (!id) return;
    api.product(id).then((p) => {
      setF({
        sku: p.sku, name_en: p.name_en, name_ta: p.name_ta ?? '', categoryId: p.category_id, brand: p.brand ?? '', hsn: p.hsn ?? '',
        gst: String(p.gst_bp / 100), baseUnit: p.base_unit, trackStock: !!p.track_stock, minStock: p.min_stock_milli ? String(p.min_stock_milli / 1000) : '',
        rateMode: p.rate_mode, rateGroup: p.rate_group, rateExtra: p.rate_extra_paise ? String(p.rate_extra_paise / 100) : '',
        saleRate: p.sale_rate_paise ? (p.sale_rate_paise / 100).toFixed(2) : '', active: !!p.active,
      });
      setURows(p.units.map((u) => ({ key: k++, unit: u.unit, factor: String(u.factor_milli / 1000), onBill: !!u.on_bill, theoretical: !!u.is_theoretical })));
      setLoaded(true);
    }).catch((e) => setError((e as Error).message));
  }, [id]);

  const set = <K extends keyof typeof f>(key: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [key]: v }));
  const unitName = (code: string) => { const u = units.find((x) => x.code === code); return u ? nameIn(ui, u.name_en, u.name_ta) : code; };
  const readOnly = !isOwner;
  const { settings } = useApp();
  const inclusive = settings?.values['billing.rates_include_gst'] === 'true' && settings?.values['gst.scheme'] === 'regular';

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body: ProductInput = { ...f, units: uRows.filter((u) => u.unit && u.factor).map(({ unit, factor, onBill, theoretical }) => ({ unit, factor, onBill, theoretical })) };
      await api.saveProduct(body, id);
      location.hash = '#/items';
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const newCategory = async () => {
    const name = window.prompt(t('items.newCategoryPrompt'));
    if (!name?.trim()) return;
    const r = await api.addCategory({ name_en: name.trim(), isService: false });
    setCats(await api.categories());
    set('categoryId', r.id);
  };
  /** For steel: fill a rod's theoretical weight from the size in the item code or name, e.g. "12mm". */
  const rodWeight = (row: UnitRow) => {
    const mm = Number(/(\d{1,2})\s*mm/i.exec(`${f.name_en} ${f.sku}`)?.[1] ?? /TMT-0?(\d{1,2})/i.exec(f.sku)?.[1]);
    if (!mm) return;
    setURows((rs) => rs.map((r) => (r.key === row.key ? { ...r, factor: String(steelRodWeightMilli(mm, 12) / 1000), theoretical: true } : r)));
  };

  if (!loaded) return error ? <p className="field-error">{error}</p> : null;
  return (
    <form className="page editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head">
        <h1>{id ? `${f.sku}` : t('items.add')}</h1>
        <a className="btn" href="#/items">{t('common.back')}</a>
      </div>
      <fieldset disabled={readOnly}>
        <div className="form-grid">
          <Field id="sku" label={t('items.code')}><input id="sku" value={f.sku} required maxLength={20} onChange={(e) => set('sku', e.target.value.toUpperCase())} /></Field>
          <Field id="name_en" label={t('items.nameEn')} wide><input id="name_en" value={f.name_en} required maxLength={120} onChange={(e) => set('name_en', e.target.value)} /></Field>
          <Field id="name_ta" label={t('items.nameTa')} wide><input id="name_ta" lang="ta" value={f.name_ta ?? ''} maxLength={120} onChange={(e) => set('name_ta', e.target.value)} /></Field>
          <Field id="brand" label={t('items.brand')}><input id="brand" value={f.brand ?? ''} maxLength={40} onChange={(e) => set('brand', e.target.value)} /></Field>
          <Field id="cat" label={t('items.category')}>
            <select id="cat" required value={f.categoryId} onChange={(e) => (e.target.value === '__new' ? void newCategory() : set('categoryId', e.target.value))}>
              <option value="" disabled>—</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{nameIn(ui, c.name_en, c.name_ta)}</option>)}
              <option value="__new">{t('items.newCategory')}</option>
            </select>
          </Field>
          <Field id="hsn" label={t('items.hsn')}><input id="hsn" inputMode="numeric" value={f.hsn ?? ''} maxLength={8} onChange={(e) => set('hsn', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field id="gst" label={t('items.gst')}>
            <select id="gst" value={f.gst} onChange={(e) => set('gst', e.target.value)}>{GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}</select>
          </Field>
          <Field id="base" label={t('items.baseUnit')}>
            <select id="base" value={f.baseUnit} onChange={(e) => set('baseUnit', e.target.value)}>{units.map((u) => <option key={u.code} value={u.code}>{nameIn(ui, u.name_en, u.name_ta)} ({u.code})</option>)}</select>
          </Field>
        </div>

        <h2>{t('items.pricing')}</h2>
        <div className="seg" role="group" aria-label={t('items.pricing')}>
          <button type="button" aria-pressed={f.rateMode === 'fixed'} onClick={() => set('rateMode', 'fixed')}>{t('items.fixed')}</button>
          <button type="button" aria-pressed={f.rateMode === 'daily'} disabled={!groups.length} onClick={() => set('rateMode', 'daily')}>{t('items.daily')}</button>
        </div>
        <div className="form-grid">
          {f.rateMode === 'fixed' ? (
            <Field id="rate" label={`${t('items.saleRate', { unit: unitName(f.baseUnit) })}${inclusive ? ` (${t('items.inclGst')})` : ''}`}><input id="rate" inputMode="decimal" value={f.saleRate ?? ''} onChange={(e) => set('saleRate', e.target.value)} /></Field>
          ) : (
            <>
              <Field id="group" label={t('items.rateGroup')}>
                <select id="group" value={f.rateGroup ?? ''} onChange={(e) => set('rateGroup', e.target.value)}>
                  <option value="" />
                  {groups.map((g) => <option key={g.code} value={g.code}>{nameIn(ui, g.name_en, g.name_ta)}</option>)}
                </select>
              </Field>
              <Field id="extra" label={t('items.rateExtra')}><input id="extra" inputMode="decimal" value={f.rateExtra ?? ''} onChange={(e) => set('rateExtra', e.target.value)} /></Field>
            </>
          )}
        </div>

        <h2>{t('items.stock')}</h2>
        <div className="form-grid">
          <label className="check"><input type="checkbox" checked={f.trackStock} onChange={(e) => set('trackStock', e.target.checked)} /> {t('items.trackStock')}</label>
          {f.trackStock && <Field id="min" label={`${t('items.minStock')} (${unitName(f.baseUnit)})`}><input id="min" inputMode="decimal" value={f.minStock ?? ''} onChange={(e) => set('minStock', e.target.value)} /></Field>}
          <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> {t('items.active')}</label>
        </div>

        <h2>{t('items.largerUnits')}</h2>
        <p className="hint">{t('items.largerHelp')}</p>
        {uRows.length > 0 && (
          <div className="scroll-x"><table className="grid compact">
            <thead><tr><th>{t('items.unit')}</th><th className="r">{t('items.howMany', { base: unitName(f.baseUnit) })}</th><th>{t('items.calculated')}</th><th>{t('items.onBill')}</th><th /></tr></thead>
            <tbody>
              {uRows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <select aria-label={t('items.unit')} value={r.unit} onChange={(e) => setURows((rs) => rs.map((x) => (x.key === r.key ? { ...x, unit: e.target.value } : x)))}>
                      <option value="" />
                      {units.filter((u) => u.code !== f.baseUnit).map((u) => <option key={u.code} value={u.code}>{nameIn(ui, u.name_en, u.name_ta)}</option>)}
                    </select>
                  </td>
                  <td className="r">
                    <input aria-label={t('items.howMany', { base: unitName(f.baseUnit) })} className="num" inputMode="decimal" value={r.factor}
                      onChange={(e) => setURows((rs) => rs.map((x) => (x.key === r.key ? { ...x, factor: e.target.value } : x)))} />
                    {r.unit === 'ROD' && f.baseUnit === 'KG' && !readOnly && <button type="button" className="link" onClick={() => rodWeight(r)}>d²/162</button>}
                  </td>
                  <td><input type="checkbox" aria-label={t('items.calculated')} checked={r.theoretical} onChange={(e) => setURows((rs) => rs.map((x) => (x.key === r.key ? { ...x, theoretical: e.target.checked } : x)))} /></td>
                  <td><input type="checkbox" aria-label={t('items.onBill')} checked={r.onBill} onChange={(e) => setURows((rs) => rs.map((x) => (x.key === r.key ? { ...x, onBill: e.target.checked } : x)))} /></td>
                  <td><button type="button" className="icon-btn" aria-label={t('common.remove')} onClick={() => setURows((rs) => rs.filter((x) => x.key !== r.key))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <button type="button" className="btn small" onClick={() => setURows((rs) => [...rs, { key: k++, unit: '', factor: '', onBill: true, theoretical: false }])}>{t('items.addUnit')}</button>
      </fieldset>
      {error && <p className="field-error" role="alert">{error}</p>}
      {!readOnly && (
        <div className="form-actions">
          <a className="btn" href="#/items">{t('common.cancel')}</a>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
          {id && <DeleteButton kind="products" id={id} name={f.name_en} onDone={() => { location.hash = '#/items'; }} />}
        </div>
      )}
    </form>
  );
}

import { Field } from '../components/Field';
export { Field };
