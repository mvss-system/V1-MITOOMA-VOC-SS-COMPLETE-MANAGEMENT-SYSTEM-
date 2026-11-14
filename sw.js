
/* Mitooma VSS offline-first service worker.
   GitHub Pages project-site safe: all app URLs are resolved from this worker's scope. */
const CACHE_VERSION = 'mvss-app-shell-v4';
const APP_CACHE = CACHE_VERSION;
const scopeURL = new URL(self.registration.scope);
const indexURL = new URL('index.html', scopeURL).href;
const rootURL = scopeURL.href;
const manifestURL = new URL('manifest.webmanifest', scopeURL).href;

function isApprovedLibrary(url, request) {
  if (request.destination !== 'script') return false;
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
  return url.origin === self.location.origin &&
    ['script', 'style', 'image', 'font', 'manifest'].includes(request.destination);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // Cache the project-scoped app entry point.
    const response = await fetch(new Request(indexURL, { cache: 'reload' }));
    if (!response.ok) throw new Error(`Could not cache ${indexURL}: HTTP ${response.status}`);
    await cache.put(indexURL, response.clone());
    await cache.put(rootURL, response.clone());

    // A missing manifest must not prevent installation.
    try {
      const manifestResponse = await fetch(new Request(manifestURL, { cache: 'reload' }));
      if (manifestResponse.ok) await cache.put(manifestURL, manifestResponse);
    } catch (error) {
      console.warn('MVSS manifest was not cached during install:', error);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('mvss-app-shell-') && key !== CACHE_VERSION)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Online-first navigation, with a cached homepage when offline.
  if (url.origin === self.location.origin && request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          await cache.put(indexURL, response.clone());
          if (url.href === rootURL) await cache.put(rootURL, response.clone());
        }
        return response;
      } catch (error) {
        return (await cache.match(url.href)) ||
               (await cache.match(indexURL)) ||
               (await cache.match(rootURL)) ||
               new Response(
                 'Mitooma School is not available offline yet. Connect to the internet once, open the system fully, and try again.',
                 {
                   status: 503,
                   headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                 }
               );
      }
    })());
    return;
  }

  // Cache local static files and approved external libraries.
  const approvedLibrary = isApprovedLibrary(url, request);
  if (approvedLibrary || isSameOriginStatic(request, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const cached = await cache.match(request);
      const refresh = fetch(request).then(async response => {
        if (response && (response.ok || response.type === 'opaque')) {
          await cache.put(request, response.clone());
        }
        return response;
      });

      if (cached) {
        event.waitUntil(refresh.catch(() => {}));
        return cached;
      }
      return refresh;
    })());
  }
});
