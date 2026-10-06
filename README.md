# 阅读生词 v3.1.0

极简用途仍然只有一个：**保存阅读中遇到的生词 / 短语**。本版只重新加入账号登录与多设备双向同步，不恢复任何复习、词库或调度功能。

## 当前功能

- 保存单词 / 短语，可填写中文义、来源、原句、备注
- 同一词条再次保存时更新内容并累计遇见次数
- 删除词条
- IndexedDB 本地持久化，离线仍可保存
- Supabase 邮箱账号注册 / 登录 / 退出
- 多设备双向合并：不同设备各自新增的词条会取并集
- 同一词条两端都有数据时，保留较新的内容，同时尽量保留另一端非空字段
- 删除同步：删除会写入本地和云端“删除墓碑”；其他设备登录或再次同步时会删除本地旧副本
- 自动同步：登录、联网恢复、回到页面、本地修改、定时同步；也可手动“立即同步”

## 数据保护

仍使用原数据库：`cet6-review-db`。数据库由 v4 升到 v5 时 **只新增** `readingWordTombstones` 对象仓库，不删除 `readingWords`，已有阅读生词不会被清空。

对象仓库：
- `readingWords`：当前词条
- `readingWordTombstones`：删除标记，仅记录 normalizedTerm 和删除时间

删除墓碑是实现跨设备删除所必需的：云端正文会被替换成最小删除记录，而不是保留被删除词条的释义、原句等内容。

## Supabase

本项目继续使用原 CET6 Review 的 Supabase 项目配置（`supabase-config.js`）与 `cet6_sync_records` 表。如果原项目已经执行过旧版 `supabase-schema.sql`，无需再次执行。

如果换成新的 Supabase 项目，请修改 `supabase-config.js` 中的 Project URL 和 publishable / anon key，并在新项目 SQL Editor 执行 `supabase-schema.sql`。前端禁止使用 service_role / secret key。

## 部署

直接覆盖原 GitHub Pages 仓库文件即可。不要清除浏览器“网站数据 / IndexedDB”，否则本机阅读生词会被删除。Service Worker 更新只清旧静态缓存，不清 IndexedDB。
