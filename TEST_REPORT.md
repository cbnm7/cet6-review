# v2.2.1 实际测试报告

## 本次执行

**Node.js v22.16.0：40 项自动化测试全部通过，0 失败。**

| 范围 | 数量 | 覆盖点 |
| --- | ---: | --- |
| 备份与迁移 | 10 | v2.2.0 schema1 恢复、v2.2.1 往返、重复导入、旧备份、混合备份、缺迁移标记、导入前快照、损坏文件拒绝、事务失败回滚、等待在途同步 |
| 云同步合并 | 8 | 10 月 1 日及以后旧会话拒绝、历史保留、新版保留、真正新版优先、远端独有/本地独有/双方皆旧、上传路径保护 |
| 调度与加练 | 9 | 160 认识+40 遗忘、237 到期溢出、恰好 200、轮次切换、10/25/50/队尾、旧队列兼容、短队列、跨天阶梯、加练不推进跨天阶段 |
| Service Worker | 12 | 网络优先、最新缓存优先、404/500、超时、固定数据缓存优先、导航回退、缓存写失败、安装资产、安装失败、激活清理、API 不缓存、其它文件不污染首页 |
| PWA 版本比较 | 1 | 不把较低版本 Worker 误报为新版本 |

原始输出：`tests/REGRESSION_RESULTS.tap`。

**Chromium 页面检查：13 项通过，未观察到未处理脚本异常。**

实际注入本工程页面、CSS 和运行脚本，验证首页与词典初始化、设置页版本与新按钮、忘记后插回、认识→记错了、加练纠错递增、重新读取会话、备份版本元信息、保存期间不强制刷新，以及 360 / 390 / 480 像素视口无横向溢出。

结果：`tests/UI_v2.2.1_RESULTS.json`；截图：`tests/UI_v2.2.1_settings.png`。

全部生产 JavaScript 通过 `node --check`。核心资源清单 19 项文件均存在，HTML 引用与预缓存版本一致。原始词表、词典、配置和图标的字节一致性校验记录在 `CHECK_RESULTS.json`。

## 环境与限制：不能把模拟测试说成真实设备验收

本环境 Chromium 对 `http://127.0.0.1:8765/` 的导航返回 `ERR_BLOCKED_BY_ADMINISTRATOR`。因此页面测试采用 `about:blank` 注入实际页面代码，而不是正常网站导航。

- IndexedDB：使用 `tests/support/memory-idb.cjs` 的有限异步内存替身；模拟提交、回滚和错误注入，**不是浏览器磁盘 IndexedDB 的完整实现或兼容性认证**。
- Service Worker：在 Node VM 中执行本工程 Worker，使用 Request/Response 与内存 CacheStorage/fetch 替身；**没有验证真实注册、生命周期、GitHub CDN、Chrome 手机缓存或断网行为**。
- 页面：真实 Chromium DOM/CSS/按钮执行；词库 fetch、本地存储与 IndexedDB 使用测试替身，Supabase 未配置。截图中的未配置状态仅属于测试环境，不代表交付工程配置被删除。
- 云同步：执行实际过滤、合并、上传选择函数，远端 API 用测试桩；**没有登录用户账号，没有读写真实云端，也没有完成多设备并发端到端验收**。
- 测试词记录为构造数据，不是用户真实学习记录。本次不宣称已证明用户第一天每个词的真实状态都已恢复。

测试替身不出现在 `index.html` 或 Worker 预缓存清单中，不会被生产 App 加载。

## 复跑

在工程目录：

```sh
node --test tests/*.test.cjs
```

不需要 npm 安装。页面检查另需 Python Playwright 和 Chromium：

```sh
python tests/ui_smoke.py
```

可用 `CHROMIUM_PATH` 指定浏览器可执行文件。普通使用 App 无需这些开发工具。

## 实现参考

核心网络优先/离线回退按 Chrome 官方缓存策略文档设计；更新提示参考官方 Service Worker 生命周期和更新处理说明；导入以事务完成/中止作为成功/失败边界。

- Chrome for Developers — Strategies for service worker caching：`https://developer.chrome.com/docs/workbox/caching-strategies-overview`
- web.dev — The service worker lifecycle：`https://web.dev/articles/service-worker-lifecycle`
- Chrome for Developers — Handling service worker updates with immediacy：`https://developer.chrome.com/docs/workbox/handling-service-worker-updates`
- MDN — IDBTransaction / abort：`https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction`；`https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/abort`

以上文档用于实现依据，不等于本项目已完成其覆盖的所有浏览器验证。
