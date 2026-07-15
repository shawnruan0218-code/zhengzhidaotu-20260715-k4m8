const APP_NAMESPACE = "zhengzhidaotu_20260715_k4m8";
const CACHE_NAME = `${APP_NAMESPACE}-cache-v1`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(`${APP_NAMESPACE}-`) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
  const relativePath = `/${url.pathname.slice(scope.pathname.length)}`.replace(/\/+/g, "/");
  return (
    request.mode === "navigate" ||
    relativePath.startsWith("/_next/static/") ||
    relativePath.startsWith("/pages/") ||
    relativePath.startsWith("/data/ocr/") ||
    relativePath.startsWith("/connectors/")
  );
}

self.addEventListener("fetch", (event) => {
  if (!isCacheableRequest(event.request)) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      if (event.request.mode === "navigate") {
        try {
          const response = await fetch(event.request);
          if (response.ok) await cache.put(event.request, response.clone());
          return response;
        } catch {
          return (await cache.match(event.request)) ?? Response.error();
        }
      }

      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }),
  );
});
