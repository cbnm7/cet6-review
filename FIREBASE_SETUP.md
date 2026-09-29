# CET6 Review v2.0 · Firebase 多设备同步配置

> 只需要浏览器操作，不需要 Node.js、Firebase CLI 或服务器。

## 1. 创建 Firebase 项目

1. 打开 Firebase Console：`https://console.firebase.google.com/`
2. 创建项目，例如 `cet6-review`。
3. Google Analytics 对本 App 不是必需，可以关闭。

## 2. 注册 Web App

1. 项目首页点击 Web 图标 `</>`。
2. App nickname 可填 `CET6 Review`。
3. 注册后 Firebase 会给出 `firebaseConfig`，其中至少包含：
   - `apiKey`
   - `authDomain`
   - `projectId`
   - `appId`
   - 通常还会有 `messagingSenderId`、`storageBucket`
4. 不需要 npm。v2.0 直接使用 Firebase 官方 Browser Modules。

## 3. 开启邮箱密码登录

Firebase Console → **Authentication** → **Sign-in method** → **Email/Password** → Enable。

App 内会提供“注册 / 登录”，同一个邮箱账号用于手机、电脑和不同浏览器。

## 4. 创建 Cloud Firestore

Firebase Console → **Firestore Database** → Create database。

区域选离你常用地点较近的区域即可。创建完成后进入 Rules。

## 5. 部署安全规则

把工程根目录 `firestore.rules` 的内容完整复制到 Firestore → Rules，然后点击 Publish。

规则的核心是：

```text
users/{uid}/...
```

只有 `request.auth.uid == uid` 的登录用户能读取和修改自己的学习数据。

**不要使用允许所有人读写的测试规则长期运行。**

## 6. GitHub Pages 授权域名

Firebase Console → Authentication → Settings → Authorized domains。

把 GitHub Pages 的域名加入，例如：

```text
你的用户名.github.io
```

本地调试通常使用 `localhost` / `127.0.0.1`。如果控制台提示域名未授权，也把实际访问域名加入 Authorized domains。

## 7. 在 CET6 Review 中填写配置

打开 App → 右上角设置 → **多设备云同步 / Firebase**。

把第 2 步获得的字段分别粘贴进去并保存。页面会重新加载。

然后：

1. 输入邮箱和至少 6 位密码。
2. 第一次使用点“注册”。
3. 其他设备使用同一邮箱密码点“登录”。
4. 首次登录自动执行一次双向合并。

## 8. 云端保存什么

Cloud Firestore 只保存个人学习数据：

```text
users/{uid}/wordProgress/{wordId}
users/{uid}/dailySessions/{yyyy-mm-dd}
users/{uid}/readingWords/{termKey}
```

不会上传：

- 2003 核心词静态词库
- 增强词典缓存
- PWA 程序文件

这些内容继续保存在 GitHub Pages / 当前设备。

## 9. 离线行为

v2.0 仍然使用原来的 IndexedDB 作为本地学习数据库。

断网时：

- 可以继续背词；
- “认识 / 忘了”立即写入本机 IndexedDB；
- 今日队列和阅读生词仍然可用；
- Firebase SDK 使用持久本地缓存保存待同步写入。

恢复网络后：

- Firestore 自动发送待处理写入；
- App 还会执行一次双向同步；
- 其他已登录设备通过 Firestore 实时监听接收更新。

## 10. 冲突规则

v2.0 以记录的 `updatedAt / lastReviewedAt` 作为合并依据，较新的记录优先。

正常的“手机用完再换电脑”不会有问题。**不建议同时在两台设备上并行进行同一天的复习**，因为两边会同时修改同一个 `dailySessions/YYYY-MM-DD` 文档，后写入的一方可能成为最终版本。

## 11. 本地 JSON 备份仍保留

即使启用了 Firebase，设置页里的“导出备份 / 导入备份”仍然保留，建议偶尔导出一份 JSON 作为独立灾备。
