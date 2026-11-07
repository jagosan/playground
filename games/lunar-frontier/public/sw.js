/* eslint-env serviceworker */
/**
 * Lunar Frontier — PWA Service Worker (Spec 34 §2.3, TASK-PLAY-081c).
 *
 * Satisfies Chromium Android's strict installability criteria (registered SW
 * with a functional fetch/lifecycle handler) on the secure Tailscale HTTPS
 * origin (`https://beehive.tail1ab408.ts.net/` → `tailscale serve --bg 5174`).
 *
 * Strategy:
 *   - install  : pre-cache the app shell, then skipWaiting() so a new version
 *                takes over without requiring a full app restart.
 *   - activate : purge stale `lf-pwa-*` caches, then clients.claim() so the
 *                fresh SW controls already-open tabs immediately.
 *   - fetch    : network-first with cache fallback for navigations and static
 *                app assets; WebSocket (`/ws`) and live API (`/api`) traffic is
 *                bypassed entirely so realtime state is never served stale.
 */

const CACHE_NAME = 'lf-pwa-v1';

/** App-shell assets pre-cached at install time (relative to SW scope). */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // cache.addAll() rejects atomically if any shell asset 404s; cache
        // individually so one missing icon never kills the whole install.
        Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))),
      )
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[pwa][sw] shell pre-cache failed:', err);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('lf-pwa-') && k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** True when the request must never be intercepted (realtime / live data). */
function isBypassed(request) {
  if (request.method !== 'GET') return true;
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return true;
    if (url.pathname.endsWith('/ws') || url.pathname.includes('/ws/')) return true;
    if (url.pathname.startsWith('/api') || url.pathname.includes('/api/')) return true;
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return true;
    return false;
  } catch {
    return true;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (isBypassed(request)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response != null && response.ok) {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
        }
        return response;
      })
      .catch(() =>
        caches.match(request, { ignoreSearch: false }).then((cached) => {
          if (cached != null) return cached;
          // Navigation while offline → cached shell entry point.
          if (request.mode === 'navigate') {
            return caches.match('./index.html').then((shell) => {
              if (shell != null) return shell;
              return caches.match('./');
            });
          }
          return Response.error();
        }),
      ),
  );
});
