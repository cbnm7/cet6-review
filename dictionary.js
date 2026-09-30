// CET6 Review v2.1.3 — 本地精简词典
// 只读取随工程打包的词性/中文释义。旧在线词典不再参与合并。
// 只更新 cet6-dictionary-db；不会修改学习数据库或 Supabase。
const DICT_DB_NAME = "cet6-dictionary-db";
const DICT_DB_VERSION = 3; // 保持原数据库版本，使用数据版本作非破坏性迁移
const DICT_ENTRY_STORE = "entries";
const DICT_META_STORE = "meta";
const DICTIONARY_QUALITY_VERSION = "2.1.3-concise-1";
let dictionaryDB = null;
let localDictionaryMap = null;
let dictionarySeedTask = null;

function normalizeDictionaryTerm(term) {
  return String(term || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function getBundledDictionaryMap() {
  if (localDictionaryMap) return localDictionaryMap;
  const bundle = window.CET6_CONCISE_DICTIONARY;
  if (!bundle || bundle.version !== DICTIONARY_QUALITY_VERSION || !Array.isArray(bundle.entries)) {
    throw new Error("精简词典文件未正确加载。请完整上传 data/concise-dictionary.js 后更新页面，不要清除网站学习数据。");
  }
  const map = new Map();
  for (const row of bundle.entries) {
    const key = normalizeDictionaryTerm(row.term);
    if (!key || map.has(key) || !Array.isArray(row.translations)) {
      throw new Error("内置词典条目格式错误或词头重复：" + key);
    }
    const seen = new Set();
    const translations = row.translations.map(item => {
      const type = String(item.type || "").trim();
      const translation = String(item.translation || "").trim();
      if (!type || !translation || seen.has(type)) throw new Error("词性/释义格式错误：" + key);
      seen.add(type);
      return { type, translation };
    });
    if (!translations.length && !row.needsReview) throw new Error("词典释义为空：" + key);
    // 白名单重建，不接收上游短语、例句等额外字段。
    map.set(key, {
      term: row.term, key, normalizedTerm: key, translations,
      needsReview: Boolean(row.needsReview), note: String(row.note || ""),
      qualityVersion: DICTIONARY_QUALITY_VERSION,
      sources: ["本地精简词典 · v2.1.3"],
      us: "", uk: ""
    });
  }
  if (map.size !== bundle.headwordCount) throw new Error("精简词典数量校验失败。");
  localDictionaryMap = map;
  return map;
}

function initDictionaryDB() {
  getBundledDictionaryMap();
  if (dictionaryDB) return Promise.resolve(dictionaryDB);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DICT_DB_NAME, DICT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DICT_ENTRY_STORE)) db.createObjectStore(DICT_ENTRY_STORE, { keyPath: "normalizedTerm" });
      if (!db.objectStoreNames.contains(DICT_META_STORE)) db.createObjectStore(DICT_META_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => {
      dictionaryDB = request.result;
      dictionaryDB.onversionchange = () => { dictionaryDB.close(); dictionaryDB = null; };
      resolve(dictionaryDB);
    };
    request.onerror = () => reject(request.error || new Error("词典缓存打开失败。"));
    request.onblocked = () => reject(new Error("词典缓存被旧页面占用，请关闭其它 CET6 页面后重新打开。"));
  });
}

function dictionaryRead(storeName, key) {
  if (!dictionaryDB) return Promise.reject(new Error("词典缓存尚未就绪。"));
  return new Promise((resolve, reject) => {
    const tx = dictionaryDB.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = key === undefined ? store.getAll() : store.get(key);
    let result;
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error || req.error || new Error("读取词典缓存失败。"));
  });
}

async function getDictionaryEntry(term) {
  const row = getBundledDictionaryMap().get(normalizeDictionaryTerm(term));
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

async function getAllDictionaryEntries() {
  return Array.from(getBundledDictionaryMap().values()).map(row => JSON.parse(JSON.stringify(row)));
}

async function getDictionaryMeta(key) {
  if (!dictionaryDB) return null;
  return (await dictionaryRead(DICT_META_STORE, key)) || null;
}

async function getDictionaryCoverage(vocabulary) {
  const map = getBundledDictionaryMap();
  const keys = new Set((vocabulary || []).map(row => normalizeDictionaryTerm(row.term)).filter(Boolean));
  let matched = 0, reviewed = 0, flagged = 0;
  for (const key of keys) {
    const row = map.get(key);
    if (!row) continue;
    reviewed++;
    if (row.needsReview) flagged++;
    if (row.translations.length) matched++;
  }
  return {
    target: keys.size, matched, reviewed, flagged, missing: keys.size - reviewed,
    // 向下保留一位小数，不能把 1989/1992 四舍五入显示成 100%。
    percent: keys.size ? Math.floor(matched / keys.size * 1000) / 10 : 0,
    version: DICTIONARY_QUALITY_VERSION
  };
}

async function syncDictionaryForVocabulary(vocabulary, options = {}) {
  if (dictionarySeedTask) return dictionarySeedTask;
  dictionarySeedTask = (async () => {
    await initDictionaryDB();
    const map = getBundledDictionaryMap();
    options.onProgress?.({ stage: "loading", source: "本地精简词典" });
    const oldRows = await dictionaryRead(DICT_ENTRY_STORE);
    // 本次不审音标：仅延续旧缓存的音标，不从旧缓存读取任何释义、搭配或例句。
    for (const old of oldRows || []) {
      const current = map.get(normalizeDictionaryTerm(old.normalizedTerm || old.key || old.term));
      if (!current) continue;
      for (const label of ["us", "uk"]) {
        if (typeof old[label] === "string" && old[label].length <= 160) current[label] = old[label];
      }
    }
    const oldMeta = await getDictionaryMeta("sync");
    const coverage = await getDictionaryCoverage(vocabulary);
    if (oldMeta?.qualityVersion === DICTIONARY_QUALITY_VERSION && oldRows.length === map.size && !options.force) {
      options.onProgress?.({ stage: "complete", coverage });
      return { coverage, meta: oldMeta, cached: true };
    }
    const meta = {
      key: "sync", qualityVersion: DICTIONARY_QUALITY_VERSION,
      lastSyncAt: new Date().toISOString(), coverage,
      errors: [], sourceMode: "bundled-local-only"
    };
    await new Promise((resolve, reject) => {
      const tx = dictionaryDB.transaction([DICT_ENTRY_STORE, DICT_META_STORE], "readwrite");
      const store = tx.objectStore(DICT_ENTRY_STORE);
      // 清理 + 写入在同一事务内；失败时原词典缓存会回滚，而不是留下半份词典。
      store.clear();
      for (const row of map.values()) store.put(row);
      tx.objectStore(DICT_META_STORE).put(meta);
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("精简词典缓存更新失败。"));
    });
    options.onProgress?.({ stage: "complete", coverage });
    return { coverage, meta, cached: false };
  })();
  try { return await dictionarySeedTask; }
  finally { dictionarySeedTask = null; }
}

// 保留原 App 的入口名称，但实际执行的是整份本地词典的安全迁移。
function seedLocalDictionarySupplements(vocabulary) {
  return syncDictionaryForVocabulary(vocabulary);
}
function ensureDictionaryData(vocabulary, options = {}) {
  return syncDictionaryForVocabulary(vocabulary, options);
}
