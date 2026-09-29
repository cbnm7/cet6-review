# CET6 Review v2.1.2 · Supabase 配置

这版不需要 Google / Firebase。云同步使用 **Supabase Auth + Postgres + Row Level Security (RLS)**，本地 IndexedDB 仍然是离线主数据层。

## 1. 创建 Supabase 项目

打开 Supabase Dashboard，注册/登录后创建一个新项目。项目名可用：

`cet6-review`

记住数据库密码即可；这个密码**不会**填写到网页 App 中。

## 2. 创建同步表和安全策略

进入：

`SQL Editor -> New query`

打开工程根目录的：

`supabase-schema.sql`

整段复制进去并运行。

它会创建唯一一张学习同步表：

`public.cet6_sync_records`

同时开启 RLS。每一条记录都带 `user_id`，策略要求：

`auth.uid() = user_id`

因此登录用户只能读取和修改自己的学习数据。

## 3. 确认邮箱登录可用

进入：

`Authentication -> Providers -> Email`

确保 Email provider 已开启。

Supabase 项目通常默认要求邮件确认。如果保持邮件确认：

1. App 中点击“注册”
2. 去邮箱点击验证链接
3. 回到 App 登录

如果只是自己本地测试，也可以临时关闭“Confirm email”；正式长期使用建议保留邮箱验证。

## 4. 设置站点 URL（建议）

如果启用邮箱确认，进入：

`Authentication -> URL Configuration`

部署 GitHub Pages 后，将 `Site URL` 设置成你的正式地址，例如：

`https://你的用户名.github.io/CET6-Review/`

本地 Live Server 测试时，可把类似下面的地址加入允许的 Redirect URLs：

`http://127.0.0.1:5500/**`

具体端口以你的 Live Server 为准。

## 5. 获取前端配置

在 Supabase Dashboard 项目设置 / API 页面找到：

- **Project URL**
- **Publishable key**（新项目优先使用）
- 如果界面仍显示旧式 **anon public key**，也可以使用

绝对不要把以下密钥放进网页：

- `service_role`
- secret key

因为网页源代码任何访问者都能看到前端 key；安全依赖 RLS，而不是隐藏 publishable key。


### 可选：把配置写进部署文件

如果你不想在每台设备上重复填写 Project URL 和 publishable key，可以编辑：

`supabase-config.js`

把 `null` 改成你的项目配置后再上传 GitHub Pages。这样每台设备只需要登录账号。publishable/anon key 本来就是前端客户端使用的 key，安全边界仍由 RLS 控制；**service_role / secret key 仍然绝对不能写进去**。

## 6. 在 CET6 Review 中填写

打开 App：

`右上角设置 -> 多设备云同步`

填写：

- Project URL
- Publishable key / anon key

保存后页面会刷新，然后使用邮箱和密码注册或登录。

## 7. 同步行为

登录后：

- 每次“认识 / 忘了”先写入当前设备 IndexedDB
- 有网时立即尝试上传
- 今日会话、每日记录、阅读生词同样同步
- 断网时继续正常学习
- 恢复联网后自动补同步
- 页面重新获得焦点 / 从后台切回前台时自动同步
- 打开状态下约每 45 秒做一次补偿同步
- 设置页可以手动“立即同步”

另一台设备使用**同一个 Supabase 邮箱账号**登录，即可获得相同学习数据。

## 8. 从 v2.0 Firebase 版升级

v2.1 不会删除原来的 IndexedDB 学习数据。

如果你是在保存着学习进度的同一浏览器中覆盖升级：

1. 本地学习记录仍在
2. 配置 Supabase
3. 登录
4. 首次同步会将本机数据上传到 Supabase

Firebase 云端已有但本机已经丢失的数据，不会自动从 Firebase 迁移到 Supabase。
