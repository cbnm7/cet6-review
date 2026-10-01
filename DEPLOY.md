# 部署 v2.2.1

先在原 App 中导出独立 JSON 备份。将本包 `CET6-Review/` **里面的内容**覆盖原仓库对应位置，保持原网站地址和 `supabase-config.js` 配置，不需要重新执行 Supabase SQL。

运行所需文件为根目录 HTML/CSS/JS、`manifest.json`、`data/` 与 `icons/`，以及 GitHub Pages 使用的 `.nojekyll`。`tests/` 与文档用于核查，不被 App 自动执行。

等待 Pages 部署完成，关闭其它旧 CET6 页面/PWA，在电脑和手机联网打开原网址。设置页底部应显示 **2.2.1 数据保护与渐进加练版**。词典版本继续显示 v2.1.3，词典内容未改。

未即时更新时，关闭重开/普通刷新；新版可点设置中的“检查 App 更新”。不要清除网站数据、IndexedDB 或重置学习记录。所有设备都需要停止使用旧版本。

详见 `V2.2.1_UPGRADE.md`。交付的是完整工程，未代为上传或发布。
