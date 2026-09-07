const CACHE_NAME = "gameplan-firebase-preview-v2";
// Same-origin shell only. The Firebase SDK (gstatic) and everything else is
// cached lazily by the fetch handler on first use.
const APP_SHELL = [
  "./index.html",
  "./manifest.json",
  "./css/app.css?v=fb1",
  "./js/config.js?v=fb1",
  "./js/app.js?v=fb1",
  "./js/gameplan-api.js",
  "./js/firebase-app.js",
  "./firebase-config.js",
  "./assets/logo/gameplan-logo.svg",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(url))))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  // Let Firestore/Auth traffic go straight to the network — the SDK manages its
  // own offline cache.
  const url = new URL(event.request.url);
  if (/firestore\.googleapis\.com|identitytoolkit|googleapis\.com\/.*token/.test(url.href)) return;

  const fresh = event.request.mode === "navigate" ||
    ["document", "script", "style"].includes(event.request.destination);

  if (fresh) {
    event.respondWith(
      fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }))
  );
});
