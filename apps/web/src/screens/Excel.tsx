import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api';
import { downloadWorkbook, excelApi, readWorkbook, SheetError, type Cell, type ExcelKind, type ImportResult } from '../api/excel';
import type { ScreenProps } from '../nav';
import '../styles/excel.css';
import { serverText } from '../server-text';

const KINDS: ExcelKind[] = ['items', 'parties', 'opening-stock'];

/** Owner screen: download items / customers and suppliers / opening stock as Excel, fill or change them, import them back. */
export function Excel(_props: ScreenProps) {
  const { t } = useTranslation();
  return (
    <div className="excel-screen">
      <section className="page">
        <div className="page-head"><h1>{t('excel.title')}</h1></div>
        <p className="hint">{t('excel.lead')}</p>
        <ol className="excel-steps">
          <li>{t('excel.step1')}</li>
          <li>{t('excel.step2')}</li>
          <li>{t('excel.step3')}</li>
        </ol>
      </section>
      {KINDS.map((k) => <KindCard key={k} kind={k} />)}
    </div>
  );
}

function KindCard({ kind }: { kind: ExcelKind }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'download' | 'check' | 'save' | null>(null);
  const [rows, setRows] = useState<Array<Record<string, Cell>> | null>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const k = `excel.kinds.${kind}`;

  const fail = (e: unknown) => setError(e instanceof SheetError ? t(`excel.sheet.${e.code}`) : e instanceof ApiError || e instanceof Error ? e.message : String(e));

  const download = async () => {
    setBusy('download');
    setError('');
    try {
      const help = (t(`${k}.help`, { returnObjects: true }) as Array<[string, string]>) ?? [];
      await downloadWorkbook(kind, `${t(`${k}.file`)}.xlsx`, t(`${k}.title`), help);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy('check');
    setError('');
    setResult(null);
    setRows(null);
    setFileName(file.name);
    try {
      const r = await readWorkbook(await file.arrayBuffer());
      setRows(r);
      setResult(await excelApi.check(kind, r));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!rows) return;
    setBusy('save');
    setError('');
    try {
      const r = await excelApi.save(kind, rows);
      setResult(r);
      if (r.applied) setRows(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const shown = result?.rows.filter((r) => r.errors.length || r.notes.length || r.action !== 'skip') ?? [];
  const problems = result?.rows.filter((r) => r.errors.length) ?? [];

  return (
    <section className="page excel-card">
      <h2>{t(`${k}.title`)}</h2>
      <p className="hint">{t(`${k}.about`)}</p>
      <div className="form-actions">
        <button type="button" className="btn" disabled={!!busy} onClick={() => void download()}>
          {busy === 'download' ? t('excel.working') : t('excel.download')}
        </button>
        <label className={`btn${busy ? ' disabled' : ''}`}>
          {busy === 'check' ? t('excel.checking') : t('excel.choose')}
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden disabled={!!busy}
            onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}

      {result && (
        <div className="excel-result">
          {result.applied
            ? <p className="saved-note" role="status">{t('excel.saved', { created: result.created, updated: result.updated })}</p>
            : (
              <p className={problems.length ? 'notice' : 'hint'}>
                <b>{fileName}</b>{' — '}
                {problems.length
                  ? t('excel.hasErrors', { count: problems.length })
                  : t('excel.ready', { created: result.created, updated: result.updated, skipped: result.skipped })}
              </p>
            )}
          {shown.length > 0 && (
            <div className="excel-table">
              <table className="grid compact">
                <thead><tr><th>{t('excel.row')}</th><th>{t('excel.what')}</th><th>{t('excel.result')}</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.line} className={r.errors.length ? 'excel-bad' : ''}>
                      <td>{r.line}</td>
                      <td>{r.key}</td>
                      <td>
                        {r.errors.length ? r.errors.map((m) => <span key={m} className="field-error">{sheetError(m)}</span>) : t(`excel.action.${r.action}`)}
                        {r.notes.map((n) => <span key={n} className="sub">{n}</span>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!result.applied && rows && !problems.length && result.created + result.updated > 0 && (
            <div className="form-actions">
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => void save()}>
                {busy === 'save' ? t('excel.saving') : t('excel.save', { count: result.created + result.updated })}
              </button>
            </div>
          )}
          {problems.length > 0 && <p className="hint">{t('excel.fixAndRetry')}</p>}
        </div>
      )}
    </section>
  );
}

/** "GST %: …" (a sheet heading, kept as in the workbook, then the message) or a whole message, in the person's language. */
function sheetError(m: string): string {
  const whole = serverText(m);
  if (whole !== m) return whole;
  const i = m.indexOf(': ');
  return i > 0 ? `${m.slice(0, i)}: ${serverText(m.slice(i + 2))}` : m;
}
