# Harness 设计纪要

> 经一轮逐项 grill 后达成的共识。记录"决定了什么"和"为什么"，作为后续实现的依据。
> 范围：前期 Web 版。原需求点 5（5h 限额检测/挂起恢复）已删除。

## 一、执行模型（点 0）

- **驱动真实 CLI 子进程**：把 `claude`、`codex`、`antigravity` 等真实 CLI 以 headless 模式当子进程拉起，解析其流式输出（stream-json）。
- **靠订阅额度**跑（Claude Pro/Max、ChatGPT 订阅），不走 API key 计费。
- 这些 CLI 本身已是完整 agent（自带 agent loop / 工具 / sandbox）；本系统是它们之上的**编排层（control plane）**，不重造 agent。
- **本地 vs 远程统一为"执行目标（target）= 一个 shell 环境"**：本地直接 spawn，远程 `ssh host "cd repo && <cli> ..."`，对编排层完全一致。

## 二、拓扑

- **常驻本地后端 + 浏览器前端**（非纯静态 web）：后端是 harness 核心，负责 spawn 进程、管队列、存状态、跑 ssh；浏览器只是界面。
- 部署上先做**单机**；架构上 orchestrator / executor 两个模块分离，便于以后扩展。
- 远程 = ssh 跑命令（不做 worker 注册/心跳那套分布式）。

## 三、数据模型与层级

- 三层：**`Project → Group → Task`**。
- **Group**：定位为**临时、同质批次容器**（如把同一活儿并行扇出到多个目标/多方案），用完即弃。**不持久、不可定时。**
  - `Group.mode: parallel | serial`（点 1）
  - `Group.useWorktree: bool = true`（见下）
- **Task**：工作单元。预留 `parentId`（暂不做子任务）。复杂顺序用"组内 serial 顺序 + 跨任务 `dependsOn` 依赖边"表达，不做无限嵌套。
- **持久反复的工作 → 单个 Task（带定时）；一次性并行扇出 → Group。**

## 四、隔离单元（Task 运行时）

- **默认 git worktree 隔离**：Task 跑前自动 `git worktree add` 出独立工作区 + 分支，agent 在自己 worktree 改，产出独立分支/diff。并行天然安全。远程 ssh 同样适用。
- worktree 开关在 **Group 级**，默认开。纯执行/只读任务可关；可能改动但不想要改动时，指令 agent "只提意见不修改"。
- 跑完的合并方式**可选，默认自动**（自动合并/提交）。

## 五、Agent 抽象（点 0 / 2 / 3 共用）

两级模型：

```
抽象层（交互对象）          执行层（真正跑的 executor）
claude       ──┬──→  claude@本地·opus      (默认执行者)
               └──→  claude@devbox·opus
codex        ──┬──→  codex@本地·gpt-5
               └──→  codex@远程·gpt-5
antigravity  ─────→  antigravity@本地
```

- **你 `@`、debate 选辩手，选的都是"类型"**（claude / codex / antigravity）。
- 类型 → 执行者解析：在"智能体列表"里为每个类型设一个**默认执行者**。
- "按负载自动挑同类最闲的" = 以后的增强，初期不做。
- 高级用法仍可显式指定执行者（`@claude@devbox`）。

### Executor 适配器接口（手搓，见点 7）

```ts
interface AgentExecutor {
  run(prompt, opts: { sessionId?, worktree?, target? }): AsyncIterable<Event>
  // Event: thinking / text / tool / done；done 带 newSessionId 供下一轮 resume
}
// 每种 CLI 一个实现：ClaudeExecutor / CodexExecutor / AntigravityExecutor
// 负责：拼命令行、本地 spawn 或 ssh、解析 stream-json、抽取/续接 session id
// 多轮 resume / 共识检测 / 重试等逻辑可借鉴现有 cxc 脚本的经验
```

## 六、@ 指定（点 2）

- `@类型` 把任务派给某类型的默认执行者。是 `Task.mode = single` 的配置。

## 七、/debate 多智能体对抗（点 3）

### 形态
- **对称双辩手（两个平等 AI）+ 裁判 = 人（HITL 的 H，不是第三个 AI）。**
- **决策型辩论**：辩的是方案/判断，辩论本身产出"结论/共识"，不直接落代码。
- debate 是 **Task 的一种执行模式**：`Task.mode = single | debate`。debate 白嫖任务系统的分组/并行/定时/列表能力。

### 流水线
```
①两个AI辩论 → 〔门G1：共识门〕 → ②委派实现方在worktree实现 → 〔门G2：代码门〕 → ③提交
```

### 收尾规则（全自动无人时）
- **双方都举手（都声明同意）或 跑满轮数上限** → 收敛。
- **实现方**：配置里预设默认（默认辩手 A）。
- 有人监督时：人就是裁判，在门上拍板。

### HITL（门后人的动作集）
每个门可独立开关。门后动作：**`放行` / `打回终止` / `注入意见→回炉再辩` / `提问→答完继续`**。
- 全自动 = G1、G2 全关。
- **默认：G1（共识门）开、G2（代码门）关。**

### /debate 内联交互（重点打磨）
输入 `/debate ` 后浮出一行可 Tab 切换的槽位 chips，全部预填默认值：

```
议题:[__]  辩手A:«Claude»  辩手B:«Codex»  实现方:«辩手A»  轮数:«不设限»  共识门G1:«开»  代码门G2:«关»
```

- **Tab / Shift-Tab** 在槽位间前后移动，当前槽高亮。
- 停在某槽 → **弹出该槽候选**（辩手/实现方=agent类型列表；轮数=数字；门=开/关）。
- 弹出层内额外提供 **「设为默认」** 动作：改完并设默认后，下次 `/debate` 该槽预填新默认（槽位"当前值"与"默认值"分离）。
- 议题槽直接打字；**Enter** 用当前配置开跑；**Esc** 取消。
- 什么都不改直接 Enter = 用全部默认值开打。

## 八、任务管理（点 4，借鉴 Linear）

### 借鉴重点
- **主要取"交互手感"**：键盘优先、命令面板（Cmd-K）、快捷键、列表丝滑、`@`/`/` 内联。
- 组织模型**只取"状态 + 优先级 + 标签"**，不做 Cycle / 自定义工作流（单人驱动 agent，无需团队协作模型）。

### 状态机（7 态）
| 状态 | 含义 |
|------|------|
| `Backlog` | 草拟，未排期 |
| `Queued` | 就绪，等待调度（受组并行/串行、定时控制）|
| `Running` | agent 正在跑（debate 的轮次/谁在说作为子进度显示）|
| `Awaiting Review` | 卡在 HITL 门，等人处理（本系统核心特色状态）|
| `Done` | 成功完成（含已提交）|
| `Failed` | 出错/重试耗尽 |
| `Canceled` | 手动停 |

- `Awaiting Review` 显式建模"机器停下等人"，列表里一眼看到"哪些在等我"；门后四动作从此状态出发。

## 九、定时执行（点 6）

- **定时挂在 Task 上**（Group 是临时的，不可定时）。
- **一次性 + 循环（cron）都支持**，统一为 `{目标:task, 触发:时间点|cron, 启用}`，一次性跑完自停。
- 定时器**只负责把目标置 `Queued`**，之后复用正常并行/串行调度路径（不分叉）。
- **定时触发 = 全新一轮**：每次 cron/once 触发都新开一个 session 跑任务本体，**不接续上一次的 CLI 会话**。续接旧会话（`继续…`）只发生在「手动运行/重试/分组」的中断恢复，或「定时发消息（scheduledMessages → continueTask）」。否则每日 cron 会一直续昨天的对话，而不是每天新跑一次。
- **错过补跑**：一次性任务在后端重启时补跑一次；循环任务只跑最近一次、不堆积。
- 依赖常驻后端在线。

## 十、技术选型（点 7）

- **核心执行层手搓薄适配器**（上面的 `AgentExecutor` 接口 + 每 CLI 一个实现），**不用 Vercel AI SDK 的 Agent**。原因：
  1. 它是"进程内调模型 API 跑 agent loop"，与"驱动现成 CLI"层级不符，等于重造 CLI 已有能力。
  2. 它走 API key 计费，**直接冲突订阅额度前提**。
  3. 它抽象的是模型供应商 API，不是 CLI 程序，帮不到"接更多 CLI 智能体"——能统一 CLI 的是你自己的适配器接口。
- Vercel AI SDK 仅在将来需要"按 token 计费的辅助 LLM 小功能"（自动标题/总结 diff 等）时才考虑；因"裁判=人、不引入第三个 AI"，v1 几乎无此需求 → **v1 不引入。**

## 现有资产（参考，不复用其架构）

- `/Users/fjh/bin/cxc`（bash 辩论引擎）+ `cxc-web`（单文件 python http.server）：现有不成熟方案。
  - **流程/架构都重做**；但其趟过的坑可借鉴：codex `exec resume` / claude `--resume` 续接、session id 落盘、stream-json 解析、CLI 重试容错、HITL 门控、"实测对照(field)"形态。
  - 关键教训：cxc 把"流程编排"和"谁扮演什么角色"焊死（Codex 永远实现、Claude 永远审查+独占拍板），新系统须把角色与身份解耦、流程可配置。

## 十一、技术栈

- **形态：单后端进程托管前端静态资源的"一体"应用**（Flask/Spring Boot 那种心智，非 Next.js）。一个进程、一个仓、一条 `npm start`。
- **前端**：React + Vite + Tailwind（+ shadcn/ui，契合 Linear 式极简）。设计走 `/design-taste-frontend` 或 `/minimalist-ui`。`vite build` 产出静态文件由后端托管。
- **后端**：常驻 Node + TypeScript server，推荐 **Hono**（轻、TS 类型好、SSE/静态托管都简单；Fastify/Express 亦可）。它同时：①托管前端 `dist/`；②提供 API + SSE；③持有 orchestrator / scheduler / 子进程**单例**（长驻 server 是这种 daemon 的天然归宿）。
- **共享类型**：monorepo `shared/`，前后端共用 `Task`/`Event`/agent 档案等类型。
- **存储**：SQLite + **Drizzle**（schema 用 TS 定义、贴 SQL、零代码生成、轻；想更省心可换 Prisma，不影响架构）。长文本产物（每轮输出、diff）存文件，表里存路径。
- **实时**：**SSE**（服务端→前端推流式输出与状态），前端发指令走普通 POST。
- **约束**：本地自托管常驻，不上 serverless/edge。

## 十二、Debate 执行机制

核心：**两个 AI 从不直接对话；编排器是唯一信使 + 回合裁判。严格串行回合制。**

1. **回合推进**：编排器驱动子进程，靠 `AgentExecutor` 的 `done` 事件（子进程退出 / stream-json 最终 result）判定"对方说完"，必须等到 `done` 才发起下一棒。不会出现一方未完另一方启动。
2. **跨 agent 搬运**：B 看到 A 的输出，是因为编排器把 A 的输出**注入 B 这回合的 prompt**。两层记忆：
   - 会话续接（`--resume` / `exec resume`）→ 每个 agent 记得自己之前的发言。
   - 对手内容注入 → 只搬"对手自上次发言以来的增量"（旧发言已在各自会话里），省 token。
3. **盲态开局**：第 1 回合两边 prompt 都不注入对方内容（可并行跑这一回合）；第 2 回合起串行 + 注入。
4. **举手收敛**：双方被指令——认为可收敛就单起一行写约定标记（如 `[可收敛]`）。编排器每回合扫输出；**相邻回合双方都举手 → 收敛**；一方反驳则继续；到轮数上限强制收尾。
5. **容错**：每棒沿用 cxc 式重试（503/rate limit 等瞬时错误重试 N 次），到顶则 Task 置 `Failed`。
6. **前端**：A/B 输出经 SSE 边生成边推，按发言人分栏，回合号/谁在说/举手状态实时更新。

## 十三、可溯源凭证（Session / Execution 记录）

每次执行落一条记录，溯源单元是"会话（Session）"（session id 跨多轮 resume 复用）。

```
session = { id(内部uuid), taskId, role(辩手A|辩手B|实现方),
  agentType, executor, target(本地|ssh主机),
  worktreePath, branch, cliSessionId,   // 各 CLI 的 session/thread id = 核心凭证
  resumeCommand(自动生成), 命令全文, startedAt, exitStatus }
```

- 存 SQLite `sessions` 表。
- **复制以"整条可直接粘贴运行的 resume 命令"为主、原始 ID 为辅**（裸 ID 无用：需附带工具类型、resume 语法，尤其 `cd` 到当时的 worktree；远程自动带 `ssh` 包裹）：
  ```bash
  cd /path/.worktrees/task-123 && claude --resume 3f2a...
  ssh devbox "cd /repo/.worktrees/task-123 && codex exec resume 9b1c..."
  ```
- UI：任务详情里做成凭证 chip，主按钮"复制 resume 命令"、次按钮"复制原始 ID"。

## 十四、实现路线图（里程碑）

> 状态：M0–M6 全部完成并提交（见 git log）。下方为原计划，括注实测情况。

每个里程碑独立可跑、可验证，后一个建立在前一个之上。每完成一个里程碑 git 提交一次。

- **M0 · 项目骨架** ✅：monorepo（`server/` + `web/` + `shared/`）；Hono 后端托管 Vite+React+Tailwind SPA；SQLite（**libsql 驱动**，替换 better-sqlite3 以避开 Node 26 的 node-gyp 编译）+ Drizzle；`npm run dev` / `npm start` 跑通。
- **M1 · 单 agent 垂直切片** ✅：`AgentExecutor` + `ClaudeExecutor`；single 任务在自动 worktree+分支里跑；SSE 实时流；`sessions` 凭证（resume 命令）。e2e 验证。
- **M2 · 任务管理 UI（Linear 式）** ✅：状态分组列表、7 态、优先级 bar、标签、Cmd-K 命令面板、键盘导航（j/k/c/r）、Task/Group CRUD。
- **M3 · 分组并行/串行调度** ✅：`Group.mode`、`dependsOn` 边、调度器（并发上限+死锁兜底）、`CodexExecutor`。e2e 验证（claude+codex 并行）。
- **M4 · /debate 对抗** ✅：串行回合制编排器（盲态开局并行、A 先、举手收敛、轮数上限）；HITL 门 G1/G2 四动作（rendezvous）；实现方在 worktree 实现并提交；composer + Tab 槽位条（设为默认）；聊天式时间线（实时 + 持久 transcript 重建）。e2e + 浏览器验证。门暂停→继续未做现场实测。
- **M5 · 定时执行** ✅：挂 Task 的一次性 + cron（手写 5 字段匹配器）；tick 只入队复用运行路径；一次性补跑、cron 不堆积。e2e 验证。
- **M6 · 打磨** ✅：智能体注册表（agents 表 + 管理面板 + 默认执行者解析）；ssh 执行目标（prompt 走 stdin；本地验证，远程因无主机未实测）；data 目录归一到 `<repo>/data`；设计微打磨（抗锯齿/滚动条/选区）。antigravity 因本机无该 CLI，登记为类型但暂无解析器。


## 待后续决定（本轮未展开）
- `Event` 流的具体 schema 字段。
- 优先级/标签的具体取值。
- 各 CLI "举手"标记 / 流式输出格式的具体解析约定（claude / codex / antigravity 各一份适配）。
- worktree 自动合并的具体策略（fast-forward / squash / 冲突处理）。
```
