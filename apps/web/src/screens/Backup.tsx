import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { opsApi, type BackupItem, type BackupStatus, type MachineInfo } from '../api/ops';
import type { ScreenProps } from '../nav';
import '../styles/ops.css';

const TZ = 'Asia/Kolkata';
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const locale = (lang: string) => (lang === 'ta' ? 'ta-IN' : 'en-IN');

/** "Today 9:00 PM", "Yesterday 9:00 PM", "Tomorrow 9:00 PM", else "12 Oct 2026, 9:00 PM" (India time). */
function useWhen() {
  const { t, i18n } = useTranslation();
  return (iso: string) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(locale(i18n.language), { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    const now = Date.now();
    const k = dayKey(d);
    if (k === dayKey(new Date(now))) return t('ops.today', { time });
    if (k === dayKey(new Date(now - 86400000))) return t('ops.yesterday', { time });
    if (k === dayKey(new Date(now + 86400000))) return t('ops.tomorrow', { time });
    const date = d.toLocaleDateString(locale(i18n.language), { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
    return t('ops.onDate', { date, time });
  };
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

type Health = 'ok' | 'warn' | 'problem';
function healthOf(s: BackupStatus): Health {
  if (s.lastError || !s.lastOk) return 'problem';
  if (Date.now() - new Date(s.lastOk.at).getTime() > 48 * 3600000) return 'problem';
  if (s.lastWarningFolder || !s.enabled || s.folderError) return 'warn';
  return 'ok';
}

export function Backup(_props: ScreenProps) {
  const { t } = useTranslation();
  const when = useWhen();
  const [s, setS] = useState<BackupStatus | null>(null);
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  // key + values, so the message follows a language switch
  const [runMsg, setRunMsg] = useState<{ ok: boolean; key: string; values: Record<string, string> } | null>(null);
  const [folder, setFolder] = useState('');
  const [time, setTime] = useState('21:00');
  const [enabled, setEnabled] = useState(true);
  const [cfgMsg, setCfgMsg] = useState<{ ok: boolean; text: string; key?: string } | null>(null);
  const [restoring, setRestoring] = useState<BackupItem | null>(null);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const st = await opsApi.status();
      setS(st);
      setFolder(st.isDefaultFolder ? '' : st.folder);
      setTime(st.time);
      setEnabled(st.enabled);
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    opsApi.info().then(setInfo).catch(() => {});
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setRunMsg(null);
    try {
      const r = await opsApi.runNow();
      setRunMsg(r.warningFolder ? { ok: false, key: 'ops.savedLocalOnly', values: { folder: r.warningFolder } } : { ok: true, key: 'ops.backupDone', values: { size: formatBytes(r.sizeBytes) } });
    } catch (e) {
      setRunMsg({ ok: false, key: 'ops.backupFailed', values: { reason: (e as Error).message } });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const saveConfig = async () => {
    setCfgMsg(null);
    try {
      const st = await opsApi.saveConfig({ folder, time, enabled });
      setS(st);
      setFolder(st.isDefaultFolder ? '' : st.folder);
      setCfgMsg({ ok: true, text: '', key: 'ops.settingsSaved' });
    } catch (e) {
      setCfgMsg({ ok: false, text: (e as Error).message });
    }
  };

  if (restarting) return <Restarting />;
  if (!s) return <section className="page"><div className="page-head"><h1>{t('ops.title')}</h1></div>{loadError && <p className="field-error" role="alert">{loadError}</p>}</section>;

  const health = healthOf(s);
  const changed = folder !== (s.isDefaultFolder ? '' : s.folder) || time !== s.time || enabled !== s.enabled;
  const twoPlaces = s.backups.some((b) => b.where === 'local') && s.backups.some((b) => b.where === 'chosen') && !s.isDefaultFolder;

  return (
    <div className="ops stack">
      <section className="page">
        <div className="page-head"><h1>{t('ops.title')}</h1></div>

        <div className={`ops-status ${health}`} role="status">
          <div className="ops-status-main">
            <span className="ops-badge">{t(`ops.health.${health}`)}</span>
            <p className="ops-last">
              {s.lastOk ? t('ops.lastBackup', { when: when(s.lastOk.at) }) : t('ops.neverBackedUp')}
            </p>
            <p className="ops-next">
              {s.running ? t('ops.runningNow') : s.enabled && s.nextRunAt ? t('ops.nextBackup', { when: when(s.nextRunAt) }) : t('ops.dailyOff')}
            </p>
          </div>
          <button type="button" className="btn primary ops-run" onClick={() => void runNow()} disabled={busy || s.running}>
            {busy ? t('ops.backingUp') : t('ops.backUpNow')}
          </button>
        </div>
        {s.lastError && <p className="notice ops-problem">{t('ops.lastFailed', { when: when(s.lastError.at), reason: s.lastError.message })}</p>}
        {s.lastWarningFolder && !s.lastError && <p className="notice">{t('ops.savedLocalOnly', { folder: s.lastWarningFolder })}</p>}
        {s.folderError && <p className="notice ops-problem">{t('ops.folderMissing', { folder: s.folder })}</p>}
        {s.lastRestore && !s.lastRestore.ok && <p className="notice ops-problem">{t('ops.restoreFailed', { reason: s.lastRestore.error ?? '' })}</p>}
        {s.restored && <p className="hint">{t('ops.restoredFrom', { file: s.restored.from, when: when(s.restored.at) })}</p>}
        {runMsg && <p className={runMsg.ok ? 'saved-note' : 'field-error'} role={runMsg.ok ? 'status' : 'alert'}>{t(runMsg.key, runMsg.values)}</p>}
      </section>

      <section className="page">
        <h2 className="ops-h2">{t('ops.whereTitle')}</h2>
        <form className="ops-config" onSubmit={(e) => { e.preventDefault(); void saveConfig(); }}>
          <div className="field ops-folder">
            <label htmlFor="ops-folder">{t('ops.folder')}</label>
            <input id="ops-folder" value={folder} placeholder={s.defaultFolder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} autoComplete="off" />
            <span className="hint">{t('ops.folderTip')}</span>
            <span className="hint">{t('ops.folderTipUsb')}</span>
            {s.sameDisk && !s.folderError && <span className="hint ops-warn-text">{t('ops.sameDisk')}</span>}
          </div>
          <div className="field ops-time">
            <label htmlFor="ops-time">{t('ops.dailyTime')}</label>
            <input id="ops-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            <span className="hint">{t('ops.dailyTimeTip')}</span>
          </div>
          <label className="ops-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('ops.dailyOn')}
          </label>
          <div className="ops-actions">
            {cfgMsg && <p className={cfgMsg.ok ? 'saved-note' : 'field-error'} role={cfgMsg.ok ? 'status' : 'alert'}>{cfgMsg.key ? t(cfgMsg.key) : cfgMsg.text}</p>}
            <button type="submit" className="btn primary" disabled={!changed}>{t('ops.saveSettings')}</button>
          </div>
        </form>
      </section>

      <section className="page">
        <h2 className="ops-h2">{t('ops.listTitle')}</h2>
        {!s.backups.length ? <p className="empty">{t('ops.noBackups')}</p> : (
          <ul className="ops-list">
            {s.backups.map((b) => (
              <li key={`${b.where}/${b.file}`}>
                <div className="ops-item">
                  <span className="ops-when">{when(b.createdAt)}</span>
                  <span className="ops-meta">
                    <span className={`ops-kind ${b.kind}`}>{t(`ops.kind.${b.kind}`)}</span>
                    {formatBytes(b.sizeBytes)}
                    {twoPlaces && <> · {t(`ops.where.${b.where}`)}</>}
                  </span>
                </div>
                <div className="ops-item-actions">
                  <a className="btn small" href={opsApi.downloadUrl(b.file)} download={b.file}>{t('ops.download')}</a>
                  <button type="button" className="btn small" disabled={!s.canRestoreHere} onClick={() => setRestoring(b)}>{t('ops.restore')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!s.canRestoreHere && s.backups.length > 0 && <p className="hint">{t('ops.restoreNeedsService')}</p>}
      </section>

      {info && (
        <section className="page">
          <h2 className="ops-h2">{t('ops.computerTitle')}</h2>
          <dl className="ops-info">
            <div><dt>{t('ops.info.phones')}</dt><dd>{info.lanUrls.length ? info.lanUrls.map((u) => <span key={u} className="mono ops-url">{u}</span>) : t('ops.info.noNetwork')}</dd></div>
            <div><dt>{t('ops.info.version')}</dt><dd>Tula {info.version}</dd></div>
            <div><dt>{t('ops.info.database')}</dt><dd><span className="ops-path">{info.dbFile}</span> ({formatBytes(info.dbSizeBytes)})</dd></div>
            <div><dt>{t('ops.info.disk')}</dt><dd>{info.disk ? t('ops.info.diskFree', { free: formatBytes(info.disk.freeBytes), total: formatBytes(info.disk.totalBytes) }) : t('ops.info.unknown')}</dd></div>
            <div><dt>{t('ops.info.running')}</dt><dd>{t('ops.info.uptime', { hours: Math.floor(info.uptimeSec / 3600), minutes: Math.floor((info.uptimeSec % 3600) / 60) })}{info.supervised ? '' : ` · ${t('ops.info.notService')}`}</dd></div>
            <div><dt>{t('ops.info.system')}</dt><dd>{info.hostname} · {info.os} · Node {info.node}</dd></div>
          </dl>
        </section>
      )}

      {restoring && <RestoreDialog item={restoring} when={when} onClose={() => setRestoring(null)} onStarted={() => { setRestoring(null); setRestarting(true); }} />}
    </div>
  );
}

function RestoreDialog({ item, when, onClose, onStarted }: { item: BackupItem; when: (iso: string) => string; onClose: () => void; onStarted: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const go = async () => {
    setWorking(true);
    setError('');
    try {
      await opsApi.restore(item.file, pin);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
      setWorking(false);
    }
  };

  return (
    <dialog ref={ref} className="ops-dialog" onClose={onClose} aria-labelledby="restore-title">
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <h2 id="restore-title">{t('ops.restoreTitle')}</h2>
        <p className="ops-dialog-when">{when(item.createdAt)} · {t(`ops.kind.${item.kind}`)}</p>
        <ul className="ops-dialog-points">
          <li>{t('ops.restorePoint1')}</li>
          <li>{t('ops.restorePoint2')}</li>
          <li>{t('ops.restorePoint3')}</li>
        </ul>
        <div className="field">
          <label htmlFor="restore-pin">{t('ops.yourPin')}</label>
          <input id="restore-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} value={pin} autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="ops-dialog-actions">
          <button type="button" className="btn" onClick={() => ref.current?.close()} disabled={working}>{t('ops.cancel')}</button>
          <button type="submit" className="btn primary ops-danger" disabled={pin.length < 4 || working}>{working ? t('ops.restoring') : t('ops.restoreAndRestart')}</button>
        </div>
      </form>
    </dialog>
  );
}

/** Shown while Tula restarts after a restore; reloads the app once the server answers again. */
function Restarting() {
  const { t } = useTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    let stopped = false;
    let wentDown = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      const up = await opsApi.alive();
      if (!up) wentDown = true;
      if (up && (wentDown || Date.now() - started > 8000)) { location.hash = '#/'; location.reload(); return; }
      if (Date.now() - started > 90000) setSlow(true);
      setTimeout(() => void tick(), 1500);
    };
    setTimeout(() => void tick(), 1500);
    return () => { stopped = true; };
  }, []);
  return (
    <section className="page ops-restarting" role="status">
      <h1>{t('ops.restartingTitle')}</h1>
      <p>{t('ops.restartingText')}</p>
      {slow && <p className="notice ops-problem">{t('ops.restartingSlow')}</p>}
    </section>
  );
}
