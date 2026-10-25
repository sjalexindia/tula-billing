import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Tula Android app (thin shell). The APK holds only the connect page in ./shell; the real app
 * is served by the shop computer over the shop Wi-Fi (http://192.168.x.x:5000), so the app
 * must be allowed to load plain-http pages on private LAN addresses.
 * Build: see .github/workflows/android.yml and docs/07-sync-and-phones.md.
 */
const privateLan = [
  '192.168.*.*',
  '10.*.*.*',
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*.*`),
  '*.local', // e.g. shop-pc.local where mDNS works
];

const config: CapacitorConfig = {
  appId: 'in.tula.app',
  appName: 'Tula',
  webDir: 'shell',
  server: {
    // the shop computer speaks plain http on the LAN
    cleartext: true,
    // open the shop computer's pages inside the app instead of handing them to Chrome
    allowNavigation: privateLan,
    // shown when the shop computer stops answering; links back to the connect page
    errorPath: 'error.html',
  },
  android: {
    // the shell is served from https://localhost inside the app; the shop computer is http
    allowMixedContent: true,
  },
};

export default config;
