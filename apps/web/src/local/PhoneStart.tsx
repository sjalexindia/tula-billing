import { Capacitor } from '@capacitor/core';
import { describeError } from '@tula/server/sync/state';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { App } from '../App';
import { Field } from '../components/Field';
import { setLang } from '../i18n';
import '../styles/sync.css';
import { getMode, joinFromCloud, needsRefresh, openPhoneDb, phoneIsJoined, refreshFromCloud, setMode, startOnPhone } from './phone';

type Step = 'loading' | 'choose' | 'setup' | 'refreshing' | 'ready' | { error: string };

const SETUP_ERRORS = ['OFFLINE', 'AUTH', 'BAD_URL', 'EMPTY_HUB'];

/**
 * The Android app's start: Tula on this phone (set up once from the cloud copy), or Tula opened
 * from the shop computer (the connect page in connect/, unchanged from before).
 */
export function PhoneStart() {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('loading');

  const runHere = async () => {
    try {
      await openPhoneDb();
    } catch (e) {
      setStep({ error: `${t('phone.errors.noStorage')} (${(e as Error).message})` });
      return;
    }
    if (await needsRefresh()) {
      // the cloud copy was started afresh (a different business): copy it again before opening
      setStep('refreshing');
      try {
        await refreshFromCloud();
      } catch (e) {
        const d = describeError(e);
        setStep({ error: t('phone.refresh.failed', { detail: SETUP_ERRORS.includes(d.code) ? t(`phone.errors.${d.code}`) : d.message }) });
        return;
      }
    }
    if (!(await phoneIsJoined())) { setStep('setup'); return; }
    await startOnPhone();
    setStep('ready');
  };

  useEffect(() => {
    void (async () => {
      // the connect page links back here with #choose ("use this phone on its own instead")
      if (location.hash === '#choose') {
        await setMode(null);
        history.replaceState(null, '', location.pathname);
      }
      // In a browser (the web version, e.g. on an iPhone) there is no connect page to offer: Tula runs here.
      if (!Capacitor.isNativePlatform()) { await runHere(); return; }
      const mode = await getMode();
      if (mode === 'computer') location.href = 'connect/index.html';
      else if (mode === 'anywhere') await runHere();
      else setStep('choose');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (step === 'ready') return <App />;
  if (step === 'loading') return <Card><p>{t('phone.loading')}</p></Card>;
  if (step === 'refreshing') return <Card><h1>{t('phone.refresh.title')}</h1><p>{t('phone.refresh.lead')}</p></Card>;
  if (typeof step === 'object') return <Card><p className="field-error" role="alert">{step.error}</p></Card>;
  if (step === 'setup') return <Setup onBack={Capacitor.isNativePlatform() ? () => setStep('choose') : undefined} onDone={async () => { await startOnPhone(); setStep('ready'); }} />;

  return (
    <Card>
      <h1>{t('phone.choose.title')}</h1>
      <div className="phone-choice">
        <button type="button" className="primary" onClick={() => void runHere()}>
          <b>{t('phone.choose.anywhere')}</b>
          <span>{t('phone.choose.anywhereHelp')}</span>
        </button>
        <button type="button" onClick={() => void setMode('computer').then(() => { location.href = 'connect/index.html'; })}>
          <b>{t('phone.choose.computer')}</b>
          <span>{t('phone.choose.computerHelp')}</span>
        </button>
      </div>
    </Card>
  );
}

function Setup({ onBack, onDone }: { onBack?: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // a translation key (and detail), so the message follows a language switch
  const [error, setError] = useState<{ key: string; detail?: string } | null>(null);

  const submit = async () => {
    if (!url.trim() || !token.trim()) { setError({ key: 'phone.setup.required' }); return; }
    setBusy(true);
    setError(null);
    try {
      await joinFromCloud({ url: url.trim(), token: token.trim() }, name.trim() || undefined);
      await onDone();
    } catch (e) {
      const d = describeError(e, token.trim());
      setError(SETUP_ERRORS.includes(d.code) ? { key: `phone.errors.${d.code}` } : { key: 'phone.errors.OTHER', detail: (e as Error).message.split(token.trim()).join('***') });
      setBusy(false);
    }
  };

  return (
    <Card>
      <h1>{t('phone.setup.title')}</h1>
      <p className="hint">{t('phone.setup.lead')}</p>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field id="setup-url" label={t('phone.setup.url')} hint={t('phone.setup.urlHint')} wide>
          <input id="setup-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="libsql://…turso.io" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
        </Field>
        <Field id="setup-token" label={t('phone.setup.token')} hint={t('phone.setup.tokenHint')} wide>
          <input id="setup-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </Field>
        <Field id="setup-name" label={t('phone.setup.name')} wide>
          <input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('phone.setup.namePlaceholder')} maxLength={40} />
        </Field>
        {error && <p className="field-error wide" role="alert">{t(error.key, { detail: error.detail })}</p>}
        <div className="form-actions wide">
          <button type="submit" className="btn primary" disabled={busy}>{busy ? t('phone.setup.working') : t('phone.setup.start')}</button>
          {onBack && <button type="button" className="btn" disabled={busy} onClick={onBack}>{t('phone.setup.back')}</button>}
        </div>
      </form>
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="signin phone-start">
      <div className="signin-card">
        <p className="signin-business">{t('app.title')}</p>
        <div className="lang-switch" role="group" aria-label={t('lang.label')}>
          {(['en', 'ta'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={i18n.language === l} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}
