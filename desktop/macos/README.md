# Navi for macOS

装在「应用程序」里的一整份 Navi：自带 node 和 server/web/mcp，数据放在 `~/Library/Application Support/dev.navi.mac/`（从 Ash.app 升级上来的机器上还是原来的 `dev.ash.mac/`，见「从 Ash.app 升级」），打开就能用。不依赖仓库检出，也不依赖系统里有没有 node。个人自用：没有多人和邀请；默认以本机自用模式运行（只听 127.0.0.1，没有远程配对），要在手机上用就打开菜单「Navi › 允许其他设备访问」（见「让别的设备进来」）。

```bash
npm run install:mac                     # 构建并装进 /Applications，然后打开
npm run build:mac                       # 只构建 → desktop/macos/build/Navi.app
bash desktop/macos/build.sh --dmg       # 另出一份拖拽安装的 build/Navi.dmg（与发版同一个格式）
```

构建要 Xcode 命令行工具（`swiftc`、编 node-pty 的 clang）和本机的 node/npm，按当前 Node 的架构生成 Apple 芯片（arm64）或 Intel（x64）安装包。最低 macOS 14，ad-hoc 签名。`NAVI_MAC_ARCH=arm64|x64` 可显式指定，但要与构建用的 Node 架构一致；Node、原生依赖缓存和 Swift 目标随架构切换，不做混合架构打包。

## 包里有什么

`scripts/bundle-runtime.mjs` 把下面这些装进 `Contents/Resources/app`（布局与仓库同形）：

- `node/bin/node`：固定版本的 node（版本与 sha256 写死在脚本顶部，下载后校验，对不上就不用）；
- `shared`、`server/dist`、`mcp/dist`、`web/dist`：先跑一遍 `npm run build`（`NAVI_MAC_SKIP_BUILD=1` 跳过）；
- `node_modules`：server 与 mcp 的生产依赖，用自带 node 装，node-pty 按它重编。

下载的 node 和装好的依赖缓存在 `build/cache/`，lockfile、各 workspace 的 package.json 或 node 版本变了才重装。

版本：`CFBundleShortVersionString` 是给人看的（`build.sh` 里的 `VERSION`）；`CFBundleVersion` 严格递增：样子是 UTC `日期.时分秒`，但每次构建都要比账本里上一个号大，不比它大（同一秒、从旧提交重打、时钟回拨）就在它上面加一，并发构建按锁排队（`scripts/build-number.mjs`）。账本是仓库 git 公共目录下的 `navi-mac-build-number`，各个 worktree 共用（改名前叫 `ash-mac-build-number`：发号时在锁里把它当底读一下，只读不写，号从它往上接着发。反过来不成立：从改名前的旧提交构建，用的还是旧账本和旧锁，可能跟新版发出同一个号 —— 那是 Ash.app，包标识和更新源都跟 Navi 分开，互不影响）。

## 服务怎么起

- 打开 app 先探 `/api/health`。端口上是**自己那份**才载页面：health 报的数据根是 app 的数据根、代码目录是 app 自带的那份、报自己是 app 起的那一份（`desktop`），三样都对上（`NaviHealth.swift`，只看数据根的话仓库里指着同一份数据的开发实例也会被认成自己；比这一版旧、不报 `desktop` 的服务按 `localOnly` 认）。没人就用自带 node 起自带 server，带 `NAVI_DATA_DIR=<数据根>`、`NAVI_DESKTOP_APP=1`、`NAVI_LOCAL_ONLY=1`（打开了「允许其他设备访问」时是 `0`）。环境取自交互式登录 shell（`zsh -ilc`），claude、codex 这些 CLI 的 PATH、LANG 与终端里一致；数据根、端口、本机模式写成命令里的字面量、由 `env` 在 exec 那一下落定，终端配置里给开发实例 export 的同名变量盖不掉它们。node 不从 PATH 找。
- 窗口不连 4317，连这份服务**专用的端口**：app 按数据根的真实路径算出一个固定端口（42000–47999，`NaviConfig.windowPort`；`NAVI_MAC_WINDOW_PORT` 可指定），起服务时用 `NAVI_WINDOW_PORT` 交给它，服务在 4317 之外再监听这个端口（只听 127.0.0.1），health 里报出来（`server/src/window-port.ts`）；health 报的专用端口对不上（没监听上、或者不是这一版 app 起的）也不算自己那份。4317 照旧给浏览器、CLI 和 MCP 用，「在浏览器中打开」换回 4317 的地址。这样自己那份一停，窗口的端口就空着：别的 Navi 默认只会去占 4317，撤页之前页面还在发的请求连不上任何人。**剩余风险（用户 2026-11-14 选择接受）**：专用端口只是一个普通的本机端口，不归这份服务独占。有人特意把一份旧版 Navi（不认实例号）用 `PORT` 起在这个端口上，而且恰好赶在窗口撤页之前那一两秒，页面在那一下发出的请求仍会被它执行；新版 Navi 起在这个端口上则会因为实例号对不上而拒收。要彻底堵住得让窗口请求换成旧版接不住的形式（每次起服务都不同的地址前缀，或经 app 转发到只有新版才开的本机连接文件），改动大，没有做。代价：窗口和浏览器是两个来源，主题、草稿这些存在页面本地的设置各管各的。
- 认过人之后，页面发的每个请求（页面本身、fetch、SSE、预览）还都带着那一份服务的实例号（cookie `ash_instance`，原生的补接请求放在请求头里）。实例号每次起服务都换；自家服务原地重起过、或者专用端口上换了一份新版 Navi，见到别人的实例号一律 409、什么都不执行（`server/src/instance-binding.ts`）。
- 页面在的时候也一直认着人：本机地址的刷新、前进后退、页面自己跳转放行前各认一次，页面在时每秒再认一次。窗口的端口上不再是自己那份（比如服务停了）就把整页撤成空白、盖上说明，自己那份回来后回到原来的路由；自己那份重起过（实例号换了）就换上新的重载一遍。这一道管的是提示和撤页，不是请求归属：撤页之前还在路上的请求由上面两条挡下。
- server 进自己的会话，**关窗、退出 app 都不停服务**，也不带走在跑的 agent。app 只负责起，不杀、不守护。
- 端口被**别的 Navi** 占着（比如仓库里 `npm run restart` 起的开发实例）不会连上去，窗口里说清是哪个进程、代码和数据在哪、怎么停；对方一停 app 就接着起自己那份。端口被不是 Navi 的程序占着也一样说明。仓库开发实例以后换端口、用临时库起。
- 「Navi → 登录时启动 Navi 服务」（装进「应用程序」后第一次打开默认勾上）：`~/Library/LaunchAgents/dev.navi.server.plist`，登录时跑一次 `Navi --start-server`，同一套逻辑、不开窗口。数据根还是空的时它不起（首启要先问用户）。
- 日志在**数据根下的 `logs/`**：`server.log`（服务）、`login.log`（登录项），跟着数据走。起不来时占位页上有「日志」按钮。
- `install:mac` 先请窗口退出，拷好新包后换包并打开新版。外置服务与 MCP 不占用 app，任务和服务持有的终端、项目服务、预览试跑、聊天执行继续运行。仍使用包内代码的旧布局才走空闲服务停止与占用者检查；身份不明、旧布局任务或 MCP 仍占包时拒绝替换，不强杀。
- 旧布局检查全部占用者：只有它们全是可确认的空闲服务时才统一停止。服务身份按实际监听进程和 health 报的代码根、数据根核对，不依赖默认端口或当前终端的数据目录；停止前检查运行与排队任务（包括可接管的 agent）、服务的存活后代，以及服务端通过 `/api/restart-impact?shutdown=1` 提供的退出清场清单。清单和实际退出清理使用同一组登记，包含终端与正在创建的会话、只靠端口认领的守护化项目服务、预览试跑和聊天执行。清单非空时列出资源并保留全部服务；清单缺失或格式不明的旧服务也不会自动停止，需要先手动停止旧服务再安装。这是对旧版本的保守兼容，不从进程树为空推断没有受影响的资源。在旧布局服务的 Navi 自带终端里安装会提示改用外部终端，避免安装器被服务退出时的清场连带终止。Navi MCP 不由安装器结束，仍有 MCP 或其他进程占用旧包时会拒绝换包并列出进程。安装失败后也会重新打开保留或恢复的旧 app，由它恢复服务。
- 换包和进程启动共用一把锁（`shared/src/code-lock.ts`）：服务和 Navi MCP 在读业务模块前，以共享锁持有包里的 `Contents/Resources/app/.in-use`；安装器拿排他锁，从最后一次检查一直持有到两次改名换完。换包期间新起的进程等在锁上，随后读取完整新版。锁跟着文件走，软链、相对路径、包改名不影响识别；进程退出后内核释放锁。锁管不到的可执行文件、映射库、工作目录和命令行另由 `scripts/bundle-users.sh` 按真实路径扫描。安装目录有独立的串行锁，新包先拷到旁边，失败时旧包保留或恢复；没有代码锁的旧版仍按扫描检查。
- 换了新版 app 而服务还是旧版 app 起的（app 被强杀时 Sparkle 照样装上的那一档、手动换 app）：app 起服务时在数据根里记一笔 pid + 构建号（`.mac-server.json`），新版打开时认得出，按下面的独立服务接管流程换成新版。

## 让别的设备进来

两个开关各管一件事（`server/src/local-only.ts`）：`NAVI_DESKTOP_APP` 说「这是 app 起的那一份」（health 里认自家、窗口专用端口、模式固定自用），`NAVI_LOCAL_ONLY` 只管网络暴露面（只听 127.0.0.1、关掉远程配对和访问密钥）。

- 菜单「Navi › 允许其他设备访问」打勾 = 起服务时 `NAVI_LOCAL_ONLY=0`：服务听所有网卡，同一 Tailscale / 局域网里的设备打开 `http://<这台 Mac>:4317` 走现有的配对流程（这台电脑上批准，或者输访问密钥，「设置 › 默认规则 › 远程访问」），飞书卡片上的「在 Navi 中打开」在手机上也就打得开了。窗口专用端口不受影响，始终只听 127.0.0.1。
- 设置存在 UserDefaults（`NaviAllowOtherDevices`），服务按起的那一下的值定，所以改了要重启：先问「现在重启会打断谁」，会打断或确认不了才弹窗让人选，放行后攥着维护锁只停评估过的那一份，确认停下之后才把新设置落盘，再按它起（`RemoteAccessSwitch.swift`）。这样中途在哪一步退出，留下的设置和服务都对得上；没停成就什么都不改。
- 设置和在跑的服务还是可能对不上（手动改了 defaults、上一版 app 起的服务）：app 记着每次认出自家服务时它报的 `localOnly`（`ServedInstance`），对不上时菜单写「允许其他设备访问（重启服务后生效）」，点它就按现在的设置重启。
- 只听本机时，飞书设置页存着的「卡片深链地址」不是本机地址的话，就地说明手机打不开、指向这个开关（`server/src/im/app-link.ts`）。

## navi:// 链接

app 注册了 `navi://`（`build.sh` 写进 Info.plist）。`navi://open?project=<项目>&task=<任务>&instance=<指纹>&fallback=<http 地址>` 把窗口拉到前面；自家服务报的指纹（`server/src/instance-tag.ts`，health 里的 `instance.tag`）和链接里的对上，才在窗口里打开那个任务（页面在着就原地换路由，还没载进来就载到那里），对不上或认不出（另一台 Mac 发的卡、app 指着别处）就把 http 地址交给浏览器（`DeepLink.swift`）。只收这几个参数、只收 id 和指纹的字形，fallback 只收指着同一个任务的 http(s) 地址；别的链接只把窗口拉到前面。

飞书卡片只在 app 起的服务**只听本机**时给按钮的 `pc_url` 带这条链接（手机仍走 `default_url` 的 http）：那时 http 在别的电脑上一律打不开，`navi://` 只会让本机这一台变好。放开了别的设备访问就不给，桌面端也走 http —— 发卡的服务不知道收卡的电脑装没装 app。开关一换、服务按新设置起来，飞书通道会把库里存着的卡按新的链接策略重写，14 天内发出的逐张记着、改到飞书上才算完 —— 额度挡住就往后挪着再改，改卡放弃了下次起服务重新排上（更早的飞书不让改，`server/src/im/relink.ts`）。连着点了几条链接时只有最后一条落地。飞书开放平台文档写明 `pc_url` 支持 AppLink，没写第三方 scheme 支不支持，真飞书桌面端没验证过（`server/src/im/app-link.ts`）。

## 自更新

用 [Sparkle](https://sparkle-project.org) 2（版本和 sha256 钉在 `scripts/sparkle.mjs`，框架原样放进 `Contents/Frameworks`）。菜单「Navi → 检查更新…」，另外每 6 小时自己查一次。两个公开仓库，都在 `release.json` 里配：

- **安装包**在 [noroot777/navi](https://github.com/noroot777/navi)（`releaseRepo`；GitHub 上要先从 noroot777/ash 改名过来，没改名时发版脚本会拦下、不去新建）：Apple 芯片版为 `navi-mac-v<版本>` Release 上的 `Navi-<版本>.dmg`，Intel 版为 `navi-mac-intel-v<版本>` 上的 `Navi-<版本>-intel.dmg`；旧版含构建号的包及链接不变。只出 dmg：新用户下载安装的、Sparkle 更新用的是同一个文件。
- **appcast** 在素材库 [noroot777/materials](https://github.com/noroot777/materials)（`feedRepo`）的 `navi/mac/appcast.xml`，app 的 `SUFeedURL` 是它在 raw.githubusercontent 上的那份；每一版的下载地址指向 noroot777/navi 那个 Release 上的 dmg。改名前的 Ash.app 看的是同一个仓库里的 `ash/mac/appcast.xml`（`legacyAppcastPath`）：每次发版那一份换成一条「仅通知」的条目，见「从 Ash.app 升级」。

**只靠 EdDSA 签名校验**：app 是 ad-hoc 签名，没有能跨版本延续的 Apple 签名身份，而 Sparkle 的规则是「Apple 签名身份和 EdDSA 密钥至少一样不变」。所以 Info.plist 里的 `SUPublicEDKey` **永远不能换**，换了已装的 app 就再也装不上新版。appcast 本身也签（`SURequireSignedFeed`），dmg 先验签再挂载（`SUVerifyUpdateBeforeExtraction`）：被改过的 dmg 或 appcast 一律拒装。公钥由 `build.sh` 从 `release.json` 写进 Info.plist；还没配公钥的构建不带更新源，菜单里也没有「检查更新…」。

dmg 的格式（`scripts/make-dmg.sh`，按 Sparkle 2.10.1 的源码核对过）：UDZO 只读压缩镜像，不带许可协议；卷里是 `Navi.app`、指向 `/Applications` 的软链和 Finder 布局（`dmg/DS_Store`，由 `scripts/make-dmg-layout.py` 生成后入库，出包时不用 Finder）。Sparkle 挂载时跳过软链和隐藏文件、只拷出 app，再按已装那份的文件名（`Navi.app`）或包标识认出新版，所以卷里的名字固定是 `Navi.app`。dmg 不签：Sparkle 对 dmg 的「Apple 签名兜底」只认 Developer ID，ad-hoc 的 app 没有 team，这条兜底永远走不通，验签失败就是拒装。

### 装之前那道闸

换 app 与换服务现在是两件事。构建在签完原生依赖后生成内容清单，首次启动把 Node、服务、MCP、前端及依赖完整校验并发布到 `<数据根>/.mac-runtimes/<sha256>/`。发布用暂存目录与原子改名；已发布版本不被覆盖，也不自动清理，旧 MCP 可以一直使用原来的版本。导入数据不搬这些可重建的运行时。

1. `install:mac` 或 Sparkle 换 app 时，外置服务、agent 和 MCP 继续运行，不等任务完成。Sparkle 的安装、自动安装和退出时安装都只取得 app 内代码的排他锁，不停止外置服务；取消或安装失败会释放锁，旧服务不受影响。
2. 新窗口既认当前运行时、同一数据根中保留的旧运行时，也认 app 包内的旧布局服务。外置旧服务单独接管：detached 单飞任务按原有 PID、回合身份和输出进度接回，旧 MCP 不杀、不换文件，连接拒绝期间沿用 MCP 现有的有限重试。包内旧服务走原来的确认、停服务、备份流程，不申请它无法提供的外置接管许可。
3. 排队、团队的当前回合或其他不可接管的运行继续留在旧服务上，每 5 秒重评；不弹出默认允许中断的选项。它们不阻止 app 安装，只延后服务切换。服务接管有短暂 HTTP 连接空档，不是双服务同时写库的零停机升级。
4. 真正换服务前取得启动维护锁，并向被点名的旧实例申请 60 秒接管许可。许可冻结新回合认领，再检查数据库与内存中的起跑、结算占位；有不确定性就撤销许可、继续用旧服务。冻结有独立的等待队列，派审、续跑和结算在许可撤销或过期后继续，不消耗「回合被抢占」的重排次数。备份成功且许可仍有效才 SIGTERM 旧服务；许可自动过期，启动器崩溃不会永久冻结起跑。新服务的迁移前备份和启动失败恢复点沿用下一节机制。

已经运行的包内服务和 MCP 的模块路径仍写着原 app，无法靠复制目录改变它们的模块缓存。`install:mac` 与 Sparkle 对仍持锁的包内进程安全拒绝，不强杀来伪装无中断；拒绝信息列出进程与登记迁移入口。宿主 MCP 使用固定的 `command = /bin/sh`、`args = ["<数据根>/.mac-runtimes/mcp.sh"]`，每次启动一次性选定当前版本，之后一直读取那个不可变版本。升级切换 `current` 指针，已运行的 MCP 不变，新会话跟随新版。已有包内或钉死某版的登记，可在「检查 Navi MCP 登记…」中查看当前与建议配置、修改后重开对应 CLI 会话；既有登记不会被擅自覆盖。若不迁登记，后续新开的包内 MCP 仍会阻止换包，不是只会遇到一次的迁移限制。

`npm run restart` 与旧布局的交互式更新仍使用原来的快照判定；新接管许可只用于 mac app 的外置运行时切换。app 被强杀（`kill -9`、崩溃）时 Sparkle 可能仍会安装已下载的更新，外置旧服务和 MCP 继续使用原目录；新版打开后再评估服务接管。

### 安全接管与稳定通道

外置发布仍只有 `.mac-runtimes/<内容哈希>/.runtime.json` 和固定 `mcp.sh` 入口；服务协调仍只有 `/api/runtime-handover` 的同实例、宿主凭证与 60 秒租约。清单包含 `.handover.json`：协议版本为 1，schema 指纹覆盖打包后的数据库代码；活跃回合只在协议和 schema 兼容时接管。单个执行器配置异常仅阻挡对应任务，不破坏重启风险名单。

租约先暂停独立 gateway 接收后的投递并封住后端新请求，等已投递的 HTTP 请求和响应流完全排空，再冻结每个会话的文件读取、解析事件队列和正文/trace 写入，把准确消费位置写进数据库。最终复核任务、进程与回合占位后才放行停服；取消和租约过期恢复同一批消费者及 gateway。后台 agent 仍可继续写原始文件，新服务从持久化位置接着消费。

1M、协议转换和 Monitor 使用数据根内独立 Node 分发及 gateway 脚本提供的固定监听端口；新版服务准备好后接过后端身份。已投递的模型请求不会因断线自动重放，暂停期间的新请求留在 gateway；Monitor 异常、超时和切换期间均返回明确拒绝，并有命令钩子兜底。旧回合缺少可验证通道快照、仍依赖直连服务或持有未知状态时保守等待。`x-navi-undelivered: runtime-handoff-v1` 只是 MCP 明确未执行的重试标记，不是另一套接管端点。

入口身份、端口、PID、启动代次和控制 socket 持久化并保留备份；临时目录变化使用原记录，socket 被删后由原进程重绑。入口端口、协议或身份异常不会阻止整个 Navi 启动：存在活跃或未知使用者时保留身份、警告并拒绝不安全接管，没有使用者时才恢复入口或退回直连。控制器和独立入口使用同一个真实 PID、启动代次与通道快照判据，不把历史未结会话当成活进程。后端、活使用者、在途与排队请求全部消失十分钟后入口安全退役，再次启动仍可恢复原身份。

app 的接管预检携带新版 `.handover.json` 的协议与 schema，服务返回已核对的目标及阻挡原因；旧服务未确认核对目标时继续等待。预检与真实接管共享兼容性、任务和稳定通道可用性判据，先检查再取得封口租约；已知不兼容或通道降级不会触发请求 503、暂停入口或反复覆盖窗口。封口后的再次核对仍拒绝准备期间发生的变化；执行期拒绝会解除窗口覆盖并显式暂停自动切换，保留菜单重试入口，不重新启动轮询。

独立入口按 Node、脚本、使用者判据和身份记录模块四份内容哈希的聚合值发布；Node 复制完整发行目录，脚本及两个模块一起保留，构建目录名不超过文件系统单目录名限制。取消接管同步解除本地租约、请求封口及输出屏障，再尝试恢复入口；入口恢复失败明确报错且可以重试，不会把旧服务留在无限冻结状态。Monitor 的命令拒绝兜底不依赖入口或其 Node 文件仍可运行。

身份记录与备份的发布、恢复和迁移共用 SQLite 写事务锁，替换前比较完整读取快照；进程退出后锁自动释放。入口启动先认领未变化且不属于活进程的记录；启动后显式退役和闲置退出只在记录中的身份、端口、PID、启动代次与 socket 仍属于自己时发布，失去归属的旧进程退出不覆盖继任者。存在活着却无法验证归属的入口时，服务降级直连并警告，不在同数据根另起身份写者；入口有证据地退出后才恢复。

两份身份记录都为空、损坏或结构无效时，控制器同时核对通道使用者、残留 PID 的启动代次以及全量进程命令中的同数据根入口。只有三者均无活跃或未知证据时才比较后归档坏记录、换 socket 重建；进程探测失败或旧入口仍存活则保留原记录并降级，证据消失后巡检可以恢复。

运行时与 detached 根进程共享代码锁，活跃的旧 MCP 也持有自己的运行时锁。回收仅处理非 current、非恢复记录引用、通过清单校验、拿到排他锁且整目录进程扫描为空的版本；不确定性保留目录。`runtime-store.mjs gc <store>` 提供同一回收实现。

`npm run test:runtime:mac` 覆盖适配后的消费屏障、租约释放/过期、流排空、真实 Claude/Codex 与 MCP 接管、手动换包、签名 Sparkle 重开和失败迁移恢复；CLI 为隔离夹具，服务、MCP、HTTP 与更新安装流程真实运行，目录、HOME、端口均独立。

### 更新前的库备份、回到旧版

外置无损接管先留停服前备份，再在旧服务退出后固定最终快照与 `.mac-runtime-recovery.json`。新版迁移失败且进程确已退出、尚未开始业务接管时，可验证恢复点后恢复数据库和旧版本固定入口，重新启动保留的旧运行时；一旦开始业务接管就不自动覆盖库。未知或损坏的恢复记录不会阻止其他正常版本启动，也不会触发猜测性恢复。

成功回退后，数据根的 `.mac-runtime-paused.json` 记录保留的运行时和旧构建号。窗口重连、开机启动、访问设置引起的重启和 app 重开都继续使用该旧版本；暂停记录损坏时拒绝猜测启动其他版本。菜单重试会先准备当前 app 的目标运行时以核实接管协议，但不改变旧运行时入口或解除暂停；因此暂停期间安装后续版本也能重新进行普通接管评估。只有重新固定迁移前快照与恢复记录并验证目标运行时后，才解除暂停。恢复专项里的后台测试服务带有独立的自退凭证，场景收尾确认相关进程全部退出后再删除临时运行时。

新版窗口被外置旧服务的永久阻挡项卡住时，可从「切换新版服务…」选择「强制切换服务…」。确认框重新列出可能被打断的任务，默认取消；影响清单获取失败时明确提示可能打断所有任务。确认只绑定当时的本机服务身份，停服务前在维护锁下再次复核实例、进程、代码与数据目录，无法识别或身份变化时拒绝操作。强制路径不保证任务、模型请求或 MCP 无损，但保留迁移前备份、最终停服快照及上述失败回退。回退成功时提示新版启动失败并暂停自动切换，可从菜单重试；普通与强制重试都以当前 app 的新版运行时为目标，不把回退中的旧运行时当作目标。包内旧布局仍保留「现在重启」。Sparkle、退出安装和包占用检查独立执行，不继承强制授权。`node scripts/test-macos-recovery.mjs` 使用隔离目录和服务覆盖取消、身份变化、幽灵阻挡、真实启动失败恢复及并发安装隔离。

server 一启动就做不可逆的迁移，所以外置服务接管在取得许可后、停服务前（旧布局则在停服务后、换 app 前），用 SQLite 在线备份给库留一份：`<数据根>/backups/<UTC 时间>-<旧构建号>.db`，一个自成一体的文件；同一秒的几份另起名字、不互相覆盖，新旧按生成先后认。每一份更新前备份都先**固定成恢复点**（`backups/recovery-points.json`），直到确认之后有一份服务在这份库上真起来过：

- 「起来过」的判据只有一个：端口上应答的正是数据根里服务记录（`.mac-server.json`）记着的那个进程。起服务之前先记下这一版的构建号（记不下就不起），进程一起来补上 pid；之后**不管是谁先看到它应答**——起它的启动器、重开的 app、登录项、另一个窗口——都在同一处确认，起它的那个中途被退掉、超时了也不要紧。确认时间记进服务记录，比它早的恢复点一律作废（恢复点文件删不掉也一样）。
- 没确认之前，恢复点不参与「只留最近 5 份」的轮换；确认之后回到普通轮换里。
- 起服务前要不要补一份：库上一次交给的就是这一版（它已经在这份库上起过，没成的话起之前已经留过底，这会儿再备就是拿迁移了一半的库去挤原件）、或者有一份恢复点是「留它时库最后交给的版本和现在一样」的（这一次已经备过），就不补；其余都补。上一版起过、哪怕从没被谁看到应答，更早那份底也不会被当成这一次的。

新版起不来时，占位页指的是最近那个恢复点（这一版迁移之前的库）；更早几次没确认起来过的也还留着。回到旧版：

```bash
# （数据根按自己机器上的写：从 Ash.app 升级上来的还是 dev.ash.mac，见「从 Ash.app 升级」）
# 1. 退出 app，停掉服务（数据根里库的单例锁记着 pid：库叫 navi.db 的是 navi.db.navi.lock，还叫 ash.db 的是 ash.db.ash.lock）
cd ~/Library/Application\ Support/dev.navi.mac
for l in navi.db.navi.lock ash.db.ash.lock; do [ -f "$l" ] && kill "$(node -p "require('./$l').pid")"; done
# 2. 从 noroot777/navi 的 Releases 里下回备份文件名里那个构建号的 dmg（tag navi-mac-v…-<构建号>），
#    打开后把里面的 Navi（`Navi.app`）拖进 Applications，选「替换」
# 3. 把备份放回去（先把现在这份挪开，别直接覆盖）。放成旧名 ash.db：新旧版 app 都认它（认不得 navi.db 的旧版只认它）；
#    接力身份、访问密钥这些跟着库名走的文件一并换回旧名，不然旧版会当成一台新机器
mkdir -p rolled-back && mv navi.db navi.db-wal navi.db-shm ash.db ash.db-wal ash.db-shm rolled-back/ 2>/dev/null
for f in navi.db.*; do case "$f" in *.lock|*-online.*) ;; *) mv "$f" "ash.db${f#navi.db}";; esac; done 2>/dev/null
cp backups/<那一份>.db ash.db
# 4. 打开旧版 app
```

旧版 app 会在下一次定时检查时又提示装新版：点「跳过这个版本」（勾过自动安装的，先 `defaults write dev.navi.mac SUAutomaticallyUpdate -bool NO` 再打开旧版）。回退到改名前的 Ash.app 不在这条路上：那是另一个 app，见「从 Ash.app 升级」。

## 发版

日常发布只需要在仓库根目录执行：

```bash
npm run release:mac -- 0.3.2
```

本地工作区干净、当前分支为 `main` 时，命令先检查版本和 GitHub 工作流，再核对远端是否领先：不自动合并、不强推。随后只修改 `build.sh` 的 `VERSION`、单独提交版本号、正常 push，再将完整源码 SHA 和版本号交给 GitHub Actions。其他开发改动由开发者事先整理提交。命令输出任务地址后即可关电脑，云端独立完成构建和发布。

版本提交或 push 已成功但触发失败时，重新执行同一命令不会重复提交版本号；同一源码和版本的任务正在运行时返回已有任务，失败时重跑原任务，已经成功时返回结果。只构建的演练与真正发布分别识别，不会把演练当成已发布。

### 一次性配置

1. 将 `.github/workflows/release-mac.yml` 合入 GitHub 的 `main`，启用 Actions。
2. 在 `noroot777/navi → Settings → Secrets and variables → Actions` 添加两项 Repository secrets：

| 名称 | 内容与权限 |
|---|---|
| `MAC_RELEASE_TOKEN` | fine-grained PAT，仅选择 `navi`、`materials`，Contents: Read and write；传包、更新 appcast 和 Mac 下载页共用这一张。内置 `GITHUB_TOKEN` 不能替代跨仓库写权限。 |
| `MAC_SPARKLE_PRIVATE_KEY` | 现有 Sparkle 私钥备份文件里的 base64 文本；沿用现有钥匙，不生成新公钥。 |

3. 本地准备有 `navi` Actions 读写权限的凭证。查找顺序为 `GH_TOKEN` / `GITHUB_TOKEN` → `gh auth token` → git 的 github.com 凭证，不强制安装 gh。git push 仍使用本地已有的 Git 凭证。
4. 在 Actions 的 **Release Mac → Run workflow** 选 main，填源码中的版本及完整提交 SHA，先关闭 `publish` 做云端构建演练。打开 `publish` 才会使用发布 Secret。

签名私钥目前在登录钥匙串的 `dev.navi.mac` 下；改名前的条目为 `dev.ash.mac`，本机备用脚本仍支持它。可从已有密码管理器备份取出，或使用已经下载的 Sparkle 工具导出：

```bash
umask 077
desktop/macos/build/cache/Sparkle-*/bin/generate_keys --account dev.navi.mac -x <临时备份文件>
```

将文件内容放进 Secret 后删除临时文件，并保留密码管理器中的离线备份。私钥不进仓库或日志；云端只在签名步骤写入权限为 0600 的临时文件，退出及失败时删除，不进入产物、缓存或子进程环境。公钥仍是 `release.json` 中已有的那一把，换公钥会使已安装应用失去更新能力。

### 云端与恢复

同一条发布命令触发双架构工作流：Apple 芯片用标准 `macos-15` runner，Intel 用标准 `macos-15-intel` runner。从指定的完整 SHA 构建，只接受 main 上的源码及与源码一致的版本，不因普通 push 或 PR 自动发布。两路各自在对应架构运行 sqlite、终端和隔离服务健康检查，校验 app/Node/原生模块的 Mach-O 架构并保存恢复产物；两路构建都成功才进入串行发布。构建号基于工作流创建时间和各自更新源分配，始终比已有构建号大；不取消进行中的发布。

Apple 芯片使用 `navi/mac/appcast.xml`、`navi-mac-v0.3.3` tag 和 `Navi-0.3.3.dmg`；Intel 使用 `navi/mac/appcast-intel.xml`、`navi-mac-intel-v0.3.3` tag 和 `Navi-0.3.3-intel.dmg`（以 0.3.3 为例）。两者包标识和 EdDSA 公钥相同，但包内更新源不同，自动更新不会混用架构；旧 Ash 通知源只由 Apple 芯片发布更新。固定下载页同时保留两路已发布包，版本暂不一致时分别标明版本，不展示未发布的 Intel 包。不需要新增 Secret。

「关于 Navi」、更新提示标题、Release 标题、固定下载页标题以及新发布的 tag、安装包文件名和下载 URL 都只带 `0.3.3` 这样的版本号，不附带日期构建号。内部 `CFBundleVersion`、`sparkle:version` 和恢复清单仍保留构建号，用于更新比较和精确恢复。同一版本号不能换构建重新发布，要发不同的包就提高版本号；恢复原包补收尾不受影响。已经发布的旧 tag、安装包及链接保持原样，脚本兼容旧命名的更新源和恢复产物，不迁移或覆盖历史包。

构建和安装依赖时没有发布凭证。原始 app、dmg、内容摘要、架构和构建号在对外发布前封进各自的恢复产物 `mac-release-<run id>-arm64|x64`，保留一天；tar 保留软链及可执行位。重跑优先恢复对应架构的原包，不换构建号、不重封同号 dmg。原产物已过期或缺失且已有对应 Release 时停止，改发新版本，不覆盖历史包。一次发布有一部分成功时，成功的包不撤回，失败部分靠同一工作流重跑补齐；固定页保留另一架构的现有下载。Actions 中显示的失败阶段就是恢复入口。

首次构建从公开 raw 地址读取更新源，不占用共享 runner IP 的匿名 REST API 配额；短暂网络错误、限流和服务端错误最多重试三次。恢复已保存的原包时不再读取更新源或分配新构建号，发布前仍用发布凭证核对正式更新源。遇到只剩部分架构发布失败时，原工作流的「Re-run failed jobs」沿用原包补齐，不需要改版本或重新触发一条工作流。

随后沿用原有事务：核对私钥与 app 公钥、更新源、源码提交及 tag → 草稿 Release → 上传 dmg → 经 API 下回校验 → 公开且核对 tag → 从公开地址下回校验 → 签名并提交主 appcast → 签名并提交旧 Ash 的通知 appcast → 更新 Mac 固定下载页。清单提交带原文件 SHA，冲突时拒绝覆盖。包公开后不撤回，重跑只补缺失步骤；固定下载页失败也算发布失败。raw.githubusercontent 的几分钟缓存可能延后客户端看到更新。

README 只链接 `navi-mac-latest` 这个 Mac 专用 Release 页面。页面正文链接到最新成功版本的不可变 dmg，不重复上传附件，不移动历史 tag；入口自己的 tag 不跟着版本移动，也不占用整个仓库的 latest 标记。初始化入口可执行 `node desktop/macos/scripts/init-download-page.mjs --check` 验证现有公开包的地址、大小与 EdDSA 签名；去掉 `--check` 才创建或更新入口。发版不再改写、提交 README。

当前公开仓库使用标准 GitHub-hosted macOS runner，构建计算免费；大规格 runner 与超额 artifact/cache 存储另计。此工作流不使用大规格机器或依赖缓存，恢复产物只留一天，账户的存储和超额付费设置仍需单独核对。这里没有加入 Apple Developer ID 签名或公证，首次打开提示与原版相同。

### 本机备用

```bash
npm run release:mac:local
npm run release:mac:local -- --app <Navi.app> --notes '更新说明'
npm run release:mac:local -- --keys
```

本机模式继续使用钥匙串，适合本地演练和紧急发布。`--keys` 在已有条目时只读取并核对公钥；换电脑时先导回原密钥，避免新建。`--init-repo` 仍可初始化配置中不存在的公开仓库。正式发版会当场证明同一张凭证对两个仓库都能写，清单分支有保护或要 PR 的规则时拒发。

### 本地演练

不碰 GitHub、不碰日常那一份 app：换一个 bundle id（defaults、数据根、登录项都跟着分开）、本机 http 托 appcast，造一旧一新两版：

```bash
export NAVI_MAC_BUNDLE_ID=dev.navi.mac.rehearsal NAVI_MAC_SKIP_BUILD=1 \
       NAVI_MAC_FEED_URL=http://127.0.0.1:8765/appcast.xml NAVI_MAC_ED_PUBLIC_KEY=<演练公钥>
NAVI_MAC_BUILD_NUMBER=20000101.0001 bash desktop/macos/build.sh && ditto desktop/macos/build/Navi.app /tmp/r/Navi.app
NAVI_MAC_BUILD_NUMBER=20000101.0002 bash desktop/macos/build.sh
npm run release:mac:local -- --local /tmp/r/feed --app desktop/macos/build/Navi.app --ed-key-file <演练私钥文件>
(cd /tmp/r/feed && python3 -m http.server 8765 --bind 127.0.0.1) &
defaults write dev.navi.mac.rehearsal NaviURL http://127.0.0.1:14977
defaults write dev.navi.mac.rehearsal NaviDataDir /tmp/r/data
defaults write dev.navi.mac.rehearsal HostMcpSetupDone -array /tmp/r/data   # 别替本机 CLI 写 MCP 登记
open /tmp/r/Navi.app                                                         # 菜单「检查更新…」
```

演练出来的 `/tmp/r/feed` 里是 dmg 和 appcast，和正式发版传上去的是同一种东西。演练私钥是 base64 的 32 字节 ed25519 种子（`generate_keys -x` 导出的就是这个格式）。演练完删掉 `dev.navi.mac.rehearsal` 的 defaults 和 `~/Library/{Caches,HTTPStorages,WebKit}/dev.navi.mac.rehearsal`。

## 从 Ash.app 升级

改名之前装的是 `Ash.app`（包标识 `dev.ash.mac`）。Navi 换了包标识（`dev.navi.mac`），macOS 把它当成另一个 app，而 Sparkle 只肯装包标识相同的更新包（实测：包名、包标识都换了的 dmg，旧版下载、验签之后报「No suitable install is found」拒装），所以**旧版没法自己更新过来**，要手动装一次：

1. 旧版的「检查更新…」会提示有新版（改名前那份 appcast 里是一条「仅通知」的条目），点「了解更多」打开下载页；或者直接从仓库首页下载 dmg。
2. 把 dmg 里的 `Navi.app` 拖进「应用程序」，打开一次（第一次被系统拦下的处理同首页）。
3. 不用先退出 Ash，也不用停服务：Navi 第一次打开时自己做下面这些（`Sources/LegacyIdentity.swift`）。Ash 要是不肯退（正弹着「等任务跑完再装更新」之类的对话框），Navi 不开窗口、先弹窗说明，让你选「重试」「不接了，直接打开」或「退出」。

| 旧的 | 新的 | 怎么接 | 接不了的后果 |
|---|---|---|---|
| defaults 域 `dev.ash.mac` | `dev.navi.mac` | 每一项抄过来（新域已有的不盖）；`AshURL` / `AshDataDir` / 窗口位置 `NSWindow Frame AshMainWindow` 换成 `NaviURL` / `NaviDataDir` / `…NaviMainWindow`；只抄一次 | — |
| 数据根 `~/Library/Application Support/dev.ash.mac/` | 原地继续用 | 新的那块地还不存在、旧的在，就一直用旧的（记在 defaults 里，之后哪个组件建出了新目录也不会换成空数据根）。不搬：数据根的路径决定窗口专用端口，端口一变页面的源就变，页面存在本机的设置全丢 | 目录名里还是 `dev.ash.mac`。要挪得自己动手：退出 Navi、停服务、`mv` 目录、`defaults write dev.navi.mac NaviDataDir <新目录>`，代价是窗口里页面本地的设置（主题、草稿、布局）回到默认 |
| WebKit 网站数据 `~/Library/WebKit/dev.ash.mac`、cookie `~/Library/HTTPStorages/dev.ash.mac{,.binarycookies}` | `…/dev.navi.mac` | 等旧窗口退了，在第一个窗口建出来之前整份复制（复制不挪，旧的留着）；每一项先拷到本进程自己的暂存位置再一次放上去，整次接班在一把跨进程的锁里做（同时开着两份 Navi 时只有一份在复制，另一份等它接完；等满 30 秒还没接完就弹窗说明，可以重试、不接或退出；那一份还拿着锁时点「不接」也不开窗口，等它放手才算数），放上去的一定是完整的一份。**没接完之前不开窗口**：窗口一开，WebKit 就在新身份下建出自己那份，之后再也分不清、接不回来 | 旧窗口不肯退、复制失败（比如盘满了）时弹窗说清原因：腾出地方或退掉 Ash 后点「重试」；点「不接了，直接打开」就按全新的样子开（登录、主题、草稿回到默认），之后不再接 |
| 登录项 `~/Library/LaunchAgents/dev.ash.server.plist`（跑 `Ash.app/…/Ash --start-server`） | `dev.navi.server.plist`（跑 `Navi.app/…/Navi --start-server`） | 原来开着就先装好新的、确认生效，再卸旧的；原来关着的保持关着 | 新的装不上时旧的原样留着，**旧包也不让位**（旧登录项写死的是 `MacOS/Ash`，让位后留下的软链那头只有 `MacOS/Navi`），登录时照样用旧包起服务；后台每 15 秒再换一次。换上之后、或者你在菜单里开关过一次，后台就只剩清理旧的，**不会再替你打开**；菜单里关掉时旧的一起卸掉，删不掉会弹窗说明 |
| 正在跑的旧窗口 | — | 请它退出（最多等 8 秒） | 没退的（比如它正弹着对话框）：网页数据先不接（见上），旧包先不动，隔 15 秒再试 |
| 旧版起的服务（在 :4317、同一个数据根上） | Navi 自带的服务 | 认成「旧版 app 起的服务」，走装更新那道闸换掉（会打断任务就先问你，见「装之前那道闸」），换之前备份库 | — |
| `/Applications/Ash.app`（或 `~/Applications/`、别处 LaunchServices 认得的） | 废纸篓里；原位置是一个指向 `Navi.app` 的软链 | 等旧登录项换成了 Navi 的、旧服务、旧版拉起的 MCP 和别的进程都不在用它的代码了才挪，判据与 `install-app.sh` 同一份（包里的代码锁拿排他锁一直拿到挪完，再用随 app 带着的 `bundle-users.sh` 按真实文件身份扫一遍；挪进废纸篓后再扫一遍）；还有人在用就挪回原处、隔 15 秒再试。原位置放软链失败也挪回原处，下次打开 Navi 再来 | 软链留着是为了让 CLI 的 MCP 登记、脚本里写死的 `Ash.app/Contents/Resources/app/…` 路径照样走得通（MCP 登记按真实路径比，指着软链的登记算「指向这个 app」）；确认没东西再指着它可以删 |

系统层面绕不过去的：

- **隐私权限要重新给**：macOS 按包标识记权限（辅助功能、完全磁盘访问、自动化、文件夹访问……）。给过 Ash 的，Navi 第一次用到时会重新问；「系统设置 → 隐私与安全性」里 Ash 那几条要自己删。
- **第一次打开要再过一次 Gatekeeper**（没经公证，同首页的处理）。
- 「应用程序」里会多一个叫 Navi 的替身（软链），见上表最后一行。
- Dock 里固定的 Ash 图标会跟着旧包进废纸篓（或者失效）：从 Dock 移掉、重新把 Navi 拖上去。**别从废纸篓或那个旧图标打开 Ash**：旧版会把 Navi 的服务当成「旧版 app 起的」换成它自己的、用旧代码跑在已经被新版迁移过的库上；真要退回旧版按「更新前的库备份、回到旧版」那一节走。
- 钥匙串、通知、登录时打开（「通用 → 登录项」里那一栏）这几样 Navi 没有用过，不涉及；登录时起服务走的是上表的 LaunchAgent。

## 第一次打开

数据根里还没有库（`navi.db`，或改名之前的 `ash.db`，见 `docs/rename-db.md`）时，窗口开成一扇 980×660 的小窗（不是 1440 的大窗正中摆几行字），先问数据从哪来（`FirstRunView`：左边一栏是 Navi 和首次配置要走的几站，右边是两个选项；选了之后原地转圈直到页面接上，不换屏、不闪白）。原生那一屏只交给表了态的页面（报了窗口大小 = 画出了第一屏或报错屏），主文档载完不算数；页面脚本没载成、或者久等不到表态，就换成一屏说明，给「重试」和「仍然显示页面」，不放出一整块空白。随后 web 的三步向导也在这扇小窗里、铺满整窗，用同一套两栏版式（左栏原地不动），每一站都能跳过；页面说进了工作台才展开成工作窗。窗口大小由页面表态：`<html data-window-size="setup|work">`（`web/src/auth/AuthGate.tsx` 写，`WindowChrome` 转告）——数据已有、向导上次没走完时也会缩回小窗。首次配置期间不记窗口位置，工作窗照旧按上次拖成的样子打开。


- **全新开始**：起一份空的，进入首启向导（供应商 → 执行器 → 项目）。
- **导入已有数据…**：选一份 Navi 数据目录（比如仓库的 `data/`）。**只复制、不移动**，源目录一个文件都不多。库走 SQLite 在线备份（一致快照，源库正被另一份 server 写着也安全；它还开着时会先提醒），其余目录按文件复制（同一 APFS 卷上是克隆，不占第二份空间）；锁、在线标记、`deps/`、`tmp/`、源的 `logs/` 不搬。多人模式的数据、和 app 数据根互相包含的目录不能导。
  - **导入不是重启**：发布前用自带 node 跑一遍 server 的 `import-snapshot`。副本里不留任何认得出源实例进程的线索（pid、启动时刻、进程记号、没收干净的清理责任），在跑或排队的任务落「暂停」，在盯的哨兵、在跑的验收前置命令、进行中的审查落「结束/被打断」，定时任务停用（定义留着）、没发出的消息取消、队列推进作废 —— 否则副本开机会去接管、甚至停掉源实例正在跑的 agent，或在同一个仓库里再起一份。审查链另有一套不认 pid、认「任务还停在那个方向上」的执行权限：每个任务的方向世代推进一格，导入前记下的方向身份一律作废；收尾计划落成已了结、待补的结算不再补、续审/派审/修复投递的凭据全部撤掉 —— 否则副本开机会替源实例重投修复、推后续站、清合并审查的工作区。停下了哪些，导入完弹窗说一声。同一趟把库里落在源数据根下的绝对路径（会话输出、哨兵日志、附件、证据目录……）逐字改到 app 的数据根（数据根路径里带 `$&` 之类也照原样写），源数据根以外的路径一个字不动。
  - 和起服务**同一把锁**：先在数据根里一个只属于这一次的暂存目录备齐、洗好，再拿锁发布；锁里重查数据根还空着（另一个窗口或登录项可能刚点了「全新开始」，那时这次导入作罢、那份数据不碰）。数据根里有认不出来的东西也拒绝。库最后落，是提交点；挪到一半的条目记在清单里，下次导入先收掉。

连上自己那份之后，app 替本机装了的 CLI 接 Navi MCP（`POST /api/ash-mcp/host-setup`，同注册执行器那一下：缺了才写、已有登记一律不覆盖），写进去的是 app 自带的 node 和 `mcp/dist`。已有登记**指向别处**的（比如仓库的 `mcp/dist`）不替你改，弹窗列出现在指向哪、改成什么，改不改你定；没接上的（macOS 上 codex 那一家 Navi 不替你写）给出手工加的那一段。每个数据根自动查一次，之后从菜单「检查 Navi MCP 登记…」随时再查。

## 验证用的口子

不碰日常那一份：把 app 拷到任何地方，用临时数据根和临时端口直接跑可执行文件——

```bash
NAVI_URL=http://127.0.0.1:14977 NAVI_DATA_DIR=/tmp/navi-try HOME=/tmp/navi-home \
  /path/to/Navi.app/Contents/MacOS/Navi                 # 带窗口
  /path/to/Navi.app/Contents/MacOS/Navi --start-server  # 不带窗口
```

也可以 `defaults write dev.navi.mac NaviDataDir <目录>` 换数据根、`defaults write dev.navi.mac NaviURL http://192.168.1.187:4317` 连别的 Navi（非本机地址不替它起服务，也不做身份判断）。

定点回归（仅 macOS）：`node scripts/test-macos-update.mjs` 覆盖装之前那道闸（不会打断就不问；会打断先问、等到排空自己装、现在装；问不出来按会打断；等的时候一次 503 / 不应答不放行；只停评估过的那个进程；另一处在起服务时不停；维护标记跨进程生效、持有者没了作废；停不下来不装也不备份；别的 Navi 不碰；退出那一档和它备份失败时的说法；Sparkle 放弃后闸收回、重试再备份；起服务前补备份、没有服务记录时连着起不来也留住迁移前的原件、起它的启动器没等到时由之后看到它应答的那一处确认、下一版不拿上一次的底顶替、确认后旧恢复点作废；旧版服务识别）、库备份（WAL 里的写入、确认前不轮换、确认后只留 5 份、同一秒不覆盖且按生成先后认新旧）。`npm run test:release:mac` 覆盖本地触发入口、main/脏工作区/版本与权限预检、正常推送和冲突拒绝、重复触发与失败重跑；恢复产物的 app 软链/可执行位、原始 dmg 与构建号、篡改和过期拒绝、签名私钥隔离清理；Mac 固定下载页的验签初始化、不占全局 latest、失败补齐与不倒退；原发布脚本的真假 GitHub 双仓库预检、草稿上传/下回核对/公开/签名清单及旧版 Ash 通知。`node scripts/test-macos-sparkle-dmg.mjs` 用真的 Sparkle（`Tests/SparkleDmg` 编的空壳 app，更新配置同 build.sh）走一遍：dmg 被改一个字节 → 下载了但挂载前验签不过、不装；appcast 被改 → 连 dmg 都不下；都对 → 装上新版并由 Sparkle 重开。`node scripts/test-macos-client.mjs` 用真的 NaviConfig / NaviHealth / ServerLauncher / DataImport / BrowserWindowController 加一份假的自带运行时，覆盖下载事务、红绿灯下的页面、「端口上是谁」的判据（数据根 + 自带代码 + 本机模式）、窗口只连专用端口、在线后换人（自己那份停了、不认实例号的旧版 Navi 接手 4317，页面持续写请求，一条都到不了 4317；导航与定时两道撤页；自家服务重起后换上新实例号）、空数据根不起、起服务的环境（终端配置盖不掉）、占用提示、并发只起一份、锁超时、请求合并、起来就退、PID 核对、启动器报错、运行时缺件、构建号、安装（别名目录、带正则字符的目录、相对路径起的包内可执行文件、包外软链起的入口靠它拿着的锁认出、最后检查之后改名之前起来的入口等在锁上并读到整份新包、锁文件缺了不启动不安装、两个安装器并发）、导入（WAL 里的写入、命名管道跳过而链接照原样复制、暂存里洗过再发布、和起服务互斥、失败与抢跑不留痕迹、残留清单、停掉的源、互相包含、多人库拒绝）。server 那一半：`npm -w server run test:host-navi-mcp`（MCP 登记归类）、`npm -w server run test:import-snapshot`（导入不是重启：真的接管入口对着洗过的库认不出活着的源进程；同一串开机对账对着没洗/洗过的副本各跑一遍，前者替源实例重投修复、后者一行不动；路径逐字重定位）、`npm -w server run test:instance-binding`（真服务：带着别人实例号的写请求、页面、预览与预览 WebSocket 一律 409 且不执行，health 照答；窗口专用端口上同一套判据，被占着时 health 报 null、服务照常起）。

## 窗口

内容铺到窗口顶，红绿灯浮在页面左上角，不单占一行标题栏（首次配置时窗口开多大见「第一次打开」）。页面要给它让位，所以是页面先表态：`web/index.html` 里有 `<meta name="navi-window-chrome" content="overlay">`（改名前的页面写的是 `ash-window-chrome`，也认）才铺上去，没有这一行的文档（更早版本的 Navi、同源的其它页面）仍是普通标题栏。壳把红绿灯的实际高宽量出来交给页面（`--window-titlebar-height` / `--window-controls-width`，全屏时为 0），页面这一半在 `web/src/styles/window-shell.css`：主工作区和设置页把那一条用起来，其它整页布局默认让开。顶上那一条的空白处、以及页面用 `--window-drag: drag` 划进来的顶栏都能拖窗口，双击跟随系统设置。

`NaviWebView` 通过 `acceptsFirstMouse` 让后台窗口同时激活和点击。2026-11-21 用户在独立诊断窗口复现了从任务切到新建后，智能体、工作目录和任务列表首击失灵：原生日志是按下→松开，前台、当前窗口、微信输入法和输入框焦点均在，页面却收到松开→按下且没有 click；第二下正常。修复只对各鼠标按键的按下、拖动、松开先用 AppKit 公开的同步 `handleEvent` 取得输入法处理结果，未消费的事件按原生到达顺序交给 WebKit，转发期间避免二次异步处理。键盘、鼠标移动、移入和移出仍走 WebKit 原链路。同步调用仍依赖输入法及时返回；后台确定性探针只验证分发契约，不代表前台真实输入法覆盖。

需要抓取实际故障时，`node desktop/macos/scripts/trace-clicks.mjs` 会根据已安装应用的源码提交，编译并打开独立的「Navi 点击诊断」窗口，连接现有本机服务，不安装应用、不启动或替换服务。诊断构建关闭自动更新、旧身份迁移、登录项整理、MCP 配置检查和遗留下载清理；服务离线时只显示失败，不自行恢复。默认保留已安装版本的输入处理；`--candidate-input` 仅替换为当前工作区的 `NaviWebView`，日志记下源码哈希，其余窗口和页面保持已安装版本。只附加事件观察，记录原生鼠标按下/松开、页面 pointer/mouse/click、目标节点身份及是否脱离 DOM、点击后的路由；不记录输入内容、任务标题或页面正文。日志在命令输出的临时目录 `events.jsonl` 中，最多记录 10000 行，退出该诊断应用即可停止。`--prepare-only` 只构建不打开。诊断窗口使用独立的网页数据仓，不复制当前窗口的草稿或登录态。这是取证工具，不是首击故障已修复的证明。

导出下载先写目标目录内的独立临时文件，完成后再原子替换目标文件。下载失败或在完成前退出不会删除已有文件。每笔下载在 app 那块地（`~/Library/Application Support/dev.navi.mac`，升级上来的是 `dev.ash.mac`）的 `downloads` 下留一张带锁的登记；app 被强杀或断电留下的隐藏暂存目录（目标文件夹里的 `.ash-download-…`）下次启动时照登记回收，仍在写的下载持着锁、不会被碰。

## 文件

| 文件 | 管什么 |
|---|---|
| `scripts/bundle-runtime.mjs` | 把 node、产物、生产依赖装进 app |
| `scripts/build-number.mjs` | 严格递增的 CFBundleVersion |
| `scripts/install-app.sh` | 换进安装目录（按目录加锁）；旧包还有进程在用就不换 |
| `scripts/bundle-users.sh` | 还有哪些进程在用某个 .app（按真实文件身份认） |
| `Sources/NaviConfig.swift` | 连哪台、自带运行时在哪、数据和日志放哪 |
| `Sources/NaviWebView.swift` | 后台首击；鼠标按键手势按序交给输入法与 WebKit |
| `Sources/LegacyIdentity.swift` | 改名前的 Ash.app 怎么交班：设置、网页数据、登录项接过来，旧包让位 |
| `Sources/NaviHealth.swift` | 「端口上是谁」的唯一判据（数据根、自带代码、app 标记、窗口专用端口） |
| `Sources/ServerLauncher.swift` | 起自带的服务；端口被占时说清是谁 |
| `Sources/RemoteAccessSwitch.swift` | 「允许其他设备访问」：改设置、按新设置重启服务 |
| `Sources/DeepLink.swift` | `navi://open?project=&task=`：拉起窗口、打开任务 |
| `Sources/ServerStartLock.swift` | 同一数据根同时只有一处在起服务 |
| `Sources/LaunchFlow.swift` | 窗口回到 Navi 的那条路，首启的全新开始 / 导入 |
| `Sources/DataImport.swift` | 导入旧数据：暂存、洗副本（`server/src/import-snapshot.ts`）、持锁发布 |
| `Sources/HostMcpSetup.swift` | 替本机 CLI 接 Navi MCP、把指向别处的摆给用户 |
| `Sources/LoginService.swift` | 登录时启动的 LaunchAgent |
| `Sources/Updater.swift` | 接 Sparkle：三条安装路径都交给 UpdateGate |
| `Sources/UpdateGate.swift` | 装之前那道闸：问会打断谁、等或现在、停服务、备份 |
| `Sources/RestartImpact.swift` | 读 `/api/restart-impact`，算出会打断哪几个 |
| `Sources/ServerControl.swift` | 记下哪一版起的服务；只让评估过的那份下线；维护期标记（跨进程不许起服务） |
| `Sources/DatabaseBackup.swift` | SQLite 一致快照；更新前备份、恢复点与保留 |
| `scripts/sparkle.mjs` | 取固定版本的 Sparkle（框架 + 签名工具） |
| `scripts/release.mjs`、`appcast.mjs`、`github.mjs` | 发版、appcast 读写、GitHub API |
| `scripts/cloud-release.mjs`、`cloud-workflow.mjs` | 本地提交版本并触发 Actions、云端构建与原包恢复 |
| `scripts/release-channel.mjs`、`init-download-page.mjs` | Mac 专用固定下载页与现有版本入口初始化 |
| `scripts/release-artifacts.mjs`、`release-state.mjs` | app/dmg 身份、版本号及发布状态 |
| `scripts/make-dmg.sh` | 封 dmg（下载安装和 Sparkle 更新同一个） |
| `scripts/make-dmg-layout.py`、`dmg/DS_Store` | dmg 打开时那扇拖拽安装窗口的 Finder 布局 |
| `release.json` | 装包仓库、清单仓库与 appcast 路径、tag 前缀、钥匙串条目名、EdDSA 公钥 |
| `Sources/AppDelegate.swift` | 生命周期与菜单（⌘C/⌘V 靠编辑菜单分发，不能省） |
| `Sources/BrowserWindowController.swift` | 窗口、WKWebView、探活、页面在时认人、菜单动作 |
| `Sources/WindowChrome.swift` | 内容铺到窗口顶：量红绿灯、和页面的约定、拖窗口 |
| `Sources/WebViewBridge.swift` | 外链、新窗口、选文件、下载、JS 对话框 |
| `Sources/DownloadTransaction.swift` | 另存为的暂存、原子替换与中断后的回收 |
| `Sources/OfflineView.swift` | 页面载不进来时的那一屏 |
| `Sources/FirstRunView.swift` | 首启那一屏：全新开始 / 导入已有数据 |
| `Sources/NaviPalette.swift` | 原生几屏的颜色，取自 web 的浅 / 深两套令牌 |
| `scripts/make-icon.swift` | 构建时把 `docs/logo/icon.svg` 栅格成图标 |

卸载：菜单里先取消「登录时启动 Navi 服务」，停掉服务，再删 /Applications/Navi.app（升级上来的机器上还有一个指向它的 `Ash.app` 替身，一起删）；数据在 `~/Library/Application Support/dev.navi.mac/`（升级上来的是 `dev.ash.mac/`）。页面检查器：Safari →「开发」→ 本机 → Navi。
