// 阅读生词 v3.2.0
// 仅缓存当前 App 静态文件；绝不清理 IndexedDB 或登录数据。
const VERSION = "3.2.0";
const CACHE = `reading-words-${VERSION}`;
const ROOT = new URL("./", self.location.href);
const ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=3.2.0",
  "./sync-model.js?v=3.2.0",
  "./db.js?v=3.2.0",
  "./supabase-config.js?v=3.2.0",
  "./cloud-sync.js?v=3.2.0",
  "./app.js?v=3.2.0",
  "./manifest.json?v=3.2.0",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];
const absolute = path => new URL(path, ROOT).href;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(path => new Request(absolute(path), { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => (name.startsWith("cet6-review-") || name.startsWith("reading-words-")) && name !== CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const inScope = url.origin === ROOT.origin && url.pathname.startsWith(ROOT.pathname);
  if (!inScope) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: "no-store" });
      if (response?.ok) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, response.clone()).catch(() => {});
      }
      if (response.ok || response.status < 500) return response;
      // 临时服务器错误也回退缓存，而不是把 5xx 页面当成新 App。
      throw new Error("Server unavailable");
    } catch {
      const cache = await caches.open(CACHE);
      return await cache.match(event.request) ||
        (event.request.mode === "navigate" ? await cache.match(absolute("./index.html")) : undefined) ||
        new Response("当前离线，且资源尚未缓存。", { status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" } });
    }
  })());
});
