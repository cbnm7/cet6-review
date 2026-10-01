// =======================================
// CET6 Review - db.js
// IndexedDB 持久化
// =======================================

const DB_NAME = "cet6-review-db";
const DB_VERSION = 4;

const WORD_STORE = "wordProgress";
const DAILY_SESSION_STORE = "dailySessions";
const LEGACY_DAILY_STORE = "dailyStats";
const READING_WORD_STORE = "readingWords";
const META_STORE = "appMeta";
const SCHEDULER_MIGRATION_KEY = "scheduler-v2-migration";
const SCHEDULER_BACKUP_KEY = "scheduler-v2-pre-migration-backup";

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

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
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

    request.onsuccess = async event => {
      reviewDB = event.target.result;
      try {
        await migrateSchedulerV2IfNeeded();
        window.CET6_SCHEDULER_MIGRATION_READY = true;
        window.CET6_LOCAL_DB_READY = true;
        window.dispatchEvent(new CustomEvent("cet6-local-db-ready"));
        window.dispatchEvent(new CustomEvent("cet6-scheduler-migration-ready"));
        console.log("IndexedDB 已连接，版本：", DB_VERSION, "；调度器版本：", SCHEDULER_VERSION);
        resolve(reviewDB);
      } catch (error) {
        console.error("调度数据迁移失败：", error);
        reject(error);
      }
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


function getMetaRecord(key) {
  if (!reviewDB?.objectStoreNames.contains(META_STORE)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(META_STORE, "readonly");
    const request = tx.objectStore(META_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function putMetaRecord(record) {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(META_STORE, "readwrite");
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error || new Error("保存元数据失败"));
    tx.onabort = () => reject(tx.error || new Error("保存元数据中止"));
    try { tx.objectStore(META_STORE).put(record); }
    catch (error) { tx.abort(); reject(error); }
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function recordDateKey(isoLike) {
  if (!isoLike) return "";
  const text = String(isoLike);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  try { return getLocalDateKey(new Date(text)); } catch { return ""; }
}

function emptySchedulerV2Record(oldRecord = {}) {
  return {
    id: oldRecord.id,
    term: oldRecord.term || "",
    sourceOrder: oldRecord.sourceOrder || 0,
    schedulerVersion: SCHEDULER_VERSION,
    stateRevision: Math.max(1, Number(oldRecord.stateRevision) || 0) + 1,
    roundCount: 0,
    reviewCount: 0,
    knowCount: 0,
    forgotCount: 0,
    streak: 0,
    lastRating: null,
    lastReviewedAt: null,
    lastReviewedDate: null,
    nextReviewDate: null,
    remediationActive: false,
    reviewStage: null,
    reinforcementCount: 0,
    lastReinforcementRating: null,
    lastReinforcementAt: null,
    correctionCount: 0,
    reinforcementCorrectionCount: 0,
    updatedAt: new Date().toISOString()
  };
}

function upgradeLegacyRecordPreservingHistory(oldRecord) {
  const upgraded = emptySchedulerV2Record(oldRecord);
  const reviewedDate = recordDateKey(oldRecord.lastReviewedAt || oldRecord.updatedAt);
  const reviewCount = Math.max(0, Number(oldRecord.reviewCount) || 0);

  if (reviewCount <= 0 && !oldRecord.lastRating) return upgraded;

  upgraded.roundCount = Math.max(1, Number(oldRecord.roundCount) || 1);
  upgraded.reviewCount = reviewCount || 1;
  upgraded.knowCount = Math.max(0, Number(oldRecord.knowCount) || (oldRecord.lastRating === "know" ? 1 : 0));
  upgraded.forgotCount = Math.max(0, Number(oldRecord.forgotCount) || (oldRecord.lastRating === "forgot" ? 1 : 0));
  upgraded.lastRating = oldRecord.lastRating || null;
  upgraded.lastReviewedAt = oldRecord.lastReviewedAt || oldRecord.updatedAt || null;
  upgraded.lastReviewedDate = reviewedDate || null;
  upgraded.reinforcementCount = Math.max(0, Number(oldRecord.reinforcementCount) || 0);
  upgraded.lastReinforcementRating = oldRecord.lastReinforcementRating || null;
  upgraded.lastReinforcementAt = oldRecord.lastReinforcementAt || null;
  upgraded.correctionCount = Math.max(0, Number(oldRecord.correctionCount) || 0);
  upgraded.reinforcementCorrectionCount = Math.max(0, Number(oldRecord.reinforcementCorrectionCount) || 0);

  if (oldRecord.lastRating === "forgot") {
    upgraded.remediationActive = true;
    upgraded.reviewStage = 0;
    upgraded.nextReviewDate = reviewedDate ? addDaysToDateKey(reviewedDate, FORGOT_INTERVALS[0]) : oldRecord.nextReviewDate || null;
  }

  return upgraded;
}

function rebuildRecordFromHistoricalRatings(oldRecord, actions) {
  const rebuilt = emptySchedulerV2Record(oldRecord);
  let lastAction = null;

  for (const action of actions) {
    if (action.rating !== "know" && action.rating !== "forgot") continue;
    rebuilt.roundCount += 1;
    rebuilt.reviewCount += 1;
    rebuilt.lastRating = action.rating;
    rebuilt.lastReviewedDate = action.date;
    rebuilt.lastReviewedAt = action.timestamp || `${action.date}T12:00:00`;

    if (action.rating === "know") {
      rebuilt.knowCount += 1;
      rebuilt.streak += 1;
      rebuilt.remediationActive = false;
      rebuilt.reviewStage = null;
      rebuilt.nextReviewDate = null;
    } else {
      rebuilt.forgotCount += 1;
      rebuilt.streak = 0;
      rebuilt.remediationActive = true;
      rebuilt.reviewStage = 0;
      rebuilt.nextReviewDate = addDaysToDateKey(action.date, FORGOT_INTERVALS[0]);
    }
    lastAction = action;
  }

  if (lastAction) rebuilt.updatedAt = lastAction.timestamp || `${lastAction.date}T12:00:00`;
  return rebuilt;
}

/**
 * 仅转换旧调度记录。已经是 v2 的记录原样保留，即使缺少 appMeta 标记，
 * 也不能依据“2026-10-01”重建/回退它们。供首次升级与旧备份导入共用。
 * 日期是固定的一次性事故边界，绝不使用运行当天动态删除记录。
 */
function buildSchedulerV2MigrationPlan(wordRecords, sessions) {
  const historical = sessions
    .filter(session => String(session.date || "") < SCHEDULER_V2_RESET_DATE)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const actionsByWord = new Map();
  for (const session of historical) {
    const ratings = session.primaryRatings && typeof session.primaryRatings === "object"
      ? session.primaryRatings : {};
    for (const [id, rating] of Object.entries(ratings)) {
      if (rating !== "know" && rating !== "forgot") continue;
      if (!actionsByWord.has(String(id))) actionsByWord.set(String(id), []);
      actionsByWord.get(String(id)).push({
        date: session.date,
        rating,
        timestamp: session.completedAt || session.updatedAt || session.createdAt || `${session.date}T12:00:00`
      });
    }
  }
  const migratedWords = wordRecords.map(oldRecord => {
    // 关键保护：新版备份、已迁移的真实进度绝不重新按旧日期回退。
    if (Number(oldRecord.schedulerVersion) >= SCHEDULER_VERSION) return { ...oldRecord };
    const actions = actionsByWord.get(String(oldRecord.id)) || [];
    if (actions.length) return rebuildRecordFromHistoricalRatings(oldRecord, actions);
    const lastDate = oldRecord.lastReviewedDate || recordDateKey(oldRecord.lastReviewedAt || oldRecord.updatedAt);
    if (lastDate && lastDate < SCHEDULER_V2_RESET_DATE) {
      return upgradeLegacyRecordPreservingHistory(oldRecord);
    }
    return emptySchedulerV2Record(oldRecord);
  });

  // 保留历史会话和所有新版会话；拒绝边界日及以后的旧调度会话。
  const migratedSessions = sessions.filter(session =>
    Number(session.schedulerVersion) >= SCHEDULER_VERSION ||
    (String(session.date || "") && String(session.date) < SCHEDULER_V2_RESET_DATE)
  ).map(session => ({ ...session }));
  const hasCurrentReset = migratedSessions.some(session => session.date === SCHEDULER_V2_RESET_DATE);
  const hadLegacyReset = sessions.some(session => session.date === SCHEDULER_V2_RESET_DATE &&
    !(Number(session.schedulerVersion) >= SCHEDULER_VERSION));
  if (hadLegacyReset && !hasCurrentReset) {
    const now = new Date().toISOString();
    migratedSessions.push({
      date: SCHEDULER_V2_RESET_DATE,
      schedulerVersion: SCHEDULER_VERSION,
      stateRevision: 1,
      needsRegeneration: true,
      queue: [], cursor: 0, initialPrimaryCount: 0, primaryCompleted: 0,
      forgot: 0, know: 0, reinforcementAttempts: 0, primaryRatings: {},
      planMeta: { schedulerVersion: SCHEDULER_VERSION, migratedReset: true },
      createdAt: now, updatedAt: now, completedAt: null
    });
  }
  return { wordProgress: migratedWords, dailySessions: migratedSessions };
}

async function migrateSchedulerV2IfNeeded() {
  const marker = await getMetaRecord(SCHEDULER_MIGRATION_KEY);
  if (Number(marker?.version) >= SCHEDULER_VERSION) return false;

  const [wordRecords, sessions, legacyStats, previousBackup] = await Promise.all([
    idbGetAll(WORD_STORE), idbGetAll(DAILY_SESSION_STORE), idbGetAll(LEGACY_DAILY_STORE),
    getMetaRecord(SCHEDULER_BACKUP_KEY)
  ]);
  const plan = buildSchedulerV2MigrationPlan(wordRecords, sessions);
  const now = new Date().toISOString();
  await new Promise((resolve, reject) => {
    const tx = reviewDB.transaction([WORD_STORE, DAILY_SESSION_STORE, LEGACY_DAILY_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("调度迁移失败"));
    tx.onabort = () => reject(tx.error || new Error("调度迁移被中止"));
    try {
      const words = tx.objectStore(WORD_STORE);
      const daily = tx.objectStore(DAILY_SESSION_STORE);
      const meta = tx.objectStore(META_STORE);
      // 快照和迁移同事务提交；不覆盖最初那一份迁移前快照。
      if (!previousBackup && (wordRecords.length || sessions.length || legacyStats.length)) {
        meta.put({ key: SCHEDULER_BACKUP_KEY, createdAt: now,
          resetDate: SCHEDULER_V2_RESET_DATE, wordProgress: wordRecords,
          dailySessions: sessions, dailyStats: legacyStats });
      }
      for (const record of plan.wordProgress) words.put(record);
      daily.clear();
      for (const record of plan.dailySessions) daily.put(record);
      // dailyStats 仅由更早的旧程序使用，防止旧日统计遗漏在恢复结果里。
      for (const record of legacyStats) {
        if (String(record.date || "") >= SCHEDULER_V2_RESET_DATE &&
            !(Number(record.schedulerVersion) >= SCHEDULER_VERSION)) {
          tx.objectStore(LEGACY_DAILY_STORE).delete(record.date);
        }
      }
      meta.put({ key: SCHEDULER_MIGRATION_KEY, version: SCHEDULER_VERSION,
        resetDate: SCHEDULER_V2_RESET_DATE, migratedAt: now });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
  console.log("调度器 v2 兼容迁移完成；已有 v2 数据保持不变。");
  return true;
}

/**
 * 构造/规范 v2 调度记录。
 */
function ensureSchedulerRecord(word, oldRecord = null) {
  const base = oldRecord ? { ...oldRecord } : emptySchedulerV2Record({
    id: word.id,
    term: word.term,
    sourceOrder: word.source_order || 0
  });

  base.id = word.id;
  base.term = word.term;
  base.sourceOrder = word.source_order || base.sourceOrder || 0;
  base.schedulerVersion = SCHEDULER_VERSION;
  base.stateRevision = Math.max(0, Number(base.stateRevision) || 0);
  base.roundCount = Math.max(0, Number(base.roundCount) || 0);
  base.reviewCount = Math.max(0, Number(base.reviewCount) || 0);
  base.knowCount = Math.max(0, Number(base.knowCount) || 0);
  base.forgotCount = Math.max(0, Number(base.forgotCount) || 0);
  base.reinforcementCount = Math.max(0, Number(base.reinforcementCount) || 0);
  base.correctionCount = Math.max(0, Number(base.correctionCount) || 0);
  base.reinforcementCorrectionCount = Math.max(0, Number(base.reinforcementCorrectionCount) || 0);
  return base;
}

function captureSchedulingState(record) {
  return {
    roundCount: Math.max(0, Number(record.roundCount) || 0),
    reviewCount: Math.max(0, Number(record.reviewCount) || 0),
    knowCount: Math.max(0, Number(record.knowCount) || 0),
    forgotCount: Math.max(0, Number(record.forgotCount) || 0),
    streak: Math.max(0, Number(record.streak) || 0),
    lastRating: record.lastRating ?? null,
    lastReviewedAt: record.lastReviewedAt ?? null,
    lastReviewedDate: record.lastReviewedDate ?? null,
    nextReviewDate: record.nextReviewDate ?? null,
    remediationActive: Boolean(record.remediationActive),
    reviewStage: record.reviewStage == null ? null : Number(record.reviewStage)
  };
}

function applyPlannedRating(record, rating, itemType, todayKey, now, { countAttempt = true } = {}) {
  if (rating !== "know" && rating !== "forgot") {
    throw new Error(`未知评价：${rating}`);
  }

  if (countAttempt) {
    record.reviewCount += 1;
    if (itemType === "primary") record.roundCount += 1;
  }

  if (rating === "know") {
    if (countAttempt) record.knowCount += 1;
    record.streak = (record.streak || 0) + 1;

    if (itemType === "review") {
      const stage = Math.max(0, Number(record.reviewStage) || 0);
      if (stage >= FORGOT_INTERVALS.length - 1) {
        record.remediationActive = false;
        record.reviewStage = null;
        record.nextReviewDate = null;
      } else {
        const nextStage = stage + 1;
        record.remediationActive = true;
        record.reviewStage = nextStage;
        record.nextReviewDate = addDaysToDateKey(todayKey, FORGOT_INTERVALS[nextStage]);
      }
    } else {
      // 普通分轮学习中“认识”后顺延到本轮末尾，不进入固定日期复习。
      record.remediationActive = false;
      record.reviewStage = null;
      record.nextReviewDate = null;
    }
  } else {
    if (countAttempt) record.forgotCount += 1;
    record.streak = 0;
    record.remediationActive = true;
    record.reviewStage = 0;
    record.nextReviewDate = addDaysToDateKey(todayKey, FORGOT_INTERVALS[0]);
  }

  record.lastRating = rating;
  record.lastReviewedAt = now;
  record.lastReviewedDate = todayKey;
  record.lastPlannedType = itemType;
  record.updatedAt = now;
  record.schedulerVersion = SCHEDULER_VERSION;
  record.stateRevision = Math.max(0, Number(record.stateRevision) || 0) + 1;
  return record;
}

/** 保存当天计划中的一个正式单词：普通轮次(primary)或到期遗忘复习(review)。 */
async function savePlannedWordRating(word, rating, itemType = "primary") {
  if (itemType !== "primary" && itemType !== "review") {
    throw new Error(`未知正式任务类型：${itemType}`);
  }

  const oldRecord = await getWordProgress(word.id);
  const record = ensureSchedulerRecord(word, oldRecord);
  const now = new Date().toISOString();
  const todayKey = getLocalDateKey();

  record.lastActionBefore = captureSchedulingState(record);
  applyPlannedRating(record, rating, itemType, todayKey, now, { countAttempt: true });
  return putWordRecord(record);
}

async function savePrimaryWordRating(word, rating) {
  return savePlannedWordRating(word, rating, "primary");
}

async function saveReviewWordRating(word, rating) {
  return savePlannedWordRating(word, rating, "review");
}

/**
 * 用户正式任务先点“认识”，查看解析后发现其实记错：
 * 恢复本次作答前的调度状态，再把同一次作答改为 forgot，不重复增加正式任务次数。
 */
async function correctPrimaryKnowToForgot(word, itemType = null) {
  const oldRecord = await getWordProgress(word.id);
  if (!oldRecord) throw new Error("纠错失败：找不到单词正式记录");

  const record = ensureSchedulerRecord(word, oldRecord);
  const before = record.lastActionBefore;
  const plannedType = itemType || record.lastPlannedType || "primary";
  const now = new Date().toISOString();
  const todayKey = getLocalDateKey();

  if (before && typeof before === "object") {
    Object.assign(record, before);
    record.reviewCount = Math.max(0, Number(record.reviewCount) || 0) + 1;
    if (plannedType === "primary") {
      record.roundCount = Math.max(0, Number(record.roundCount) || 0) + 1;
    }
  } else {
    // 兼容极少数旧记录：至少回退一次“认识”计数，正式任务总次数不重复增加。
    record.knowCount = Math.max(0, (record.knowCount || 0) - 1);
  }

  record.forgotCount = Math.max(0, Number(record.forgotCount) || 0) + 1;
  record.correctionCount = Math.max(0, Number(record.correctionCount) || 0) + 1;
  record.streak = 0;
  record.remediationActive = true;
  record.reviewStage = 0;
  record.nextReviewDate = addDaysToDateKey(todayKey, FORGOT_INTERVALS[0]);
  record.lastRating = "forgot";
  record.lastReviewedAt = now;
  record.lastReviewedDate = todayKey;
  record.lastPlannedType = plannedType;
  record.lastCorrectionAt = now;
  record.updatedAt = now;
  record.schedulerVersion = SCHEDULER_VERSION;
  record.stateRevision = Math.max(0, Number(oldRecord.stateRevision) || 0) + 1;
  delete record.lastActionBefore;

  return putWordRecord(record);
}

/** 加练阶段先点“认识”后发现记错；不改变已经确定的跨天安排。 */
async function correctReinforcementKnowToForgot(word) {
  const oldRecord = await getWordProgress(word.id);
  if (!oldRecord) throw new Error("纠错失败：找不到加练记录");

  const record = ensureSchedulerRecord(word, oldRecord);
  record.lastReinforcementRating = "forgot";
  record.lastReinforcementAt = new Date().toISOString();
  record.reinforcementCorrectionCount += 1;
  record.updatedAt = record.lastReinforcementAt;
  record.stateRevision += 1;
  return putWordRecord(record);
}

/**
 * 保存当天“稍后再出现”的加练结果。
 * 加练本身不推进跨天阶段；若再次忘记，App 会继续把该词插回当天队列。
 */
async function saveReinforcementAttempt(word, rating) {
  const oldRecord = await getWordProgress(word.id);
  if (!oldRecord) throw new Error("加练词没有正式记录");

  const record = ensureSchedulerRecord(word, oldRecord);
  record.reinforcementCount += 1;
  record.lastReinforcementRating = rating;
  record.lastReinforcementAt = new Date().toISOString();
  record.updatedAt = record.lastReinforcementAt;
  record.stateRevision += 1;
  return putWordRecord(record);
}

/** 重点易错专项不推进分轮；忘记时重新进入 +1 天强化链。 */
async function saveFocusPracticeAttempt(word, rating) {
  const oldRecord = await getWordProgress(word.id);
  if (!oldRecord) return savePlannedWordRating(word, rating, "primary");

  const record = ensureSchedulerRecord(word, oldRecord);
  const now = new Date().toISOString();
  record.reinforcementCount += 1;
  record.lastReinforcementRating = rating;
  record.lastReinforcementAt = now;
  if (rating === "forgot") {
    record.remediationActive = true;
    record.reviewStage = 0;
    record.nextReviewDate = addDaysToDateKey(getLocalDateKey(), FORGOT_INTERVALS[0]);
  }
  record.updatedAt = now;
  record.stateRevision += 1;
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
    cleanSession.schedulerVersion = SCHEDULER_VERSION;
    cleanSession.stateRevision = Math.max(0, Number(cleanSession.stateRevision) || 0) + 1;
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
  return records.filter(record => Boolean(record.remediationActive)).length;
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
