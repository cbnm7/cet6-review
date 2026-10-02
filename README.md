# CET6 Review v2.2.2 — 音标与词头修正版

本版在 **v2.2.1 数据保护与渐进加练版**上做最小增量修改：补齐内置词典的北美英语 IPA，并修正两个已确认错误词头。学习调度、IndexedDB 学习数据结构、Supabase 同步逻辑均保持 v2.2.1 不变。

## 本版修改

| 部分 | 修改结果 |
| --- | --- |
| 全量音标 | 1992 个唯一词头/短语全部加入北美英语广义 IPA；2003 条核心记录通过词头映射均可显示音标。 |
| 词头修正 | 稳定 ID `cet6_0310`：`a tribute`/原错误 `atribute` → `attribute`；稳定 ID `cet6_0367`：`mir` → `mirror`。 |
| 数据保护 | 两个修正词头继续使用原稳定 ID；`db.js`、`scheduler.js`、`cloud-sync.js`、数据库名称与版本均未修改。 |
| 缓存更新 | App / Service Worker / 静态资源版本升级到 2.2.2，使新词表和新词典能够替换旧缓存。 |

## 数据安全结论

**在原 GitHub Pages 站点原地覆盖更新，不会主动覆盖、清空或重置已经统一好的学习进度。**

学习进度仍保存在 IndexedDB 数据库 `cet6-review-db`（`DB_VERSION = 4`）；本版没有修改该数据库的 schema，也没有新增学习数据迁移。Service Worker 更新只管理 CacheStorage，不删除 IndexedDB。

`attribute` 和 `mirror` 只修正词头文本，分别继续使用 `cet6_0310`、`cet6_0367`，所以已有“认识/忘记/轮次/到期时间”等状态仍绑定原 ID，不会因为拼写修正而变成新词。

内置词典使用独立数据库 `cet6-dictionary-db`。词典缓存可因版本升级而重建，但不会影响 `cet6-review-db` 的学习数据。

### 更新前仍建议做一份独立备份

1. 在当前正常 App 的设置页导出 JSON 备份并保存到浏览器之外。
2. 将本项目 `CET6-Review/` 目录内文件覆盖原仓库对应位置，保持原网站地址和 Supabase 配置。
3. 等 GitHub Pages 部署完成，关闭旧标签页/PWA，再打开原网址。
4. 设置页底部确认显示 **`2.2.2 音标与词头修正版`**。
5. **不要清除网站数据、IndexedDB 或点击重置学习进度。**正常代码更新不需要重新导入备份。

若换到不同域名/不同浏览器配置文件，原 IndexedDB 不会自动跟过去，看起来会像“没有进度”；这不是本版删除数据。应继续使用原站点，或通过备份/云同步迁移。

详细说明见 [V2.2.2_UPGRADE.md](V2.2.2_UPGRADE.md)。

## 音标说明

- 音标口径：**North American English，IPA 广义转写**。
- 发音基础数据：CMU Pronouncing Dictionary（CMUdict）。
- 词典原始发音为 ARPAbet，本项目转换为 IPA 显示。
- 有多个发音的词，本版默认使用 CMUdict 主发音；因此它是一套统一的学习用美式音标，而不是穷举每个地域/词性/语境的全部变体。
- CMUdict 官方也说明其词典可能仍存在错误、遗漏和不一致；本项目因此保留 `phoneticSource` 元数据，便于后续定点修正。

示例：

- `attribute` → `/ˈætrəbˌjut/`
- `mirror` → `/ˈmɪrɚ/`
- `individual` → `/ˌɪndəˈvɪdʒəwəl/`
- `reasonable` → `/ˈrizənəbəl/`

## 原有学习规则保持不变

- 普通轮次点“认识”后，本轮结束前不再作为普通轮次词回流；整本完成一轮后进入下一轮。
- 忘记词当天按 **10 → 25 → 50 个队列项 → 队尾**逐步插回加练。
- 忘记词跨天仍按 **1 → 3 → 7 → 14 → 30 天**逐级复习；跨天再次忘记回到 +1 天。
- 当天到期遗忘词优先，剩余名额由当前轮单词补足 200；到期遗忘词超过 200 时全部安排。

## 文件与验证

- `data/cet6_2003.json`：2003 条核心记录；ID 与顺序保持不变，仅修正两个词头。
- `data/concise-dictionary.json` / `.js`：1992 个唯一词头/短语，1992/1992 已有 `us` IPA。
- `dictionary.js`：优先使用本版内置音标，并继续兼容已有词典缓存。
- `db.js` / `scheduler.js` / `cloud-sync.js`：与上传的 v2.2.1 版本保持字节一致。
- `tests/`：44 项 Node 回归测试 + 13 项 Chromium 页面检查。
- [TEST_REPORT.md](TEST_REPORT.md)：实际测试范围和限制。
- [DATA_SOURCES.md](DATA_SOURCES.md)：词典与音标来源。

开发者可在项目目录运行：

```bash
node --test tests/*.test.cjs
```

当前交付回归结果：**44 / 44 通过**。
