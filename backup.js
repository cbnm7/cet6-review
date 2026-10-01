// CET6 Review v2.2.1 — 向后兼容、事务式学习数据备份与恢复。
const BACKUP_FORMAT = "cet6-review-backup";
const BACKUP_SCHEMA_VERSION = 2;
const PRE_IMPORT_BACKUP_KEY = "study-backup-before-import";
const BACKUP_STORES = [WORD_STORE, DAILY_SESSION_STORE, LEGACY_DAILY_STORE, READING_WORD_STORE];
let studyBackupImportInProgress = false;

function getStoreAll(storeName) {
  return idbGetAll(storeName);
}

/** 同一只读事务获取学习数据与迁移标记，避免多次独立读取拼出不同时间的快照。 */
function readStudySnapshot() {
  if (!reviewDB) return Promise.reject(new Error("复习数据库尚未初始化"));
  const names = [...BACKUP_STORES, META_STORE].filter(name => reviewDB.objectStoreNames.contains(name));
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(names, "readonly");
    const stores = Object.fromEntries(BACKUP_STORES.map(name => [name, []]));
    let migration = null;
    tx.oncomplete = () => resolve({ stores, migration });
    tx.onerror = () => reject(tx.error || new Error("读取备份失败"));
    tx.onabort = () => reject(tx.error || new Error("读取备份被中止"));
    for (const name of BACKUP_STORES) {
      if (!names.includes(name)) continue;
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => { stores[name] = request.result || []; };
    }
    if (names.includes(META_STORE)) {
      const request = tx.objectStore(META_STORE).get(SCHEDULER_MIGRATION_KEY);
      request.onsuccess = () => { migration = request.result || null; };
    }
  });
}

async function buildStudyBackup() {
  const { stores, migration } = await readStudySnapshot();
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: "2.2.1",
    scheduler: { version: SCHEDULER_VERSION, migration },
    exportedAt: new Date().toISOString(),
    note: "包含学习数据与调度迁移标记，不含账号凭据和词典缓存。恢复不会重新执行已完成的旧日期迁移；云同步仍按合并规则处理。",
    stores
  };
}

function backupFileName(prefix = "CET6-Review-backup") {
  const now = new Date();
  const day = getLocalDateKey(now);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, "0")).join("");
  return `${prefix}-${day}-${time}.json`;
}

function downloadStudyBackup(backup, prefix) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFileName(prefix);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportStudyBackup() {
  const backup = await buildStudyBackup();
  downloadStudyBackup(backup);
  return backup;
}

async function exportPreImportBackup() {
  const snapshot = await getMetaRecord(PRE_IMPORT_BACKUP_KEY);
  if (!snapshot?.backup) throw new Error("本机还没有导入前快照，请先使用“导出备份”保存当前数据。");
  downloadStudyBackup(snapshot.backup, "CET6-Review-before-import");
  return snapshot.backup;
}

function isBackupDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && getLocalDateKey(date) === value;
}

function validateStudyBackup(data) {
  if (!data || data.format !== BACKUP_FORMAT) throw new Error("不是 CET6 Review 的学习数据备份");
  if (![1, BACKUP_SCHEMA_VERSION].includes(Number(data.schemaVersion))) {
    throw new Error(`不支持的备份版本：${data.schemaVersion}；请先升级 App，不要修改备份版本号。`);
  }
  if (!data.stores || typeof data.stores !== "object" || Array.isArray(data.stores)) {
    throw new Error("备份文件缺少 stores 数据");
  }
  // 最小必要数据必须存在，不能把截断/损坏文件当作“空备份”清库。
  for (const name of [WORD_STORE, DAILY_SESSION_STORE]) {
    if (!Array.isArray(data.stores[name])) throw new Error(`备份缺少 ${name} 数组`);
  }
  const declaredVersion = Number(data.scheduler?.version || 0);
  const markerVersion = Number(data.scheduler?.migration?.version || 0);
  if (declaredVersion > SCHEDULER_VERSION || markerVersion > SCHEDULER_VERSION) {
    throw new Error("备份来自更新的调度器，请升级 App 后再导入。");
  }
  if (Number(data.schemaVersion) === 2 && declaredVersion !== SCHEDULER_VERSION) {
    throw new Error("备份缺少有效的调度器版本信息");
  }
  for (const name of BACKUP_STORES) {
    const records = data.stores[name];
    if (records == null) continue; // 兼容早期不含阅读生词/dailyStats 的文件。
    if (!Array.isArray(records)) throw new Error(`备份中的 ${name} 格式不正确`);
    const keys = new Set();
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${name} 中存在无效记录`);
      const key = name === WORD_STORE || name === READING_WORD_STORE ? record.id : record.date;
      if ((typeof key !== "string" && typeof key !== "number") || String(key) === "" ||
          (typeof key === "number" && !Number.isFinite(key))) throw new Error(`${name} 中存在无效主键`);
      if ((name === DAILY_SESSION_STORE || name === LEGACY_DAILY_STORE) && !isBackupDateKey(key)) {
        throw new Error(`${name} 中存在无效日期：${key}`);
      }
      // Word IDs 在应用层按字符串处理，数字/文本相同 ID 也视为重复。
      const signature = String(key);
      if (keys.has(signature)) throw new Error(`${name} 中存在重复主键：${key}`);
      keys.add(signature);
      if ((name === WORD_STORE || name === DAILY_SESSION_STORE) && Number(record.schedulerVersion) > SCHEDULER_VERSION) {
        throw new Error("备份包含更新版调度记录，请升级 App 后导入。");
      }
      if (name === DAILY_SESSION_STORE && record.queue != null && !Array.isArray(record.queue)) {
        throw new Error(`每日会话 ${key} 的队列无效`);
      }
    }
  }
  return true;
}

function prepareStudyBackupImport(data) {
  validateStudyBackup(data);
  const stores = structuredClone(data.stores);
  const words = stores[WORD_STORE];
  const sessions = stores[DAILY_SESSION_STORE];
  const hasLegacy = words.some(record => !(Number(record.schedulerVersion) >= SCHEDULER_VERSION)) ||
    sessions.some(record => String(record.date) >= SCHEDULER_V2_RESET_DATE &&
      !(Number(record.schedulerVersion) >= SCHEDULER_VERSION));
  // v2.2.0 的 schema=1 没有 appMeta；以记录版本判断，不能因此重跑旧迁移。
  // 混合备份也逐记录保护 v2 数据，不根据 appVersion 文本一刀切。
  if (hasLegacy) {
    const plan = buildSchedulerV2MigrationPlan(words, sessions);
    stores[WORD_STORE] = plan.wordProgress;
    stores[DAILY_SESSION_STORE] = plan.dailySessions;
    stores[LEGACY_DAILY_STORE] = (stores[LEGACY_DAILY_STORE] || []).filter(record =>
      String(record.date) < SCHEDULER_V2_RESET_DATE || Number(record.schedulerVersion) >= SCHEDULER_VERSION
    );
  }
  const sourceMarker = data.scheduler?.migration;
  const migration = Number(sourceMarker?.version) === SCHEDULER_VERSION
    ? { ...sourceMarker, key: SCHEDULER_MIGRATION_KEY }
    : { key: SCHEDULER_MIGRATION_KEY, version: SCHEDULER_VERSION,
        resetDate: SCHEDULER_V2_RESET_DATE, restoredAt: new Date().toISOString(),
        sourceAppVersion: String(data.appVersion || "unknown"), migratedLegacy: hasLegacy };
  return { stores, migration, migratedLegacy: hasLegacy };
}

/** 数据替换、导入前快照、迁移完成标记在同一事务中提交；任一步失败则全部回滚。 */
function replaceStudyStores(storesData, { migration, beforeBackup } = {}) {
  const stores = BACKUP_STORES.filter(name => reviewDB.objectStoreNames.contains(name));
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction([...stores, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("恢复学习数据失败"));
    tx.onabort = () => reject(tx.error || new Error("恢复学习数据被中止，原数据未替换"));
    try {
      for (const name of stores) {
        const store = tx.objectStore(name);
        store.clear();
        for (const item of (storesData[name] || [])) store.put(item);
      }
      const meta = tx.objectStore(META_STORE);
      if (beforeBackup) meta.put({ key: PRE_IMPORT_BACKUP_KEY, createdAt: new Date().toISOString(), backup: beforeBackup });
      // 不能写 version:0 再另开事务迁移，否则刷新/失败会留下待破坏的数据。
      meta.put(migration || { key: SCHEDULER_MIGRATION_KEY, version: SCHEDULER_VERSION,
        resetDate: SCHEDULER_V2_RESET_DATE, restoredAt: new Date().toISOString() });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

async function importStudyBackupFile(file) {
  if (!file) throw new Error("没有选择备份文件");
  if (studyBackupImportInProgress) throw new Error("正在导入，请勿重复操作");
  studyBackupImportInProgress = true;
  let cloudPaused = false;
  let success = false;
  try {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw new Error("备份文件不是有效 JSON"); }
    const prepared = prepareStudyBackupImport(data); // 验证完成前不进行任何数据库写入。
    if (window.CET6Cloud?.beginDataRestore) {
      await window.CET6Cloud.beginDataRestore();
      cloudPaused = true;
    }
    const beforeBackup = await buildStudyBackup();
    await replaceStudyStores(prepared.stores, { migration: prepared.migration, beforeBackup });
    success = true;
    return { ...data, restoreSummary: { migratedLegacy: prepared.migratedLegacy } };
  } finally {
    if (cloudPaused) window.CET6Cloud.endDataRestore({ success });
    studyBackupImportInProgress = false;
    if (success) {
      window.dispatchEvent(new CustomEvent("cet6-local-bulk-change", {
        detail: { reason: "backup-import" }
      }));
    }
  }
}
