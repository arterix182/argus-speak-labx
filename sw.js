// ARGUS SPEAK LAB-X Service Worker
// Goal: fast + reliable without "pantalla blanca" por caché viejo.
//
// Strategy:
// - Precache core static assets (cache-first).
// - Navigation (index.html): network-first with cache fallback (so updates arrive).
// - Never cache /api/* or Netlify functions.
// - Only cache same-origin GET requests; avoid opaque cross-origin caching.
// - Clean old caches on activate.

const CACHE = "argus-speak-labx-v16";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./privacy.html",
  "./terms.html",
  "./cancel.html",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    try{
      const keys = await caches.keys();
      await Promise.all(keys.map(k => (k !== CACHE ? caches.delete(k) : Promise.resolve())));
      await self.clients.claim();
    }catch(_){}
  })());
});

function isHtmlNavigation(req){
  return req.mode === "navigate" || (req.headers.get("accept")||"").includes("text/html");
}

self.addEventListener("fetch", (e) => {
  const req = e.request;

  // Only GET can be cached safely
  if(req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache API calls
  if(url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/functions/")){
    e.respondWith(fetch(req).catch(() => new Response("offline", { status: 503 })));
    return;
  }

  // Navigation: network-first (so app updates arrive)
  if(isHtmlNavigation(req) && url.origin === self.location.origin){
    e.respondWith((async () => {
      try{
        const fresh = await fetch(req, { cache: "no-store" });
        const c = await caches.open(CACHE);
        c.put("./index.html", fresh.clone()).catch(()=>{});
        return fresh;
      }catch(_){
        const cached = await caches.match("./index.html");
        return cached || new Response("offline", { status: 503 });
      }
    })());
    return;
  }

  // Same-origin static assets: cache-first, update in background
  if(url.origin === self.location.origin){
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if(cached) {
        // Update in background
        fetch(req).then(resp => {
          if(resp && resp.ok){
            caches.open(CACHE).then(c => c.put(req, resp.clone())).catch(()=>{});
          }
        }).catch(()=>{});
        return cached;
      }
      try{
        const resp = await fetch(req);
        if(resp && resp.ok){
          const c = await caches.open(CACHE);
          c.put(req, resp.clone()).catch(()=>{});
        }
        return resp;
      }catch(_){
        return cached || new Response("offline", { status: 503 });
      }
    })());
    return;
  }

  // Cross-origin: do not cache (avoid opaque poisoning)
  e.respondWith(fetch(req));
});
