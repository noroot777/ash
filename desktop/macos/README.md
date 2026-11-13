# ash for macOS（实验）

装在「应用程序」里的 ash：一个原生窗口装着 :4317 那份 web，服务没在跑就自己把它起起来。

```bash
npm run install:mac                     # 构建并装进 /Applications，然后打开
npm run build:mac                       # 只构建 → desktop/macos/build/Ash.app
bash desktop/macos/build.sh --dmg       # 另出一份拖拽安装的 build/Ash.dmg
```

只依赖 Xcode 命令行工具里的 `swiftc`，没有 Xcode 工程、没有 npm 依赖。最低 macOS 14，ad-hoc 签名，只供本机用。

## 服务怎么起

- 打开 app 时 `/api/health` 不通，就在**主仓**（构建时写进 Info.plist 的 `AshRepoPath`）里跑 `scripts/start-detached.mjs` 起 `server/dist/index.js` —— 与 `npm run restart` 最后一步同一条路。环境取自交互式登录 shell（`zsh -ilc`），PATH、LANG 与在终端里起的一致。
- server 进自己的会话，**退出 app 不会停服务**，也不会带走在跑的 agent。
- 只起不管：不 build、不杀旧进程、不守护。改了代码照旧 `npm run restart`；它正在换服务时 app 不插手，等它起好。
- 「ash → 登录时启动 ash 服务」（装好后第一次打开默认勾上）：一份 `~/Library/LaunchAgents/dev.ash.server.plist`，登录时跑一次 `Ash --start-server`，同一套逻辑、不开窗口。日志 `/tmp/ash-mac-login.log`。
- 服务日志在 `/tmp/ash-4317.log`，起不来时占位页上有「日志」按钮。

连别的 ash：`defaults write dev.ash.mac AshURL http://192.168.1.187:4317`，或启动时带 `ASH_URL`；非本机地址不会替它起服务。换仓库：`defaults write dev.ash.mac AshRepoPath <仓库根>`。

## 文件

| 文件 | 管什么 |
|---|---|
| `Sources/AshConfig.swift` | 连哪台、用哪份仓库、什么算同源 |
| `Sources/ServerLauncher.swift` | 服务不在时把它起起来 |
| `Sources/LoginService.swift` | 登录时启动的 LaunchAgent |
| `Sources/AppDelegate.swift` | 生命周期与菜单（⌘C/⌘V 靠编辑菜单分发，不能省） |
| `Sources/BrowserWindowController.swift` | 窗口、WKWebView、离线探活、菜单动作 |
| `Sources/WebViewBridge.swift` | 外链、新窗口、选文件、下载、JS 对话框 |
| `Sources/OfflineView.swift` | 服务不在时的那一屏 |
| `scripts/make-icon.swift` | 构建时现画图标 |

卸载：菜单里先取消「登录时启动 ash 服务」，再删 /Applications/Ash.app。页面检查器：Safari →「开发」→ 本机 → ash。
