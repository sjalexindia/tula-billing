import { formatRs, stateFromGstin, toPaise } from '@tula/core';
import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Party } from '../api';
import {
  daysAgo, EXPENSE_MODES, GST_CHOICES, purchasesApi, showDate, today, type ExpenseHead, type ExpenseInput, type ExpenseList, type ExpenseMode,
  type ExpensePreview, type ExpenseRow,
} from '../api/purchases';
import { useApp } from '../App';
import { DeleteButton } from '../components/DeleteButton';
import { nameIn } from '../i18n';
import type { ScreenProps } from '../nav';
import { CancelDialog, DateRange, Num } from './Purchases';
import '../styles/purchases.css';

const errText = (e: unknown, network: string) => (e instanceof ApiError && e.status === 0 ? network : (e as Error).message);

export function Expenses({ id }: ScreenProps) {
  if (id === 'new') return <NewExpense />;
  if (id === 'heads') return <Heads />;
  return <ExpenseListView />;
}

function ExpenseListView() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner } = useApp();
  const [range, setRange] = useState({ from: daysAgo(30), to: today() });
  const [data, setData] = useState<ExpenseList | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<ExpenseRow | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    purchasesApi.expenses(range.from, range.to).then((d) => { setData(d); setError(''); }).catch((e) => setError(errText(e, t('purchases.common.network'))));
  }, [range, version, t]);

  // Group rows under their head, heads in the order of their totals (largest first); cancelled entries go with their head.
  const groups = data ? [...data.byHead.map((h) => h.headId), ...data.rows.map((r) => r.head_id)].filter((v, i, a) => a.indexOf(v) === i) : [];
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('purchases.exp.title')}</h1>
        {isOwner && (
          <div className="pu-actions">
            <a className="btn" href="#/expenses/heads">{t('purchases.exp.manageHeads')}</a>
            <a className="btn primary" href="#/expenses/new">+ {t('purchases.exp.new')}</a>
          </div>
        )}
      </div>
      {!isOwner && <p className="hint">{t('purchases.common.readOnly')}</p>}
      <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      {error && <p className="field-error" role="alert">{error}</p>}
      {data && data.rows.length === 0 && <p className="empty">{t('purchases.common.none')}</p>}
      {data && data.rows.length > 0 && <>
        <ul className="pu-chips">
          <li className="mark"><span className="k">{t('purchases.exp.grand')}</span><span className="v">{formatRs(data.totalPaise)}</span></li>
          {data.byHead.slice(0, 3).map((h) => <li key={h.headId}><span className="k">{nameIn(ui, h.name_en, h.name_ta)}</span><span className="v">{formatRs(h.totalPaise)}</span></li>)}
        </ul>
        <div className="pu-scroll">
          <table className="grid">
            <thead><tr>
              <th>{t('purchases.common.date')}</th><th>{t('purchases.common.no')}</th><th>{t('purchases.common.notes')}</th><th>{t('purchases.common.mode')}</th>
              <th className="r">{t('purchases.common.tax')}</th><th className="r">{t('purchases.common.total')}</th>{isOwner && <th />}
            </tr></thead>
            <tbody>
              {groups.map((hid) => {
                const h = data.byHead.find((x) => x.headId === hid);
                const rows = data.rows.filter((r) => r.head_id === hid);
                const first = rows[0]!;
                return (
                  <Fragment key={hid}>
                    <tr className="pu-group">
                      <td colSpan={5}>{nameIn(ui, first.head_en, first.head_ta)} <span className="sub-inline">· {t('purchases.exp.count')}: {h?.count ?? 0}</span></td>
                      <td className="r">{formatRs(h?.totalPaise ?? 0)}</td>{isOwner && <td />}
                    </tr>
                    {rows.map((r) => {
                      const tax = r.cgst_paise + r.sgst_paise + r.igst_paise;
                      return (
                        <tr key={r.id} className={r.status === 'cancelled' ? 'cancelled' : ''}>
                          <td className="mono">{showDate(r.doc_date)}</td>
                          <td className="mono">{r.doc_no}</td>
                          <td>{r.notes}{r.party_en && <span className="sub">{nameIn(ui, r.party_en, r.party_ta)}</span>}{r.cancel_reason && <span className="sub">{r.cancel_reason}</span>}</td>
                          <td>{t(`purchases.modes.${r.mode}`)}</td>
                          <td className="r">{tax ? formatRs(tax) : ''}{tax > 0 && r.itc_eligible ? <span className="sub">ITC</span> : null}</td>
                          <td className="r">{formatRs(r.total_paise)}</td>
                          {isOwner && <td className="r">{r.status === 'active' ? <button type="button" className="btn small" onClick={() => setCancelling(r)}>{t('purchases.common.cancel')}</button> : t('purchases.common.cancelled')}</td>}
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </>}
      {cancelling && (
        <CancelDialog title={t('purchases.exp.cancelTitle', { no: cancelling.doc_no })} help={t('purchases.exp.cancelHelp')} placeholder={t('purchases.exp.cancelReasonPh')} action={t('purchases.exp.cancelDo')}
          onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); setVersion((v) => v + 1); }}
          run={(reason) => purchasesApi.cancelExpense(cancelling.id, reason)} />
      )}
    </section>
  );
}

function NewExpense() {
  const { t, i18n } = useTranslation();
  const ui = i18n.language;
  const { isOwner, settings } = useApp();
  const [heads, setHeads] = useState<ExpenseHead[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [headId, setHeadId] = useState('');
  const [amount, setAmount] = useState('');
  const [incl, setIncl] = useState(false);
  const [gst, setGst] = useState('0');
  const [gstin, setGstin] = useState('');
  const [itc, setItc] = useState<boolean | null>(null);
  const [mode, setMode] = useState<ExpenseMode>('cash');
  const [partyText, setPartyText] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<ExpensePreview | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([purchasesApi.heads(), api.parties()]).then(([h, p]) => { setHeads(h); setParties(p.filter((x) => !x.is_walk_in)); })
      .catch((e) => setError(errText(e, t('purchases.common.network'))));
  }, [t]);
  const party = parties.find((p) => [p.name_en, p.name_ta].includes(partyText.trim()));
  const amountOk = (() => { try { return amount.trim() !== '' && toPaise(amount) > 0; } catch { return false; } })();
  const gstinOk = !gstin || !!stateFromGstin(gstin);
  const input: ExpenseInput | null = headId && amountOk && gstinOk && (mode !== 'credit' || party) ? {
    headId, amount, amountIncludesGst: incl, gst, vendorGstin: gstin || null, itcEligible: itc ?? undefined, mode, partyId: party?.id ?? null, date,
    reference: reference.trim() || undefined, notes: notes.trim() || undefined,
  } : null;
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!input) { setPreview(null); return; }
    const h = setTimeout(() => {
      purchasesApi.expensePreview(input).then((p) => { setPreview(p); setError(''); }).catch((e) => { setPreview(null); setError(errText(e, t('purchases.common.network'))); });
    }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => setItc(null), [gstin, gst, party?.id]);

  const save = async () => {
    if (mode === 'credit' && !party) { setError(t('purchases.exp.needParty')); return; }
    if (!input) return;
    setSaving(true);
    try {
      const r = await purchasesApi.saveExpense(input);
      setSaved(r.docNo);
      setAmount(''); setGst('0'); setGstin(''); setIncl(false); setItc(null); setNotes(''); setReference(''); setPartyText(''); setPreview(null);
    } catch (e) {
      setError(errText(e, t('purchases.common.network')));
    } finally {
      setSaving(false);
    }
  };

  if (!isOwner) return <section className="page"><p className="hint">{t('purchases.common.readOnly')}</p></section>;
  const regular = settings?.values['gst.scheme'] === 'regular';
  const tax = preview ? preview.cgst + preview.sgst + preview.igst : 0;
  return (
    <form className="page pu-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head">
        <h1>{t('purchases.exp.new')}</h1>
        <a className="btn" href="#/expenses">{t('purchases.common.back')}</a>
      </div>
      {saved && <p className="saved-banner" role="status"><strong>{t('purchases.exp.saved', { no: saved })}</strong></p>}
      <div className="pu-pay-grid">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ex-head">{t('purchases.exp.head')}</label>
            <select id="ex-head" value={headId} onChange={(e) => setHeadId(e.target.value)}>
              <option value="">{t('purchases.exp.pickHead')}</option>
              {heads.map((h) => <option key={h.id} value={h.id}>{nameIn(ui, h.name_en, h.name_ta)}</option>)}
            </select>
          </div>
          <Num id="ex-amt" label={t('purchases.exp.amount')} value={amount} onChange={setAmount} />
          <div className="field"><label htmlFor="ex-date">{t('purchases.common.date')}</label>
            <input id="ex-date" type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
          <div className="field">
            <label htmlFor="ex-gst">{t('purchases.common.gst')}</label>
            <select id="ex-gst" value={gst} onChange={(e) => setGst(e.target.value)}>{GST_CHOICES.map((g) => <option key={g} value={g}>{g}%</option>)}</select>
          </div>
          {gst !== '0' && <>
            <label className="check"><input type="checkbox" checked={incl} onChange={(e) => setIncl(e.target.checked)} /> {t('purchases.exp.amountInclGst')}</label>
            <div className="field">
              <label htmlFor="ex-gstin">{t('purchases.exp.vendorGstin')}</label>
              <input id="ex-gstin" className="mono" maxLength={15} value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase().trim())} />
              <span className="hint">{t('purchases.exp.vendorGstinHelp')}</span>
            </div>
            {regular && <label className="check"><input type="checkbox" checked={preview?.itc ?? false} disabled={!preview?.vendorGstin} onChange={(e) => setItc(e.target.checked)} /> {t('purchases.exp.itc')}</label>}
          </>}
          <div className="field wide">
            <span className="label" id="ex-mode">{t('purchases.common.mode')}</span>
            <div className="seg" role="group" aria-labelledby="ex-mode">
              {EXPENSE_MODES.map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`purchases.modes.${m}`)}</button>)}
            </div>
          </div>
          {mode === 'credit' && (
            <div className="field">
              <label htmlFor="ex-party">{t('purchases.exp.party')}</label>
              <input id="ex-party" list="ex-parties" value={partyText} placeholder={t('purchases.exp.partyPh')} autoComplete="off" onChange={(e) => setPartyText(e.target.value)} />
              <datalist id="ex-parties">{parties.map((p) => <option key={p.id} value={nameIn(ui, p.name_en, p.name_ta)} />)}</datalist>
            </div>
          )}
          {mode !== 'cash' && mode !== 'credit' && (
            <div className="field"><label htmlFor="ex-ref">{t('purchases.common.reference')}</label><input id="ex-ref" value={reference} maxLength={40} onChange={(e) => setReference(e.target.value)} /></div>
          )}
          <div className="field wide"><label htmlFor="ex-notes">{t('purchases.common.notes')}</label>
            <input id="ex-notes" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <aside className="totals" aria-live="polite">
          <dl>
            <div><dt>{t('purchases.common.taxable')}</dt><dd>{preview ? formatRs(preview.taxable) : '—'}</dd></div>
            <div><dt>{t('purchases.common.tax')}</dt><dd>{preview ? formatRs(tax) : '—'}</dd></div>
          </dl>
          <div className="grand">
            <span className="grand-label">{t('purchases.exp.totalPaid')}</span>
            <span className="grand-value">{preview ? formatRs(preview.total) : '₹0.00'}</span>
          </div>
          {preview && tax > 0 && <p className="hint">{preview.itc ? t('purchases.exp.itcNote', { amount: formatRs(tax) }) : t('purchases.exp.costNote', { amount: formatRs(preview.cost) })}</p>}
          {error && <p className="field-error" role="alert">{error}</p>}
          <button type="submit" className="btn primary big" disabled={(!input && mode !== 'credit') || saving}>{saving ? t('purchases.common.saving') : t('purchases.exp.save')}</button>
        </aside>
      </div>
    </form>
  );
}

function Heads() {
  const { t } = useTranslation();
  const { isOwner } = useApp();
  const [heads, setHeads] = useState<Array<ExpenseHead & { dirty?: boolean }> | null>(null);
  const [en, setEn] = useState('');
  const [ta, setTa] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => purchasesApi.heads().then(setHeads).catch((e) => setMsg(errText(e, t('purchases.common.network'))));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  const edit = (id: string, patch: Partial<ExpenseHead>) => setHeads((hs) => (hs ?? []).map((h) => (h.id === id ? { ...h, ...patch, dirty: true } : h)));
  const saveOne = async (h: ExpenseHead) => {
    try { await purchasesApi.updateHead(h.id, { name_en: h.name_en, name_ta: h.name_ta || null }); setMsg(t('purchases.exp.headSaved')); void load(); } catch (e) { setMsg((e as Error).message); }
  };
  const add = async () => {
    try { await purchasesApi.addHead({ name_en: en, name_ta: ta || null }); setEn(''); setTa(''); setMsg(t('purchases.exp.headSaved')); void load(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <section className="page">
      <div className="page-head">
        <h1>{t('purchases.exp.heads')}</h1>
        <a className="btn" href="#/expenses">{t('purchases.common.back')}</a>
      </div>
      {heads && heads.length === 0 && <p className="empty">{t('purchases.exp.noHeads')}</p>}
      {heads && heads.length > 0 && (
        <div className="pu-scroll">
          <table className="grid compact">
            <thead><tr><th>{t('purchases.exp.headEn')}</th><th>{t('purchases.exp.headTa')}</th><th /></tr></thead>
            <tbody>
              {heads.map((h) => (
                <tr key={h.id} className={`pu-head-row${h.dirty ? ' changed' : ''}`}>
                  <td><input aria-label={t('purchases.exp.headEn')} value={h.name_en} disabled={!isOwner} maxLength={60} onChange={(e) => edit(h.id, { name_en: e.target.value })} /></td>
                  <td><input aria-label={t('purchases.exp.headTa')} lang="ta" value={h.name_ta ?? ''} disabled={!isOwner} maxLength={60} onChange={(e) => edit(h.id, { name_ta: e.target.value })} /></td>
                  <td className="r">
                    {isOwner && h.dirty && <button type="button" className="btn small primary" onClick={() => void saveOne(h)}>{t('purchases.exp.saveHead')}</button>}
                    {isOwner && !h.dirty && <DeleteButton small kind="expense_heads" id={h.id} name={h.name_en} onDone={() => void load()} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isOwner && (
        <form className="add-user" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <div className="field"><label htmlFor="h-en">{t('purchases.exp.headEn')}</label><input id="h-en" required maxLength={60} value={en} onChange={(e) => setEn(e.target.value)} /></div>
          <div className="field"><label htmlFor="h-ta">{t('purchases.exp.headTa')}</label><input id="h-ta" lang="ta" maxLength={60} value={ta} onChange={(e) => setTa(e.target.value)} /></div>
          <button type="submit" className="btn primary">{t('purchases.exp.addHead')}</button>
        </form>
      )}
      {msg && <p role="status" className="hint">{msg}</p>}
    </section>
  );
}
