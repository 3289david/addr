// Network-first: a wallet app must never silently serve stale code while online (a fixed bug or an
// updated contract address could matter). Cache is only a fallback for when the network is unreachable.
const CACHE = "addr-wallet-v1";
const SHELL = ["/", "/app.js", "/style.css", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});
