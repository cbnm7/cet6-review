// CET6 Review v2.2.2 — 更新提示，不在正在作答/导入时强制刷新。
const PWA_APP_VERSION = "2.2.2";
let deferredInstallPrompt = null;
let serviceWorkerRegistration = null;
let availableAppVersion = null;
let lastUpdateCheckAt = 0;

function isStandaloneMode() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}
function getPWAStatus() {
  return { installed: isStandaloneMode(), canPrompt: Boolean(deferredInstallPrompt),
    online: navigator.onLine, updateVersion: availableAppVersion };
}
async function requestPWAInstall() {
  if (isStandaloneMode()) return { outcome: "already-installed" };
  if (!deferredInstallPrompt) return { outcome: "manual" };
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  return choice;
}

function isNewerAppVersion(version, current = PWA_APP_VERSION) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) return false;
  const a = String(version).split(".").map(Number);
  const b = String(current).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function showAppUpdateNotice(version) {
  if (!isNewerAppVersion(version)) return;
  availableAppVersion = version;
  let notice = document.getElementById("appUpdateNotice");
  if (!notice) {
    notice = document.createElement("aside");
    notice.id = "appUpdateNotice";
    notice.className = "app-update-notice";
    notice.setAttribute("role", "status");
    const label = document.createElement("span");
    label.className = "app-update-label";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "刷新更新";
    button.addEventListener("click", () => {
      if ((window.CET6CanReload && !window.CET6CanReload()) || window.CET6Cloud?.getStatus?.().syncing) {
        label.textContent = "正在保存/同步，请稍后再点刷新。";
        return;
      }
      window.location.reload();
    });
    notice.append(label, button);
    document.body.appendChild(notice);
  }
  notice.querySelector(".app-update-label").textContent = `新版本 ${version} 已就绪，学习记录保留。`;
}

async function queryActiveWorkerVersion() {
  const worker = navigator.serviceWorker?.controller || serviceWorkerRegistration?.active;
  if (!worker) return null;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = value => { clearTimeout(timer); channel.port1.close(); resolve(value); };
    const timer = setTimeout(() => finish(null), 2000);
    channel.port1.onmessage = event => {
      if (event.data?.type === "CET6_SW_VERSION") {
        showAppUpdateNotice(event.data.version);
        finish(event.data.version);
      }
    };
    worker.postMessage({ type: "CET6_GET_SW_VERSION" }, [channel.port2]);
  });
}

async function checkPWAUpdate({ force = false } = {}) {
  if (!navigator.onLine || !serviceWorkerRegistration) return { checked: false, version: availableAppVersion };
  if (!force && Date.now() - lastUpdateCheckAt < 60000) return { checked: false, version: availableAppVersion };
  lastUpdateCheckAt = Date.now();
  await serviceWorkerRegistration.update();
  const version = await queryActiveWorkerVersion();
  return { checked: true, version, installing: Boolean(serviceWorkerRegistration.installing) };
}

async function registerPWA() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" });
    serviceWorkerRegistration.addEventListener("updatefound", () => {
      const worker = serviceWorkerRegistration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "activated") queryActiveWorkerVersion().catch(() => {});
      });
    });
    checkPWAUpdate({ force: true }).catch(() => {});
    return serviceWorkerRegistration;
  } catch (error) {
    console.warn("Service Worker 注册失败：", error);
    return null;
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data?.type === "CET6_SW_VERSION") showAppUpdateNotice(event.data.version);
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => { queryActiveWorkerVersion().catch(() => {}); });
}
window.addEventListener("online", () => { checkPWAUpdate().catch(() => {}); });
window.addEventListener("focus", () => { checkPWAUpdate().catch(() => {}); });
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  window.dispatchEvent(new CustomEvent("cet6-install-available"));
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  window.dispatchEvent(new CustomEvent("cet6-app-installed"));
});
registerPWA();
