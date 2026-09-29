// =======================================
// CET6 Review - db.js
// IndexedDB 持久化
// =======================================

const DB_NAME = "cet6-review-db";
const DB_VERSION = 3;

const WORD_STORE = "wordProgress";
const DAILY_SESSION_STORE = "dailySessions";
const LEGACY_DAILY_STORE = "dailyStats";
const READING_WORD_STORE = "readingWords";

let reviewDB = null;

function emitLocalCloudChange(detail) {
  try {
    window.dispatchEvent(new CustomEvent("cet6-local-change", { detail }));
  } catch (error) {
    console.warn("云同步事件发送失败：", error);
  }
}

function stripCloudMeta(record) {
  if (!record || typeof record !== "object") return record;
  const copy = { ...record };
  delete copy.remoteId;
  delete copy.cloudUpdatedAt;
  delete copy.deleted;
  return copy;
}

function initReviewDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(WORD_STORE)) {
        const wordStore = db.createObjectStore(WORD_STORE, { keyPath: "id" });
        wordStore.createIndex("lastRating", "lastRating", { unique: false });
        wordStore.createIndex("nextReviewDate", "nextReviewDate", { unique: false });
      } else {
        const transaction = event.target.transaction;
        const wordStore = transaction.objectStore(WORD_STORE);

        if (!wordStore.indexNames.contains("lastRating")) {
          wordStore.createIndex("lastRating", "lastRating", { unique: false });
        }

        if (!wordStore.indexNames.contains("nextReviewDate")) {
          wordStore.createIndex("nextReviewDate", "nextReviewDate", { unique: false });
        }
      }

      // 保留旧版 dailyStats，避免升级时破坏已有数据。
      if (!db.objectStoreNames.contains(LEGACY_DAILY_STORE)) {
        db.createObjectStore(LEGACY_DAILY_STORE, { keyPath: "date" });
      }

      if (!db.objectStoreNames.contains(DAILY_SESSION_STORE)) {
        db.createObjectStore(DAILY_SESSION_STORE, { keyPath: "date" });
      }

      // 阅读中遇到的生词/短语。
      if (!db.objectStoreNames.contains(READING_WORD_STORE)) {
        const readingStore = db.createObjectStore(READING_WORD_STORE, {
          keyPath: "id",
          autoIncrement: true
        });

        readingStore.createIndex("normalizedTerm", "normalizedTerm", { unique: false });
        readingStore.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };

    request.onsuccess = event => {
      reviewDB = event.target.result;
      window.CET6_LOCAL_DB_READY = true;
      window.dispatchEvent(new CustomEvent("cet6-local-db-ready"));
      console.log("IndexedDB 已连接，版本：", DB_VERSION);
      resolve(reviewDB);
    };

    request.onerror = () => reject(request.error);
  });
}

function getWordProgress(wordId) {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(WORD_STORE, "readonly");
    const request = tx.objectStore(WORD_STORE).get(wordId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function getAllWordProgress() {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(WORD_STORE, "readonly");
    const request = tx.objectStore(WORD_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 保存“首轮”评价。
 * 首轮评价才改变 streak / lastRating / nextReviewDate。
 */
async function savePrimaryWordRating(word, rating) {
  const oldRecord = await getWordProgress(word.id);
  const now = new Date().toISOString();
  const todayKey = getLocalDateKey();

  const record = oldRecord
    ? { ...oldRecord }
    : {
        id: word.id,
        term: word.term,
        sourceOrder: word.source_order || 0,
        reviewCount: 0,
        knowCount: 0,
        forgotCount: 0,
        streak: 0,
        lastRating: null,
        lastReviewedAt: null,
        nextReviewDate: null,
        reinforcementCount: 0,
        lastReinforcementRating: null,
        lastReinforcementAt: null
      };

  record.term = word.term;
  record.sourceOrder = word.source_order || record.sourceOrder || 0;
  record.reviewCount = (record.reviewCount || 0) + 1;

  if (rating === "know") {
    record.knowCount = (record.knowCount || 0) + 1;
    record.streak = (record.streak || 0) + 1;
  } else if (rating === "forgot") {
    record.forgotCount = (record.forgotCount || 0) + 1;
    record.streak = 0;
  } else {
    throw new Error(`未知评价：${rating}`);
  }

  record.lastRating = rating;
  record.lastReviewedAt = now;
  record.updatedAt = now;
  record.nextReviewDate = calculateNextReviewDate(rating, record.streak, todayKey);

  return putWordRecord(record);
}

/**
 * 用户先点“认识”，查看解析后发现自己其实记错了：
 * 把本次首轮评价从 know 原地纠正为 forgot。
 * reviewCount 不重复增加；knowCount 回退1次；forgotCount 增加1次。
 */
async function correctPrimaryKnowToForgot(word) {
  const oldRecord = await getWordProgress(word.id);

  if (!oldRecord) {
    throw new Error("纠错失败：找不到单词首轮记录");
  }

  const record = { ...oldRecord };
  const now = new Date().toISOString();
  const todayKey = getLocalDateKey();

  if (record.lastRating === "know") {
    record.knowCount = Math.max(0, (record.knowCount || 0) - 1);
  }

  record.forgotCount = (record.forgotCount || 0) + 1;
  record.streak = 0;
  record.lastRating = "forgot";
  record.lastReviewedAt = now;
  record.nextReviewDate = calculateNextReviewDate("forgot", 0, todayKey);
  record.correctionCount = (record.correctionCount || 0) + 1;
  record.lastCorrectionAt = now;
  record.updatedAt = now;

  return putWordRecord(record);
}

/**
 * 加练阶段先点“认识”后发现记错：
 * 只纠正最近一次加练结果，不改变首轮已经确定的次日安排。
 */
async function correctReinforcementKnowToForgot(word) {
  const oldRecord = await getWordProgress(word.id);

  if (!oldRecord) {
    throw new Error("纠错失败：找不到加练记录");
  }

  const record = { ...oldRecord };
  record.lastReinforcementRating = "forgot";
  record.lastReinforcementAt = new Date().toISOString();
  record.reinforcementCorrectionCount = (record.reinforcementCorrectionCount || 0) + 1;
  record.updatedAt = record.lastReinforcementAt;

  return putWordRecord(record);
}

/**
 * 保存“本轮稍后再出现”的加练结果。
 * 加练不改变 nextReviewDate，也不覆盖 lastRating。
 */
async function saveReinforcementAttempt(word, rating) {
  const oldRecord = await getWordProgress(word.id);

  if (!oldRecord) {
    throw new Error("加练词没有首轮记录");
  }

  const record = { ...oldRecord };
  record.reinforcementCount = (record.reinforcementCount || 0) + 1;
  record.lastReinforcementRating = rating;
  record.lastReinforcementAt = new Date().toISOString();
  record.updatedAt = record.lastReinforcementAt;

  return putWordRecord(record);
}

function putWordRecord(record, { fromCloud = false } = {}) {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(WORD_STORE, "readwrite");
    const cleanRecord = stripCloudMeta(record);
    const request = tx.objectStore(WORD_STORE).put(cleanRecord);
    request.onsuccess = () => {
      if (!fromCloud) {
        emitLocalCloudChange({ storeName: "wordProgress", operation: "put", record: cleanRecord });
      }
      resolve(cleanRecord);
    };
    request.onerror = () => reject(request.error);
  });
}

function getTodaySession() {
  return getDailySession(getLocalDateKey());
}

function getDailySession(dateKey) {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(DAILY_SESSION_STORE, "readonly");
    const request = tx.objectStore(DAILY_SESSION_STORE).get(dateKey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function saveDailySession(session, { fromCloud = false } = {}) {
  const cleanSession = stripCloudMeta({ ...session });
  if (!fromCloud) {
    cleanSession.updatedAt = new Date().toISOString();
  }

  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(DAILY_SESSION_STORE, "readwrite");
    const request = tx.objectStore(DAILY_SESSION_STORE).put(cleanSession);
    request.onsuccess = () => {
      if (!fromCloud) {
        emitLocalCloudChange({ storeName: "dailySessions", operation: "put", record: cleanSession });
      }
      resolve(cleanSession);
    };
    request.onerror = () => reject(request.error);
  });
}

async function getForgottenWordCount() {
  const records = await getAllWordProgress();
  return records.filter(record => record.lastRating === "forgot").length;
}

// =======================================
// 阅读生词 / 短语
// =======================================

function normalizeReadingTerm(term) {
  return String(term || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findReadingWordByNormalizedTerm(normalizedTerm) {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(READING_WORD_STORE, "readonly");
    const index = tx.objectStore(READING_WORD_STORE).index("normalizedTerm");
    const request = index.get(normalizedTerm);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function saveReadingWord({ term, meaning = "", source = "", sentence = "", note = "" }) {
  const cleanTerm = String(term || "").trim().replace(/\s+/g, " ");

  if (!cleanTerm) {
    throw new Error("单词或短语不能为空");
  }

  const normalizedTerm = normalizeReadingTerm(cleanTerm);
  const oldRecord = await findReadingWordByNormalizedTerm(normalizedTerm);
  const now = new Date().toISOString();

  const record = oldRecord
    ? { ...oldRecord }
    : {
        term: cleanTerm,
        normalizedTerm,
        meaning: "",
        source: "",
        sentence: "",
        note: "",
        occurrenceCount: 0,
        createdAt: now,
        updatedAt: now
      };

  record.term = cleanTerm;
  record.normalizedTerm = normalizedTerm;
  record.meaning = String(meaning || "").trim() || record.meaning || "";
  record.source = String(source || "").trim() || record.source || "";
  record.sentence = String(sentence || "").trim() || record.sentence || "";
  record.note = String(note || "").trim() || record.note || "";
  record.occurrenceCount = (record.occurrenceCount || 0) + 1;
  record.updatedAt = now;

  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(READING_WORD_STORE, "readwrite");
    const store = tx.objectStore(READING_WORD_STORE);
    const request = oldRecord ? store.put(record) : store.add(record);
    request.onsuccess = () => {
      if (!oldRecord) {
        record.id = request.result;
      }
      emitLocalCloudChange({ storeName: "readingWords", operation: "put", record });
      resolve(record);
    };
    request.onerror = () => reject(request.error);
  });
}

function getAllReadingWords() {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(READING_WORD_STORE, "readonly");
    const request = tx.objectStore(READING_WORD_STORE).getAll();

    request.onsuccess = () => {
      const items = request.result || [];
      items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      resolve(items);
    };

    request.onerror = () => reject(request.error);
  });
}

async function deleteReadingWord(id) {
  const numericId = Number(id);
  const existing = await new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(READING_WORD_STORE, "readonly");
    const request = tx.objectStore(READING_WORD_STORE).get(numericId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });

  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(READING_WORD_STORE, "readwrite");
    const request = tx.objectStore(READING_WORD_STORE).delete(numericId);
    request.onsuccess = () => {
      if (existing?.normalizedTerm) {
        emitLocalCloudChange({
          storeName: "readingWords",
          operation: "delete-reading",
          normalizedTerm: existing.normalizedTerm
        });
      }
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function getReadingWordCount() {
  const items = await getAllReadingWords();
  return items.length;
}

// =======================================
// 每日复习记录
// =======================================

/**
 * 读取全部每日复习会话，按日期从新到旧排列。
 * 每天实际复习词数使用 primaryCompleted，
 * 因此即使当天只完成100词后退出，也会保存为100。
 */
function getAllDailySessions() {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(DAILY_SESSION_STORE, "readonly");
    const request = tx.objectStore(DAILY_SESSION_STORE).getAll();

    request.onsuccess = () => {
      const sessions = request.result || [];
      sessions.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      resolve(sessions);
    };

    request.onerror = () => reject(request.error);
  });
}


// =======================================
// Supabase 云同步：本地写入辅助
// =======================================

async function upsertRecordFromCloud(storeName, remoteRecord) {
  const record = stripCloudMeta(remoteRecord);

  if (storeName === "wordProgress") {
    return putWordRecord(record, { fromCloud: true });
  }

  if (storeName === "dailySessions") {
    return saveDailySession(record, { fromCloud: true });
  }

  if (storeName === "readingWords") {
    const normalizedTerm = normalizeReadingTerm(record.normalizedTerm || record.term);
    if (!normalizedTerm) throw new Error("云端阅读词缺少 normalizedTerm");

    const existing = await findReadingWordByNormalizedTerm(normalizedTerm);
    const clean = {
      ...record,
      normalizedTerm,
      updatedAt: record.updatedAt || new Date().toISOString()
    };
    delete clean.id;

    return new Promise((resolve, reject) => {
      const tx = reviewDB.transaction(READING_WORD_STORE, "readwrite");
      const store = tx.objectStore(READING_WORD_STORE);
      if (existing?.id != null) clean.id = existing.id;
      const request = existing ? store.put(clean) : store.add(clean);
      request.onsuccess = () => {
        if (!existing) clean.id = request.result;
        resolve(clean);
      };
      request.onerror = () => reject(request.error);
    });
  }

  throw new Error(`不支持的云同步存储：${storeName}`);
}

async function deleteReadingWordFromCloud(normalizedTerm) {
  const existing = await findReadingWordByNormalizedTerm(normalizeReadingTerm(normalizedTerm));
  if (!existing) return false;

  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(READING_WORD_STORE, "readwrite");
    const request = tx.objectStore(READING_WORD_STORE).delete(existing.id);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

// =======================================
// 最终版：学习数据重置
// =======================================

/**
 * 清空所有用户学习数据，但保留：
 * - 内置 2003 核心词文件
 * - 独立增强词典缓存（cet6-dictionary-db）
 *
 * 会清空：
 * - 单词复习历史 / 连续认识 / 忘记次数 / 下次复习日期
 * - 每日复习会话与历史统计
 * - 阅读生词 / 短语
 */
function resetAllStudyData() {
  if (!reviewDB) {
    return Promise.reject(new Error("复习数据库尚未初始化"));
  }

  const stores = [
    WORD_STORE,
    DAILY_SESSION_STORE,
    LEGACY_DAILY_STORE,
    READING_WORD_STORE
  ].filter(name => reviewDB.objectStoreNames.contains(name));

  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(stores, "readwrite");

    for (const storeName of stores) {
      tx.objectStore(storeName).clear();
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("重置学习数据失败"));
    tx.onabort = () => reject(tx.error || new Error("重置学习数据被中止"));
  });
}

/**
 * 仅在最终版第一次运行时自动执行一次清空。
 * 之后刷新、关闭浏览器再打开都不会再次清空。
 */
async function ensureFinalFreshStart() {
  // v2.0 不再自动清空学习记录。升级到云同步版时必须保留现有 IndexedDB 数据，
  // 首次登录后会把本地记录与 Supabase 合并。
  return false;
}
