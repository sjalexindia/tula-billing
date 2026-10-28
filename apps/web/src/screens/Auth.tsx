import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Me, type Role } from '../api';
import { isLang, nameIn, setLang } from '../i18n';

/** Sign-in: tap your name, type your PIN. Works with a keyboard or a touch screen. */
export function SignIn({ onSignedIn, networkError }: { onSignedIn: (u: Me) => void; networkError?: string }) {
  const { t, i18n } = useTranslation();
  const [users, setUsers] = useState<Array<{ id: string; name: string; role: Role; lang: string | null }>>([]);
  const [info, setInfo] = useState<{ name_en: string; name_ta: string; languages: string[]; defaultLang: string } | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(networkError ?? '');
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.loginUsers(), api.publicInfo()]).then(([u, i]) => {
      setUsers(u);
      setInfo(i);
      if (u.length === 1) setUserId(u[0]!.id);
      if (isLang(i.defaultLang) && !localStorage.getItem('lang')) setLang(i.defaultLang, false);
    }).catch(() => setError(t('errors.network')));
  }, [t]);
  useEffect(() => { if (userId) pinRef.current?.focus(); }, [userId]);

  const submit = async (value = pin) => {
    if (!userId || value.length < 4) return;
    setBusy(true);
    try {
      const r = await api.login(userId, value);
      if (r.user.lang && isLang(r.user.lang)) setLang(r.user.lang, false);
      onSignedIn(r.user);
    } catch (e) {
      setPin('');
      setError(e instanceof ApiError && e.code === 'BAD_LOGIN' ? t('auth.wrong') : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => {
    setError('');
    const next = (pin + d).slice(0, 6);
    setPin(next);
  };

  const name = info ? nameIn(i18n.language, info.name_en, info.name_ta) : '';
  const langs = (info?.languages ?? []).filter(isLang);
  return (
    <div className="signin">
      <div className="signin-card">
        <p className="signin-business">{name || t('app.title')}</p>
        <h1>{t('auth.who')}</h1>
        <div className="people" role="radiogroup" aria-label={t('auth.who')}>
          {users.map((u) => (
            <button key={u.id} type="button" role="radio" aria-checked={userId === u.id} className="person"
              onClick={() => { setUserId(u.id); setPin(''); setError(''); }}>
              <span className="person-name">{u.name}</span>
              {u.name !== t(`auth.roles.${u.role}`) && <span className="person-role">{t(`auth.roles.${u.role}`)}</span>}
            </button>
          ))}
        </div>
        {userId && (
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="pin-form">
            <label htmlFor="pin">{t('auth.pin')}</label>
            <input id="pin" ref={pinRef} className="pin-input" type="password" inputMode="numeric" autoComplete="current-password"
              maxLength={6} value={pin} onChange={(e) => { setError(''); setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); }} />
            <div className="keypad" aria-hidden="true">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" tabIndex={-1} onClick={() => press(d)}>{d}</button>)}
              <button type="button" tabIndex={-1} onClick={() => setPin(pin.slice(0, -1))}>⌫</button>
              <button type="button" tabIndex={-1} onClick={() => press('0')}>0</button>
              <button type="submit" tabIndex={-1} className="go" disabled={busy || pin.length < 4}>→</button>
            </div>
            {error && <p className="field-error" role="alert">{error}</p>}
            <button type="submit" className="btn primary big" disabled={busy || pin.length < 4}>{t('auth.signIn')}</button>
            <details className="hint">
              <summary>{t('auth.forgot')}</summary>
              <p>{t('auth.forgotHelp')}</p>
            </details>
          </form>
        )}
        {!userId && error && <p className="field-error" role="alert">{error}</p>}
        {users.length === 1 && <p className="hint">{t('auth.firstRun')}</p>}
        {langs.length > 1 && (
          <div className="lang-switch light" role="group" aria-label={t('lang.label')}>
            {langs.map((l) => <button key={l} type="button" aria-pressed={i18n.language === l} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChangePin({ forced, onDone, onCancel }: { forced: boolean; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

  const save = async () => {
    if (next !== again) { setError(t('auth.mismatch')); return; }
    setBusy(true);
    try {
      await api.changePin(current, next);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="signin">
      <form className="signin-card" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h1>{forced ? t('auth.newPinTitle') : t('auth.changePin')}</h1>
        {forced && <p className="hint">{t('auth.newPinHelp')}</p>}
        {[['cur', 'auth.currentPin', current, setCurrent], ['new', 'auth.newPin', next, setNext], ['again', 'auth.confirmPin', again, setAgain]].map(([id, label, value, set]) => (
          <div className="field" key={id as string}>
            <label htmlFor={`pin-${id}`}>{t(label as string)}</label>
            <input id={`pin-${id}`} className="pin-input" type="password" inputMode="numeric" autoComplete={id === 'cur' ? 'current-password' : 'new-password'}
              value={value as string} onChange={(e) => { setError(''); (set as (v: string) => void)(digits(e.target.value)); }} />
          </div>
        ))}
        {error && <p className="field-error" role="alert">{error}</p>}
        <button type="submit" className="btn primary big" disabled={busy || current.length < 4 || next.length < 4 || again.length < 4}>{t('auth.savePin')}</button>
        {!forced && <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>}
      </form>
    </div>
  );
}
