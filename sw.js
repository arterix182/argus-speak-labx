const CACHE = "argus-speak-labx-v16";
const CORE = [
  "./",
  "./index.html",
  "./assets/mouth_open.png",
  "./assets/mouth_closed.png",
  "./assets/avatar_open.png",
  "./assets/avatar_blink.png",
  "./voiceRecorder.js",
  "./voicePipeline.js",
  "./avatar.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./sw.js",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("message", (e) => {
  try{
    if(e.data && (e.data.type==="SKIP_WAITING" || e.data==="SKIP_WAITING")) self.skipWaiting();
  }catch(_){ }
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if(url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/functions/")){
    e.respondWith(fetch(e.request).catch(() => new Response("offline", { status: 503 })));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    }))
  );
});
