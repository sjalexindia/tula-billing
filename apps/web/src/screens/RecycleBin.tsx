import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Category } from '../api';
import { recycleApi, type BinRow } from '../api/recycle';
import { DeleteButton } from '../components/DeleteButton';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import '../styles/recycle.css';

/** Owner screen: masters deleted by mistake, and Restore; categories with no items can be deleted here. */
export function RecycleBin(_props: ScreenProps) {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const [rows, setRows] = useState<BinRow[] | null>(null);
  const [empty, setEmpty] = useState<Category[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [bin, cats, products] = await Promise.all([recycleApi.list(), api.categories(), api.products()]);
      setRows(bin);
      const used = new Set(products.map((p) => p.category_id));
      setEmpty(cats.filter((c) => !used.has(c.id)));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const restore = async (r: BinRow) => {
    setBusy(r.id);
    setMsg(null);
    try {
      await recycleApi.restore(r.kind, r.id);
      setMsg({ ok: true, text: t('recycle.restored', { name: nameIn(ui, r.name_en, r.name_ta) }) });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };

  const when = (iso: string) => new Date(iso).toLocaleString(t('recycle.locale'), { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="recycle-screen">
      <section className="page">
        <div className="page-head"><h1>{t('recycle.title')}</h1></div>
        <p className="hint">{t('recycle.lead')}</p>
        {msg && <p className={msg.ok ? 'saved-note' : 'field-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
        {rows && !rows.length && <p className="empty">{t('recycle.empty')}</p>}
        {rows && rows.length > 0 && (
          <div className="scroll-x">
            <table className="grid compact">
              <thead><tr><th>{t('recycle.what')}</th><th>{t('recycle.kind')}</th><th>{t('recycle.deleted')}</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}:${r.id}`}>
                    <td><b>{nameIn(ui, r.name_en, r.name_ta)}</b>{r.code && <span className="sub mono">{r.code}</span>}</td>
                    <td>{t(`recycle.kinds.${r.kind}`)}</td>
                    <td>{when(r.deleted_at)}{r.deleted_by && <span className="sub">{t('recycle.by', { name: r.deleted_by })}</span>}</td>
                    <td className="r"><button type="button" className="btn small" disabled={busy === r.id} onClick={() => void restore(r)}>{t('recycle.restore')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="page">
        <h2>{t('recycle.emptyCategories')}</h2>
        <p className="hint">{t('recycle.emptyCategoriesHelp')}</p>
        {!empty.length && <p className="empty">{t('recycle.noEmptyCategories')}</p>}
        <ul className="recycle-cats">
          {empty.map((c) => (
            <li key={c.id}>
              <span>{nameIn(ui, c.name_en, c.name_ta)}</span>
              <DeleteButton small kind="categories" id={c.id} name={nameIn(ui, c.name_en, c.name_ta)} onDone={() => void load()} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
