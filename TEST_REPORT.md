# v3.2.0 编辑同步版 · 测试报告

测试日期：2026-10-06。修改基线：用户上传的 `Reading-Words-v3.1.0-Sync(1).zip`。

## 结果

| 检查 | 结果 |
|---|---:|
| Node 自动化回归（数据模型、本地事务、双设备同步、Service Worker） | 71 / 71 通过 |
| Chromium 页面交互检查（实际页面脚本 + 显式测试替身） | 20 / 20 通过 |
| 原云配置、原 SQL 和四张图标字节一致性 | 6 / 6 一致 |
| 数据库版本、非破坏性静态检查、脚本依赖与 Manifest | 全部通过 |
| 根目录生产 JavaScript 语法检查 | 全部通过 |

原始记录：`tests/node-results.tap`、`tests/browser-results.json`、`tests/static-checks.json`。截图：`tests/UI-v3.2.0-mobile.png` 和 `tests/UI-v3.2.0-desktop.png`。

## 已覆盖场景

编辑五个字段、清空选填项、保留本机 ID/创建日期/遇见次数、修改拼写、撞词阻止覆盖、取消编辑与草稿保护、事务失败时改名与墓碑一起回滚、编辑已删除词条不复活。

跨设备测试覆盖不同词并集、双向编辑、清空同步、不同字段并发修改、同字段确定性裁决、并发初次插入冲突、条件更新冲突重试、上传期间继续编辑/新增/删除、失败后重试、删除优先于旧副本编辑、主动重新添加、空设备登录、重复同步幂等、1105 条云端生词分页下载、退出登录时停止当前账号后续处理。

页面测试覆盖实际按钮与表单操作、已知编辑冲突提示、HTML 转义，以及 360/390/560/1100 像素页面宽度不横向溢出。

Service Worker 单元测试覆盖新资源预缓存、仅删除旧 App 静态缓存、网络优先、断网与临时 5xx 时回退缓存、不处理 Supabase 外域或非 GET 请求，以及缓存写入失败不影响在线响应。

## 不能据此声称已完成的验证

**IndexedDB、localStorage、Supabase、网络及 Service Worker 在测试中使用了显式替身。** Node 事务替身模拟异步请求、串行事务、提交和回滚，但不是 IndexedDB 规范一致性测试。Chromium 使用 about:blank 加载实际 HTML/CSS/JS 进行界面操作，未在真实网站来源下执行数据库与 PWA 端到端测试。

环境中的浏览器导航策略阻止了本地 HTTP 测试页面；未修改或绕过该策略。因而没有把本地 HTTP 浏览器/真实 IndexedDB/PWA 的端到端用例计作通过。

没有登录或写入用户真实 Supabase 项目，也未验证用户实际账号的网络、RLS 权限、手机浏览器或 GitHub Pages 部署。首次更新后，应通过一个测试词完成“电脑编辑 → 手机同步 → 手机清空备注 → 电脑同步”的实际验收。

旧版 v3.1.0 不能安全参与新版字段编辑与明确清空；所有活跃设备需要一起升级。同步是最终一致，不是跨设备瞬时原子操作。冲突边界与改名场景说明见 README。

## 实现参考

Supabase 官方文档：
- 条件更新和返回已修改行：https://supabase.com/docs/reference/javascript/update
- 查询与分页限制：https://supabase.com/docs/reference/javascript/select
- 过滤器：https://supabase.com/docs/reference/javascript/using-filters
- Auth 状态回调：https://supabase.com/docs/reference/javascript/auth-onauthstatechange

MDN IndexedDB 事务说明：https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB

以上用于核对 API 用法，不能替代真实设备与真实 Supabase 的验收。
