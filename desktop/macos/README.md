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
- 换了新版 app 而服务还是旧版 app 起的（`install:mac`、Sparkle 在退出时装的那一档、app 被强杀时 Sparkle 照样装上的那一档）：app 起服务时在数据根里记一笔 pid + 构建号（`.mac-server.json`），新版打开时认得出，走下面「装之前那道闸」把服务换成新版。

## 自更新

用 [Sparkle](https://sparkle-project.org) 2（版本和 sha256 钉在 `scripts/sparkle.mjs`，框架原样放进 `Contents/Frameworks`）。菜单「ash → 检查更新…」，另外每 6 小时自己查一次。更新包放在素材库 [noroot777/materials](https://github.com/noroot777/materials)（公开仓库，`release.json` 里配）：appcast 是 `ash/mac/appcast.xml`（app 拉的是它在 raw.githubusercontent 上的那份），zip 是 tag 为 `ash-mac-v<版本>-<构建号>` 的 GitHub Release 的附件。

**只靠 EdDSA 签名校验**：app 是 ad-hoc 签名，没有能跨版本延续的 Apple 签名身份，而 Sparkle 的规则是「Apple 签名身份和 EdDSA 密钥至少一样不变」。所以 Info.plist 里的 `SUPublicEDKey` **永远不能换**，换了已装的 app 就再也装不上新版。appcast 本身也签（`SURequireSignedFeed`），zip 先验签再解压（`SUVerifyUpdateBeforeExtraction`）：被改过的 zip 或 appcast 一律拒装。公钥由 `build.sh` 从 `release.json` 写进 Info.plist；还没配公钥的构建不带更新源，菜单里也没有「检查更新…」。

### 装之前那道闸

装新版 = 重启 app 里的服务。所以不管从哪条路装（点了「安装并重新启动」、勾了自动安装后 Sparkle 悄悄下好、下好了没装就按 ⌘Q），都先过 `UpdateGate`：

1. 问 server 的 `/api/restart-impact`（与 `npm run restart` 的安全闸同一条口径）。`interrupted`（接不回来、会判失败）和 `mcpDisrupted`（活得过重启，但手里握着 ash MCP，服务换代码那会儿交卷可能失败）都算**会打断**，同一个任务只算一次。会被接管的、调度台会自动接回的不算。只有**确认**没人会被打断才自己往下走：连接被拒（确认没在跑）、端口上是报了别的数据根的 ash、或者问到了且是空的；服务一时没答复、回了 503、没报身份、restart-impact 问不出来，都是「确认不了」，按会打断对待。
2. 不会打断任何任务 → 直接装。会打断 → 弹窗列出是哪几个、为什么，选「等它们跑完再装」或「现在装」（退出那一档多一个「取消」）。选了等，每 5 秒再问一次，确认排空了才自己装（中途一次探活失败只算确认不了，接着等）；等的时候菜单里有「等任务跑完后安装更新…」，点它可以改成现在装。
3. 放行后：攥住启动锁、在数据根里写维护标记（`.mac-maintenance.json`）→ 停掉**评估过的那一份**服务（SIGTERM；在跑的 agent 不随它死，新服务起来按 pid 接管；这会儿端口上换了进程、或者认不出是谁，就不停、从头再评估）→ 备份库 → 交给 Sparkle 换 app、重开 → 新版起新服务。维护标记在的时候，任何入口（这个窗口、登录项的 `--start-server`、另开的一份 app）都不起服务；持有它的进程没了（装完被退掉、崩了）标记就作废。停不下来或备份失败就不装，窗口把服务接回来，菜单里留「安装更新…」可以重试。
4. Sparkle 中途放弃了这次更新（安装出错、取消）：闸里排着的安装、轮询、维护标记全部作废，窗口把服务接回来；再装从头评估、再备份一次。

**退出那一档的例外**：退出时备份不成（比如盘满了），弹窗给「不退出」和「仍然退出」。Sparkle 没有「撤销退出时安装」的接口，仍然退出就会换上新版 app —— 兜底在新版那头：**起服务之前，库上一次要是别的构建号在用（或者没有服务记录、不知道是谁）、又没有固定着的恢复点，先备份并固定下来；备份不成就不起服务、不碰库**，装回旧版 app 就能回去。这一条同样兜住强杀后的安装、`build.sh --install` 和手动换 app。

已知、接受的剩余窗口：restart-impact 是一次快照，问完到 SIGTERM 之间（几十毫秒）server 仍可能接新任务；撞上的那条任务点一次重试就行，`npm run restart` 一直是这样。服务端不为此做「排空 → 停机」事务（用户 2026-11-14 决定）。

勾了「自动下载并安装」的话，下好之后只要不会打断任务就直接装并重开（窗口会刷新一下）；ash 常驻不退出，等「退出时装」可能要等好几天。app 被强杀（`kill -9`、崩溃）时 Sparkle 照样会把下好的那份装上，这一刀绕过了闸，由新版打开时的「旧版服务」识别（见「服务怎么起」）和起服务前的补备份兜住。

### 更新前的库备份、回到旧版

server 一启动就做不可逆的迁移，所以闸在停掉服务之后、换 app 之前，用 SQLite 在线备份给库留一份：`<数据根>/backups/<UTC 时间>-<旧构建号>.db`，一个自成一体的文件，只留最近 5 份，同一秒的两份另起名字、不互相覆盖。迁移前的那份原件另外**固定成恢复点**（`backups/recovery-point.json` 记着是哪个文件）：新版的服务真起来之前（迁移跑完了才会应答），它不参与轮换，起服务前也不再补备份 —— 新版连着起不来时，每次重试看到的都是被失败的迁移改过一半的库，照常备份、轮换的话原件很快就被挤掉。新版起来了，恢复点就回到普通轮换里。新版起不来时，占位页指的就是这份恢复点。回到旧版：

```bash
# 1. 退出 app，停掉服务（数据根里 ash.db.ash.lock 记着 pid）
kill "$(node -p 'require(process.env.HOME + "/Library/Application Support/dev.ash.mac/ash.db.ash.lock").pid')"
# 2. 从素材库的 Releases 里下回备份文件名里那个构建号的 zip（tag ash-mac-v…-<构建号>），解开换掉 /Applications/Ash.app
# 3. 把备份放回去（先把现在这份挪开，别直接覆盖）
cd ~/Library/Application\ Support/dev.ash.mac
mkdir -p rolled-back && mv ash.db ash.db-wal ash.db-shm rolled-back/ 2>/dev/null
cp backups/<那一份>.db ash.db
# 4. 打开旧版 app
```

旧版 app 会在下一次定时检查时又提示装新版：点「跳过这个版本」（勾过自动安装的，先 `defaults write dev.ash.mac SUAutomaticallyUpdate -bool NO` 再打开旧版）。

## 发版

**签名密钥**（2026-11-14 已生成，公钥已在 `release.json`）：私钥存在这台 Mac 的**登录钥匙串**里（「钥匙串访问」里搜 `dev.ash.mac`），不进任何仓库。生成时导出过一份备份，**必须放进密码管理器 / 离线介质**。私钥丢了，已经装了 app 的机器就**再也收不到更新**（公钥不能换，见上）。

```bash
npm run release:mac -- --keys        # 钥匙串里已有就沿用、只核对 release.json；没有才新建（换电脑时先导回，别新建）
desktop/macos/build/cache/Sparkle-*/bin/generate_keys --account dev.ash.mac -x <备份文件>   # 再导出一份备份
desktop/macos/build/cache/Sparkle-*/bin/generate_keys --account dev.ash.mac -f <备份文件>   # 换电脑：导回钥匙串
```

发版时 `generate_keys` / `sign_update` 读钥匙串，第一次会弹窗问能不能访问 `dev.ash.mac`：输登录密码、点「始终允许」。

每发一版：

```bash
npm run release:mac
```

从**干净的提交**构建（版本号取提交时间）→ 核对 app 里的公钥就是签名私钥的那一把、更新源就是素材库里那份 appcast → 版本号必须比 appcast 里最新的大 → 压 zip（`ditto`）、`sign_update` 签名 → 在素材库建 GitHub Release `ash-mac-v<版本>-<构建号>`、传 zip → 把包下回来核对 → 再更新 appcast（新的一项在前，旧的原样保留，整份重签）→ 经 GitHub Contents API 提交回素材库（带着读出时的 sha，这期间别处改过就拒，重跑即可；不克隆素材库，宣传片等大文件一个字节都不下）。先传包、确认下得下来才提交 appcast，feed 不会指向一个还不存在的包；中途失败重跑，同一版沿用 `build/releases/` 里上次压好的 zip —— 只在这次的 app 和压那个 zip 的是同一份时（zip 旁边的 `.source` 记着 app 的内容摘要），同一个构建号换了包就拒发。更新说明默认是上一版以来的提交标题，`--notes` 可以换。

GitHub 凭证按顺序找：`GH_TOKEN` / `GITHUB_TOKEN` → `gh auth token` → git 存在钥匙串里的 github.com 凭证（`git push` 用的那条）。都没有就报错并说怎么配。传包和提交 appcast 只用这一张，开传之前先确认它对素材库有写权限，没有就什么都不传。`--init-repo` 只在 `release.json` 的 repo 还不存在时才用得上（会建成公开仓库）。raw.githubusercontent 有几分钟缓存，推完稍等已装的 app 才看得到。

### 本地演练

不碰 GitHub、不碰日常那一份 app：换一个 bundle id（defaults、数据根、登录项都跟着分开）、本机 http 托 appcast，造一旧一新两版：

```bash
export ASH_MAC_BUNDLE_ID=dev.ash.mac.rehearsal ASH_MAC_SKIP_BUILD=1 \
       ASH_MAC_FEED_URL=http://127.0.0.1:8765/appcast.xml ASH_MAC_ED_PUBLIC_KEY=<演练公钥>
ASH_MAC_BUILD_NUMBER=20000101.0001 bash desktop/macos/build.sh && ditto desktop/macos/build/Ash.app /tmp/r/Ash.app
ASH_MAC_BUILD_NUMBER=20000101.0002 bash desktop/macos/build.sh
npm run release:mac -- --local /tmp/r/feed --app desktop/macos/build/Ash.app --ed-key-file <演练私钥文件>
(cd /tmp/r/feed && python3 -m http.server 8765 --bind 127.0.0.1) &
defaults write dev.ash.mac.rehearsal AshURL http://127.0.0.1:14977
defaults write dev.ash.mac.rehearsal AshDataDir /tmp/r/data
defaults write dev.ash.mac.rehearsal HostMcpSetupDone -array /tmp/r/data   # 别替本机 CLI 写 MCP 登记
open /tmp/r/Ash.app                                                          # 菜单「检查更新…」
```

演练私钥是 base64 的 32 字节 ed25519 种子（`generate_keys -x` 导出的就是这个格式）。演练完删掉 `dev.ash.mac.rehearsal` 的 defaults 和 `~/Library/{Caches,HTTPStorages,WebKit}/dev.ash.mac.rehearsal`。

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

定点回归（仅 macOS）：`node scripts/test-macos-update.mjs` 覆盖装之前那道闸（不会打断就不问；会打断先问、等到排空自己装、现在装；问不出来按会打断；等的时候一次 503 / 不应答不放行；只停评估过的那个进程；另一处在起服务时不停；维护标记跨进程生效、持有者没了作废；停不下来不装也不备份；别的 ash 不碰；退出那一档和它备份失败时的说法；Sparkle 放弃后闸收回、重试再备份；起服务前补备份、没有服务记录时连着起不来也留住迁移前的原件；旧版服务识别）、库备份（WAL 里的写入、只留 5 份、恢复点不参与轮换、同一秒不覆盖）和发版脚本（zip 与 appcast 的签名、篡改检测、重发 / 旧版本 / 钥匙不配对拒发、`--notes`、缓存 zip 认 app；对着本地假 GitHub 的正式发版：只给 GH_TOKEN 走完传包和提交 appcast、没写权限什么都不传）。`node scripts/test-macos-client.mjs`用真的 AshConfig / AshHealth / ServerLauncher / DataImport 加一份假的自带运行时，覆盖下载事务、红绿灯下的页面、「端口上是谁」的判据、空数据根不起、起服务的环境、占用提示、并发只起一份、锁超时、请求合并、起来就退、PID 核对、启动器报错、运行时缺件、导入（WAL 里的写入、只复制、多人库拒绝、残留替换）。server 那一半在 `npm -w server run test:host-ash-mcp`。

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
| `Sources/Updater.swift` | 接 Sparkle：三条安装路径都交给 UpdateGate |
| `Sources/UpdateGate.swift` | 装之前那道闸：问会打断谁、等或现在、停服务、备份 |
| `Sources/RestartImpact.swift` | 读 `/api/restart-impact`，算出会打断哪几个 |
| `Sources/ServerControl.swift` | 记下哪一版起的服务；只让评估过的那份下线；维护期标记（跨进程不许起服务） |
| `Sources/DatabaseBackup.swift` | SQLite 一致快照；更新前备份、恢复点与保留 |
| `scripts/sparkle.mjs` | 取固定版本的 Sparkle（框架 + 签名工具） |
| `scripts/release.mjs`、`appcast.mjs`、`github.mjs` | 发版、appcast 读写、GitHub API |
| `release.json` | 发布仓库与 appcast 路径、tag 前缀、钥匙串条目名、EdDSA 公钥 |
| `Sources/AppDelegate.swift` | 生命周期与菜单（⌘C/⌘V 靠编辑菜单分发，不能省） |
| `Sources/BrowserWindowController.swift` | 窗口、WKWebView、探活、菜单动作 |
| `Sources/WindowChrome.swift` | 内容铺到窗口顶：量红绿灯、和页面的约定、拖窗口 |
| `Sources/WebViewBridge.swift` | 外链、新窗口、选文件、下载、JS 对话框 |
| `Sources/DownloadTransaction.swift` | 另存为的暂存、原子替换与中断后的回收 |
| `Sources/OfflineView.swift` | 页面载不进来时的那一屏 |
| `scripts/make-icon.swift` | 构建时现画图标 |

卸载：菜单里先取消「登录时启动 ash 服务」，停掉服务，再删 /Applications/Ash.app；数据在 `~/Library/Application Support/dev.ash.mac/`。页面检查器：Safari →「开发」→ 本机 → ash。
