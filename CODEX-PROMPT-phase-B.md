# Codex 交付：阶段 B —— Server 端队列模型实施

## 你的任务

按同目录 [`DESIGN-scheduling.md`](DESIGN-scheduling.md) 实施"队列模型"对 server 端的改造。这是 phase B —— **不动 UI，不动 skill**。

## 起点状态

- 你应该在这个 worktree 工作：`/Users/fjh/code/harness/.claude/worktrees/queue-scheduling/`
- 分支：`worktree-queue-scheduling`，基于 origin/main
- 你的第一笔 commit 接在 `fa5c506`（docs(scheduling): queue 模型重做的设计稿）后面
- **不要 push 到远端**，做完留在本地等人 review

## 先读什么

1. `DESIGN-scheduling.md` —— **唯一权威**，所有歧义看它
2. 重点读：§3 推进规则、§6 schema 变更、§7 API、§8 迁移
3. 仓库根 `CLAUDE.md` 的工作约定（前端禁原生弹窗那条不在你的影响范围，但其它约定要看）

## 严格不要做的

- ❌ 不要引入 `skipped` 状态（DESIGN §2 明确禁止，agent 报 `done` / `failed` 二选一）
- ❌ 不动 `web/src/...`（是 phase C）
- ❌ 不动 `~/.codex/skills/dr-ytb2b/...`（是 phase D）
- ❌ **不要重启 :4317 这个 live dev server**——人工 review 后才决定何时切换；你只需让 `npm run build` 通过即可
- ❌ 不要 push 到远端
- ❌ 不要保留 `tasks.depends_on` / `tasks.resume_depends_on` 数据字段"以防万一"——按 DESIGN 完全废掉（SQLite 删列麻烦的话，把值清空 + 在代码层不再读，足够）

## 实施顺序

### 步骤 1 — Schema

文件：
- `server/src/db/schema.ts`：新增 `queueItems` 表
- `server/src/db/index.ts` 的 `ensureSchema()`：加 `CREATE TABLE IF NOT EXISTS queue_items ...`

字段：

| 列 | 类型 | 说明 |
|---|---|---|
| `task_id` | text PRIMARY KEY | 一个 task 至多在一个 queue 里，所以 task_id 唯一即可 |
| `queue_id` | text NOT NULL | 队列标识（用 ulid 或类似短 id，**不**复用 group_id，DESIGN §6 说留扩展空间） |
| `position` | integer NOT NULL | 整数序号 0..N-1。每次 reorder 全表重排该 queue 的所有项（不用 fractional indexing，先简单实现） |
| `created_at` | text NOT NULL | |

索引：`(queue_id, position)`。

**Commit**：`feat(scheduling): add queue_items table`

### 步骤 2 — 数据迁移

新建 `server/src/db/migrateQueues.ts`，由 `ensureSchema()` 在表创建完后调用一次。

**幂等性**：先查 `queue_items` 表是否已有数据，有就直接 return（已迁移过）。

**自检（在写任何 queue_items 之前跑）**：

```
1. 扫所有 tasks：若有 t.depends_on.length > 1（DAG），throw 终止启动
   理由：DESIGN §8 明确不支持 DAG，要人工拆
2. 扫所有 tasks：若有 t.depends_on 里的 X 和 t 的 group_id 不同（跨 group），throw
   把 null group_id 视为单独的"无组"宇宙，跨 null/非 null 也是跨
3. 同样的检查跑一遍 resume_depends_on
```

throw 时 message 写清楚："存在跨 group 依赖 / DAG 依赖，本版本不支持。请人工修改后重启。涉及 task: <list>"。

**迁移逻辑**：

```
for each group g where g.mode === 'serial':
  对 g.tasks 做拓扑排序：
    - 基于 depends_on 的偏序（无依赖在前）
    - 同层用 created_at 升序兜底
  生成一个 queue_id (ulid)
  for each task in sorted order, idx in [0..N-1]:
    INSERT INTO queue_items (task_id, queue_id, position, created_at) VALUES (...)

for each task t with group_id IS NULL:
  if t.depends_on / t.resume_depends_on 非空:
    把这条链单独建一个 queue（同样做自检 + 拓扑）
  else:
    跳过（独立任务，无队列）

最后：UPDATE tasks SET depends_on='[]', resume_depends_on='[]'（清空，不动 schema）
```

**Commit**：`feat(scheduling): migrate dependsOn/resumeDependsOn to queue_items`

### 步骤 3 — 重写 scheduler

整个 `server/src/scheduler.ts` 的 `runGroup` 改成走 queue 推进规则。

**核心逻辑**（伪代码，照实现）：

```ts
async function runGroup(groupId: string) {
  if (group.paused) return;

  if (group.mode === 'parallel') {
    // parallel group：没有 queue，扫所有 task，凡 backlog/paused 都启动
    // 保留原来的 MAX_PARALLEL 并发上限
    runParallel(groupTasks);
    return;
  }

  // serial group：找到 group 关联的那个 queue，按推进规则走
  const queue = findQueueForGroup(groupId);
  if (!queue) return;
  advanceQueue(queue);
}

async function advanceQueue(queue) {
  const items = sortedByPosition(queue);
  // 找 head：跳过所有"透明"状态（done / canceled）
  for (const item of items) {
    const t = await getTask(item.task_id);
    if (t.status === 'done' || t.status === 'canceled') continue; // 透明,跳过
    if (t.status === 'running' || t.status === 'queued') return;   // 还在跑,等
    if (t.status === 'awaiting_review') return;                    // 卡审查门,等
    if (t.status === 'failed') return;                             // 链停,等用户
    if (t.status === 'backlog') {
      await setQueued(t.id);
      await resumeOrRunTask(t.id, { reason: 'group' }); // 新 agent
      return;
    }
    if (t.status === 'paused') {
      // 用 resume_prompt 续跑当前 session
      await setQueued(t.id);
      await resumeOrRunTask(t.id, { reason: 'group' }); // orchestrator 内部会因 paused 状态走 resume 路径
      return;
    }
  }
}
```

**重要**：
- DESIGN §3 唯一规则："前面所有项 done，我才能动"，但 `canceled` 透明跳过，所以实际是"前面所有项都 done 或 canceled"
- `failed` / `awaiting_review` 必须卡住链推进（这是新模型表达"中断"的方式）
- 父任务 done 时**自动**触发本 queue 的 advance（见步骤 4 关于自动触发的接入点）

**Commit**：`refactor(scheduling): rewrite scheduler around queue advance rule`

### 步骤 4 — 删 041860b 的自动唤醒、改成 queue 驱动

文件：`server/src/orchestrator.ts`

搜 `自动唤醒` 注释（大约 line 80–110），那是 041860b 引入的"task done 时遍历同组找 resumeDependsOn 指向自己的 paused 任务"——这块**整段删掉**。

替换为：task 进 `done` / `canceled` 终态时，触发"如果它在某个 queue 里，对那个 queue 调一次 advanceQueue"。

更精确的接入点：
- `server/src/status.ts` 的 `setTaskStatus` 里，task 进 `done` 或 `canceled` 时
- 查 queue_items 里是否有这条 task，若有则调度 advance（同 queue 的下一项）

**注意**：avoid 同步嵌套调用（参考 orchestrator.ts:82 已有的注释，那条警告解释了为什么不直接调 runGroup）。用 `void` + setImmediate / Promise.resolve().then(...) 异步触发。

**Commit**：`refactor(scheduling): replace 041860b auto-wake with queue advance trigger`

### 步骤 5 — 删 canStartTask、改 routes

文件：
- `shared/src/index.ts`：删 `canStartTask` 函数（保留 `isUserSettableStatus` / `canArchive`）
- `server/src/routes.ts`：所有 import canStartTask 的地方改 inline 检查

**单任务手动 Run 端点**（`POST /tasks/:id/run`，routes.ts:806 附近）：

```ts
// 用户单条 Run：接受 backlog / failed / canceled / paused
// 这跟原 canStartTask 一致。canceled 在这里允许"用户手动重启"，
// 区别于队列推进里"canceled 透明跳过"（那是 group/queue 视角）
const RUNNABLE_FROM = new Set(['backlog', 'failed', 'canceled', 'paused']);
if (!RUNNABLE_FROM.has(r.status)) {
  return c.json({ error: '任务当前状态不可运行', status: r.status }, 409);
}
```

**dependsOn / resumeDependsOn 入参**（routes.ts:527-528, 566-572, 695-712, 1200-1201）：

- 创建任务 / batch_create：废 `dependsOn` / `resumeDependsOn` 字段；新增 `queueId?: string` + `appendToQueue?: boolean`，或者 `queuePosition?: number`
- patch 任务：废这俩字段的编辑
- `create_task_chain`（routes.ts:691 附近）：把 `chain:true` 翻译成"建一个 queue，按顺序加入"——内部用 queue 操作而不是写 dependsOn 字段
- 出参（routes.ts:224-225）：`dependsOn` / `resumeDependsOn` 仍可保留在返回 json 里（暂时为 `[]`，老前端读了不会崩），但新前端会改用 queue 接口

**Commit**：`refactor(scheduling): remove canStartTask, inline status checks`

### 步骤 6 — 新增 queue 操作 API

新端点（建议路径，可调整）：

| Method | Path | Body | 行为 |
|---|---|---|---|
| `GET` | `/queues/:queueId` | — | 返回 `{queueId, groupId, items: [{taskId, position, status, title}]}` |
| `POST` | `/queues/:queueId/reorder` | `{taskIds: string[]}` | 整批重排（taskIds 必须是该 queue 全集） |
| `POST` | `/queues/:queueId/remove` | `{taskId}` | 把 task 从 queue 移除（task 本身不删） |
| `POST` | `/queues/:queueId/insert` | `{taskId, position}` | 在指定位置插入（**校验**：task 必须跟 queue 同 group） |
| `POST` | `/queues/:queueId/append` | `{taskId}` | 加到尾部 |

**跨 group 校验**：所有写入端点都拒绝"queue 里某个 task 不在 queue 所属 group 里"——返回 400 + `error: '跨 group 不允许，task <id> 属于 group <X>，queue 属于 group <Y>'`。

**MCP 工具**：`mcp/src/...` 暴露上面这几个端点对应的工具（如果你觉得有用）。最起码 `create_task_chain` / `batch_create_tasks` 的内部实现要切到 queue 操作。

**Commit**：`feat(scheduling): queue ops API + MCP migration`

### 步骤 7 — 测试

server 目前没有 test 框架。推荐做法：

- 新建 `server/scripts/test-queue.ts`，一次性 e2e 脚本
- 跑法：`HARNESS_DB=/tmp/test-queue.db tsx server/scripts/test-queue.ts`
- 内部用真实的 db + scheduler API，跑完打印 PASS / FAIL

**必须覆盖的场景**：

1. **基本推进**：建一个 serial group + queue 里 3 个 backlog task，调 advanceQueue，验 task1 进 queued/running
2. **链式推进**：task1 done 后，task2 自动启动
3. **canceled 透明**：task2 设成 canceled，调 advance，task3 自动启动（跳过 canceled）
4. **failed 链停**：task2 设成 failed，调 advance，task3 仍 backlog（不动）
5. **paused 续跑**：task2 处于 paused、有 resume_prompt，task1 done 后 task2 自动续跑（走 resume 路径）
6. **跨 group 拒绝**：建两个 group，往 queue 里 insert 另一个 group 的 task，返回 400
7. **迁移自检**：手造一个跨 group 的 dependsOn 数据，启动 ensureSchema，throw
8. **迁移自检**：手造一个 dependsOn 长度=2 的 task，启动，throw
9. **迁移正确性**：现存的 serial group 迁移后，queue 里位置和 dependsOn 链一致

**Commit**：`test(scheduling): e2e checks for queue advance`

## 验收清单

跑完后请确认（**不要重启 live :4317**，只跑构建和 throwaway db 验证）：

- [ ] `npm run build` 全绿（shared + web + server + mcp）
- [ ] `npx tsc --noEmit -p server` / `npx tsc --noEmit -p shared` 没新增 type error
- [ ] `HARNESS_DB=/tmp/test-queue.db PORT=4318 npm -w server run dev` 能正常启动（说明 ensureSchema + migrate 跑通了）
- [ ] `server/scripts/test-queue.ts` 全部场景 PASS
- [ ] 现存 db 的迁移演练：
  ```bash
  cp ~/.local/share/harness/harness.db /tmp/migrate-test.db  # 或实际路径
  HARNESS_DB=/tmp/migrate-test.db PORT=4319 npm -w server run dev &
  # 启动后看日志：迁移完成、无 throw
  sqlite3 /tmp/migrate-test.db 'SELECT count(*) FROM queue_items;'  # 应有数据
  sqlite3 /tmp/migrate-test.db "SELECT depends_on FROM tasks LIMIT 5;"  # 应全是 '[]'
  ```

## 提交规范

每步一个 commit，conventional 风格：
- `feat(scheduling): xxx` —— 新功能
- `refactor(scheduling): xxx` —— 重构
- `test(scheduling): xxx` —— 测试

不要 squash，留多个 commit 方便人工 review。

## 完成后报告

把每个 commit hash 列出来，并简要说明：

1. 每步遇到的关键取舍（如果有偏离本 prompt 的地方，标出来）
2. 测试场景里有没有不通过的
3. 迁移自检触发了吗（本地 db 有没有跨 group / DAG 数据）
4. 有没有发现 DESIGN doc 没覆盖到的边角

---

## 附录：关键文件清单

| 文件 | 改动 |
|---|---|
| `DESIGN-scheduling.md` | 不改（权威，只读） |
| `server/src/db/schema.ts` | 加 queueItems 表 |
| `server/src/db/index.ts` | 加 CREATE TABLE queue_items |
| `server/src/db/migrateQueues.ts` | 新建 |
| `server/src/scheduler.ts` | 大改：runGroup + advanceQueue |
| `server/src/orchestrator.ts` | 删 041860b 自动唤醒 + 改 status hook |
| `server/src/status.ts` | 加 queue advance 触发 hook |
| `server/src/routes.ts` | 删 canStartTask 引用、改 deps 入参、加 queue 端点 |
| `shared/src/index.ts` | 删 canStartTask |
| `mcp/src/...` | create_task_chain / batch_create_tasks 内部改 |
| `server/scripts/test-queue.ts` | 新建 |

## 附录：现存"事故现场"参考（迁移要考虑）

来自当前 db 的真实例子，迁移时这些都得正确处理：

- `7F_daULKqI_n` 是 serial group，里面有 30+ 个 task，深度链
- `P0d-fY_Zi4RC` (canceled) 的 `resume_depends_on = ["xP9cm4I-xePQ"]`
- `CT7v4K84TTu6` (done) 的 `depends_on = ["51Dkhh_xMIw3"]`
- 大部分 task 的 dependsOn 是单元素或空，但要确认拓扑能跑通

迁移后这些任务都应在 `7F_daULKqI_n` 对应的 queue 里，按拓扑顺序占好位置，原来 done 的就在 queue 里仍是 done（透明跳过），canceled 的也在 queue 里、推进时透明。
