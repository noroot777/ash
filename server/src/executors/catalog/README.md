# 智能体目录(catalog)

harness 能派任务的 CLI 全部登记在这个目录里,**一个 CLI 一个 spec 文件**。这份 spec 同时喂三条链路:

| 链路 | 用到的字段 | 出口 |
|---|---|---|
| 检测与展示 | `key` / `name` / `description` / `bins` / `fallbackVersionMatch` / `docsUrl` / `installCommand` / `untested` / `notes` | `server/src/detect.ts` → `GET /api/agents/catalog`、`GET /api/agents/detect` |
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
   看三件事:①有没有卡在交互确认(卡住 = 自动批准的 flag 没给对,harness 里会表现为任务永远不结束);②有没有真的动文件;③stdout 长什么样(决定 parser)。
3. **把实测结果写进 spec**,去掉 `untested`,`notes` 改成「实测于 <日期> + 版本号 + 仍未确认的点」。**没实测通就别去掉 `untested`** —— 那个标记是给用户看的诚实声明,不是待办勾选框。
4. **跑测试**:
   ```bash
   npx tsc -p server/tsconfig.json --noEmit     # typecheck(必须干净)
   npm -w server run test:cli-catalog           # 目录机制的回归测试
   ```
   > worktree 里 typecheck 报 `@harness/shared` 是旧类型的话,说明该 worktree 没有自己的 `node_modules`(会走到主仓那份)。补一次软链即可:
   > `mkdir -p node_modules/@harness && for p in shared server web mcp; do ln -sfn ../../$p node_modules/@harness/$p; done`

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
  installCommand: "npm install -g foo",  // 官方原文,只给用户复制,服务端永不执行
  untested: true,          // 执行参数按文档写、本机未实测
  notes: "待核实:…",       // 未定的点、踩过的坑。标了 untested 就必须写(测试会拦)
  exec: { … },
};
```

**`bins` 是踩坑核对过的,别顺手改**:产品名和终端里敲的那个词经常对不上(`trae` → `traecli`、`qoder` → `qodercli`、`kiro` → `kiro-cli`、cursor 官方现在的 bin 叫 `agent`)。改它要有实测依据,并在注释里写清依据是什么。

`fallbackVersionMatch` 存在的原因:`agent` 这种通用名在本机实测里命中的其实是 grok —— 备用名不自证身份就会把别家的命令连版本号一起认成自己。

**候选顺序对执行也生效**:检测和执行共用 `probeBins`/`execBinFor`(`server/src/executors/bin-probe.ts`)—— 主 bin 不在本机、备用名可用时,派任务会自动用那个备用名(以前执行侧死认 `bins[0]`,于是「目录显示可用、派任务 ENOENT」)。例外是 ssh 目标:候选探测查的是本机 PATH,拿本机结果决定远端命令名只会更错,所以 ssh 一律用 `bins[0]`。

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
//     harness 会忽略 RunOpts.sessionId、生成一个新 sessionId 仅作追溯,
//     恢复命令给一句诚实说明。续聊时 agent 记忆是断的 —— 这是事实,不是 bug。

// (b) harness 自己发 id(claude 的 --session-id):最省事,textParser 也能续跑
session: {
  newIdFlag: "--session-id",
  resumeArgs: (id) => ["--resume", id],
  interactive: (id) => `foo --resume ${id}`,   // 给人复制粘贴的交互式命令,别带 cd(外层会包)
}

// (c) id 由 CLI 自己产生:必须让 parser 发 {kind:"session", cliSessionId} 把 id 带回来,
//     否则 harness 拿不到 id,永远起新会话
session: { resumeArgs: (id) => ["resume", id], interactive: (id) => `foo resume ${id}` }
```

**只写 `interactive` 是无效的**(第 1 轮审查抓到过):没有 `newIdFlag` 也没有 `resumeArgs` 时,harness 手里那个 id 是它自己发的运行记录,CLI 压根没听说过 —— 拿它拼 `--resume <id>` 就是给用户一条引用不存在会话的命令。所以 `interactiveResumeInner`(`executors/generic.ts`)会判定它不可信、退化成诚实说明,`interactive` 等于白写。知道该 CLI 有 `--resume` 但还没查清 id 从哪来时,就走 (a) 档、把线索写进 `notes`。

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
import type { AgentEvent } from "@harness/shared";
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

## 自检清单(交活前逐条对)

- [ ] `npx tsc -p server/tsconfig.json --noEmit` 干净
- [ ] `npm -w server run test:cli-catalog` 通过
- [ ] 只改了自己的 spec 文件 + `shared/src/cli-presets.ts` 里自己 type 的两行(`git status` 确认)
- [ ] 实测通过才去掉 `untested`;没通过就把结论写进 `notes`(包括「这个 CLI 不支持非交互,当不了执行器」这种结论 —— 如实说比留个跑不动的配置有用)
- [ ] `notes` 写了版本号和实测日期
- [ ] 命令行里没有任何密钥(key 只走 `relay.env`)
