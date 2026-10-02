# v2.2.2 实际测试报告

测试日期：2026-10-02

## 自动化回归

在项目目录执行：

```bash
node --test tests/*.test.cjs
```

结果：**44 / 44 通过，0 失败**。

覆盖范围包括：

- 分轮调度、200 词配额、到期复习词超过 200 的情况。
- 跨天 `1 → 3 → 7 → 14 → 30` 调度与当天递增加练。
- v2.2.0 / v2.2.1 备份、迁移、导入前快照、事务回滚。
- 旧调度器 2026-10-01 及以后会话过滤。
- Service Worker 网络优先/缓存回退、版本更新检查。
- **2003 条核心词条稳定 ID/顺序不变。**
- `attribute`、`mirror` 在原稳定 ID 上完成词头修正。
- **1992 / 1992 唯一词头/短语具有北美英语 IPA。**
- 学习数据库 `cet6-review-db` 的数据库名、版本和 `wordProgress` 主键保持不变。

完整输出：`tests/REGRESSION_RESULTS.tap`。

## JavaScript 语法检查

对生产运行 JS 执行 `node --check`：

- `app.js`
- `backup.js`
- `cloud-sync.js`
- `db.js`
- `dictionary.js`
- `firebase-config.js`
- `pwa.js`
- `scheduler.js`
- `service-worker.js`
- `supabase-config.js`

结果：全部通过。

## Chromium 页面检查

`tests/ui_smoke.py` 实际执行 **13 项**页面级检查，全部通过，包括：

- 2003 条词表、1992 个词典词头和 IPA 数据加载。
- 设置页显示 v2.2.2。
- 当天 10 → 25 项加练与刷新后的层级续接。
- 备份导出包含调度/迁移版本。
- 新版本提示不会在保存过程中强制刷新。
- 360 / 390 / 480 px 宽度无设置页横向溢出。
- 无未处理脚本异常或保存失败提示。

结果：`tests/UI_v2.2.2_RESULTS.json`；截图：`tests/UI_v2.2.2_settings.png`。

## 数据保护定向核对

与用户上传的 v2.2.1 工程逐文件比较：

- `db.js`：字节一致。
- `scheduler.js`：字节一致。
- `cloud-sync.js`：字节一致。
- `supabase-schema.sql`：字节一致。
- `supabase-config.js`：字节一致。
- `firebase-config.js`、`firestore.rules`：字节一致。
- `backup.js` 仅更新交付版本号/注释，不改变导入导出逻辑。

词表还额外比较了 2003 条记录的 ID 序列与 `source_order` 序列，均与上传版完全一致。

## 未覆盖的部分

测试环境没有连接用户真实 Supabase 账号，也没有在用户真实手机浏览器数据库上执行破坏性升级测试。因此仍建议发布前导出一份独立 JSON 备份。正常原地更新本身不需要导入备份或清除数据。
