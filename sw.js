
/* Mitooma VSS offline-first service worker */
const CACHE_VERSION = 'mvss-app-shell-v2';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest'];

function isApprovedLibrary(url) {
  if (url.hostname === 'cdnjs.cloudflare.com') {
    return url.pathname.startsWith('/ajax/libs/html2pdf.js/') ||
           url.pathname.startsWith('/ajax/libs/pdf-lib/');
  }
  if (url.hostname === 'www.gstatic.com') {
    return url.pathname.startsWith('/firebasejs/9.22.1/');
  }
  return false;
}

function isSameOriginStatic(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (request.mode === 'navigate') return false;
  return ['script', 'style', 'image', 'font', 'manifest']
    .includes(request.destination);
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key =>
          key.startsWith('mvss-app-shell-') &&
          key !== CACHE_VERSION
        )
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin &&
      request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION)
            .then(cache => cache.put('./index.html', copy));
        }
        return response;
      }).catch(async () => {
        return (await caches.match('./index.html')) ||
               (await caches.match('./')) ||
               Response.error();
      })
    );
    return;
  }

  const approvedLibrary =
    isApprovedLibrary(url) && request.destination === 'script';

  if (approvedLibrary || isSameOriginStatic(request, url)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) {
          fetch(request).then(response => {
            if (response &&
                (response.ok || response.type === 'opaque')) {
              caches.open(CACHE_VERSION)
                .then(cache => cache.put(request, response.clone()));
            }
          }).catch(() => {});
          return cached;
        }

        return fetch(request).then(response => {
          if (response &&
              (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_VERSION)
              .then(cache => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});
