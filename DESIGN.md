# Harness 设计纪要

> **Harness 是一个编排多个本地 / 远程 CLI 编码智能体(claude / codex / antigravity…)跑任务的控制台**——"调度一群 agent 的那层"。
> 全部设计围绕一件事:**把一个想法,变成可被多个 agent 可靠执行、可溯源、可迭代的工作。**
> 状态:M0–M6 已实现(见 git log);标注「规划」的为方向。更新:2026-07。

---

## 0. 设计哲学(为什么这么设计)

**① 它是 harness-of-harnesses。**
业界说的 "harness" = 包在 LLM 外的运行时四要素:**agent loop / 工具接口 / 上下文管理 / 控制机制**。`claude`、`codex` 这些 CLI **本身已是完整 harness**(自带 loop / 工具 / sandbox)。本系统**不重造 agent**,而是驱动真实 CLI 子进程(headless,解析 stream-json),做它们**之上**的编排层。两个根本前提由此而来:**靠订阅额度跑(Claude Max / ChatGPT 订阅),不走 API key 计费;不用 Vercel AI SDK 的 Agent**(那是进程内调 API 跑 loop,既冲突订阅额度、又重造 CLI 已有能力)。真正的设计命题,是把四要素**上移一层**,在「多 agent 编排」尺度重做:编排循环 / 把 CLI·bash·git·MCP 做成可校验工具 / 跨任务知识 / 编排级验证门与预算。

**② 战场在编排层,不在单 agent 层。**
"换 harness 能把一般模型提到顶级"(SWE-bench 同模型不同 harness,5%→30%+)——但那增量全来自单 agent 下层的**工具设计 / 上下文工程 / 控制循环 / 验证循环,且是结构件、不在 prompt**。这层被 Claude Code 占据、且模型针对自家 harness 后训练,自己重做只会更差——**用 `claude`/`codex` 当 agent = 免费拿到它**。编排器**唯一能蹭的提分杠杆,是"上下文工程"的上移版**:给每个 task 注入对的项目知识(也正是全行业还空着的「跨任务知识」层)。

**③ 守界:协作对象是 agent,不是人。** 不做项目管理(成员 / 权限 / 工时 / 燃尽图);不做套壳 / IDE(会话视图够"看懂 + 能干预"即可);流程编排停在轻量,不做重型 DAG 编辑器。

**④ 结构 > 散文。** 护城河在结构件(编排循环、验证门、隔离、知识),不在 prompt 措辞——散文脚手架终会被更强的模型吸收。

---

## 1. 概念模型:核心分离 + 两个组织维度(精髓)

六个概念是一套思想的六个落点。

```
Project(边界 = 一个 git 仓库)
│
├─【执行层】 Task「让谁干一件具体的事」
│                ├─ Agent「谁来干」── 类型(claude/codex)→ 默认执行器；执行目标 = 本地 spawn / ssh shell
│                └─ Session × N「每次执行的凭证」── resume / 多 agent 接力 / debate 角色
│
├─【空间维度】Group：一组相关 Task 怎么调度（parallel/serial + dependsOn）
└─【时间维度】Schedule：Task 何时自动触发（once / cron）
```

> 事项中心规划层已移除；用户输入现在直接创建 `Task`，不再维护独立的事项实体或回链。

**核心分离:做什么 `Task` × 谁做 `Agent` × 过程 `Session`。** Task 不绑死"谁做"。`@` 选的是**类型**(claude/codex),由"默认执行器"解析到具体 executor(本地 / ssh);本地与远程统一为"执行目标 = 一个 shell 环境"。正因三者分离,**同一个 Task 才能换 agent 重跑、多 agent 接力、对抗、并行选优——全是"一个 Task 挂多条 Session"**。Session 以"可直接粘贴的 resume 命令"为凭证(裸 ID 无用,需带 `cd` worktree、远程带 `ssh`)。**这是最核心的一刀。**

**两个组织维度:`Group`(空间)+ `Schedule`(时间)。** Group 管"这组任务谁先谁后、能否同时";Schedule 管"何时自动启动"(定时**挂在 Task 上**,Group 可能临时;**定时触发 = 全新一轮 session,不续昨天会话**)。

| 关系 | 基数 | 一句话 |
|---|---|---|
| Group ↔ Task | 1 : N(可 null) | Group 是 Task 的调度上下文,非分类盒 |
| Task ↔ Session | 1 : N | 多 agent 协作 / resume 的根基 |
| Agent ↔ Task | N : N | 类型 → 默认执行器,可复用 |

---

## 2. 一个 Task 的一生

1. **诞生** — 用户直接创建，或由 MCP / 团队调度派生。
2. **归属** — 落到一个 **Project**(哪个 repo)+ 一个 **Group**(怎么和兄弟一起跑)。
3. **排队** — Group `mode` + 自身 `dependsOn` 决定何时启动(`backlog → queued`)。
4. **执行** — **Agent** 在一个隔离 **worktree**(默认开,`git worktree add` 出独立分支)里跑,落一条 **Session**(`queued → running`)。*隔离边界*:worktree 只隔 git 工作树 + 分支,**不隔**依赖 / 端口 / 外部 DB。
5. **协作** — `@` 第二个 agent、`reply` 纠偏、或 debate 多角色——**每个动作都给这个 Task 再挂一条 Session**。
6. **落幕** — `done / failed / canceled`(`awaiting_review` = 卡在 HITL 门,"机器停下等人"的特色态),留下分支 commits 与可 resume 的凭证。
7. **复盘**(规划) — 结果 → 反思 → 新 Task / Group → 回到第 1 步。回路闭合,系统自我迭代。

---

## 3. 一个任务的两个独立选择:拆不拆 × 怎么跑(本次核心)

一个任务要分别回答**两个互不相干的问题**,分属两个正交的轴,**可叠加**:

```
轴一·结构(要不要拆)        轴二·执行(每个任务怎么跑)
   ├ 不拆 ─────────────────► single / race / debate 三选一
   └ 拆成子任务 ──► 每个子任务，再各自 single / race / debate
```

> 例「加用户认证」:拆成 5 个子任务(结构轴);其中"设计架构"跑 `debate`、"实现 API"跑 `race`、其余 `single`(执行轴)。**拆解决定有几个任务,模式决定每个怎么跑——两件事。**

### 轴一 · 拆解(一个任务 → 一窝子任务)

**角色**:`Task` = 干活单元;`Group` = 一组子任务的调度容器(管并行 + 依赖)。Group 在此从早期的"临时并行扇出容器"**演进**为"一组相关任务的容器"——并行扇出、或拆解出的子任务,都用它。

**两个触发时机,同一套底层**(关键纪律:**别做成两套**):
- **前置 · `@planner`**:派之前就知道要拆 → planner 把目标拆成子任务 DAG,落进一个 Group。
- **运行时 · 自拆**:跑着才发现要拆 → **父 Task 生出一个子 Group 装子任务,自己挂起(`awaiting_children`)**,子组按调度跑完 → 唤醒父 Task 收尾。

**为何用"父 Task 挂子 Group"而非 `parentId` 树**:延续早期决策——不做无限嵌套子任务,复杂结构用「Group + `dependsOn`」表达。父子关系 = "父 Task 拥有一个子 Group",复用现成调度,不引入树形层级与递归。

**跑(并行 / 依赖)= 现成**:子组按 `dependsOn` 拓扑跑(`ready = 依赖全 done`,最多 4 并发);**失败的依赖不释放下游**(下游卡住、留人决断 → 配合「关注信号 / 失败重试」补)。

**现状支持度**:✅ 建带依赖的子任务链(`create_task_chain`)+ 拓扑调度;❌ 缺三样——`task → 子 Group` 的连接(`childGroupId`)、父任务挂起状态(`awaiting_children`)、执行中 agent 主动发起拆解的触发(需 agent 连 harness MCP + 拆解约定)。

### 轴二 · 执行模式:`single → race → debate` 光谱

即"这个任务我愿投入多少冗余,要广度还是深度":
- **single**:1 agent 1 次,默认。
- **race / best-of-N**(规划):N agent **独立隔离**并行 → 比 diff 选 1。**费 token 换命中率、不费脑**(广度)。**必须 per-candidate worktree 隔离**(同目录并行会互覆盖、多样性塌缩);**保持纯粹只选优、不内置 review**;受隔离边界限制,适合"改代码"非"起服务"。
- **debate**:两 agent 盲态开局 → 多轮对抗 → 收敛并给出结论，可选 G1 共识门。**费 token + 脑力换深度**。机制:**编排器是唯一信使、严格串行回合、盲态开局、举手收敛**。需要落地代码时，辩论结束后交给 `/team` 拆解执行与验收。

**复盘是第三件事(回路,非这两轴)**:用一个 agent 回看会话,把结果转成可继续执行的新 Task / Group。要点:输入结构化、输出**可一键执行**(建议→Task / 问题→卡片)。

> 三者不冲突:`拆解` 动"几个任务"(结构)、`single/race/debate` 动"每个怎么跑"(执行)、`复盘` 动"跑完反哺"(回路)——三个不同层面。`planner`/`自拆` 只是拆解的两个时机,不是独立概念。

---

## 4. 技术栈

单后端进程(Hono)托管前端 SPA + API + SSE + orchestrator/scheduler/子进程单例;SQLite(libsql)+ Drizzle(长文本产物存文件、表存路径);React/Vite/Tailwind;SSE 推流、POST 发指令。单仓 monorepo(`server/`+`web/`+`shared/`+`mobile/`+`mcp/`)。真·多端:web(SSE)+ mobile(Expo,轮询)+ 对外 MCP(自身可被别的 agent 驱动)。本地自托管常驻,不上 serverless。

---

## 5. 迭代路线图(方向,非现状)

**主轴**:沿 §0 的编排级四要素补齐——loop(流程)与 control(验证 / 预算)是补课,**context(跨任务知识)与 verification 是空场、是护城河**(也是 §0② 唯一能蹭的提分杠杆)。

**用户视角增量**(守 §0③ 的界,按 ROI):
- *一梯队*:① 主动通知 / push(`bus.ts` 事件已齐,缺出口;gate 打开主动提醒)② 完成摘要 TL;DR ③ Token / 成本落库(`claude.ts` 已算未存)+ burn-rate 预警 ④ "需要你关注"信号(卡住 / 打转 / 求助 / 等确认)。
- *二梯队*:⑤ 实时干预(现 single-flight,跑偏只能等完 / kill)⑥ 预算护栏 + 失败分类重试 ⑦ race / 复盘 / planner 拆解(§3)⑧ diff 视图 + 一键起 dev server ⑨ 跨任务知识注入(文件级,不上 RAG)。
- *更远 / 团队化*:模型路由([CCR](https://github.com/musistudio/claude-code-router) 式,有 `LlmProvider` 地基未接执行)、会话 checkpoint·回滚·fork、PR 闭环 + 自动 review→self-fix、Autopilot、更多 agent CLI。

对标:[Archon](https://github.com/coleam00/Archon)(流程确定性)、[Multica](https://github.com/multica-ai/multica)(agent 当队友)、[vibe-kanban](https://github.com/BloopAI/vibe-kanban)(同层竞品)。

---

## 附 A. 里程碑(已完成)

M0 骨架 → M1 单 agent 垂直切片 → M2 任务管理(Linear 式:状态/优先级/标签 + Cmd-K)→ M3 分组并行/串行调度 → M4 debate 对抗(双门 HITL)→ M5 定时执行 → M6 打磨(agent 注册表 / ssh 目标)。见 git log。

## 附 B. 待后续决定

- 拆解落地:`childGroupId` + `awaiting_children` 状态机;运行时自拆的触发约定(agent ↔ harness MCP)。
- race 产出闭环;复盘对象范围(task 会话 / 团队执行记录)。
- 跨任务知识注入的存储与检索形态(文件级)。
- worktree 自动合并策略(ff / squash / 冲突);远程 target 密钥管理;附件清理。
