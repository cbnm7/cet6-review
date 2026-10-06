// 阅读生词 v3.2.0 — 可离线、可清空字段的同步模型（无网络/数据库副作用）。
// 每个可编辑字段有独立版本。相同时刻以设备标识、字段值稳定裁决，避免两端反复覆盖。
(function (root) {
  "use strict";
  const FIELDS = ["term", "meaning", "source", "sentence", "note"];
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const normalize = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const iso = value => time(value) ? new Date(time(value)).toISOString() : EPOCH;
  const compare = (a, b) => a === b ? 0 : (a > b ? 1 : -1);
  const latest = (...values) => new Date(Math.max(0, ...values.map(time))).toISOString();

  function cleanWord(record) {
    const normalizedTerm = normalize(record?.normalizedTerm || record?.term);
    if (!normalizedTerm) return null;
    const updatedAt = iso(record.updatedAt || record.createdAt);
    const word = {
      term: String(record.term || normalizedTerm).trim().replace(/\s+/g, " "),
      normalizedTerm,
      meaning: String(record.meaning ?? ""),
      source: String(record.source ?? ""),
      sentence: String(record.sentence ?? ""),
      note: String(record.note ?? ""),
      occurrenceCount: Math.max(1, Math.floor(Number(record.occurrenceCount) || 1)),
      createdAt: iso(record.createdAt || updatedAt),
      updatedAt,
      syncVersion: 2,
      fieldVersions: {},
      generationAt: iso(record.generationAt || record.createdAt || updatedAt),
      restoredAfter: record.restoredAfter ? iso(record.restoredAfter) : ""
    };
    for (const field of FIELDS) {
      const stamp = record.fieldVersions?.[field];
      // 旧版空字符串意为“未填写”，不是明确删除；真正清空时会写入新的字段版本。
      word.fieldVersions[field] = {
        at: stamp?.at ? iso(stamp.at) : (word[field] ? updatedAt : EPOCH),
        actor: String(stamp?.actor || "")
      };
    }
    word.updatedAt = latest(updatedAt, ...FIELDS.map(f => word.fieldVersions[f].at));
    return word;
  }

  function cleanTombstone(record) {
    const normalizedTerm = normalize(record?.normalizedTerm);
    if (!normalizedTerm) return null;
    const deletedAt = iso(record.deletedAt || record.updatedAt);
    return { normalizedTerm, deletedAt, updatedAt: deletedAt, syncVersion: 2 };
  }

  function mergeWords(a, b) {
    const left = cleanWord(a), right = cleanWord(b);
    if (!left) return right;
    if (!right) return left;
    if (left.normalizedTerm !== right.normalizedTerm) throw new Error("不能合并不同词条");
    // 用户在看到删除标记后主动重新添加：不要把被删除的旧正文补回新一代词条。
    if (left.restoredAfter && time(left.restoredAfter) >= time(right.generationAt) &&
        time(left.generationAt) > time(right.generationAt)) return left;
    if (right.restoredAfter && time(right.restoredAfter) >= time(left.generationAt) &&
        time(right.generationAt) > time(left.generationAt)) return right;
    const result = { ...left, fieldVersions: {} };
    for (const field of FIELDS) {
      const l = left.fieldVersions[field], r = right.fieldVersions[field];
      const order = compare(time(l.at), time(r.at)) || compare(l.actor, r.actor) || compare(left[field], right[field]);
      const winner = order >= 0 ? left : right;
      result[field] = winner[field]; // 空字符串也是一个有效的修改，绝不使用 || 回填。
      result.fieldVersions[field] = { ...winner.fieldVersions[field] };
    }
    result.occurrenceCount = Math.max(left.occurrenceCount, right.occurrenceCount);
    result.createdAt = time(left.createdAt) <= time(right.createdAt) ? left.createdAt : right.createdAt;
    result.updatedAt = latest(left.updatedAt, right.updatedAt);
    result.generationAt = latest(left.generationAt, right.generationAt);
    result.restoredAfter = left.restoredAfter || right.restoredAfter
      ? latest(left.restoredAfter, right.restoredAfter) : "";
    return result;
  }

  function wordState(record) {
    const word = cleanWord(record);
    return word ? { kind: "word", key: word.normalizedTerm, word } : null;
  }
  function deletedState(record) {
    const tombstone = cleanTombstone(record);
    return tombstone ? { kind: "deleted", key: tombstone.normalizedTerm, tombstone } : null;
  }
  function mergeStates(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.key !== b.key) throw new Error("同步词条键不一致");
    if (a.kind === "word" && b.kind === "word") return wordState(mergeWords(a.word, b.word));
    if (a.kind === "deleted" && b.kind === "deleted") {
      return time(a.tombstone.deletedAt) >= time(b.tombstone.deletedAt) ? a : b;
    }
    const live = a.kind === "word" ? a : b;
    const dead = a.kind === "deleted" ? a : b;
    // 编辑旧副本不会重建词条；只有用户明确新增/重新添加的新一代记录可以超过删除。
    const revived = time(live.word.generationAt) > time(dead.tombstone.deletedAt) ||
      (live.word.restoredAfter && time(live.word.restoredAfter) >= time(dead.tombstone.deletedAt));
    return revived ? live : dead;
  }
  const equalStates = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function nextTime(...records) {
    const previous = records.filter(Boolean).flatMap(r => [
      r.updatedAt, r.deletedAt, r.createdAt, r.generationAt,
      ...Object.values(r.fieldVersions || {}).map(v => v.at)
    ]);
    return new Date(Math.max(Date.now(), ...previous.map(v => time(v) + 1))).toISOString();
  }
  function patchWord(record, patch, actor, at) {
    const word = cleanWord(record);
    if (!word) throw new Error("无效词条");
    for (const field of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      const value = String(patch[field] ?? "").trim();
      const clean = field === "term" ? value.replace(/\s+/g, " ") : value;
      if (clean === word[field]) continue;
      word[field] = clean;
      word.fieldVersions[field] = { at, actor };
    }
    word.normalizedTerm = normalize(word.term);
    if (!word.normalizedTerm) throw new Error("请输入单词或短语");
    word.updatedAt = at;
    return word;
  }
  root.ReadingWordsModel = {
    FIELDS, EPOCH, normalize, time, cleanWord, cleanTombstone, mergeWords,
    wordState, deletedState, mergeStates, equalStates, nextTime, patchWord
  };
})(globalThis);
