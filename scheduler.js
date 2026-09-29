// =======================================
// CET6 Review - scheduler.js
// 复习调度规则
// =======================================

const DAILY_TARGET = 200;
const REINFORCEMENT_GAP = 10;

// “认识”后的连续答对间隔，最长固定为30天。
const KNOW_INTERVALS = [1, 3, 7, 14, 21, 30];

// 随机巡检预留。按当前需求“后面再加入”，所以现在关闭。
const RANDOM_PATROL_COUNT = 0;

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return getLocalDateKey(date);
}

function calculateNextReviewDate(rating, streak, todayKey = getLocalDateKey()) {
  if (rating === "forgot") {
    return addDaysToDateKey(todayKey, 1);
  }

  const safeStreak = Math.max(1, Number(streak) || 1);
  const index = Math.min(safeStreak - 1, KNOW_INTERVALS.length - 1);
  return addDaysToDateKey(todayKey, KNOW_INTERVALS[index]);
}

function isRecordDue(record, todayKey = getLocalDateKey()) {
  if (!record) return false;

  // 兼容上一版测试数据：没有 nextReviewDate 的旧记录视为到期。
  if (!record.nextReviewDate) return true;

  return record.nextReviewDate <= todayKey;
}

function compareOldDue(a, b) {
  const dueA = a.record.nextReviewDate || "0000-00-00";
  const dueB = b.record.nextReviewDate || "0000-00-00";

  if (dueA !== dueB) {
    return dueA.localeCompare(dueB);
  }

  return (a.word.source_order || 0) - (b.word.source_order || 0);
}

/**
 * 生成当天“首轮”复习队列。
 *
 * 规则：
 * 1. 前几天忘记且今天已到期的词最优先。
 * 2. 如果忘记词 > 200：全部忘记词都要复习，允许超过200；不加其他词。
 * 3. 如果忘记词 <= 200：再加入已经到期的“认识”词。
 * 4. 仍不足200时，按词库 source_order 顺序加入从未复习的新词。
 * 5. 总量一般控制在200；只有“到期忘记词本身 > 200”时才主动突破200。
 */
function buildDailyPrimaryQueue(vocabulary, progressRecords, target = DAILY_TARGET) {
  const recordMap = new Map(progressRecords.map(record => [record.id, record]));
  const todayKey = getLocalDateKey();

  const forgottenDue = [];
  const knownDue = [];
  const unseen = [];

  for (const word of vocabulary) {
    const record = recordMap.get(word.id);

    if (!record) {
      unseen.push(word);
      continue;
    }

    if (!isRecordDue(record, todayKey)) {
      continue;
    }

    if (record.lastRating === "forgot") {
      forgottenDue.push({ word, record });
    } else {
      knownDue.push({ word, record });
    }
  }

  forgottenDue.sort(compareOldDue);
  knownDue.sort(compareOldDue);
  unseen.sort((a, b) => (a.source_order || 0) - (b.source_order || 0));

  // 忘记词积压超过目标：今天只清忘记词，不再加入其他复习/新词。
  if (forgottenDue.length > target) {
    return {
      items: forgottenDue.map(item => ({ id: item.word.id, type: "primary" })),
      meta: {
        forgottenDue: forgottenDue.length,
        knownDueAdded: 0,
        newAdded: 0,
        target,
        overflowBecauseForgotten: true
      }
    };
  }

  const selected = forgottenDue.map(item => item.word);
  let remaining = Math.max(0, target - selected.length);

  const knownToAdd = knownDue.slice(0, remaining).map(item => item.word);
  selected.push(...knownToAdd);
  remaining = Math.max(0, target - selected.length);

  const newToAdd = unseen.slice(0, remaining);
  selected.push(...newToAdd);

  // RANDOM_PATROL_COUNT 目前为0，保留扩展点但不实际加入随机巡检。

  return {
    items: selected.map(word => ({ id: word.id, type: "primary" })),
    meta: {
      forgottenDue: forgottenDue.length,
      knownDueAdded: knownToAdd.length,
      newAdded: newToAdd.length,
      target,
      overflowBecauseForgotten: false
    }
  };
}

/**
 * “忘了”后把同一个词插到稍后位置，只加练一次。
 * cursor 是当前正在作答的索引。
 */
function insertReinforcement(queue, cursor, wordId, gap = REINFORCEMENT_GAP) {
  const insertIndex = Math.min(cursor + 1 + gap, queue.length);
  queue.splice(insertIndex, 0, {
    id: wordId,
    type: "reinforcement"
  });
  return insertIndex;
}
