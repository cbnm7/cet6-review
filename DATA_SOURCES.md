# v2.2.2 数据来源与核查方式

## 核心词表

- `data/cet6_2003.json`：2003 条核心记录、1992 个唯一词头/短语。
- 本版保持全部稳定 ID 与 `source_order` 不变。
- 用户确认的两处词头修正：
  - `cet6_0310` → `attribute`
  - `cet6_0367` → `mirror`

## 中文精简释义

中文释义继续使用 v2.1.3 / v2.2.1 已整理的本地精简词典。本版只针对 `attribute`、`mirror` 补齐与修正对应精简释义，不重新批量改写其它中文释义。

## 音标来源

本版为 1992 个唯一词头/短语统一加入北美英语 IPA。

- 发音基础：**CMU Pronouncing Dictionary (CMUdict)**。
- CMUdict 是 Carnegie Mellon University Speech Group 维护的英语发音词典，面向 North American / US English，并使用 ARPAbet 表示发音。
- 本项目将主发音的 ARPAbet 转换为广义 IPA。
- 多词短语按组成词逐项转换后组合。
- 当前 1992 / 1992 唯一词头/短语均有 `us` 字段。
- 唯一未直接由 CMUdict 单词查表覆盖的 `4th` 使用人工标准化 `/fɔrθ/`。

官方来源：

- https://github.com/cmusphinx/cmudict
- https://github.com/words/cmu-pronouncing-dictionary

## 限制

- “统一 IPA”指本项目采用同一北美英语口径的学习用广义音标，不表示穷举所有英式、美式地域变体、词性变读或弱读。
- CMUdict 自身说明其中仍可能存在错误、遗漏和不一致，因此特殊词若后续发现问题，应做定点人工校正，而不是改动学习记录 ID。
- 本版不把美式音标复制到 `uk` 字段；没有可靠英式来源时宁可留空，避免把同一发音伪装成英式音标。
- 阅读生词中的用户中文义、原句和备注没有被批量覆盖。
