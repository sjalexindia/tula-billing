import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { recycleApi, type BinKind } from '../api/recycle';
import '../styles/recycle.css';

/**
 * Delete a master into the recycle bin (owner only). The server refuses anything in use and says
 * what to do instead (usually: mark it inactive); that reason is shown here.
 */
export function DeleteButton({ kind, id, name, onDone, small }: { kind: BinKind; id: string; name: string; onDone: () => void; small?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!window.confirm(t('recycle.confirm', { name }))) return;
    setBusy(true);
    setError('');
    try {
      await recycleApi.remove(kind, id);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={`btn danger${small ? ' small' : ''}`} disabled={busy} onClick={() => void go()}>{t('recycle.delete')}</button>
      {error && <span className="field-error" role="alert">{error}</span>}
    </>
  );
}
