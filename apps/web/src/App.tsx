import { formatRs, toPaise } from '@tula/core';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, setSignedOutHandler, type Me, type RateGroup, type Role, type SettingsState } from './api';
import { hasSavedLang, isLang, nameIn, setLang, type Lang } from './i18n';
import { GROUP_ORDER, NAV } from './nav';
import { ChangePin, SignIn } from './screens/Auth';
import { Invoice } from './screens/Invoice';

interface Route { name: string; id?: string }

/** #/route/id ; the bill screen is the empty route. "print" is the full-page invoice view. */
function parseHash(): Route {
  const [a = '', b] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: a, id: b || undefined };
}

interface AppState {
  settings: SettingsState | null;
  reloadSettings: () => Promise<void>;
  /** languages enabled for this business, in order */
  langs: Lang[];
  me: Me | null;
  isOwner: boolean;
}
const AppCtx = createContext<AppState>({ settings: null, reloadSettings: async () => {}, langs: ['en'], me: null, isOwner: false });
export const useApp = () => useContext(AppCtx);

export function App() {
  const { t, i18n } = useTranslation();
  const [route, setRoute] = useState<Route>(parseHash);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still checking
  const [error, setError] = useState('');
  const [ratesVersion, setRatesVersion] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [changingPin, setChangingPin] = useState(false);

  const applyLang = useCallback((enabled: string[], fallback: string, userLang?: string | null) => {
    const preferred = userLang && enabled.includes(userLang) ? userLang : null;
    if (preferred && isLang(preferred) && !hasSavedLang()) setLang(preferred, false);
    else if (!hasSavedLang() || !enabled.includes(i18n.language)) {
      if (isLang(fallback)) setLang(fallback, false);
    }
  }, [i18n.language]);

  const reloadSettings = useCallback(async () => {
    try {
      const s = await api.settings();
      setSettings(s);
      setError('');
      applyLang(s.values['app.languages']!.split(','), s.values['app.default_lang']!, me?.lang);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.status === 0 ? t('errors.network') : (e as Error).message);
    }
  }, [applyLang, me?.lang, t]);

  useEffect(() => {
    setSignedOutHandler(() => setMe(null));
    api.me().then((r) => setMe(r.user)).catch((e) => {
      if (e instanceof ApiError && e.status === 0) setError(t('errors.network'));
      setMe(null);
    });
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [t]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (me) void reloadSettings(); }, [me?.id]);

  const langs = (settings?.values['app.languages'] ?? 'en').split(',').filter(isLang);
  const ctx: AppState = { settings, reloadSettings, langs, me: me ?? null, isOwner: me?.role === 'owner' };

  if (me === undefined) return null;
  if (me === null) return <SignIn onSignedIn={(u) => { setMe(u); location.hash = '#/'; }} networkError={error} />;
  if (me.mustChangePin || changingPin) {
    return <ChangePin forced={me.mustChangePin} onDone={() => { setChangingPin(false); setMe({ ...me, mustChangePin: false }); }} onCancel={() => setChangingPin(false)} />;
  }
  if (route.name === 'print' && route.id) return <AppCtx.Provider value={ctx}><Invoice key={route.id} id={route.id} /></AppCtx.Provider>;

  const allowed = NAV.filter((n) => n.roles.includes(me.role));
  const currentItem = allowed.find((n) => n.route === route.name) ?? allowed[0]!;
  const current = currentItem.route;
  const groups = GROUP_ORDER.filter((g) => allowed.some((n) => n.group === g && !n.hidden));
  const inGroup = allowed.filter((n) => n.group === currentItem.group && !n.hidden);
  const Screen = currentItem.screen;
  const v = settings?.values ?? {};
  const businessName = nameIn(i18n.language, v['business.name_en'] ?? '', v['business.name_ta']) || t('app.title');
  const setupNeeded = !!settings?.missingForBilling.length;

  const signOut = async () => {
    await api.logout().catch(() => {});
    setMenuOpen(false);
    setMe(null);
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <div className="brand"><span className="brand-name">{businessName}</span></div>
          <nav className="tabs" aria-label="Main">
            {groups.map((g) => {
              const first = allowed.find((n) => n.group === g && !n.hidden)!;
              return <a key={g} href={`#/${first.route}`} aria-current={currentItem.group === g ? 'page' : undefined}>{t(`nav.groups.${g}`)}</a>;
            })}
          </nav>
          <RatesBar key={ratesVersion} canEdit={me.role === 'owner'} onChanged={() => setRatesVersion((n) => n + 1)} />
          {langs.length > 1 && (
            <div className="lang-switch" role="group" aria-label="Language">
              {langs.map((l) => (
                <button key={l} type="button" aria-pressed={i18n.language === l} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>
              ))}
            </div>
          )}
          <div className="user-menu">
            <button type="button" className="user-btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
              <span className="user-name">{me.name}</span>
              <span className="user-role">{t(`auth.roles.${me.role}`)}</span>
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setChangingPin(true); }}>{t('auth.changePin')}</button>
                <button type="button" role="menuitem" onClick={() => void signOut()}>{t('auth.signOut')}</button>
              </div>
            )}
          </div>
        </header>
        {error && <p className="banner error" role="alert">{error}</p>}
        {setupNeeded && current !== 'settings' && (
          <p className="banner setup">
            {t('errors.setup')} {me.role === 'owner' && <a href="#/settings">{t('errors.setupLink')}</a>}
          </p>
        )}
        {inGroup.length > 1 && (
          <nav className="subtabs" aria-label={t(`nav.groups.${currentItem.group}`)}>
            {inGroup.map((n) => <a key={n.route} href={`#/${n.route}`} aria-current={n.route === current ? 'page' : undefined}>{t(n.label)}</a>)}
          </nav>
        )}
        <main className="main">
          <Screen key={`${current}/${route.id ?? ''}`} id={route.name === current ? route.id : undefined} ratesVersion={ratesVersion} />
        </main>
      </div>
    </AppCtx.Provider>
  );
}

/** One chip per rate group the business defines (none, one or many). Only the owner can change them. */
function RatesBar({ onChanged, canEdit }: { onChanged: () => void; canEdit: boolean }) {
  const [groups, setGroups] = useState<RateGroup[]>([]);
  useEffect(() => { api.rates().then((g) => setGroups(g.filter((x) => x.show_on_topbar))).catch(() => {}); }, []);
  if (!groups.length) return null;
  return <div className="rates">{groups.map((g) => <RateChip key={g.code} group={g} canEdit={canEdit} onChanged={onChanged} />)}</div>;
}

function RateChip({ group, onChanged, canEdit }: { group: RateGroup; onChanged: () => void; canEdit: boolean }) {
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
  const value = <span className="rate-value">{group.rate_paise != null ? formatRs(group.rate_paise) : t('rate.notSet')}{group.rate_paise != null && unit && <small>{t('rate.per', { unit })}</small>}</span>;
  if (!canEdit) return <div className="rate-chip readonly"><span className="rate-label">{name}</span>{value}</div>;
  return (
    <button type="button" className="rate-chip" title={t('rate.edit', { name })}
      onClick={() => { setDraft(group.rate_paise != null ? (group.rate_paise / 100).toFixed(2) : ''); setError(''); setEditing(true); }}>
      <span className="rate-label">{name}</span>
      {value}
    </button>
  );
}
