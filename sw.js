/* Service worker : met l'app en cache pour qu'elle fonctionne sans réseau sur l'eau */
var CACHE = 'myscoach-v10';
var FILES = [
  './', './index.html', './app.js', './stroke.js', './heading.js', './line.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Réseau d'abord (pour recevoir les mises à jour), cache si hors ligne ou réseau trop lent (> 3 s)
function fetchWithTimeout(req) {
  return Promise.race([
    fetch(req),
    new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, 3000); })
  ]);
}
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetchWithTimeout(e.request).then(function (r) {
      if (r && r.ok && new URL(e.request.url).origin === location.origin) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return r;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (m) { return m || caches.match('./index.html'); });
    })
  );
});
