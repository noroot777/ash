# server/CLAUDE.md

> 三个前提，别踩：
> ① 这个文件是**懒加载**的（2026-07-29 实测：agent 开场拿不到，第一次接触 `server/` 子树文件后才注入），所以硬保证一律靠「编译不过 / 409 硬拦 / 回归测试」，这里只承载路标。
> ② **codex 执行器读不到这个文件**（它只读 `AGENTS.md` 链，且只沿根→cwd）。凡是 codex 也必须遵守的，得写进根 `AGENTS.md` 或者做进系统。
> ③ **往这个文件里加规则要先经用户同意**（根 `AGENTS.md`「加规则要先经用户同意」）。想加就先在回复里问，同意了再落盘；删和搬不受限。

## 这个文件不复述说明

每块逻辑的「为什么这么写」都在**那份代码自己的顶部注释里**（`turn-baseline.ts` 40 行、`detached.ts` 20 行、`repo-lock.ts` 14 行…），事故经过在 `docs/incidents.md`。改这块代码的人一定会看到那份注释，所以这里再抄一遍只会变成过期的第二份——2026-08-07 清理前，这个文件 39 KB，抽查到的段落全是代码注释的旧拷贝。

**结论：要改哪块，先读那个文件的头部。**下表只回答「住在哪、回归测试是哪条」。

| 要改的东西 | 说明住在 | 回归测试 |
|---|---|---|
| 结算优先级 / 续聊 `followUpFrom` | `orchestrator.ts` `settleTaskStatus` | `test:follow-up` |
| 续聊改了代码就清账（前后两张工作目录快照） | `turn-baseline.ts` 顶部 | `test:turn-baseline` |
| 已验收任务被真人唤醒后摘牌 / 挂回 | `task-stage.ts` | `test:reopen-acceptance` |
| 就地验证轮（旁路回合、证据落盘） | `review.ts` 顶部；判定在 `review-policy.ts`，证据 `review-evidence.ts`，措辞 `review-prompts.ts` | `test:review` |
| 队列推进、透明跳过、同队至多一个在跑 | `queues.ts` 顶部（不变量）+ `scheduler.ts` `selectNextInQueue` | `test:queue` |
| 重新排队的位置规则 | `queues.ts` `isOvertaken` / `tailOrder` | `test:queue` |
| agent 活得过 server 重启 | `executors/detached.ts` 顶部 | `test:detached` |
| 重启后接回 / 收拾残留（`reattach` 必须排在 `reconcile` 前） | `reattach.ts` + `index.ts` 调用顺序 | `test:reattach` |
| 三层击杀、预检失败的惰性 `'error'` | `executors/spawn.ts` | — |
| 单实例锁（粒度是 DB 文件路径，不是端口） | `singleton.ts` | `test:singleton` |
| 启动期致命错误必须 `exit(1)` | `index.ts` `exitAfterStartupFailure`（**代码已在做**，不是靠自觉） | — |
| 同仓库写型 git 操作串行 | `repo-lock.ts` 顶部 | `test:repo-lock` |
| 验收合并 / 冲突叫醒来源任务 | `task-accept.ts`、`git-accept.ts`、`accept-conflict.ts` 顶部 | `test:accept-merge` |
| worktree 恢复三档（复用 / 恢复 / 建空壳 + `fresh` 打断记忆） | `git.ts` `prepareWorktree` | `test:worktree-recovery` |
| 删任务时连 worktree/分支一起删 | `workspace-cleanup.ts` | `test:workspace-cleanup` |
| 加/删一个 CLI 执行器 | `executors/catalog/README.md` | `test:cli-catalog` |
| 执行器 profile 解析、model/effort 覆盖 | `executors/index.ts` `resolveExecutorFor`、`shared/src/executor-overrides.ts` | `test:executor-overrides`、`test:executor-resolution` |
| 团队常驻调度台、执行者派活、提问转发 | `team/session.ts`、`team/dispatch.ts`、`team/inbox.ts` | `test:answer-routing` |
| 供应商注入（base_url + key） | `llm.ts` `relayRoot` / `relayApi` | — |
| 退役老库字段/表 | `db/index.ts` `RETIRED_COLUMNS` / `RETIRED_TABLES` | — |

## 没有单一代码归宿的，只有这几条

跨文件、跨端、grep 才能保证的规则——放不进任何一份代码注释，所以留在这里：

- **凡是对 `tasks.status` 做校验的地方，先问一句「这条对常驻调度台适用吗」。** 一次性任务是「跑→终态」，`status !== "running"` 约等于没在干活；常驻调度台的 status 只在 `beginTurn`/`endTurn` 之间来回切，重启接回时是 `idle`，**明明活着却会被这类挡板拦住**。已知需要 team 例外：`/ask` `/answer` `/reply` `/run`；明确不适用：`/complete` `/pause`。**改一处就 grep 一遍所有 status 校验点**——同一个文件里两个对称端点只改一个，靠通读发现不了（`docs/incidents.md`「对称端点只改了一个」）。
- **新增任何「选谁干活」的表面，三件套一起上**：前端 `ExecutorPicker` + 持久化 `executorId` 字段 + 后端 `resolveExecutorFor`。自查时 grep 写死的 agent 类型列表，duet 链路曾因此漏过一次。
- **密钥绝不进 argv**，只走 `spec.exec.relay` 的 `env`（`commandLine` 会存进 `sessions.command_line` 并在 UI 展示）。
- **`shared/src/index.ts` 不能转发运行时函数**，只能 `import type`。服务端直接跑 shared 的 `.ts` 源码，Node 的类型擦除不会把 `"./x.js"` 说明符映射回 `"./x.ts"`，一加真正的运行时转发进程立刻起不来。要共享运行时函数就照 `@ash/shared/team` 开子路径导出。
- **对 running/queued 任务 PATCH status 一律 409**（只改数据库不停进程会三连错，`docs/incidents.md`「只改数据库不停进程」）。取消走 `stop_task`。
- 完成协议（**exit 0 ≠ done**）的规则本体由 prompt 前言 / 消息尾部注入，**别再往任何 md 里加拷贝**。
