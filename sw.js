/* sw.js — InkPad offline cache (PWA installable banane ke liye) */
'use strict';
const CACHE = 'inkpad-v10';
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/maskable-512.png',
  './assets/apple-touch-icon.png',
  './js/storage.js',
  './js/history.js',
  './js/canvas.js',
  './js/tools.js',
  './js/pages.js',
  './js/file-import.js',
  './js/pdf-handler.js',
  './js/file-resizer.js',
  './js/app.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // CDN libs (pdf.js / pdf-lib): network-first, cache backup
  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }
  // Local files: cache-first (?v=3 query ignore karke)
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        return fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        });
      })
    );
  }
});
