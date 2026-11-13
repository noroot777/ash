# ash for macOS

装在「应用程序」里的一整份 ash：自带 node 和 server/web/mcp，数据放在 `~/Library/Application Support/dev.ash.mac/`，打开就能用。不依赖仓库检出，也不依赖系统里有没有 node。个人自用：服务以本机自用模式运行（只听 127.0.0.1，没有多人、配对和邀请）。

```bash
npm run install:mac                     # 构建并装进 /Applications，然后打开
npm run build:mac                       # 只构建 → desktop/macos/build/Ash.app
bash desktop/macos/build.sh --dmg       # 另出一份拖拽安装的 build/Ash.dmg
```

构建要 Xcode 命令行工具（`swiftc`、编 node-pty 的 clang）和本机的 node/npm，只在 Apple 芯片的 Mac 上出包。最低 macOS 14，ad-hoc 签名。

## 包里有什么

`scripts/bundle-runtime.mjs` 把下面这些装进 `Contents/Resources/app`（布局与仓库同形）：

- `node/bin/node`：固定版本的 node（版本与 sha256 写死在脚本顶部，下载后校验，对不上就不用）；
- `shared`、`server/dist`、`mcp/dist`、`web/dist`：先跑一遍 `npm run build`（`ASH_MAC_SKIP_BUILD=1` 跳过）；
- `node_modules`：server 与 mcp 的生产依赖，用自带 node 装，node-pty 按它重编。

下载的 node 和装好的依赖缓存在 `build/cache/`，lockfile、各 workspace 的 package.json 或 node 版本变了才重装。

版本：`CFBundleShortVersionString` 是给人看的（`build.sh` 里的 `VERSION`）；`CFBundleVersion` 单调递增，取构建所在提交的时间（UTC `日期.时分`），工作区有未提交改动时取当前时间。

## 服务怎么起

- 打开 app 先探 `/api/health`。端口上是**自己那份**（health 报的数据根就是 app 的数据根）就直接载页面；没人就用自带 node 起自带 server，带 `ASH_DATA_DIR=<数据根>`、`ASH_LOCAL_ONLY=1`。环境取自交互式登录 shell（`zsh -ilc`），claude、codex 这些 CLI 的 PATH、LANG 与终端里一致；node 不从 PATH 找。
- server 进自己的会话，**关窗、退出 app 都不停服务**，也不带走在跑的 agent。app 只负责起，不杀、不守护。
- 端口被**别的 ash** 占着（比如仓库里 `npm run restart` 起的开发实例）不会连上去，窗口里说清是哪个进程、代码和数据在哪、怎么停；对方一停 app 就接着起自己那份。端口被不是 ash 的程序占着也一样说明。仓库开发实例以后换端口、用临时库起。
- 「ash → 登录时启动 ash 服务」（装进「应用程序」后第一次打开默认勾上）：`~/Library/LaunchAgents/dev.ash.server.plist`，登录时跑一次 `Ash --start-server`，同一套逻辑、不开窗口。数据根还是空的时它不起（首启要先问用户）。
- 日志在**数据根下的 `logs/`**：`server.log`（服务）、`login.log`（登录项），跟着数据走。起不来时占位页上有「日志」按钮。
- 重装 app 不会重启已经在跑的服务：`install:mac` 发现旧 app 的服务还在跑时会提示，挑没有任务在跑的时候 `kill` 掉它，再打开 app。

## 第一次打开

数据根里还没有 `ash.db` 时，先问数据从哪来：

- **全新开始**：起一份空的，进入首启向导（供应商 → 执行器 → 项目）。
- **导入已有数据…**：选一份 ash 数据目录（比如仓库的 `data/`）。**只复制、不移动**。库走 SQLite 在线备份（一致快照，源库正被另一份 server 写着也安全；它还开着时会先提醒），其余目录按文件复制（同一 APFS 卷上是克隆，不占第二份空间）；锁、在线标记、`deps/`、`tmp/` 不搬。多人模式的数据不能导（app 只跑自用模式）。库最后落，中途失败下次打开还是这一屏。已知局限：库里有些历史记录写的是源目录的绝对路径（旧会话的输出文件、监控日志等），导入后它们仍指向源目录，源目录删了那几条就读不到。

连上自己那份之后，app 替本机装了的 CLI 接 ash MCP（`POST /api/ash-mcp/host-setup`，同注册执行器那一下：缺了才写、已有登记一律不覆盖），写进去的是 app 自带的 node 和 `mcp/dist`。已有登记**指向别处**的（比如仓库的 `mcp/dist`）不替你改，弹窗列出现在指向哪、改成什么，改不改你定；没接上的（macOS 上 codex 那一家 ash 不替你写）给出手工加的那一段。每个数据根自动查一次，之后从菜单「检查 ash MCP 登记…」随时再查。

## 验证用的口子

不碰日常那一份：把 app 拷到任何地方，用临时数据根和临时端口直接跑可执行文件——

```bash
ASH_URL=http://127.0.0.1:14977 ASH_DATA_DIR=/tmp/ash-try HOME=/tmp/ash-home \
  /path/to/Ash.app/Contents/MacOS/Ash                 # 带窗口
  /path/to/Ash.app/Contents/MacOS/Ash --start-server  # 不带窗口
```

也可以 `defaults write dev.ash.mac AshDataDir <目录>` 换数据根、`defaults write dev.ash.mac AshURL http://192.168.1.187:4317` 连别的 ash（非本机地址不替它起服务，也不做身份判断）。

定点回归：`node scripts/test-macos-client.mjs`（仅 macOS）。用真的 AshConfig / AshHealth / ServerLauncher / DataImport 加一份假的自带运行时，覆盖下载事务、红绿灯下的页面、「端口上是谁」的判据、空数据根不起、起服务的环境、占用提示、并发只起一份、锁超时、请求合并、起来就退、PID 核对、启动器报错、运行时缺件、导入（WAL 里的写入、只复制、多人库拒绝、残留替换）。server 那一半在 `npm -w server run test:host-ash-mcp`。

## 窗口

内容铺到窗口顶，红绿灯浮在页面左上角，不单占一行标题栏。页面要给它让位，所以是页面先表态：`web/index.html` 里有 `<meta name="ash-window-chrome" content="overlay">` 才铺上去，没有这一行的文档（旧版本的 ash、同源的其它页面）仍是普通标题栏。壳把红绿灯的实际高宽量出来交给页面（`--window-titlebar-height` / `--window-controls-width`，全屏时为 0），页面这一半在 `web/src/styles/window-shell.css`：主工作区和设置页把那一条用起来，其它整页布局默认让开。顶上那一条的空白处、以及页面用 `--window-drag: drag` 划进来的顶栏都能拖窗口，双击跟随系统设置。

导出下载先写目标目录内的独立临时文件，完成后再原子替换目标文件。下载失败或在完成前退出不会删除已有文件。每笔下载在 `~/Library/Application Support/dev.ash.mac/downloads` 留一张带锁的登记；app 被强杀或断电留下的隐藏暂存目录（目标文件夹里的 `.ash-download-…`）下次启动时照登记回收，仍在写的下载持着锁、不会被碰。

## 文件

| 文件 | 管什么 |
|---|---|
| `scripts/bundle-runtime.mjs` | 把 node、产物、生产依赖装进 app |
| `Sources/AshConfig.swift` | 连哪台、自带运行时在哪、数据和日志放哪 |
| `Sources/AshHealth.swift` | 「端口上是谁」的唯一判据 |
| `Sources/ServerLauncher.swift` | 起自带的服务；端口被占时说清是谁 |
| `Sources/ServerStartLock.swift` | 同一数据根同时只有一处在起服务 |
| `Sources/LaunchFlow.swift` | 窗口回到 ash 的那条路，首启的全新开始 / 导入 |
| `Sources/DataImport.swift` | 导入旧数据 |
| `Sources/HostMcpSetup.swift` | 替本机 CLI 接 ash MCP、把指向别处的摆给用户 |
| `Sources/LoginService.swift` | 登录时启动的 LaunchAgent |
| `Sources/AppDelegate.swift` | 生命周期与菜单（⌘C/⌘V 靠编辑菜单分发，不能省） |
| `Sources/BrowserWindowController.swift` | 窗口、WKWebView、探活、菜单动作 |
| `Sources/WindowChrome.swift` | 内容铺到窗口顶：量红绿灯、和页面的约定、拖窗口 |
| `Sources/WebViewBridge.swift` | 外链、新窗口、选文件、下载、JS 对话框 |
| `Sources/DownloadTransaction.swift` | 另存为的暂存、原子替换与中断后的回收 |
| `Sources/OfflineView.swift` | 页面载不进来时的那一屏 |
| `scripts/make-icon.swift` | 构建时现画图标 |

卸载：菜单里先取消「登录时启动 ash 服务」，停掉服务，再删 /Applications/Ash.app；数据在 `~/Library/Application Support/dev.ash.mac/`。页面检查器：Safari →「开发」→ 本机 → ash。
