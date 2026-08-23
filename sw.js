const CACHE_NAME = 'habtix-v295';
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
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(e => console.warn('Precache partial fail:', e))
    )
  );
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

// C1: Message handler — flush offline queue signal from app
// P3-A: also handles scheduling/cancelling a Pomodoro completion notification.
// NOTE on reliability: a SW-side setTimeout is NOT bulletproof for long sessions —
// browsers can still fully terminate an idle SW, especially on iOS or aggressive
// Android battery savers. This meaningfully improves delivery for the common case
// (screen lock / brief backgrounding during a session) but true guaranteed delivery
// for arbitrary-duration timers would need server-scheduled push, same as the daily
// check-in — that's real backend work, not something this client-only fix can promise.
const _pomoTimers = {};
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'SCHEDULE_POMODORO_NOTIF') {
    const { id, fireAt, label, mins } = event.data;
    if (_pomoTimers[id]) clearTimeout(_pomoTimers[id]);
    const delay = Math.max(0, fireAt - Date.now());
    _pomoTimers[id] = setTimeout(() => {
      self.registration.showNotification('⚡ Session Complete!', {
        body: label + ' — ' + mins + 'm done! 🎉',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'pomo_' + id,
        vibrate: [200, 100, 200],
      }).catch(() => {});
      delete _pomoTimers[id];
    }, delay);
  }
  if (event.data && event.data.type === 'CANCEL_POMODORO_NOTIF') {
    const { id } = event.data;
    if (_pomoTimers[id]) { clearTimeout(_pomoTimers[id]); delete _pomoTimers[id]; }
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
  const title = d.title || '⚡ Habtix';
  const body = d.body || "Mo's checking in — ready to build today?";
  const url = d.url || '/';
  const tag = d.tag || ('momentum_push_' + new Date().toDateString());
  // N.1: the server may send a situation-specific Mo pose as `icon`. Use it when
  // present, else fall back to the app icon. badge always stays the app icon.
  const icon = d.icon || '/icon-192.png';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      image: icon,
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
