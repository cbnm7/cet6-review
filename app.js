const form = document.getElementById("wordForm");
const list = document.getElementById("wordList");
const count = document.getElementById("wordCount");
const saveButton = document.getElementById("saveButton");
const formMessage = document.getElementById("formMessage");
const accountCard = document.getElementById("accountCard");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function friendlyCloudError(error) {
  const text = String(error?.message || error || "同步失败");
  const lower = text.toLowerCase();
  if (lower.includes("invalid login credentials")) return "邮箱或密码错误";
  if (lower.includes("email not confirmed")) return "邮箱尚未验证，请先打开验证邮件";
  if (lower.includes("user already registered")) return "这个邮箱已经注册，请直接登录";
  if (lower.includes("password") && lower.includes("6")) return "密码至少需要 6 位";
  if (lower.includes("row-level security") || lower.includes("permission") || lower.includes("42501")) {
    return "云端权限配置不完整，请执行项目里的 supabase-schema.sql";
  }
  return text;
}

function renderWord(item) {
  const source = item.source ? `<span>${escapeHtml(item.source)}</span>` : "";
  const occurrences = Math.max(1, Number(item.occurrenceCount) || 1);
  const updated = formatDate(item.updatedAt || item.createdAt);

  return `
    <article class="word-item">
      <div class="word-item-head">
        <div class="word-title-wrap">
          <h3>${escapeHtml(item.term)}</h3>
          ${item.meaning ? `<p class="word-meaning">${escapeHtml(item.meaning)}</p>` : ""}
        </div>
        <button class="delete-button" type="button" data-delete-id="${Number(item.id)}">删除</button>
      </div>
      ${item.sentence ? `<p class="word-sentence">${escapeHtml(item.sentence)}</p>` : ""}
      ${item.note ? `<p class="word-note">${escapeHtml(item.note)}</p>` : ""}
      <div class="word-meta">
        <span>遇见 ${occurrences} 次${updated ? ` · ${updated}` : ""}</span>
        ${source}
      </div>
    </article>
  `;
}

async function refreshList() {
  const items = await getAllReadingWords();
  count.textContent = String(items.length);

  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><strong>还没有保存生词</strong>阅读时遇到真正不会的词，再记到这里。</div>`;
    return;
  }

  list.innerHTML = items.map(renderWord).join("");
  list.querySelectorAll("[data-delete-id]").forEach(button => {
    button.addEventListener("click", async () => {
      const item = items.find(row => Number(row.id) === Number(button.dataset.deleteId));
      if (!item || !confirm(`确定删除“${item.term}”吗？\n\n登录状态下，这次删除会同步到云端，并让其他设备下次同步时一起删除。`)) return;
      button.disabled = true;
      try {
        await deleteReadingWord(item.id);
        await refreshList();
      } catch (error) {
        console.error(error);
        alert(error?.message || "删除失败");
        button.disabled = false;
      }
    });
  });
}

function renderAccount() {
  const cloud = window.ReadingWordsCloud;
  const status = cloud?.getStatus?.() || {
    ready: false, configured: false, signedIn: false, syncing: false, online: navigator.onLine,
    email: "", lastSyncAt: null, lastError: null
  };

  if (!status.ready) {
    accountCard.innerHTML = `<div class="account-loading">正在加载账号同步…</div>`;
    return;
  }

  if (!status.configured) {
    accountCard.innerHTML = `
      <div class="account-head"><div><h2>账号同步</h2><p>Supabase 配置缺失</p></div></div>
      <p class="cloud-message is-error">${escapeHtml(status.lastError || "请检查 supabase-config.js")}</p>`;
    return;
  }

  if (!status.signedIn) {
    accountCard.innerHTML = `
      <div class="account-head">
        <div><h2>账号同步</h2><p>登录后自动合并不同设备的生词；删除也会跨设备同步。</p></div>
        <span class="cloud-pill">${status.online ? "未登录" : "离线"}</span>
      </div>
      <form id="authForm" class="auth-form">
        <input id="cloudEmail" type="email" autocomplete="email" placeholder="邮箱" required>
        <input id="cloudPassword" type="password" autocomplete="current-password" minlength="6" placeholder="密码（至少 6 位）" required>
        <div class="auth-actions">
          <button class="primary-button compact" type="submit">登录</button>
          <button class="secondary-button" id="registerButton" type="button">注册</button>
        </div>
      </form>
      <p id="cloudMessage" class="cloud-message">${status.lastError ? escapeHtml(status.lastError) : "本地生词不会因为登录而被清空；首次登录会与云端双向合并。"}</p>`;
    bindAuthEvents();
    return;
  }

  accountCard.innerHTML = `
    <div class="account-head">
      <div><h2>账号同步</h2><p class="account-email">${escapeHtml(status.email)}</p></div>
      <span class="cloud-pill ${status.syncing ? "is-syncing" : ""}">${status.syncing ? "同步中…" : (status.online ? "已登录" : "离线")}</span>
    </div>
    <div class="sync-summary">
      ${status.lastSyncAt ? `上次同步：${escapeHtml(formatDateTime(status.lastSyncAt))}` : "等待首次同步"}
      <br>不同设备登录同一账号后会合并词条；云端删除墓碑会让旧设备同步删除，不会把旧词重新复活。
    </div>
    <div class="auth-actions">
      <button class="primary-button compact" id="syncNowButton" type="button" ${status.syncing || !status.online ? "disabled" : ""}>立即同步</button>
      <button class="secondary-button" id="logoutButton" type="button">退出登录</button>
    </div>
    <p id="cloudMessage" class="cloud-message ${status.lastError ? "is-error" : ""}">${status.lastError ? escapeHtml(status.lastError) : ""}</p>`;
  bindSignedInEvents();
}

function bindAuthEvents() {
  const cloud = window.ReadingWordsCloud;
  const formEl = document.getElementById("authForm");
  const message = document.getElementById("cloudMessage");
  formEl?.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("cloudEmail").value.trim();
    const password = document.getElementById("cloudPassword").value;
    message.textContent = "正在登录并合并数据…";
    try {
      await cloud.login(email, password);
    } catch (error) {
      message.textContent = friendlyCloudError(error);
      message.classList.add("is-error");
    }
  });

  document.getElementById("registerButton")?.addEventListener("click", async () => {
    const email = document.getElementById("cloudEmail").value.trim();
    const password = document.getElementById("cloudPassword").value;
    if (!email || password.length < 6) {
      message.textContent = "请输入有效邮箱和至少 6 位密码";
      message.classList.add("is-error");
      return;
    }
    message.textContent = "正在注册…";
    try {
      const result = await cloud.createAccount(email, password);
      message.classList.remove("is-error");
      message.textContent = result.requiresEmailConfirmation
        ? "账号已创建，请先到邮箱点击验证链接，再回来登录。"
        : "账号已创建并登录，正在合并数据。";
    } catch (error) {
      message.textContent = friendlyCloudError(error);
      message.classList.add("is-error");
    }
  });
}

function bindSignedInEvents() {
  const cloud = window.ReadingWordsCloud;
  const message = document.getElementById("cloudMessage");
  document.getElementById("syncNowButton")?.addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    message.classList.remove("is-error");
    message.textContent = "正在双向合并…";
    try {
      const result = await cloud.syncNow({ reason: "manual" });
      message.textContent = `同步完成：上传 ${result.uploaded}，下载/合并 ${result.downloaded}，同步删除 ${result.deleted}`;
      await refreshList();
    } catch (error) {
      message.textContent = friendlyCloudError(error);
      message.classList.add("is-error");
    } finally {
      renderAccount();
    }
  });

  document.getElementById("logoutButton")?.addEventListener("click", async () => {
    try {
      await cloud.logout();
    } catch (error) {
      message.textContent = friendlyCloudError(error);
      message.classList.add("is-error");
    }
  });
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  saveButton.disabled = true;
  formMessage.textContent = "正在保存…";

  try {
    const saved = await saveReadingWord({
      term: document.getElementById("term").value,
      meaning: document.getElementById("meaning").value,
      source: document.getElementById("source").value,
      sentence: document.getElementById("sentence").value,
      note: document.getElementById("note").value
    });
    form.reset();
    document.getElementById("term").focus();
    formMessage.textContent = `已保存：${saved.term}`;
    await refreshList();
  } catch (error) {
    console.error(error);
    formMessage.textContent = error?.message || "保存失败";
  } finally {
    saveButton.disabled = false;
  }
});

window.addEventListener("reading-words-cloud-status", renderAccount);
window.addEventListener("reading-words-cloud-data-updated", () => refreshList().catch(console.error));

async function init() {
  try {
    await openReadingDB();
    await refreshList();
  } catch (error) {
    console.error(error);
    formMessage.textContent = error?.message || "本地数据加载失败";
  }

  renderAccount();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js?v=3.1.0").catch(error => {
        console.warn("Service Worker 注册失败：", error);
      });
    }, { once: true });
  }
}

init();
