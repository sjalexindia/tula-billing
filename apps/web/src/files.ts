import { Capacitor } from '@capacitor/core';

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Give the person a file Tula made (an Excel workbook, a bill image). On a computer's browser it
 * downloads; in a phone's browser (the web version on an iPhone) the phone's share sheet opens; in
 * the Android app, where downloads don't work, it is saved to the app's cache and the share sheet
 * opens (WhatsApp, Drive, Gmail, Files…).
 */
export async function saveFile(name: string, bytes: Uint8Array | Blob, mime: string): Promise<void> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: mime });
  if (!Capacitor.isNativePlatform()) {
    // A phone's browser (the web version on an iPhone): its own share sheet, when it can share files.
    // Computers keep downloading. If the browser refuses (it may, once the tap is a few seconds old), download.
    const file = new File([blob], name, { type: mime });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // closed the share sheet
      }
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return;
  }
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const { uri } = await Filesystem.writeFile({ path: name.replace(/[\\/:*?"<>|]/g, '_'), data, directory: Directory.Cache });
  await Share.share({ title: name, files: [uri] });
}

/** Read a file the person picked (input type=file). */
export const readFile = (file: File) => file.arrayBuffer();
