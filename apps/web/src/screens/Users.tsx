import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Role, type UserRow } from '../api';
import { useApp } from '../App';

/** Owner-only: who can sign in, with which role. PINs set here are temporary. */
export function UsersPanel() {
  const { t } = useTranslation();
  const { me } = useApp();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('billing');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.users().then(setRows).catch(() => {});
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg({ ok: true, text: ok }); await load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const add = () => run(async () => { await api.addUser({ name, role, pin }); setName(''); setPin(''); }, t('common.saved'));
  const resetPin = (u: UserRow) => {
    const p = window.prompt(t('users.newTempPin', { name: u.name }));
    if (p) void run(() => api.updateUser(u.id, { pin: p }), t('common.saved'));
  };

  return (
    <section className="page users">
      <h2>{t('users.title')}</h2>
      <table className="grid compact">
        <thead><tr><th>{t('users.name')}</th><th>{t('users.role')}</th><th /><th /></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td>{u.name}{!u.active ? <span className="sub">{t('users.off')}</span> : !u.pin_set && <span className="sub">{t('users.waiting')}</span>}</td>
              <td>
                <select aria-label={t('users.role')} value={u.role} disabled={u.id === me?.id}
                  onChange={(e) => void run(() => api.updateUser(u.id, { role: e.target.value as Role }), t('common.saved'))}>
                  {(['owner', 'billing', 'viewer'] as const).map((r) => <option key={r} value={r}>{t(`auth.roles.${r}`)}</option>)}
                </select>
              </td>
              <td>{u.id !== me?.id && <button type="button" className="btn small" onClick={() => resetPin(u)}>{t('users.resetPin')}</button>}</td>
              <td>{u.id !== me?.id && (
                <button type="button" className="btn small" onClick={() => void run(() => api.updateUser(u.id, { active: !u.active }), t('common.saved'))}>
                  {u.active ? t('users.turnOff') : t('users.turnOn')}
                </button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="add-user" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <div className="field"><label htmlFor="u-name">{t('users.name')}</label><input id="u-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="u-role">{t('users.role')}</label>
          <select id="u-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>{(['billing', 'viewer', 'owner'] as const).map((r) => <option key={r} value={r}>{t(`auth.roles.${r}`)}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="u-pin">{t('users.pin')}</label><input id="u-pin" inputMode="numeric" value={pin} maxLength={6} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></div>
        <button type="submit" className="btn primary" disabled={!name.trim() || pin.length < 4}>{t('users.add')}</button>
      </form>
      <p className="hint">{t('users.pinHelp')}</p>
      {msg && <p className={msg.ok ? 'saved-note' : 'field-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </section>
  );
}
