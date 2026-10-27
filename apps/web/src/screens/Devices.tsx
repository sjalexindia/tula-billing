import { Capacitor } from '@capacitor/core';
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '../components/Field';
import { syncApi, type DeviceRow, type NetworkInfo, type SyncStatus } from '../api/sync';
import type { ScreenProps } from '../nav';
import { runsLocally } from '../platform';
import '../styles/sync.css';
import { serverText } from '../server-text';

const ERROR_CODES = ['OFFLINE', 'AUTH', 'BAD_URL', 'UPDATE_APP', 'REVOKED', 'EMPTY_HUB'];
const PHONE_ERROR_CODES = ['OFFLINE', 'AUTH', 'BAD_URL', 'REVOKED'];

/** Owner screen: is the cloud copy working, which computers share the data, and how to open Tula on a phone. */
export function Devices(_props: ScreenProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([syncApi.status(), syncApi.devices()]);
      setStatus(s);
      setDevices(d);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    if (!runsLocally) syncApi.network().then(setNet).catch(() => setNet({ port: 0, addresses: [] }));
    const timer = setInterval(() => void syncApi.status().then(setStatus).catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const syncNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await syncApi.syncNow();
      setStatus(r.status);
      setDevices(await syncApi.devices());
      if (r.result.ok) setMsg({ ok: true, text: t('sync.syncedNow') });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const change = async (d: DeviceRow, patch: { name?: string; revoked?: boolean }) => {
    try {
      await syncApi.updateDevice(d.id, patch);
      setMsg({ ok: true, text: t('common.saved') });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const rename = (d: DeviceRow) => {
    const name = window.prompt(t('sync.devices.newName'), d.name)?.trim();
    if (name && name !== d.name) void change(d, { name });
  };
  const toggleLost = (d: DeviceRow) => {
    if (!d.revoked && !window.confirm(t('sync.devices.confirmLost', { name: d.name }))) return;
    void change(d, { revoked: !d.revoked });
  };

  return (
    <div className="sync-screen">
      <section className="page">
        <div className="page-head"><h1>{t('nav.devices')}</h1></div>
        {status ? <StatusCard status={status} busy={busy} onSyncNow={syncNow} /> : <p className="empty">{t('sync.loading')}</p>}
        {msg && <p className={msg.ok ? 'saved-note' : 'field-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
        {runsLocally && status && <ThisPhoneCard status={status} />}
        {!runsLocally && <details className="sync-setup" open={status ? !status.configured : false}>
          <summary>{t('sync.setup.title')}</summary>
          <ol>
            <li>{t('sync.setup.step1')}</li>
            <li>{t('sync.setup.step2')}</li>
            <li>
              {t('sync.setup.step3')}
              <pre>{'TULA_SYNC_URL=libsql://<your-db>.turso.io\nTULA_SYNC_TOKEN=<token>'}</pre>
            </li>
            <li>{t('sync.setup.step4')}</li>
          </ol>
          <p className="hint">{t('sync.setup.secret')} {t('sync.setup.doc')} <code>docs/07-sync-and-phones.md</code></p>
        </details>}
      </section>

      {!runsLocally && <PhoneCard net={net} />}

      <section className="page">
        <h2>{t('sync.devices.title')}</h2>
        <p className="hint">{t('sync.devices.help')}</p>
        <table className="grid compact sync-devices">
          <thead><tr><th>{t('sync.devices.name')}</th><th>{t('sync.devices.series')}</th><th /></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className={d.revoked ? 'inactive' : ''}>
                <td>
                  <b>{d.name}</b>
                  {d.this_device && <span className="sync-tag">{t(runsLocally ? 'sync.devices.thisPhone' : 'sync.devices.thisOne')}</span>}
                  {!!d.revoked && <span className="sync-tag lost">{t('sync.devices.lost')}</span>}
                  <span className="sub">{t('sync.devices.added', { when: fmtTime(d.created_at, t) })}</span>
                </td>
                <td>{d.series_code || t('sync.devices.mainSeries')}</td>
                <td className="sync-actions">
                  <button type="button" className="btn small" onClick={() => rename(d)}>{t('sync.devices.rename')}</button>
                  {!d.this_device && (
                    <button type="button" className="btn small" onClick={() => toggleLost(d)}>
                      {d.revoked ? t('sync.devices.found') : t('sync.devices.markLost')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!devices.length && <p className="empty">{t('sync.loading')}</p>}
        <p className="hint">{t('sync.devices.lostHelp')}</p>
      </section>
    </div>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

function fmtTime(iso: string | null, t: T): string {
  if (!iso) return t('sync.never');
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return t('sync.justNow');
  if (ms < 3_600_000) return t('sync.minutesAgo', { n: Math.round(ms / 60_000) });
  return new Date(iso).toLocaleString(t('sync.locale'), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const fmtDate = (iso: string, t: T) => new Date(iso).toLocaleDateString(t('sync.locale'), { day: 'numeric', month: 'short', year: 'numeric' });

/** Turso can't revoke one token, so each phone gets one that runs out (docs/07); warn a week ahead. */
function TokenWarning({ expiresAt }: { expiresAt: string | null }) {
  const { t } = useTranslation();
  if (!expiresAt) return null;
  const left = new Date(expiresAt).getTime() - Date.now();
  if (left > 7 * 86_400_000) return null;
  return (
    <p className={left <= 0 ? 'field-error' : 'notice'} role="alert">
      {t(left <= 0 ? 'tokens.expired' : 'tokens.soon', { date: fmtDate(expiresAt, t) })}{' '}
      {t(runsLocally ? 'tokens.hintPhone' : 'tokens.hintComputer')}
    </p>
  );
}

function StatusCard({ status, busy, onSyncNow }: { status: SyncStatus; busy: boolean; onSyncNow: () => void }) {
  const { t } = useTranslation();
  const state = !status.configured ? 'off' : status.lastError ? 'problem' : status.lastPushAt ? 'ok' : 'starting';
  const err = status.lastError;
  return (
    <div className={`sync-status ${state}`}>
      <div className="sync-status-head">
        <span className="sync-dot" aria-hidden="true" />
        <div>
          <h2>{t(`sync.state.${state}`)}</h2>
          <p className="sync-lead">{t(runsLocally && state !== 'off' ? `sync.phoneLead.${state}` : `sync.lead.${state}`)}</p>
        </div>
      </div>
      {err && (
        <div className="sync-error" role="alert">
          <p>{runsLocally && PHONE_ERROR_CODES.includes(err.code) ? t(`sync.phoneErrors.${err.code}`) : ERROR_CODES.includes(err.code) ? t(`sync.errors.${err.code}`) : serverText(err.message)}</p>
          {err.at && <p className="hint">{t('sync.since', { when: fmtTime(err.at, t) })}</p>}
        </div>
      )}
      {status.configured && (
        <dl className="sync-facts">
          <div><dt>{t('sync.hub')}</dt><dd>{status.hub}</dd></div>
          <div><dt>{t('sync.lastSent')}</dt><dd>{fmtTime(status.lastPushAt, t)}</dd></div>
          <div><dt>{t('sync.lastReceived')}</dt><dd>{fmtTime(status.lastPullAt, t)}</dd></div>
          <div><dt>{t('sync.waiting')}</dt><dd>{status.pending}</dd></div>
          <div><dt>{t('tokens.expires')}</dt><dd>{status.tokenExpiresAt ? fmtDate(status.tokenExpiresAt, t) : t('tokens.never')}</dd></div>
        </dl>
      )}
      <TokenWarning expiresAt={status.tokenExpiresAt} />
      {status.rejected > 0 &&<p className="notice">{t('sync.rejected', { count: status.rejected })}</p>}
      {status.configured && (
        <button type="button" className="btn primary" disabled={busy || !status.running} onClick={onSyncNow}>
          {busy ? t('sync.syncing') : t('sync.syncNow')}
        </button>
      )}
      {status.configured && !status.running && <p className="hint">{t('sync.notRunning')}</p>}
    </div>
  );
}

function PhoneCard({ net }: { net: NetworkInfo | null }) {
  const { t } = useTranslation();
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const urls = (net?.addresses ?? []).filter((a) => a.private);
  const shown = urls.length ? urls : (net?.addresses ?? []);

  useEffect(() => {
    let live = true;
    Promise.all(shown.map(async (a) => [a.url, await QRCode.toDataURL(`${a.url}/`, { margin: 1, width: 220 })] as const))
      .then((pairs) => { if (live) setQrs(Object.fromEntries(pairs)); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net]);

  return (
    <section className="page">
      <h2>{t('sync.phone.title')}</h2>
      <ol className="sync-steps">
        <li>{t('sync.phone.step1')}</li>
        <li>{t('sync.phone.step2')}</li>
        <li>{t('sync.phone.step3')}</li>
        <li>{t('sync.phone.step4')}</li>
      </ol>
      {!net && <p className="empty">{t('sync.loading')}</p>}
      {net && !shown.length && <p className="notice">{t('sync.phone.noNetwork')}</p>}
      <div className="sync-qrs">
        {shown.map((a) => (
          <figure key={a.url} className="sync-qr">
            {qrs[a.url] ? <img src={qrs[a.url]} alt={t('sync.phone.qrAlt', { url: a.url })} width={220} height={220} /> : <div className="sync-qr-blank" />}
            <figcaption><b>{a.url}</b><span className="sub">{a.name}</span></figcaption>
          </figure>
        ))}
      </div>
      {shown.length > 1 && <p className="hint">{t('sync.phone.several')}</p>}
      <p className="hint">{t('sync.phone.app')}</p>
    </section>
  );
}

/** Only when Tula runs on this phone: its bill series, a new access token, and going back to the shop computer. */
function ThisPhoneCard({ status }: { status: SyncStatus }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const phone = () => import.meta.env.MODE === 'phone' ? import('../local/phone') : Promise.reject(new Error('phone build only'));
  const saveToken = async () => {
    setBusy(true);
    setError('');
    try {
      await (await phone()).changeHub({ url: url.trim(), token: token.trim() });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="sync-phone">
      <h2>{t('sync.thisPhone.title')}</h2>
      <p>{t('sync.thisPhone.series', { series: status.device.seriesCode })}</p>
      <details>
        <summary>{t('sync.thisPhone.token')}</summary>
        <p className="hint">{t('sync.thisPhone.tokenHelp')}</p>
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void saveToken(); }}>
          <Field id="hub-url" label={t('phone.setup.url')}>
            <input id="hub-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`libsql://${status.hub ?? ''}`} autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field id="hub-token" label={t('phone.setup.token')}>
            <input id="hub-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
          {error && <p className="field-error wide" role="alert">{error}</p>}
          <div className="form-actions"><button type="submit" className="btn" disabled={busy || !url.trim() || !token.trim()}>{t('sync.thisPhone.save')}</button></div>
        </form>
      </details>
      {/* the Android app can switch to opening Tula from the shop computer; the web version can't (https → http) */}
      {Capacitor.isNativePlatform() && <details>
        <summary>{t('sync.thisPhone.shopComputer')}</summary>
        <p className="hint">{t('sync.thisPhone.shopComputerHelp')}</p>
        {status.pending > 0 && <p className="notice">{t('sync.thisPhone.pending', { count: status.pending })}</p>}
        <button type="button" className="btn" onClick={() => void phone().then((p) => p.useShopComputer())}>{t('sync.thisPhone.shopComputer')}</button>
      </details>}
    </div>
  );
}
