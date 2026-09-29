// =======================================
// CET6 Review - pwa.js
// PWA 安装、离线状态与 Service Worker
// =======================================

let deferredInstallPrompt = null;
let serviceWorkerRegistration = null;

function isStandaloneMode() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.navigator.standalone === true;
}

function getPWAStatus() {
  if (isStandaloneMode()) {
    return { installed: true, canPrompt: false, online: navigator.onLine };
  }

  return {
    installed: false,
    canPrompt: Boolean(deferredInstallPrompt),
    online: navigator.onLine
  };
}

async function requestPWAInstall() {
  if (isStandaloneMode()) {
    return { outcome: "already-installed" };
  }

  if (!deferredInstallPrompt) {
    return { outcome: "manual" };
  }

  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  return choice;
}

async function registerPWA() {
  if (!("serviceWorker" in navigator)) {
    console.warn("当前浏览器不支持 Service Worker");
    return null;
  }

  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("./service-worker.js");
    serviceWorkerRegistration.update().catch(() => {});
    console.log("PWA Service Worker 已注册");
    return serviceWorkerRegistration;
  } catch (error) {
    console.warn("Service Worker 注册失败：", error);
    return null;
  }
}

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
