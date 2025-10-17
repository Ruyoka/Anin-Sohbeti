const CACHE_NAME = "aninsohbeti-static-v1";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/assets/favicon.ico",
  "/assets/favicon.svg",
  "/assets/logo.png",
  "/assets/logo-trans.png",
  "/assets/web-app-manifest-192x192.png",
  "/assets/web-app-manifest-512x512.png",
  "/assets/site.webmanifest",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .catch((error) => {
        console.error("Service worker install failed", error);
      })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }
            return null;
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((networkResponse) => {
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          if (request.url.startsWith(self.location.origin)) {
            cache.put(request, responseClone);
          }
        });
        return networkResponse;
      });
    })
  );
});
