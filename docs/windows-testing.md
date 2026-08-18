# Windows 上的测试基线

`server/scripts/test-*.ts` 有 70 来条,**不是每一条在 Windows 上都该跑绿**。这份清单只回答一件事:
在 Windows 上跑回归时,红了的那条**是真 bug,还是它本来就跑不了**。

盘点于 2026-08-14(`feat/win-support` 分支),依据是逐条读代码。**2026-08-18 起有真机了**
(`192.168.1.187`,Windows 10 Pro 19045 / node v22.20.0 / git 2.53.0 / pwsh 7.6.4),下面标了
「实测」的是在那台机器上跑出来的,其余仍是读代码的推断。怎么在开发机上改、在那台机器上跑,
见 `docs/win-remote.md`。

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
建符号链接 —— 在「设置 → 隐私和安全性 → 开发者选项」里打开。**实测 `192.168.1.187` 上是关的**
(`AllowDevelopmentWithoutDevLicense` 未设),所以这几条在那台机器上现在必红:

`test-file-browser.ts`、`test-local-open.ts`、`test-skills.ts`、`test-review-flow.ts`、
`test-free-workflow-hardening.ts`、`test-free-workflow-lifecycle.ts`

**`HARNESS_DB` 指向临时目录**:下面几条会真写库,入口有守卫(`server/scripts/tmp-db.ts`)——

`test-queue.ts`、`test-answer-routing.ts`、`test-executor-resolution.ts`、`test-cli-overrides.ts`、
`test-duet-iteration.ts`

守卫认 `os.tmpdir()`(POSIX 上额外认 `/tmp`)。Windows 上**别再照抄注释里的 `HARNESS_DB=/tmp/x.db`**:
那会落到当前盘的 `\tmp\`,多半不存在。改用 `HARNESS_DB=%TEMP%\test-queue.db`。

## 三、需要改夹具才能跑(现在会红,不是产品 bug)

这几条往 PATH 里塞一个**假 CLI** 来验执行链路,而那个假 CLI 是 `#!/bin/sh` 脚本 + `chmod 755`——
Windows 既不认 shebang 也不认 `chmod`;它们拼 PATH 用的还是写死的 `:`。要跑得换成 `.cmd` 桩
(或改成 `node <js>` 桩,两边通吃),并把 `:` 换成 `path.delimiter`:

| 测试 | 假 CLI 干什么 |
|---|---|
| `test-accept-merge.ts` | `exit 0` |
| `test-cli-catalog.ts` | 打印一行版本号 |
| `test-cli-overrides.ts` | 把收到的参数/环境变量写进探针文件 |
| `test-review-flow.ts` | `exit 0`(同时还用符号链接,见上一节) |
| `test-scheduled-messages.ts` | 多行脚本,模拟一次完整回合 |

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
  **注意其中一批(`test:queue`、`test:review` 等端到端)会真 spawn `claude -p` 烧真额度**,
  不适合拿来做无人值守的全量扫描 —— 要跑就挑着跑。
- `test-terminal.ts` 已按平台分了 shell(Windows 走 `cmd.exe`,探针命令换成 `echo` + `cd`),
  ConPTY 那条路**实测绿**(2026-08-18,8.6s)。但它会在退出时留一个孤儿:node-pty 的
  `conpty_console_list_agent.ts:13` 抛 `Error: AttachConsole failed` 之后不退,继续攥着 stdout。
  测试本身 exit 0 不受影响,踩到的是**外面**的东西 —— 任何拿「管道关闭」当完成判据的调用方
  (`<cmd> | Out-File`、CI 收集器)都会永远等不到 EOF。这是环境/上游的问题,不是 harness 的,
  暂未处理;`scripts/win-remote/transport.mjs` 改用「进程退出」当判据来绕开它。
