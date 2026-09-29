// =======================================
// CET6 Review - app.js
// v2.1.2 Supabase 多设备同步版
// 每日队列 + IndexedDB + 二档复习 + 阅读生词
// + 今日复习总览（三分类） + 重点易错 + 每日复习记录
// =======================================

const APP_VERSION = "2.1.2 Anti-Rollback Sync";

const app = document.querySelector(".app");
const homePageHTML = app.innerHTML;

let vocabulary = [];
let vocabularyMap = new Map();
let currentSession = null;
let isSaving = false;
let dictionarySyncTask = null;
let lastDictionaryCoverage = null;

// 重点易错专项复习（独立于今日队列，不改变今日完成进度）
let difficultPractice = null;

async function loadVocabulary() {
  const response = await fetch("./data/cet6_2003.json");

  if (!response.ok) {
    throw new Error(`词库加载失败：HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.entries)) {
    throw new Error("词库 JSON 中没有 entries 数组");
  }

  vocabulary = data.entries;
  vocabularyMap = new Map(vocabulary.map(word => [word.id, word]));

  console.log(`词库加载成功：${vocabulary.length}词`);
}

function bindHomeEvents() {
  const startBtn = document.getElementById("startReviewBtn");
  const todayOverviewBtn = document.getElementById("todayOverviewBtn");
  const difficultWordsBtn = document.getElementById("difficultWordsBtn");
  const readingWordsBtn = document.getElementById("readingWordsBtn");
  const dailyHistoryBtn = document.getElementById("dailyHistoryBtn");
  const settingsBtn = document.getElementById("settingsBtn");

  if (startBtn) {
    startBtn.addEventListener("click", startReview);
  }

  if (todayOverviewBtn) {
    todayOverviewBtn.addEventListener("click", showTodayOverviewPage);
  }

  if (difficultWordsBtn) {
    difficultWordsBtn.addEventListener("click", showDifficultWordsPage);
  }

  if (readingWordsBtn) {
    readingWordsBtn.addEventListener("click", showReadingWordsPage);
  }

  if (dailyHistoryBtn) {
    dailyHistoryBtn.addEventListener("click", showDailyHistoryPage);
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", showSettingsPage);
  }
}

async function refreshHomeStats() {
  const session = await getTodaySession();
  const forgottenCount = await getForgottenWordCount();
  const readingWordCount = await getReadingWordCount();

  let completed = 0;
  let total = DAILY_TARGET;

  if (session) {
    completed = session.primaryCompleted || 0;
    total = session.initialPrimaryCount || DAILY_TARGET;
  }

  const percentage = total > 0
    ? Math.min(100, Math.round((completed / total) * 100))
    : 100;

  const todayNumber = document.querySelector(".today-card h2");
  const progressText = document.querySelector(".progress-text");
  const progressValue = document.querySelector(".progress-value");
  const startBtn = document.getElementById("startReviewBtn");
  const stats = document.querySelectorAll(".stats strong");

  if (todayNumber) todayNumber.textContent = `${completed} / ${total}`;
  if (progressText) progressText.textContent = `${percentage}%`;
  if (progressValue) progressValue.style.width = `${percentage}%`;

  if (startBtn && session) {
    if (session.completedAt) {
      startBtn.textContent = "查看今日结果";
    } else if (session.cursor > 0) {
      startBtn.textContent = "继续今日复习";
    }
  }

  if (stats.length >= 3) {
    stats[0].textContent = completed;
    stats[1].textContent = forgottenCount;
    stats[2].textContent = readingWordCount;
  }
}

async function createTodaySession() {
  const progressRecords = await getAllWordProgress();
  const plan = buildDailyPrimaryQueue(vocabulary, progressRecords, DAILY_TARGET);
  const now = new Date().toISOString();

  const session = {
    date: getLocalDateKey(),
    queue: plan.items,
    cursor: 0,
    initialPrimaryCount: plan.items.length,
    primaryCompleted: 0,
    forgot: 0,
    know: 0,
    reinforcementAttempts: 0,
    reinsertedIds: [],
    primaryRatings: {},
    planMeta: plan.meta,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };

  await saveDailySession(session);
  return session;
}

async function prepareCloudBeforeStudy() {
  const cloud = window.CET6Cloud;
  const status = cloud?.getStatus?.();

  // 已登录且网络可用时，创建/修改今日学习数据之前先尽力完成首次云端合并。
  // 如果 Supabase 在当前网络不可达，不阻止离线学习；本地数据仍会保存，
  // 恢复联网后由防回退合并规则补齐。
  if (status?.signedIn && status?.online && !status?.initialSyncDone && cloud?.ensureInitialSync) {
    try {
      await cloud.ensureInitialSync();
    } catch (error) {
      console.warn("首次云端合并暂未完成，继续使用本地数据：", error);
    }
  }
}

async function startReview() {
  if (vocabulary.length === 0) {
    alert("词库尚未加载完成");
    return;
  }

  await prepareCloudBeforeStudy();
  currentSession = await getTodaySession();

  if (!currentSession) {
    currentSession = await createTodaySession();
  }

  ensureSessionCompat(currentSession);

  if (currentSession.completedAt || currentSession.cursor >= currentSession.queue.length) {
    showFinishPage();
    return;
  }

  if (currentSession.queue.length === 0) {
    showNoReviewPage();
    return;
  }

  showReviewPage();
}

function ensureSessionCompat(session) {
  if (!session.primaryRatings || typeof session.primaryRatings !== "object") {
    session.primaryRatings = {};
  }

  if (!Array.isArray(session.reinsertedIds)) {
    session.reinsertedIds = [];
  }
}

async function showReviewPage() {
  const item = currentSession.queue[currentSession.cursor];

  if (!item) {
    finishSession();
    return;
  }

  const word = vocabularyMap.get(item.id);

  if (!word) {
    console.error("找不到词条：", item.id);
    currentSession.cursor++;
    saveDailySession(currentSession).then(showReviewPage);
    return;
  }

  const dictionaryEntry = await getDictionaryEntry(word.term);
  const currentNumber = currentSession.cursor + 1;
  const totalAttempts = currentSession.queue.length;
  const progress = Math.round((currentSession.cursor / totalAttempts) * 100);
  const isReinforcement = item.type === "reinforcement";

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="backBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">TODAY REVIEW</p>
        <h1>今日复习</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="today-card">
      <div class="today-header">
        <div>
          <p class="section-label">本轮进度</p>
          <h2>${currentNumber} / ${totalAttempts}</h2>
        </div>
        <div class="progress-text">${progress}%</div>
      </div>

      <div class="progress-bar">
        <div class="progress-value" style="width:${progress}%"></div>
      </div>

      <div class="review-word-area">
        <p class="review-word-type">WORD</p>
        <div class="review-word">${escapeHtml(word.term)}</div>
        ${renderCompactPronunciation(dictionaryEntry)}
        ${isReinforcement ? '<span class="reinforcement-badge">本轮加练 · 明天仍会复习</span>' : ''}
      </div>

      <p class="review-hint">先凭记忆判断，作答后显示释义、搭配和例句。</p>

      <div class="rating-grid">
        <button class="rating-btn rating-forgot" data-rating="forgot">忘了</button>
        <button class="rating-btn rating-know" data-rating="know">认识</button>
      </div>

      <div class="review-stats">
        <span>首轮忘了 ${currentSession.forgot}</span>
        <span>首轮认识 ${currentSession.know}</span>
        <span>加练 ${currentSession.reinforcementAttempts}</span>
      </div>
    </section>
  `;

  bindReviewEvents();
}

function bindReviewEvents() {
  const backBtn = document.getElementById("backBtn");

  if (backBtn) {
    backBtn.addEventListener("click", showHomePage);
  }

  document.querySelectorAll(".rating-btn").forEach(button => {
    button.addEventListener("click", () => rateCurrentWord(button.dataset.rating));
  });
}

async function rateCurrentWord(rating) {
  if (isSaving) return;
  isSaving = true;

  const buttons = document.querySelectorAll(".rating-btn");
  buttons.forEach(button => (button.disabled = true));

  try {
    const item = currentSession.queue[currentSession.cursor];
    const word = vocabularyMap.get(item.id);

    if (!word) {
      throw new Error(`找不到词条：${item.id}`);
    }

    const wasReinforcement = item.type === "reinforcement";
    ensureSessionCompat(currentSession);

    if (item.type === "primary") {
      await savePrimaryWordRating(word, rating);
      currentSession.primaryCompleted++;
      currentSession.primaryRatings[word.id] = rating;

      if (rating === "forgot") {
        currentSession.forgot++;

        if (!currentSession.reinsertedIds.includes(word.id)) {
          insertReinforcement(
            currentSession.queue,
            currentSession.cursor,
            word.id,
            REINFORCEMENT_GAP
          );
          currentSession.reinsertedIds.push(word.id);
        }
      } else {
        currentSession.know++;
      }
    } else {
      await saveReinforcementAttempt(word, rating);
      currentSession.reinforcementAttempts++;
    }

    currentSession.cursor++;
    currentSession.updatedAt = new Date().toISOString();

    if (currentSession.cursor >= currentSession.queue.length) {
      currentSession.completedAt = new Date().toISOString();
    }

    await saveDailySession(currentSession);
    await showRatedAnswerPage(word, rating, wasReinforcement);
  } catch (error) {
    console.error("保存复习记录失败：", error);
    alert("复习记录保存失败，请重试。");
    buttons.forEach(button => (button.disabled = false));
  } finally {
    isSaving = false;
  }
}

async function showRatedAnswerPage(word, rating, wasReinforcement = false) {
  const dictionaryEntry = await getDictionaryEntry(word.term);
  const nextLabel = currentSession?.completedAt ? "查看今日结果" : "下一个词";

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="answerBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">WORD DETAIL</p>
        <h1>本词解析</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="answer-shell">
      <div class="answer-word-head">
        <div>
          <p class="section-label">${rating === "know" ? "你选择了：认识" : "你选择了：忘了"}</p>
          <h2>${escapeHtml(word.term)}</h2>
          ${renderCompactPronunciation(dictionaryEntry)}
        </div>
        <span class="answer-rating ${rating === "know" ? "answer-rating-know" : "answer-rating-forgot"}">
          ${rating === "know" ? "认识" : "忘了"}
        </span>
      </div>

      ${wasReinforcement ? '<p class="answer-reinforcement-note">这是本轮加练；加练结果不会覆盖明天的复习安排。</p>' : ''}

      ${renderDictionaryCard(dictionaryEntry, word.term)}

      <div class="answer-actions">
        ${rating === "know" ? '<button class="secondary-button" id="markMistakeBtn">记错了</button>' : ''}
        <button class="primary-button" id="nextAfterAnswerBtn">${nextLabel}</button>
      </div>
    </section>
  `;

  document.getElementById("answerBackBtn")?.addEventListener("click", showHomePage);

  document.getElementById("markMistakeBtn")?.addEventListener("click", async () => {
    await correctTodayAnswerToForgot(word, wasReinforcement);
  });

  document.getElementById("nextAfterAnswerBtn")?.addEventListener("click", () => {
    if (currentSession?.completedAt) {
      showFinishPage();
    } else {
      showReviewPage();
    }
  });
}

async function correctTodayAnswerToForgot(word, wasReinforcement = false) {
  if (isSaving || !currentSession) return;
  isSaving = true;

  const mistakeBtn = document.getElementById("markMistakeBtn");
  const nextBtn = document.getElementById("nextAfterAnswerBtn");
  if (mistakeBtn) mistakeBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;

  try {
    if (wasReinforcement) {
      await correctReinforcementKnowToForgot(word);
    } else {
      await correctPrimaryKnowToForgot(word);

      currentSession.know = Math.max(0, (currentSession.know || 0) - 1);
      currentSession.forgot = (currentSession.forgot || 0) + 1;
      currentSession.primaryRatings[word.id] = "forgot";

      if (!currentSession.reinsertedIds.includes(word.id)) {
        insertReinforcement(
          currentSession.queue,
          Math.max(0, currentSession.cursor - 1),
          word.id,
          REINFORCEMENT_GAP
        );
        currentSession.reinsertedIds.push(word.id);
      }

      // 如果这个词原本是本轮最后一个，“记错了”会新增一次加练，
      // 因此今日任务不能继续保持“已完成”。
      if (currentSession.cursor < currentSession.queue.length) {
        currentSession.completedAt = null;
      }
    }

    currentSession.updatedAt = new Date().toISOString();
    await saveDailySession(currentSession);

    await showRatedAnswerPage(word, "forgot", wasReinforcement);
  } catch (error) {
    console.error("更正为忘了失败：", error);
    alert("更正失败，请重试。");
    if (mistakeBtn) mistakeBtn.disabled = false;
    if (nextBtn) nextBtn.disabled = false;
  } finally {
    isSaving = false;
  }
}

async function finishSession() {
  currentSession.completedAt = currentSession.completedAt || new Date().toISOString();
  currentSession.updatedAt = new Date().toISOString();
  await saveDailySession(currentSession);
  showFinishPage();
}

function showFinishPage() {
  if (!currentSession) {
    showHomePage();
    return;
  }

  const meta = currentSession.planMeta || {};

  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="date">REVIEW COMPLETE</p>
        <h1>今日完成</h1>
      </div>
    </header>

    <section class="today-card">
      <div class="finish-total">
        <strong>${currentSession.initialPrimaryCount || 0}</strong>
        <span>今日首轮复习词</span>
      </div>

      <div class="finish-grid">
        ${createResultBox("忘了", currentSession.forgot || 0)}
        ${createResultBox("认识", currentSession.know || 0)}
      </div>

      <p class="finish-note">
        本轮加练 ${currentSession.reinforcementAttempts || 0} 次。<br>
        今日计划：忘记词 ${meta.forgottenDue || 0}，到期已认识词 ${meta.knownDueAdded || 0}，顺序新增 ${meta.newAdded || 0}。
      </p>

      <button class="primary-button" id="finishBtn">返回首页</button>
    </section>
  `;

  document.getElementById("finishBtn").addEventListener("click", showHomePage);
}

function showNoReviewPage() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="date">TODAY REVIEW</p>
        <h1>今日无需复习</h1>
      </div>
    </header>

    <section class="today-card">
      <p class="finish-note">当前没有到期旧词，也没有尚未加入学习的新词。</p>
      <button class="primary-button" id="finishBtn">返回首页</button>
    </section>
  `;

  document.getElementById("finishBtn").addEventListener("click", showHomePage);
}

function createResultBox(title, number) {
  return `
    <div class="result-box">
      <strong>${number}</strong>
      <span>${title}</span>
    </div>
  `;
}


// =======================================
// 每日复习记录
// =======================================

async function showDailyHistoryPage() {
  const sessions = await getAllDailySessions();
  renderDailyHistoryPage(sessions);
}

function renderDailyHistoryPage(sessions) {
  const todayKey = getLocalDateKey();

  const totalDays = sessions.length;
  const totalReviewed = sessions.reduce(
    (sum, session) => sum + Number(session.primaryCompleted || 0),
    0
  );
  const averageReviewed = totalDays > 0
    ? Math.round(totalReviewed / totalDays)
    : 0;

  const listHtml = sessions.length
    ? sessions.map(session => {
        const completed = Number(session.primaryCompleted || 0);
        const planned = Number(session.initialPrimaryCount || 0);
        const know = Number(session.know || 0);
        const forgot = Number(session.forgot || 0);
        const isToday = session.date === todayKey;
        const isFinished = Boolean(session.completedAt);

        return `
          <article class="daily-history-item">
            <div class="daily-history-date">
              <strong>${formatFullDateForDisplay(session.date)}</strong>
              <span>${isToday ? "今天" : (isFinished ? "已结束" : "当日未完成")}</span>
            </div>

            <div class="daily-history-count">
              <strong>${completed}</strong>
              <span>实际复习词数</span>
            </div>

            <div class="daily-history-meta">
              <span>计划 ${planned}</span>
              <span>认识 ${know}</span>
              <span>忘了 ${forgot}</span>
            </div>
          </article>
        `;
      }).join("")
    : `
      <div class="empty-state">
        <strong>还没有每日复习记录</strong>
        <span>开始复习后，每天实际完成的词数会自动保存在这里。</span>
      </div>
    `;

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="dailyHistoryBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">DAILY HISTORY</p>
        <h1>每日复习记录</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="daily-history-summary">
      <div><strong>${totalDays}</strong><span>记录天数</span></div>
      <div><strong>${totalReviewed}</strong><span>累计复习</span></div>
      <div><strong>${averageReviewed}</strong><span>日均词数</span></div>
    </section>

    <section class="daily-history-note">
      <p>这里记录的是每天真正完成首轮判断的词数，而不是固定目标。比如今天只做到100词就退出，今天会保存为100；昨天做完200词，则昨天显示200。</p>
    </section>

    <section class="daily-history-list">
      ${listHtml}
    </section>
  `;

  document.getElementById("dailyHistoryBackBtn")?.addEventListener("click", showHomePage);
}

function formatFullDateForDisplay(dateKey) {
  if (!dateKey) return "未知日期";
  const parts = String(dateKey).split("-");
  if (parts.length !== 3) return escapeHtml(String(dateKey));
  return `${Number(parts[0])}年${Number(parts[1])}月${Number(parts[2])}日`;
}

// =======================================
// 列表页轻量翻译下拉
// 仅显示词性 + 中文释义，不显示固定搭配和例句
// =======================================

async function buildTranslationEntryMap(terms) {
  const uniqueTerms = Array.from(new Set((terms || []).filter(Boolean)));
  const pairs = await Promise.all(
    uniqueTerms.map(async term => [
      normalizeDictionaryTerm(term),
      await getDictionaryEntry(term)
    ])
  );

  return new Map(pairs);
}

function renderTranslationDropdown(entry, fallbackTerm = "") {
  const translations = (entry?.translations || []).filter(item => item?.translation);

  const content = translations.length
    ? translations.map(item => `
        <div class="mini-translation-row">
          ${item.type ? `<span class="pos-badge">${escapeHtml(item.type)}</span>` : ""}
          <span>${escapeHtml(item.translation)}</span>
        </div>
      `).join("")
    : `<div class="mini-translation-empty">“${escapeHtml(fallbackTerm)}”暂无本地中文释义</div>`;

  return `
    <details class="mini-translation-details">
      <summary>查看翻译</summary>
      <div class="mini-translation-panel">${content}</div>
    </details>
  `;
}

// =======================================
// 今日复习总览
// 分为：认识 / 忘了 / 待复习
// =======================================

async function showTodayOverviewPage() {
  const savedSession = await getTodaySession();
  const progressRecords = await getAllWordProgress();
  const recordMap = new Map(progressRecords.map(record => [record.id, record]));

  let session = savedSession;
  let primaryItems;
  let meta;
  let isPreview = false;

  if (session) {
    ensureSessionCompat(session);
    primaryItems = session.queue.filter(item => item.type === "primary");
    meta = session.planMeta || {};
  } else {
    const plan = buildDailyPrimaryQueue(vocabulary, progressRecords, DAILY_TARGET);
    primaryItems = plan.items;
    meta = plan.meta || {};
    isPreview = true;
  }

  // 某些情况下会出现：当天已经答过，但旧 session 中尚未保存 primaryRatings。
  // 这里从数据库的最后一次复习记录中补全当天状态。
  const inferredRatings = {};

  if (session) {
    for (const item of primaryItems) {
      if (session.primaryRatings[item.id]) continue;

      const record = recordMap.get(item.id);
      if (
        record &&
        record.lastReviewedAt &&
        getLocalDateKey(new Date(record.lastReviewedAt)) === getLocalDateKey()
      ) {
        inferredRatings[item.id] = record.lastRating;
      }
    }
  }

  const knownItems = [];
  const forgotItems = [];
  const pendingItems = [];

  primaryItems.forEach((item, index) => {
    const word = vocabularyMap.get(item.id);
    if (!word) return;

    const rating = session
      ? (session.primaryRatings[item.id] || inferredRatings[item.id] || null)
      : null;

    const viewItem = {
      item,
      word,
      index,
      sourceText: describeTodayWordSource(item.id, meta, index, primaryItems.length)
    };

    if (rating === "know") {
      knownItems.push(viewItem);
    } else if (rating === "forgot") {
      forgotItems.push(viewItem);
    } else {
      pendingItems.push(viewItem);
    }
  });

  const total = primaryItems.length;
  const knownCount = knownItems.length;
  const forgotCount = forgotItems.length;
  const pendingCount = pendingItems.length;

  const overviewDictionaryMap = await buildTranslationEntryMap(
    primaryItems
      .map(item => vocabularyMap.get(item.id)?.term)
      .filter(Boolean)
  );

  function renderOverviewRows(items) {
    if (!items.length) {
      return `
        <div class="overview-board-empty">
          暂无单词
        </div>
      `;
    }

    return items.map(({ word, index, sourceText }) => {
      const dictionaryEntry = overviewDictionaryMap.get(normalizeDictionaryTerm(word.term)) || null;

      return `
        <article class="overview-row overview-row-grouped">
          <span class="overview-index">${index + 1}</span>
          <div class="overview-word-wrap">
            <strong>${escapeHtml(word.term)}</strong>
            <span>${sourceText}</span>
            ${renderTranslationDropdown(dictionaryEntry, word.term)}
          </div>
        </article>
      `;
    }).join("");
  }

  function renderOverviewBoard(title, count, statusClass, items, description) {
    return `
      <section class="overview-board ${statusClass}">
        <div class="overview-board-header">
          <div>
            <h2>${title}</h2>
            <p>${description}</p>
          </div>
          <strong>${count}</strong>
        </div>
        <div class="overview-board-list">
          ${renderOverviewRows(items)}
        </div>
      </section>
    `;
  }

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="overviewBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">TODAY OVERVIEW</p>
        <h1>今日复习总览</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="overview-summary">
      <div><strong>${knownCount}</strong><span>认识</span></div>
      <div><strong>${forgotCount}</strong><span>忘了</span></div>
      <div><strong>${pendingCount}</strong><span>待复习</span></div>
    </section>

    <section class="overview-plan-card">
      <p>
        今日计划 ${total} 词 · 忘记词 ${meta.forgottenDue || 0} · 到期已认识 ${meta.knownDueAdded || 0} · 新词 ${meta.newAdded || 0}
      </p>
      ${isPreview
        ? '<span>当前为计划预览，正式开始复习后锁定今日队列。所有单词暂归入“待复习”。</span>'
        : '<span>单词会随着今天的作答结果，在“认识 / 忘了 / 待复习”三个板块之间自动更新。</span>'}
    </section>

    <div class="overview-groups">
      ${renderOverviewBoard(
        "认识",
        knownCount,
        "overview-board-know",
        knownItems,
        "今天首轮已选择“认识”的单词"
      )}

      ${renderOverviewBoard(
        "忘了",
        forgotCount,
        "overview-board-forgot",
        forgotItems,
        "今天首轮选择“忘了”的单词"
      )}

      ${renderOverviewBoard(
        "待复习",
        pendingCount,
        "overview-board-pending",
        pendingItems,
        "今天尚未完成首轮判断的单词"
      )}
    </div>
  `;

  document.getElementById("overviewBackBtn")?.addEventListener("click", showHomePage);
}

function describeTodayWordSource(wordId, meta, index, total) {
  const forgottenEnd = Number(meta.forgottenDue || 0);
  const knownEnd = forgottenEnd + Number(meta.knownDueAdded || 0);

  if (index < forgottenEnd) return "优先：到期忘记词";
  if (index < knownEnd) return "到期复习词";
  if (index < total) return "顺序补充新词";
  return "今日复习";
}

// =======================================
// 重点易错
// =======================================

async function getDifficultWordsData() {
  const records = await getAllWordProgress();

  return records
    .filter(record =>
      record.lastRating === "forgot" ||
      Number(record.forgotCount || 0) >= 2
    )
    .map(record => {
      const word = vocabularyMap.get(record.id);
      return {
        ...record,
        term: word?.term || record.term || record.id,
        sourceOrder: word?.source_order || record.sourceOrder || 0,
        forgotRate: Number(record.reviewCount || 0) > 0
          ? Number(record.forgotCount || 0) / Number(record.reviewCount || 1)
          : 0,
        currentForgotten: record.lastRating === "forgot"
      };
    })
    .sort((a, b) => {
      if (a.currentForgotten !== b.currentForgotten) {
        return a.currentForgotten ? -1 : 1;
      }

      if ((b.forgotCount || 0) !== (a.forgotCount || 0)) {
        return (b.forgotCount || 0) - (a.forgotCount || 0);
      }

      if (b.forgotRate !== a.forgotRate) {
        return b.forgotRate - a.forgotRate;
      }

      return (a.sourceOrder || 0) - (b.sourceOrder || 0);
    });
}

async function showDifficultWordsPage() {
  const items = await getDifficultWordsData();
  await renderDifficultWordsPage(items);
}

async function renderDifficultWordsPage(items) {
  const currentForgotten = items.filter(item => item.currentForgotten).length;
  const repeated = items.filter(item => Number(item.forgotCount || 0) >= 2).length;

  const difficultDictionaryMap = await buildTranslationEntryMap(
    items.map(item => item.term).filter(Boolean)
  );

  const listHtml = items.length
    ? items.map((item, index) => {
        const dictionaryEntry = difficultDictionaryMap.get(normalizeDictionaryTerm(item.term)) || null;

        return `
          <article class="difficult-item">
            <div class="difficult-rank">${index + 1}</div>
            <div class="difficult-main">
              <div class="difficult-title-line">
                <h3>${escapeHtml(item.term)}</h3>
                <span class="status-badge ${item.currentForgotten ? "status-forgot" : "status-hard"}">
                  ${item.currentForgotten ? "当前忘记" : "反复易错"}
                </span>
              </div>
              <p>
                忘记 ${item.forgotCount || 0} 次 · 认识 ${item.knowCount || 0} 次 · 连续认识 ${item.streak || 0}
              </p>
              <div class="difficult-meta">
                <span>遗忘率 ${Math.round((item.forgotRate || 0) * 100)}%</span>
                <span>下次 ${formatDateForDisplay(item.nextReviewDate)}</span>
              </div>
              ${renderTranslationDropdown(dictionaryEntry, item.term)}
            </div>
          </article>
        `;
      }).join("")
    : `
      <div class="empty-state">
        <strong>暂时没有重点易错词</strong>
        <span>“当前仍忘记”或“历史忘记至少2次”的词会自动进入这里。</span>
      </div>
    `;

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="difficultBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">DIFFICULT WORDS</p>
        <h1>重点易错</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="difficult-summary">
      <div><strong>${items.length}</strong><span>重点易错</span></div>
      <div><strong>${currentForgotten}</strong><span>当前忘记</span></div>
      <div><strong>${repeated}</strong><span>反复遗忘</span></div>
    </section>

    <section class="difficult-rule-card">
      <strong>进入规则</strong>
      <p>当前状态为“忘了”，或历史累计忘记至少 2 次。答对后当前忘记会清除，但历史遗忘次数保留。</p>
    </section>

    ${items.length ? '<button class="primary-button difficult-practice-start" id="startDifficultPracticeBtn">开始专项复习</button>' : ''}

    <section class="difficult-list">
      ${listHtml}
    </section>
  `;

  document.getElementById("difficultBackBtn")?.addEventListener("click", showHomePage);
  document.getElementById("startDifficultPracticeBtn")?.addEventListener("click", () => startDifficultPractice(items));
}

async function startDifficultPractice(items) {
  if (!items.length) return;

  await prepareCloudBeforeStudy();

  difficultPractice = {
    queue: items.map(item => ({ id: item.id, type: "primary" })),
    cursor: 0,
    forgot: 0,
    know: 0,
    reinforcementAttempts: 0,
    reinsertedIds: []
  };

  showDifficultPracticePage();
}

async function showDifficultPracticePage() {
  const item = difficultPractice?.queue[difficultPractice.cursor];

  if (!item) {
    showDifficultPracticeFinishPage();
    return;
  }

  const word = vocabularyMap.get(item.id);
  if (!word) {
    difficultPractice.cursor++;
    showDifficultPracticePage();
    return;
  }

  const dictionaryEntry = await getDictionaryEntry(word.term);
  const current = difficultPractice.cursor + 1;
  const total = difficultPractice.queue.length;
  const progress = Math.round((difficultPractice.cursor / total) * 100);
  const reinforcement = item.type === "reinforcement";

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="difficultPracticeBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">FOCUS REVIEW</p>
        <h1>重点易错复习</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="today-card">
      <div class="today-header">
        <div>
          <p class="section-label">专项进度</p>
          <h2>${current} / ${total}</h2>
        </div>
        <div class="progress-text">${progress}%</div>
      </div>

      <div class="progress-bar">
        <div class="progress-value" style="width:${progress}%"></div>
      </div>

      <div class="review-word-area">
        <p class="review-word-type">DIFFICULT WORD</p>
        <div class="review-word">${escapeHtml(word.term)}</div>
        ${renderCompactPronunciation(dictionaryEntry)}
        ${reinforcement ? '<span class="reinforcement-badge">专项加练</span>' : ''}
      </div>

      <p class="review-hint">作答后查看完整释义、常见搭配和双语例句。</p>

      <div class="rating-grid">
        <button class="rating-btn rating-forgot difficult-rating-btn" data-rating="forgot">忘了</button>
        <button class="rating-btn rating-know difficult-rating-btn" data-rating="know">认识</button>
      </div>

      <div class="review-stats">
        <span>忘了 ${difficultPractice.forgot}</span>
        <span>认识 ${difficultPractice.know}</span>
        <span>加练 ${difficultPractice.reinforcementAttempts}</span>
      </div>
    </section>
  `;

  document.getElementById("difficultPracticeBackBtn")?.addEventListener("click", showDifficultWordsPage);
  document.querySelectorAll(".difficult-rating-btn").forEach(button => {
    button.addEventListener("click", () => rateDifficultWord(button.dataset.rating));
  });
}

async function rateDifficultWord(rating) {
  if (isSaving || !difficultPractice) return;
  isSaving = true;

  const buttons = document.querySelectorAll(".difficult-rating-btn");
  buttons.forEach(button => (button.disabled = true));

  try {
    const item = difficultPractice.queue[difficultPractice.cursor];
    const word = vocabularyMap.get(item.id);

    if (!word) throw new Error(`找不到词条：${item.id}`);
    const wasReinforcement = item.type === "reinforcement";

    if (item.type === "primary") {
      await savePrimaryWordRating(word, rating);

      if (rating === "forgot") {
        difficultPractice.forgot++;

        if (!difficultPractice.reinsertedIds.includes(word.id)) {
          insertReinforcement(
            difficultPractice.queue,
            difficultPractice.cursor,
            word.id,
            REINFORCEMENT_GAP
          );
          difficultPractice.reinsertedIds.push(word.id);
        }
      } else {
        difficultPractice.know++;
      }
    } else {
      await saveReinforcementAttempt(word, rating);
      difficultPractice.reinforcementAttempts++;
    }

    difficultPractice.cursor++;
    await showDifficultRatedAnswerPage(word, rating, wasReinforcement);
  } catch (error) {
    console.error("重点易错复习保存失败：", error);
    alert("保存失败，请重试。");
    buttons.forEach(button => (button.disabled = false));
  } finally {
    isSaving = false;
  }
}

async function showDifficultRatedAnswerPage(word, rating, wasReinforcement) {
  const dictionaryEntry = await getDictionaryEntry(word.term);
  const finished = !difficultPractice || difficultPractice.cursor >= difficultPractice.queue.length;

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="difficultAnswerBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">WORD DETAIL</p>
        <h1>易错词解析</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="answer-shell">
      <div class="answer-word-head">
        <div>
          <p class="section-label">${rating === "know" ? "本次：认识" : "本次：忘了"}</p>
          <h2>${escapeHtml(word.term)}</h2>
          ${renderCompactPronunciation(dictionaryEntry)}
        </div>
        <span class="answer-rating ${rating === "know" ? "answer-rating-know" : "answer-rating-forgot"}">
          ${rating === "know" ? "认识" : "忘了"}
        </span>
      </div>

      ${wasReinforcement ? '<p class="answer-reinforcement-note">这是专项加练。</p>' : ''}
      ${renderDictionaryCard(dictionaryEntry, word.term)}

      <div class="answer-actions">
        ${rating === "know" ? '<button class="secondary-button" id="difficultMarkMistakeBtn">记错了</button>' : ''}
        <button class="primary-button" id="difficultNextAfterAnswerBtn">${finished ? "查看专项结果" : "下一个词"}</button>
      </div>
    </section>
  `;

  document.getElementById("difficultAnswerBackBtn")?.addEventListener("click", showDifficultWordsPage);
  document.getElementById("difficultMarkMistakeBtn")?.addEventListener("click", async () => {
    await correctDifficultAnswerToForgot(word, wasReinforcement);
  });
  document.getElementById("difficultNextAfterAnswerBtn")?.addEventListener("click", () => {
    const nowFinished = !difficultPractice || difficultPractice.cursor >= difficultPractice.queue.length;
    if (nowFinished) showDifficultPracticeFinishPage();
    else showDifficultPracticePage();
  });
}

async function correctDifficultAnswerToForgot(word, wasReinforcement) {
  if (isSaving || !difficultPractice) return;
  isSaving = true;

  const mistakeBtn = document.getElementById("difficultMarkMistakeBtn");
  const nextBtn = document.getElementById("difficultNextAfterAnswerBtn");
  if (mistakeBtn) mistakeBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;

  try {
    if (wasReinforcement) {
      await correctReinforcementKnowToForgot(word);
    } else {
      await correctPrimaryKnowToForgot(word);

      difficultPractice.know = Math.max(0, (difficultPractice.know || 0) - 1);
      difficultPractice.forgot = (difficultPractice.forgot || 0) + 1;

      if (!difficultPractice.reinsertedIds.includes(word.id)) {
        insertReinforcement(
          difficultPractice.queue,
          Math.max(0, difficultPractice.cursor - 1),
          word.id,
          REINFORCEMENT_GAP
        );
        difficultPractice.reinsertedIds.push(word.id);
      }
    }

    await showDifficultRatedAnswerPage(word, "forgot", wasReinforcement);
  } catch (error) {
    console.error("专项复习更正失败：", error);
    alert("更正失败，请重试。");
    if (mistakeBtn) mistakeBtn.disabled = false;
    if (nextBtn) nextBtn.disabled = false;
  } finally {
    isSaving = false;
  }
}

function showDifficultPracticeFinishPage() {
  const result = difficultPractice || { forgot: 0, know: 0, reinforcementAttempts: 0 };

  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="date">FOCUS COMPLETE</p>
        <h1>专项复习完成</h1>
      </div>
    </header>

    <section class="today-card">
      <div class="finish-grid">
        ${createResultBox("忘了", result.forgot || 0)}
        ${createResultBox("认识", result.know || 0)}
      </div>
      <p class="finish-note">专项加练 ${result.reinforcementAttempts || 0} 次。专项复习会更新单词长期复习状态，但不会增加“今日复习”的完成数量。</p>
      <button class="primary-button" id="difficultFinishBtn">返回重点易错</button>
    </section>
  `;

  document.getElementById("difficultFinishBtn")?.addEventListener("click", showDifficultWordsPage);
}

function formatDateForDisplay(dateKey) {
  if (!dateKey) return "未安排";
  const parts = String(dateKey).split("-");
  if (parts.length !== 3) return escapeHtml(String(dateKey));
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

// =======================================
// 阅读生词 / 短语
// =======================================

async function showReadingWordsPage() {
  const items = await getAllReadingWords();
  renderReadingWordsPage(items);
}

function renderReadingWordsPage(items) {
  const listHtml = items.length
    ? items.map(item => `
        <article class="reading-item">
          <div class="reading-item-head">
            <div>
              <h3>${escapeHtml(item.term)}</h3>
              ${item.meaning ? `<p class="reading-meaning">${escapeHtml(item.meaning)}</p>` : ''}
            </div>
            <button class="reading-delete-btn" data-id="${item.id}" type="button">删除</button>
          </div>

          ${item.sentence ? `<p class="reading-sentence">${escapeHtml(item.sentence)}</p>` : ''}

          <div class="reading-meta">
            ${item.source ? `<span>${escapeHtml(item.source)}</span>` : '<span>未填写来源</span>'}
            <span>遇到 ${item.occurrenceCount || 1} 次</span>
          </div>

          ${item.note ? `<p class="reading-note">${escapeHtml(item.note)}</p>` : ''}
        </article>
      `).join("")
    : `
      <div class="empty-state">
        <strong>还没有阅读生词</strong>
        <span>把阅读理解中遇到的单词、短语和原句保存到这里。</span>
      </div>
    `;

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="readingBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">READING WORDS</p>
        <h1>阅读生词</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    <section class="today-card reading-form-card">
      <div class="reading-form-title">
        <div>
          <p class="section-label">新增</p>
          <h2>记录阅读词汇</h2>
        </div>
        <span>${items.length} 条</span>
      </div>

      <form id="readingWordForm" class="reading-form">
        <label>
          <span>单词 / 短语 *</span>
          <input id="readingTerm" type="text" autocomplete="off" placeholder="例如 susceptible to" required>
        </label>

        <label>
          <span>中文释义</span>
          <input id="readingMeaning" type="text" autocomplete="off" placeholder="例如 易受……影响">
        </label>

        <label>
          <span>来源</span>
          <input id="readingSource" type="text" autocomplete="off" placeholder="例如 六级阅读 Passage Two">
        </label>

        <label>
          <span>原句</span>
          <textarea id="readingSentence" rows="3" placeholder="把阅读中的原句粘贴到这里"></textarea>
        </label>

        <label>
          <span>备注</span>
          <textarea id="readingNote" rows="2" placeholder="可选：搭配、易混点等"></textarea>
        </label>

        <button class="primary-button" type="submit">保存到阅读生词</button>
      </form>
    </section>

    <section class="reading-list">
      ${listHtml}
    </section>
  `;

  bindReadingWordsEvents();
}

function bindReadingWordsEvents() {
  document.getElementById("readingBackBtn")?.addEventListener("click", showHomePage);

  document.getElementById("readingWordForm")?.addEventListener("submit", async event => {
    event.preventDefault();

    const submitBtn = event.currentTarget.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      await saveReadingWord({
        term: document.getElementById("readingTerm").value,
        meaning: document.getElementById("readingMeaning").value,
        source: document.getElementById("readingSource").value,
        sentence: document.getElementById("readingSentence").value,
        note: document.getElementById("readingNote").value
      });

      const items = await getAllReadingWords();
      renderReadingWordsPage(items);
    } catch (error) {
      console.error("保存阅读生词失败：", error);
      alert(error.message || "保存阅读生词失败");
      submitBtn.disabled = false;
    }
  });

  document.querySelectorAll(".reading-delete-btn").forEach(button => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.id);
      const confirmed = confirm("确定删除这条阅读生词吗？");

      if (!confirmed) return;

      try {
        await deleteReadingWord(id);
        const items = await getAllReadingWords();
        renderReadingWordsPage(items);
      } catch (error) {
        console.error("删除阅读生词失败：", error);
        alert("删除失败，请重试。");
      }
    });
  });
}


// =======================================
// 增强词典 UI / 设置
// =======================================

function renderCompactPronunciation(entry) {
  if (!entry) return '<div class="pronunciation-line pronunciation-missing">释义词典尚未匹配</div>';

  const parts = [];
  if (entry.us) parts.push(`<span><b>美</b> /${escapeHtml(entry.us)}/</span>`);
  if (entry.uk) parts.push(`<span><b>英</b> /${escapeHtml(entry.uk)}/</span>`);

  return parts.length
    ? `<div class="pronunciation-line">${parts.join("")}</div>`
    : '<div class="pronunciation-line pronunciation-missing">暂无音标</div>';
}

function renderDictionaryCard(entry, fallbackTerm = "") {
  if (!entry) {
    return `
      <section class="dictionary-card dictionary-card-missing">
        <div class="dictionary-section-title">词典资料</div>
        <p>“${escapeHtml(fallbackTerm)}”暂未匹配到本地增强词典。可到右上角设置中重新同步。少数异常词、专名或源词表噪声可能没有标准词典条目。</p>
      </section>
    `;
  }

  const translations = (entry.translations || []).length
    ? entry.translations.map(item => `
        <div class="translation-row">
          ${item.type ? `<span class="pos-badge">${escapeHtml(item.type)}</span>` : ''}
          <span>${escapeHtml(item.translation)}</span>
        </div>
      `).join("")
    : '<p class="dictionary-empty">暂无中文释义</p>';

  const phrases = (entry.phrases || []).slice(0, 5);
  const phraseHtml = phrases.length
    ? phrases.map(item => `
        <div class="phrase-row">
          <strong>${escapeHtml(item.phrase)}</strong>
          <span>${escapeHtml(item.translation || "")}</span>
        </div>
      `).join("")
    : '<p class="dictionary-empty">暂无常见搭配</p>';

  const sentences = (entry.sentences || []).slice(0, 2);
  const sentenceHtml = sentences.length
    ? sentences.map(item => `
        <div class="sentence-row">
          <p>${escapeHtml(item.en)}</p>
          ${item.cn ? `<span>${escapeHtml(item.cn)}</span>` : ''}
        </div>
      `).join("")
    : '<p class="dictionary-empty">暂无双语例句</p>';

  return `
    <section class="dictionary-card">
      <div class="dictionary-section">
        <div class="dictionary-section-title">核心释义</div>
        <div class="translation-list">${translations}</div>
      </div>

      <div class="dictionary-section">
        <div class="dictionary-section-title">常见搭配</div>
        <div class="phrase-list">${phraseHtml}</div>
      </div>

      <div class="dictionary-section">
        <div class="dictionary-section-title">语境例句</div>
        <div class="sentence-list">${sentenceHtml}</div>
      </div>

      <div class="dictionary-source-note">
        数据源：${escapeHtml((entry.sources || []).join(" / ") || "本地词典")} · v1.5补全规则
      </div>
    </section>
  `;
}

async function showSettingsPage() {
  const coverage = await getDictionaryCoverage(vocabulary);
  const meta = await getDictionaryMeta("sync");
  const pwaStatus = typeof getPWAStatus === "function"
    ? getPWAStatus()
    : { installed: false, canPrompt: false, online: navigator.onLine };
  const cloud = window.CET6Cloud;
  const cloudStatus = cloud?.getStatus?.() || {
    configured: false,
    ready: false,
    signedIn: false,
    email: "",
    online: navigator.onLine,
    syncing: false,
    initialSyncDone: false,
    rollbackPreventionCount: 0,
    lastSyncAt: null,
    lastError: null
  };

  lastDictionaryCoverage = coverage;

  const installLabel = pwaStatus.installed
    ? "已安装到桌面"
    : (pwaStatus.canPrompt ? "安装到桌面" : "查看安装方式");

  const networkLabel = navigator.onLine ? "在线" : "离线";
  const networkClass = navigator.onLine ? "status-ok" : "status-offline";

  app.innerHTML = `
    <header class="topbar">
      <button class="settings-button" id="settingsBackBtn" aria-label="返回">←</button>
      <div style="text-align:center">
        <p class="date">SETTINGS</p>
        <h1>设置</h1>
      </div>
      <div style="width:46px"></div>
    </header>

    ${renderCloudSettingsCard(cloudStatus)}

    <section class="today-card settings-card">
      <p class="section-label">增强词典</p>
      <div class="dictionary-coverage-head">
        <strong>${coverage.matched} / ${coverage.target}</strong>
        <span>${coverage.percent}% 已匹配</span>
      </div>
      <div class="progress-bar dictionary-progress">
        <div class="progress-value" style="width:${coverage.percent}%"></div>
      </div>
      <p class="settings-help">
        固定短语与少量特殊词已随 App 内置中文释义；普通单词会从公开词库补全词性、音标、搭配和例句。首次完整同步需要联网，之后保存在 IndexedDB 中，可离线使用。
      </p>
      <p class="settings-meta">
        ${meta?.lastSyncAt ? `上次同步：${formatDateTime(meta.lastSyncAt)}` : "尚未完成同步"}
        ${meta?.errors?.length ? ` · ${meta.errors.length} 个数据源失败` : ""}
      </p>
      <button class="primary-button" id="syncDictionaryBtn">${coverage.percent >= 95 ? "重新同步增强词典" : "同步增强词典"}</button>
      <div id="dictionarySyncMessage" class="sync-message"></div>
    </section>

    <section class="today-card settings-card">
      <div class="settings-title-row">
        <div>
          <p class="section-label">安装与离线</p>
          <h2 class="settings-card-title">PWA 应用</h2>
        </div>
        <span class="status-pill ${networkClass}">${networkLabel}</span>
      </div>
      <p class="settings-help">
        首次打开和更新版本需要联网。完成缓存后，核心复习、学习记录、阅读生词和已同步词典均可离线使用。
      </p>
      <p class="settings-meta">
        ${pwaStatus.installed ? "当前已以独立 App 模式运行。" : "当前处于浏览器模式。小米/Android 可使用浏览器菜单中的“安装应用”或“添加到主屏幕”。"}
      </p>
      <button class="secondary-action-button" id="installAppBtn" ${pwaStatus.installed ? "disabled" : ""}>${installLabel}</button>
      <div id="installMessage" class="sync-message"></div>
    </section>

    <section class="today-card settings-card">
      <p class="section-label">学习数据</p>
      <h2 class="settings-card-title">本地备份与恢复</h2>
      <p class="settings-help">
        Supabase 会负责多设备同步，但仍建议偶尔导出 JSON 作为独立备份。备份包含复习历史、每日记录、今日队列断点和阅读生词。
      </p>
      <div class="settings-action-grid">
        <button class="secondary-action-button" id="exportBackupBtn">导出备份</button>
        <button class="secondary-action-button" id="importBackupBtn">导入备份</button>
      </div>
      <input id="backupFileInput" class="backup-file-input" type="file" accept="application/json,.json">
      <div id="backupMessage" class="sync-message"></div>
    </section>

    <section class="dictionary-source-card">
      <strong>CET6 Review · ${APP_VERSION}</strong>
      <p>IndexedDB 仍是每台设备的离线本地数据层；登录同一 Supabase 账号后，学习数据自动同步到 Postgres 云端表，再同步到其他设备。</p>
      <p>2003 核心词和增强词典不是个人学习记录，不上传云端；云端仅保存复习进度、每日会话和阅读生词。</p>
    </section>
  `;

  document.getElementById("settingsBackBtn")?.addEventListener("click", showHomePage);
  document.getElementById("syncDictionaryBtn")?.addEventListener("click", syncDictionaryFromSettings);
  document.getElementById("installAppBtn")?.addEventListener("click", handleInstallApp);
  document.getElementById("exportBackupBtn")?.addEventListener("click", handleExportBackup);
  document.getElementById("importBackupBtn")?.addEventListener("click", () => {
    document.getElementById("backupFileInput")?.click();
  });
  document.getElementById("backupFileInput")?.addEventListener("change", handleImportBackup);
  bindCloudSettingsEvents(cloudStatus);
}

function renderCloudSettingsCard(status) {
  const onlineClass = status.online ? "status-ok" : "status-offline";
  const onlineText = status.online ? "在线" : "离线";

  if (!status.configured) {
    return `
      <section class="today-card settings-card cloud-card">
        <div class="settings-title-row">
          <div>
            <p class="section-label">多设备云同步</p>
            <h2 class="settings-card-title">Supabase</h2>
          </div>
          <span class="status-pill">未配置</span>
        </div>
        <p class="settings-help">
          先创建 Supabase 项目并执行工程里的 supabase-schema.sql，然后填写 Project URL 与 Publishable key。配置只保存在当前浏览器。Publishable/anon key 可以放在前端，真正的数据隔离由 RLS 策略负责；绝对不要填写 service_role 或 secret key。
        </p>
        <form id="supabaseConfigForm" class="cloud-form">
          <label><span>Project URL *</span><input id="sbUrl" type="url" autocomplete="off" placeholder="https://xxxx.supabase.co" required></label>
          <label><span>Publishable key / anon key *</span><input id="sbPublishableKey" type="text" autocomplete="off" required></label>
          <button class="primary-button" type="submit">保存 Supabase 配置</button>
        </form>
        <div id="cloudMessage" class="sync-message"></div>
      </section>
    `;
  }

  if (!status.signedIn) {
    return `
      <section class="today-card settings-card cloud-card">
        <div class="settings-title-row">
          <div>
            <p class="section-label">多设备云同步</p>
            <h2 class="settings-card-title">Supabase 账号</h2>
          </div>
          <span class="status-pill ${onlineClass}">${onlineText}</span>
        </div>
        <p class="settings-help">
          用同一个邮箱账号登录小米手机、Windows Edge、Chrome 等设备。首次登录会自动把当前设备 IndexedDB 与云端数据双向合并；运行中的其他设备会在重新打开/切回页面、恢复联网或最多约45秒后同步。
        </p>
        <form id="supabaseAuthForm" class="cloud-form">
          <label><span>邮箱</span><input id="cloudEmail" type="email" autocomplete="email" required></label>
          <label><span>密码</span><input id="cloudPassword" type="password" autocomplete="current-password" minlength="6" required></label>
          <div class="settings-action-grid">
            <button class="primary-button" id="cloudLoginBtn" type="submit">登录</button>
            <button class="secondary-action-button" id="cloudRegisterBtn" type="button">注册</button>
          </div>
        </form>
        <button class="text-action-button" id="clearSupabaseConfigBtn" type="button">重新填写 Supabase 配置</button>
        <div id="cloudMessage" class="sync-message">${status.lastError ? escapeHtml(status.lastError) : ""}</div>
      </section>
    `;
  }

  return `
    <section class="today-card settings-card cloud-card">
      <div class="settings-title-row">
        <div>
          <p class="section-label">多设备云同步</p>
          <h2 class="settings-card-title">Supabase 已连接</h2>
        </div>
        <span class="status-pill ${onlineClass}">${onlineText}</span>
      </div>
      <div class="cloud-account-row">
        <div>
          <span class="cloud-account-label">当前账号</span>
          <strong>${escapeHtml(status.email || "已登录")}</strong>
        </div>
        <span class="cloud-sync-indicator ${status.syncing ? "is-syncing" : ""}">${status.syncing ? "同步中…" : "自动同步"}</span>
      </div>
      <p class="settings-meta">
        ${status.lastSyncAt ? `上次完成同步：${formatDateTime(status.lastSyncAt)}` : "正在等待首次同步"}
      </p>
      <p class="settings-meta">
        防数据回退保护：已启用
        ${status.initialSyncDone ? " · 首次云端合并已完成" : (status.online ? " · 首次云端合并进行中/待完成" : " · 当前离线，联网后补合并")}
        ${status.rollbackPreventionCount ? ` · 本次运行已拦截 ${status.rollbackPreventionCount} 次低进度覆盖` : ""}
      </p>
      <p class="settings-help">
        每次“认识 / 忘了”、今日队列变化和阅读生词修改都会先写入本机 IndexedDB，再尝试同步到 Supabase。v2.1.2 不再单纯按“谁时间新”覆盖：每日进度和单词复习次数只能向前合并，低进度记录不能把高进度记录清零。断网时继续学习；恢复联网后自动补齐。
      </p>
      <div class="settings-action-grid">
        <button class="primary-button" id="cloudSyncNowBtn" type="button" ${status.syncing ? "disabled" : ""}>立即同步</button>
        <button class="secondary-action-button" id="cloudLogoutBtn" type="button">退出账号</button>
      </div>
      <button class="text-action-button" id="clearSupabaseConfigBtn" type="button">更换 Supabase 项目</button>
      <div id="cloudMessage" class="sync-message">${status.lastError ? escapeHtml(status.lastError) : ""}</div>
    </section>
  `;
}

function bindCloudSettingsEvents(status) {
  const cloud = window.CET6Cloud;
  const message = document.getElementById("cloudMessage");

  document.getElementById("supabaseConfigForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const config = {
      url: document.getElementById("sbUrl").value,
      publishableKey: document.getElementById("sbPublishableKey").value
    };

    try {
      if (!cloud?.saveConfig) throw new Error("Supabase 模块尚未加载，请确认当前可以联网后重试");
      cloud.saveConfig(config);
    } catch (error) {
      if (message) message.textContent = error.message || String(error);
    }
  });

  document.getElementById("supabaseAuthForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!cloud) return;
    const email = document.getElementById("cloudEmail").value.trim();
    const password = document.getElementById("cloudPassword").value;
    if (message) message.textContent = "正在登录…";

    try {
      await cloud.login(email, password);
      if (message) message.textContent = "登录成功，正在同步…";
      setTimeout(showSettingsPage, 700);
    } catch (error) {
      if (message) message.textContent = friendlySupabaseError(error);
    }
  });

  document.getElementById("cloudRegisterBtn")?.addEventListener("click", async () => {
    if (!cloud) return;
    const email = document.getElementById("cloudEmail")?.value.trim();
    const password = document.getElementById("cloudPassword")?.value || "";
    if (!email || password.length < 6) {
      if (message) message.textContent = "请输入有效邮箱，密码至少 6 位。";
      return;
    }

    if (message) message.textContent = "正在创建账号…";
    try {
      const result = await cloud.createAccount(email, password);
      if (result?.requiresEmailConfirmation) {
        if (message) message.textContent = "账号已创建。请先到邮箱点击 Supabase 验证链接，完成后返回这里登录。";
      } else {
        if (message) message.textContent = "账号创建成功，正在同步本机数据…";
        setTimeout(showSettingsPage, 700);
      }
    } catch (error) {
      if (message) message.textContent = friendlySupabaseError(error);
    }
  });

  document.getElementById("cloudSyncNowBtn")?.addEventListener("click", async event => {
    if (!cloud) return;
    const button = event.currentTarget;
    button.disabled = true;
    if (message) message.textContent = "正在双向同步…";
    try {
      const result = await cloud.syncNow({ reason: "manual" });
      if (message) message.textContent = `同步完成：上传 ${result?.uploaded || 0} 条，下载 ${result?.downloaded || 0} 条。`;
      await refreshHomeStats();
      setTimeout(showSettingsPage, 900);
    } catch (error) {
      if (message) message.textContent = friendlySupabaseError(error);
      button.disabled = false;
    }
  });

  document.getElementById("cloudLogoutBtn")?.addEventListener("click", async () => {
    if (!cloud) return;
    try {
      await cloud.logout();
      showSettingsPage();
    } catch (error) {
      if (message) message.textContent = friendlySupabaseError(error);
    }
  });

  document.getElementById("clearSupabaseConfigBtn")?.addEventListener("click", () => {
    const confirmed = confirm("确定更换 Supabase 项目吗？本机学习数据不会被删除。切换后请使用对应账号重新登录。");
    if (confirmed) cloud?.clearConfig?.();
  });
}

function friendlySupabaseError(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();

  if (lower.includes("invalid login credentials")) return "邮箱或密码不正确。";
  if (lower.includes("email not confirmed")) return "邮箱尚未验证，请先打开 Supabase 验证邮件。";
  if (lower.includes("user already registered")) return "这个邮箱已经注册，可以直接登录。";
  if (lower.includes("password")) return message || "密码不符合要求。";
  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "网络请求失败。离线时本地复习仍可继续，联网后再同步。";
  }
  if (lower.includes("row-level security") || lower.includes("permission denied")) {
    return "Supabase 数据权限被拒绝，请确认已执行 supabase-schema.sql 并启用 RLS 策略。";
  }
  return message;
}

async function handleInstallApp() {
  const message = document.getElementById("installMessage");
  const button = document.getElementById("installAppBtn");
  if (!message || !button) return;

  if (typeof requestPWAInstall !== "function") {
    message.textContent = "请使用浏览器菜单 → 安装应用 / 添加到主屏幕。";
    return;
  }

  try {
    const result = await requestPWAInstall();
    if (result?.outcome === "accepted") {
      message.textContent = "安装请求已接受。";
    } else if (result?.outcome === "already-installed") {
      message.textContent = "当前已经以 App 模式运行。";
      button.disabled = true;
    } else {
      message.textContent = "若浏览器未弹出安装窗口，请打开浏览器菜单 → 安装应用 / 添加到主屏幕。";
    }
  } catch (error) {
    console.error("PWA 安装失败：", error);
    message.textContent = "无法自动唤起安装，请使用浏览器菜单 → 安装应用 / 添加到主屏幕。";
  }
}

async function handleExportBackup() {
  const message = document.getElementById("backupMessage");
  if (!message) return;

  try {
    await exportStudyBackup();
    message.textContent = "备份已导出。请把 JSON 文件保存到安全位置。";
  } catch (error) {
    console.error("导出备份失败：", error);
    message.textContent = `导出失败：${error.message || error}`;
  }
}

async function handleImportBackup(event) {
  const input = event.target;
  const file = input?.files?.[0];
  const message = document.getElementById("backupMessage");
  if (!file || !message) return;

  const confirmed = window.confirm(
    "导入会用备份文件替换当前设备上的学习记录。恢复后如已登录 Supabase，会再与云端合并。\n\n确定继续吗？"
  );

  if (!confirmed) {
    input.value = "";
    return;
  }

  message.textContent = "正在恢复学习数据…";

  try {
    await importStudyBackupFile(file);
    message.textContent = "恢复成功，正在重新载入 App…";
    setTimeout(() => window.location.reload(), 700);
  } catch (error) {
    console.error("导入备份失败：", error);
    message.textContent = `导入失败：${error.message || error}`;
    input.value = "";
  }
}

async function syncDictionaryFromSettings() {
  const button = document.getElementById("syncDictionaryBtn");
  const message = document.getElementById("dictionarySyncMessage");
  if (!button || !message) return;

  button.disabled = true;
  message.textContent = "正在连接公开词库…";

  try {
    const result = await syncDictionaryForVocabulary(vocabulary, {
      onProgress(info) {
        if (info.stage === "fetching") {
          message.textContent = `正在同步 ${info.source}（${info.current}/${info.total}）…`;
        } else if (info.stage === "parsed" && info.coverage) {
          message.textContent = `${info.source} 完成，当前匹配 ${info.coverage.matched}/${info.coverage.target}`;
        }
      }
    });

    lastDictionaryCoverage = result.coverage;
    message.textContent = `同步完成：${result.coverage.matched}/${result.coverage.target}，覆盖率 ${result.coverage.percent}%`;
    button.textContent = "同步完成";

    setTimeout(showSettingsPage, 900);
  } catch (error) {
    console.error("增强词典同步失败：", error);
    message.textContent = `同步失败：${error.message || error}`;
    button.disabled = false;
  }
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(iso || "");
  }
}

async function showHomePage() {
  app.innerHTML = homePageHTML;
  bindHomeEvents();
  currentSession = await getTodaySession();
  await refreshHomeStats();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("cet6-cloud-data-updated", async () => {
  try {
    currentSession = await getTodaySession();
    if (document.getElementById("startReviewBtn")) {
      await refreshHomeStats();
    }
  } catch (error) {
    console.warn("云端数据刷新首页失败：", error);
  }
});

let cloudStatusRefreshTimer = null;

window.addEventListener("cet6-cloud-status", event => {
  // 修复 v2.1：首次同步完成后，设置页原先不会重绘，
  // 因而界面会一直停留在“同步中…”，即使后台已经完成。
  // 仅在“已登录”的设置页自动刷新；未登录/填写表单时不重绘，
  // 避免打断用户输入邮箱和密码。
  if (!document.querySelector(".cloud-card")) return;

  const status = event.detail || window.CET6Cloud?.getStatus?.();
  if (!status?.signedIn) return;

  if (cloudStatusRefreshTimer) clearTimeout(cloudStatusRefreshTimer);
  cloudStatusRefreshTimer = setTimeout(() => {
    if (!document.querySelector(".cloud-card")) return;
    showSettingsPage().catch(error => {
      console.warn("刷新云同步状态失败：", error);
    });
  }, 120);
});

async function initApp() {
  try {
    bindHomeEvents();
    await initReviewDB();
    await ensureFinalFreshStart();
    await initDictionaryDB();
    await loadVocabulary();
    await seedLocalDictionarySupplements(vocabulary);
    currentSession = await getTodaySession();
    await refreshHomeStats();

    // 首次启动后台初始化增强词典。失败不会影响背词主流程。
    dictionarySyncTask = ensureDictionaryData(vocabulary, {
      minPercent: 100,
      onProgress(info) {
        if (info.stage === "parsed" && info.coverage) {
          lastDictionaryCoverage = info.coverage;
          console.log(`增强词典：${info.coverage.matched}/${info.coverage.target}`);
        }
      }
    }).then(result => {
      if (result?.coverage) lastDictionaryCoverage = result.coverage;
      console.log("增强词典初始化完成：", result?.coverage || result);
      return result;
    }).catch(error => {
      console.warn("增强词典自动同步失败，主功能仍可正常使用：", error);
      return null;
    });

    console.log("CET6 Review v2.1.2 初始化完成");
  } catch (error) {
    console.error("App 初始化失败：", error);
    alert("App 初始化失败，请打开浏览器开发者工具查看错误。");
  }
}

initApp();
