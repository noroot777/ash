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

客户端、登录项和 `npm run restart` 在 macOS 上共用按仓库真实路径和端口区分的启动锁；其他仓库的重启不会阻止当前实例。重启退出或失败后，客户端会重新检查并尝试启动；等待超时会显示可重试的错误，无窗口入口返回失败。启动 shell 的报错会保留在独立启动器日志中。

导出下载先写目标目录内的独立临时文件，完成后再原子替换目标文件。下载失败或在完成前退出不会删除已有文件。每笔下载在 `~/Library/Application Support/dev.ash.mac/downloads` 留一张带锁的登记；app 被强杀或断电留下的隐藏暂存目录（目标文件夹里的 `.ash-download-…`）下次启动时照登记回收，仍在写的下载持着锁、不会被碰。

定点回归入口为 `node scripts/test-macos-client.mjs`（仅 macOS）：覆盖下载提交/失败/中途退出与暂存回收、就绪判据、红绿灯下面的页面仍收得到点击与窗口拖拽（探针窗口在屏幕外，不抢焦点）、Swift/Node 锁身份、双向启动时序、超时重试、请求合并和启动错误诊断，使用临时仓库及独立端口，不停真实服务。

## 窗口

内容铺到窗口顶，红绿灯浮在页面左上角，不单占一行标题栏。页面要给它让位，所以是页面先表态：`web/index.html` 里有 `<meta name="ash-window-chrome" content="overlay">` 才铺上去，没有这一行的文档（旧版本的 ash、同源的其它页面）仍是普通标题栏。壳把红绿灯的实际高宽量出来交给页面（`--window-titlebar-height` / `--window-controls-width`，全屏时为 0），页面这一半在 `web/src/styles/window-shell.css`：主工作区和设置页把那一条用起来，其它整页布局默认让开。顶上那一条的空白处、以及页面用 `--window-drag: drag` 划进来的顶栏都能拖窗口，双击跟随系统设置。

两头有先后：先让服务端用上新的 `web/dist`，再装新 app —— 反过来也不会坏，只是在页面更新之前仍是普通标题栏。

连别的 ash：`defaults write dev.ash.mac AshURL http://192.168.1.187:4317`，或启动时带 `ASH_URL`；非本机地址不会替它起服务。换仓库：`defaults write dev.ash.mac AshRepoPath <仓库根>`。

## 文件

| 文件 | 管什么 |
|---|---|
| `Sources/AshConfig.swift` | 连哪台、用哪份仓库、什么算同源 |
| `Sources/ServerLauncher.swift` | 服务不在时把它起起来 |
| `Sources/ServerStartLock.swift` | 与 `npm run restart` 共用的启动锁 |
| `Sources/AshHealth.swift` | 「服务就绪」的唯一判据，启动器与窗口恢复共用 |
| `Sources/LoginService.swift` | 登录时启动的 LaunchAgent |
| `Sources/AppDelegate.swift` | 生命周期与菜单（⌘C/⌘V 靠编辑菜单分发，不能省） |
| `Sources/BrowserWindowController.swift` | 窗口、WKWebView、离线探活、菜单动作 |
| `Sources/WindowChrome.swift` | 内容铺到窗口顶：量红绿灯、和页面的约定、拖窗口 |
| `Sources/WebViewBridge.swift` | 外链、新窗口、选文件、下载、JS 对话框 |
| `Sources/DownloadTransaction.swift` | 另存为的暂存、原子替换与中断后的回收 |
| `Sources/OfflineView.swift` | 服务不在时的那一屏 |
| `scripts/make-icon.swift` | 构建时现画图标 |

卸载：菜单里先取消「登录时启动 ash 服务」，再删 /Applications/Ash.app。页面检查器：Safari →「开发」→ 本机 → ash。
