// 阅读生词 v3.2.0 — 原数据库 v5，不升级、不清库；所有编辑/改名和墓碑在同一事务中提交。
const DB_NAME = "cet6-review-db";
const DB_VERSION = 5;
const READING_WORD_STORE = "readingWords";
const TOMBSTONE_STORE = "readingWordTombstones";
const RWModel = globalThis.ReadingWordsModel;
let readingDB = null;
let readingDBPromise = null;
const normalizeReadingTerm = RWModel.normalize;
const clonePlain = value => value == null ? value : JSON.parse(JSON.stringify(value));

let readingDeviceId;
try {
  readingDeviceId = localStorage.getItem("reading-words-device-v2") || crypto.randomUUID();
  localStorage.setItem("reading-words-device-v2", readingDeviceId);
} catch { readingDeviceId = crypto.randomUUID(); }
const readingChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("reading-words-data-v2") : null;
readingChannel?.addEventListener("message", event => {
  window.dispatchEvent(new CustomEvent("reading-words-peer-change", { detail: event.data }));
});
function emitLocalSyncChange(detail) {
  window.dispatchEvent(new CustomEvent("reading-words-local-change", { detail }));
  readingChannel?.postMessage({ operation: detail.operation, at: Date.now() });
}
function readingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function openReadingDB() {
  if (readingDB) return Promise.resolve(readingDB);
  if (readingDBPromise) return readingDBPromise;
  readingDBPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      const store = db.objectStoreNames.contains(READING_WORD_STORE)
        ? request.transaction.objectStore(READING_WORD_STORE)
        : db.createObjectStore(READING_WORD_STORE, { keyPath: "id", autoIncrement: true });
      if (!store.indexNames.contains("normalizedTerm")) store.createIndex("normalizedTerm", "normalizedTerm", { unique: false });
      if (!store.indexNames.contains("updatedAt")) store.createIndex("updatedAt", "updatedAt", { unique: false });
      if (!db.objectStoreNames.contains(TOMBSTONE_STORE)) {
        db.createObjectStore(TOMBSTONE_STORE, { keyPath: "normalizedTerm" })
          .createIndex("deletedAt", "deletedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      readingDB = request.result;
      readingDB.onversionchange = () => { readingDB.close(); readingDB = null; readingDBPromise = null; };
      readingDB.onclose = () => { readingDB = null; readingDBPromise = null; };
      window.READING_WORDS_DB_READY = true;
      window.dispatchEvent(new CustomEvent("reading-words-db-ready"));
      resolve(readingDB);
    };
    request.onerror = () => { readingDBPromise = null; reject(request.error || new Error("无法打开本地数据库")); };
    request.onblocked = () => {
      window.dispatchEvent(new CustomEvent("reading-words-db-blocked"));
    };
  });
  return readingDBPromise;
}

// 所有读-改-写在一个 readwrite 事务内完成，避免 await 网络时覆盖用户刚输入的数据。
async function readingTransaction(mode, run) {
  const db = await openReadingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([READING_WORD_STORE, TOMBSTONE_STORE], mode);
    let result, error;
    const fail = value => { error = value; try { tx.abort(); } catch {} };
    const on = (request, callback) => {
      request.onsuccess = () => { try { callback(request.result); } catch (e) { fail(e); } };
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(error || tx.error || new Error("本地数据操作已取消"));
    tx.onerror = () => { error ||= tx.error; };
    try {
      run({ tx, words: tx.objectStore(READING_WORD_STORE), tombstones: tx.objectStore(TOMBSTONE_STORE),
        on, done: value => { result = value; }, fail });
    } catch (e) { fail(e); }
  });
}
function readKeyInTransaction(ctx, key, callback) {
  let rows, tombstone;
  const finish = () => { if (rows !== undefined && tombstone !== undefined) callback(rows, tombstone); };
  ctx.on(ctx.words.index("normalizedTerm").getAll(key), value => { rows = value; finish(); });
  ctx.on(ctx.tombstones.get(key), value => { tombstone = value || null; finish(); });
}
function stateFromRows(rows, tombstone) {
  return rows.reduce((state, row) => RWModel.mergeStates(state, RWModel.wordState(row)), RWModel.deletedState(tombstone));
}
function storeState(ctx, rows, state) {
  if (!state) return;
  if (state.kind === "deleted") {
    rows.forEach(row => ctx.words.delete(row.id));
    ctx.tombstones.put(state.tombstone);
  } else {
    const stored = { ...state.word };
    if (rows[0]?.id != null) stored.id = rows[0].id;
    ctx.words.put(stored);
    rows.slice(1).forEach(row => ctx.words.delete(row.id));
    ctx.tombstones.delete(state.key);
  }
}
async function getReadingWordById(id) {
  return readingTransaction("readonly", c => c.on(c.words.get(Number(id)), row => c.done(row || null)));
}
async function findReadingWordByNormalizedTerm(term) {
  return readingTransaction("readonly", c => c.on(c.words.index("normalizedTerm").get(normalizeReadingTerm(term)), row => c.done(row || null)));
}
async function getReadingWordTombstone(term) {
  return readingTransaction("readonly", c => c.on(c.tombstones.get(normalizeReadingTerm(term)), row => c.done(row || null)));
}
async function getAllReadingWordTombstones() {
  return readingTransaction("readonly", c => c.on(c.tombstones.getAll(), rows => c.done(rows)));
}
async function getAllReadingWords() {
  return readingTransaction("readonly", c => c.on(c.words.getAll(), rows => {
    rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    c.done(rows);
  }));
}
async function getReadingSyncSnapshot() {
  return readingTransaction("readonly", c => {
    let words, tombstones;
    const finish = () => { if (words && tombstones) c.done({ words, tombstones }); };
    c.on(c.words.getAll(), rows => { words = rows; finish(); });
    c.on(c.tombstones.getAll(), rows => { tombstones = rows; finish(); });
  });
}
async function getReadingState(term) {
  const key = normalizeReadingTerm(term);
  return readingTransaction("readonly", c => readKeyInTransaction(c, key, (rows, tombstone) => c.done(stateFromRows(rows, tombstone))));
}

// 新增/再次遇见：保留旧版“只填非空字段 + 次数加一”行为。编辑必须用 updateReadingWord。
async function saveReadingWord(input) {
  const term = String(input?.term || "").trim().replace(/\s+/g, " ");
  const key = normalizeReadingTerm(term);
  if (!key) throw new Error("请输入单词或短语");
  const result = await readingTransaction("readwrite", c => readKeyInTransaction(c, key, (rows, tombstone) => {
    const state = stateFromRows(rows, tombstone);
    const existing = state?.kind === "word" ? state.word : null;
    const at = RWModel.nextTime(existing, tombstone);
    const patch = { term };
    RWModel.FIELDS.slice(1).forEach(f => { if (String(input[f] ?? "").trim()) patch[f] = input[f]; });
    let record = RWModel.patchWord(existing || { term, normalizedTerm: key, createdAt: at, updatedAt: at }, patch, readingDeviceId, at);
    record.occurrenceCount = existing ? existing.occurrenceCount + 1 : 1;
    if (!existing) {
      record.generationAt = at;
      record.restoredAfter = tombstone?.deletedAt || "";
    }
    if (rows[0]?.id != null) record.id = rows[0].id;
    c.on(c.words.put(record), id => { record.id = id; c.done(record); });
    rows.slice(1).forEach(row => c.words.delete(row.id));
    c.tombstones.delete(key);
  }));
  emitLocalSyncChange({ operation: "put", normalizedTerm: key });
  return result;
}

// base 是打开编辑表单时的副本。只提交改过的字段；冲突时保留草稿并要求重新核对。
async function updateReadingWord(id, patch, { base = null } = {}) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error("无效词条");
  const result = await readingTransaction("readwrite", c => c.on(c.words.get(numericId), current => {
    if (!current) throw readingError("WORD_GONE", "该词条已被其他设备删除或改名。草稿已保留，请先核对列表；不会自动重新创建旧词条。");
    const clean = RWModel.cleanWord(current);
    if (base && normalizeReadingTerm(base.normalizedTerm || base.term) !== clean.normalizedTerm) {
      throw readingError("EDIT_CONFLICT", "该词条已被其他页面改名，请先取消编辑再重新打开。当前草稿未提交。");
    }
    const changes = {};
    for (const field of RWModel.FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      let value = String(patch[field] ?? "").trim();
      if (field === "term") value = value.replace(/\s+/g, " ");
      if (base && clean[field] !== String(base[field] ?? "") && clean[field] !== value) {
        throw readingError("EDIT_CONFLICT", "你正在修改的字段也被其他设备更新了。草稿已保留，请核对后取消编辑并重新打开，避免覆盖对方修改。");
      }
      if (value !== clean[field]) changes[field] = value;
    }
    if (Object.keys(changes).length === 0) { c.done(current); return; }
    const newKey = normalizeReadingTerm(changes.term ?? clean.term);
    if (!newKey) throw new Error("请输入单词或短语");
    readKeyInTransaction(c, newKey, (targetRows, targetTombstone) => {
      if (targetRows.some(row => row.id !== numericId)) {
        throw readingError("TERM_EXISTS", "已有相同单词或短语。请修改已有词条，或先整理重复内容；本次不会覆盖任何词条。");
      }
      const at = RWModel.nextTime(clean, targetTombstone);
      const updated = RWModel.patchWord(clean, changes, readingDeviceId, at);
      updated.id = numericId;
      if (newKey !== clean.normalizedTerm) {
        c.tombstones.put(RWModel.cleanTombstone({ normalizedTerm: clean.normalizedTerm, deletedAt: at }));
        updated.generationAt = at;
        updated.restoredAfter = targetTombstone?.deletedAt || "";
      }
      c.words.put(updated);
      c.tombstones.delete(newKey);
      c.done(updated);
    });
  }));
  emitLocalSyncChange({ operation: "edit", normalizedTerm: result.normalizedTerm });
  return result;
}
async function deleteReadingWord(id) {
  const result = await readingTransaction("readwrite", c => c.on(c.words.get(Number(id)), row => {
    if (!row) { c.done(false); return; }
    const key = normalizeReadingTerm(row.normalizedTerm || row.term);
    readKeyInTransaction(c, key, (rows, tombstone) => {
      const at = RWModel.nextTime(row, tombstone);
      rows.forEach(r => c.words.delete(r.id));
      c.tombstones.put(RWModel.cleanTombstone({ normalizedTerm: key, deletedAt: at }));
      c.done(true);
    });
  }));
  if (result) emitLocalSyncChange({ operation: "delete" });
  return result;
}
async function applyReadingStateFromCloud(remoteState) {
  if (!remoteState?.key) throw new Error("云端词条缺少键");
  return readingTransaction("readwrite", c => readKeyInTransaction(c, remoteState.key, (rows, tombstone) => {
    const local = stateFromRows(rows, tombstone);
    const merged = RWModel.mergeStates(local, remoteState);
    if (!RWModel.equalStates(local, merged) || rows.length > 1 || (rows.length && tombstone)) storeState(c, rows, merged);
    c.done(merged);
  }));
}
