import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Phone build only: the connect page (Tula opened from the shop computer) goes in connect/. */
const connectPage = (outDir: string): Plugin => ({
  name: 'tula-connect-page',
  apply: 'build',
  closeBundle() {
    cpSync(resolve(__dirname, 'shell'), resolve(__dirname, outDir, 'connect'), { recursive: true });
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
    plugins: [react(), ...(phone ? [connectPage('dist-phone')] : [])],
    server: { port: 5173, proxy: { '/api': 'http://localhost:5000' } },
    build: phone ? { outDir: 'dist-phone', emptyOutDir: true } : undefined,
    worker: { format: 'es' },
    // sqlite-wasm finds its .wasm file next to itself; pre-bundling would move it
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  };
});
