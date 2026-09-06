/*
 * sw.js - オフラインで動かすためのサービスワーカー
 *
 * 表示に必要なファイルはすべて静的なので、まとめてキャッシュしておく。
 * 取得はキャッシュ優先で即座に返しつつ、裏で新しい版を取りに行って次回に備える
 * （stale-while-revalidate）。写真は一切キャッシュしない（そもそも通信しない）。
 */
var CACHE = 'camera-stats-v1';

var ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/exif.js',
  './js/charts.js',
  './js/instagram.js',
  './js/card.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
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
    caches.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        // オフラインで未キャッシュのページを開いた場合はトップを返す
        return cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined);
      });

      return cached || network;
    })
  );
});
