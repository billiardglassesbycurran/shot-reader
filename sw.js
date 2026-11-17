/* ── Curran's Shot Reader — service worker ─────────────────────────────
   Put this file next to index.html. index.html registers './sw.js'.

   WHY THIS EXISTS IN THIS FORM
   The app promises that after one online session it keeps working with no
   signal. That is only true if the things it fetches at runtime are cached,
   and it fetches four:

     1. TensorFlow.js            cdn.jsdelivr.net
     2. the COCO-SSD fallback    cdn.jsdelivr.net
     3. the trained model        billiardglassesbycurran.github.io
        + its .bin weight shards (several MB)
     4. Playfair / Barlow fonts  fonts.googleapis.com + fonts.gstatic.com

   Without caching those, an installed app opens offline and then fails at
   AI Detect with no explanation, in system fonts. So:

     - the page itself is NETWORK-FIRST, so a fresh upload always wins and
       nobody gets stuck on a stale build;
     - everything above is CACHE-FIRST, because those files are versioned or
       immutable and are the expensive part to re-fetch;
     - anything else is network-first with a cache fallback.

   Bumping SHELL_CACHE forces the page cache to refresh. The runtime cache is
   left alone on purpose - re-downloading the model on every deploy would be
   wasteful and slow. */

var SHELL_CACHE   = 'shot-reader-shell-v1';
var RUNTIME_CACHE = 'shot-reader-runtime-v1';

/* These must match what index.html actually links. The manifest is
   "manifest.webmanifest" - naming it manifest.json here made addAll reject,
   and addAll is all-or-nothing, so a single wrong name silently cached
   nothing at all. Each entry is now cached on its own for that reason. */
var SHELL = ['./', './index.html', './manifest.webmanifest'];

/* Hosts and paths whose responses are worth keeping for offline use. */
function isCacheFirst(url) {
  return url.hostname === 'cdn.jsdelivr.net'              // tfjs + coco-ssd
      || url.hostname === 'fonts.googleapis.com'          // font CSS
      || url.hostname === 'fonts.gstatic.com'             // font files
      || url.pathname.endsWith('.bin')                    // model weight shards
      || url.pathname.endsWith('model.json')              // model graph
      || /rack-reader-v3/.test(url.pathname);             // anything else in the model folder
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (c) {
        /* One entry per promise: a 404 on any one of them must not throw away
           the others, which is exactly what addAll would do. */
        return Promise.all(SHELL.map(function (u) {
          return c.add(u).catch(function () { /* that one file only */ });
        }));
      })
      .catch(function () { /* a missing shell entry must not block install */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* ── the heavy, stable things: cache first ───────────────────────────── */
  if (isCacheFirst(url)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          /* Opaque cross-origin responses still cache and still replay
             offline, which is what matters here. */
          if (res && (res.ok || res.type === 'opaque')) {
            var copy = res.clone();
            caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  /* ── the page: network first, so a new upload always wins ────────────── */
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        /* A navigation with nothing cached for that exact URL still wants
           the app, not a browser error page. */
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});

/* index.html posts this when the user taps Refresh on the update notice. */
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
