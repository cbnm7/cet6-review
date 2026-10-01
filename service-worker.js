// CET6 Review v2.2.1 — 核心程序网络优先；固定数据缓存优先。
// 此文件仅操作 CacheStorage，从不清除 IndexedDB 或用户学习记录。
const SW_VERSION = "2.2.1";
const STATIC_CACHE = "cet6-review-v2.2.1-static-1";
const RUNTIME_CACHE = "cet6-review-v2.2.1-runtime-1";
const CLOUD_SDK_CACHE = "cet6-review-v2.2.1-supabase-sdk";
const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const NETWORK_TIMEOUT_MS = 6000;
const SCOPE_URL = new URL("./", self.location.href);

const CORE_ASSETS = [
  "./", "./index.html", "./style.css?v=2.2.1", "./scheduler.js?v=2.2.1",
  "./db.js?v=2.2.1", "./dictionary.js?v=2.2.1", "./backup.js?v=2.2.1",
  "./pwa.js?v=2.2.1", "./supabase-config.js?v=2.2.1", "./cloud-sync.js?v=2.2.1",
  "./app.js?v=2.2.1", "./manifest.json?v=2.2.1",
  "./data/concise-dictionary.js", "./data/concise-dictionary.json", "./data/cet6_2003.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

function absoluteURL(path) { return new URL(path, SCOPE_URL).href; }

async function fetchWithTimeout(request, timeoutMs = NETWORK_TIMEOUT_MS, { fresh = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal, ...(fresh ? { cache: "no-store" } : {}) });
  } finally {
    clearTimeout(timeout);
  }
}

async function putCacheSafely(name, request, response) {
  if (!response?.ok || response.type === "opaque") return;
  try {
    const cache = await caches.open(name);
    await cache.put(request, response.clone());
  } catch (error) {
    // 缓存空间不足不能使已获取成功的网络响应失效。
    console.warn("资源缓存暂未写入：", error);
  }
}

async function matchAppCache(request) {
  // 明确先找最新的运行时缓存，不能让旧预缓存遮住刚更新的文件。
  const runtime = await caches.open(RUNTIME_CACHE);
  const staticCache = await caches.open(STATIC_CACHE);
  return await runtime.match(request) || await staticCache.match(request);
}

function unavailableResponse() {
  return new Response("当前离线，且该资源尚未缓存。请联网后重新打开原 App 网址。", {
    status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" }
  });
}

async function networkFirst(request, { navigation = false } = {}) {
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS, { fresh: true });
    if (!response || !response.ok) throw new Error(`HTTP ${response?.status || 0}`);
    await putCacheSafely(RUNTIME_CACHE, request, response);
    if (navigation) {
      // 任意入口查询参数都更新同一个首页回退地址，避免离线退回旧 index。
      await putCacheSafely(RUNTIME_CACHE, absoluteURL("./index.html"), response);
      await putCacheSafely(RUNTIME_CACHE, absoluteURL("./"), response);
    }
    return response;
  } catch {
    return await matchAppCache(request) ||
      (navigation && (await matchAppCache(absoluteURL("./index.html")) ||
        await matchAppCache(absoluteURL("./")))) || unavailableResponse();
  }
}

async function cacheFirst(request, cacheName = null) {
  const cached = cacheName
    ? await (await caches.open(cacheName)).match(request)
    : await matchAppCache(request);
  if (cached) return cached;
  try {
    const response = await fetchWithTimeout(request);
    if (!response?.ok) return response || unavailableResponse();
    await putCacheSafely(cacheName || RUNTIME_CACHE, request, response);
    return response;
  } catch {
    return unavailableResponse();
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // reload 绕过 HTTP 缓存，避免把旧 JS 再次写入带新版本名的 CacheStorage。
    // 任一核心资源不可用则不激活新 Worker，保留旧版离线能力。
    await cache.addAll(CORE_ASSETS.map(path => new Request(absoluteURL(path), { cache: "reload" })));
    try {
      const response = await fetchWithTimeout(SUPABASE_SDK_URL, 4000);
      await putCacheSafely(CLOUD_SDK_CACHE, SUPABASE_SDK_URL, response);
    } catch { /* 云 SDK 是可选增强，失败不能阻止本地应用更新。 */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("cet6-review-") &&
      ![STATIC_CACHE, RUNTIME_CACHE, CLOUD_SDK_CACHE].includes(name)).map(name => caches.delete(name)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: "CET6_SW_VERSION", version: SW_VERSION });
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "CET6_GET_SW_VERSION") {
    const target = event.ports?.[0] || event.source;
    target?.postMessage({ type: "CET6_SW_VERSION", version: SW_VERSION });
  }
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const inApp = url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_URL.pathname);
  const relativePath = inApp ? url.pathname.slice(SCOPE_URL.pathname.length) : "";
  const isFixedData = inApp && (relativePath.startsWith("data/") || relativePath.startsWith("icons/"));
  const isAppNavigation = request.mode === "navigate" && inApp &&
    (relativePath === "" || relativePath === "index.html");
  const isCoreProgram = inApp && !isFixedData &&
    (isAppNavigation || /\.(js|css|html|json)$/.test(relativePath) || relativePath === "");
  if (isCoreProgram) {
    event.respondWith(networkFirst(request, { navigation: isAppNavigation }));
  } else if (isFixedData) {
    event.respondWith(cacheFirst(request));
  } else if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/@supabase/supabase-js@")) {
    event.respondWith(cacheFirst(request, CLOUD_SDK_CACHE));
  }
  // Supabase API、其它跨域请求和非 GET 不拦截、不落地缓存。
});
