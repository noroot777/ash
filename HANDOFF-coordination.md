# 交接文档:编排组(协调者)功能

> 2026-07-23 · 状态:已实现并部署,但**用户对当前设计不满意**,待重新评审。
> 本文档整理:需求是怎么一步步提出来的、我(Claude)做了什么、关键取舍、已知粗糙点。
> 接手者(或下一轮讨论)请从「已知粗糙点与局限」一节切入。

## 一、需求演化过程(用户原话摘录)

这个功能不是一次性提出的,是一串对话逐步收敛的,理解脉络很重要:

1. **起点——反馈通道**:「你发给 harness 里让 codex 去做了,如果 codex 想给你一些反馈,该怎么做?」
   当时结论:harness 没有执行方→派单方的通道,先用约定凑(pause_task 等拍板 / jot 仓库 docs/FEEDBACK.md 反馈板 / commit message)。
2. **直接沟通的可能性**:「codex 那边可以 exec 调用 cli,claude 不也可以吗?直接让他们在 harness 里沟通不行吗?」
   结论:CLI 互调拉起的是无上下文的新实例,不是正在对话的那个 agent;通道必须走状态机 + 留痕。
3. **对标 Orca**:用户让看 stablyai/orca,确认它的 Orchestration 层有 ask/reply 阻塞提问、decision gate、worker_done 严格确认、任务 DAG。又追问「原地阻塞等答复是怎么做到的,codex 也可以吗」——结论:阻塞 = 不返回的命令 + 消息总线 + 超时当检查点,任何能跑 shell 的 agent 都行,瓶颈在「谁来值班答题」。
4. **把派单方搬进 harness**:「我现在一直是在 claude desktop 问你的,如果我在 harness 里直接跟 claude 说让他指挥 codex 干活,可不可以做到?」
   结论:可以,harness 拉起的 claude 会自动读仓库 CLAUDE.md 和 harness MCP(全局配置),用「队列穿插 claude 验收任务」就能闭环。
5. **要不要专门模式**:「是不是得让 harness 有个专门的模式会比较好?这样就不用每次都加上『读需求 X,按 CLAUDE.md 流程设计、派单』了,现在有一个协作模式,相当于再加一个?」
   我的判断(用户认可了动手,但**未必认可具体方案**):提示词模板靠项目文档解决;harness 该加的是三个**机制**——①角色前言注入、②提问路由(最值钱,pause 提问会堵死串行队列)、③worker 结束自动唤醒协调者。
6. **动手指令**:「好,你先直接去改 harness,让他能支持。」随后又要求补页面入口:「这个在页面上怎么用?」
7. **同期附带需求**(另一条线,一并交待):修「patch_task(status=canceled) 只改库不停进程」的三连错 bug(「别只修调用 codex 的,claude 的也要修」);以及暂停分组后 codex 拉起的后台进程(TTS 流水线)残留问题。
8. **最终反馈**:「最后的这个协调者这块功能设计的我不是很满意」——**具体不满意在哪,用户尚未展开**,接手者应先问清,别急着改。

## 二、我做了什么(实现清单)

### 数据模型(shared/src/index.ts、server/src/db/schema.ts、db/index.ts 宽容迁移)

- `groups.coordinator_task_id`(nullable):组的协调者任务 id。**不是第三种 group mode**,与 parallel/serial 正交——任何组设了协调者就是「编排组」。
- `tasks.question`(nullable):worker 提出的待答复问题。非空 = 提问暂停中。

### Server 机制(server/src/orchestrator.ts、scheduler.ts、routes.ts)

- **结算优先级**插入提问(单点在 `settleTaskStatus`):手停 canceled > **提问 paused(question)** > 检查点 paused(resumePrompt)> exit≠0 failed > 已确认 done > 未确认 failed。
- **队列挡板**:`pickNextLaunchable` 对「paused 且 question 非空」返回 null——队列陪等答案,绝不空手唤醒(否则问题白问,这是实现时抓到的关键坑)。
- **通知投递**:worker 结算为 done/failed、或提问时,若组有协调者且不是它自己,插一条 `scheduledMessages(sendAt=now)` 给协调者。复用「空闲才投递」的既有机制,避开 continueTask 单飞锁静默丢消息的竞态;代价是走 30s 调度 tick,非即时。
- **角色前言**:fresh run 时注入(`coordinationPreamble`)——协调者版(你会被唤醒、用 answer_question 答疑、每回合 complete_task)/ worker 版(卡住用 ask_question,别用 pause_task 提问)。
- 端点:`POST /groups/:id/coordinator`(设/撤,校验同项目、未归档、**不在本组串行队列里**)、`POST /tasks/:id/ask`(仅 running)、`POST /tasks/:id/answer`(清空 question,把答复作为消息 resume 同一 CLI 会话;提问回合未结算完则 409)。

### MCP 工具(mcp/src/index.ts)

`set_coordinator` / `ask_question` / `answer_question` / `stop_task`(最后一个属 bug 修复线),并更新了 `pause_task`、`patch_task` 的描述做分流指引。

### Web UI(web/src/GroupsPanel.tsx、TaskDetail.tsx、api.ts、App.tsx)

- 分组管理弹窗:每组一行「协调者」下拉(候选=组内未归档任务),选中出紫色「编排组」徽标;409 经 toast 透出。
- 任务详情:`question` 非空时显示紫色提问卡片(问题全文 + 答复框 +「答复并唤醒」)。

### 同期 bug 修复(独立于协调者,但相关)

- `4b37dab`:对 running/queued 任务 PATCH status 一律 409;`stop_task` 成为取消唯一通道;queued 无进程时 stop 直接落 canceled;告警文案不再冤枉「agent 未调用」。
- `3e2415b`:三层击杀——进程组信号 + **继承 fd 追踪**(spawn 时把追踪文件 fd 塞进 stdio[3],stop 时 `lsof -t` 反查逃逸孤儿 + 从持有者走 ppid 树补漏)+ 2s 后补 SIGKILL。解决「暂停分组后 nohup 流水线继续后台跑」。

### 提交索引(harness 仓库)

| commit | 内容 |
|---|---|
| `604a49e` | 编排组核心(协调者 + ask/answer + 队列挡板 + 前言) |
| `4b37dab` | PATCH 状态守卫 + stop_task |
| `3e2415b` | 继承 fd 追踪逃逸后代 |
| `01c22fc` | Web UI(协调者下拉 + 提问卡片) |

jot 仓库侧配套:CLAUDE.md「协调者模式」操作手册、AGENTS.md 反馈通道、docs/FEEDBACK.md 反馈板。

### 测试情况

隔离实例(独立 DB+端口)实测通过:协调者设置校验(队列内任务 409)、非 running 提问 409、**提问暂停的队首任务不被 run_group 空手唤醒**、answer 清空问题并触发续跑、PATCH 守卫、stop 兜底;fd 追踪用「自开进程组孤儿 + close_fds 孙进程」同构场景实测全灭;Web UI 在副本库预览实例上截图验证。**尚未做过一次真实的端到端编排**(真 worker 提问 → 真协调者被唤醒 → 答复 → 续跑)。

## 三、关键设计取舍(为什么这么做)

1. **协调者是「任务」而不是新实体**:复用任务的会话/resume/结算全套机制,改动最小;代价见粗糙点 #1。
2. **通知走 scheduledMessages 而非直接 continueTask**:continueTask 对忙碌任务会静默丢消息(单飞锁),scheduledMessages 天然「空闲才投递、忙时排队」;代价是最长 30s 延迟。
3. **提问用单字段 tasks.question 而非消息表**:一个任务同时只会卡在一个问题上,单槽够用;代价是无历史、无线程(粗糙点 #4)。
4. **ask 不阻塞、靠 resume 回灌**(Orca 是阻塞式 ask):CLI agent 的 MCP 调用有超时上限,长阻塞不可靠;harness 已有「pause→resume 同一会话」机制,异步版语义等价且免费。
5. **不加第三种 group mode**:编排与并行/串行正交(串行队列 worker + 队列外协调者是主用法)。

## 四、已知粗糙点与局限(接手者从这里切入)

1. **协调者复用任务状态机,语义别扭**(最可能是用户不满的点):它是常驻角色,却顶着一次性任务的状态——每次被唤醒处理完必须调 complete_task,状态反复 done→running→done;忘调就落 failed,面板上看着像坏了。
2. **通知非即时**:30s tick;且 done/failed **每个 worker 结束都各唤醒一次**,无聚合无节流,长队列 = 协调者被叫醒 N 回,每回都是一轮真金白银的模型调用。
3. **前言只在 fresh run 注入**:设协调者之前就创建/已运行过的任务,resume 时 worker 不知道有 ask_question 这回事。
4. **提问无历史**:答复后 question 即清空,只在会话 .md 里留痕;不支持一问一答之外的往返。
5. **UI 入口浅**:协调者藏在分组管理弹窗;主列表看不出哪个组是编排组、哪个任务在等答复(得点进详情);没有全局「待答复」收件箱。
6. **覆盖面**:仅 single 模式任务;debate 任务收不到投递(scheduledMessages 对 mode≠single 直接作废);ssh 远端进程追踪不适用。
7. **无审计**:谁设的协调者、谁答的问题,不留操作者记录。
8. **answer 时序**:worker 回合未结算完(running)时答复会 409,调用方需自行等 paused 重试。

## 五、可能的改进方向(未定,供讨论)

- 把协调者从「任务」升级为组上的**常驻角色/会话**,不占用任务状态机(解 #1,顺带让 UI 有自然的挂载点)。
- 通知改事件驱动(settle 后直接尝试投递,忙时才落 scheduledMessages)+ **聚合**(短窗口内多个 worker 结束合并成一条)。
- question 升级为问答线程表(留痕、可多轮)。
- 主界面显性化:编排组徽标上列表、全局待答复收件箱、菜单栏红点。
- 前言改为每回合注入(与 COMPLETION_REMINDER 同位)。

**下一步建议**:先让用户指认不满意的具体点(候选:上面 #1/#2/#5 概率最大),再决定是小修还是把协调者改成常驻角色的大重构——后者动状态机,别顺手做。
