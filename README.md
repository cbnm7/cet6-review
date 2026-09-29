# CET6 Review v2.1.2 · 防数据回退同步版

本版针对“重新登录/切换设备后，较新的空记录把已有学习进度覆盖为 0”的风险进行修复。

## 核心修复

- `dailySessions` 不再只比较 `updatedAt`。
  - 优先比较：`primaryCompleted -> cursor -> reinforcementAttempts -> completedAt`。
  - 例如云端 `37 / 200`、本地 `0 / 200`，即使本地时间更新，也不能用 0 覆盖 37。
- `wordProgress` 不再只比较时间。
  - 优先比较累计复习次数、认识/忘记累计次数、加练次数与纠错次数。
  - 低复习次数记录不能覆盖高复习次数记录。
- 首次登录同步完成前，本地变化会先等待一次完整双向合并，再读取合并后的最新本地记录上传。
- 多个登录/聚焦/定时事件同时触发同步时，共享同一个同步 Promise，不重复并发合并。
- 退出账号不会清除 IndexedDB。
- 设置页显示“防数据回退保护”状态以及本次运行拦截次数。
- Service Worker 缓存升级到 v2.1.2，避免继续加载旧同步代码。

## 保持不变

- IndexedDB 仍是离线主数据层。
- 断网可继续复习。
- Supabase 负责跨设备同步。
- 2003 核心词、增强词典不上传云端。
- 云端只同步：`wordProgress`、`dailySessions`、`readingWords`。
- JSON 本地备份/恢复继续保留。

## 升级方式

直接用本目录文件覆盖 GitHub 仓库根目录即可。

不需要重新执行 `supabase-schema.sql`，数据库结构没有变化。

升级不会主动删除 IndexedDB 学习记录，也不会清空 Supabase 数据。
