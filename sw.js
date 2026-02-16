/* sw.js
   - NO intercepta JS/CSS
   - NO intercepta /api
   - HTML (navigate): network-first con fallback cache
   - assets: cache-first
*/
const CACHE_VERSION = "v20";
const CACHE_NAME = `app-cache-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/avatar.html",
  "/manifest.json",
  "/avatar.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith("app-cache-") && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;
  if (url.origin !== location.origin) return;

  // 1) NO interceptar JS/CSS
  if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.startsWith("/js/")) {
    return;
  }

  // 2) NO interceptar API
  if (url.pathname.startsWith("/api/")) return;

  // 3) HTML: network-first
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || caches.match("/index.html");
      }
    })());
    return;
  }

  // 4) Assets: cache-first
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});

