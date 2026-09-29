# CET6 Review v2.1 · 云同步改造审计

## 改造范围

v2.1 已将 v2.0 的 Firebase Authentication + Cloud Firestore 云同步完整替换为：

- Supabase Auth（邮箱 / 密码）
- Supabase Postgres Data API
- Row Level Security (RLS)
- 本地 IndexedDB offline-first

## 保留不变

- 2003 核心词
- 复习调度算法
- 忘词回插
- 今日总览
- 重点易错
- 阅读生词
- 每日复习历史
- 增强词典
- PWA
- JSON 手动备份
- 原 IndexedDB 数据库名和结构

因此从旧版本覆盖升级不会主动清空本机学习进度。

## 云端模型

只使用一张表：

`public.cet6_sync_records`

唯一键：

`(user_id, store_name, record_key)`

其中 `payload` 使用 JSONB 保存本地记录。当前同步三个逻辑存储：

- `wordProgress`
- `dailySessions`
- `readingWords`

## 冲突策略

- 每次操作始终先保存 IndexedDB
- 在线时再尝试上传
- 完整同步时按记录自身的 `updatedAt / lastReviewedAt / ...` 判断新旧
- 较新的记录覆盖较旧记录
- 阅读生词删除使用云端 tombstone，避免另一设备把已删除项目重新上传

这个项目预期是一人多设备、通常一次只在一个设备学习。若两台设备在离线状态下同时修改同一个词，最终采用较新的记录时间作为冲突结果。

## 自动同步触发

- 登录后
- App 启动时
- 每次本地学习数据修改后
- 恢复联网后
- 浏览器窗口重新获得焦点
- App 从后台切回前台
- 约每 45 秒补偿同步
- 设置页“立即同步”

## 安全

- 前端只需要 Project URL + publishable/anon key
- 禁止使用 service_role / secret key
- `supabase-schema.sql` 默认启用 RLS
- 读写策略要求 `auth.uid() = user_id`

## 离线行为

Supabase 不替代 IndexedDB。即使 Supabase SDK、网络或云端暂时不可用，核心学习功能仍使用本地 IndexedDB 正常工作；联网后再补同步。
