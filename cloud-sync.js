// 阅读生词 v3.1.0 - Supabase 登录与双向同步
// 同步单位是 normalizedTerm。云端 deleted=true 的记录是“删除墓碑”：
// 词条正文已被移除，但保留最小删除标记，用于让其他设备也删除本地旧副本。
const RW_REMOTE_TABLE = "cet6_sync_records";
const RW_REMOTE_STORE = "readingWords";
const RW_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const RW_LAST_SYNC_KEY = "reading-words-last-sync-v1";
const RW_AUTO_SYNC_MS = 60 * 1000;

const rwCloudState = {
  ready: false,
  configured: false,
  client: null,
  user: null,
  signedIn: false,
  syncing: false,
  online: navigator.onLine,
  lastSyncAt: localStorage.getItem(RW_LAST_SYNC_KEY) || null,
  lastError: null,
  syncPromise: null,
  timer: null,
  authSubscription: null
};

function rwEmitStatus() {
  window.dispatchEvent(new CustomEvent("reading-words-cloud-status", { detail: rwGetStatus() }));
}

function rwEmitDataUpdated() {
  window.dispatchEvent(new CustomEvent("reading-words-cloud-data-updated", {
    detail: { at: new Date().toISOString() }
  }));
}

function rwGetStatus() {
  return {
    ready: rwCloudState.ready,
    configured: rwCloudState.configured,
    signedIn: rwCloudState.signedIn,
    email: rwCloudState.user?.email || "",
    syncing: rwCloudState.syncing,
    online: rwCloudState.online,
    lastSyncAt: rwCloudState.lastSyncAt,
    lastError: rwCloudState.lastError
  };
}

function rwTimestamp(value) {
  const text = String(value || "");
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : 0;
}

function rwWordTimestamp(record) {
  return rwTimestamp(record?.updatedAt || record?.createdAt);
}

function rwTombstoneTimestamp(record) {
  return rwTimestamp(record?.deletedAt || record?.updatedAt);
}

function rwRemoteTimestamp(record) {
  return rwTimestamp(record?.sourceUpdatedAt || record?.deletedAt || record?.updatedAt || record?.cloudUpdatedAt);
}

function rwNormalizeTerm(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function rwReadingDocId(normalizedTerm) {
  const text = rwNormalizeTerm(normalizedTerm);
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function rwDecodeDocId(id) {
  try {
    let base64 = String(id || "").replaceAll("-", "+").replaceAll("_", "/");
    while (base64.length % 4) base64 += "=";
    const binary = atob(base64);
    return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

function rwSanitizeWord(record) {
  const normalizedTerm = rwNormalizeTerm(record?.normalizedTerm || record?.term);
  if (!normalizedTerm) return null;
  return {
    term: String(record?.term || normalizedTerm).trim(),
    normalizedTerm,
    meaning: String(record?.meaning || ""),
    source: String(record?.source || ""),
    sentence: String(record?.sentence || ""),
    note: String(record?.note || ""),
    occurrenceCount: Math.max(1, Number(record?.occurrenceCount) || 1),
    createdAt: record?.createdAt || record?.updatedAt || new Date().toISOString(),
    updatedAt: record?.updatedAt || new Date().toISOString()
  };
}

function rwMergeSameWord(localWord, remoteWord) {
  const local = rwSanitizeWord(localWord);
  const remote = rwSanitizeWord(remoteWord);
  if (!local) return remote;
  if (!remote) return local;

  const localNewer = rwWordTimestamp(local) >= rwWordTimestamp(remote);
  const newer = localNewer ? local : remote;
  const older = localNewer ? remote : local;
  const earliestCreated = [local.createdAt, remote.createdAt]
    .filter(Boolean)
    .sort()[0] || newer.createdAt;
  const latestUpdated = rwWordTimestamp(local) >= rwWordTimestamp(remote) ? local.updatedAt : remote.updatedAt;

  return {
    term: newer.term || older.term,
    normalizedTerm: newer.normalizedTerm || older.normalizedTerm,
    meaning: newer.meaning || older.meaning,
    source: newer.source || older.source,
    sentence: newer.sentence || older.sentence,
    note: newer.note || older.note,
    occurrenceCount: Math.max(Number(local.occurrenceCount) || 1, Number(remote.occurrenceCount) || 1),
    createdAt: earliestCreated,
    updatedAt: latestUpdated || new Date().toISOString()
  };
}

function rwLoadSDK() {
  if (window.supabase?.createClient) return Promise.resolve(window.supabase);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-reading-words-supabase="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.supabase), { once: true });
      existing.addEventListener("error", () => reject(new Error("Supabase SDK 加载失败")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = RW_SDK_URL;
    script.async = true;
    script.dataset.readingWordsSupabase = "1";
    script.onload = () => window.supabase?.createClient
      ? resolve(window.supabase)
      : reject(new Error("Supabase SDK 初始化失败"));
    script.onerror = () => reject(new Error("Supabase SDK 加载失败，请检查网络"));
    document.head.appendChild(script);
  });
}

function rwWaitForDB(timeoutMs = 10000) {
  if (window.READING_WORDS_DB_READY) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const onReady = () => {
      clearTimeout(timer);
      window.removeEventListener("reading-words-db-ready", onReady);
      resolve();
    };
    window.addEventListener("reading-words-db-ready", onReady);
    timer = setTimeout(() => {
      window.removeEventListener("reading-words-db-ready", onReady);
      reject(new Error("本地数据库尚未准备完成"));
    }, timeoutMs);
  });
}

function rwRequireSignedIn() {
  if (!rwCloudState.client || !rwCloudState.user || !rwCloudState.signedIn) {
    throw new Error("请先登录账号");
  }
}

function rwRemoteToState(row) {
  const payload = row?.payload && typeof row.payload === "object" ? JSON.parse(JSON.stringify(row.payload)) : {};
  const key = rwNormalizeTerm(payload.normalizedTerm || rwDecodeDocId(row?.record_key));
  const sourceUpdatedAt = row?.source_updated_at || payload.deletedAt || payload.updatedAt || row?.updated_at || "";
  return {
    key,
    deleted: Boolean(row?.deleted),
    sourceUpdatedAt,
    cloudUpdatedAt: row?.updated_at || "",
    payload
  };
}

async function rwFetchRemoteSnapshot() {
  rwRequireSignedIn();
  const { data, error } = await rwCloudState.client
    .from(RW_REMOTE_TABLE)
    .select("record_key,payload,deleted,source_updated_at,updated_at")
    .eq("user_id", rwCloudState.user.id)
    .eq("store_name", RW_REMOTE_STORE);
  if (error) throw error;
  return (data || []).map(rwRemoteToState).filter(item => item.key);
}

function rwWordRow(word) {
  rwRequireSignedIn();
  const payload = rwSanitizeWord(word);
  if (!payload) throw new Error("词条缺少 normalizedTerm");
  return {
    user_id: rwCloudState.user.id,
    store_name: RW_REMOTE_STORE,
    record_key: rwReadingDocId(payload.normalizedTerm),
    payload,
    deleted: false,
    source_updated_at: payload.updatedAt,
    updated_at: new Date().toISOString()
  };
}

function rwDeleteRow(tombstone) {
  rwRequireSignedIn();
  const normalizedTerm = rwNormalizeTerm(tombstone?.normalizedTerm);
  const deletedAt = tombstone?.deletedAt || tombstone?.updatedAt || new Date().toISOString();
  return {
    user_id: rwCloudState.user.id,
    store_name: RW_REMOTE_STORE,
    record_key: rwReadingDocId(normalizedTerm),
    payload: { normalizedTerm, deletedAt, updatedAt: deletedAt },
    deleted: true,
    source_updated_at: deletedAt,
    updated_at: new Date().toISOString()
  };
}

async function rwUpsertRows(rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await rwCloudState.client
      .from(RW_REMOTE_TABLE)
      .upsert(rows.slice(i, i + 200), { onConflict: "user_id,store_name,record_key" });
    if (error) throw error;
  }
}

function rwMapByTerm(items, keyGetter) {
  const map = new Map();
  for (const item of items || []) {
    const key = rwNormalizeTerm(keyGetter(item));
    if (key) map.set(key, item);
  }
  return map;
}

async function rwSyncNow({ reason = "manual" } = {}) {
  if (!rwCloudState.configured) throw new Error("Supabase 尚未配置");
  if (!rwCloudState.signedIn) throw new Error("请先登录账号");
  if (!rwCloudState.online) throw new Error("当前离线，本地数据已保留，联网后会继续同步");
  if (rwCloudState.syncPromise) return rwCloudState.syncPromise;

  rwCloudState.syncing = true;
  rwCloudState.lastError = null;
  rwEmitStatus();

  rwCloudState.syncPromise = (async () => {
    try {
      await rwWaitForDB();
      const [localWords, localTombstones, remoteStates] = await Promise.all([
        getAllReadingWords(),
        getAllReadingWordTombstones(),
        rwFetchRemoteSnapshot()
      ]);

      const localWordMap = rwMapByTerm(localWords, item => item.normalizedTerm || item.term);
      const localDeleteMap = rwMapByTerm(localTombstones, item => item.normalizedTerm);
      const remoteMap = rwMapByTerm(remoteStates, item => item.key);
      const keys = new Set([...localWordMap.keys(), ...localDeleteMap.keys(), ...remoteMap.keys()]);

      const rowsToUpload = [];
      let downloaded = 0;
      let deleted = 0;

      for (const key of keys) {
        const localWord = localWordMap.get(key) || null;
        const localDelete = localDeleteMap.get(key) || null;
        const remote = remoteMap.get(key) || null;

        // 如果本地同时存在词条和墓碑（理论上不应发生），以时间更新者为准。
        let localKind = null;
        let localTime = 0;
        if (localWord && rwWordTimestamp(localWord) >= rwTombstoneTimestamp(localDelete)) {
          localKind = "word";
          localTime = rwWordTimestamp(localWord);
        } else if (localDelete) {
          localKind = "deleted";
          localTime = rwTombstoneTimestamp(localDelete);
        }

        if (!remote) {
          if (localKind === "word") rowsToUpload.push(rwWordRow(localWord));
          if (localKind === "deleted") rowsToUpload.push(rwDeleteRow(localDelete));
          continue;
        }

        const remoteTime = rwRemoteTimestamp(remote);
        const remoteKind = remote.deleted ? "deleted" : "word";

        if (!localKind) {
          if (remoteKind === "deleted") {
            await applyReadingDeletionFromCloud(key, remote.sourceUpdatedAt);
            deleted++;
          } else {
            await applyReadingWordFromCloud(remote.payload);
            downloaded++;
          }
          continue;
        }

        // 两边都是同一个词条时做字段级合并：
        // 较新的记录决定冲突字段，同时保留另一端没有被覆盖的非空字段。
        if (localKind === "word" && remoteKind === "word") {
          const merged = rwMergeSameWord(localWord, remote.payload);
          const localJSON = JSON.stringify(rwSanitizeWord(localWord));
          const remoteJSON = JSON.stringify(rwSanitizeWord(remote.payload));
          const mergedJSON = JSON.stringify(merged);
          if (mergedJSON !== localJSON) {
            await applyReadingWordFromCloud(merged);
            downloaded++;
          }
          if (mergedJSON !== remoteJSON) rowsToUpload.push(rwWordRow(merged));
          continue;
        }

        // 删除与词条冲突时按源数据时间判定；完全相同时间删除优先，
        // 避免旧设备把已删除词条重新“复活”。
        if (remoteTime > localTime || (remoteTime === localTime && remoteKind === "deleted" && localKind !== "deleted")) {
          await applyReadingDeletionFromCloud(key, remote.sourceUpdatedAt);
          deleted++;
          continue;
        }

        if (localTime > remoteTime || (localTime === remoteTime && localKind === "deleted" && remoteKind !== "deleted")) {
          rowsToUpload.push(rwDeleteRow(localDelete));
          continue;
        }
      }

      await rwUpsertRows(rowsToUpload);
      rwCloudState.lastSyncAt = new Date().toISOString();
      localStorage.setItem(RW_LAST_SYNC_KEY, rwCloudState.lastSyncAt);
      rwCloudState.lastError = null;
      rwEmitDataUpdated();
      return { reason, uploaded: rowsToUpload.length, downloaded, deleted };
    } catch (error) {
      rwCloudState.lastError = error?.message || String(error);
      throw error;
    } finally {
      rwCloudState.syncing = false;
      rwCloudState.syncPromise = null;
      rwEmitStatus();
    }
  })();

  return rwCloudState.syncPromise;
}

async function rwCreateAccount(email, password) {
  if (!rwCloudState.client) throw new Error("Supabase 尚未初始化");
  const { data, error } = await rwCloudState.client.auth.signUp({ email, password });
  if (error) throw error;
  return {
    user: data?.user || null,
    session: data?.session || null,
    requiresEmailConfirmation: Boolean(data?.user && !data?.session)
  };
}

async function rwLogin(email, password) {
  if (!rwCloudState.client) throw new Error("Supabase 尚未初始化");
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
  if (rwCloudState.timer) clearInterval(rwCloudState.timer);
  rwCloudState.timer = setInterval(() => {
    if (rwCloudState.signedIn && rwCloudState.online && !rwCloudState.syncing) {
      rwSyncNow({ reason: "timer" }).catch(() => {});
    }
  }, RW_AUTO_SYNC_MS);
}

function rwStopTimer() {
  if (rwCloudState.timer) clearInterval(rwCloudState.timer);
  rwCloudState.timer = null;
}

let rwLocalSyncDebounce = null;
window.addEventListener("reading-words-local-change", () => {
  if (!rwCloudState.signedIn || !rwCloudState.online) return;
  clearTimeout(rwLocalSyncDebounce);
  rwLocalSyncDebounce = setTimeout(() => rwSyncNow({ reason: "local-change" }).catch(() => {}), 350);
});

window.addEventListener("online", () => {
  rwCloudState.online = true;
  rwEmitStatus();
  if (rwCloudState.signedIn) rwSyncNow({ reason: "online" }).catch(() => {});
});

window.addEventListener("offline", () => {
  rwCloudState.online = false;
  rwEmitStatus();
});

window.addEventListener("focus", () => {
  if (rwCloudState.signedIn && rwCloudState.online) rwSyncNow({ reason: "focus" }).catch(() => {});
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && rwCloudState.signedIn && rwCloudState.online) {
    rwSyncNow({ reason: "visible" }).catch(() => {});
  }
});

async function rwInitCloud() {
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
      rwCloudState.lastError = null;
      rwEmitStatus();

      if (rwCloudState.signedIn) {
        rwStartTimer();
        if (previousId !== rwCloudState.user.id || event === "SIGNED_IN" || event === "INITIAL_SESSION") {
          setTimeout(() => rwSyncNow({ reason: `auth-${event || "change"}` }).catch(error => {
            rwCloudState.lastError = error?.message || String(error);
            rwEmitStatus();
          }), 0);
        }
      } else {
        rwStopTimer();
      }
    });
    rwCloudState.authSubscription = subData?.subscription || null;

    const { data, error } = await rwCloudState.client.auth.getSession();
    if (error) throw error;
    rwCloudState.user = data?.session?.user || null;
    rwCloudState.signedIn = Boolean(rwCloudState.user);
    rwCloudState.ready = true;
    rwEmitStatus();

    if (rwCloudState.signedIn) {
      rwStartTimer();
      rwSyncNow({ reason: "startup" }).catch(error => {
        rwCloudState.lastError = error?.message || String(error);
        rwEmitStatus();
      });
    }
  } catch (error) {
    rwCloudState.ready = true;
    rwCloudState.lastError = error?.message || String(error);
    rwEmitStatus();
  }
}

window.ReadingWordsCloud = {
  getStatus: rwGetStatus,
  createAccount: rwCreateAccount,
  login: rwLogin,
  logout: rwLogout,
  syncNow: rwSyncNow
};

rwInitCloud();
