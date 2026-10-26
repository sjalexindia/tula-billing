import { formatQty, formatRs, parseScaled, roundDiv, toMilli } from '@tula/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type OpeningRow, type Unit } from '../api';
import { nameIn } from '../i18n';

/** Enter the counted stock and its cost per unit; only changed rows are saved. */
export function OpeningStock() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const [rows, setRows] = useState<OpeningRow[] | null>(null);
  const [draft, setDraft] = useState<Record<string, { qty: string; cost: string }>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [units, setUnits] = useState<Map<string, Unit>>(new Map());

  const load = () => api.opening().then((r) => {
    setRows(r);
    setDraft(Object.fromEntries(r.map((x) => [x.product_id, { qty: x.qty_milli ? formatQty(x.qty_milli, { trimZeros: true }).replace(/,/g, '') : '', cost: x.cost_paise != null ? (x.cost_paise / 100).toFixed(2) : '' }])));
  });
  useEffect(() => {
    void load();
    api.units().then((u) => setUnits(new Map(u.map((x) => [x.code, x])))).catch(() => {});
  }, []);
  const unitName = (code: string) => { const u = units.get(code); return u ? nameIn(ui, u.name_en, u.name_ta) : code; };
  if (!rows) return null;

  const changed = rows.filter((r) => {
    const d = draft[r.product_id];
    const origQty = r.qty_milli ? formatQty(r.qty_milli, { trimZeros: true }).replace(/,/g, '') : '';
    const origCost = r.cost_paise != null ? (r.cost_paise / 100).toFixed(2) : '';
    return d && (d.qty !== origQty || d.cost !== origCost);
  });
  const value = (id: string) => {
    const d = draft[id];
    try { return d?.qty && d.cost ? roundDiv(toMilli(d.qty) * parseScaled(d.cost, 2), 1000) : 0; } catch { return 0; }
  };
  const total = rows.reduce((a, r) => a + value(r.product_id), 0);

  const save = async () => {
    if (!changed.length) { setMsg({ ok: false, text: t('opening.nothingChanged') }); return; }
    setSaving(true);
    try {
      const r = await api.saveOpening(changed.map((c) => ({ productId: c.product_id, qty: draft[c.product_id]!.qty || '0', cost: draft[c.product_id]!.cost || '0' })));
      setMsg({ ok: true, text: t('opening.saved', { n: r.items }) });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="page" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head">
        <h1>{t('opening.title')}</h1>
        <span className="page-sum">{t('opening.total')}: {formatRs(total)}</span>
      </div>
      <p className="hint">{t('opening.help')}</p>
      <div className="scroll-x"><table className="grid compact">
        <thead><tr><th>{t('items.title')}</th><th className="r">{t('opening.qty')}</th><th className="r">{t('opening.cost')}</th><th className="r">{t('opening.value')}</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const d = draft[r.product_id] ?? { qty: '', cost: '' };
            const set = (k: 'qty' | 'cost', v: string) => setDraft((x) => ({ ...x, [r.product_id]: { ...d, [k]: v.replace(/[^\d.]/g, '') } }));
            return (
              <tr key={r.product_id} className={changed.includes(r) ? 'changed' : ''}>
                <td>{nameIn(ui, r.name_en, r.name_ta)}<span className="sub mono">{r.sku}</span></td>
                <td className="r"><input className="num" inputMode="decimal" aria-label={`${t('opening.qty')} ${r.sku}`} value={d.qty} onChange={(e) => set('qty', e.target.value)} /> <span className="unit">{unitName(r.base_unit)}</span></td>
                <td className="r"><input className="num" inputMode="decimal" aria-label={`${t('opening.cost')} ${r.sku}`} value={d.cost} onChange={(e) => set('cost', e.target.value)} /></td>
                <td className="r">{value(r.product_id) ? formatRs(value(r.product_id)) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <div className="form-actions">
        {msg && <p className={msg.ok ? 'saved-note' : 'field-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
        <button type="submit" className="btn primary" disabled={saving}>{saving ? t('common.saving') : t('opening.save')}</button>
      </div>
    </form>
  );
}
