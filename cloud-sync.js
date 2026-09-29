// =======================================
// CET6 Review v2.1 - Supabase 多设备云同步
// 本地 IndexedDB 为离线主数据层；Supabase 负责账号与跨设备同步。
// =======================================

const CONFIG_STORAGE_KEY = "cet6-supabase-config-v1";
const LAST_SYNC_STORAGE_KEY = "cet6-cloud-last-sync";
const REMOTE_TABLE = "cet6_sync_records";
const AUTO_SYNC_INTERVAL_MS = 45 * 1000;
const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

function loadSupabaseSDK() {
  if (window.supabase?.createClient) return Promise.resolve(window.supabase);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-cet6-supabase-sdk="1"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.supabase), { once: true });
      existing.addEventListener("error", () => reject(new Error("Supabase SDK 加载失败")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = SUPABASE_SDK_URL;
    script.async = true;
    script.dataset.cet6SupabaseSdk = "1";
    script.onload = () => {
      if (window.supabase?.createClient) resolve(window.supabase);
      else reject(new Error("Supabase SDK 已下载但未正确初始化"));
    };
    script.onerror = () => reject(new Error("Supabase SDK 加载失败。首次配置/同步需要联网；离线复习不受影响。"));
    document.head.appendChild(script);
  });
}

const SUPPORTED_STORES = [
  "wordProgress",
  "dailySessions",
  "readingWords"
];

const state = {
  configured: false,
  ready: false,
  signedIn: false,
  user: null,
  client: null,
  syncing: false,
  online: navigator.onLine,
  lastSyncAt: localStorage.getItem(LAST_SYNC_STORAGE_KEY) || null,
  lastError: null,
  autoTimer: null,
  authSubscription: null
};

function emitStatus() {
  window.dispatchEvent(new CustomEvent("cet6-cloud-status", {
    detail: getStatus()
  }));
}

function emitDataUpdated() {
  window.dispatchEvent(new CustomEvent("cet6-cloud-data-updated", {
    detail: { at: new Date().toISOString() }
  }));
}

function cleanConfig(input) {
  if (!input || typeof input !== "object") return null;

  const config = {
    url: String(input.url || "").trim().replace(/\/+$/, ""),
    publishableKey: String(input.publishableKey || input.anonKey || "").trim()
  };

  if (!/^https:\/\/.+\.supabase\.(co|in)$/.test(config.url) && !/^https:\/\//.test(config.url)) {
    return null;
  }

  if (!config.publishableKey) return null;
  return config;
}

function loadConfig() {
  try {
    const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (saved) {
      const parsed = cleanConfig(JSON.parse(saved));
      if (parsed) return parsed;
    }
  } catch (error) {
    console.warn("读取 Supabase 配置失败：", error);
  }

  return cleanConfig(window.CET6_SUPABASE_CONFIG);
}

function saveConfig(config) {
  const cleaned = cleanConfig(config);
  if (!cleaned) {
    throw new Error("Supabase 配置不完整：需要 Project URL 和 Publishable key / anon key");
  }

  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cleaned));
  location.reload();
}

function clearConfig() {
  localStorage.removeItem(CONFIG_STORAGE_KEY);
  location.reload();
}

function getStatus() {
  return {
    provider: "Supabase",
    configured: state.configured,
    ready: state.ready,
    signedIn: state.signedIn,
    email: state.user?.email || "",
    uid: state.user?.id || "",
    syncing: state.syncing,
    online: state.online,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError
  };
}

function normalizeTimestamp(record) {
  if (!record || typeof record !== "object") return "";
  return String(
    record.updatedAt ||
    record.lastReviewedAt ||
    record.lastCorrectionAt ||
    record.lastReinforcementAt ||
    record.createdAt ||
    ""
  );
}

function localIsNewer(localRecord, remoteRecord) {
  if (!localRecord) return false;
  if (!remoteRecord) return true;

  const localTime = normalizeTimestamp(localRecord);
  const remoteTime = normalizeTimestamp(remoteRecord);

  if (!localTime && !remoteTime) return false;
  if (!remoteTime) return true;
  if (!localTime) return false;
  return localTime > remoteTime;
}

function readingDocId(normalizedTerm) {
  const text = String(normalizedTerm || "").trim().toLowerCase();
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeReadingDocId(id) {
  try {
    let base64 = String(id || "").replaceAll("-", "+").replaceAll("_", "/");
    while (base64.length % 4) base64 += "=";
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function remoteDocId(storeName, record) {
  if (storeName === "wordProgress") return String(record.id);
  if (storeName === "dailySessions") return String(record.date);
  if (storeName === "readingWords") return readingDocId(record.normalizedTerm || record.term);
  throw new Error(`不支持的同步存储：${storeName}`);
}

function sanitizeForCloud(storeName, record) {
  const copy = JSON.parse(JSON.stringify(record || {}));

  if (storeName === "readingWords") {
    delete copy.id;
    copy.normalizedTerm = String(copy.normalizedTerm || copy.term || "").trim().toLowerCase();
  }

  delete copy.remoteId;
  delete copy.cloudUpdatedAt;
  delete copy.deleted;
  return copy;
}

function requireSignedIn() {
  if (!state.client || !state.signedIn || !state.user) {
    throw new Error("请先登录 Supabase 账号");
  }
}

function waitForLocalDB(timeoutMs = 10000) {
  if (window.CET6_LOCAL_DB_READY) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer = null;

    const onReady = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("cet6-local-db-ready", onReady);
      resolve();
    };

    window.addEventListener("cet6-local-db-ready", onReady);
    timer = setTimeout(() => {
      window.removeEventListener("cet6-local-db-ready", onReady);
      reject(new Error("本地 IndexedDB 尚未准备完成"));
    }, timeoutMs);
  });
}

function toRemoteRecord(row) {
  const payload = row?.payload && typeof row.payload === "object"
    ? JSON.parse(JSON.stringify(row.payload))
    : {};

  return {
    remoteId: row?.record_key || "",
    ...payload,
    deleted: Boolean(row?.deleted),
    cloudUpdatedAt: row?.updated_at || row?.source_updated_at || ""
  };
}

function buildRow(storeName, record, { deleted = false } = {}) {
  requireSignedIn();

  const payload = sanitizeForCloud(storeName, record);
  const sourceUpdatedAt = normalizeTimestamp(payload) || new Date().toISOString();

  return {
    user_id: state.user.id,
    store_name: storeName,
    record_key: remoteDocId(storeName, record),
    payload,
    deleted,
    source_updated_at: sourceUpdatedAt,
    updated_at: new Date().toISOString()
  };
}

async function getLocalSnapshot() {
  const [wordProgress, dailySessions, readingWords] = await Promise.all([
    window.getAllWordProgress(),
    window.getAllDailySessions(),
    window.getAllReadingWords()
  ]);

  return { wordProgress, dailySessions, readingWords };
}

async function getRemoteSnapshot(storeName) {
  requireSignedIn();

  const { data, error } = await state.client
    .from(REMOTE_TABLE)
    .select("record_key,payload,deleted,source_updated_at,updated_at")
    .eq("user_id", state.user.id)
    .eq("store_name", storeName);

  if (error) throw error;
  return (data || []).map(toRemoteRecord);
}

async function getOneRemoteRecord(storeName, recordKey) {
  requireSignedIn();

  const { data, error } = await state.client
    .from(REMOTE_TABLE)
    .select("record_key,payload,deleted,source_updated_at,updated_at")
    .eq("user_id", state.user.id)
    .eq("store_name", storeName)
    .eq("record_key", recordKey)
    .maybeSingle();

  if (error) throw error;
  return data ? toRemoteRecord(data) : null;
}

async function upsertRows(rows) {
  if (!rows.length) return;

  const chunkSize = 250;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await state.client
      .from(REMOTE_TABLE)
      .upsert(chunk, { onConflict: "user_id,store_name,record_key" });

    if (error) throw error;
  }
}

async function pushRecord(storeName, record, { checkRemote = true } = {}) {
  if (!state.signedIn || !record) return { uploaded: 0, downloaded: 0 };

  const key = remoteDocId(storeName, record);

  if (checkRemote) {
    const remote = await getOneRemoteRecord(storeName, key);

    if (remote) {
      if (storeName === "readingWords" && remote.deleted) {
        if (!localIsNewer(record, remote)) {
          await window.deleteReadingWordFromCloud(
            String(remote.normalizedTerm || decodeReadingDocId(key) || "").toLowerCase()
          );
          emitDataUpdated();
          return { uploaded: 0, downloaded: 1 };
        }
      } else if (normalizeTimestamp(remote) > normalizeTimestamp(record)) {
        await window.upsertRecordFromCloud(storeName, remote);
        emitDataUpdated();
        return { uploaded: 0, downloaded: 1 };
      }
    }
  }

  await upsertRows([buildRow(storeName, record)]);
  return { uploaded: 1, downloaded: 0 };
}

async function pushReadingDeletion(normalizedTerm) {
  if (!state.signedIn) return;

  const clean = String(normalizedTerm || "").trim().toLowerCase();
  if (!clean) return;

  const now = new Date().toISOString();
  const tombstone = {
    normalizedTerm: clean,
    updatedAt: now
  };

  await upsertRows([
    buildRow("readingWords", tombstone, { deleted: true })
  ]);
}

function mapLocalByKey(storeName, items) {
  const map = new Map();
  for (const item of items || []) {
    if (storeName === "wordProgress") map.set(String(item.id), item);
    if (storeName === "dailySessions") map.set(String(item.date), item);
    if (storeName === "readingWords") {
      map.set(String(item.normalizedTerm || item.term || "").trim().toLowerCase(), item);
    }
  }
  return map;
}

function mapRemoteByKey(storeName, items) {
  const map = new Map();
  for (const item of items || []) {
    if (storeName === "wordProgress") map.set(String(item.id || item.remoteId), item);
    if (storeName === "dailySessions") map.set(String(item.date || item.remoteId), item);
    if (storeName === "readingWords") {
      const key = String(
        item.normalizedTerm || decodeReadingDocId(item.remoteId) || ""
      ).trim().toLowerCase();
      if (key) map.set(key, item);
    }
  }
  return map;
}

async function mergeStore(storeName, localItems, remoteItems) {
  const localMap = mapLocalByKey(storeName, localItems);
  const remoteMap = mapRemoteByKey(storeName, remoteItems);
  const keys = new Set([...localMap.keys(), ...remoteMap.keys()]);

  const rowsToUpload = [];
  let downloaded = 0;

  for (const key of keys) {
    const local = localMap.get(key) || null;
    const remote = remoteMap.get(key) || null;

    if (storeName === "readingWords" && remote?.deleted) {
      if (!local || !localIsNewer(local, remote)) {
        await window.deleteReadingWordFromCloud(key);
        downloaded++;
      } else {
        rowsToUpload.push(buildRow(storeName, local));
      }
      continue;
    }

    if (!remote && local) {
      rowsToUpload.push(buildRow(storeName, local));
      continue;
    }

    if (remote && !local) {
      await window.upsertRecordFromCloud(storeName, remote);
      downloaded++;
      continue;
    }

    if (localIsNewer(local, remote)) {
      rowsToUpload.push(buildRow(storeName, local));
    } else if (normalizeTimestamp(remote) > normalizeTimestamp(local)) {
      await window.upsertRecordFromCloud(storeName, remote);
      downloaded++;
    }
  }

  await upsertRows(rowsToUpload);
  return { uploaded: rowsToUpload.length, downloaded };
}

async function syncNow({ reason = "manual" } = {}) {
  if (!state.configured) throw new Error("Supabase 尚未配置");
  if (!state.signedIn) throw new Error("请先登录 Supabase 账号");
  if (!state.online) throw new Error("当前处于离线状态，本地复习仍可继续");
  if (state.syncing) return null;

  state.syncing = true;
  state.lastError = null;
  emitStatus();

  try {
    await waitForLocalDB();
    const local = await getLocalSnapshot();

    const [remoteWords, remoteSessions, remoteReading] = await Promise.all([
      getRemoteSnapshot("wordProgress"),
      getRemoteSnapshot("dailySessions"),
      getRemoteSnapshot("readingWords")
    ]);

    const wordResult = await mergeStore("wordProgress", local.wordProgress, remoteWords);
    const sessionResult = await mergeStore("dailySessions", local.dailySessions, remoteSessions);
    const readingResult = await mergeStore("readingWords", local.readingWords, remoteReading);

    state.lastSyncAt = new Date().toISOString();
    localStorage.setItem(LAST_SYNC_STORAGE_KEY, state.lastSyncAt);
    state.lastError = null;
    emitDataUpdated();

    return {
      reason,
      uploaded: wordResult.uploaded + sessionResult.uploaded + readingResult.uploaded,
      downloaded: wordResult.downloaded + sessionResult.downloaded + readingResult.downloaded
    };
  } catch (error) {
    state.lastError = error?.message || String(error);
    console.error("Supabase 同步失败：", error);
    throw error;
  } finally {
    state.syncing = false;
    emitStatus();
  }
}

async function createAccount(email, password) {
  if (!state.client) throw new Error("Supabase 尚未初始化");

  const { data, error } = await state.client.auth.signUp({
    email,
    password
  });

  if (error) throw error;

  return {
    user: data?.user || null,
    session: data?.session || null,
    requiresEmailConfirmation: Boolean(data?.user && !data?.session)
  };
}

async function login(email, password) {
  if (!state.client) throw new Error("Supabase 尚未初始化");

  const { data, error } = await state.client.auth.signInWithPassword({
    email,
    password
  });

  if (error) throw error;
  return data?.user || null;
}

async function logout() {
  if (!state.client) return;
  const { error } = await state.client.auth.signOut();
  if (error) throw error;
}

async function handleLocalChange(event) {
  if (!state.signedIn || !state.online) return;
  const detail = event.detail || {};

  try {
    if (detail.operation === "delete-reading") {
      await pushReadingDeletion(detail.normalizedTerm);
      return;
    }

    if (detail.storeName && detail.record) {
      await pushRecord(detail.storeName, detail.record, { checkRemote: true });
    }
  } catch (error) {
    // IndexedDB 已先保存成功；云端失败不会影响本地学习。
    // 恢复联网、窗口重新获得焦点或手动同步时会补齐。
    state.lastError = error?.message || String(error);
    emitStatus();
  }
}

function startAutoSync() {
  stopAutoSync();
  state.autoTimer = setInterval(() => {
    if (state.signedIn && state.online && !state.syncing) {
      syncNow({ reason: "timer" }).catch(() => {});
    }
  }, AUTO_SYNC_INTERVAL_MS);
}

function stopAutoSync() {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
}

async function refreshAuthState() {
  if (!state.client) return;

  const { data, error } = await state.client.auth.getSession();
  if (error) throw error;

  state.user = data?.session?.user || null;
  state.signedIn = Boolean(state.user);
}

async function initCloud() {
  const config = loadConfig();

  if (!config) {
    state.configured = false;
    state.ready = true;
    emitStatus();
    window.dispatchEvent(new CustomEvent("cet6-cloud-ready"));
    return;
  }

  state.configured = true;

  try {
    await loadSupabaseSDK();

    state.client = window.supabase.createClient(
      config.url,
      config.publishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      }
    );

    const { data: subscriptionData } = state.client.auth.onAuthStateChange((event, session) => {
      state.user = session?.user || null;
      state.signedIn = Boolean(state.user);
      state.ready = true;
      state.lastError = null;
      emitStatus();

      if (state.signedIn) {
        startAutoSync();
        // 避免在 auth 回调中阻塞 Supabase 内部锁，延后触发同步。
        setTimeout(() => {
          syncNow({ reason: `auth-${event || "change"}` }).catch(error => {
            console.warn("登录后同步失败：", error);
          });
        }, 0);
      } else {
        stopAutoSync();
      }

      window.dispatchEvent(new CustomEvent("cet6-cloud-ready"));
    });

    state.authSubscription = subscriptionData?.subscription || null;
    await refreshAuthState();
    state.ready = true;
    emitStatus();
    window.dispatchEvent(new CustomEvent("cet6-cloud-ready"));

    if (state.signedIn) {
      startAutoSync();
      syncNow({ reason: "startup" }).catch(() => {});
    }
  } catch (error) {
    state.ready = true;
    state.lastError = error?.message || String(error);
    console.error("Supabase 初始化失败：", error);
    emitStatus();
    window.dispatchEvent(new CustomEvent("cet6-cloud-ready"));
  }
}

window.addEventListener("online", () => {
  state.online = true;
  emitStatus();
  if (state.signedIn) {
    syncNow({ reason: "online" }).catch(() => {});
  }
});

window.addEventListener("offline", () => {
  state.online = false;
  emitStatus();
});

window.addEventListener("focus", () => {
  if (state.signedIn && state.online) {
    syncNow({ reason: "focus" }).catch(() => {});
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.signedIn && state.online) {
    syncNow({ reason: "visible" }).catch(() => {});
  }
});

window.addEventListener("cet6-local-change", event => {
  handleLocalChange(event).catch(() => {});
});

window.addEventListener("cet6-local-bulk-change", () => {
  if (state.signedIn && state.online) {
    syncNow({ reason: "bulk-local-change" }).catch(() => {});
  }
});

window.CET6Cloud = {
  getStatus,
  saveConfig,
  clearConfig,
  createAccount,
  login,
  logout,
  syncNow
};

initCloud();
