# CET6 Review v2.1.2 · 防回退同步审计

## 问题

v2.1.1 对同一个 `dailySessions` / `wordProgress` 冲突主要依赖更新时间判断。
因此可能出现：

- 云端已有有效学习进度；
- 新设备或重新登录后本地先产生一条进度为 0 的新记录；
- 这条空记录时间更新；
- “新时间戳”被误判为“更正确的数据”。

## v2.1.2 处理

### dailySessions

采用学习进度优先的比较：

1. `primaryCompleted`
2. `cursor`
3. `reinforcementAttempts`
4. `completedAt`
5. 只有学习进度完全相同时才使用时间戳决胜

队列、游标、认识/忘记计数、评分映射均从同一条更高进度记录取得，避免不同会话硬拼接。

### wordProgress

采用累计学习量优先：

1. `reviewCount`
2. `knowCount + forgotCount`
3. `reinforcementCount`
4. `correctionCount + reinforcementCorrectionCount`
5. 学习量相同才比较时间戳

累计计数使用不下降合并，核心状态（`lastRating`、`streak`、`nextReviewDate`）由更高学习进度记录决定。

### 首次登录

首次云端合并完成前，本地写操作不会直接把旧/空状态推到云端，而是先完成一次双向合并，再读取最新本地记录上传。

### 并发同步

登录、恢复网络、切回页面、定时同步可能同时触发。v2.1.2 使用共享 `syncPromise`，避免并发同步互相覆盖。

## 自动测试

已验证以下冲突：

- 新时间戳 `0 / 200` 不得覆盖旧时间戳 `2 / 200`。
- 新时间戳低 `reviewCount` 不得覆盖旧时间戳高 `reviewCount`。
- 高进度本地记录即使时间较旧，也不会被低进度云端记录清零。

所有 JavaScript 已通过 `node --check` 语法检查。
