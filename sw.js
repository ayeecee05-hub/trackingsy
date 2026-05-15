// CTU Danao Borrowing System — Service Worker (Fixed)
const CACHE_NAME = "ctu-borrow-v3";

// Only cache files you're 100% sure exist on the server
const STATIC_ASSETS = [
  "/index.html",
  "/style.css",
  "/script.js",
  "/manifest.json",
  "/logo.svg",
  "/icon-192.svg",
  "/icon-512.svg",
  "/countdown-timer.js",
  "/countdown-styles.css",
  "/admin.html",
  "/admin.js",
  "/overrides.css"
];

// Install: cache static assets individually so one missing file doesn't break everything
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Use individual adds so a missing file doesn't abort the whole cache
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn("Could not cache:", url, err))
        )
      );
    })
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

// Fetch strategy:
// - Google Apps Script API → always network (never cache)
// - Everything else → network first, fall back to cache
self.addEventListener("fetch", e => {
  const url = e.request.url;

  // Always go to network for Google Apps Script API calls
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

  // Network-first for everything else (guarantees fresh content on load)
  e.respondWith(
    fetch(e.request)
      .then(networkResponse => {
        // Update cache with fresh response
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return networkResponse;
      })
      .catch(() => {
        // Network failed — try to serve from cache
        return caches.match(e.request).then(cached => {
          if (cached) return cached;
          // Final fallback for navigation requests
          if (e.request.mode === "navigate") {
            return caches.match("/index.html");
          }
          return new Response("Offline", { status: 503 });
        });
      })
  );
});