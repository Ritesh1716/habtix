const CACHE_NAME = 'habtix-v349';
const CDN_CACHE = 'momentum-cdn-v2';
const FONT_CACHE = 'momentum-fonts-v1';

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/mo/mo-meditate.png',
  '/mo/mo-meditate-closed.png',
  '/mo/mo-wave-hello.png',
  '/mo/mo-comeback.png',
  '/mo/mo-handshake.png',
  '/mo/mo-arms-crossed.png',
  '/mo/mo-analyse.png',
  '/mo/mo-sit-relax.png',
  '/mo/mo-megaphone.png',
  '/mo/mo-wink.png',
  '/mo/mo-presenting.png',
  '/mo/mo-concerned.png',
  '/mo/mo-fist-pump.png',
  '/mo/mo-jump.png',
  '/mo/mo-trophy.png',
  '/mo/mo-thumbs-up.png',
  '/mo/mo-flex.png',
  '/mo/mo-clock.png',
  '/mo/mo-proud.png',
  '/villains/inertia.png',
  '/villains/procrastination.png',
  '/villains/distraction.png',
  '/villains/doubt.png',
  '/villains/breaker.png',
  '/villains/overload.png',
  '/villains/erraticrhythm.png',
  '/villains/goalhopping.png',
];

const CDN_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.9/babel.min.js',
];

// Firebase SDK modules the app imports at startup (index.html). Cached at install — not just on
// first use — so the very first offline cold start works even if the person went offline right
// after installing or updating the app.
const FIREBASE_MODULES = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(e => console.warn('Precache partial fail:', e))
    ),
    // One URL failing (CDN hiccup) must never fail the install — each is independent and the
    // runtime cache-first rules below still fill the cache on first use.
    caches.open(CDN_CACHE).then(cache =>
      Promise.all([...CDN_URLS, ...FIREBASE_MODULES].map(u =>
        cache.match(u).then(hit => hit || cache.add(u)).catch(e => console.warn('CDN precache skipped:', u, e && e.message))
      ))
    ),
  ]));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE && k !== FONT_CACHE && k !== 'momentum-kv-store')
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// C1: Message handler — SKIP_WAITING only. (Pomodoro notification scheduling
// removed along with the Pomodoro feature.)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── C3: Push handler (FCM closed-app delivery) ────────────────────────────────
// FCM sends web push using the standard Web Push protocol, so a plain 'push'
// listener receives it — no firebase-messaging-sw import needed. The server
// (/api/push.js) sends a "data-only" message so WE control exactly how the
// notification renders here (title/body/icon/tag), rather than the browser
// auto-rendering a "notification" payload. Wrapped in try/catch so a malformed
// payload can never crash the SW.
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // Non-JSON payload — fall back to plain text body.
    try { payload = { body: event.data ? event.data.text() : '' }; } catch (e2) { payload = {}; }
  }
  // FCM nests the app's fields under `data` for data-only messages.
  const d = payload.data || payload || {};
  const title = d.title || 'Habtix';
  const body = d.body || 'Plan your tomorrow — open Habtix.';
  const url = d.url || '/';
  const tag = d.tag || ('momentum_push_' + new Date().toDateString());
  // Notification design: app name (title), text, app icon, click-through link —
  // nothing else. No large `image` (it used to duplicate the Mo pose into a big
  // banner at the bottom of every push) and no per-state Mo icon.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      renotify: true,
      requireInteraction: false,
      vibrate: [200, 100, 200],
      data: { url },
    })
  );
});

// ── C3: Notification click — focus existing tab or open the app ───────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If the app is already open in a tab, focus it instead of opening a new one.
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && target !== '/') { try { client.navigate(target); } catch (e) {} }
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Console-confirmed bug: cache.put() only supports GET requests with http(s) schemes.
  // Browser extensions inject chrome-extension:// requests that this SW was intercepting
  // and trying to cache (throws "Request scheme is unsupported"), and any POST request
  // hitting a caught-all handler below threw the same way ("Request method is unsupported").
  // Letting anything non-GET or non-http(s) pass through untouched avoids both entirely.
  if (event.request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // CDN resources — cache-first, long TTL
  if (CDN_URLS.some(u => event.request.url.startsWith(u.split('/').slice(0,3).join('/')))) {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(resp => {
            if (resp.ok) cache.put(event.request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // Firebase SDK modules (www.gstatic.com/firebasejs/<version>/…) — versioned, immutable URLs.
  // Cache-first, in the CDN cache that survives app updates, so a COLD START with no connection can
  // still load Firebase: Auth restores the signed-in user from the device and Firestore then serves
  // the user's data from its on-device database. (Only this path — the same host also serves
  // things like reCAPTCHA, which must never be cached.)
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(resp => {
            if (resp.ok) cache.put(event.request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // Google Fonts — cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(resp => {
            if (resp.ok) cache.put(event.request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // Firebase / API — network only, no caching
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({error:'offline'}),
        {status:503,headers:{'Content-Type':'application/json'}}
      ))
    );
    return;
  }

  // App shell — network-first with cache fallback
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Mo character images — network-first, then cache.
  // The ?v=MO_ASSET_VERSION query param added by MoImg guarantees a new URL
  // whenever images are updated — the browser/SW cache has never seen it before,
  // so the first fetch always hits the network and gets the fresh file.
  // Subsequent requests use the cached result instantly. No cache:reload needed.
  if (url.pathname.startsWith('/mo/') && url.pathname.endsWith('.png')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached; // Cache hit — instant
        // Cache miss (new ?v= URL or first load) — fetch from network
        return fetch(event.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return resp;
        }).catch(() => new Response('', {status: 404}));
      })
    );
    return;
  }

  // Static assets (including /mo/ images) — cache-first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => new Response('', {status: 404}));
    })
  );
});
