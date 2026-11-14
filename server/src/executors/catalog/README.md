# 智能体目录(catalog)

ash 能派任务的 CLI 全部登记在这个目录里,**一个 CLI 一个 spec 文件**。这份 spec 同时喂三条链路:

| 链路 | 用到的字段 | 出口 |
|---|---|---|
| 检测与展示 | `key` / `name` / `description` / `bins` / `fallbackVersionMatch` / `docsUrl` / `installCommand` / `installCommandWindows` / `windowsNote` / `untested` / `notes` | `server/src/detect.ts` → `GET /api/agents/catalog`、`GET /api/agents/detect` |
| 派任务(命令行构造 + 输出解析) | `exec` / `factory` | `GenericCliExecutor`(`server/src/executors/generic.ts`)、`executors/index.ts` 的 `build()` |
| 会话恢复命令展示 | `exec.session.interactive` | `server/src/executors/resume.ts` |

**增删一个智能体只有两步**:

1. `shared/src/index.ts` 的 `AGENT_TYPES` 加/删一个字符串;
2. 这个目录加/删一个 spec 文件,并在 `catalog/index.ts` 的 `SPECS` 里加/删一行。

两边不一致就**编译不过**(`SPECS` 上挂着 `satisfies Record<AgentType, CliSpec>`),不靠谁记得。

---

## B 阶段(逐个 CLI 实测校准)的改动边界

**每人只许改两处**,其余一律别碰 —— 15 个执行者在并行,碰共享文件就是必然冲突:

1. 自己那一个 spec 文件:`server/src/executors/catalog/<你的 key>.ts`(含内联的自定义 parser);
2. `shared/src/cli-presets.ts` 里**属于自己 type 的那两行**:`CLI_MODEL_PRESETS[<key>]` 和 `REASONING_EFFORT_VALUES[<key>]`。

明确**不要**动:`catalog/index.ts`(15 个 import 已一次写全)、`catalog/types.ts`、`catalog/parsers.ts`、`generic.ts`、`detect.ts`、`AGENT_TYPES` 数组、web / mobile 前端。

真需要给 spec 加一个新字段(现有字段表达不了你这个 CLI)时,**先提问**(`ask_question`)—— `types.ts` 是 15 个人的共享文件,谁都可以自己加一个字段,合起来就是 15 版互相冲突的类型。

## 怎么校准

1. **先看它自己怎么说**:`<bin> --help`、`<bin> <子命令> --help`,官方 docs 只作参考(文档滞后于 CLI 是常态)。
2. **手动跑通一次非交互回合**,在一个 throwaway 目录里:
   ```bash
   cd /tmp && mkdir -p probe && cd probe
   <bin> <你写进 spec 的那串参数> # prompt 用「创建 hello.txt,内容 hi」这种可验证的
   ```
   看三件事:①有没有卡在交互确认(卡住 = 自动批准的 flag 没给对,ash 里会表现为任务永远不结束);②有没有真的动文件;③stdout 长什么样(决定 parser)。
3. **把实测结果写进 spec**,去掉 `untested`,`notes` 改成「实测于 <日期> + 版本号 + 仍未确认的点」。**没实测通就别去掉 `untested`** —— 那个标记是给用户看的诚实声明,不是待办勾选框。
4. **跑测试**:
   ```bash
   npx tsc -p server/tsconfig.json --noEmit     # typecheck(必须干净)
   npm -w server run test:cli-catalog           # 目录机制的回归测试
   ```
   > worktree 里 typecheck 报 `@ash/shared` 是旧类型的话,说明该 worktree 没有自己的 `node_modules`(会走到主仓那份)。补一次软链即可:
   > `mkdir -p node_modules/@ash && for p in shared server web mcp; do ln -sfn ../../$p node_modules/@ash/$p; done`

---

## spec 字段逐条说明

### 检测与展示

```ts
export const fooSpec: CliSpec = {
  key: "foo",              // = AgentType,前端拿它做 key;与文件名、SPECS 的键必须一致
  name: "Foo CLI",         // 展示名
  description: "谁家的什么 CLI",  // 中文一句话,卡片副标题
  bins: ["foo", "foo-cli"],// 候选命令名,按顺序探测,第一个探到的算数
  fallbackVersionMatch: "foo",   // 仅备用 bin(bins[1..])需自证:--version 输出须含这个词
  docsUrl: "https://…",
  installCommand: "npm install -g foo",  // 官方原文(POSIX 侧),只给用户复制,服务端永不执行
  installCommandWindows: "irm https://…/install.ps1 | iex",  // 三态,见下;`npm -g` 那种跨平台的不写
  windowsNote: "需要先装 Git for Windows",   // Windows 上的前提/限制,一句话;只发给 Windows 宿主
  untested: true,          // 执行参数按文档写、本机未实测
  notes: "待核实:…",       // 未定的点、踩过的坑。标了 untested 就必须写(测试会拦)
  exec: { … },
};
```

**`bins` 是踩坑核对过的,别顺手改**:产品名和终端里敲的那个词经常对不上(`trae` → `traecli`、`qoder` → `qodercli`、`kiro` → `kiro-cli`、cursor 官方现在的 bin 叫 `agent`)。改它要有实测依据,并在注释里写清依据是什么。

**安装命令是按平台发的**:`detect.ts` 的 `installCommandFor` 按**跑 server 那台机器**的平台在两条里挑一条,界面上只出现能用的那条(浏览器在哪个系统上开的不算数 —— CLI 要装在服务端那台)。`installCommandWindows` 三态:

| 取值 | 含义 |
|---|---|
| 不写 | `installCommand` 本身跨平台(`npm install -g …`),两边同一条 |
| 字符串 | Windows 专用那条(PowerShell / winget / choco…),**官方原文照抄** |
| `null` | 官方没有 Windows 版。发出去的安装命令是空串,`windowsNote` 就是用户看到的唯一理由,**不能空**(测试会拦) |

半数 CLI 的 `installCommand` 是 `curl … | bash`,原样端给 Windows 用户就是一条注定跑不通的命令 —— 所以测试还会拦「Windows 侧发 POSIX 命令」。

**Windows ARM64 的产物可用性(2026-08-14 逐家读了官方安装脚本,结论记在这里省得再查一遍)**:装原生二进制的那几家里,只有 **kiro** 写死 `kiro-cli-x86_64-pc-windows-msvc.msi`、manifest 过滤也钉在 `x86_64`,全程没有架构探测 —— ARM 机器上只能走 x64 模拟,它的 `windowsNote` 已经如实标了。其余都会在运行时取 arm64 产物:grok 把 `ARM64` 映射成 `aarch64` 拼 `windows-aarch64` 资产名,antigravity 直接请求 `/manifests/windows_arm64.json`,cursor 用 WMI 的 `SystemType` 拼 `…/windows/arm64/agent-cli-package.zip`,kimi 算出 `win32-arm64` 再查服务端 manifest(这几家若上游没传对应产物会自己报错,不是我们能兜的)。opencode 走 `npm install -g opencode-ai`,和 claude/codex/gemini/copilot/qwen/kilo/qoder/pi 一样是纯 JS,无架构差异。

`fallbackVersionMatch` 存在的原因:`agent` 这种通用名在本机实测里命中的其实是 grok —— 备用名不自证身份就会把别家的命令连版本号一起认成自己。

**候选顺序对执行也生效**:检测和执行共用 `probeBins`/`execBinFor`(`server/src/executors/bin-probe.ts`)—— 主 bin 不在本机、备用名可用时,派任务会自动用那个备用名(以前执行侧死认 `bins[0]`,于是「目录显示可用、派任务 ENOENT」)。

### 执行(`exec`)

```ts
exec: {
  subcommand: ["run"],                  // 一次性非交互运行的子命令,多数 CLI 没有
  baseArgs: ["--yolo", "--output-format", "json"],  // 每次都带:非交互 / 自动批准 / 输出格式
  prompt: { via: "flag", flag: "-p" },  // prompt 怎么传,见下
  model: { flag: "-m" },                // 缺省 = 该 CLI 不支持指定模型
  reasoningEffort: { flag: "--effort" },// 缺省 = 没有这个概念
  fastArgs: ["--fast"],                 // 1.5x 加速档;缺省 = 无此概念,profile 的 speed 被忽略
  session: { … },                       // 会话延续,见下
  parser: myParser,                     // 缺省 = textParser(保守:stdout 逐行当正文)
  relay: (r) => ({ … }),                // 供应商注入;缺省 = 挂了供应商也走官方账号
}
```

装配顺序(`generic.ts` 的 `plan()`):
`subcommand` → `baseArgs` → 会话参数 → `model` → `reasoningEffort` → `fastArgs` → `relay.args` → profile 的固定参数 → 本次调用的 `extraArgs` → prompt。
同 flag 时多数 CLI 取最后一个,所以用户自带参数排在最后(能覆盖 spec)。**凑不出这个顺序的 CLI**(比如 codex 要求 exec 选项排在 `resume` 子命令之前)得写自定义 `factory`。

**prompt 的三种传法**

```ts
prompt: { via: "stdin" }                  // 写进 stdin 后关掉(最稳:不撞 argv 长度上限、不用转义)
prompt: { via: "stdin", stdinArg: "-" }   // 同上,但 CLI 需要一个占位位置参数表示「从 stdin 读」
prompt: { via: "arg" }                    // 作为最后一个位置参数
prompt: { via: "flag", flag: "-p" }       // 作为某个 flag 的值
```

优先选 `stdin`(如果 CLI 支持):任务正文经常上千字,还带引号和反引号。

**值型参数的两种写法**

```ts
model: { flag: "--model" }                  // → --model opus
model: { flag: "--model", style: "equals" } // → --model=opus
reasoningEffort: (v) => ["-c", `model_reasoning_effort="${v}"`]  // 拼不出来的自己返回 argv
```

**会话延续(`session`)** —— 三档语义,按你的 CLI 实际能力选一档,**别硬凑**:

```ts
// (a) 整个 session 字段不写 = 没有 resume 通道。
//     ash 会忽略 RunOpts.sessionId、生成一个新 sessionId 仅作追溯,
//     恢复命令给一句诚实说明。续聊时 agent 记忆是断的 —— 这是事实,不是 bug。

// (b) ash 自己发 id(claude 的 --session-id):最省事,textParser 也能续跑
session: {
  newIdFlag: "--session-id",
  resumeArgs: (id) => ["--resume", id],
  interactive: (id) => `foo --resume ${id}`,   // 给人复制粘贴的交互式命令,别带 cd(外层会包)
}

// (c) id 由 CLI 自己产生:必须让 parser 发 {kind:"session", cliSessionId} 把 id 带回来,
//     否则 ash 拿不到 id,永远起新会话
session: { resumeArgs: (id) => ["resume", id], interactive: (id) => `foo resume ${id}` }
```

**只写 `interactive` 是无效的**(第 1 轮审查抓到过):没有 `newIdFlag` 也没有 `resumeArgs` 时,ash 手里那个 id 是它自己发的运行记录,CLI 压根没听说过 —— 拿它拼 `--resume <id>` 就是给用户一条引用不存在会话的命令。所以 `interactiveResumeInner`(`executors/generic.ts`)会判定它不可信、退化成诚实说明,`interactive` 等于白写。知道该 CLI 有 `--resume` 但还没查清 id 从哪来时,就走 (a) 档、把线索写进 `notes`。

**供应商注入(`relay`)** —— **密钥绝不能进 argv**(`commandLine` 会存进 `sessions.command_line` 并在 UI 展示):

```ts
relay: (r) => ({
  env: { FOO_BASE_URL: relayRoot(r.baseUrl), FOO_API_KEY: r.apiKey },  // key 只走这里
  args: ["--provider", "custom"],          // 只放非密文
  envHint: `FOO_BASE_URL=${relayRoot(r.baseUrl)} FOO_API_KEY=<你的key> `, // 恢复命令的 env 前缀,token 占位
})
```

地址一律过 `relayRoot()` / `relayApi()`(`server/src/llm.ts`)归一,别自己拼字符串 —— 库里那份可能已经带了 `/v1`,硬拼会打到 `/v1/v1`。不确定这个 CLI 怎么接供应商就**别写 `relay`**:不写 = 挂了供应商也用 CLI 自己的官方账号跑,比拿半截配置去撞一个必然 401 的端点好。

### 输出解析(`parser`)

优先级:**有结构化输出就用它,没有就留 textParser**。

- `textParser`(缺省):stdout 逐行当 assistant 正文,非 0 退出报错。看不到工具调用和思考过程,但不会把任何东西错报成正文。
- `claudeStreamJsonParser`(`./parsers.js`):claude 那套 `--output-format stream-json --verbose`(文本增量 + `tool_use` + `session_id` + `result`)。**只在该 CLI 确实输出同一套 schema 时用** —— claude Code 的 fork 常常连输出格式一起继承,那时能直接白嫖工具调用与流式文本;schema 不一样会一行都解析不出来,比 textParser 还差。
- 自己写:**内联在自己的 spec 文件里**(别加到 `parsers.ts`,那是共享文件)。骨架照抄下面这份:

```ts
import type { AgentEvent } from "@ash/shared";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser } from "./types.js";

// 事件流必须**一定**以 { kind: "done" } 收尾。少一个 done,run loop 就永远等下去:
// 任务卡在 running、stop 返回成功却停不掉、再发消息被 409 挡回,只有重启能解。
const fooParser: CliParser = async function* (ctx) {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const push = (e: AgentEvent) => { queue.push(e); resolve?.(); resolve = null; };

  const rl = createInterface({ input: ctx.child.stdout! });
  rl.on("line", (line) => {
    ctx.trace && undefined;            // 原始事件想落盘就照 parsers.ts 用 RunTraceRecorder
    const ev = JSON.parse(line);       // 解析失败要 try/catch 掉,别让一行脏数据炸掉整个回合
    if (ev.type === "session") push({ kind: "session", cliSessionId: ev.id });
    else if (ev.type === "text") push({ kind: "text", text: ev.text });
    else if (ev.type === "tool") push({ kind: "tool", name: ev.name, detail: ev.detail });
  });

  const finish = (exitStatus: number, err?: string) => {
    if (finished) return;
    finished = true;
    // 手停(ctx.lifecycle.stopRequested)不算故障,别往时间线塞错误
    if (err && !ctx.lifecycle.stopRequested) push({ kind: "error", message: err });
    push({ kind: "done", exitStatus });
    resolve?.(); resolve = null;
  };
  // 三条路都要收口:spawn 失败 / close / exit 后流不收尾
  ctx.child.on("error", (e: NodeJS.ErrnoException) => finish(1, spawnErrorMessage(ctx.bin, e)));
  ctx.child.on("close", (code, sig) => finish(code ?? (sig ? 1 : 0)));
  forceFinishOnExit(ctx.child, () => finished, (exit) => finish(exit, "输出流未正常收尾,已强制结束本回合"));

  while (true) {
    if (queue.length) { yield queue.shift()!; continue; }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
};
```

三条硬约束(踩过坑,`server/CLAUDE.md` 与 `docs/incidents.md` 有原委):

1. **parser 必须是惰性 async generator,且不能抢在被订阅前 emit `'error'`**。预检失败(bin 不在 PATH、cwd 没了)时 `spawnAgent` 返回的是一个「一有人监听就报错」的假 child;抢跑的 `'error'` 没有监听者,EventEmitter 会升级成 uncaughtException,被运行期兜底一吞,任务就永远卡在 running。
2. **事件流一定要以 `done` 结束**(见上面注释)。
3. **手停不报错**:`ctx.lifecycle.stopRequested` 为 true 时是用户按了停止,不是故障。

### `factory`(自定义执行器)

`exec` 表达不了的(claude 的常驻会话、codex 的每回合失败证据链)才写 `factory`:

```ts
factory: (opts) => new FooExecutor(opts),
```

有 `factory` 时 `exec` 只作说明与 resume 展示之用(改专用类记得同步 `exec`)。**`openResident` 只有 claude 有,别给别人加**:团队模式「谁能当调度者」的过滤就是靠这个方法存在与否,加一个假的等于让一堆跑不了常驻会话的 CLI 出现在调度者下拉里。

---

## ash MCP 登记矩阵(2026-10-31)

**为什么这张表要紧**:ash 的完成协议整个建立在 ash MCP 上(`complete_task` / `ask_question` /
`pause_task` / `report_stage`)。一家 CLI 接不上它,用它跑的任务干完活也交不了卷,界面上只看得到
「失败」—— 用户 2026-10-30 实测到的就是这个:claude / codex 之外的十三家压根没有注册逻辑。

**claude / codex 不靠这张表**(2026-11-14 起):起跑时由 ash 把自己的 MCP 注入进去,连没连上
以 CLI 启动时自己报的为准(`executors/ash-mcp-inject.ts`)。表里这两行只在独立 app 首启替本机
CLI 接 ash 那一下用得到;其余十三家的退路仍是它们自己配置里的登记。

**表本体是代码,不是这段文字**:`server/src/mcp-registry/catalog.ts`(`satisfies Record<AgentType,…>`
保证新增执行器时编译不过,逼着当场给结论)。下面这张是给人读的同一份内容,
`npm -w server run test:ash-mcp-registry` 会逐行比对它和代码里那张表,对不上就红。

| 执行器 | ash 自动写? | 落点(用户级) | 配置目录变量 | 格式族 | 回合身份 | 档位 |
|---|---|---|---|---|---|---|
| claude | 是 | `<配置目录>/.claude.json` | `CLAUDE_CONFIG_DIR` | `mcpServers` JSON | 原样继承 | 实测 |
| codex | 是 | `$CODEX_HOME/config.toml` | `CODEX_HOME` | `[mcp_servers.x]` TOML | 要声明(`env_vars`) | 实测 |
| gemini | 是 | `<配置目录>/.gemini/settings.json` | `GEMINI_CLI_HOME` | `mcpServers` JSON | 原样继承(按**变量名**过滤) | 实测 |
| grok | 是 | `$GROK_HOME/config.toml` | `GROK_HOME` | `[mcp_servers.x]` TOML | 未验 | 实测 |
| kimi | 是 | `$KIMI_CODE_HOME/mcp.json` | `KIMI_CODE_HOME` | `mcpServers` JSON | 未验 | 实测 |
| opencode | 是 | `~/.config/opencode/{config,opencode}.json[c]` + `~/.opencode/` | `OPENCODE_CONFIG`(指文件) | `mcp` JSON | 原样继承 | 实测(含端到端) |
| cursor | 是 | `~/.cursor/mcp.json` | 无 | `mcpServers` JSON(要 `type`) | 未验 | 未实测 |
| qwen | 是 | `$QWEN_HOME/settings.json`(默认 `~/.qwen/`) | `QWEN_HOME`(**就是配置目录**) | `mcpServers` JSON | 未验 | 未实测 |
| qoder | 是 | `~/.qoder/mcp.json` | 无(`QODER_CONFIG_DIR_NAME` 换目录名) | `mcpServers` JSON | 未验 | 未实测 |
| copilot | 是 | `$COPILOT_HOME/mcp-config.json` | `COPILOT_HOME` | `mcpServers` JSON(`type: local`) | 走 PATH 上那份文件(只继承 PATH) | 未实测 |
| kiro | 是 | `~/.kiro/settings/mcp.json` | 无 | `mcpServers` JSON | 未验 | 未实测 |
| kilo | 是 | `~/.config/kilo/kilo.json[c]` | `KILO_CONFIG`(指文件) | `mcp` JSON | 未验 | 未实测 |
| antigravity | 是 | `~/.gemini/config/mcp_config.json` | 无 | `mcpServers` JSON | 未验 | 未实测 |
| pi | 是 | `$PI_CODING_AGENT_DIR/mcp.json`(默认 `~/.pi/agent/`) | `PI_CODING_AGENT_DIR` | `mcpServers` JSON | 原样继承 | 未实测 |
| trae | 是 | `~/.trae/mcp.json` | 无 | `mcpServers` JSON | 未验 | 未实测 |

**「档位」只有两档**,判据是**本机有没有真 CLI 可问**:实测 = 拿真 CLI 在沙盘配置目录里写过/读过
一遍;未实测 = 只查了官方文档或发布包源码(逐家的出处写在代码那张表的 `source` 里)。没有第三档。

**哪些坑必须知道**(完整版在代码里逐条的 `notes` / `caveat`):

- **gemini 两道门**。① 未信任的目录连**用户级** MCP server 都不加载 —— 所以 `gemini.ts` 的
  `baseArgs` 带 `--skip-trust`,别去掉;② 它把交给 MCP 子进程的环境按**变量名**过滤(命中
  `/TOKEN|KEY|SECRET|AUTH/i` 一类的直接删),于是回合身份 `ASH_TURN_TOKEN` 根本到不了子进程 ——
  这就是为什么 `shared/src/mcp.ts` 另按 `*_TICKET` 别名导了一份(用只 dump 环境的假 MCP server 取证)。
- **启停策略一家一家认,不跨家套用**(机制上的 `switches`,2026-10-31 两边真机实测):
  - **grok 有两种关法**:条目上的 `enabled = false`,和根级 `disabled_mcp_servers = ["ash"]`
    (`grok mcp list` 打出 `(disabled)`);
  - **同样写 TOML 的 codex 压根不认那个根级键**(`codex mcp list --json` 仍是
    `enabled: true, disabled_reason: null`)—— 所以它**不许**声明 `switches`。上一版两家共用
    格式族、无条件解释那个键,给 grok 关一次 ash 会把 codex 这条能用的连接也判成「被关掉了」,
    安装器还说是用户自己关的;
  - **gemini 还有两个根级名单**:`mcp.excluded` 列着 ash、或 `mcp.allowed` 这个白名单里没有
    ash(**空数组也算「一个都不放行」**),真 CLI 把那条登记直接打成 `⛔ Blocked`。所以它
    **压根没登记时也要如实说「被挡住了」**(没登记的名字里只问规范名 —— 历史名 `harness` 不在
    白名单里是常态,拿它判会把一份完全可用的配置说成关着的),而且绝不替用户改那两个名单。
  格式族只负责**结构读取**:条目上那两个布尔之外的开关一律由逐家声明进来(本轮审查 F2)。
- **kimi 没有 `mcp` 子命令**(`kimi mcp add` 报 unknown command),只能我们写文件,也就没法拿它
  自己的输出复核。
- **opencode 会读好几份配置,判的是「几份合起来最终生效的那一条」**(真 CLI 逐格实测,全部
  记在那家的 `source` 里)。**六层**来源,优先级从低到高:默认目录(`config.json` <
  `opencode.json` < `opencode.jsonc`,**三份都读**;`config.json` 这个名字**只在默认目录**算)、
  `OPENCODE_CONFIG` 指的那个文件、任务目录往上走的项目配置、`~/.opencode/`(`opencode.json` <
  `opencode.jsonc`,**压过上面那几层**,站点上的 `extraDirs`)、`OPENCODE_CONFIG_DIR` 再加的
  那个目录、`OPENCODE_CONFIG_CONTENT` 里那整段 JSON(**只读,没有文件可写**)。合并是**逐字段深合并**:低的那份写完整登记、高的那份只写
  `{"enabled": false}` ⇒ 命令留着、开关被关掉(真 CLI 报 `ash disabled`);嵌套的
  `environment` 按键合、数组整条替换。所以判据只能是 `resolveAshMcp`
  (`mcp-registry/register.ts`),而且必须是**合完那一条**——「任一份里有就算有」会把已经被
  关掉的说成已接好;「只看写入目标那一份」会把本来连得上的判成 absent;
  「挑一份赢家」会把跨来源继承来的启动命令整个丢掉(高优先级那份只写 `{"enabled": true}` 时,
  搬进隔离档的就只有这一个键,真 CLI 在那边一个服务都没有)。这件事由站点上的 `sourcesMerge`
  声明 ——它同时表示**加载序**和**逐字段合并**语义都实测过,**只给实测过的家置真**;kilo 的
  `KILO_CONFIG` 形状一样但没真 CLI 可问,几份来源结论不一致时判定一律回 unknown(不写)。合并还有三条实测约束,少一条就会把「连得上」和「连不上」算反:
  ① **逐份投影**:条目是三支并集,没写 `type` 的那一支只认 `enabled` —— 哪一份来源写成开关就
  只贡献这一个键(低的那份、高的那份都一样),所以投影做在 `shapes.ts` 的 `opencodeFact` 里、
  `mergeFacts` 两边一视同仁;只过滤高的那份会让低那份里本该被丢掉的 `environment` 活下来,
  搬进隔离档后真 CLI 报 `MCP error -32000: Connection closed`。
  ② **阶段才是单位**:同一个文件被两条路指到(`OPENCODE_CONFIG` 指回默认目录那份)算两次
  加载,`ashMcpHostSources` 不按路径去重 —— 去重会把优先级最高的那次加载整个删掉,实测把一条
  `connected` 的登记判成 disabled、落点还指错。
  ③ **任何一份读不通就整份拒载**:实测 `debug config --pure` 直接 `exit 1`(不管那份在哪一层、
  有没有提到 ash),所以 `resolveAshMcp` 只要见到一份读不准就回 unknown,不能靠「优先级比它低
  的影响不到」放行 —— 那时压根没有生效的登记可言。
  来源**入口**那一侧还有两条(本轮审查 F1,三行实测里真 CLI 全是 `ash connected`、而 ash 答
  absent 并据此硬拒、安装器还新写一条把生效 `ASH_URL` 换掉了):
  ④ **指到文件的变量给相对路径时按 CLI 自己的工作目录解** —— 所以 `ashMcpHostSources` 吃一个
  `cwd`:知道那个目录就解准,不知道就把这份来源标成**证不出来**(`AshMcpSource.unprovable`),
  整体回 unknown(不写,也永不当写入落点)。
- **opencode / kilo 不是 `mcpServers` 那一族**:容器叫 `mcp`、`command` 是整条 argv 数组、环境
  变量键叫 `environment`。
- **antigravity 别和 gemini 搞混**:两家都住 `~/.gemini` 下,但 gemini 读 `settings.json`、
  antigravity 读 `config/mcp_config.json`,互不相认。
- **pi 看版本**:MCP 是 1.x 才有的,本机装的 0.83.0 整个产物里一个 MCP 入口都没有 —— 那种版本下
  登记写了也没人读。
- **kiro 依据最弱**:官方文档把配置位置按 IDE / CLI / Web 分页签,只抓到 IDE 那一份;`kiro-cli`
  读不读它没有第二处证据。
- **copilot 的身份搭 `PATH` 那班车**:官方文档明写「`PATH` 自动继承,其余环境变量必须配在这条登记的
  `env` 里」,而回合身份一轮一个值 —— 写死进配置文件就是过期的假身份。所以身份改走**一份文件**:
  ash 每回合在 `<runs>/<taskId>/turn-identity/<turnToken>/identity.json` 写一份、把那个目录追加到
  `PATH` 末尾(目录里没有可执行文件,盖不掉任何命令),MCP 侧在变量都不在时读它
  (`@ash/shared/mcp` 的 `ASH_TURN_IDENTITY_PATH_DIR` 是约定本体,两侧实现在
  `server/src/turn-identity.ts` 与 `mcp/src/runtime.ts`,回归在 `test:turn-identity`)。
  **按回合开目录、开新的就删旧的**:上一回合的残留子进程读到的是空,而不是当前令牌。
  表里 `identity: "path"` + `caveat` —— 这条桥本机没装 copilot、没法实测,万一它连 `PATH` 也改写,
  表现就回到「交卷被拒」。另外 `--config-dir` 旗标优先于 `COPILOT_HOME`,起跑带了它这条判据会错。
- **trae 写的是它「另外支持的那种格式」**:原生 `~/.trae/traecli.yaml` 是 YAML(`mcp_servers` 对象
  数组、`env` 是 `{key,value}` 列表),本仓没有保得住注释缩进的 YAML 写入器;但它同样扫描标准
  `mcpServers` JSON(`~/.trae/mcp.json`),所以走后者。**同目录出现 `traecli.yaml` / `mcp.yaml` /
  `.mcp.yaml` 时一个字都不写、也不下结论**(`site.opaque`):ash 可能已经被写在那里面了,而同名登记
  同时来自两份配置、谁生效没有文档依据。项目里的 `.trae/mcp.json` 是用户仓库文件,ash 不碰。

**「回合身份」那一列的几种值**:原样继承 = ash 起跑时注进 CLI 进程就够了;要声明 = 得在登记里放行
变量名(codex 的 `env_vars`,按回合用 `-c` 给,不写进配置文件);走 PATH 上那份文件 = CLI 只自动继承
`PATH`(copilot),身份改走一次性目录里的 `identity.json`,登记里一个身份字段都不用写。还留着一档
**送不进去**(`blocked`)当判据,现在空着:下一家若连 `PATH` 都过滤就落它,那一家登记写对了也交不了卷,
表里必须配 `caveat` 当场说出来。

**改这张表要同时改三处**:`mcp-registry/catalog.ts`(单源)、`scripts/mcp-host-sources.mjs`(安装时
那份裸 Node 实现,setup 导不进 TS)、本节表格。三处不一致时 `test:ash-mcp-registry` 会红 —— 它逐项比对
路径、变量、格式族、要不要 `type`/`enabled`,以及本节每一行的档位。

---

## 自检清单(交活前逐条对)

- [ ] `npx tsc -p server/tsconfig.json --noEmit` 干净
- [ ] `npm -w server run test:cli-catalog` 通过
- [ ] 新执行器在「ash MCP 登记矩阵」里有一行(代码那张表会编译不过;本节表格由
      `npm -w server run test:ash-mcp-registry` 逐行核对)
- [ ] 只改了自己的 spec 文件 + `shared/src/cli-presets.ts` 里自己 type 的两行(`git status` 确认)
- [ ] 实测通过才去掉 `untested`;没通过就把结论写进 `notes`(包括「这个 CLI 不支持非交互,当不了执行器」这种结论 —— 如实说比留个跑不动的配置有用)
- [ ] `notes` 写了版本号和实测日期
- [ ] 命令行里没有任何密钥(key 只走 `relay.env`)
