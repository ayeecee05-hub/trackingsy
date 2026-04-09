// CTU Danao Borrowing System — Service Worker
const CACHE_NAME = "ctu-borrow-v1";
const STATIC_ASSETS = [
  "/index.html",
  "/style.css",
  "/script.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// Install: cache all static assets
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for static assets
self.addEventListener("fetch", e => {
  const url = e.request.url;

  // Always go network-first for Google Apps Script API calls
  if (url.includes("script.google.com")) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: "Offline — cannot reach server" }), {
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    return;
  }

  // Cache-first for everything else (static files)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});