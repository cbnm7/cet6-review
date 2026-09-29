# CET6 Review v2.1.1

Supabase 同步状态显示修复版。

## 修复

- 修复首次登录后后台同步已完成，但设置页仍一直显示“同步中…”的问题。
- 设置页在已登录状态下会随 `cet6-cloud-status` 自动刷新。
- Service Worker 缓存版本升级，避免浏览器继续使用旧版 `app.js`。

其余 v2.1 功能保持不变。

# CET6 Review v2.1 · Supabase 多设备同步版

这是 CET6 Review 的 Supabase 云同步版本。核心原则仍是 **offline-first**：

- IndexedDB 保存每台设备的本地学习数据
- 无网可以正常复习
- Supabase Auth 提供账号
- Supabase Postgres 保存跨设备同步副本
- RLS 保证每个账号只能访问自己的数据
- 恢复联网后自动补同步

## 当前功能

- 2003 核心词复习
- 忘了 / 认识二档判断
- 忘词本轮回插
- 1 → 3 → 7 → 14 → 21 → 30 天调度
- 遗忘词优先，每日不足 200 时顺序补新词
- 今日复习总览：认识 / 忘了 / 待复习
- 重点易错专项复习
- 阅读生词与短语
- 每日复习词数历史
- 增强中文释义、词性、音标、搭配与语境例句
- “记错了”纠正机制
- PWA 安装与离线缓存
- JSON 本地导出/导入备份
- **Supabase 多设备自动同步**

## 云端同步的数据

只同步个人学习数据：

- `wordProgress`
- `dailySessions`
- `readingWords`

不上传：

- 2003 内置核心词文件
- 增强词典缓存
- App 静态资源

## 配置

先阅读：

`SUPABASE_SETUP.md`

然后在 Supabase SQL Editor 执行：

`supabase-schema.sql`

最后在 App 设置页填写 Project URL 与 Publishable key。

## 安全

前端只使用 Supabase **publishable / anon** key。

绝对不要把 `service_role` 或 secret key 写入本项目。

云端数据访问由 `supabase-schema.sql` 中的 RLS 策略控制。

## 部署

继续使用 GitHub Pages 即可，参考：

`DEPLOY.md`
