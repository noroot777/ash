# Windows 上的测试基线

`server/scripts/test-*.ts` 有 70 来条,**不是每一条在 Windows 上都该跑绿**。这份清单只回答一件事:
在 Windows 上跑回归时,红了的那条**是真 bug,还是它本来就跑不了**。

盘点于 2026-08-14(`feat/win-support` 分支),依据是逐条读代码。**2026-08-18 起有真机了**
(`192.168.1.187`,Windows 10 Pro 19045 / node v22.20.0 / git 2.53.0 / pwsh 7.6.4),下面标了
「实测」的是在那台机器上跑出来的,其余仍是读代码的推断。怎么在开发机上改、在那台机器上跑,
见 `docs/win-remote.md`。

## 〇、当前基线

**2026-08-19 实测这 6 条绿**:`win-launch`、`path-boundary`、`openers-windows`、
`scheduled-messages`、`review`、`accept-merge`。**其余的绿是 2026-08-18 那轮留下的,
夹具此后改过,没有重测就不作数** —— 别把下表当成「现在还是 14/14」。

不作数的原因很具体:`test-accept-merge` / `test-review-flow` 的假 claude 已经删掉,改成
「`HARNESS_RUNS_DIR` 一设就必须 fail-closed」的断言(见第三节);`test-scheduled-messages`
当时那条绿更是假的 —— 它断言 `crash.signal === "SIGKILL"`,而 Windows 没有 POSIX 信号,
`signal` 恒为 `null`,这条在真机上**只可能红**。它现在按平台分:Windows 断 `status === 1`,
POSIX 仍断 `SIGKILL`,两边都先排除掉「没抢到租约」(`status === 3`)这个伪前提。

下表是各条**首次**上真机时红在哪(2026-08-18),留作分类样本,不是当前状态:

| 测试 | 首次上真机 | 红的是什么 |
|---|---|---|
| `win-launch` | 红 → 绿 | 夹具写死 `cmd.exe`,真机 `COMSPEC` 是全路径 |
| `path-boundary` | 红 → 绿 | 收尾 `EBUSY: unlink harness.db`(A 类) |
| `openers-windows` | 绿 | |
| `agent-tee` | 绿 | |
| `terminal` | 绿 | (留一个孤儿进程,见第五节) |
| `file-browser` | 绿 | |
| `local-open` | 绿 | |
| `review` | 绿 | 当时靠假 CLI;夹具已换,2026-08-19 重测仍绿 |
| `accept-merge` | 绿 | 同上 |
| `free-workflow` | 红 → 绿 | **产品 bug**:`free-review-files.ts` 拼 `/` 判边界 + 夹具是 POSIX 方言(B 类) |
| `skills` | 红 → 绿 | 动态 `import` 说明符不是 `file://`(Windows 上 `d:` 被当协议拒);随后 A 类 |
| `cli-catalog` | 红 → 绿 | 夹具依赖 `echo`/`sh`(B 类) |
| `cli-overrides` | 红 → 绿 | 假 CLI 是 `#!/bin/sh` + 写死 `:`;夹具只设 `HOME`(Windows 认 `USERPROFILE`) |
| `scheduled-messages` | 红 → **假绿** | 假 CLI 是 sh 脚本(B 类)+ A 类;修完这两类之后才露出真正那条 POSIX 信号断言 |

真机红的原因基本只有三类,认出类别比逐条查快得多:

- **A 类:收尾 EBUSY。**断言全过,却在 `finally` / `process.on("exit")` 里删不掉临时目录或库文件。
  POSIX 删得掉还开着的文件,Windows 删不掉。危害不止于「多留个临时目录」——**它抛在收尾路径上,
  会把 try 里真正的断言错整个顶掉**,于是产品 bug 显示成「删不掉临时目录」。松库句柄用
  `tmp-db.ts` 的 `releaseTmpDb()`;`process.on("exit")` 是同步的,句柄得提前拿在手里。
- **B 类:夹具写的是 POSIX 方言。**`#!/bin/sh` 桩(Windows 不认 shebang,PATH 查找只认 PATHEXT
  后缀)、`echo`/`sh`/`test -f`/`sleep`(前者是 cmd 内建、PATH 上没这个文件,后三个压根没有)、
  PATH 拼接写死 `:`、只设 `HOME`。**两边通吃的写法是转手交给 `node`**:测试本身就是它跑起来的,
  必然在、必然是 PATH 上的真文件,而且 execFile 直起是亲子进程(不像 `.cmd` 垫片中间垫一层
  cmd.exe,手停的击杀语义两边就不一样了)。
- **C 类:断言写的是 POSIX 语义。**最典型的是「被 SIGKILL 杀掉」——Windows 上进程终止没有信号,
  `child.signal` 恒为 `null`,退出码是 `TerminateProcess` 传进去的那个数。要断的其实是
  「它是被硬杀死的、不是自己正常退出的」,两边各写各的判据(POSIX 看 `signal`,Windows 看
  `status`),并且**先把「压根没进到那个状态」排除掉**,否则平台分支只是把假绿换个地方藏。

**A/B 之外真找出来的产品 bug 只有一类,但它有五处**:`startsWith(x + "/")` 判路径边界。
`path.resolve` 在 Windows 上还的是反斜杠,这个前缀比较**恒为假** —— 不是安全收紧,是整条功能
静默失效:审查报告一律读成空串(「按意见修复」被挡死)、`/review/*` 全部 404、SPA 的每个 js/css
都判成界外回退 index.html(整个前端白屏)、assets 拿不到 immutable 缓存头。改用 `path.sep`。

## 一、专为 Windows 写的三条(在 macOS/Linux 上也跑绿)

它们靠伪造 `process.platform` 走真分支,不需要 Windows 机器 —— 改动对应逻辑时在开发机上就该跑:

| 测试 | 钉的东西 |
|---|---|
| `npm -w server run test:win-launch` | PATH 按 `;` 拆、PATHEXT 补扩展名、npm `.cmd` 垫片拆封、cmd.exe 引号规则、三个 `Program Files` 根 |
| `npm -w server run test:path-boundary` | NTFS 大小写归一、兄弟目录、UNC/8.3 拒绝面、MAX_PATH 提示 |
| `npm -w server run test:openers-windows` | 注册表输出解析、默认应用、`%1` 替换 |

**实测 3/3 绿**(2026-08-18)。前两条第一次上真机时是红的,两条都是**夹具**写歪了而不是产品 bug,
已修 —— 值得记一笔,因为这类「开发机绿、真机红」的偏差正是这份文档存在的理由:

- `win-launch` 断言 `plan.file === "cmd.exe"`,但真机上 `COMSPEC` 是 `C:\WINDOWS\system32\cmd.exe`,
  产品逻辑(`win-command.ts` 的 `process.env.COMSPEC || "cmd.exe"`)两边都对。第 6 节早就把 COMSPEC
  钉死了,第 5 节漏了。
- `path-boundary` 断言全过,却在 `finally` 里 `EBUSY: unlink …harness.db` —— Windows 删不掉还开着的
  文件,而 `HARNESS_DB` 指向的那个库是 import 时连上的。POSIX 上删已打开的文件合法,所以这条只在
  真机上现形。现在收尾前先 `dbClient.close()`。

## 二、需要先满足一个前提

**Node >= 22.16.0**:数据库走 Node 内置的 `node:sqlite`,再早的版本要么没这个模块、要么缺
`setReturnArrays`(join 出的重名列会**静默**读错)。凡是碰库的测试在低版本上一律起不来 ——
起不来时的报错已经是人话,照着升级即可,别去查测试本身。

**开发者模式**(或以管理员身份跑):下面几条用 `symlinkSync` 造夹具,Windows 默认不允许普通用户
建符号链接 —— 在「设置 → 隐私和安全性 → 开发者选项」里打开。**`192.168.1.187` 上已于 2026-08-18
打开,这几条现已实测绿**:

`test-file-browser.ts`、`test-local-open.ts`、`test-skills.ts`、`test-review-flow.ts`、
`test-free-workflow-hardening.ts`、`test-free-workflow-lifecycle.ts`

探测这个开关**别读注册表**:那台机器开关早就打开了,`AllowDevelopmentWithoutDevLicense` 却仍读不到
值,据此报过一次假警。要回答的问题其实是「symlink 建不建得出来」—— 直接建一个再删掉最准
(`scripts/win-remote.mjs` 的 doctor 就是这么做的)。

**`HARNESS_DB` 指向临时目录**:下面几条会真写库,入口有守卫(`server/scripts/tmp-db.ts`)——

`test-queue.ts`、`test-answer-routing.ts`、`test-executor-resolution.ts`、`test-cli-overrides.ts`、
`test-duet-iteration.ts`

守卫认 `os.tmpdir()`(POSIX 上额外认 `/tmp`)。Windows 上**别再照抄注释里的 `HARNESS_DB=/tmp/x.db`**:
那会落到当前盘的 `\tmp\`,多半不存在。改用 `HARNESS_DB=%TEMP%\test-queue.db`。`win-remote.mjs test`
已经统一代跑的人给一个临时库并在跑完删掉 —— 不给的话,红出来的样子是「Windows 上失败了」,
而其实 mac 上不设照样红。

## 三、假 CLI 夹具

这几条往 PATH 里塞一个**假 CLI** 来验执行链路。原先那批是 `#!/bin/sh` 脚本 + `chmod 755` + 写死
的 `:`,在 Windows 上一句都跑不起来;留下来的这几条已改成「壳按平台换(`.cmd` / shebang),本体
交给 node」:

| 测试 | 假 CLI 干什么 |
|---|---|
| `test-cli-catalog.ts` | 回显第一个参数(`%~1` / `"$1"`);另有三段直接用 `node -e` 当被测命令 |
| `test-cli-overrides.ts` | 把收到的环境变量写进探针文件 |
| `test-scheduled-messages.ts` | 读一行 stdin、回两条 JSON,模拟一次完整回合 |

`cli-catalog` 的回显桩在 Windows 上顺带多验了一段产品逻辑:命中的是批处理垫片,`resolveLaunch`
必须把它拆成 cmd.exe 调用而不是直接 execFile(`bin-resolve.ts` 里 CVE-2024-27980 那段)。

**`test-accept-merge.ts` 和 `test-review-flow.ts` 已经不摆假 CLI 了**,别再照着上面那张表去找。
它们要的只是「别真起 claude」,而这件事 `spawn.ts` 的 `guardAgentSpawn` 已经在做:设了
`HARNESS_RUNS_DIR` 且没显式给 `HARNESS_ALLOW_REAL_AGENT=1` 时,任何执行器启动都被换成一个立刻
失败的假 child。于是这两条改成在开头断言这个隔离确实生效 —— 假 CLI 是「挡住了就没人知道有没有
挡住」,fail-closed 断言是「没挡住就当场炸」。断言故意会响,所以这两条的临时目录清理挂在
`process.on("exit")` 上,不能只放在 `finally` 里(2026-08-19 反证过:去掉钩子,`HARNESS_ALLOW_REAL_AGENT=1`
跑一次就在 `os.tmpdir()` 留一个 `harness-review-flow-*`)。

## 四、验的是 Windows 上**有意不做**的功能

按 Windows 支持计划的决策 4,「agent 活得过 server 重启」在 Windows 上不做
(`reattach.ts:60`、`reattach.ts:102`、`detached.ts:288` 三处平台短路)。这两条在 Windows 上红是预期:

- `npm -w server run test:detached` —— 杀掉 server 之后 agent 还活着
- `npm -w server run test:reattach` —— 重启后按 pid + 启动时间接管

**但 detached 的另一半保留了**:stdout tee 到 `.agent-out.jsonl`。砍掉重启存活之后,它成了
交卷补捞(`mcp-handoff.ts` 的 `replayUndeliveredMcpCalls`)唯一的输入来源 —— 不写就是
「调过 `complete_task` 的任务被记成 failed 且不报错」。钉这一半的是
`npm -w server run test:agent-tee`,**它在 Windows 上必须绿** —— **实测绿**(2026-08-18)。

## 五、剩下的

其余(纯逻辑、Node 内置 API、`execFile("git", …)`)没有额外前提,应当直接绿。两处还没落实:

- 团队 / duet 那批长链路测试只做了静态阅读,没有逐条推演会不会间接踩到上面几类前提。
  其中**有一批会真 spawn `claude -p` 烧真额度** —— 判据不是「名字看着像端到端」,而是
  **它有没有设 `HARNESS_RUNS_DIR`**:设了的那批被 `guardAgentSpawn` fail-closed 挡着
  (`review`、`accept-merge`、`free-workflow*`、`workflow-*`、`turn-*` 等),不设的那批没人挡
  (`test:queue` 就是,`grep -L HARNESS_RUNS_DIR server/scripts/test-*.ts` 能列全)。
  要无人值守地全量扫,先按这条筛一遍。
- `test-terminal.ts` 已按平台分了 shell(Windows 走 `cmd.exe`,探针命令换成 `echo` + `cd`),
  ConPTY 那条路**实测绿**(2026-08-18,8.6s)。但它会在退出时留一个孤儿:node-pty 的
  `conpty_console_list_agent.ts:13` 抛 `Error: AttachConsole failed` 之后不退,继续攥着 stdout。
  测试本身 exit 0 不受影响,踩到的是**外面**的东西 —— 任何拿「管道关闭」当完成判据的调用方
  (`<cmd> | Out-File`、CI 收集器)都会永远等不到 EOF。这是环境/上游的问题,不是 harness 的,
  暂未处理;`scripts/win-remote/transport.mjs` 改用「进程退出」当判据来绕开它。
