# 改名 navi ⑦：Windows 真机验证记录与那台机器的升级操作单

2026-11-19 在 `192.168.1.187`（Windows 10 Pro / Windows PowerShell 5.1 / node v22.20.0）上跑的。
被测代码是改名 ⑤ 之后的分支（本文件所在的提交），经 `scripts/win-remote.mjs` 同步到对端独立的
`.worktrees\navi7-verify`；对照组是对端线上那份检出的提交 `8abd51552`（改名之前），另开在
`.worktrees\navi7-old`。对端主仓 `D:\ai_workspace\ash`、线上 `:4317` 和它的数据全程没有写过，
测试服务都起在别的端口、用临时数据目录或线上库的只读副本。

结论先说：

- **改名没有在 Windows 上弄坏产品代码。** 真机上跑出来的红，逐条拿改名前的版本对照过，要么旧版红在
  同一处（改名之前就有），要么是测试夹具/执行环境的问题。由改名带进来的红只有两处，都在测试里：
  `test-rename-compat` 自己的收尾（见第三节，已修）；`test-rename-navi.mjs` 是改名脚本的回归，天生只在
  POSIX 上成立，那个脚本也只在开发机上跑（见第二节表里那一行，没修）。
- **新旧两版在同一份数据上互斥照样成立**，新旧接力能认出对方，认不了的那一种会说清原因、拒绝。
- **那台机器可以升级**，步骤见第五节；有两件事没在真机上验证，原因见第四节。

## 一、跑了什么、结果

### 跨版本：同一份数据上的互斥锁（旧版 `8abd51552` ↔ 新版）

驱动脚本在对端起两版真服务（`tsx src/index.ts`），临时数据目录、临时家目录、别的端口。

| 项 | 结果 |
|---|---|
| M0 旧版在临时数据上起得来 | 过 |
| M1 旧版占着时新版被拒（新名 `NAVI_*` 与旧名 `ASH_*` 环境变量各一次），报的是旧版那把 `ash.db.ash.lock` 与持有者 pid | 过 |
| M2 旧版被强杀、留下陈旧 `.ash.lock` 后新版接得过来（日志：`stale singleton lock … overwriting`） | 过 |
| M3 新版同时持有 `ash.db.navi.lock` 与 `ash.db.ash.lock`（同 pid、同 token），在线标记两代都写 | 过 |
| M4 新版占着时旧版被拒 | 过 |
| M5 新版被强杀后旧版接得过来（读得懂新版写的 `.ash.lock`） | 过 |

### 跨版本：接力（握手与导出）

| 项 | 结果 |
|---|---|
| H1 配对，旧→新、新→旧：申请送达、对端认得出来访者、批准成功 | 过 |
| H2/H3 旧→新：导出成功、新版落库，`ash/` 分支和提交到了新版仓库，worktree 挂在这条分支上 | 过 |
| H4 新→旧（`navi/` 分支）：预检就提示；导出 409，原话「对端还是改名之前的版本：它只认 ash/ 开头的任务分支……先把对端升级到 Navi，再接力」 | 过 |
| H5 同上：旧版那边没落任何东西，新版本机的任务没被接力标记锁住 | 过 |
| H6 新→旧（`ash/` 分支）：导出成功、旧版落库、分支和提交到了 | 过 |
| 开发机新版 → 对端线上旧版 `:4317` 只读探测：签名被接受、服务认得出，`navi/` 分支被拒、`ash/` 放行，没往对端写东西 | 过 |

### 升级演练（线上库的只读副本）

线上 `data\ash.db` 用只读方式打开、`VACUUM INTO` 到 `navi7-verify\data\ash.db`（3 个项目、30 个任务、93 个会话、
在跑 0；`integrity_check` = ok），身份与远程访问两份 json 一并复制。旧版在副本上起成预览实例，再照新版
`scripts/restart.mjs` 第 2 步的同一批函数换成新版 `server/dist`（同样是预览模式：不跑调度器、不接管真进程）。

| 项 | 结果 |
|---|---|
| U2 旧版在副本上起来 | 过 |
| U3 新版重启脚本认出旧版那把锁（`data\ash.db.ash.lock`） | 过 |
| U4 问到了旧版的「重启会打断谁」 | 过（0 / 0 / 0） |
| U5 点名下刀、旧版下线、端口静下来 | 过（selective） |
| U6 新版 `server/dist/index.js` 经 `start-detached.mjs` 在副本上就绪：默认数据目录是检出下的 `data`，库名沿用 `ash.db`，没有建 `navi.db` | 过（1.8s） |
| U7 新版接过了陈旧的旧锁、两代锁都持有 | 过 |
| U8–U11 项目数与副本一致、任务列表、单个任务详情、网页（`web/dist`） | 过 |
| U12 新版启动日志里没有报错 | 过 |
| U13 `mcp\dist\index.js` 用最老一代的 `HARNESS_URL` 与新名 `NAVI_URL` 各接一次：握手、列出 34 个工具（含 `complete_task`、`pause_task`） | 过 |

演练结束后副本和临时家目录都已删掉。

### 回归测试（对端，新版）

叶子环境照 `scripts/test-runner.mjs` 的 `leafEnv`：擦掉各代库/运行目录/数据目录，每条一个自己的
`NAVI_DATA_DIR` 和 `TEMP`/`TMP`，`NAVI_TEST_NO_MODEL_PROBE=1`；另在 `PATH` 最前放了一组一调就失败的假
`claude`/`codex`/`gemini`/…，万一哪条测试去找真 CLI 也烧不到额度。

**绿（32 条）**

- Windows 专属与平台边界：`win-launch`、`path-boundary`、`openers-windows`、`data-root`、`singleton`、
  `rename-compat`（修过之后，见第三节；含「CIM 认得出的假旧服务占着锁」那几节）
- 活得过重启：`detached` 全链（`test-detached-survival` / `test-controllable-detached` / `test-control-fifo`（Windows 跳过）/
  `test-windows-detached`）、`reattach`、`kill-lineage`、`cleanup-debt`、`instance-binding`、`kernel-confine`、
  `accept-gate-process`、`worktree-recovery`
- MCP 注入与 CLI 配置：`navi-mcp-inject`、`cli-overrides`、`test-codex-mcp-setup.mjs`
- 终端链：`test-terminal-pty`、`test-terminal`、`test-project-commands`（Windows 生命周期一节）、`test-stop-evidence`、
  `test-stop-review`、`test-service-ports`、`test-service-ports-script`、`test-terminal-capacity`、
  `test-terminal-lifecycle`、`test-launch-abandon-races`、`test-terminal-stale-tty`
- 根目录脚本：`test-windows-restart.mjs`、`test-windows-restart-preservation.mjs`、`test-restart.mjs`、
  `test-win-remote-project.mjs`（按目录名认对端本仓库，新旧名都认）

**红（9 条）**：逐条见下一节。

## 二、红了的几条：都不是改名弄坏的产品代码

每条都在 `navi7-old`（`8abd51552`）上用同样的环境再跑了一遍对照。

| 测试 | 红在哪 | 旧版 | 归类 |
|---|---|---|---|
| `test-service-ports-scan`（`test:terminal` 链里） | Windows 分支断言的结果对象少了 `membersIncomplete: false` | 同一处红 | 改名前就有 |
| `test:scheduled-messages` | `test-scheduled-messages.ts:503`「真送进会话之后才算 sent」：`'pending' !== 'sent'` | 同一处红 | 改名前就有 |
| `test:navi-mcp-registry` | `:538` 断言把 `/profile/.claude.json` 写死成 POSIX 分隔符，Windows 上是 `\profile\.claude.json` | 同一处红（`test-ash-mcp-registry`） | 改名前就有 |
| `test:user-cli-mcp` | `codex-approve-cases.ts:44` 的 `/mcp[\\/]dist[\\/]index\.js/` 对不上 TOML 里转义过的 `mcp\\dist\\index.js` | 这句改名前就在；旧版检出没 build `mcp/dist`，走的是另一支 —— 线上那份检出是 build 过的，在那里跑同样会红 | 改名前就有 |
| `test-stop-verification` | `:130` 断言「守护进程还活着」为假：夹具是 POSIX 的形状（中转双 fork 出一个自己 `setsid` 的守护） | 同一处红（`:128`） | 改名前就有 |
| `test-launch-abandon` | 断言都过，`:204` 收尾删临时目录 `EBUSY` | 同一处红 | 改名前就有（和第三节同一类收尾） |
| `test:handoff` | 对端 server 起不来：测试写死 `<检出>\node_modules\tsx\dist\cli.mjs`，win-remote 工作区的 `node_modules` 里只有 `@navi/*` | 同一结构（旧版是 `@ash/*`） | 测试与 win-remote 工作区布局不合，不是改名；跨版本接力由第一节 H 组在真机上覆盖 |
| `test-rename-navi.mjs` | `:332` 权限位：Windows 没有执行位，`chmod 0o755` 读回来是 `0o666`；试着把这句改成比「写之前读回来的那份」，又红在 `:359`：给开着文件的目录改名 `EPERM`。后面还有建符号链接（那台机器没开开发者模式）、路径带 TAB 几段（那处试改已撤回） | 改名之前没有这个脚本 | 改名脚本只在开发机上跑，Windows 那台的升级用不到它（第五节）；它的回归天生是 POSIX 的，不在 Windows 上修 |
| `test:host-navi-mcp` | 拷出来的代码树找不到 `drizzle-orm`：测试往上找「第一个 `node_modules`」借给它，而 win-remote 的工作区里那个 `node_modules` 只有 `@navi/*` 几条 junction，其余依赖靠逐级向上解析到主仓 | 旧版这里放的是 `@ash/*`，同一结构；旧版检出另因没 build `mcp/dist` 先红在前一步 | 测试与 win-remote 工作区布局不合，不是改名 |

另有两件执行环境上的事：

- **叶子设了 `NAVI_RUNS_DIR` 会怎样。** 这一轮一开始就这么跑的：设了它，`server/src/executors/spawn.ts` 的 `guardAgentSpawn` 就进隔离档，
  把测试自己拿 `process.execPath` 起的假 agent 也拦下。`test-detached-survival` 于是一直等一个不会来的
  `close`，跑满 900 秒被杀；`test-reattach` 第一步拿到 `pid === undefined`。旧版设 `ASH_RUNS_DIR` 一模一样。
  照运行器的叶子环境跑，两条都绿。
- **win-remote 回传在 Windows PowerShell 5.1 上中文乱码。** `scripts/win-remote/transport.mjs` 读回传用的是
  不带 `-Encoding` 的 `Get-Content -Raw`，5.1 按活动代码页（936）解 UTF-8 字节。这一轮的输出都是让对端把日志
  转成 base64 再回传绕过去的。

## 三、改名带进来、已修的一处

`server/scripts/test-rename-compat.ts`：15 节断言在真机上全过，却在 `finally` 里删一个还开着 `ash.db` 的舞台目录时
报 `EBUSY` 判红（Windows 不许删开着的文件，POSIX 许）。改成先 `removeTmpStage(root)`（`tmp-db.ts` 那份先松开库再删）；
对端重跑全绿，开发机上已登记回归。同一类「库开着就删目录」的收尾在别的测试里还有几十处，都是改名之前就有的，
另提了任务，没在这里动。

## 四、没验证的部分

- **`npm install` / `npm run build` 在 Windows 上跑。** 这一轮按约定不在那台机器上构建：`dist` 是开发机构建好、随同步送过去的。
  所以 `npm install` 把 `node_modules\@ash\*` 换成 `@navi\*` 这一步、以及在 Windows 上 build，都只读了代码、没真跑。
- **升级那一刻还在跑的 agent 被新版接管。** 旧服务起的外壳带的是它自己那份脚本和 `ASH_*` 环境，新版接管只靠文件和
  管道名（这两样冻结在旧名上，见 `legacy-names`）；这条跨版本接管没在真机上造现场验证。线上库快照里在跑的任务是 0，
  操作单因此要求空闲时升级。
- **真 claude / codex 吃到 Navi 注入的 `navi` 这条 MCP 登记。** 要起真 CLI、烧额度，没跑；注入与登记的逻辑由
  `navi-mcp-inject`、`cli-overrides` 等回归在真机上覆盖，用户配置里那条 `harness` 登记由 U13 覆盖。
- **两边都升级之后 Mac ↔ Windows 用 `navi/` 分支接力。** 这一轮对端线上还是旧版，跨机只验了新→旧；新↔新由对端的
  `test:handoff` 覆盖（同一台机器上两个实例）。

## 五、那台机器的升级操作单

现状（2026-11-19 只读查得）：检出 `D:\ai_workspace\ash`，`main` @ `8abd51552`，工作区干净；`:4317` 是手动起的
`node server/dist/index.js`（2026-11-16 起，日志 `%TEMP%\ash-4317.log`）；没有计划任务、启动项或 Run 注册表项会自动拉起它；
用户级环境变量里没有 `ASH_*`/`NAVI_*`/`HARNESS_*`；claude（`~\.claude.json`）与 codex（`~\.codex\config.toml`）里各有一条
`harness` → `D:\ai_workspace\ash\mcp\dist\index.js`、环境变量 `HARNESS_URL`；数据目录里另有一份 2026-08-20 的
`harness.db.harness.lock`，是更早一代留下的，新旧版都不看它。

在那台机器的 PowerShell 里、`D:\ai_workspace\ash` 下做：

1. **挑空闲的时候。** 界面上没有在跑、在排队的任务（快照时是 0）。理由见第四节第二条。
2. **拉代码：** `git status` 应为空，然后 `git pull`（或 `git fetch` + 合并 `main`）。
3. **先停旧服务，再装依赖：** `node scripts/stop.mjs`。这是新版的停止脚本，只依赖 `scripts\` 下的文件，不需要先装依赖；
   它认得旧版那把 `data\ash.db.ash.lock`，会先问旧服务「停了会打断谁」再点名下刀（升级演练 U3–U5 跑的就是这一批函数）。
   先停再装，是因为下一步的 `npm install` 会把 `node_modules\@ash\*` 换成 `@navi\*`：旧服务还开着的话，它之后再懒加载
   哪个模块就会找不到。
4. **备份库：** `Copy-Item data\ash.db data\ash.db.pre-navi.bak`（服务已停，拷出来是一致的）。
5. **装、建、起：** `npm.cmd run restart`（或 `node scripts/restart.mjs`）。它依次 `npm install`、`npm run build`、起
   `server\dist\index.js`。**日志从此在 `%TEMP%\navi-4317.log`**，不再是 `ash-4317.log`。
6. **核对：**
   - 浏览器打开 `http://localhost:4317`，项目和任务都在；
   - `data\` 下同时有 `ash.db.navi.lock` 和 `ash.db.ash.lock`，库仍是 `ash.db`，没有出现 `navi.db`；
   - `node_modules\@navi\` 下是四条 junction（mcp / server / shared / web），`node_modules\@ash\` 已经没有了。
7. **CLI 里的 MCP 登记不用改。** 那两条 `harness` 登记指的入口没变，`HARNESS_URL` 照样认（U13）。Navi 自己起 agent 时注入的是
   新名 `navi`，两者不冲突。
8. **之后从 Mac 往这台接力**，`navi/` 开头的任务分支就能过了；升级之前这类接力会被拒，并写明「先把对端升级到 Navi」（H4）。

**回退：** `node scripts/stop.mjs` → `git checkout 8abd51552` → `npm install` → `npm run build` → 用原来的方式起
（`node scripts/start-detached.mjs %TEMP%\ash-4317.log node server/dist/index.js`，或 `npm run restart`）。旧版认得新版留下的
`ash.db.ash.lock`，也在新版迁移过的库上起得来（M5 就是这个顺序）；真遇到旧版读不了的库，用第 4 步那份备份换回 `data\ash.db`。

## 六、清场

<!-- CLEANUP -->
