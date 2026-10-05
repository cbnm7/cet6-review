const form = document.getElementById("wordForm");
const list = document.getElementById("wordList");
const count = document.getElementById("wordCount");
const saveButton = document.getElementById("saveButton");
const formMessage = document.getElementById("formMessage");

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
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
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
    list.innerHTML = `
      <div class="empty-state">
        <strong>还没有保存生词</strong>
        阅读时遇到真正不会的词，再记到这里。
      </div>`;
    return;
  }

  list.innerHTML = items.map(renderWord).join("");
  list.querySelectorAll("[data-delete-id]").forEach(button => {
    button.addEventListener("click", async () => {
      const item = items.find(row => Number(row.id) === Number(button.dataset.deleteId));
      if (!item) return;
      if (!confirm(`确定删除“${item.term}”吗？`)) return;
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

async function init() {
  try {
    await openReadingDB();
    await refreshList();
  } catch (error) {
    console.error(error);
    formMessage.textContent = error?.message || "本地数据加载失败";
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js?v=3.0.0").catch(error => {
        console.warn("Service Worker 注册失败：", error);
      });
    }, { once: true });
  }
}

init();
