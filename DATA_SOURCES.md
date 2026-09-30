# v2.1.3 数据来源与核查方式

## 本次真正使用的数据

1. **用户上传的主词表** `data/cet6_2003.json`：2003 条记录，1992 个唯一词头。原文件不改。
2. **本次逐词编辑的释义**：`data/concise-dictionary.json`；语义取舍和中文简明表述由模型逐条编辑。不是取得了一套官方“六级/考研所有应考义项”的授权词库。
3. **本地辅助词性词表**：TextBlob 包内 `en/en-lexicon.txt`（Brill tagger / Brown、Penn Treebank 常见标签及扩充数据）。用于发现值得复查的 POS 提示，不充当完整多词性词典，不将其整库打包。
4. **定点查询的词典原站**：仅下表所列词头完成此轮外部查询。中文释义为重新概括，没有复制长段词典定义或例句。

| 核查目标 | 原站 |
|---|---|
| principal | https://www.merriam-webster.com/dictionary/principal |
| underly / underlying 对照 underlie | https://www.merriam-webster.com/dictionary/underlie |
| content | https://www.merriam-webster.com/dictionary/content |
| provided | https://www.merriam-webster.com/dictionary/provided |
| given | https://www.merriam-webster.com/dictionary/given |
| rival | https://www.merriam-webster.com/dictionary/rival |
| retail | https://www.merriam-webster.com/dictionary/retail |
| retail 对照不同词典的修饰语分类 | https://www.oxfordlearnersdictionaries.com/definition/english/retail_1 |

查询/整理日期：2026-09-30。

## 与旧版区别

旧版从 KyleBing/english-vocabulary 的九套 TSV 拉取数据，随后合并相同词头的词性、释义、搭配与例句。本版运行时不再请求或合并这些远端词典。

ECDICT、WordNet 的项目说明曾用于前期评估，但本轮没有取得并逐词查询它们的完整数据，因此它们不列为这份释义逐词核查的证据。

## 保留与限制

- 旧词典缓存中已有的音标可延续显示，本轮没有重新审校每个音标。不会把旧中文释义重新混入。
- 已有阅读生词中的中文义、原句和备注是用户内容，未被模型批量覆盖。
- 缺少可靠来源的词头会提示待核对，不因为“覆盖率”指标而硬配释义。
- 词性可随上下文变化；本版兼列的是有用常见词性，不是所有历史或专门领域用法的清单。
