// =======================================
// CET6 Review - dictionary.js
// v1.3 词典审校版
//
// 目标：
// - 保留英美音标、核心中文释义、常用搭配、双语例句
// - 过滤法律/技术/网络标签等不适合六级记忆的低价值条目
// - 对明显生硬、误导性的短语翻译做清洗或剔除
// - 每个词只保留少量高价值搭配与例句，避免信息过载
// =======================================

const DICT_DB_NAME = "cet6-dictionary-db";
const DICT_DB_VERSION = 3; // v1.5 升级：扩展词典源 + 本地补充，重建旧缓存
const DICT_ENTRY_STORE = "entries";
const DICT_META_STORE = "meta";
const DICTIONARY_QUALITY_VERSION = "1.5";

let dictionaryDB = null;

const DICTIONARY_BASE_URL = "https://cdn.jsdelivr.net/gh/KyleBing/english-vocabulary@master/full_line_tsv/sentence/%E6%AD%A3%E5%BA%8F/";

function dictionarySource(name) {
  return {
    name: `${name}词库`,
    url: `${DICTIONARY_BASE_URL}${encodeURIComponent(name)}.txt`
  };
}

// 从最贴近六级的词库开始，再逐步扩大覆盖面。
// 本地补充负责固定短语与少量特殊词；公开词库负责普通单词的释义、音标、搭配和例句。
const DICTIONARY_SOURCES = [
  dictionarySource("六级"),
  dictionarySource("四级"),
  dictionarySource("考研"),
  dictionarySource("高中"),
  dictionarySource("雅思"),
  dictionarySource("托福"),
  dictionarySource("专八"),
  dictionarySource("SAT"),
  dictionarySource("GRE")
];

// 明确不适合当作六级“常见搭配”展示的来源条目。
// 例如 said to contain 在海运提单中是术语，但对一般六级学习会造成误导。
const BLOCKED_PHRASES = new Set([
  "said to contain"
]);

// 源词表中已确认的异常项：不编造释义，明确标记来源异常。
const TERM_OVERRIDES = {
  "4th": {
    translations: [
      { type: "num.", translation: "第四；第四个（fourth 的数字写法）" }
    ],
    phrases: [],
    sentences: []
  },
  "mir": {
    translations: [
      { type: "", translation: "词表源异常项：不是常规六级核心词头，建议跳过" }
    ],
    phrases: [],
    sentences: []
  },
  "lehman": {
    translations: [
      { type: "", translation: "词表源异常项：专名性质明显，不作为普通六级词汇记忆" }
    ],
    phrases: [],
    sentences: []
  }
};


// =======================================
// 本地补充词典
// =======================================
// 这些条目主要解决“核心词表是固定短语，但上游词典只收单词”的缺口。
// 释义按常见六级阅读语境整理；这里只放核心义，不额外制造生硬搭配。
const LOCAL_SUPPLEMENTS = {
  "wipe out": { type: "phr.", cn: "彻底消灭；摧毁；擦掉" },
  "be subject to": { type: "phr.", cn: "受……影响或制约；须经受；取决于" },
  "figure out": { type: "phr.", cn: "弄清楚；想出；计算出" },
  "keep track of": { type: "phr.", cn: "掌握……的动态；记录；持续了解" },
  "take charge of": { type: "phr.", cn: "负责；接管；主管" },
  "attach importance to something": { type: "phr.", cn: "重视某事" },
  "feed on or off something": { type: "phr.", cn: "以……为食；从……获取养分或能量（通常说 feed on sth）" },
  "a tribute": { type: "n. phr.", cn: "表示敬意的事物；致敬；赞颂" },
  "take for granted": { type: "phr.", cn: "认为……理所当然；想当然地认为" },
  "be bound to do": { type: "phr.", cn: "一定会做；必然会做" },
  "an insight into something": { type: "n. phr.", cn: "对某事的深入了解；洞察" },
  "a host of": { type: "phr.", cn: "大量的；许多的" },
  "arise from something": { type: "phr.", cn: "由……产生；由……引起" },
  "in essence": { type: "phr.", cn: "本质上；实质上" },
  "an array of": { type: "phr.", cn: "一系列；大量" },
  "I swear": { type: "phr.", cn: "我发誓；我保证" },
  "be consistent with something": { type: "phr.", cn: "与……一致；与……相符" },
  "feel obliged to do": { type: "phr.", cn: "觉得有义务做……；觉得不得不做……" },
  "cling to": { type: "phr.", cn: "紧紧抓住；坚持；依恋" },
  "pave the way for": { type: "phr.", cn: "为……铺平道路；为……创造条件" },
  "up to date": { type: "phr.", cn: "最新的；掌握最新情况的" },
  "manifest itself in something": { type: "phr.", cn: "以……形式表现出来；在……中显现" },
  "well off": { type: "adj. phr.", cn: "富裕的；境况良好的" },
  "in fact": { type: "phr.", cn: "事实上；实际上" },
  "lay off": { type: "phr.", cn: "解雇；停止；暂停" },
  "to date": { type: "phr.", cn: "迄今为止；到目前为止" },
  "take over": { type: "phr.", cn: "接管；接替；取得控制权" },
  "take on": { type: "phr.", cn: "承担；呈现；雇用；与……较量" },
  "take up": { type: "phr.", cn: "开始从事；占用；接受；继续" },
  "attend to": { type: "phr.", cn: "处理；照料；专心于" },
  "put up": { type: "phr.", cn: "张贴；搭建；提供住宿；举起" },
  "go through": { type: "phr.", cn: "经历；仔细检查；通过；完成" },
  "cut back": { type: "phr.", cn: "削减；减少" },
  "in line with something": { type: "phr.", cn: "与……一致；符合……" },
  "make for something": { type: "phr.", cn: "促成；有助于；走向……" },
  "on the part of somebody": { type: "phr.", cn: "就某人而言；由某人所做" },
  "pulled back": { type: "phr.", cn: "撤回；退却；拉回" },
  "for all": { type: "phr.", cn: "尽管；虽然" },
  "translate into something": { type: "phr.", cn: "转化为；转变成；翻译成" },
  "among other things": { type: "phr.", cn: "除了其他事情外；其中包括" },
  "in view of something": { type: "phr.", cn: "鉴于；考虑到" },
  "relate to": { type: "phr.", cn: "与……有关；涉及；理解并认同" },
  "allow for": { type: "phr.", cn: "考虑到；把……计算在内；为……留出余地" },
  "at will": { type: "phr.", cn: "随意地；任意地" },
  "by and large": { type: "phr.", cn: "总的来说；大体上" },
  "come down to something": { type: "phr.", cn: "归结为；最终取决于" },
  "fall short of something": { type: "phr.", cn: "未达到；低于；不符合" },
  "follow suit": { type: "phr.", cn: "仿效；照着做" },
  "in a sense": { type: "phr.", cn: "在某种意义上" },
  "in effect": { type: "phr.", cn: "实际上；事实上；正在实施" },
  "in light of something": { type: "phr.", cn: "鉴于；考虑到；根据" },
  "lay down": { type: "phr.", cn: "制定；规定；放下；铺设" },
  "let alone": { type: "phr.", cn: "更不用说；更别提" },
  "look out for": { type: "phr.", cn: "留意；当心；照看" },
  "turn to": { type: "phr.", cn: "转向；求助于；开始使用" },
  "in the midst of something": { type: "phr.", cn: "在……之中；在……进行期间" },
  "life expectancy": { type: "n. phr.", cn: "预期寿命；平均寿命" },
  "real estate": { type: "n. phr.", cn: "房地产；不动产" },

  // 少量现代词、派生词或上游覆盖不稳定的词，提供本地兜底。
  "well-being": { type: "n.", cn: "幸福；健康；福祉" },
  "so-called": { type: "adj.", cn: "所谓的；号称的" },
  "outdated": { type: "adj.", cn: "过时的；陈旧的" },
  "nonprofit": { type: "adj./n.", cn: "非营利的；非营利组织" },
  "workforce": { type: "n.", cn: "劳动力；全体员工" },
  "dropout": { type: "n.", cn: "辍学者；中途退出者" },
  "billionaire": { type: "n.", cn: "亿万富翁" },
  "managerial": { type: "adj.", cn: "管理的；经理的" },
  "methodology": { type: "n.", cn: "方法论；研究方法" },
  "mindset": { type: "n.", cn: "思维方式；心态" },
  "globalize": { type: "v.", cn: "使全球化；全球化" },
  "multicultural": { type: "adj.", cn: "多元文化的" },
  "wireless": { type: "adj./n.", cn: "无线的；无线通信；无线电" },
  "supportive": { type: "adj.", cn: "支持的；给予帮助的" },
  "interactive": { type: "adj.", cn: "互动的；交互式的" },
  "mainstream": { type: "n./adj.", cn: "主流；主流的" },
  "undergraduate": { type: "n./adj.", cn: "本科生；本科阶段的" },
  "medicare": { type: "n.", cn: "医疗保险制度；（美国）老年人医疗保险" },
  "mechanics": { type: "n.", cn: "力学；机械学；运作方式" },
  "adventurers": { type: "n.", cn: "冒险者；冒险家（adventurer 的复数）" },
  "brows": { type: "n.", cn: "眉；眉毛（brow 的复数）" },
  "incidents": { type: "n.", cn: "事件；事故（incident 的复数）" },
  "underly": { type: "v.", cn: "位于……之下；构成……的基础（较少见，通常用 underlie）" }
};

function makeLocalSupplementEntry(term, payload, source = "本地补充") {
  return sanitizeDictionaryEntry({
    normalizedTerm: normalizeDictionaryTerm(term),
    term,
    us: "",
    uk: "",
    translations: [{ type: payload.type || "", translation: payload.cn || "" }],
    phrases: [],
    sentences: [],
    sources: [source],
    qualityVersion: DICTIONARY_QUALITY_VERSION,
    updatedAt: new Date().toISOString()
  });
}

async function seedLocalDictionarySupplements(vocabulary = []) {
  if (!dictionaryDB) return;

  const targetKeys = new Set((vocabulary || []).map(item => normalizeDictionaryTerm(item.term)));
  const entries = [];

  for (const [term, payload] of Object.entries(LOCAL_SUPPLEMENTS)) {
    const key = normalizeDictionaryTerm(term);
    if (!targetKeys.size || targetKeys.has(key)) {
      entries.push(makeLocalSupplementEntry(term, payload));
    }
  }

  // 异常项也始终本地可用，不依赖联网。
  for (const [term, override] of Object.entries(TERM_OVERRIDES)) {
    const key = normalizeDictionaryTerm(term);
    if (targetKeys.size && !targetKeys.has(key)) continue;
    entries.push(sanitizeDictionaryEntry({
      normalizedTerm: key,
      term,
      us: "",
      uk: "",
      translations: override.translations || [],
      phrases: override.phrases || [],
      sentences: override.sentences || [],
      sources: ["本地审校"],
      qualityVersion: DICTIONARY_QUALITY_VERSION,
      updatedAt: new Date().toISOString()
    }));
  }

  if (entries.length) await putDictionaryEntries(entries);
}

function normalizeDictionaryTerm(term) {
  return String(term || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function initDictionaryDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DICT_DB_NAME, DICT_DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      // v1.3 质量规则发生变化，直接重建增强词典缓存。
      if (db.objectStoreNames.contains(DICT_ENTRY_STORE)) {
        db.deleteObjectStore(DICT_ENTRY_STORE);
      }
      if (db.objectStoreNames.contains(DICT_META_STORE)) {
        db.deleteObjectStore(DICT_META_STORE);
      }

      db.createObjectStore(DICT_ENTRY_STORE, { keyPath: "normalizedTerm" });
      db.createObjectStore(DICT_META_STORE, { keyPath: "key" });
    };

    request.onsuccess = event => {
      dictionaryDB = event.target.result;
      console.log("增强词典 IndexedDB 已连接（补全版 v1.5）");
      resolve(dictionaryDB);
    };

    request.onerror = () => reject(request.error);
  });
}

function getDictionaryEntry(term) {
  const key = normalizeDictionaryTerm(term);

  return new Promise((resolve, reject) => {
    if (!dictionaryDB || !key) {
      resolve(null);
      return;
    }

    const tx = dictionaryDB.transaction(DICT_ENTRY_STORE, "readonly");
    const request = tx.objectStore(DICT_ENTRY_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function getAllDictionaryEntries() {
  return new Promise((resolve, reject) => {
    if (!dictionaryDB) {
      resolve([]);
      return;
    }

    const tx = dictionaryDB.transaction(DICT_ENTRY_STORE, "readonly");
    const request = tx.objectStore(DICT_ENTRY_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getDictionaryMeta(key) {
  return new Promise((resolve, reject) => {
    if (!dictionaryDB) {
      resolve(null);
      return;
    }

    const tx = dictionaryDB.transaction(DICT_META_STORE, "readonly");
    const request = tx.objectStore(DICT_META_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function putDictionaryMeta(record) {
  return new Promise((resolve, reject) => {
    const tx = dictionaryDB.transaction(DICT_META_STORE, "readwrite");
    const request = tx.objectStore(DICT_META_STORE).put(record);
    request.onsuccess = () => resolve(record);
    request.onerror = () => reject(request.error);
  });
}

async function putDictionaryEntries(entries) {
  if (!entries.length) return;

  const CHUNK = 300;

  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK);

    await new Promise((resolve, reject) => {
      const tx = dictionaryDB.transaction(DICT_ENTRY_STORE, "readwrite");
      const store = tx.objectStore(DICT_ENTRY_STORE);

      chunk.forEach(entry => store.put(entry));

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("词典写入事务被中止"));
    });
  }
}

function dictionaryUnescape(text) {
  return String(text || "")
    .replace(/\\\\/g, "\u0000")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\u0000/g, "\\");
}

function splitDictionaryItems(cell) {
  if (!cell) return [];
  return String(cell)
    .split("¦")
    .map(item => dictionaryUnescape(item).trim())
    .filter(Boolean);
}

function parseTranslationCell(cell) {
  return splitDictionaryItems(cell)
    .map(item => {
      const parts = item.split("::");
      return {
        type: (parts[0] || "").trim(),
        translation: (parts[1] || "").trim()
      };
    })
    .filter(item => item.translation);
}

function parsePhraseCell(cell) {
  return splitDictionaryItems(cell)
    .map(item => {
      const parts = item.split("::");
      return {
        phrase: (parts[0] || "").trim(),
        translation: (parts.slice(1).join("::") || "").trim()
      };
    })
    .filter(item => item.phrase);
}

function parseSentenceCell(cell) {
  return splitDictionaryItems(cell)
    .map(item => {
      const parts = item.split("::");
      return {
        en: (parts[0] || "").trim(),
        cn: (parts.slice(1).join("::") || "").trim()
      };
    })
    .filter(item => item.en);
}

function parseSentenceTsvLine(line, sourceName) {
  const cols = String(line || "").replace(/\r$/, "").split("\t");
  if (cols.length < 4) return null;

  const term = dictionaryUnescape(cols[0]).trim();
  if (!term) return null;

  return {
    normalizedTerm: normalizeDictionaryTerm(term),
    term,
    us: dictionaryUnescape(cols[1] || "").trim(),
    uk: dictionaryUnescape(cols[2] || "").trim(),
    translations: parseTranslationCell(cols[3] || ""),
    phrases: parsePhraseCell(cols[4] || ""),
    sentences: parseSentenceCell(cols[5] || ""),
    sources: [sourceName],
    qualityVersion: DICTIONARY_QUALITY_VERSION,
    updatedAt: new Date().toISOString()
  };
}

function uniqueObjects(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function stripSourceLabels(text) {
  return String(text || "")
    .replace(/\[(?:网络|网|医|医学|化|化学|计|计算机|经|经济|法|法律|商)\]\s*/g, "")
    .replace(/【(?:网络|网|医|医学|化|化学|计|计算机|经|经济|法|法律|商)】\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeChineseText(text) {
  return stripSourceLabels(text)
    .replace(/据称内装/g, "据说含有")
    .replace(/在…的能力/g, "……方面的能力")
    .replace(/\s*；\s*/g, "；")
    .replace(/\s*，\s*/g, "，")
    .trim();
}

function isClearlySpecializedTranslation(text) {
  const raw = String(text || "");
  return /\[(?:网络|网|医|医学|化|化学|计|计算机|经|经济|法|法律|商)\]|【(?:网络|网|医|医学|化|化学|计|计算机|经|经济|法|法律|商)】|人名|地名|姓氏/.test(raw);
}

function sanitizeTranslations(items) {
  const cleaned = uniqueObjects(
    (items || [])
      .map(item => ({
        type: String(item.type || "").trim(),
        translation: normalizeChineseText(item.translation)
      }))
      .filter(item => item.translation),
    item => `${item.type}|${item.translation}`
  );

  const general = cleaned.filter(item => !isClearlySpecializedTranslation(item.translation));
  const selected = general.length ? general : cleaned;

  // 六级复习优先展示最常用的少量义项，避免塞入过多专名/边缘义。
  return selected.slice(0, 5);
}

function termAppearsInPhrase(term, phrase) {
  const t = normalizeDictionaryTerm(term);
  const p = normalizeDictionaryTerm(phrase);
  if (!t || !p) return false;

  if (t.includes(" ")) {
    return p.includes(t);
  }

  return new RegExp(`(^|[^a-z])${escapeRegExp(t)}([^a-z]|$)`, "i").test(p);
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseQualityScore(term, item) {
  const phrase = normalizeDictionaryTerm(item.phrase);
  const tokens = phrase.split(/\s+/).filter(Boolean);
  let score = 0;

  if (phrase.startsWith(normalizeDictionaryTerm(term) + " ")) score += 4;
  if (phrase.endsWith(" " + normalizeDictionaryTerm(term))) score += 3;
  if (/\b(to|of|for|with|on|in|from|into|against|over|under|at)\b/.test(phrase)) score += 3;
  if (tokens.length >= 2 && tokens.length <= 4) score += 3;
  if (tokens.length === 2) score += 1;
  if (item.translation && item.translation.length <= 18) score += 1;

  return score;
}

function isUsefulPhrase(term, item) {
  const phrase = normalizeDictionaryTerm(item.phrase);
  const translation = String(item.translation || "").trim();

  if (!phrase || !translation) return false;
  if (BLOCKED_PHRASES.has(phrase)) return false;
  if (phrase === normalizeDictionaryTerm(term)) return false;
  if (!termAppearsInPhrase(term, phrase)) return false;

  const tokens = phrase.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  if (/https?:\/\/|www\.|\d{2,}|[%<>_=]/i.test(phrase)) return false;
  if (/\[(?:网络|网|医|医学|化|化学|计|计算机|经|经济|法|法律|商)\]|【(?:网络|网|医|医学|化|化学|计|计算机|经|经济|法|法律|商)】/.test(translation)) return false;
  if (/据称内装/.test(translation)) return false;
  if (translation.length > 36) return false;

  return true;
}

function sanitizePhrases(term, items) {
  const cleaned = uniqueObjects(
    (items || [])
      .map(item => ({
        phrase: String(item.phrase || "").replace(/\s+/g, " ").trim(),
        translation: normalizeChineseText(item.translation)
      }))
      .filter(item => isUsefulPhrase(term, item)),
    item => `${normalizeDictionaryTerm(item.phrase)}|${item.translation}`
  );

  return cleaned
    .map((item, index) => ({ ...item, _sourceIndex: index, _score: phraseQualityScore(term, item) }))
    .sort((a, b) => (b._score - a._score) || (a._sourceIndex - b._sourceIndex))
    .slice(0, 5)
    .map(({ _sourceIndex, _score, ...item }) => item);
}

function sentenceContainsTerm(term, sentence) {
  const t = normalizeDictionaryTerm(term);
  const s = normalizeDictionaryTerm(sentence);

  if (!t || !s) return false;
  if (t.includes(" ")) return s.includes(t);

  if (new RegExp(`(^|[^a-z])${escapeRegExp(t)}([^a-z]|$)`, "i").test(s)) {
    return true;
  }

  // 允许常见屈折变化：例如 commit -> committed / committing。
  if (t.length >= 5) {
    const stem = t.slice(0, Math.max(4, t.length - 2));
    return new RegExp(`(^|[^a-z])${escapeRegExp(stem)}[a-z]*([^a-z]|$)`, "i").test(s);
  }

  return false;
}

function sentenceQualityScore(term, item) {
  const words = String(item.en || "").trim().split(/\s+/).filter(Boolean).length;
  let score = 0;

  if (words >= 8 && words <= 20) score += 4;
  else if (words >= 5 && words <= 28) score += 2;

  if (sentenceContainsTerm(term, item.en)) score += 4;
  if (item.cn && item.cn.length >= 6 && item.cn.length <= 45) score += 2;
  if (!/[()\[\]{};]/.test(item.en)) score += 1;

  return score;
}

function isUsefulSentence(term, item) {
  const en = String(item.en || "").trim();
  const cn = normalizeChineseText(item.cn);
  if (!en || !cn) return false;

  const words = en.split(/\s+/).filter(Boolean).length;
  if (words < 5 || words > 30) return false;
  if (!sentenceContainsTerm(term, en)) return false;
  if (/https?:\/\/|www\.|©|doi:|ISBN|\bfig\.?\s*\d+/i.test(en)) return false;
  if ((en.match(/\d/g) || []).length >= 4) return false;
  if (cn.length < 5 || cn.length > 80) return false;
  if (/\[(?:网络|网|医|医学|化|化学|计|计算机|经|经济|法|法律|商)\]/.test(cn)) return false;

  return true;
}

function sanitizeSentences(term, items) {
  const cleaned = uniqueObjects(
    (items || [])
      .map(item => ({
        en: String(item.en || "").replace(/\s+/g, " ").trim(),
        cn: normalizeChineseText(item.cn)
      }))
      .filter(item => isUsefulSentence(term, item)),
    item => item.en.toLowerCase()
  );

  return cleaned
    .map((item, index) => ({ ...item, _sourceIndex: index, _score: sentenceQualityScore(term, item) }))
    .sort((a, b) => (b._score - a._score) || (a._sourceIndex - b._sourceIndex))
    .slice(0, 2)
    .map(({ _sourceIndex, _score, ...item }) => item);
}

function applyTermOverride(entry) {
  const override = TERM_OVERRIDES[entry.normalizedTerm];
  if (!override) return entry;

  return {
    ...entry,
    translations: override.translations ?? entry.translations,
    phrases: override.phrases ?? entry.phrases,
    sentences: override.sentences ?? entry.sentences,
    qualityNote: "manual-override"
  };
}

function sanitizeDictionaryEntry(entry) {
  if (!entry) return null;

  let cleaned = {
    ...entry,
    translations: sanitizeTranslations(entry.translations || []),
    phrases: sanitizePhrases(entry.term, entry.phrases || []),
    sentences: sanitizeSentences(entry.term, entry.sentences || []),
    qualityVersion: DICTIONARY_QUALITY_VERSION,
    updatedAt: new Date().toISOString()
  };

  cleaned = applyTermOverride(cleaned);
  return cleaned;
}

function mergeDictionaryEntries(oldEntry, newEntry) {
  if (!oldEntry) return sanitizeDictionaryEntry(newEntry);

  const merged = {
    ...oldEntry,
    term: oldEntry.term || newEntry.term,
    us: oldEntry.us || newEntry.us,
    uk: oldEntry.uk || newEntry.uk,
    translations: uniqueObjects(
      [...(oldEntry.translations || []), ...(newEntry.translations || [])],
      item => `${item.type}|${item.translation}`
    ),
    phrases: uniqueObjects(
      [...(oldEntry.phrases || []), ...(newEntry.phrases || [])],
      item => `${normalizeDictionaryTerm(item.phrase)}|${item.translation}`
    ),
    sentences: uniqueObjects(
      [...(oldEntry.sentences || []), ...(newEntry.sentences || [])],
      item => item.en
    ),
    sources: Array.from(new Set([...(oldEntry.sources || []), ...(newEntry.sources || [])])),
    updatedAt: new Date().toISOString()
  };

  return sanitizeDictionaryEntry(merged);
}

async function fetchTextWithTimeout(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getDictionaryCoverage(vocabulary) {
  const entries = await getAllDictionaryEntries();
  const targetKeys = new Set(vocabulary.map(item => normalizeDictionaryTerm(item.term)));
  const matched = entries.filter(item => targetKeys.has(item.normalizedTerm));

  return {
    target: targetKeys.size,
    matched: matched.length,
    missing: Math.max(0, targetKeys.size - matched.length),
    percent: targetKeys.size > 0 ? Math.round((matched.length / targetKeys.size) * 100) : 0
  };
}

async function syncDictionaryForVocabulary(vocabulary, options = {}) {
  if (!dictionaryDB) {
    throw new Error("增强词典数据库尚未初始化");
  }

  // 固定短语和少量特殊词先走本地补充，离线也有释义。
  await seedLocalDictionarySupplements(vocabulary);

  const onProgress = typeof options.onProgress === "function"
    ? options.onProgress
    : () => {};

  const targetKeys = new Set(vocabulary.map(item => normalizeDictionaryTerm(item.term)));
  const existing = await getAllDictionaryEntries();
  const mergedMap = new Map(existing.map(item => [item.normalizedTerm, item]));

  // 先写入已确认的异常项说明，避免它们被远端错误解释覆盖。
  const overrideEntries = Object.keys(TERM_OVERRIDES)
    .filter(key => targetKeys.has(key))
    .map(key => sanitizeDictionaryEntry({
      normalizedTerm: key,
      term: key,
      us: "",
      uk: "",
      translations: [],
      phrases: [],
      sentences: [],
      sources: ["本地审校"],
      updatedAt: new Date().toISOString()
    }));

  overrideEntries.forEach(entry => mergedMap.set(entry.normalizedTerm, entry));
  if (overrideEntries.length) await putDictionaryEntries(overrideEntries);

  let sourceSuccess = 0;
  const errors = [];

  for (let sourceIndex = 0; sourceIndex < DICTIONARY_SOURCES.length; sourceIndex++) {
    const source = DICTIONARY_SOURCES[sourceIndex];

    onProgress({
      stage: "fetching",
      source: source.name,
      current: sourceIndex + 1,
      total: DICTIONARY_SOURCES.length
    });

    try {
      const text = await fetchTextWithTimeout(source.url);
      const lines = text.split(/\n/);
      const updates = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseSentenceTsvLine(line, source.name);
        if (!parsed || !targetKeys.has(parsed.normalizedTerm)) continue;

        // 本地异常项不再用远端内容覆盖。
        if (TERM_OVERRIDES[parsed.normalizedTerm]) continue;

        const merged = mergeDictionaryEntries(mergedMap.get(parsed.normalizedTerm), parsed);
        mergedMap.set(parsed.normalizedTerm, merged);
        updates.push(merged);
      }

      if (updates.length) {
        await putDictionaryEntries(updates);
      }

      sourceSuccess++;

      const coverage = await getDictionaryCoverage(vocabulary);
      onProgress({
        stage: "parsed",
        source: source.name,
        current: sourceIndex + 1,
        total: DICTIONARY_SOURCES.length,
        coverage
      });

      if (coverage.missing === 0) {
        break;
      }
    } catch (error) {
      console.warn(`词典源同步失败：${source.name}`, error);
      errors.push(`${source.name}: ${error.message || error}`);
    }
  }

  const coverage = await getDictionaryCoverage(vocabulary);

  await putDictionaryMeta({
    key: "sync",
    qualityVersion: DICTIONARY_QUALITY_VERSION,
    lastSyncAt: new Date().toISOString(),
    sourceSuccess,
    errors,
    coverage
  });

  return {
    coverage,
    sourceSuccess,
    errors
  };
}

async function ensureDictionaryData(vocabulary, options = {}) {
  // 即使完全离线，也先把随 App 打包的本地补充写入 IndexedDB。
  await seedLocalDictionarySupplements(vocabulary);

  const meta = await getDictionaryMeta("sync");
  const coverage = await getDictionaryCoverage(vocabulary);
  const minPercent = Number(options.minPercent || 100);

  // 只有质量版本一致才允许沿用缓存。
  if (
    meta?.qualityVersion === DICTIONARY_QUALITY_VERSION &&
    coverage.percent >= minPercent
  ) {
    return {
      skipped: true,
      coverage,
      meta
    };
  }

  if (navigator.onLine === false) {
    return {
      skipped: true,
      offline: true,
      coverage,
      meta
    };
  }

  return syncDictionaryForVocabulary(vocabulary, options);
}

async function clearDictionaryCache() {
  if (!dictionaryDB) return;

  await Promise.all([
    new Promise((resolve, reject) => {
      const tx = dictionaryDB.transaction(DICT_ENTRY_STORE, "readwrite");
      const req = tx.objectStore(DICT_ENTRY_STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }),
    new Promise((resolve, reject) => {
      const tx = dictionaryDB.transaction(DICT_META_STORE, "readwrite");
      const req = tx.objectStore(DICT_META_STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    })
  ]);
}
