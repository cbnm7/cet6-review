// =======================================
// CET6 Review - backup.js
// 学习数据导出 / 导入
// =======================================

const BACKUP_FORMAT = "cet6-review-backup";
const BACKUP_SCHEMA_VERSION = 1;

const BACKUP_STORES = [
  WORD_STORE,
  DAILY_SESSION_STORE,
  LEGACY_DAILY_STORE,
  READING_WORD_STORE
];

function getStoreAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function buildStudyBackup() {
  if (!reviewDB) throw new Error("复习数据库尚未初始化");

  const stores = {};

  for (const storeName of BACKUP_STORES) {
    if (reviewDB.objectStoreNames.contains(storeName)) {
      stores[storeName] = await getStoreAll(storeName);
    } else {
      stores[storeName] = [];
    }
  }

  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: "2.0",
    exportedAt: new Date().toISOString(),
    note: "增强词典缓存不包含在备份内；Supabase 云同步数据可在恢复后点击立即同步进行合并。",
    stores
  };
}

function backupFileName() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0")
  ].join("");
  return `CET6-Review-backup-${date}-${time}.json`;
}

async function exportStudyBackup() {
  const backup = await buildStudyBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFileName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return backup;
}

function validateStudyBackup(data) {
  if (!data || data.format !== BACKUP_FORMAT) {
    throw new Error("不是 CET6 Review 的学习数据备份");
  }
  if (Number(data.schemaVersion) !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`不支持的备份版本：${data.schemaVersion}`);
  }
  if (!data.stores || typeof data.stores !== "object") {
    throw new Error("备份文件缺少 stores 数据");
  }

  for (const storeName of BACKUP_STORES) {
    if (data.stores[storeName] != null && !Array.isArray(data.stores[storeName])) {
      throw new Error(`备份中的 ${storeName} 格式不正确`);
    }
  }

  return true;
}

function replaceStudyStores(storesData) {
  const stores = BACKUP_STORES.filter(name => reviewDB.objectStoreNames.contains(name));

  return new Promise((resolve, reject) => {
    const tx = reviewDB.transaction(stores, "readwrite");

    for (const storeName of stores) {
      const store = tx.objectStore(storeName);
      const clearRequest = store.clear();

      clearRequest.onsuccess = () => {
        for (const item of (storesData[storeName] || [])) {
          store.put(item);
        }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("恢复学习数据失败"));
    tx.onabort = () => reject(tx.error || new Error("恢复学习数据被中止"));
  });
}

async function importStudyBackupFile(file) {
  if (!file) throw new Error("没有选择备份文件");
  const text = await file.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是有效 JSON");
  }

  validateStudyBackup(data);
  await replaceStudyStores(data.stores);
  window.dispatchEvent(new CustomEvent("cet6-local-bulk-change", {
    detail: { reason: "backup-import" }
  }));
  return data;
}
