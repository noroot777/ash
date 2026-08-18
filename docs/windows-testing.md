# Windows 上的测试基线

`server/scripts/test-*.ts` 有 70 来条,**不是每一条在 Windows 上都该跑绿**。这份清单只回答一件事:
在 Windows 上跑回归时,红了的那条**是真 bug,还是它本来就跑不了**。

盘点于 2026-08-14(`feat/win-support` 分支),依据是逐条读代码 —— **没有在真 Windows 上跑过**。
拿到机器后按这份清单对,对不上的地方直接改这里。

## 一、专为 Windows 写的三条(在 macOS/Linux 上也跑绿)

它们靠伪造 `process.platform` 走真分支,不需要 Windows 机器 —— 改动对应逻辑时在开发机上就该跑:

| 测试 | 钉的东西 |
|---|---|
| `npm -w server run test:win-launch` | PATH 按 `;` 拆、PATHEXT 补扩展名、npm `.cmd` 垫片拆封、cmd.exe 引号规则、三个 `Program Files` 根 |
| `npm -w server run test:path-boundary` | NTFS 大小写归一、兄弟目录、UNC/8.3 拒绝面、MAX_PATH 提示 |
| `npm -w server run test:openers-windows` | 注册表输出解析、默认应用、`%1` 替换 |

## 二、需要先满足一个前提

**Node >= 22.16.0**:数据库走 Node 内置的 `node:sqlite`,再早的版本要么没这个模块、要么缺
`setReturnArrays`(join 出的重名列会**静默**读错)。凡是碰库的测试在低版本上一律起不来 ——
起不来时的报错已经是人话,照着升级即可,别去查测试本身。

**开发者模式**(或以管理员身份跑):下面几条用 `symlinkSync` 造夹具,Windows 默认不允许普通用户
建符号链接 —— 在「设置 → 隐私和安全性 → 开发者选项」里打开:

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
`npm -w server run test:agent-tee`,**它在 Windows 上必须绿**。

## 五、剩下的

其余(纯逻辑、Node 内置 API、`execFile("git", …)`)没有额外前提,应当直接绿。两处还没落实:

- 团队 / duet 那批长链路测试只做了静态阅读,没有逐条推演会不会间接踩到上面几类前提
- `test-terminal.ts` 已按平台分了 shell(Windows 走 `cmd.exe`,探针命令换成 `echo` + `cd`),
  但 ConPTY 那条路**没在真机上验过** —— 这是拿到机器后最值得先跑的一条
