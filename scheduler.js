// =======================================
// CET6 Review - scheduler.js
// v2.2.1 分轮学习 + 遗忘词间隔复习
// =======================================

const DAILY_TARGET = 200;
// 当天连续遗忘：第 1/2/3 次分别隔 10/25/50 个队列项，第 4 次及以后放到队尾。
// 这是交错练习的产品规则，不是精确的分钟数，也不是跨天间隔。
const REINFORCEMENT_GAPS = [10, 25, 50];
const SCHEDULER_VERSION = 2;

// 忘记词跨天复习间隔：首次忘记后 +1 天，之后每次跨天复习成功依次 +3/+7/+14/+30 天。
// 完成 30 天阶段后退出遗忘词强化链，等待下一轮正常出现。
const FORGOT_INTERVALS = [1, 3, 7, 14, 30];

// 2026-10-01 的旧调度会把前一天“认识”的词全部再次排入。
// v2.2.0 只丢弃这一天由旧算法产生的进度；不会按运行当天动态删除数据。
const SCHEDULER_V2_RESET_DATE = "2026-10-01";

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + Number(days || 0));
  return getLocalDateKey(date);
}

function safeRoundCount(record) {
  return Math.max(0, Number(record?.roundCount) || 0);
}

function isRemediationActive(record) {
  return Boolean(record?.remediationActive && record?.nextReviewDate);
}

function isRecordDue(record, todayKey = getLocalDateKey()) {
  return isRemediationActive(record) && record.nextReviewDate <= todayKey;
}

function compareDue(a, b) {
  const dueA = a.record.nextReviewDate || "9999-12-31";
  const dueB = b.record.nextReviewDate || "9999-12-31";
  if (dueA !== dueB) return dueA.localeCompare(dueB);
  return (a.word.source_order || 0) - (b.word.source_order || 0);
}

/**
 * 计算当前“分轮学习”的轮次。
 * 所有词至少完成第1轮后才进入第2轮；以此类推。
 */
function getCurrentRound(vocabulary, recordMap) {
  if (!Array.isArray(vocabulary) || vocabulary.length === 0) return 1;
  let minRound = Infinity;
  for (const word of vocabulary) {
    minRound = Math.min(minRound, safeRoundCount(recordMap.get(word.id)));
  }
  return Number.isFinite(minRound) ? minRound + 1 : 1;
}

/**
 * 当天正式任务：
 * 1) 到期遗忘词最高优先级；若超过200，全部加入，今天不加普通轮次词。
 * 2) 未超过200时，用当前轮尚未出现的词补足到200。
 * 3) “认识”的普通轮次词不会按1/3/7天回流，而是等整本完成本轮后再进入下一轮。
 * 4) 正在遗忘强化链中的词不会同时作为普通轮次词重复加入。
 */
function buildDailyPrimaryQueue(vocabulary, progressRecords, target = DAILY_TARGET, todayKey = getLocalDateKey()) {
  const recordMap = new Map((progressRecords || []).map(record => [record.id, record]));
  const currentRound = getCurrentRound(vocabulary, recordMap);

  const forgottenDue = [];
  const roundCandidates = [];

  for (const word of vocabulary || []) {
    const record = recordMap.get(word.id) || null;

    if (isRecordDue(record, todayKey)) {
      forgottenDue.push({ word, record });
      continue;
    }

    // 当前仍处于遗忘强化链、但尚未到期：今天不作为普通轮次词再次出现。
    if (isRemediationActive(record)) continue;

    if (safeRoundCount(record) < currentRound) {
      roundCandidates.push(word);
    }
  }

  forgottenDue.sort(compareDue);
  roundCandidates.sort((a, b) => (a.source_order || 0) - (b.source_order || 0));

  if (forgottenDue.length > target) {
    return {
      items: forgottenDue.map(item => ({ id: item.word.id, type: "review" })),
      meta: {
        schedulerVersion: SCHEDULER_VERSION,
        currentRound,
        forgottenDue: forgottenDue.length,
        roundAdded: 0,
        newAdded: 0,
        target,
        overflowBecauseForgotten: true
      }
    };
  }

  const selectedReviews = forgottenDue.map(item => ({ id: item.word.id, type: "review" }));
  const remaining = Math.max(0, target - selectedReviews.length);
  const selectedRound = roundCandidates.slice(0, remaining).map(word => ({ id: word.id, type: "primary" }));

  const newAdded = selectedRound.filter(item => safeRoundCount(recordMap.get(item.id)) === 0).length;

  return {
    items: [...selectedReviews, ...selectedRound],
    meta: {
      schedulerVersion: SCHEDULER_VERSION,
      currentRound,
      forgottenDue: forgottenDue.length,
      roundAdded: selectedRound.length,
      newAdded,
      target,
      overflowBecauseForgotten: false
    }
  };
}

/**
 * “忘了”后安排当天加练。历史 queue 项不删除，因此刷新、云同步和备份恢复后
 * 仍能推导本词的连续加练层级；同时兼容 v2.2.0 没有层级字段的队列。
 * cursor 是刚刚作答的项的位置（解析页纠错时传 session.cursor - 1）。
 * 队列不足指定间隔时放在队尾，不凭空增加单词，也不改变正式任务配额。
 */
function insertReinforcement(queue, cursor, wordId) {
  if (!Array.isArray(queue) || !Number.isInteger(cursor) || cursor < 0 || cursor >= queue.length) {
    throw new Error("无法安排加练：队列或作答位置无效");
  }
  const sameWord = item => String(item?.id) === String(wordId);
  if (!sameWord(queue[cursor])) throw new Error("无法安排加练：作答词与队列不一致");

  let previousAttempts = 0;
  let previousLevel = 0;
  for (let i = 0; i <= cursor; i++) {
    const item = queue[i];
    if (sameWord(item) && item.type === "reinforcement") {
      previousAttempts++;
      previousLevel = Math.max(previousLevel, Number(item.reinforcementLevel) || 0);
    }
  }
  const level = Math.max(previousAttempts, previousLevel) + 1;
  const gap = REINFORCEMENT_GAPS[level - 1];

  // 同一个词最多只保留一个“待做”加练项，避免重复点击/旧队列导致无限复制。
  for (let i = queue.length - 1; i > cursor; i--) {
    if (sameWord(queue[i]) && queue[i].type === "reinforcement") queue.splice(i, 1);
  }
  const insertIndex = gap == null ? queue.length : Math.min(cursor + 1 + gap, queue.length);
  queue.splice(insertIndex, 0, {
    id: wordId,
    type: "reinforcement",
    reinforcementLevel: level,
    scheduledGap: gap == null ? "tail" : gap
  });
  return insertIndex;
}
