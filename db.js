// 阅读生词 - IndexedDB 本地持久化
// 继续使用旧 App 的数据库名、版本和 readingWords store，确保已有阅读生词直接保留。
// 本文件只访问 readingWords；其他旧对象仓库保持原样。
const DB_NAME = "cet6-review-db";
const DB_VERSION = 4;
const READING_WORD_STORE = "readingWords";

let readingDB = null;

function normalizeReadingTerm(term) {
  return String(term || "").trim().replace(/\s+/g, " ").toLowerCase();
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
      }
    };

    request.onsuccess = event => {
      readingDB = event.target.result;
      readingDB.onversionchange = () => {
        readingDB.close();
        readingDB = null;
      };
      resolve(readingDB);
    };

    request.onerror = () => reject(request.error || new Error("无法打开本地数据库"));
    request.onblocked = () => reject(new Error("数据库升级被其他页面阻止，请关闭旧页面后重试"));
  });
}

async function findReadingWordByNormalizedTerm(normalizedTerm) {
  const db = await openReadingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(READING_WORD_STORE, "readonly");
    const store = tx.objectStore(READING_WORD_STORE);
    const index = store.index("normalizedTerm");
    const request = index.get(normalizedTerm);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function saveReadingWord({ term, meaning = "", source = "", sentence = "", note = "" }) {
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
  record.occurrenceCount = Math.max(0, Number(record.occurrenceCount) || 0) + 1;
  record.updatedAt = now;

  const db = await openReadingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(READING_WORD_STORE, "readwrite");
    const store = tx.objectStore(READING_WORD_STORE);
    const request = existing ? store.put(record) : store.add(record);

    request.onsuccess = () => {
      if (!existing) record.id = request.result;
      resolve(record);
    };
    request.onerror = () => reject(request.error);
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

async function deleteReadingWord(id) {
  const db = await openReadingDB();
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) throw new Error("无效词条");

  return new Promise((resolve, reject) => {
    const tx = db.transaction(READING_WORD_STORE, "readwrite");
    const request = tx.objectStore(READING_WORD_STORE).delete(numericId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
