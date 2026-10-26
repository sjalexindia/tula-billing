import { Capacitor } from '@capacitor/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { saveFile } from '../files';

/**
 * Print and Share for a customer document (bill, receipt, statement). Share makes a picture of
 * the document (drawn by the browser, so Tamil shapes correctly); Share as PDF puts that picture on
 * A4 or A5 pages, like the printed document. Both go to the share sheet in the Android app
 * (WhatsApp, a Bluetooth printer app…) or download on a computer. The Android app cannot print from
 * the page, so it shows no Print button.
 */
export function PrintShare({ target, fileName, printLabel }: { target: string; fileName: string; printLabel: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'png' | 'pdf' | null>(null);
  const [error, setError] = useState('');
  const inApp = Capacitor.isNativePlatform();
  const name = fileName.replace(/[\\/]/g, '-');

  const share = async (as: 'png' | 'pdf') => {
    const el = document.querySelector<HTMLElement>(target);
    if (!el) return;
    setBusy(as);
    setError('');
    try {
      const shot = await picture(el);
      if (as === 'png') await saveFile(`${name}.png`, shot.blob, 'image/png');
      else await saveFile(`${name}.pdf`, await toPdf(shot), 'application/pdf');
    } catch (e) {
      // closing the share sheet without choosing an app is not an error
      if (!/cancel/i.test((e as Error).message)) setError((e as Error).message || t('share.failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" className={`btn${inApp ? ' primary' : ''}`} disabled={!!busy} onClick={() => void share('png')}>
        {busy === 'png' ? t('share.working') : t('share.button')}
      </button>
      <button type="button" className="btn" disabled={!!busy} onClick={() => void share('pdf')}>
        {busy === 'pdf' ? t('share.working') : t('pdf.button')}
      </button>
      {!inApp && <button type="button" className="btn primary" onClick={() => window.print()}>{printLabel}</button>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </>
  );
}

interface Shot { blob: Blob; dataUrl: string; width: number; height: number; paper: 'a4' | 'a5' }

/** The document as a PNG at its paper width (its max-width: 210 mm for A4, 148 mm for A5). */
async function picture(el: HTMLElement): Promise<Shot> {
  const { toCanvas } = await import('html-to-image');
  await document.fonts.ready;
  el.style.width = getComputedStyle(el).maxWidth;
  el.classList.add('capturing');
  let canvas: HTMLCanvasElement;
  try {
    canvas = await toCanvas(el, { pixelRatio: 2, backgroundColor: '#ffffff', width: el.offsetWidth, height: el.offsetHeight });
  } finally {
    el.classList.remove('capturing');
    el.style.width = '';
  }
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('The picture could not be made');
  // 148 mm is about 560 CSS px, 210 mm about 794
  return { blob, dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, paper: canvas.width / 2 < 680 ? 'a5' : 'a4' };
}

/** The picture across as many pages as it needs, full page width, top to bottom. */
async function toPdf(s: Shot): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: s.paper, orientation: 'portrait', compress: true });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgH = (s.height * pageW) / s.width;
  for (let y = 0, page = 0; y < imgH - 0.5; y += pageH, page++) {
    if (page) pdf.addPage(s.paper, 'portrait');
    pdf.addImage(s.dataUrl, 'PNG', 0, -y, pageW, imgH, 'doc', 'FAST');
  }
  return pdf.output('blob');
}
