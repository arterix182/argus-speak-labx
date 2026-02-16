/* sw.js
   ✅ NO cachea: avatar.html + voiceRecorder.js + voicePipeline.js
   ✅ Cachea assets estáticos (imágenes/mp4/css/etc)
*/

const CACHE_NAME = "argus-beta-static-v7";

// Archivos que JAMÁS deben cachearse (para evitar bugs eternos)
const NO_CACHE_PATHS = new Set([
  "/avatar.html",
  "/js/voiceRecorder.js",
  "/js/voicePipeline.js",
]);

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

// Estrategia:
// - NO_CACHE_PATHS => network only (no-store)
// - HTML/JS => network-first
// - assets => cache-first
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo mismo origen
  if (url.origin !== location.origin) return;

  // Nunca cachear críticos
  if (NO_CACHE_PATHS.has(url.pathname)) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  const isHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  const isJS = url.pathname.endsWith(".js");
  const isAsset =
    url.pathname.includes("/assets/") ||
    url.pathname.endsWith(".mp4") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".jpeg") ||
    url.pathname.endsWith(".webp") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".css");

  // HTML/JS: network-first
  if (isHTML || isJS) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        // cache opcional para js (pero no los críticos)
        const c = await caches.open(CACHE_NAME);
        c.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Assets: cache-first
  if (isAsset) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      const c = await caches.open(CACHE_NAME);
      c.put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  // Default: network-first light
  event.respondWith((async () => {
    try { return await fetch(req); }
    catch { return (await caches.match(req)) || new Response("Offline", { status: 503 }); }
  })());
});
