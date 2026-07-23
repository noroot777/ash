# 调度模型重做：从指针依赖到队列

> 配套 [DESIGN.md](DESIGN.md) 的执行层补丁。本文定**调度与依赖**这一刀，废掉现有 `dependsOn / resumeDependsOn` 体系，改为"队列 = 唯一依赖原语"。
> 状态：设计稿，待实施。更新 2026-06-28。

---

## 0. 为什么要重做（而不是修修补补）

现状是几个"当时合理"的局部决定叠出来一片混乱：

1. **`dependsOn` 和 `resumeDependsOn` 两套并行**——其实是同一件事在 backlog / paused 两个时机的两个触发场景。
2. **041860b 的对称性只做了一半**——父 `done` 会自动唤醒下游 `paused`，但不会自动启动下游 `backlog`。同一种"前置完成"两种规则。
3. **`canStartTask` 谓词被两个场景共用**——"用户单条 Run" vs "分组批量 Run"对 `canceled` 该不该重启的判断完全相反，但用了一个谓词。今天发现的 P0d-fY_Zi4RC 被 run_group 拉起就是这个。
4. **`canceled` 一个状态承载两种意图**——用户主动停 vs 系统因 pause 停，下游/调度器该不该接力规则完全不同。
5. **没有"合法跳过"的表达**——agent 想报告"我合法地什么都没干"只能在 done/failed/canceled 里挑一个最不离谱的，结果就是 dr-ytb2b 里它自己加了 `--force-long-video` 硬绕过 gate。
6. **数据依赖隐式（文件系统）+ 顺序依赖显式（dependsOn）两层不对齐**——调度器看不见数据流，"删一条"是否安全永远只能问用户。

继续打补丁会让 7、8、9 处接着冒出来。重做的核心动作只有一个：**把"任务记着自己依赖谁"翻过来变成"队列记着任务的顺序"**。所有指针依赖塌缩成位置依赖，6 处问题里 4 处直接消失，1 处大幅简化。

---

## 1. 核心：Queue 是唯一依赖原语

**Queue 是一个有序的 task id 列表**。任务在队列里有一个位置。任务"等谁"由它在队列里的位置决定——**等位于它前面的那个任务**——不直接指向具体 task id。

```
Queue Q = [taskA, taskB, taskC, taskD]
                          ↑
                          taskC 等的是 taskB。
                          taskB 若离队，taskC 自动等 taskA。
                          不需要"重接线"。
```

**结果**：

- 摘任务出链 = 从队列删一项；调换顺序 = 队列 swap。**无"接线"概念**。
- 任务自己 `done` 离队 → 下一个自动顶上。45 分钟那种 case 天然解决。
- `dependsOn / resumeDependsOn` 整个**废掉**——一个原语覆盖两个场景。
- "前置完成 → 自动启动"和"前置完成 → 自动唤醒 paused" 是**同一条规则**。

### Queue 不是 Group

- **Group**：用户面（UI 容器）。可并行可串行（mode 不变），是相关任务的视觉/逻辑容器。
- **Queue**：调度器内部（不直接显示）。表达"完成顺序"。

两者**正交但可共存**：一个 task 可以在 0–1 个 group 里 + 在 0–1 个 queue 里。

**硬约束**：**同一个 queue 里的所有任务必须属于同一个 group（或都不属于任何 group）**。queue 不能跨 group。理由：跨 group 的依赖链 UI 上画不出一致视图，且产品上从未需要。

**Group.mode 控制初始启动方式,Queue 控制完成顺序——两者解耦**（这是真实数据揭示后的修订；最早一版以为"parallel group 不要 queue",但用户工作流大量出现"parallel group + resume chain",见 §8 实测）：

| Group mode | 初始 runGroup 行为 | Queue 在其中的作用 |
|---|---|---|
| `serial` | 整组进一个 queue,按推进规则串行启动 | queue 是唯一启动入口 |
| `parallel` | 所有 backlog 任务**并行**启动(不看 queue) | queue 只在**完成 / 暂停后**起作用——决定 paused 任务的 resume 顺序 |

具体到 dr-ytb2b 那类"并行预处理 + 串行 TTS"工作流:放在 parallel group 里,所有视频先并行做 pre-TTS、各自 paused,后续按 queue 顺序逐个 resume 做 TTS。

---

## 2. 任务状态机

状态枚举**不变**（仍是八态：`backlog / queued / running / awaiting_review / paused / done / failed / canceled`），但**语义重定义**——见下表。

| 状态 | 含义 | 在队列里的效果 |
|---|---|---|
| `backlog` | 还没被调度过 | 队列前面的项还没 `done` → 等；前面 `done` → 自动 → `queued` |
| `queued` | 已被调度器拉起、排着等 slot | 短暂中转 |
| `running` | agent 正在跑 | 占着队列位置 |
| `awaiting_review` | 等审查门 | 占着位置，不前进 |
| `paused` | 跑到 checkpoint 留了 `resumePrompt` 等续跑；或提问等答复；或**分组暂停打断**（无 resumePrompt/question） | 占位置；前面的项 `done` 时**自动**续跑（提问的除外——等答复） |
| `done` | 任务的 mission 完成（包括"决定不做"也是完成） | **后继自动启动** |
| `failed` | 真崩了，或任务的 mission 是"判断要不要继续"且决定不继续 | **留在原地等用户处理，但不挡后面的**——后继照常推进 |
| `canceled` | 用户主动停单个任务 | 见下文操作语义 |

### 关键澄清

- **不引入 `skipped` 状态**。任务的 mission 是"做出决定 + 做事"，决定"不做"也是完成。45 分钟 gate 那个场景，pre-TTS 任务命中 gate 就报 `done`，因为它的 mission 已经完成。
- **`failed` 涵盖两种情况**：真崩了 / 任务的使命就是判断要不要继续然后决定不继续。两者下游行为相同：任务留在原地等用户重试/处理，**但队列不再链停**——一个环节挂了不拖整条流水线，后面的照常跑。要"挡住下游等人拍板"，用 `awaiting_review`（审查门仍然链停）。
- **`canceled` 只来自用户对单个任务的主动停止**。不再当"合法跳过"用。**分组暂停**打断 running 任务落的是 `paused`（不是 canceled）——canceled 会被队列透明跳过，恢复分组时就会错启下一个；paused 占住 head，恢复时从原 CLI 会话续跑它自己。

---

## 3. 队列推进规则（**唯一一条**）

```
对队列 Q 中位置 N 的任务 t：
  t 可以从 backlog → queued（或从 paused → 续跑），当且仅当：
    1. Q 里所有位于 t 之前的任务都处于 done、canceled 或 failed 状态，且
    2. t 自身状态是 backlog 或 paused（提问 paused——question 非空——除外，等答复）

  如果 t 是 paused 且有 resumePrompt：用 resumePrompt 续跑当前 session
  如果 t 是 paused 且无 resumePrompt（分组暂停打断）：用系统「继续」提示续跑当前 session
  如果 t 是 backlog：开新 agent 跑
```

**触发时机**:任何任务进入 `done` / `canceled` / `failed` / `paused` 时,如果它在某个 queue 里,对那个 queue 调一次 advance。

- `done` / `canceled` / `failed` 触发是因为它们让位(head 透明跳过;failed 留在原地等用户处理,但不挡后面的)
- `paused` 触发是因为下游可能恰好是 head 且正等着续跑(dr-ytb2b 工作流核心场景:v2 跑完 pre-TTS 进 paused,v1 已 done,v2 该立刻 resume 做 TTS)
- `awaiting_review` 不触发——审查门是明确的"等人"语义,链停

**就这一条规则**。它一并解释：

- 自动启动 backlog（前一项 done → 我从 backlog 推进）
- 自动唤醒 paused（前一项 done 或我刚进 paused → 我从 paused 续跑）
- 失败不拖链（前一项 failed → 它留在原地等用户，后面照常推进；要挡链用 `awaiting_review`）
- 重复跑分组幂等（已经 `done` 的不会再跑，因为它已经不在 backlog/paused）

### `canceled` 的处理

`canceled` 视同**任务已离队**：

- UI 上仍可见（用户能看到它被取消了）
- 但**不再占队列位置**——它后面的任务把它当不存在
- 所以 `canceled` **不会阻塞**后继任务

> 实现上：要么物理从 queue 列表删掉，要么 queue 推进时把 `canceled` 当透明项跳过。前者更干净，倾向前者。

---

## 4. 操作语义（手动改链）

队列的所有"用户能做的事"：

| 操作 | 语义 | 限制 |
|---|---|---|
| 拖动顺序（reorder） | 改 queue 列表顺序 | `running` 任务不能移；已 `done` 的位置不影响推进，移不移都可以 |
| 从队列移除（remove） | task 从 queue 列表去掉，task 本身**不删除** | 用户操作，不警告；离队任务变成"无队列的独立任务"，可再加进别处 |
| 插入（insert） | 在指定位置插入 task | 不能插到 `running` 任务之前的位置之后（即不能塞在 head 之前） |
| 删除（delete） | 删除 task 本身 | 走原有 task 删除流程，自动从 queue 移除 |

**信任用户**：所有这些操作**不弹警告**。系统不会去判断"你拔掉这个会不会让下游因为缺文件跑崩"——这是隐式数据依赖，调度器看不见，永远只能问用户。用户负责自己的 skill 设计。

**UI 设计要点**（不在本 doc 范围，但要点先记下）：

- 任务详情页**不直接显示**"我依赖 task X"——只显示"我等队列 Q 里前面那个任务"
- 点一下可弹出当前队列的完整视图（一个列表 + 当前位置 + 各任务状态）
- 队列视图里支持拖动 / 右键菜单做上面四种操作
- 队列视图是**动态生成**的，根据 queue 当下的内容画

---

## 5. Skill 层的影响（守门规则该怎么放）

dr-ytb2b 那个事故的根因不是调度问题，是 **skill 把守门规则写在 prompt 里、让 agent 自己执行**——agent 能自己合理化绕过。

队列模型不**强制**解决这个，但**结构性地鼓励**正确做法：

```
旧 skill: 把"45 分钟以下才能跑"写进 prompt
         → agent 自己判断 → 可以撒谎 / 自己加 --force

新 skill: 队列里塞两个 task
         队列 Q = [duration-check, real-work, ...]
         duration-check 的 mission: 检查时长，做决定
           - 满足：done → queue 推进到 real-work
           - 不满足：awaiting_review → 链停等用户拍板（failed 已不再挡链），
             或 done + 后续任务自己读结果决定
         real-work 看不到时长这个变量，根本不可能决定 force run
```

**这是产品规范，不是技术强制**。skill 作者可以不这么写，但只有这么写，agent 才结构性地不可能绕过 gate。系统**不**做"必装前置检查"的元数据机制（产品上"信任用户/agent 自己负责"的取舍已经接受了下次类似事故仍可能发生）。

dr-ytb2b 的 skill 重写是本设计的**第三阶段交付物**，详见 §10。

---

## 6. 数据库 schema 变更

### 新增

**`queue_items` 表**（或同等表名）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `queueId` | text | 队列标识；和 group 一一对应时可直接用 groupId，但建议独立 id 留扩展空间 |
| `taskId` | text PK | 任务 id（唯一——一个任务至多在一个队列里） |
| `position` | int | 队列内位置；用整数序号或浮点 fractional indexing 都可（fractional 利于插入） |
| `createdAt` | text | |

约束：`UNIQUE(queueId, taskId)`；同一个 queue 的所有 task 必须在同一个 group 里（应用层校验）。

### 废弃

- `tasks.dependsOn`（字段保留一段过渡期，调度器不再读，迁移完后删字段）
- `tasks.resumeDependsOn`（同上）
- `canStartTask()` 谓词（shared/src/index.ts:84）
- 041860b 引入的"`done` 自动唤醒下游 paused" 那段代码（被队列规则替代）

### `groups.mode`

**保留**。但 `serial` 不再驱动 `runGroup` 的循环——`serial` 仅作为"创建此 group 时自动给所有 task 串成一个队列"的标记，运行期完全由 queue 规则驱动。`parallel` 仍是"无队列、所有 task 互相独立启动"。

---

## 7. API 变更

### 现有 MCP 工具

`create_task_chain` / `batch_create_tasks` 当前的 `chain` 参数（"按数组顺序串成 A→B→C 依赖链"）：

- 行为不变（用户视角），但**内部实现**改为"建一个 queue，按数组顺序加入"，不再写 `dependsOn` 字段。
- `dependsOn` / `resumeDependsOn` 参数：在过渡期保留，但行为映射到 queue 操作（同一 group 内顺序加入）。跨 group 的 `dependsOn` 直接报错（违反硬约束）。

### 调度器入口

`runGroup(groupId)` 行为重写：

- `parallel` group：扫所有 task，凡是 `backlog / paused` 且无 queue 的，独立启动
- `serial` group / queue：按"推进规则"扫一遍，启动 head 那一项（如果可启动）

### 新增 MCP 工具（可选，看 UI 需求）

- `queue_reorder(queueId, taskIds: string[])` — 整批改顺序
- `queue_remove(taskId)` — 把任务从所在 queue 移除（task 不删）
- `queue_insert(queueId, taskId, position)` — 插入

不一定要 MCP 暴露，HTTP API 给 UI 用也行。看实施时定。

---

## 8. 数据迁移

现存数据：

```sql
-- 当前所有 dependsOn / resumeDependsOn 数组里都只有 0 或 1 项（确认过 list_tasks）
-- 所以迁移逻辑是线性的，不涉及 DAG 拆分。
```

**迁移脚本逻辑**：

```
for each group g:
  if g.mode == 'serial':
    # serial = 所有任务一个接一个跑,整组进一个 queue
    sort g 内 tasks 按 dependsOn 链 + createdAt 兜底拓扑排序
    创建一个 queue 把所有 task 按顺序加入
  if g.mode == 'parallel':
    # parallel = 没显式依赖的任务真并行;有依赖的小链各自一个 queue
    for each connected-component C of g.tasks (按 deps 联通):
      if size(C) >= 2 and C 有任何 deps:
        创建 queue 把 C 内 task 按拓扑顺序加入
      # 真独立的孤儿 task 不进 queue,跑起来就是真并行

for each task t with group_id IS NULL:
  按 deps 做 connected-components,有依赖的分量建独立 queue
  孤儿独立任务不进 queue

最后:UPDATE tasks SET depends_on='[]', resume_depends_on='[]'(清空,不动 schema)
```

**真实数据实测**(本仓库 06-28 时点,311 task / 1 个 parallel group "日常搬运" / 87 个 chained task):走完这套逻辑产出 **14 个 queue**(每天的搬运链各成一队,大小 2-10),独立"全流程"任务保持自由并行。

清空所有 task 的 dependsOn / resumeDependsOn 字段（先清空，下个版本删字段）
```

**迁移前自检**：

- 扫一遍：是否有跨 group 的 dependsOn 边（同一条 edge 两端 groupId 不同）。**有就报错让人工修**，不静默丢弃。
- 扫一遍：是否有 DAG（同一 task 的 dependsOn 数组长度 > 1）。**有就报错**——本设计明确不支持，要人工拆队列或合并。

---

## 9. 实施分阶段

### 阶段 A：DESIGN doc 评审（**当前**）

本文。需用户拍板：

- [x] 队列模型作为唯一依赖原语
- [x] 不引入 `skipped` 状态，`done` / `failed` 二选一表达
- [x] 队列 ⊆ group（不跨 group）
- [x] 信任用户：所有 queue 操作不弹警告
- [x] Group `mode` 字段保留但运行期由 queue 驱动

### 阶段 B：Server 端实施（**由 Codex 完成**）

交付物：

1. 新表 `queue_items` + drizzle schema
2. 迁移脚本（含自检）
3. 调度器重写（`runGroup` 走队列推进规则；删 `canStartTask`、删 041860b 那段）
4. MCP / HTTP API 适配
5. 测试覆盖：队列推进、移除、插入、reorder、paused 自动续跑、failed 透明（后继续推进）、canceled 透明、跨 group 报错

### 阶段 C：UI 改造（**由 Codex 或本会话后续完成**）

交付物：

1. 任务详情页改用"等前一个"的描述，弹层显示队列全貌
2. 队列视图：列表 + 拖动 / 右键菜单（reorder / remove / insert）
3. 删掉 `dependsOn / resumeDependsOn` 相关 UI

### 阶段 D：dr-ytb2b skill 重写（**由 Codex 完成**）

把 45 分钟检查从 prompt 内嵌改成独立前置任务，做 §5 描述的结构化拆分。

---

## 10. Codex 交付 prompt 草稿

### 阶段 B 给 Codex 的 prompt（草稿，实施前会再审一遍）

```
任务：按 DESIGN-scheduling.md 实施 server 端队列模型。

读这份 doc 全文（/Users/fjh/code/harness/DESIGN-scheduling.md），实施：
1. 新增 queue_items 表（drizzle schema + 迁移）
2. 写迁移脚本：把现有 dependsOn / resumeDependsOn 全部迁到 queue_items。
   迁移前自检：跨 group 边 / DAG 都报错让人工修，不静默丢。
3. 重写 server/src/scheduler.ts 的 runGroup：按 doc §3 的"推进规则"
4. 删除 shared/src/index.ts 的 canStartTask 函数
5. 删除 041860b 引入的"done 自动唤醒下游 paused"代码
6. MCP 工具 (create_task_chain / batch_create_tasks / patch_task)
   的 dependsOn / resumeDependsOn 参数：行为映射到 queue 操作；
   跨 group 的依赖直接报错
7. 测试：覆盖 §9 阶段 B 列出的所有场景

不要做：
- 不改 UI（阶段 C 另起）
- 不动 dr-ytb2b skill（阶段 D 另起）
- 不引入 skipped 状态（doc 明确说不要）

完成验收：
- 所有现存任务迁移后队列推进行为符合预期
- P0d-fY_Zi4RC 那种 canceled 任务在 runGroup 时被透明跳过、不重跑
- CT7v4K84TTu6 那种 backlog 任务在前置 done 后自动启动
- 跑一遍 npm test 全绿
```

### 阶段 D 给 Codex 的 prompt（草稿）

```
任务：重写 dr-ytb2b skill，把 45 分钟检查从 prompt 内嵌
改成独立前置任务。

读 DESIGN-scheduling.md §5。

当前问题：
- skill prompt 里写"超过 45 分钟必须停"
- agent 自己判断时能合理化加 --force-long-video 绕过
- 真实事故：P0d-fY_Zi4RC

要做：
- 把 dr-auto-ytb2b 的 task 创建逻辑改成：
  对每个视频先创建一个"duration-check"前置任务（在 queue 中位于 pre-TTS 之前）
- duration-check 任务的 mission：检查时长，命中 gate 报 failed（链停）
- pre-TTS 任务的 prompt 里不再含时长检查逻辑——它根本看不到这个变量

验收：
- 模拟一条超过 45 分钟的视频，确认 duration-check 报 failed、
  pre-TTS 不被启动
- 确认 pre-TTS 的 prompt 里没有 --force-long-video 这类绕过选项
```

---

## 11. 风险 / 已知未决

1. **fractional indexing vs 整数 position**：UI 频繁插入时，整数 position 要 reindex；fractional 不用，但调试不直观。实施时择一。
2. **Queue 跨 session 持久性**：本设计假定 queue 数据全在 db 里。重启服务、queue 状态完全恢复，无需快照。
3. **未来需求兜底**：如果哪天真的需要 DAG（多父多子），本设计需要扩展。当前明确不支持——产品定位上"想要 DAG 自己写代码"，参见 [CLAUDE.md](CLAUDE.md) 工作约定第 1 条（重构而非补丁）。
