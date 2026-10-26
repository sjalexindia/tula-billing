import { Capacitor } from '@capacitor/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { saveFile } from '../files';

/**
 * Print and Share for a customer document (bill, receipt, statement). Share makes a picture of
 * the document (drawn by the browser, so Tamil shapes correctly) and hands it to the share sheet
 * in the Android app (WhatsApp, a Bluetooth printer app…) or downloads it on a computer. The
 * Android app cannot print from the page, so it shows only Share there.
 */
export function PrintShare({ target, fileName, printLabel }: { target: string; fileName: string; printLabel: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inApp = Capacitor.isNativePlatform();

  const share = async () => {
    const el = document.querySelector<HTMLElement>(target);
    if (!el) return;
    setBusy(true);
    setError('');
    try {
      const { toBlob } = await import('html-to-image');
      await document.fonts.ready;
      // lay it out at paper width (its max-width: A4 or A5) while the picture is taken
      el.style.width = getComputedStyle(el).maxWidth;
      el.classList.add('capturing');
      let blob: Blob | null;
      try {
        blob = await toBlob(el, { pixelRatio: 2, backgroundColor: '#ffffff', width: el.offsetWidth, height: el.offsetHeight });
      } finally {
        el.classList.remove('capturing');
        el.style.width = '';
      }
      if (!blob) throw new Error(t('share.failed'));
      await saveFile(`${fileName.replace(/[\\/]/g, '-')}.png`, blob, 'image/png');
    } catch (e) {
      // closing the share sheet without choosing an app is not an error
      if (!/cancel/i.test((e as Error).message)) setError((e as Error).message || t('share.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={`btn${inApp ? ' primary' : ''}`} disabled={busy} onClick={() => void share()}>
        {busy ? t('share.working') : t('share.button')}
      </button>
      {!inApp && <button type="button" className="btn primary" onClick={() => window.print()}>{printLabel}</button>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </>
  );
}
