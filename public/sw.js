/* 案件管理系统 PWA Service Worker */
const VERSION = 'v1.0.0';
const STATIC_CACHE = `case-manager-static-${VERSION}`;
const PAGE_CACHE = `case-manager-pages-${VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/css/app.css',
  '/vendor/bootstrap/css/bootstrap.min.css',
  '/vendor/bootstrap-icons/bootstrap-icons.css',
  '/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
  '/vendor/bootstrap-icons/fonts/bootstrap-icons.woff',
];

const isStaticAsset = (url) =>
  url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/') ||
  url.pathname.startsWith('/icons/') || url.pathname.startsWith('/vendor/');

const isSensitive = (url) =>
  url.pathname.startsWith('/api/') || url.pathname.startsWith('/sign/') ||
  url.pathname.startsWith('/uploads/') || url.pathname === '/login';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys
          .filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE)
          .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 静态资源：cache-first（离线可用，秒开）
  if (isStaticAsset(url)) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        if (hit) {
          fetch(e.request).then((res) => {
            if (res && res.ok) caches.open(STATIC_CACHE).then((c) => c.put(e.request, res.clone()));
          }).catch(() => {});
          return hit;
        }
        return fetch(e.request).then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        }).catch(() => caches.match('/offline.html'));
      })
    );
    return;
  }

  // 敏感/动态接口：绝不缓存
  if (isSensitive(url)) return;

  // 页面导航：network-first，失败回退缓存页，再回退离线页
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(PAGE_CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request)
            .then((hit) => hit || caches.match('/offline.html'))
        )
    );
    return;
  }
});

/* ---- Web Push 预留：需 HTTPS + VAPID 密钥（服务端订阅推送）后才生效 ---- */
self.addEventListener('push', (e) => {
  let data = { title: '案件管理系统', body: '', url: '/dashboard' };
  try { if (e.data) Object.assign(data, e.data.json()); } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/dashboard', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        for (const c of list) {
          if ('focus' in c) { c.focus(); if ('navigate' in c) c.navigate(url); return; }
        }
        return self.clients.openWindow(url);
      })
  );
});
