/* sw.js — Blindado contra 404 cacheados de JS/CSS
   - NO intercepta scripts/estilos (ni aunque estén en subcarpetas)
   - Network-first para navegación (HTML)
   - Cache-first para assets “seguros” (imágenes, fuentes)
*/

const CACHE_VERSION = "v18"; // <-- SÚBELO en cada cambio importante (v19, v20, etc.)
const CACHE_NAME = `app-cache-${CACHE_VERSION}`;

// Ajusta si tus iconos o manifest están en otra ruta
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
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
        .filter((k) => k.startsWith("app-cache-") && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo GET
  if (req.method !== "GET") return;

  // ✅ 1) NO tocar scripts/estilos (esto mata tu bug de raíz)
  // request.destination funciona muy bien para distinguir tipos
  const dest = req.destination; // "script", "style", "image", "font", "document", etc.
  if (
    dest === "script" ||
    dest === "style" ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.includes("/js/") // cubre subcarpetas tipo /app/js/...
  ) {
    return; // red directa, sin SW
  }

  // ✅ 2) No interceptar API
  if (url.pathname.includes("/api/")) return;

  // ✅ 3) Navegación (HTML): Network-first con fallback
  if (req.mode === "navigate" || dest === "document") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || caches.match("/index.html");
      }
    })());
    return;
  }

  // ✅ 4) Assets seguros: cache-first
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;

    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});


