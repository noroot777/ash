# Navi for macOS

装在「应用程序」里的一整份 Navi：自带 node 和 server/web/mcp，数据放在 `~/Library/Application Support/dev.navi.mac/`（从 Ash.app 升级上来的机器上还是原来的 `dev.ash.mac/`，见「从 Ash.app 升级」），打开就能用。不依赖仓库检出，也不依赖系统里有没有 node。个人自用：服务以本机自用模式运行（只听 127.0.0.1，没有多人、配对和邀请）。

```bash
npm run install:mac                     # 构建并装进 /Applications，然后打开
npm run build:mac                       # 只构建 → desktop/macos/build/Navi.app
bash desktop/macos/build.sh --dmg       # 另出一份拖拽安装的 build/Navi.dmg（与发版同一个格式）
```

构建要 Xcode 命令行工具（`swiftc`、编 node-pty 的 clang）和本机的 node/npm，只在 Apple 芯片的 Mac 上出包。最低 macOS 14，ad-hoc 签名。

## 包里有什么

`scripts/bundle-runtime.mjs` 把下面这些装进 `Contents/Resources/app`（布局与仓库同形）：

- `node/bin/node`：固定版本的 node（版本与 sha256 写死在脚本顶部，下载后校验，对不上就不用）；
- `shared`、`server/dist`、`mcp/dist`、`web/dist`：先跑一遍 `npm run build`（`ASH_MAC_SKIP_BUILD=1` 跳过）；
- `node_modules`：server 与 mcp 的生产依赖，用自带 node 装，node-pty 按它重编。

下载的 node 和装好的依赖缓存在 `build/cache/`，lockfile、各 workspace 的 package.json 或 node 版本变了才重装。

版本：`CFBundleShortVersionString` 是给人看的（`build.sh` 里的 `VERSION`）；`CFBundleVersion` 严格递增：样子是 UTC `日期.时分秒`，但每次构建都要比账本里上一个号大，不比它大（同一秒、从旧提交重打、时钟回拨）就在它上面加一，并发构建按锁排队（`scripts/build-number.mjs`）。账本是仓库 git 公共目录下的 `navi-mac-build-number`，各个 worktree 共用（改名前叫 `ash-mac-build-number`：发号时在锁里把它当底读一下，只读不写，号从它往上接着发。反过来不成立：从改名前的旧提交构建，用的还是旧账本和旧锁，可能跟新版发出同一个号 —— 那是 Ash.app，包标识和更新源都跟 Navi 分开，互不影响）。

## 服务怎么起

- 打开 app 先探 `/api/health`。端口上是**自己那份**才载页面：health 报的数据根是 app 的数据根、代码目录是 app 自带的那份、开着本机自用模式，三样都对上（`AshHealth.swift`，只看数据根的话仓库里指着同一份数据的开发实例也会被认成自己）。没人就用自带 node 起自带 server，带 `ASH_DATA_DIR=<数据根>`、`ASH_LOCAL_ONLY=1`。环境取自交互式登录 shell（`zsh -ilc`），claude、codex 这些 CLI 的 PATH、LANG 与终端里一致；数据根、端口、本机模式写成命令里的字面量、由 `env` 在 exec 那一下落定，终端配置里给开发实例 export 的同名变量盖不掉它们。node 不从 PATH 找。
- 窗口不连 4317，连这份服务**专用的端口**：app 按数据根的真实路径算出一个固定端口（42000–47999，`AshConfig.windowPort`；`ASH_MAC_WINDOW_PORT` 可指定），起服务时用 `ASH_WINDOW_PORT` 交给它，服务在 4317 之外再监听这个端口（只听 127.0.0.1），health 里报出来（`server/src/window-port.ts`）；health 报的专用端口对不上（没监听上、或者不是这一版 app 起的）也不算自己那份。4317 照旧给浏览器、CLI 和 MCP 用，「在浏览器中打开」换回 4317 的地址。这样自己那份一停，窗口的端口就空着：别的 Navi 默认只会去占 4317，撤页之前页面还在发的请求连不上任何人。**剩余风险（用户 2026-11-14 选择接受）**：专用端口只是一个普通的本机端口，不归这份服务独占。有人特意把一份旧版 Navi（不认实例号）用 `PORT` 起在这个端口上，而且恰好赶在窗口撤页之前那一两秒，页面在那一下发出的请求仍会被它执行；新版 Navi 起在这个端口上则会因为实例号对不上而拒收。要彻底堵住得让窗口请求换成旧版接不住的形式（每次起服务都不同的地址前缀，或经 app 转发到只有新版才开的本机连接文件），改动大，没有做。代价：窗口和浏览器是两个来源，主题、草稿这些存在页面本地的设置各管各的。
- 认过人之后，页面发的每个请求（页面本身、fetch、SSE、预览）还都带着那一份服务的实例号（cookie `ash_instance`，原生的补接请求放在请求头里）。实例号每次起服务都换；自家服务原地重起过、或者专用端口上换了一份新版 Navi，见到别人的实例号一律 409、什么都不执行（`server/src/instance-binding.ts`）。
- 页面在的时候也一直认着人：本机地址的刷新、前进后退、页面自己跳转放行前各认一次，页面在时每秒再认一次。窗口的端口上不再是自己那份（比如服务停了）就把整页撤成空白、盖上说明，自己那份回来后回到原来的路由；自己那份重起过（实例号换了）就换上新的重载一遍。这一道管的是提示和撤页，不是请求归属：撤页之前还在路上的请求由上面两条挡下。
- server 进自己的会话，**关窗、退出 app 都不停服务**，也不带走在跑的 agent。app 只负责起，不杀、不守护。
- 端口被**别的 Navi** 占着（比如仓库里 `npm run restart` 起的开发实例）不会连上去，窗口里说清是哪个进程、代码和数据在哪、怎么停；对方一停 app 就接着起自己那份。端口被不是 Navi 的程序占着也一样说明。仓库开发实例以后换端口、用临时库起。
- 「Navi → 登录时启动 Navi 服务」（装进「应用程序」后第一次打开默认勾上）：`~/Library/LaunchAgents/dev.navi.server.plist`，登录时跑一次 `Navi --start-server`，同一套逻辑、不开窗口。数据根还是空的时它不起（首启要先问用户）。
- 日志在**数据根下的 `logs/`**：`server.log`（服务）、`login.log`（登录项），跟着数据走。起不来时占位页上有「日志」按钮。
- 重装 app 不会重启已经在跑的服务，也不会换掉它脚下的代码：`install:mac` 先请窗口退出，再换包（`scripts/install-app.sh`）。换包和进程启动共用一把锁（`shared/src/code-lock.ts`）：跑包里代码的服务、Navi MCP 在读任何业务代码之前，以共享锁拿着包里的 `Contents/Resources/app/.in-use`，一直拿到进程结束；安装器对它拿排他锁，从最后一次检查一直拿到两次改名换完——拿不到就是有人在用，不装、列出是谁；换包那几秒里新起来的进程等在锁上，等到时读到的是一整份新代码。锁在文件本身上，包改名、经软链或相对路径拉起都认得出；进程被强杀内核就放锁，不留死登记；锁文件缺了入口拒绝启动，不会悄悄变成「没人用」。锁管不到的（Navi 本身、别的程序拿包里的可执行文件或脚本跑）另按真实文件身份扫（`scripts/bundle-users.sh`）：可执行文件、映射进来的库、工作目录按 lsof 报的真实路径比，命令行里提到的 .app 逐个按真实路径解析。挑没有任务在跑的时候 `kill` 掉服务（agent 不跟着停），等 MCP 那几个任务这一轮结束，再装一次。同一个安装目录同一时刻只有一个安装在换（按目录真实路径加锁）；新版先拷到旁边再换上，拷失败、最后一步失败时旧的那份放回原处。已经装着的是还没有代码锁的旧版 app 时，那一次只能靠扫描。
- 换了新版 app 而服务还是旧版 app 起的（app 被强杀时 Sparkle 照样装上的那一档、手动换 app）：app 起服务时在数据根里记一笔 pid + 构建号（`.mac-server.json`），新版打开时认得出，走下面「装之前那道闸」把服务换成新版。

## 自更新

用 [Sparkle](https://sparkle-project.org) 2（版本和 sha256 钉在 `scripts/sparkle.mjs`，框架原样放进 `Contents/Frameworks`）。菜单「Navi → 检查更新…」，另外每 6 小时自己查一次。两个公开仓库，都在 `release.json` 里配：

- **安装包**在 [noroot777/navi](https://github.com/noroot777/navi)（`releaseRepo`；GitHub 上要先从 noroot777/ash 改名过来，没改名时发版脚本会拦下、不去新建）：tag 为 `navi-mac-v<版本>-<构建号>` 的 GitHub Release 上的 `Navi-<版本>-<构建号>.dmg`。只出 dmg：新用户下载安装的、Sparkle 更新用的是同一个文件。
- **appcast** 在素材库 [noroot777/materials](https://github.com/noroot777/materials)（`feedRepo`）的 `navi/mac/appcast.xml`，app 的 `SUFeedURL` 是它在 raw.githubusercontent 上的那份；每一版的下载地址指向 noroot777/navi 那个 Release 上的 dmg。改名前的 Ash.app 看的是同一个仓库里的 `ash/mac/appcast.xml`（`legacyAppcastPath`）：每次发版那一份换成一条「仅通知」的条目，见「从 Ash.app 升级」。

**只靠 EdDSA 签名校验**：app 是 ad-hoc 签名，没有能跨版本延续的 Apple 签名身份，而 Sparkle 的规则是「Apple 签名身份和 EdDSA 密钥至少一样不变」。所以 Info.plist 里的 `SUPublicEDKey` **永远不能换**，换了已装的 app 就再也装不上新版。appcast 本身也签（`SURequireSignedFeed`），dmg 先验签再挂载（`SUVerifyUpdateBeforeExtraction`）：被改过的 dmg 或 appcast 一律拒装。公钥由 `build.sh` 从 `release.json` 写进 Info.plist；还没配公钥的构建不带更新源，菜单里也没有「检查更新…」。

dmg 的格式（`scripts/make-dmg.sh`，按 Sparkle 2.10.1 的源码核对过）：UDZO 只读压缩镜像，不带许可协议；卷里是 `Navi.app`、指向 `/Applications` 的软链和 Finder 布局（`dmg/DS_Store`，由 `scripts/make-dmg-layout.py` 生成后入库，出包时不用 Finder）。Sparkle 挂载时跳过软链和隐藏文件、只拷出 app，再按已装那份的文件名（`Navi.app`）或包标识认出新版，所以卷里的名字固定是 `Navi.app`。dmg 不签：Sparkle 对 dmg 的「Apple 签名兜底」只认 Developer ID，ad-hoc 的 app 没有 team，这条兜底永远走不通，验签失败就是拒装。

### 装之前那道闸

装新版 = 重启 app 里的服务。所以不管从哪条路装（点了「安装并重新启动」、勾了自动安装后 Sparkle 悄悄下好、下好了没装就按 ⌘Q），都先过 `UpdateGate`：

1. 问 server 的 `/api/restart-impact`（与 `npm run restart` 的安全闸同一条口径）。`interrupted`（接不回来、会判失败）和 `mcpDisrupted`（活得过重启，但手里握着 Navi MCP，服务换代码那会儿交卷可能失败）都算**会打断**，同一个任务只算一次。会被接管的、调度台会自动接回的不算。只有**确认**没人会被打断才自己往下走：连接被拒（确认没在跑）、端口上是报了别的数据根的 Navi、或者问到了且是空的；服务一时没答复、回了 503、没报身份、restart-impact 问不出来，都是「确认不了」，按会打断对待。
2. 不会打断任何任务 → 直接装。会打断 → 弹窗列出是哪几个、为什么，选「等它们跑完再装」或「现在装」（退出那一档多一个「取消」）。选了等，每 5 秒再问一次，确认排空了才自己装（中途一次探活失败只算确认不了，接着等）；等的时候菜单里有「等任务跑完后安装更新…」，点它可以改成现在装。
3. 放行后：攥住启动锁、在数据根里写维护标记（`.mac-maintenance.json`）→ 停掉**评估过的那一份**服务（SIGTERM；在跑的 agent 不随它死，新服务起来按 pid 接管；这会儿端口上换了进程、或者认不出是谁，就不停、从头再评估）→ 备份库 → 交给 Sparkle 换 app、重开 → 新版起新服务。维护标记在的时候，任何入口（这个窗口、登录项的 `--start-server`、另开的一份 app）都不起服务；持有它的进程没了（装完被退掉、崩了）标记就作废。停不下来或备份失败就不装，窗口把服务接回来，菜单里留「安装更新…」可以重试。
4. Sparkle 中途放弃了这次更新（安装出错、取消）：闸里排着的安装、轮询、维护标记全部作废，窗口把服务接回来；再装从头评估、再备份一次。

Sparkle 换包不经过 `install-app.sh` 那把代码锁：服务在闸里先停了；之后还拿着包里代码的只有在跑的 agent 拉起的 Navi MCP，它们所在的任务都算在第 1 步的「会打断」里。选「等它们跑完再装」，换包时就没有人在用旧包；选「现在装」，列出的那几个任务的 MCP 会在新旧代码之间被换掉，可能失败。

**退出那一档的例外**：退出时备份不成（比如盘满了），弹窗给「不退出」和「仍然退出」。Sparkle 没有「撤销退出时安装」的接口，仍然退出就会换上新版 app —— 兜底在新版那头：**起服务之前，库上一次要是交给别的构建号起的（或者没有服务记录、不知道是谁）、这一次又还没备过，先备份并固定成恢复点；备份不成就不起服务、不碰库**（判据见下一节），装回旧版 app 就能回去。这一条同样兜住强杀后的安装、`build.sh --install` 和手动换 app。

已知、接受的剩余窗口：restart-impact 是一次快照，问完到 SIGTERM 之间（几十毫秒）server 仍可能接新任务；撞上的那条任务点一次重试就行，`npm run restart` 一直是这样。服务端不为此做「排空 → 停机」事务（用户 2026-11-14 决定）。

勾了「自动下载并安装」的话，下好之后只要不会打断任务就直接装并重开（窗口会刷新一下）；Navi 常驻不退出，等「退出时装」可能要等好几天。app 被强杀（`kill -9`、崩溃）时 Sparkle 照样会把下好的那份装上，这一刀绕过了闸，由新版打开时的「旧版服务」识别（见「服务怎么起」）和起服务前的补备份兜住。

### 更新前的库备份、回到旧版

server 一启动就做不可逆的迁移，所以闸在停掉服务之后、换 app 之前，用 SQLite 在线备份给库留一份：`<数据根>/backups/<UTC 时间>-<旧构建号>.db`，一个自成一体的文件；同一秒的几份另起名字、不互相覆盖，新旧按生成先后认。每一份更新前备份都先**固定成恢复点**（`backups/recovery-points.json`），直到确认之后有一份服务在这份库上真起来过：

- 「起来过」的判据只有一个：端口上应答的正是数据根里服务记录（`.mac-server.json`）记着的那个进程。起服务之前先记下这一版的构建号（记不下就不起），进程一起来补上 pid；之后**不管是谁先看到它应答**——起它的启动器、重开的 app、登录项、另一个窗口——都在同一处确认，起它的那个中途被退掉、超时了也不要紧。确认时间记进服务记录，比它早的恢复点一律作废（恢复点文件删不掉也一样）。
- 没确认之前，恢复点不参与「只留最近 5 份」的轮换；确认之后回到普通轮换里。
- 起服务前要不要补一份：库上一次交给的就是这一版（它已经在这份库上起过，没成的话起之前已经留过底，这会儿再备就是拿迁移了一半的库去挤原件）、或者有一份恢复点是「留它时库最后交给的版本和现在一样」的（这一次已经备过），就不补；其余都补。上一版起过、哪怕从没被谁看到应答，更早那份底也不会被当成这一次的。

新版起不来时，占位页指的是最近那个恢复点（这一版迁移之前的库）；更早几次没确认起来过的也还留着。回到旧版：

```bash
# （数据根按自己机器上的写：从 Ash.app 升级上来的还是 dev.ash.mac，见「从 Ash.app 升级」）
# 1. 退出 app，停掉服务（数据根里 ash.db.ash.lock 记着 pid）
kill "$(node -p 'require(process.env.HOME + "/Library/Application Support/dev.navi.mac/ash.db.ash.lock").pid')"
# 2. 从 noroot777/navi 的 Releases 里下回备份文件名里那个构建号的 dmg（tag navi-mac-v…-<构建号>），
#    打开后把里面的 Navi（`Navi.app`）拖进 Applications，选「替换」
# 3. 把备份放回去（先把现在这份挪开，别直接覆盖）
cd ~/Library/Application\ Support/dev.navi.mac
mkdir -p rolled-back && mv ash.db ash.db-wal ash.db-shm rolled-back/ 2>/dev/null
cp backups/<那一份>.db ash.db
# 4. 打开旧版 app
```

旧版 app 会在下一次定时检查时又提示装新版：点「跳过这个版本」（勾过自动安装的，先 `defaults write dev.navi.mac SUAutomaticallyUpdate -bool NO` 再打开旧版）。回退到改名前的 Ash.app 不在这条路上：那是另一个 app，见「从 Ash.app 升级」。

## 发版

**签名密钥**（2026-11-14 已生成，公钥已在 `release.json`）：私钥存在这台 Mac 的**登录钥匙串**里，条目名 `dev.navi.mac`（`keychainAccount`；改名前生成的那条叫 `dev.ash.mac`，新名下没有时发版脚本用旧的那条签、并打出挪过去的命令），不进任何仓库。生成时导出过一份备份，**必须放进密码管理器 / 离线介质**。私钥丢了，已经装了 app 的机器就**再也收不到更新**（公钥不能换，见上）。

```bash
npm run release:mac -- --keys        # 钥匙串里已有就沿用、只核对 release.json；没有才新建（换电脑时先导回，别新建）
desktop/macos/build/cache/Sparkle-*/bin/generate_keys --account dev.navi.mac -x <备份文件>   # 再导出一份备份
desktop/macos/build/cache/Sparkle-*/bin/generate_keys --account dev.navi.mac -f <备份文件>   # 换电脑：导回钥匙串
```

发版时 `generate_keys` / `sign_update` 读钥匙串，第一次会弹窗问能不能访问那个钥匙串条目：输登录密码、点「始终允许」。

每发一版：

```bash
npm run release:mac
```

从**干净的提交**构建（构建号由账本发，见上面「版本」）→ 核对 app 里的公钥就是签名私钥的那一把、更新源就是素材库里那份 appcast → 版本号必须比 appcast 里最新的大 → 封 dmg（`scripts/make-dmg.sh`）、`sign_update` 签名 → 在 noroot777/navi 建**草稿** GitHub Release `navi-mac-v<版本>-<构建号>`、传 dmg、经 API 下回来核对（这几步外面都看不见）→ 公开 Release（同时把目标提交写成构建 app 的那个提交，tag 这时按它打出来，公开后再核对一遍；所以**那个提交要先 `git push`**；同名 tag 已经在却指着别的提交就拒发，GitHub 会沿用已有的 tag）→ 从公开地址把包下回来核对 → 再更新 appcast（新的一项在前，旧的原样保留，整份重签）→ 经 GitHub Contents API 提交回素材库（带着读出时的 sha，这期间别处改过就拒，重跑即可；不克隆素材库，宣传片等大文件一个字节都不下；也不碰 noroot777/navi 的 main）。最后把改名前那份 appcast 换成指向这一版下载页的「仅通知」条目（已经是这一版就不动，重跑补得上）。先公开包、确认下得下来才提交 appcast，feed 不会指向一个还不存在的包。公开是单向的：之后哪一步失败（包括公开请求没收到答复）都不撤回，重跑会认出已公开的 Release、沿用上面的包、只补后面的步骤——撤回之前得确认没有哪份 appcast 引用它，而读和撤之间别的发版进程可能刚好提交了 appcast，撤回会让它指向一个下不到的包。中途失败重跑，同一版沿用 `build/releases/` 里上次封好的 dmg —— 只在这次的 app 和封那个 dmg 的是同一份时（dmg 旁边的 `.source` 记着 app 的内容摘要），同一个构建号换了包就拒发；也沿用上次的草稿和传上去的附件（草稿按 tag 名在全部 Release 里翻页找）。appcast 里已经是这个包（签名一样）时，重跑只补后面没做完的：公开 Release、README 链接；补的是旧版的收尾时 README 不动（首页链接只往新版走）。更新说明默认是上一版以来的提交标题，`--notes` 可以换。

最后把仓库根 `README.md`「下载 mac 版」两行标记之间改成这个 dmg 的直链，**只提交 README.md、不推送**（`scripts/download-link.mjs`）：noroot777/navi 以后可能还发别的 Release，`releases/latest` 不一定是 mac 包，所以写死成具体那一版；发完才改、当场提交，下一次发版要求的干净工作区不受影响；推送照常由人来，推上去之前 GitHub 首页还是上一版的链接，那一版装上后会自己更新到最新。README 自己有没提交的改动时不替你改，只打出新链接；README 已经指向更新的一版时不动（按标记里那一行的构建号比，不靠发版开头读到的 appcast）。从写入到提交之间别处（编辑器保存、另一次发版）改过 README 就不提交；提交失败时只有文件还是自己写的那份才写回原文，否则保留现场、只打出新链接。

GitHub 凭证按顺序找：`GH_TOKEN` / `GITHUB_TOKEN` → `gh auth token` → git 存在钥匙串里的 github.com 凭证（`git push` 用的那条）。都没有就报错并说怎么配。传包和提交 appcast 只用这一张，开传之前先确认它对 noroot777/navi 和素材库**都**写得了，缺一个就什么都不传（fine-grained token 要把两个仓库都选上、给 Contents 读写）。「写得了」是当场证明的：仓库信息里的 `permissions.push` 只说明账号的权限，不说明这张 token 的，所以在每个仓库里真写一次——建一个不挂到任何提交上的 blob（和改文件、建 Release 同一项权限，外面看不见、会被回收）；素材库的 `main` 上有分支保护或要 PR 之类的 ruleset 规则，也一样拒发（appcast 是直接提交上去的，证明不了提得上去就当提不上）。`--init-repo` 只在 `release.json` 里的仓库还不存在时才用得上（会建成公开仓库）。raw.githubusercontent 有几分钟缓存，推完稍等已装的 app 才看得到。

### 本地演练

不碰 GitHub、不碰日常那一份 app：换一个 bundle id（defaults、数据根、登录项都跟着分开）、本机 http 托 appcast，造一旧一新两版：

```bash
export ASH_MAC_BUNDLE_ID=dev.navi.mac.rehearsal ASH_MAC_SKIP_BUILD=1 \
       ASH_MAC_FEED_URL=http://127.0.0.1:8765/appcast.xml ASH_MAC_ED_PUBLIC_KEY=<演练公钥>
ASH_MAC_BUILD_NUMBER=20000101.0001 bash desktop/macos/build.sh && ditto desktop/macos/build/Navi.app /tmp/r/Navi.app
ASH_MAC_BUILD_NUMBER=20000101.0002 bash desktop/macos/build.sh
npm run release:mac -- --local /tmp/r/feed --app desktop/macos/build/Navi.app --ed-key-file <演练私钥文件>
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
| WebKit 网站数据 `~/Library/WebKit/dev.ash.mac`、cookie `~/Library/HTTPStorages/dev.ash.mac{,.binarycookies}` | `…/dev.navi.mac` | 等旧窗口退了，在第一个窗口建出来之前整份复制（复制不挪，旧的留着）；每一项先拷到本进程自己的暂存位置再一次放上去，整次接班在一把跨进程的锁里做（同时开着两份 Navi 时只有一份在复制，另一份等它接完），放上去的一定是完整的一份。**没接完之前不开窗口**：窗口一开，WebKit 就在新身份下建出自己那份，之后再也分不清、接不回来 | 旧窗口不肯退、复制失败（比如盘满了）时弹窗说清原因：腾出地方或退掉 Ash 后点「重试」；点「不接了，直接打开」就按全新的样子开（登录、主题、草稿回到默认），之后不再接 |
| 登录项 `~/Library/LaunchAgents/dev.ash.server.plist`（跑 `Ash.app/…/Ash --start-server`） | `dev.navi.server.plist`（跑 `Navi.app/…/Navi --start-server`） | 原来开着就先装好新的、确认生效，再卸旧的；原来关着的保持关着 | 新的装不上时旧的原样留着，**旧包也不让位**（旧登录项写死的是 `MacOS/Ash`，让位后留下的软链那头只有 `MacOS/Navi`），登录时照样用旧包起服务；后台每 15 秒再换一次 |
| 正在跑的旧窗口 | — | 请它退出（最多等 8 秒） | 没退的（比如它正弹着对话框）：网页数据先不接（见上），旧包先不动，隔 15 秒再试 |
| 旧版起的服务（在 :4317、同一个数据根上） | Navi 自带的服务 | 认成「旧版 app 起的服务」，走装更新那道闸换掉（会打断任务就先问你，见「装之前那道闸」），换之前备份库 | — |
| `/Applications/Ash.app`（或 `~/Applications/`、别处 LaunchServices 认得的） | 废纸篓里；原位置是一个指向 `Navi.app` 的软链 | 等旧登录项换成了 Navi 的、旧服务、旧版拉起的 MCP 和别的进程都不在用它的代码了才挪，判据与 `install-app.sh` 同一份（包里的代码锁拿排他锁一直拿到挪完，再用随 app 带着的 `bundle-users.sh` 按真实文件身份扫一遍；挪进废纸篓后再扫一遍）；还有人在用就挪回原处、隔 15 秒再试。原位置放软链失败也挪回原处，下次打开 Navi 再来 | 软链留着是为了让 CLI 的 MCP 登记、脚本里写死的 `Ash.app/Contents/Resources/app/…` 路径照样走得通（MCP 登记按真实路径比，指着软链的登记算「指向这个 app」）；确认没东西再指着它可以删 |

系统层面绕不过去的：

- **隐私权限要重新给**：macOS 按包标识记权限（辅助功能、完全磁盘访问、自动化、文件夹访问……）。给过 Ash 的，Navi 第一次用到时会重新问；「系统设置 → 隐私与安全性」里 Ash 那几条要自己删。
- **第一次打开要再过一次 Gatekeeper**（没经公证，同首页的处理）。
- 「应用程序」里会多一个叫 Ash 的替身（软链），见上表最后一行。
- Dock 里固定的 Ash 图标会跟着旧包进废纸篓（或者失效）：从 Dock 移掉、重新把 Navi 拖上去。**别从废纸篓或那个旧图标打开 Ash**：旧版会把 Navi 的服务当成「旧版 app 起的」换成它自己的、用旧代码跑在已经被新版迁移过的库上；真要退回旧版按「更新前的库备份、回到旧版」那一节走。
- 钥匙串、通知、登录时打开（「通用 → 登录项」里那一栏）这几样 Ash 没有用过，不涉及；登录时起服务走的是上表的 LaunchAgent。

## 第一次打开

数据根里还没有 `ash.db` 时，窗口开成一扇 980×660 的小窗（不是 1440 的大窗正中摆几行字），先问数据从哪来（`FirstRunView`：左边一栏是 Navi 和首次配置要走的几站，右边是两个选项；选了之后原地转圈直到页面接上，不换屏、不闪白）。原生那一屏只交给表了态的页面（报了窗口大小 = 画出了第一屏或报错屏），主文档载完不算数；页面脚本没载成、或者久等不到表态，就换成一屏说明，给「重试」和「仍然显示页面」，不放出一整块空白。随后 web 的三步向导也在这扇小窗里、铺满整窗，用同一套两栏版式（左栏原地不动），每一站都能跳过；页面说进了工作台才展开成工作窗。窗口大小由页面表态：`<html data-window-size="setup|work">`（`web/src/auth/AuthGate.tsx` 写，`WindowChrome` 转告）——数据已有、向导上次没走完时也会缩回小窗。首次配置期间不记窗口位置，工作窗照旧按上次拖成的样子打开。


- **全新开始**：起一份空的，进入首启向导（供应商 → 执行器 → 项目）。
- **导入已有数据…**：选一份 Navi 数据目录（比如仓库的 `data/`）。**只复制、不移动**，源目录一个文件都不多。库走 SQLite 在线备份（一致快照，源库正被另一份 server 写着也安全；它还开着时会先提醒），其余目录按文件复制（同一 APFS 卷上是克隆，不占第二份空间）；锁、在线标记、`deps/`、`tmp/`、源的 `logs/` 不搬。多人模式的数据、和 app 数据根互相包含的目录不能导。
  - **导入不是重启**：发布前用自带 node 跑一遍 server 的 `import-snapshot`。副本里不留任何认得出源实例进程的线索（pid、启动时刻、进程记号、没收干净的清理责任），在跑或排队的任务落「暂停」，在盯的哨兵、在跑的验收前置命令、进行中的审查落「结束/被打断」，定时任务停用（定义留着）、没发出的消息取消、队列推进作废 —— 否则副本开机会去接管、甚至停掉源实例正在跑的 agent，或在同一个仓库里再起一份。审查链另有一套不认 pid、认「任务还停在那个方向上」的执行权限：每个任务的方向世代推进一格，导入前记下的方向身份一律作废；收尾计划落成已了结、待补的结算不再补、续审/派审/修复投递的凭据全部撤掉 —— 否则副本开机会替源实例重投修复、推后续站、清合并审查的工作区。停下了哪些，导入完弹窗说一声。同一趟把库里落在源数据根下的绝对路径（会话输出、哨兵日志、附件、证据目录……）逐字改到 app 的数据根（数据根路径里带 `$&` 之类也照原样写），源数据根以外的路径一个字不动。
  - 和起服务**同一把锁**：先在数据根里一个只属于这一次的暂存目录备齐、洗好，再拿锁发布；锁里重查数据根还空着（另一个窗口或登录项可能刚点了「全新开始」，那时这次导入作罢、那份数据不碰）。数据根里有认不出来的东西也拒绝。库最后落，是提交点；挪到一半的条目记在清单里，下次导入先收掉。

连上自己那份之后，app 替本机装了的 CLI 接 Navi MCP（`POST /api/ash-mcp/host-setup`，同注册执行器那一下：缺了才写、已有登记一律不覆盖），写进去的是 app 自带的 node 和 `mcp/dist`。已有登记**指向别处**的（比如仓库的 `mcp/dist`）不替你改，弹窗列出现在指向哪、改成什么，改不改你定；没接上的（macOS 上 codex 那一家 Navi 不替你写）给出手工加的那一段。每个数据根自动查一次，之后从菜单「检查 Navi MCP 登记…」随时再查。

## 验证用的口子

不碰日常那一份：把 app 拷到任何地方，用临时数据根和临时端口直接跑可执行文件——

```bash
ASH_URL=http://127.0.0.1:14977 ASH_DATA_DIR=/tmp/navi-try HOME=/tmp/navi-home \
  /path/to/Navi.app/Contents/MacOS/Navi                 # 带窗口
  /path/to/Navi.app/Contents/MacOS/Navi --start-server  # 不带窗口
```

也可以 `defaults write dev.navi.mac NaviDataDir <目录>` 换数据根、`defaults write dev.navi.mac NaviURL http://192.168.1.187:4317` 连别的 Navi（非本机地址不替它起服务，也不做身份判断）。

定点回归（仅 macOS）：`node scripts/test-macos-update.mjs` 覆盖装之前那道闸（不会打断就不问；会打断先问、等到排空自己装、现在装；问不出来按会打断；等的时候一次 503 / 不应答不放行；只停评估过的那个进程；另一处在起服务时不停；维护标记跨进程生效、持有者没了作废；停不下来不装也不备份；别的 Navi 不碰；退出那一档和它备份失败时的说法；Sparkle 放弃后闸收回、重试再备份；起服务前补备份、没有服务记录时连着起不来也留住迁移前的原件、起它的启动器没等到时由之后看到它应答的那一处确认、下一版不拿上一次的底顶替、确认后旧恢复点作废；旧版服务识别）、库备份（WAL 里的写入、确认前不轮换、确认后只留 5 份、同一秒不覆盖且按生成先后认新旧）。`node scripts/test-macos-release.mjs` 覆盖发版脚本：只出 dmg（格式、卷里只有 app + Applications 软链 + 入库的布局）、dmg 与 appcast 的签名、篡改检测、重发 / 旧版本 / 钥匙不配对拒发、`--notes`、缓存 dmg 认 app 且同一份原样沿用；对着本地假 GitHub（装包、清单两个仓库，账号权限和 token 真写得了分开模拟）的正式发版：账号能写但 token 只写得了一个或都写不了、清单分支要 PR 或开着保护、构建提交没推、同名 tag 指着别的提交、app 没记构建提交、旧格式配置，都什么都不公开；都齐了是草稿 → 传包 → 下回核对 → 公开 → appcast 进清单仓库且指向公开的 dmg → README 链接只提交 README；预检都过、提交 appcast 才被拒时 Release 保持公开、重跑只补 appcast；记着别的提交、排在第二页的旧草稿找得到，公开时 tag 打在这次的构建提交上；全发完只差 README 时重跑只补 README，补旧版收尾时 README 不倒回去；README 那一步提交钩子失败时没人动过就还原、期间有人改过就保留他的改动，README 指着更新的一版时旧版不覆盖它。`node scripts/test-macos-sparkle-dmg.mjs` 用真的 Sparkle（`Tests/SparkleDmg` 编的空壳 app，更新配置同 build.sh）走一遍：dmg 被改一个字节 → 下载了但挂载前验签不过、不装；appcast 被改 → 连 dmg 都不下；都对 → 装上新版并由 Sparkle 重开。`node scripts/test-macos-client.mjs` 用真的 AshConfig / AshHealth / ServerLauncher / DataImport / BrowserWindowController 加一份假的自带运行时，覆盖下载事务、红绿灯下的页面、「端口上是谁」的判据（数据根 + 自带代码 + 本机模式）、窗口只连专用端口、在线后换人（自己那份停了、不认实例号的旧版 Navi 接手 4317，页面持续写请求，一条都到不了 4317；导航与定时两道撤页；自家服务重起后换上新实例号）、空数据根不起、起服务的环境（终端配置盖不掉）、占用提示、并发只起一份、锁超时、请求合并、起来就退、PID 核对、启动器报错、运行时缺件、构建号、安装（别名目录、带正则字符的目录、相对路径起的包内可执行文件、包外软链起的入口靠它拿着的锁认出、最后检查之后改名之前起来的入口等在锁上并读到整份新包、锁文件缺了不启动不安装、两个安装器并发）、导入（WAL 里的写入、命名管道跳过而链接照原样复制、暂存里洗过再发布、和起服务互斥、失败与抢跑不留痕迹、残留清单、停掉的源、互相包含、多人库拒绝）。server 那一半：`npm -w server run test:host-ash-mcp`（MCP 登记归类）、`npm -w server run test:import-snapshot`（导入不是重启：真的接管入口对着洗过的库认不出活着的源进程；同一串开机对账对着没洗/洗过的副本各跑一遍，前者替源实例重投修复、后者一行不动；路径逐字重定位）、`npm -w server run test:instance-binding`（真服务：带着别人实例号的写请求、页面、预览与预览 WebSocket 一律 409 且不执行，health 照答；窗口专用端口上同一套判据，被占着时 health 报 null、服务照常起）。

## 窗口

内容铺到窗口顶，红绿灯浮在页面左上角，不单占一行标题栏（首次配置时窗口开多大见「第一次打开」）。页面要给它让位，所以是页面先表态：`web/index.html` 里有 `<meta name="navi-window-chrome" content="overlay">`（改名前的页面写的是 `ash-window-chrome`，也认）才铺上去，没有这一行的文档（更早版本的 Navi、同源的其它页面）仍是普通标题栏。壳把红绿灯的实际高宽量出来交给页面（`--window-titlebar-height` / `--window-controls-width`，全屏时为 0），页面这一半在 `web/src/styles/window-shell.css`：主工作区和设置页把那一条用起来，其它整页布局默认让开。顶上那一条的空白处、以及页面用 `--window-drag: drag` 划进来的顶栏都能拖窗口，双击跟随系统设置。

导出下载先写目标目录内的独立临时文件，完成后再原子替换目标文件。下载失败或在完成前退出不会删除已有文件。每笔下载在 app 那块地（`~/Library/Application Support/dev.navi.mac`，升级上来的是 `dev.ash.mac`）的 `downloads` 下留一张带锁的登记；app 被强杀或断电留下的隐藏暂存目录（目标文件夹里的 `.ash-download-…`）下次启动时照登记回收，仍在写的下载持着锁、不会被碰。

## 文件

| 文件 | 管什么 |
|---|---|
| `scripts/bundle-runtime.mjs` | 把 node、产物、生产依赖装进 app |
| `scripts/build-number.mjs` | 严格递增的 CFBundleVersion |
| `scripts/install-app.sh` | 换进安装目录（按目录加锁）；旧包还有进程在用就不换 |
| `scripts/bundle-users.sh` | 还有哪些进程在用某个 .app（按真实文件身份认） |
| `Sources/AshConfig.swift` | 连哪台、自带运行时在哪、数据和日志放哪 |
| `Sources/LegacyIdentity.swift` | 改名前的 Ash.app 怎么交班：设置、网页数据、登录项接过来，旧包让位 |
| `Sources/AshHealth.swift` | 「端口上是谁」的唯一判据（数据根、自带代码、本机模式、窗口专用端口） |
| `Sources/ServerLauncher.swift` | 起自带的服务；端口被占时说清是谁 |
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
| `scripts/download-link.mjs` | 发完改写并单独提交根 README 的下载链接 |
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
| `Sources/AshPalette.swift` | 原生几屏的颜色，取自 web 的浅 / 深两套令牌 |
| `scripts/make-icon.swift` | 构建时把 `docs/logo/icon.svg` 栅格成图标 |

卸载：菜单里先取消「登录时启动 Navi 服务」，停掉服务，再删 /Applications/Navi.app（升级上来的机器上还有一个指向它的 `Ash.app` 替身，一起删）；数据在 `~/Library/Application Support/dev.navi.mac/`（升级上来的是 `dev.ash.mac/`）。页面检查器：Safari →「开发」→ 本机 → Navi。
