import { cpSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Phone build only:
 * - the connect page (Tula opened from the shop computer, Android app) goes in connect/;
 * - precache.json lists every file, so the service worker stores the whole app at install and the
 *   web version (Cloudflare Pages, for iPhones) opens with no internet;
 * - _headers tells Cloudflare Pages to keep hashed files for good and always check the page and sw.js.
 */
const phoneExtras = (outDir: string): Plugin => ({
  name: 'tula-phone-extras',
  apply: 'build',
  closeBundle() {
    const out = resolve(__dirname, outDir);
    cpSync(resolve(__dirname, 'shell'), join(out, 'connect'), { recursive: true });
    const skip = new Set(['sw.js', 'precache.json', '_headers']);
    const files = (readdirSync(out, { recursive: true }) as string[])
      .map((f) => f.split(sep).join('/'))
      // .woff fonts are only a fallback for browsers without .woff2: no phone needs them offline
      .filter((f) => statSync(join(out, f)).isFile() && !skip.has(f) && !f.startsWith('connect/') && f !== 'index.html' && !f.endsWith('.woff'));
    writeFileSync(join(out, 'precache.json'), JSON.stringify(['/', ...files.map((f) => `/${f}`)]));
    writeFileSync(join(out, '_headers'), [
      '/assets/*', '  Cache-Control: public, max-age=31536000, immutable',
      '/sw.js', '  Cache-Control: no-cache',
      '/precache.json', '  Cache-Control: no-cache',
      '/', '  Cache-Control: no-cache',
      '/index.html', '  Cache-Control: no-cache', '',
    ].join('\n'));
  },
});

/*
 * `vite build`              the web app the shop computer serves (dist/)
 * `vite build --mode phone` the Android app's copy (dist-phone/): Tula runs on the phone itself,
 *                           with SQLite WebAssembly in a worker (see src/local and src/platform.ts)
 */
export default defineConfig(({ mode }) => {
  const phone = mode === 'phone';
  return {
    plugins: [react(), ...(phone ? [phoneExtras('dist-phone')] : [])],
    server: { port: 5173, proxy: { '/api': 'http://localhost:5000' } },
    build: phone ? { outDir: 'dist-phone', emptyOutDir: true } : undefined,
    worker: { format: 'es' },
    // sqlite-wasm finds its .wasm file next to itself; pre-bundling would move it
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  };
});
