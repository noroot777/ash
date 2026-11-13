# ash for macOS（实验）

一个原生窗口装着 :4317 那份 web。服务端照旧由 `npm run restart` 管，这个 app 不拉起、不重启任何进程；连不上时显示占位页，每 2 秒探一次 `/api/health`，通了自动载入。

```bash
npm run build:mac                       # → desktop/macos/build/Ash.app
bash desktop/macos/build.sh --install   # 另装到 ~/Applications/Ash.app 并打开
```

只依赖 Xcode 命令行工具里的 `swiftc`，没有 Xcode 工程、没有 npm 依赖。最低 macOS 14，ad-hoc 签名，只供本机用。

连别的 ash：`defaults write dev.ash.mac AshURL http://192.168.1.187:4317`，或启动时带 `ASH_URL`。

| 文件 | 管什么 |
|---|---|
| `Sources/AshConfig.swift` | 连哪台、什么算同源 |
| `Sources/AppDelegate.swift` | 生命周期与菜单（⌘C/⌘V 靠编辑菜单分发，不能省） |
| `Sources/BrowserWindowController.swift` | 窗口、WKWebView、离线探活、菜单动作 |
| `Sources/WebViewBridge.swift` | 外链、新窗口、选文件、下载、JS 对话框 |
| `Sources/OfflineView.swift` | 连不上时的那一屏 |
| `scripts/make-icon.swift` | 构建时现画图标 |

页面检查器：Safari →「开发」→ 本机 → ash。
