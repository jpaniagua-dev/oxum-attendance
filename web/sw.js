/*
 * Keeps the kiosk launchable when the studio's wifi is not.
 *
 * The shell is cached on install and served cache-first — it changes only when
 * this file's CACHE name changes. Anything cross-origin (the Apps Script
 * endpoint, Google Fonts) is left alone: attendance data must never be served
 * from a stale cache, and the app has its own offline handling for it.
 */

var CACHE = 'kiosk-v1';
var SHELL = [
  '.',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (name) {
          return name === CACHE ? null : caches.delete(name);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(function (hit) {
      return hit || fetch(request);
    })
  );
});
