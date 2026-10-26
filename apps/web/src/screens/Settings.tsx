import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type SettingsSchema } from '../api';
import { useApp } from '../App';
import { UsersPanel } from './Users';

/** Generated from the settings registry, so new settings appear without new screen code. */
export function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const { settings, reloadSettings } = useApp();
  const [schema, setSchema] = useState<SettingsSchema | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.settingsSchema().then(setSchema).catch((e) => setMessage({ kind: 'error', text: (e as Error).message })); }, []);
  useEffect(() => { if (settings) setDraft(settings.values); }, [settings]);
  if (!schema || !settings) return null;

  const label = (key: string) => (i18n.exists(`settings.keys.${key}`) ? t(`settings.keys.${key}`) : key);
  const valueLabel = (v: string) => (i18n.exists(`settings.values.${v}`) ? t(`settings.values.${v}`) : v);
  const missing = new Set(settings.missingForBilling);
  const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => settings.values[k] !== v));
  const groups = [...new Set(schema.settings.map((s) => s.group))];
  // Language-specific fields (…_ta) only show when that language is enabled. Other two-letter
  // endings (upi_id, show_upi_qr, interest_pa) are not languages and always show.
  const enabled = (draft['app.languages'] ?? 'en').split(',');
  const visible = (key: string) => {
    const m = /_([a-z]{2})$/.exec(key);
    return !m || !schema.languages.includes(m[1]!) || m[1] === 'en' || enabled.includes(m[1]!);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(changed);
      await reloadSettings();
      setMessage({ kind: 'ok', text: t('settings.saved') });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
    <form className="page settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head"><h1>{t('settings.title')}</h1></div>
      {groups.map((g) => (
        <fieldset key={g}>
          <legend>{t(`settings.groups.${g}`)}</legend>
          {schema.settings.filter((s) => s.group === g && visible(s.key)).map((s) => {
            const id = `set-${s.key}`;
            const value = draft[s.key] ?? '';
            const set = (v: string) => setDraft((d) => ({ ...d, [s.key]: v }));
            let control;
            if (s.kind.type === 'enum' || s.kind.type === 'bool' || s.kind.type === 'lang') {
              const options = s.kind.type === 'bool' ? ['true', 'false'] : s.kind.type === 'lang' ? schema.languages : s.kind.values ?? [];
              control = <select id={id} value={value} onChange={(e) => set(e.target.value)}>{options.map((o) => <option key={o} value={o}>{valueLabel(o)}</option>)}</select>;
            } else if (s.kind.type === 'state') {
              control = (
                <select id={id} value={value} onChange={(e) => set(e.target.value)}>
                  <option value="">{t('settings.pickState')}</option>
                  {schema.states.map((st) => <option key={st.code} value={st.code}>{st.code} — {st.name}</option>)}
                </select>
              );
            } else if (s.kind.type === 'langs') {
              const list = value.split(',').filter(Boolean);
              control = (
                <div className="checks" id={id}>
                  {schema.languages.map((l) => (
                    <label key={l}>
                      <input type="checkbox" checked={list.includes(l)}
                        onChange={(e) => set((e.target.checked ? [...list, l] : list.filter((x) => x !== l)).join(','))} />
                      {valueLabel(l)}
                    </label>
                  ))}
                </div>
              );
            } else if (s.kind.type === 'text' && (s.kind.max ?? 0) > 150) {
              control = <textarea id={id} rows={2} value={value} maxLength={s.kind.max} onChange={(e) => set(e.target.value)} />;
            } else if (s.kind.type === 'int' || s.kind.type === 'amount' || s.kind.type === 'percent') {
              control = <input id={id} inputMode={s.kind.type === 'int' ? 'numeric' : 'decimal'} value={value} onChange={(e) => set(e.target.value)} />;
            } else {
              control = <input id={id} value={value} maxLength={s.kind.type === 'text' ? s.kind.max : undefined} onChange={(e) => set(e.target.value)} />;
            }
            return (
              <div className={`field setting${missing.has(s.key) ? ' missing' : ''}`} key={s.key}>
                <label htmlFor={id}>{label(s.key)}</label>
                {control}
                {missing.has(s.key) && <span className="hint">{t('settings.required')}</span>}
              </div>
            );
          })}
        </fieldset>
      ))}
      <div className="settings-actions">
        {message && <p className={message.kind === 'ok' ? 'saved-note' : 'field-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p>}
        {settings.issues.map((i) => <p key={i} className="field-error">{i}</p>)}
        <button type="submit" className="btn primary" disabled={saving || !Object.keys(changed).length}>{t('settings.save')}</button>
      </div>
    </form>
    <UsersPanel />
    </div>
  );
}
