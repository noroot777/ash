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

版本：`CFBundleShortVersionString` 是给人看的（`build.sh` 里的 `VERSION`）；`CFBundleVersion` 严格递增：样子是 UTC `日期.时分秒`，但每次构建都要比账本里上一个号大，不比它大（同一秒、从旧提交重打、时钟回拨）就在它上面加一，并发构建按锁排队（`scripts/build-number.mjs`）。账本是仓库 git 公共目录下的 `ash-mac-build-number`，各个 worktree 共用。

## 服务怎么起

- 打开 app 先探 `/api/health`。端口上是**自己那份**才载页面：health 报的数据根是 app 的数据根、代码目录是 app 自带的那份、开着本机自用模式，三样都对上（`AshHealth.swift`，只看数据根的话仓库里指着同一份数据的开发实例也会被认成自己）。没人就用自带 node 起自带 server，带 `ASH_DATA_DIR=<数据根>`、`ASH_LOCAL_ONLY=1`。环境取自交互式登录 shell（`zsh -ilc`），claude、codex 这些 CLI 的 PATH、LANG 与终端里一致；数据根、端口、本机模式写成命令里的字面量、由 `env` 在 exec 那一下落定，终端配置里给开发实例 export 的同名变量盖不掉它们。node 不从 PATH 找。
- 窗口不连 4317，连这份服务**专用的端口**：app 按数据根的真实路径算出一个固定端口（42000–47999，`AshConfig.windowPort`；`ASH_MAC_WINDOW_PORT` 可指定），起服务时用 `ASH_WINDOW_PORT` 交给它，服务在 4317 之外再监听这个端口（只听 127.0.0.1），health 里报出来（`server/src/window-port.ts`）；health 报的专用端口对不上（没监听上、或者不是这一版 app 起的）也不算自己那份。4317 照旧给浏览器、CLI 和 MCP 用，「在浏览器中打开」换回 4317 的地址。这样自己那份一停，窗口的端口就空着：别的 ash 默认只会去占 4317，撤页之前页面还在发的请求连不上任何人。**剩余风险（用户 2026-11-14 选择接受）**：专用端口只是一个普通的本机端口，不归这份服务独占。有人特意把一份旧版 ash（不认实例号）用 `PORT` 起在这个端口上，而且恰好赶在窗口撤页之前那一两秒，页面在那一下发出的请求仍会被它执行；新版 ash 起在这个端口上则会因为实例号对不上而拒收。要彻底堵住得让窗口请求换成旧版接不住的形式（每次起服务都不同的地址前缀，或经 app 转发到只有新版才开的本机连接文件），改动大，没有做。代价：窗口和浏览器是两个来源，主题、草稿这些存在页面本地的设置各管各的。
- 认过人之后，页面发的每个请求（页面本身、fetch、SSE、预览）还都带着那一份服务的实例号（cookie `ash_instance`，原生的补接请求放在请求头里）。实例号每次起服务都换；自家服务原地重起过、或者专用端口上换了一份新版 ash，见到别人的实例号一律 409、什么都不执行（`server/src/instance-binding.ts`）。
- 页面在的时候也一直认着人：本机地址的刷新、前进后退、页面自己跳转放行前各认一次，页面在时每秒再认一次。窗口的端口上不再是自己那份（比如服务停了）就把整页撤成空白、盖上说明，自己那份回来后回到原来的路由；自己那份重起过（实例号换了）就换上新的重载一遍。这一道管的是提示和撤页，不是请求归属：撤页之前还在路上的请求由上面两条挡下。
- server 进自己的会话，**关窗、退出 app 都不停服务**，也不带走在跑的 agent。app 只负责起，不杀、不守护。
- 端口被**别的 ash** 占着（比如仓库里 `npm run restart` 起的开发实例）不会连上去，窗口里说清是哪个进程、代码和数据在哪、怎么停；对方一停 app 就接着起自己那份。端口被不是 ash 的程序占着也一样说明。仓库开发实例以后换端口、用临时库起。
- 「ash → 登录时启动 ash 服务」（装进「应用程序」后第一次打开默认勾上）：`~/Library/LaunchAgents/dev.ash.server.plist`，登录时跑一次 `Ash --start-server`，同一套逻辑、不开窗口。数据根还是空的时它不起（首启要先问用户）。
- 日志在**数据根下的 `logs/`**：`server.log`（服务）、`login.log`（登录项），跟着数据走。起不来时占位页上有「日志」按钮。
- 重装 app 不会重启已经在跑的服务，也不会换掉它脚下的代码：`install:mac` 先请窗口退出，再换包（`scripts/install-app.sh`）。换包和进程启动共用一把锁（`shared/src/code-lock.ts`）：跑包里代码的服务、ash MCP 在读任何业务代码之前，以共享锁拿着包里的 `Contents/Resources/app/.in-use`，一直拿到进程结束；安装器对它拿排他锁，从最后一次检查一直拿到两次改名换完——拿不到就是有人在用，不装、列出是谁；换包那几秒里新起来的进程等在锁上，等到时读到的是一整份新代码。锁在文件本身上，包改名、经软链或相对路径拉起都认得出；进程被强杀内核就放锁，不留死登记；锁文件缺了入口拒绝启动，不会悄悄变成「没人用」。锁管不到的（Ash 本身、别的程序拿包里的可执行文件或脚本跑）另按真实文件身份扫（`scripts/bundle-users.sh`）：可执行文件、映射进来的库、工作目录按 lsof 报的真实路径比，命令行里提到的 .app 逐个按真实路径解析。挑没有任务在跑的时候 `kill` 掉服务（agent 不跟着停），等 MCP 那几个任务这一轮结束，再装一次。同一个安装目录同一时刻只有一个安装在换（按目录真实路径加锁）；新版先拷到旁边再换上，拷失败、最后一步失败时旧的那份放回原处。已经装着的是还没有代码锁的旧版 app 时，那一次只能靠扫描。

## 第一次打开

数据根里还没有 `ash.db` 时，先问数据从哪来：

- **全新开始**：起一份空的，进入首启向导（供应商 → 执行器 → 项目）。
- **导入已有数据…**：选一份 ash 数据目录（比如仓库的 `data/`）。**只复制、不移动**，源目录一个文件都不多。库走 SQLite 在线备份（一致快照，源库正被另一份 server 写着也安全；它还开着时会先提醒），其余目录按文件复制（同一 APFS 卷上是克隆，不占第二份空间）；锁、在线标记、`deps/`、`tmp/`、源的 `logs/` 不搬。多人模式的数据、和 app 数据根互相包含的目录不能导。
  - **导入不是重启**：发布前用自带 node 跑一遍 server 的 `import-snapshot`。副本里不留任何认得出源实例进程的线索（pid、启动时刻、进程记号、没收干净的清理责任），在跑或排队的任务落「暂停」，在盯的哨兵、在跑的验收前置命令、进行中的审查落「结束/被打断」，定时任务停用（定义留着）、没发出的消息取消、队列推进作废 —— 否则副本开机会去接管、甚至停掉源实例正在跑的 agent，或在同一个仓库里再起一份。审查链另有一套不认 pid、认「任务还停在那个方向上」的执行权限：每个任务的方向世代推进一格，导入前记下的方向身份一律作废；收尾计划落成已了结、待补的结算不再补、续审/派审/修复投递的凭据全部撤掉 —— 否则副本开机会替源实例重投修复、推后续站、清合并审查的工作区。停下了哪些，导入完弹窗说一声。同一趟把库里落在源数据根下的绝对路径（会话输出、哨兵日志、附件、证据目录……）逐字改到 app 的数据根（数据根路径里带 `$&` 之类也照原样写），源数据根以外的路径一个字不动。
  - 和起服务**同一把锁**：先在数据根里一个只属于这一次的暂存目录备齐、洗好，再拿锁发布；锁里重查数据根还空着（另一个窗口或登录项可能刚点了「全新开始」，那时这次导入作罢、那份数据不碰）。数据根里有认不出来的东西也拒绝。库最后落，是提交点；挪到一半的条目记在清单里，下次导入先收掉。

连上自己那份之后，app 替本机装了的 CLI 接 ash MCP（`POST /api/ash-mcp/host-setup`，同注册执行器那一下：缺了才写、已有登记一律不覆盖），写进去的是 app 自带的 node 和 `mcp/dist`。已有登记**指向别处**的（比如仓库的 `mcp/dist`）不替你改，弹窗列出现在指向哪、改成什么，改不改你定；没接上的（macOS 上 codex 那一家 ash 不替你写）给出手工加的那一段。每个数据根自动查一次，之后从菜单「检查 ash MCP 登记…」随时再查。

## 验证用的口子

不碰日常那一份：把 app 拷到任何地方，用临时数据根和临时端口直接跑可执行文件——

```bash
ASH_URL=http://127.0.0.1:14977 ASH_DATA_DIR=/tmp/ash-try HOME=/tmp/ash-home \
  /path/to/Ash.app/Contents/MacOS/Ash                 # 带窗口
  /path/to/Ash.app/Contents/MacOS/Ash --start-server  # 不带窗口
```

也可以 `defaults write dev.ash.mac AshDataDir <目录>` 换数据根、`defaults write dev.ash.mac AshURL http://192.168.1.187:4317` 连别的 ash（非本机地址不替它起服务，也不做身份判断）。

定点回归：`node scripts/test-macos-client.mjs`（仅 macOS）。用真的 AshConfig / AshHealth / ServerLauncher / DataImport / BrowserWindowController 加一份假的自带运行时，覆盖下载事务、红绿灯下的页面、「端口上是谁」的判据（数据根 + 自带代码 + 本机模式）、窗口只连专用端口、在线后换人（自己那份停了、不认实例号的旧版 ash 接手 4317，页面持续写请求，一条都到不了 4317；导航与定时两道撤页；自家服务重起后换上新实例号）、空数据根不起、起服务的环境（终端配置盖不掉）、占用提示、并发只起一份、锁超时、请求合并、起来就退、PID 核对、启动器报错、运行时缺件、构建号、安装（别名目录、带正则字符的目录、相对路径起的包内可执行文件、包外软链起的入口靠它拿着的锁认出、最后检查之后改名之前起来的入口等在锁上并读到整份新包、锁文件缺了不启动不安装、两个安装器并发）、导入（WAL 里的写入、暂存里洗过再发布、和起服务互斥、失败与抢跑不留痕迹、残留清单、停掉的源、互相包含、多人库拒绝）。server 那一半：`npm -w server run test:host-ash-mcp`（MCP 登记归类）、`npm -w server run test:import-snapshot`（导入不是重启：真的接管入口对着洗过的库认不出活着的源进程；同一串开机对账对着没洗/洗过的副本各跑一遍，前者替源实例重投修复、后者一行不动；路径逐字重定位）、`npm -w server run test:instance-binding`（真服务：带着别人实例号的写请求、页面、预览与预览 WebSocket 一律 409 且不执行，health 照答；窗口专用端口上同一套判据，被占着时 health 报 null、服务照常起）。

## 窗口

内容铺到窗口顶，红绿灯浮在页面左上角，不单占一行标题栏。页面要给它让位，所以是页面先表态：`web/index.html` 里有 `<meta name="ash-window-chrome" content="overlay">` 才铺上去，没有这一行的文档（旧版本的 ash、同源的其它页面）仍是普通标题栏。壳把红绿灯的实际高宽量出来交给页面（`--window-titlebar-height` / `--window-controls-width`，全屏时为 0），页面这一半在 `web/src/styles/window-shell.css`：主工作区和设置页把那一条用起来，其它整页布局默认让开。顶上那一条的空白处、以及页面用 `--window-drag: drag` 划进来的顶栏都能拖窗口，双击跟随系统设置。

导出下载先写目标目录内的独立临时文件，完成后再原子替换目标文件。下载失败或在完成前退出不会删除已有文件。每笔下载在 `~/Library/Application Support/dev.ash.mac/downloads` 留一张带锁的登记；app 被强杀或断电留下的隐藏暂存目录（目标文件夹里的 `.ash-download-…`）下次启动时照登记回收，仍在写的下载持着锁、不会被碰。

## 文件

| 文件 | 管什么 |
|---|---|
| `scripts/bundle-runtime.mjs` | 把 node、产物、生产依赖装进 app |
| `scripts/build-number.mjs` | 严格递增的 CFBundleVersion |
| `scripts/install-app.sh` | 换进安装目录（按目录加锁）；旧包还有进程在用就不换 |
| `scripts/bundle-users.sh` | 还有哪些进程在用某个 .app（按真实文件身份认） |
| `Sources/AshConfig.swift` | 连哪台、自带运行时在哪、数据和日志放哪 |
| `Sources/AshHealth.swift` | 「端口上是谁」的唯一判据（数据根、自带代码、本机模式、窗口专用端口） |
| `Sources/ServerLauncher.swift` | 起自带的服务；端口被占时说清是谁 |
| `Sources/ServerStartLock.swift` | 同一数据根同时只有一处在起服务 |
| `Sources/LaunchFlow.swift` | 窗口回到 ash 的那条路，首启的全新开始 / 导入 |
| `Sources/DataImport.swift` | 导入旧数据：暂存、洗副本（`server/src/import-snapshot.ts`）、持锁发布 |
| `Sources/HostMcpSetup.swift` | 替本机 CLI 接 ash MCP、把指向别处的摆给用户 |
| `Sources/LoginService.swift` | 登录时启动的 LaunchAgent |
| `Sources/AppDelegate.swift` | 生命周期与菜单（⌘C/⌘V 靠编辑菜单分发，不能省） |
| `Sources/BrowserWindowController.swift` | 窗口、WKWebView、探活、页面在时认人、菜单动作 |
| `Sources/WindowChrome.swift` | 内容铺到窗口顶：量红绿灯、和页面的约定、拖窗口 |
| `Sources/WebViewBridge.swift` | 外链、新窗口、选文件、下载、JS 对话框 |
| `Sources/DownloadTransaction.swift` | 另存为的暂存、原子替换与中断后的回收 |
| `Sources/OfflineView.swift` | 页面载不进来时的那一屏 |
| `scripts/make-icon.swift` | 构建时现画图标 |

卸载：菜单里先取消「登录时启动 ash 服务」，停掉服务，再删 /Applications/Ash.app；数据在 `~/Library/Application Support/dev.ash.mac/`。页面检查器：Safari →「开发」→ 本机 → ash。
