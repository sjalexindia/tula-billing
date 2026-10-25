import { formatRs, toPaise } from '@tula/core';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type RateGroup, type SettingsState } from './api';
import { hasSavedLang, isLang, nameIn, setLang, type Lang } from './i18n';
import { Bills } from './screens/Bills';
import { Invoice } from './screens/Invoice';
import { NewBill } from './screens/NewBill';
import { SettingsScreen } from './screens/Settings';
import { Stock } from './screens/Stock';

type Route = { name: 'new' } | { name: 'bills' } | { name: 'stock' } | { name: 'settings' } | { name: 'print'; id: string };

function parseHash(): Route {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'bills') return { name: 'bills' };
  if (a === 'stock') return { name: 'stock' };
  if (a === 'settings') return { name: 'settings' };
  if (a === 'print' && b) return { name: 'print', id: b };
  return { name: 'new' };
}

interface AppState {
  settings: SettingsState | null;
  reloadSettings: () => Promise<void>;
  /** languages enabled for this business, in order */
  langs: Lang[];
}
const AppCtx = createContext<AppState>({ settings: null, reloadSettings: async () => {}, langs: ['en'] });
export const useApp = () => useContext(AppCtx);

export function App() {
  const { t, i18n } = useTranslation();
  const [route, setRoute] = useState<Route>(parseHash);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [error, setError] = useState('');
  const [ratesVersion, setRatesVersion] = useState(0);

  const reloadSettings = useCallback(async () => {
    try {
      const s = await api.settings();
      setSettings(s);
      setError('');
      const enabled = s.values['app.languages']!.split(',');
      if (!hasSavedLang() || !enabled.includes(i18n.language)) {
        const d = s.values['app.default_lang'];
        if (isLang(d)) setLang(d, false);
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 0 ? t('errors.network') : (e as Error).message);
    }
  }, [i18n.language, t]);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reloadSettings(); }, []);

  const langs = (settings?.values['app.languages'] ?? 'en').split(',').filter(isLang);
  const ctx: AppState = { settings, reloadSettings, langs };

  if (route.name === 'print') return <AppCtx.Provider value={ctx}><Invoice id={route.id} /></AppCtx.Provider>;

  const v = settings?.values ?? {};
  const businessName = nameIn(i18n.language, v['business.name_en'] ?? '', v['business.name_ta']) || t('app.title');
  const setupNeeded = !!settings?.missingForBilling.length;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <div className="brand"><span className="brand-name">{businessName}</span></div>
          <nav className="tabs" aria-label="Main">
            <a href="#/" aria-current={route.name === 'new' ? 'page' : undefined}>{t('nav.newBill')}</a>
            <a href="#/bills" aria-current={route.name === 'bills' ? 'page' : undefined}>{t('nav.bills')}</a>
            <a href="#/stock" aria-current={route.name === 'stock' ? 'page' : undefined}>{t('nav.stock')}</a>
            <a href="#/settings" aria-current={route.name === 'settings' ? 'page' : undefined}>{t('nav.settings')}</a>
          </nav>
          <RatesBar key={ratesVersion} onChanged={() => setRatesVersion((n) => n + 1)} />
          {langs.length > 1 && (
            <div className="lang-switch" role="group" aria-label="Language">
              {langs.map((l) => (
                <button key={l} type="button" aria-pressed={i18n.language === l} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>
              ))}
            </div>
          )}
        </header>
        {error && <p className="banner error" role="alert">{error}</p>}
        {setupNeeded && route.name !== 'settings' && (
          <p className="banner setup">{t('errors.setup')} <a href="#/settings">{t('errors.setupLink')}</a></p>
        )}
        <main className="main">
          {route.name === 'new' && <NewBill ratesVersion={ratesVersion} />}
          {route.name === 'bills' && <Bills />}
          {route.name === 'stock' && <Stock />}
          {route.name === 'settings' && <SettingsScreen />}
        </main>
      </div>
    </AppCtx.Provider>
  );
}

/** One chip per rate group the business defines (none, one or many). */
function RatesBar({ onChanged }: { onChanged: () => void }) {
  const [groups, setGroups] = useState<RateGroup[]>([]);
  useEffect(() => { api.rates().then((g) => setGroups(g.filter((x) => x.show_on_topbar))).catch(() => {}); }, []);
  if (!groups.length) return null;
  return <div className="rates">{groups.map((g) => <RateChip key={g.code} group={g} onChanged={onChanged} />)}</div>;
}

function RateChip({ group, onChanged }: { group: RateGroup; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const name = nameIn(i18n.language, group.name_en, group.name_ta);
  const unit = nameIn(i18n.language, group.unit_en ?? '', group.unit_ta);

  const save = async () => {
    try {
      toPaise(draft);
      await api.setRate(group.code, draft);
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (editing) {
    return (
      <form className="rate-chip editing" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label htmlFor={`rate-${group.code}`}>{name}</label>
        <span className="rate-input-wrap">₹<input id={`rate-${group.code}`} inputMode="decimal" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />{unit && t('rate.per', { unit })}</span>
        <button type="submit" className="btn small primary">{t('rate.save')}</button>
        <button type="button" className="btn small" onClick={() => setEditing(false)}>{t('rate.cancel')}</button>
        {error && <span className="field-error" role="alert">{error}</span>}
      </form>
    );
  }
  return (
    <button type="button" className="rate-chip" title={t('rate.edit', { name })}
      onClick={() => { setDraft(group.rate_paise != null ? (group.rate_paise / 100).toFixed(2) : ''); setError(''); setEditing(true); }}>
      <span className="rate-label">{name}</span>
      <span className="rate-value">{group.rate_paise != null ? formatRs(group.rate_paise) : t('rate.notSet')}{group.rate_paise != null && unit && <small>{t('rate.per', { unit })}</small>}</span>
    </button>
  );
}
