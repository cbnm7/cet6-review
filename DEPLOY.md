# CET6 Review v2.1.2 · GitHub Pages 部署

## 1. 上传工程

将本目录中的文件上传到 GitHub 仓库根目录。建议仓库名：

`CET6-Review`

不要只上传外层文件夹；仓库根目录应直接看到：

- `index.html`
- `app.js`
- `db.js`
- `cloud-sync.js`
- `supabase-config.js`
- `service-worker.js`
- `manifest.json`
- `data/`
- `icons/`

## 2. 开启 Pages

GitHub 仓库：

`Settings -> Pages`

选择从 `main` 分支根目录部署。

最终地址通常类似：

`https://你的用户名.github.io/CET6-Review/`

## 3. 配置 Supabase

先按 `SUPABASE_SETUP.md`：

1. 创建 Supabase 项目
2. 执行 `supabase-schema.sql`
3. 开启 Email Auth
4. 将 GitHub Pages 地址设置为 Auth Site URL（启用邮件确认时尤其重要）
5. 在 App 设置页填写 Project URL + Publishable key

## 4. 小米手机安装

使用 Chrome / Edge 打开 GitHub Pages 地址。

可通过：

- 浏览器菜单 -> 安装应用
- 或 添加到主屏幕

安装后核心复习可离线使用；云同步需要网络。

## 5. 更新版本

以后只需覆盖 GitHub 仓库文件。Service Worker 会更新静态缓存，不会主动删除 IndexedDB 学习记录。
