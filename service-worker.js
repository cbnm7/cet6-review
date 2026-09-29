// CET6 Review v2.1.1 - offline-first service worker
const STATIC_CACHE = "cet6-review-v2.1.1-static-1";
const RUNTIME_CACHE = "cet6-review-v2.1.1-runtime-1";
const CLOUD_SDK_CACHE = "cet6-review-v2.1.1-supabase-sdk";
const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./scheduler.js",
  "./db.js",
  "./dictionary.js",
  "./backup.js",
  "./pwa.js",
  "./supabase-config.js",
  "./cloud-sync.js",
  "./app.js",
  "./manifest.json",
  "./data/cet6_2003.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then(cache => cache.addAll(CORE_ASSETS)),
      // Supabase SDK 属于云同步增强能力。预缓存失败不能阻止 PWA 安装。
      caches.open(CLOUD_SDK_CACHE).then(async cache => {
        try {
          const response = await fetch(SUPABASE_SDK_URL, { mode: "cors" });
          if (response && response.ok) {
            await cache.put(SUPABASE_SDK_URL, response.clone());
          }
        } catch {
          // 首次完全离线时忽略；本地复习仍可正常工作。
        }
      })
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => ![STATIC_CACHE, RUNTIME_CACHE, CLOUD_SDK_CACHE].includes(key))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isSupabaseSDK = url.hostname === "cdn.jsdelivr.net" &&
    url.pathname.includes("/@supabase/supabase-js@");

  // 页面导航：优先联网，断网回退首页缓存。
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(async () => (
          await caches.match(request) ||
          await caches.match(new URL("./index.html", self.location).href) ||
          await caches.match(new URL("./", self.location).href)
        ))
    );
    return;
  }

  // 本站程序文件与核心词库：缓存优先，后台刷新。
  if (sameOrigin) {
    event.respondWith(
      caches.match(request).then(cached => {
        const networkFetch = fetch(request)
          .then(response => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
    return;
  }

  // Supabase Browser SDK：联网获取后缓存；断网时若已经缓存则继续加载。
  if (isSupabaseSDK) {
    event.respondWith(
      caches.match(request).then(cached => {
        const networkFetch = fetch(request)
          .then(response => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CLOUD_SDK_CACHE).then(cache => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
    return;
  }

  // 公开增强词典与 Supabase API 请求保持网络访问；
  // 解析后的词典和所有学习数据仍会先保存到 IndexedDB。
  event.respondWith(fetch(request));
});
