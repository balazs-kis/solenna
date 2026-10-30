// Service worker: makes the app shell open offline. Data (/api/*) and sign-in
// (/auth/*) always go to the network and are never cached.
//
// Installed apps keep serving the cached files until this file changes, so
// VERSION is a hash of everything in web/. When any file changes, cargo test
// fails and prints the new value to put here.
const VERSION = '29e74b38d7a0';
const CACHE = `solenna-shell-${VERSION}`;

// Every file of the shell. A cargo test checks that this lists every file in web/.
const SHELL = [
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/css/app.css',
  '/i18n/en.json',
  '/i18n/hu.json',
  '/js/api.js',
  '/js/app.js',
  '/js/cycle-math.js',
  '/js/dom.js',
  '/js/format.js',
  '/js/i18n.js',
  '/js/router.js',
  '/js/snapshot.js',
  '/js/store.js',
  '/js/theme-init.js',
  '/js/theme.js',
  '/js/weight-trend.js',
  '/js/views/account.js',
  '/js/views/avatar.js',
  '/js/views/cycle-calendar.js',
  '/js/views/cycle.js',
  '/js/views/hero.js',
  '/js/views/login.js',
  '/js/views/not-found.js',
  '/js/views/weight-chart.js',
  '/js/views/weight.js',
  '/icons/apple-touch-icon.png',
  '/icons/chevron-left.svg',
  '/icons/chevron-right.svg',
  '/icons/chevron-up-down.svg',
  '/icons/cycle.svg',
  '/icons/drop.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/info.svg',
  '/icons/ovulation.svg',
  '/icons/repeat.svg',
  '/icons/sprout.svg',
  '/icons/weight.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 'reload' skips the HTTP cache, so a new version never caches an old file.
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// Drop the caches of older versions and take over open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/')
  ) {
    return; // Not ours: the browser handles it as usual.
  }
  // App routes (/weight, /cycle, ...) are all the same page.
  const key = event.request.mode === 'navigate' ? '/index.html' : url.pathname;
  event.respondWith(caches.match(key).then((cached) => cached ?? fetch(event.request)));
});
