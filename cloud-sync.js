// 阅读生词 v3.2.0 — 字段级双向同步、显式清空、删除优先与乐观并发控制。
// 沿用原 Supabase 表/账号/RLS。JSON payload 中增加字段版本，不需要重建云端表。
const RW_REMOTE_TABLE = "cet6_sync_records";
const RW_REMOTE_STORE = "readingWords";
const RW_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const RW_LAST_SYNC_KEY = "reading-words-last-sync-v1";
const RW_AUTO_SYNC_MS = 60 * 1000;
const RW_REMOTE_COLUMNS = "record_key,payload,deleted,source_updated_at,updated_at";
const RWSyncModel = globalThis.ReadingWordsModel;
const rwCloudState = {
  ready: false, configured: false, client: null, user: null, signedIn: false,
  syncing: false, online: navigator.onLine, lastSyncAt: null, lastError: null,
  syncPromise: null, timer: null, authSubscription: null, syncRequested: false, initPromise: null
};
try { rwCloudState.lastSyncAt = localStorage.getItem(RW_LAST_SYNC_KEY) || null; } catch {}
function rwGetStatus() {
  return {
    ready: rwCloudState.ready, configured: rwCloudState.configured, signedIn: rwCloudState.signedIn,
    email: rwCloudState.user?.email || "", syncing: rwCloudState.syncing, online: rwCloudState.online,
    lastSyncAt: rwCloudState.lastSyncAt, lastError: rwCloudState.lastError
  };
}
function rwEmitStatus() {
  window.dispatchEvent(new CustomEvent("reading-words-cloud-status", { detail: rwGetStatus() }));
}
function rwEmitDataUpdated(changed) {
  window.dispatchEvent(new CustomEvent("reading-words-cloud-data-updated"));
  if (changed) readingChannel?.postMessage({ operation: "cloud-applied" });
}
function rwReadingDocId(term) {
  const bytes = new TextEncoder().encode(RWSyncModel.normalize(term));
  let binary = "";
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function rwDecodeDocId(id) {
  try {
    let base64 = String(id || "").replaceAll("-", "+").replaceAll("_", "/");
    while (base64.length % 4) base64 += "=";
    return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
  } catch { return ""; }
}
function rwAssertUser(userId) {
  if (!rwCloudState.client || !rwCloudState.signedIn || rwCloudState.user?.id !== userId) {
    throw new Error("账号已变化，本轮同步已停止；本地数据未清空");
  }
}
function rwRemoteToState(row) {
  if (!row) return null;
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const key = RWSyncModel.normalize(payload.normalizedTerm || rwDecodeDocId(row.record_key));
  if (!key || rwReadingDocId(key) !== row.record_key) throw new Error("云端存在无效词条键，已停止同步以保护数据");
  const at = row.source_updated_at || payload.updatedAt || row.updated_at;
  return row.deleted
    ? RWSyncModel.deletedState({ normalizedTerm: key, deletedAt: payload.deletedAt || at })
    : RWSyncModel.wordState({ ...payload, normalizedTerm: key, updatedAt: payload.updatedAt || at });
}
async function rwFetchRemoteSnapshot(userId) {
  rwAssertUser(userId);
  const map = new Map();
  let after = null;
  // 按唯一键分页，避免只取到 Supabase 默认的前 1000 条。
  while (true) {
    let query = rwCloudState.client.from(RW_REMOTE_TABLE).select(RW_REMOTE_COLUMNS)
      .eq("user_id", userId).eq("store_name", RW_REMOTE_STORE).order("record_key", { ascending: true }).limit(500);
    if (after !== null) query = query.gt("record_key", after);
    const { data, error } = await query;
    rwAssertUser(userId);
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) map.set(rwRemoteToState(row).key, row);
    if (rows.length < 500) break;
    after = rows[rows.length - 1].record_key;
  }
  return map;
}
async function rwFetchRemoteWord(key, userId) {
  rwAssertUser(userId);
  const { data, error } = await rwCloudState.client.from(RW_REMOTE_TABLE).select(RW_REMOTE_COLUMNS)
    .eq("user_id", userId).eq("store_name", RW_REMOTE_STORE).eq("record_key", rwReadingDocId(key)).maybeSingle();
  rwAssertUser(userId);
  if (error) throw error;
  return data || null;
}
function rwBuildRow(state, userId, previousRow) {
  const payload = state.kind === "word" ? { ...state.word } : { ...state.tombstone };
  // 每次写入新的不可重复令牌；即使两台设备时钟相同，也不会把并发更改当成同一版本。
  payload.syncToken = crypto.randomUUID();
  return {
    user_id: userId, store_name: RW_REMOTE_STORE, record_key: rwReadingDocId(state.key),
    payload, deleted: state.kind === "deleted",
    source_updated_at: state.kind === "word" ? state.word.updatedAt : state.tombstone.deletedAt,
    updated_at: RWSyncModel.nextTime({ updatedAt: previousRow?.updated_at })
  };
}
async function rwCompareAndWrite(state, previous, userId) {
  rwAssertUser(userId);
  const row = rwBuildRow(state, userId, previous);
  let response;
  if (!previous) {
    response = await rwCloudState.client.from(RW_REMOTE_TABLE).insert(row).select(RW_REMOTE_COLUMNS);
    // 并发另一设备先插入了相同词，重新读取并合并，而不是盲目 upsert。
    if (response.error?.code === "23505") return null;
  } else {
    let query = rwCloudState.client.from(RW_REMOTE_TABLE).update(row)
      .eq("user_id", userId).eq("store_name", RW_REMOTE_STORE).eq("record_key", row.record_key)
      .eq("updated_at", previous.updated_at);
    query = previous.payload?.syncToken
      ? query.eq("payload->>syncToken", previous.payload.syncToken)
      : query.is("payload->>syncToken", null);
    response = await query.select(RW_REMOTE_COLUMNS);
  }
  rwAssertUser(userId);
  if (response.error) throw response.error;
  return response.data?.[0] || null; // 0 行 = 读取后已有并发写入；调用者应重新读取。
}
async function rwSyncOneKey(key, remoteRow, userId, totals) {
  for (let attempt = 0; attempt < 8; attempt++) {
    rwAssertUser(userId);
    const local = await getReadingState(key);
    rwAssertUser(userId);
    const remote = rwRemoteToState(remoteRow);
    const merged = RWSyncModel.mergeStates(local, remote);
    if (!merged) return;
    if (!RWSyncModel.equalStates(merged, remote)) {
      const written = await rwCompareAndWrite(merged, remoteRow, userId);
      if (!written) {
        remoteRow = await rwFetchRemoteWord(key, userId);
        continue;
      }
      remoteRow = written;
      totals.uploaded++;
    }
    rwAssertUser(userId);
    const confirmed = rwRemoteToState(remoteRow);
    // 再次在本地事务内读取当前值；同步期间发生的编辑/删除不能被旧快照覆盖。
    const current = await applyReadingStateFromCloud(confirmed);
    if (!RWSyncModel.equalStates(local, current)) {
      if (current.kind === "deleted") totals.deleted++;
      else totals.downloaded++;
    }
    if (RWSyncModel.equalStates(current, confirmed)) return;
    // 本地用户在上传途中又修改了内容；本轮继续上传新版本。
  }
  throw new Error("词条正在被其他设备频繁修改，本地更改已保留，请稍后再同步");
}
async function rwSyncPass(userId, totals) {
  const [local, remoteMap] = await Promise.all([getReadingSyncSnapshot(), rwFetchRemoteSnapshot(userId)]);
  rwAssertUser(userId);
  const keys = new Set([
    ...local.words.map(w => RWSyncModel.normalize(w.normalizedTerm || w.term)),
    ...local.tombstones.map(t => t.normalizedTerm), ...remoteMap.keys()
  ]);
  for (const key of keys) if (key) await rwSyncOneKey(key, remoteMap.get(key) || null, userId, totals);
}
async function rwSyncNow({ reason = "manual" } = {}) {
  if (!rwCloudState.configured || !rwCloudState.client) throw new Error("云同步尚未连接，请检查网络后重试");
  if (!rwCloudState.signedIn) throw new Error("请先登录账号");
  if (!rwCloudState.online) throw new Error("当前离线，本地修改已保存，联网后继续同步");
  if (rwCloudState.syncPromise) { rwCloudState.syncRequested = true; return rwCloudState.syncPromise; }
  const userId = rwCloudState.user.id;
  rwCloudState.syncing = true;
  rwCloudState.lastError = null;
  rwEmitStatus();
  rwCloudState.syncPromise = (async () => {
    const totals = { reason, uploaded: 0, downloaded: 0, deleted: 0 };
    try {
      await openReadingDB();
      let passes = 0;
      do {
        rwCloudState.syncRequested = false;
        await rwSyncPass(userId, totals);
      } while (rwCloudState.syncRequested && ++passes < 3);
      rwAssertUser(userId);
      rwCloudState.lastSyncAt = new Date().toISOString();
      try { localStorage.setItem(RW_LAST_SYNC_KEY, rwCloudState.lastSyncAt); } catch {}
      rwCloudState.lastError = null;
      rwEmitDataUpdated(totals.downloaded || totals.deleted);
      return totals;
    } catch (error) {
      rwCloudState.lastError = error?.message || String(error);
      // 前面成功下载的项也立即可见，失败的本地修改仍留在 IndexedDB，下一次重新合并。
      rwEmitDataUpdated(totals.downloaded || totals.deleted);
      throw error;
    } finally {
      rwCloudState.syncing = false;
      rwCloudState.syncPromise = null;
      rwEmitStatus();
      if (rwCloudState.syncRequested && rwCloudState.signedIn && rwCloudState.online) rwScheduleSync();
    }
  })();
  return rwCloudState.syncPromise;
}
let rwLocalSyncDebounce = null;
function rwScheduleSync() {
  if (!rwCloudState.signedIn || !rwCloudState.online) return;
  if (rwCloudState.syncing) { rwCloudState.syncRequested = true; return; }
  clearTimeout(rwLocalSyncDebounce);
  rwLocalSyncDebounce = setTimeout(() => rwSyncNow({ reason: "local-change" }).catch(() => {}), 350);
}
function rwLoadSDK() {
  if (window.supabase?.createClient) return Promise.resolve(window.supabase);
  return new Promise((resolve, reject) => {
    document.querySelector('script[data-reading-words-supabase="1"]')?.remove();
    const script = document.createElement("script");
    script.src = RW_SDK_URL;
    script.async = true;
    script.dataset.readingWordsSupabase = "1";
    const fail = () => { script.remove(); reject(new Error("云同步连接失败，本地保存/编辑仍可使用；联网后重试")); };
    const timer = setTimeout(fail, 15000);
    script.onload = () => { clearTimeout(timer); window.supabase?.createClient ? resolve(window.supabase) : fail(); };
    script.onerror = () => { clearTimeout(timer); fail(); };
    document.head.appendChild(script);
  });
}
async function rwCreateAccount(email, password) {
  if (!rwCloudState.client) await rwInitCloud();
  if (!rwCloudState.client) throw new Error(rwCloudState.lastError || "云同步尚未连接");
  const { data, error } = await rwCloudState.client.auth.signUp({ email, password });
  if (error) throw error;
  return { user: data?.user || null, session: data?.session || null,
    requiresEmailConfirmation: Boolean(data?.user && !data?.session) };
}
async function rwLogin(email, password) {
  if (!rwCloudState.client) await rwInitCloud();
  if (!rwCloudState.client) throw new Error(rwCloudState.lastError || "云同步尚未连接");
  const { data, error } = await rwCloudState.client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data?.user || null;
}
async function rwLogout() {
  if (!rwCloudState.client) return;
  const { error } = await rwCloudState.client.auth.signOut();
  if (error) throw error;
}
function rwStartTimer() {
  rwStopTimer();
  rwCloudState.timer = setInterval(() => {
    if (rwCloudState.signedIn && rwCloudState.online && !rwCloudState.syncing && !document.hidden) {
      rwSyncNow({ reason: "timer" }).catch(() => {});
    }
  }, RW_AUTO_SYNC_MS);
}
function rwStopTimer() { clearInterval(rwCloudState.timer); rwCloudState.timer = null; }
window.addEventListener("reading-words-local-change", rwScheduleSync);
window.addEventListener("reading-words-peer-change", event => {
  if (event.detail?.operation !== "cloud-applied") rwScheduleSync();
});
window.addEventListener("online", () => {
  rwCloudState.online = true;
  rwEmitStatus();
  if (!rwCloudState.client) rwInitCloud();
  else if (rwCloudState.signedIn) rwSyncNow({ reason: "online" }).catch(() => {});
});
window.addEventListener("offline", () => { rwCloudState.online = false; rwEmitStatus(); });
window.addEventListener("focus", () => {
  if (rwCloudState.signedIn && rwCloudState.online) rwSyncNow({ reason: "focus" }).catch(() => {});
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && rwCloudState.signedIn && rwCloudState.online) rwSyncNow({ reason: "visible" }).catch(() => {});
});
function rwInitCloud() {
  if (rwCloudState.client) return Promise.resolve();
  if (rwCloudState.initPromise) return rwCloudState.initPromise;
  rwCloudState.initPromise = (async () => {
    const config = window.READING_WORDS_SUPABASE_CONFIG;
    if (!config?.url || !config?.publishableKey) {
      rwCloudState.ready = true;
      rwCloudState.configured = false;
      rwCloudState.lastError = "Supabase 配置缺失";
      rwEmitStatus();
      return;
    }
    rwCloudState.configured = true;
    try {
      await rwLoadSDK();
      rwCloudState.client = window.supabase.createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data: subData } = rwCloudState.client.auth.onAuthStateChange((event, session) => {
        const previousId = rwCloudState.user?.id || "";
        rwCloudState.user = session?.user || null;
        rwCloudState.signedIn = Boolean(rwCloudState.user);
        rwCloudState.ready = true;
        if (previousId !== (rwCloudState.user?.id || "")) rwCloudState.lastSyncAt = null;
        rwCloudState.lastError = null;
        rwEmitStatus();
        if (rwCloudState.signedIn) {
          rwStartTimer();
          if (previousId !== rwCloudState.user.id || event === "SIGNED_IN" || event === "INITIAL_SESSION") {
            // 回调保持同步，不在 Supabase auth 锁内 await 其他请求。
            setTimeout(() => rwSyncNow({ reason: `auth-${event}` }).catch(() => {}), 0);
          }
        } else { rwStopTimer(); clearTimeout(rwLocalSyncDebounce); }
      });
      rwCloudState.authSubscription = subData?.subscription || null;
      const { data, error } = await rwCloudState.client.auth.getSession();
      if (error) throw error;
      rwCloudState.user = data?.session?.user || null;
      rwCloudState.signedIn = Boolean(rwCloudState.user);
      rwCloudState.ready = true;
      rwEmitStatus();
      if (rwCloudState.signedIn) { rwStartTimer(); rwSyncNow({ reason: "startup" }).catch(() => {}); }
    } catch (error) {
      rwCloudState.ready = true;
      rwCloudState.lastError = error?.message || String(error);
      rwEmitStatus();
    }
  })().finally(() => { rwCloudState.initPromise = null; });
  return rwCloudState.initPromise;
}
window.ReadingWordsCloud = {
  getStatus: rwGetStatus, createAccount: rwCreateAccount, login: rwLogin, logout: rwLogout, syncNow: rwSyncNow
};
rwInitCloud();
