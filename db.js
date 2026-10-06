// 阅读生词 v3.1.0 - IndexedDB 本地持久化 + 同步删除墓碑
// 保留原数据库与 readingWords 对象仓库，升级时只新增 readingWordTombstones，绝不清空旧数据。
const DB_NAME = "cet6-review-db";
const DB_VERSION = 5;
const READING_WORD_STORE = "readingWords";
const TOMBSTONE_STORE = "readingWordTombstones";

let readingDB = null;

function normalizeReadingTerm(term) {
  return String(term || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function clonePlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function emitLocalSyncChange(detail) {
  window.dispatchEvent(new CustomEvent("reading-words-local-change", { detail }));
}

function openReadingDB() {
  if (readingDB) return Promise.resolve(readingDB);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(READING_WORD_STORE)) {
        const store = db.createObjectStore(READING_WORD_STORE, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("normalizedTerm", "normalizedTerm", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      } else {
        const store = request.transaction.objectStore(READING_WORD_STORE);
        if (!store.indexNames.contains("normalizedTerm")) {
          store.createIndex("normalizedTerm", "normalizedTerm", { unique: false });
        }
        if (!store.indexNames.contains("updatedAt")) {
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      }

      if (!db.objectStoreNames.contains(TOMBSTONE_STORE)) {
        const tombstones = db.createObjectStore(TOMBSTONE_STORE, { keyPath: "normalizedTerm" });
        tombstones.createIndex("deletedAt", "deletedAt", { unique: false });
      }
    };

    request.onsuccess = event => {
      readingDB = event.target.result;
      readingDB.onversionchange = () => {
        readingDB.close();
        readingDB = null;
      };
      window.READING_WORDS_DB_READY = true;
      window.dispatchEvent(new CustomEvent("reading-words-db-ready"));
      resolve(readingDB);
    };

    request.onerror = () => reject(request.error || new Error("无法打开本地数据库"));
    request.onblocked = () => reject(new Error("数据库升级被其他页面阻止，请关闭旧页面后重试"));
  });
}

async function findReadingWordByNormalizedTerm(normalizedTerm) {
  const db = await openReadingDB();
  const key = normalizeReadingTerm(normalizedTerm);
  if (!key) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(READING_WORD_STORE, "readonly");
    const request = tx.objectStore(READING_WORD_STORE).index("normalizedTerm").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getReadingWordTombstone(normalizedTerm) {
  const db = await openReadingDB();
  const key = normalizeReadingTerm(normalizedTerm);
  if (!key) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TOMBSTONE_STORE, "readonly");
    const request = tx.objectStore(TOMBSTONE_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getAllReadingWordTombstones() {
  const db = await openReadingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TOMBSTONE_STORE, "readonly");
    const request = tx.objectStore(TOMBSTONE_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function saveReadingWord({ term, meaning = "", source = "", sentence = "", note = "" }, { fromCloud = false } = {}) {
  const cleanTerm = String(term || "").trim().replace(/\s+/g, " ");
  if (!cleanTerm) throw new Error("请输入单词或短语");

  const normalizedTerm = normalizeReadingTerm(cleanTerm);
  const existing = await findReadingWordByNormalizedTerm(normalizedTerm);
  const now = new Date().toISOString();

  const record = existing ? { ...existing } : {
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
  record.occurrenceCount = Math.max(0, Number(record.occurrenceCount) || 0) + (fromCloud ? 0 : 1);
  if (fromCloud && !record.occurrenceCount) record.occurrenceCount = Math.max(1, Number(existing?.occurrenceCount) || 1);
  record.updatedAt = now;

  const db = await openReadingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([READING_WORD_STORE, TOMBSTONE_STORE], "readwrite");
    const words = tx.objectStore(READING_WORD_STORE);
    const tombstones = tx.objectStore(TOMBSTONE_STORE);
    const request = existing ? words.put(record) : words.add(record);

    request.onsuccess = () => {
      if (!existing) record.id = request.result;
      tombstones.delete(normalizedTerm);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      if (!fromCloud) {
        emitLocalSyncChange({ operation: "put", normalizedTerm, record: clonePlain(record) });
      }
      resolve(record);
    };
    tx.onerror = () => reject(tx.error || new Error("保存失败"));
    tx.onabort = () => reject(tx.error || new Error("保存失败"));
  });
}

async function getAllReadingWords() {
  const db = await openReadingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(READING_WORD_STORE, "readonly");
    const request = tx.objectStore(READING_WORD_STORE).getAll();
    request.onsuccess = () => {
      const items = request.result || [];
      items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      resolve(items);
    };
    request.onerror = () => reject(request.error);
  });
}

async function deleteReadingWord(id, { fromCloud = false, deletedAt = "" } = {}) {
  const db = await openReadingDB();
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) throw new Error("无效词条");

  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction(READING_WORD_STORE, "readonly");
    const request = tx.objectStore(READING_WORD_STORE).get(numericId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  if (!existing) return false;

  const normalizedTerm = normalizeReadingTerm(existing.normalizedTerm || existing.term);
  const when = deletedAt || new Date().toISOString();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([READING_WORD_STORE, TOMBSTONE_STORE], "readwrite");
    tx.objectStore(READING_WORD_STORE).delete(numericId);
    tx.objectStore(TOMBSTONE_STORE).put({ normalizedTerm, deletedAt: when, updatedAt: when });
    tx.oncomplete = () => {
      if (!fromCloud) emitLocalSyncChange({ operation: "delete", normalizedTerm, deletedAt: when });
      resolve(true);
    };
    tx.onerror = () => reject(tx.error || new Error("删除失败"));
    tx.onabort = () => reject(tx.error || new Error("删除失败"));
  });
}

async function applyReadingWordFromCloud(remoteRecord) {
  const normalizedTerm = normalizeReadingTerm(remoteRecord?.normalizedTerm || remoteRecord?.term);
  if (!normalizedTerm) throw new Error("云端词条缺少 normalizedTerm");

  const db = await openReadingDB();
  const existing = await findReadingWordByNormalizedTerm(normalizedTerm);
  const clean = {
    term: String(remoteRecord.term || normalizedTerm).trim(),
    normalizedTerm,
    meaning: String(remoteRecord.meaning || ""),
    source: String(remoteRecord.source || ""),
    sentence: String(remoteRecord.sentence || ""),
    note: String(remoteRecord.note || ""),
    occurrenceCount: Math.max(1, Number(remoteRecord.occurrenceCount) || 1),
    createdAt: remoteRecord.createdAt || existing?.createdAt || remoteRecord.updatedAt || new Date().toISOString(),
    updatedAt: remoteRecord.updatedAt || new Date().toISOString()
  };
  if (existing?.id != null) clean.id = existing.id;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([READING_WORD_STORE, TOMBSTONE_STORE], "readwrite");
    const words = tx.objectStore(READING_WORD_STORE);
    const request = existing ? words.put(clean) : words.add(clean);
    request.onsuccess = () => {
      if (!existing) clean.id = request.result;
      tx.objectStore(TOMBSTONE_STORE).delete(normalizedTerm);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(clean);
    tx.onerror = () => reject(tx.error || new Error("写入云端词条失败"));
    tx.onabort = () => reject(tx.error || new Error("写入云端词条失败"));
  });
}

async function applyReadingDeletionFromCloud(normalizedTerm, deletedAt) {
  const key = normalizeReadingTerm(normalizedTerm);
  if (!key) return false;
  const db = await openReadingDB();
  const existing = await findReadingWordByNormalizedTerm(key);
  const when = deletedAt || new Date().toISOString();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([READING_WORD_STORE, TOMBSTONE_STORE], "readwrite");
    if (existing?.id != null) tx.objectStore(READING_WORD_STORE).delete(existing.id);
    tx.objectStore(TOMBSTONE_STORE).put({ normalizedTerm: key, deletedAt: when, updatedAt: when });
    tx.oncomplete = () => resolve(Boolean(existing));
    tx.onerror = () => reject(tx.error || new Error("同步删除失败"));
    tx.onabort = () => reject(tx.error || new Error("同步删除失败"));
  });
}

async function clearReadingTombstone(normalizedTerm) {
  const db = await openReadingDB();
  const key = normalizeReadingTerm(normalizedTerm);
  if (!key) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TOMBSTONE_STORE, "readwrite");
    const request = tx.objectStore(TOMBSTONE_STORE).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
