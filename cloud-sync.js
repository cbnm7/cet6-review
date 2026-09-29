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
  syncPromise: null,
  initialSyncDone: false,
  online: navigator.onLine,
  lastSyncAt: localStorage.getItem(LAST_SYNC_STORAGE_KEY) || null,
  lastError: null,
  rollbackPreventionCount: 0,
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
    initialSyncDone: state.initialSyncDone,
    online: state.online,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    rollbackPreventionCount: state.rollbackPreventionCount,
    rollbackProtection: true
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

function numericValue(record, key) {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function compareTextTimestamp(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function comparableRecord(storeName, record) {
  if (!record) return null;
  return sanitizeForCloud(storeName, record);
}

function recordsEquivalent(storeName, a, b) {
  return stableStringify(comparableRecord(storeName, a)) ===
    stableStringify(comparableRecord(storeName, b));
}

function wordProgressScore(record) {
  return [
    numericValue(record, "reviewCount"),
    numericValue(record, "knowCount") + numericValue(record, "forgotCount"),
    numericValue(record, "reinforcementCount"),
    numericValue(record, "correctionCount") + numericValue(record, "reinforcementCorrectionCount")
  ];
}

function compareScoreArrays(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = Number(a[i] || 0);
    const right = Number(b[i] || 0);
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function mergeWordProgressRecords(localRecord, remoteRecord) {
  if (!localRecord) return remoteRecord ? sanitizeForCloud("wordProgress", remoteRecord) : null;
  if (!remoteRecord) return sanitizeForCloud("wordProgress", localRecord);

  const localScore = wordProgressScore(localRecord);
  const remoteScore = wordProgressScore(remoteRecord);
  let cmp = compareScoreArrays(localScore, remoteScore);

  if (cmp === 0) {
    cmp = compareTextTimestamp(normalizeTimestamp(localRecord), normalizeTimestamp(remoteRecord));
  }

  const winner = cmp >= 0 ? localRecord : remoteRecord;
  const loser = cmp >= 0 ? remoteRecord : localRecord;
  const merged = {
    ...sanitizeForCloud("wordProgress", loser),
    ...sanitizeForCloud("wordProgress", winner)
  };

  const monotonicFields = [
    "reviewCount",
    "knowCount",
    "forgotCount",
    "reinforcementCount",
    "correctionCount",
    "reinforcementCorrectionCount"
  ];

  for (const field of monotonicFields) {
    merged[field] = Math.max(
      numericValue(localRecord, field),
      numericValue(remoteRecord, field)
    );
  }

  // 若两台设备在相同 reviewCount 上产生不同“认识/忘了”分支，
  // 合并后的累计次数也不能倒退；必要时把 reviewCount 提升到累计判断总数。
  merged.reviewCount = Math.max(
    numericValue(merged, "reviewCount"),
    numericValue(merged, "knowCount") + numericValue(merged, "forgotCount")
  );

  // 关键状态由“学习进度更高”的记录决定，而不是由更新时间较新的低进度记录决定。
  merged.streak = numericValue(winner, "streak");
  merged.lastRating = winner.lastRating ?? null;
  merged.lastReviewedAt = winner.lastReviewedAt ?? null;
  merged.nextReviewDate = winner.nextReviewDate ?? null;
  merged.lastReinforcementRating = winner.lastReinforcementRating ?? null;
  merged.lastReinforcementAt = winner.lastReinforcementAt ?? null;
  merged.lastCorrectionAt = winner.lastCorrectionAt ?? null;
  merged.updatedAt = winner.updatedAt || normalizeTimestamp(winner) || merged.updatedAt || "";
  merged.id = winner.id || loser.id;
  merged.term = winner.term || loser.term || "";
  merged.sourceOrder = winner.sourceOrder || loser.sourceOrder || 0;

  return merged;
}

function sessionPrimaryDone(record) {
  if (!record) return 0;

  const explicit = numericValue(record, "primaryCompleted");
  const counters = numericValue(record, "know") + numericValue(record, "forgot");
  const ratings = record.primaryRatings && typeof record.primaryRatings === "object"
    ? Object.keys(record.primaryRatings).length
    : 0;

  return Math.max(explicit, counters, ratings);
}

function dailySessionScore(record) {
  return [
    sessionPrimaryDone(record),
    numericValue(record, "cursor"),
    numericValue(record, "reinforcementAttempts"),
    record?.completedAt ? 1 : 0
  ];
}

function mergeDailySessionRecords(localRecord, remoteRecord) {
  if (!localRecord) return remoteRecord ? sanitizeForCloud("dailySessions", remoteRecord) : null;
  if (!remoteRecord) return sanitizeForCloud("dailySessions", localRecord);

  const localScore = dailySessionScore(localRecord);
  const remoteScore = dailySessionScore(remoteRecord);
  let cmp = compareScoreArrays(localScore, remoteScore);

  if (cmp === 0) {
    cmp = compareTextTimestamp(normalizeTimestamp(localRecord), normalizeTimestamp(remoteRecord));
  }

  const winner = cmp >= 0 ? localRecord : remoteRecord;
  const loser = cmp >= 0 ? remoteRecord : localRecord;
  const merged = {
    ...sanitizeForCloud("dailySessions", loser),
    ...sanitizeForCloud("dailySessions", winner)
  };

  // 会话的队列、游标和评分必须来自同一条更高进度记录，避免“0进度新时间戳”
  // 覆盖已经完成的学习，也避免把不同队列的游标硬拼到一起。
  merged.primaryCompleted = sessionPrimaryDone(winner);
  merged.cursor = numericValue(winner, "cursor");
  merged.know = numericValue(winner, "know");
  merged.forgot = numericValue(winner, "forgot");
  merged.reinforcementAttempts = numericValue(winner, "reinforcementAttempts");
  merged.queue = Array.isArray(winner.queue) ? winner.queue : [];
  merged.initialPrimaryCount = numericValue(winner, "initialPrimaryCount");
  merged.primaryRatings = winner.primaryRatings && typeof winner.primaryRatings === "object"
    ? { ...winner.primaryRatings }
    : {};
  merged.reinsertedIds = Array.isArray(winner.reinsertedIds) ? [...winner.reinsertedIds] : [];
  merged.planMeta = winner.planMeta && typeof winner.planMeta === "object"
    ? { ...winner.planMeta }
    : {};
  merged.completedAt = winner.completedAt || null;
  merged.updatedAt = winner.updatedAt || normalizeTimestamp(winner) || merged.updatedAt || "";
  merged.createdAt = winner.createdAt || loser.createdAt || "";
  merged.date = winner.date || loser.date;

  return merged;
}

function resolveStoreRecord(storeName, localRecord, remoteRecord) {
  if (storeName === "wordProgress") {
    return mergeWordProgressRecords(localRecord, remoteRecord);
  }

  if (storeName === "dailySessions") {
    return mergeDailySessionRecords(localRecord, remoteRecord);
  }

  // 阅读生词仍按最后更新时间处理，因为它是可编辑文本，不是单调递增的学习进度。
  if (!localRecord) return remoteRecord ? sanitizeForCloud(storeName, remoteRecord) : null;
  if (!remoteRecord) return sanitizeForCloud(storeName, localRecord);
  return localIsNewer(localRecord, remoteRecord)
    ? sanitizeForCloud(storeName, localRecord)
    : sanitizeForCloud(storeName, remoteRecord);
}

function detectRollbackPrevented(storeName, localRecord, remoteRecord, mergedRecord) {
  if (!localRecord || !remoteRecord || !mergedRecord) return false;

  if (storeName === "dailySessions") {
    const newerByTime = compareTextTimestamp(
      normalizeTimestamp(localRecord),
      normalizeTimestamp(remoteRecord)
    );
    const progressCmp = compareScoreArrays(
      dailySessionScore(localRecord),
      dailySessionScore(remoteRecord)
    );

    return newerByTime !== 0 && progressCmp !== 0 && Math.sign(newerByTime) !== Math.sign(progressCmp);
  }

  if (storeName === "wordProgress") {
    const newerByTime = compareTextTimestamp(
      normalizeTimestamp(localRecord),
      normalizeTimestamp(remoteRecord)
    );
    const progressCmp = compareScoreArrays(
      wordProgressScore(localRecord),
      wordProgressScore(remoteRecord)
    );

    return newerByTime !== 0 && progressCmp !== 0 && Math.sign(newerByTime) !== Math.sign(progressCmp);
  }

  return false;
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

async function getLatestLocalRecord(storeName, record) {
  if (!record) return null;

  if (storeName === "wordProgress") {
    return window.getWordProgress?.(record.id) || record;
  }

  if (storeName === "dailySessions") {
    return window.getDailySession?.(record.date) || record;
  }

  if (storeName === "readingWords") {
    const normalized = String(record.normalizedTerm || record.term || "").trim().toLowerCase();
    return window.findReadingWordByNormalizedTerm?.(normalized) || record;
  }

  return record;
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

  if (!checkRemote) {
    await upsertRows([buildRow(storeName, record)]);
    return { uploaded: 1, downloaded: 0 };
  }

  const remote = await getOneRemoteRecord(storeName, key);

  if (storeName === "readingWords" && remote?.deleted) {
    if (!localIsNewer(record, remote)) {
      await window.deleteReadingWordFromCloud(
        String(remote.normalizedTerm || decodeReadingDocId(key) || "").toLowerCase()
      );
      emitDataUpdated();
      return { uploaded: 0, downloaded: 1 };
    }

    await upsertRows([buildRow(storeName, record)]);
    return { uploaded: 1, downloaded: 0 };
  }

  if (!remote) {
    await upsertRows([buildRow(storeName, record)]);
    return { uploaded: 1, downloaded: 0 };
  }

  const merged = resolveStoreRecord(storeName, record, remote);

  if (detectRollbackPrevented(storeName, record, remote, merged)) {
    state.rollbackPreventionCount++;
  }

  const localMatches = recordsEquivalent(storeName, record, merged);
  const remoteMatches = recordsEquivalent(storeName, remote, merged);

  let uploaded = 0;
  let downloaded = 0;

  if (!localMatches) {
    await window.upsertRecordFromCloud(storeName, merged);
    downloaded++;
    emitDataUpdated();
  }

  if (!remoteMatches) {
    await upsertRows([buildRow(storeName, merged)]);
    uploaded++;
  }

  return { uploaded, downloaded };
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

    const merged = resolveStoreRecord(storeName, local, remote);

    if (detectRollbackPrevented(storeName, local, remote, merged)) {
      state.rollbackPreventionCount++;
    }

    const localMatches = recordsEquivalent(storeName, local, merged);
    const remoteMatches = recordsEquivalent(storeName, remote, merged);

    if (!localMatches) {
      await window.upsertRecordFromCloud(storeName, merged);
      downloaded++;
    }

    if (!remoteMatches) {
      rowsToUpload.push(buildRow(storeName, merged));
    }
  }

  await upsertRows(rowsToUpload);
  return { uploaded: rowsToUpload.length, downloaded };
}

async function syncNow({ reason = "manual" } = {}) {
  if (!state.configured) throw new Error("Supabase 尚未配置");
  if (!state.signedIn) throw new Error("请先登录 Supabase 账号");
  if (!state.online) throw new Error("当前处于离线状态，本地复习仍可继续");

  // v2.1.2：多个登录/聚焦/定时事件同时触发时，全部等待同一个同步 Promise，
  // 不再让后来的调用直接拿到 null。
  if (state.syncPromise) {
    return state.syncPromise;
  }

  state.syncing = true;
  state.lastError = null;
  emitStatus();

  state.syncPromise = (async () => {
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
      state.initialSyncDone = true;
      localStorage.setItem(LAST_SYNC_STORAGE_KEY, state.lastSyncAt);
      state.lastError = null;
      emitDataUpdated();

      return {
        reason,
        uploaded: wordResult.uploaded + sessionResult.uploaded + readingResult.uploaded,
        downloaded: wordResult.downloaded + sessionResult.downloaded + readingResult.downloaded,
        rollbackPreventionCount: state.rollbackPreventionCount
      };
    } catch (error) {
      state.lastError = error?.message || String(error);
      console.error("Supabase 同步失败：", error);
      throw error;
    } finally {
      state.syncing = false;
      state.syncPromise = null;
      emitStatus();
    }
  })();

  return state.syncPromise;
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
    // 首次登录同步未完成时，不直接把刚创建的本地空会话推上云端。
    // 先完成一次双向合并，再读取“合并后的最新本地记录”上传。
    if (!state.initialSyncDone) {
      await syncNow({ reason: "before-local-push" });
    }

    if (detail.operation === "delete-reading") {
      await pushReadingDeletion(detail.normalizedTerm);
      return;
    }

    if (detail.storeName && detail.record) {
      const latest = await getLatestLocalRecord(detail.storeName, detail.record);
      if (latest) {
        await pushRecord(detail.storeName, latest, { checkRemote: true });
      }
    }
  } catch (error) {
    // IndexedDB 已先保存成功；云端失败不会影响本地学习。
    // 恢复联网、窗口重新获得焦点或手动同步时会补齐。
    state.lastError = error?.message || String(error);
    emitStatus();
  }
}

async function ensureInitialSync() {
  if (!state.signedIn || !state.online || state.initialSyncDone) {
    return true;
  }

  await syncNow({ reason: "initial-guard" });
  return state.initialSyncDone;
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
      const previousUserId = state.user?.id || "";
      const nextUser = session?.user || null;
      const nextUserId = nextUser?.id || "";

      // 切换账号/重新登录时必须重新做一次完整双向合并。
      // 退出账号不会清本机 IndexedDB。
      if (previousUserId !== nextUserId) {
        state.initialSyncDone = false;
      }

      state.user = nextUser;
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
        state.initialSyncDone = false;
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
  syncNow,
  ensureInitialSync
};

initCloud();
