/*
 * Tula service worker: caches ONLY the static app shell (index.html, hashed /assets/*,
 * icons, manifest) so the app opens quickly. Never caches /api/ — bills, stock and
 * balances always come live from the shop computer.
 * Browsers run service workers only on https or localhost; on http://192.168.x.x
 * this file is simply never registered (see docs/07-sync-and-phones.md).
 * The phone build hosted on the web (Cloudflare Pages, for iPhones) runs Tula on the phone itself,
 * so it must open with no internet at all: its build writes precache.json, the list of every file,
 * and all of them are stored at install.
 */
const CACHE = 'tula-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

/** Every file of the phone build (written by its build), or null for the shop computer's build. */
const precacheList = () => fetch('/precache.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheList()
      .then((list) => caches.open(CACHE).then((c) => c.addAll(list ?? SHELL)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tula-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      // drop files of earlier builds, so the cache doesn't grow with every update
      .then(() => precacheList())
      .then((list) => list && caches.open(CACHE).then((c) => c.keys().then((reqs) => Promise.all(reqs
        .filter((r) => !list.includes(new URL(r.url).pathname))
        .map((r) => c.delete(r))))))
      .then(() => self.clients.claim()),
  );
});

/** fetch, but give up after `ms`: a weak mobile signal must not keep the app from opening. */
const fetchWithin = (req, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('slow network')), ms);
  fetch(req).then((r) => { clearTimeout(timer); resolve(r); }, (e) => { clearTimeout(timer); reject(e); });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // live data: never cached

  // Pages: network first (a new version shows at once), the stored copy when offline or the network is slow.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetchWithin(req, 4000)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || fetch(req))),
    );
    return;
  }

  // Built files have content hashes in their names, so a cached copy is always right.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
