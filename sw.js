/* /service-worker.js
   Blindado: NO cachea ni intercepta JS/CSS para evitar 404 viejos.
*/
const CACHE_VERSION = "v17"; // <-- súbelo cada vez que publiques cambios críticos
const CACHE_NAME = `app-cache-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",               // tu shell principal
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// Instalación
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

// Activación: limpia caches anteriores
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

// Fetch: estrategia segura
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo GET
  if (req.method !== "GET") return;

  // 1) NO interceptar JS/CSS (soluciona tu bug de raíz)
  if (
    url.pathname.startsWith("/js/") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css")
  ) {
    return; // deja que el navegador pida directo a la red
  }

  // 2) No interceptar API
  if (url.pathname.startsWith("/api/")) return;

  // 3) Para navegación (HTML): Network-first con fallback a cache
  if (req.mode === "navigate") {
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

  // 4) Para assets seguros (img/fonts): Cache-first
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});

