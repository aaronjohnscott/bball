// Generated at build time by vite.config.ts.
const CACHE = 'hoops-0367f6fdcd42';
const FILES = ["./","assets/index-B435MMLM.js","assets/detector.worker-Bc9K4TgZ.js","assets/index-CNOc6b8P.css","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","icons/icon.svg","manifest.webmanifest","mediapipe/wasm/vision_wasm_module_internal.js","mediapipe/wasm/vision_wasm_module_internal.wasm","models/efficientdet_lite0.tflite"];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hoops-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Network first for the page so updates show up; cache when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
