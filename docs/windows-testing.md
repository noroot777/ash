# Windows 上的测试基线

`server/scripts/test-*.ts` 有 70 来条,**不是每一条在 Windows 上都该跑绿**。这份清单只回答一件事:
在 Windows 上跑回归时,红了的那条**是真 bug,还是它本来就跑不了**。

盘点于 2026-08-14(`feat/win-support` 分支),依据是逐条读代码。**2026-08-18 起有真机了**
(`192.168.1.187`,Windows 10 Pro 19045 / node v22.20.0 / git 2.53.0 / pwsh 7.6.4),下面标了
「实测」的是在那台机器上跑出来的,其余仍是读代码的推断。怎么在开发机上改、在那台机器上跑,
见 `docs/win-remote.md`。

## 〇、当前基线

**2026-10-23 实测这 7 条绿**:`win-launch`、`path-boundary`、`openers-windows`、`terminal`
(含 `test-project-commands` 的 Windows 生命周期一节)、`detached`、`reattach`、
`scheduled-messages`(含 `test-native-steer` —— 它的两个假 CLI 这一轮才换成 Windows 也能启动的
形状,见第四节最后一条)。中间那几条是这一轮新进来的 —— 常用命令和「活得过重启」原先在那边都是
**明确不做**:前者的判据在第一节(伪平台那条)与第五节(ConPTY 真机那条),后者整节在第四节。

**2026-08-19 实测过这 6 条绿**:`win-launch`、`path-boundary`、`openers-windows`、
`scheduled-messages`、`review`、`accept-merge`。**其余的绿是 2026-08-18 那轮留下的,
夹具此后改过,没有重测就不作数** —— 别把下表当成「现在还是 14/14」。

不作数的原因很具体:`test-accept-merge` / `test-review-flow` 的假 claude 已经删掉,改成
「`ASH_RUNS_DIR` 一设就必须 fail-closed」的断言(见第三节);`test-scheduled-messages`
当时那条绿更是假的 —— 它断言 `crash.signal === "SIGKILL"`,而 Windows 没有 POSIX 信号,
`signal` 恒为 `null`,这条在真机上**只可能红**。它现在按平台分:Windows 断 `status === 1`,
POSIX 仍断 `SIGKILL`,两边都先排除掉「没抢到租约」(`status === 3`)这个伪前提。

下表是各条**首次**上真机时红在哪(2026-08-18),留作分类样本,不是当前状态:

| 测试 | 首次上真机 | 红的是什么 |
|---|---|---|
| `win-launch` | 红 → 绿 | 夹具写死 `cmd.exe`,真机 `COMSPEC` 是全路径 |
| `path-boundary` | 红 → 绿 | 收尾 `EBUSY: unlink ash.db`(A 类) |
| `openers-windows` | 绿 | |
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
  夹具自己拼路径也算这一类:`test-path-boundary` 的 `lower()` 曾用 `` `${stage}/Repo` `` 当替换
  目标,Mac 上伪造 win32 时命中,真机上 `stage` 是 `C:\…`,一次都换不成 —— 断言照样绿,测的却是
  原大小写。现在它改用 `join()` 拼,并在原地断言这次变换确实改到了路径 —— 空转当场就红。

**A/B 之外真找出来的产品 bug 只有一类,但它有五处**:`startsWith(x + "/")` 判路径边界。
`path.resolve` 在 Windows 上还的是反斜杠,这个前缀比较**恒为假** —— 不是安全收紧,是整条功能
静默失效:审查报告一律读成空串(「按意见修复」被挡死)、`/review/*` 全部 404、SPA 的每个 js/css
都判成界外回退 index.html(整个前端白屏)、assets 拿不到 immutable 缓存头。改用 `path.sep`。

## 一、专为 Windows 写的三条(在 macOS/Linux 上也跑绿)

它们靠伪造 `process.platform` 走真分支,不需要 Windows 机器 —— 改动对应逻辑时在开发机上就该跑:

| 测试 | 钉的东西 |
|---|---|
| `npm -w server run test:win-launch` | PATH 按 `;` 拆、PATHEXT 补扩展名、npm `.cmd` 垫片拆封、cmd.exe 引号规则、三个 `Program Files` 根、**常用命令怎么起**(PowerShell `-EncodedCommand` + 退出码收口) |
| `npm -w server run test:path-boundary` | NTFS 大小写归一、兄弟目录、UNC/8.3 拒绝面、MAX_PATH 提示 |
| `npm -w server run test:openers-windows` | 注册表输出解析、默认应用、`%1` 替换 |

**实测 3/3 绿**(2026-08-18;2026-10-23 带着新加的 `commandLaunch` 一节重测仍绿)。前两条第一次上真机时是红的,两条都是**夹具**写歪了而不是产品 bug,
已修 —— 值得记一笔,因为这类「开发机绿、真机红」的偏差正是这份文档存在的理由:

- `win-launch` 断言 `plan.file === "cmd.exe"`,但真机上 `COMSPEC` 是 `C:\WINDOWS\system32\cmd.exe`,
  产品逻辑(`win-command.ts` 的 `process.env.COMSPEC || "cmd.exe"`)两边都对。第 6 节早就把 COMSPEC
  钉死了,第 5 节漏了。
- `path-boundary` 断言全过,却在 `finally` 里 `EBUSY: unlink …ash.db` —— Windows 删不掉还开着的
  文件,而 `ASH_DB` 指向的那个库是 import 时连上的。POSIX 上删已打开的文件合法,所以这条只在
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

**`ASH_DB` 指向临时目录**:下面几条会真写库,入口有守卫(`server/scripts/tmp-db.ts`)——

`test-queue.ts`、`test-answer-routing.ts`、`test-executor-resolution.ts`、`test-cli-overrides.ts`

守卫认 `os.tmpdir()`(POSIX 上额外认 `/tmp`)。Windows 上**别再照抄注释里的 `ASH_DB=/tmp/x.db`**:
那会落到当前盘的 `\tmp\`,多半不存在。改用 `ASH_DB=%TEMP%\test-queue.db`。`win-remote.mjs test`
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
`ASH_RUNS_DIR` 且没显式给 `ASH_ALLOW_REAL_AGENT=1` 时,任何执行器启动都被换成一个立刻
失败的假 child。于是这两条改成在开头断言这个隔离确实生效 —— 假 CLI 是「挡住了就没人知道有没有
挡住」,fail-closed 断言是「没挡住就当场炸」。断言故意会响,所以这两条的临时目录清理挂在
`process.on("exit")` 上,不能只放在 `finally` 里(2026-08-19 反证过:去掉钩子,`ASH_ALLOW_REAL_AGENT=1`
跑一次就在 `os.tmpdir()` 留一个 `ash-review-flow-*`)。

光挂钩子还不够,**断言本身要排在打开数据库之前**。exit 钩子是同步的,`await` 不了
`releaseTmpDb()`;断言要是排在开库之后才响,Windows 上 `rmSync` 撞的是「文件还开着」的 EBUSY,
被 `catch {}` 一吞,每跑一次照样多一个 TEMP 目录(2026-08-19 在真机上量到 3 个存量残留)。
两条脚本现在都是「建舞台 → 挂钩子 → fail-closed 断言 → 才开始 import」。

## 四、原先「有意不做」的那一档:已经做了(2026-10-23 真机绿)

**「agent 活得过 ash 重启」在 Windows 上不做**曾经是写进支持计划的决策,`reattach.ts` 和
`detached.ts` 里各有平台短路。现在那几处短路都删了,`test:detached` / `test:reattach` 在真机上
**实测绿**(2026-10-23):

- `npm -w server run test:detached` —— 杀掉 ash 之后 agent 还活着、接回后 24 行不丢不重、
  **退出码也对**;第二条(`test-controllable-detached`)钉的是重启后 stdin 还能接着引导
- `npm -w server run test:reattach` —— 真库 + 真进程走一遍接管接线,含 claude / codex 两条
  原生引导回合接回后仍能 interrupt / steer

做法与代价写在 `server/src/executors/detached-win.ts` 和 `detached-win-wrap.ts` 顶部,这里只记
**那条让人栽跟头的实测**:

> Windows 上子进程**默认活不过父进程**。不是 `taskkill /T`、也不是 stdout 管道的事 ——
> libuv 给每个非 `detached` 的子进程做一次 `AssignProcessToJobObject`,塞进它自己的全局 Job,
> 而那个 Job 带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:父进程一退出,句柄由内核回收,圈里的
> 进程全部被杀。`UV_PROCESS_DETACHED` 是 libuv 唯一跳过那次 assign 的分支。
>
> 2026-10-23 在真机上三种起法各跑一遍(父进程起完子进程 700ms 后 `process.exit(0)`,再轮询 3 秒):
>
> | 起法 | 父退出后 |
> |---|---|
> | 直起 CLI(文件 fd、不 detached) | 子当场死,输出停在 5 行 |
> | 套一层壳(不 detached) | 壳和 CLI 一起死(壳自己的 Job 又连坐了 CLI) |
> | **壳 + `detached: true`** | 照常活着,输出继续长到 26 行 |

### 那一刀本身:**认记号,不认名单**

落盘 + `detached` 只保证「ash 自己退出时 agent 不死」。`npm run restart` 还会**主动**下刀:
Windows 没有信号,旧版是 `taskkill /PID <server> /T /F`,`/T` 按父子关系把整棵树一起杀。于是这
一轮先改成「整棵后代减去 `/api/restart-impact` 给的 survives 名单」—— 第 1 轮审查实测证明这还
不够,两条都是确定性复现:

| 怎么破的 | 为什么 |
|---|---|
| 判据查询超时 | `localGet` 把「超时」和「端口上没人在听」一律压成同一个读数,保护名单于是变成空数组,退回整树强杀,命令最后照样说「已就绪」 |
| 问完判据之后又起了一个 agent | 名单是**上一时刻**的快照;新壳不在名单里,被明确 taskkill 掉 |

修法分两层,缺一不可:

1. **决策层 fail closed**(`scripts/restart.mjs` 的 `impact`):回答分三档 —— 拿到判据 / 服务端
   拒答 / **问不出来**(超时、被重置)。「问不出来」不等于「没有」,这时普通重启直接中止,
   要下刀得显式 `FORCE=1`。端口上压根没人在听才算「没有任务会被打断」;
2. **执行层不变量**(`scripts/platform.mjs` 的 `killServerProcess`):**凡是在同一份进程表快照里
   认得出壳记号的进程,一律不下刀**,名单退化成一个额外输入。记号就是壳脚本的文件名后缀
   (`WINDOWS_WRAP_SUFFIX` / `WINDOWS_AGENT_WRAP_SUFFIX`,两侧由 `test-win-launch` 钉在一起),
   它和 doomed 集合读的是同一份快照,中间没有时间差。快照之后才出生的进程压根不在 doomed 里,
   一刀都挨不着 —— 它要么是个新壳(该活),要么是非 detached 的子进程(libuv 那个 Job 自己会收)。

只有**进程表压根问不出来**时才退回 `/T /F`(宁可杀干净,也不留一堆没人管的孤儿终端/预览)。

顺带一条**夹具**层面的教训,四个都踩过:

- `spawn("npx", …)` 在 Windows 上 ENOENT(Node 不认 PATHEXT)。测试里要跑 tsx 就用
  `spawn(process.execPath, ["--import", "tsx", …])`,两个平台同一条命令;
- 内嵌脚本里的 import 说明符必须是 **file:// URL**(裸 `D:\…` 的盘符被当协议);
- **别靠「睡固定时长」造前提**。Windows 上起两层 node 还要过一遍 Defender,实测 600ms 不够;
  按条件轮询(文件出现 / 行数够了)才跟机器速度无关。原先 `test-reattach` 的假 agent 是
  「20 段 × 100ms 就自己退」,在真机上造用例那几秒走完它早没了,于是三条断言一起红在一个
  跟产品毫无关系的理由上;
- **假 CLI 得在两个平台都真能启动,并且断言之前先确认它真起来了**。`bin-resolve` 在 Windows 上
  只认 PATHEXT 里的扩展名,`.mjs` 一律解析不到 —— `test-native-steer` 的两个假 CLI 原先就是
  裸 `.mjs` + chmod:「必须留下可接管 pid」那条直接红(第 1 轮审查 F4),而「进程死了之后写
  stdin 必须失败」那条反倒**假绿**(压根没起过进程,自然写不进去)。形状照 `sticky-claude.cmd`:
  `.cmd` 里 `@node "%~dp0<script>.mjs" %*`,再让假 CLI 自己往一个记号文件里写一行,测试按
  条件等那一行。

## 五、剩下的

其余(纯逻辑、Node 内置 API、`execFile("git", …)`)没有额外前提,应当直接绿。两处还没落实:

- 团队 / duet 那批长链路测试只做了静态阅读,没有逐条推演会不会间接踩到上面几类前提。
  其中**有一批会真 spawn `claude -p` 烧真额度** —— 判据不是「名字看着像端到端」,而是
  **它有没有设 `ASH_RUNS_DIR`**:设了的那批被 `guardAgentSpawn` fail-closed 挡着
  (`review`、`accept-merge`、`free-workflow*`、`workflow-*`、`turn-*` 等),不设的那批没人挡
  (`test:queue` 就是,`grep -L ASH_RUNS_DIR server/scripts/test-*.ts` 能列全)。
  要无人值守地全量扫,先按这条筛一遍。
- `test-terminal.ts` 已按平台分了 shell(Windows 走 `cmd.exe`,探针命令换成 `echo` + `cd`),
  ConPTY 那条路**实测绿**(2026-08-18,8.6s)。但它会在退出时留一个孤儿:node-pty 的
  `conpty_console_list_agent.ts:13` 抛 `Error: AttachConsole failed` 之后不退,继续攥着 stdout。
  测试本身 exit 0 不受影响,踩到的是**外面**的东西 —— 任何拿「管道关闭」当完成判据的调用方
  (`<cmd> | Out-File`、CI 收集器)都会永远等不到 EOF。这是环境/上游的问题,不是 ash 的,
  暂未处理;`scripts/win-remote/transport.mjs` 改用「进程退出」当判据来绕开它。
