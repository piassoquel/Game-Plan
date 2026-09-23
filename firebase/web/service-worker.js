const CACHE_NAME = "gameplan-fb21";

// Minimal precache — the offline entry point. Everything else caches lazily.
const APP_SHELL = [
  "./index.html",
  "./manifest.json",
  "./assets/logo/gameplan-logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(APP_SHELL.map((u) => cache.add(u))))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Firestore / Auth manage their own offline cache — never intercept.
  if (/firestore\.googleapis\.com|identitytoolkit|securetoken\.googleapis\.com/.test(url.href)) return;

  if (url.pathname.endsWith("/version.json")) return; // update checks must hit the network

  const sameOrigin = url.origin === self.location.origin;
  const isCode = event.request.mode === "navigate" ||
    ["document", "script", "style", "worker"].includes(event.request.destination) ||
    /\.(?:js|mjs|css)$/.test(url.pathname);

  // Code + navigations: network-first, fall back to cache, then to index.html.
  if (isCode) {
    event.respondWith(
      fetch(event.request, { cache: "no-cache" })
        .then((res) => {
          if (sameOrigin || url.hostname === "www.gstatic.com") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((c) => c || caches.match("./index.html")),
        ),
    );
    return;
  }

  // Everything else (images, fonts): cache-first.
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached ||
      fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        return res;
      }),
    ),
  );
});
