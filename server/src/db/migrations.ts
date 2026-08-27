// 老库迁移:DDL 之外的那一半 —— 一次性数据搬运、退役字段/表的清理。
//
// 从 `db/index.ts` 拆出来的理由:那份文件的两块内容判据完全不同。上面那半是
// **建表**(`CREATE TABLE IF NOT EXISTS` + 容错 ALTER,幂等、每次启动都跑、永不删);
// 这半是**改数据**(按旧语义逐条转换、转完就把旧列摘掉)。混在一起时,改一句 ALTER
// 要连着几百行迁移逻辑一起读,而两边真正共享的只有一个 `client`。
//
// 全部**幂等**:匹配 0 行就是空转,失败一律只 warn 不抛 —— 一条迁移没跑成不该让整台
// ash 起不来,它下次启动还会再试一遍。
//
// 入口只有一个:`runDataMigrations(client)`,由 `ensureSchema()` 在 DDL 之后调用。
import type { Client } from "./node-sqlite-client.js";
import { dropRetiredTables } from "./retired-schema.js";

async function widenWorkflowBuiltinIndex(client: Client): Promise<void> {
  try {
    const info = await client.execute("PRAGMA index_info(workflows_builtin_idx)");
    if (info.rows.length === 2) return; // 已经是两列的新索引
    await client.execute("DROP INDEX IF EXISTS workflows_builtin_idx");
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS workflows_builtin_idx ON workflows (builtin_key, owner_user_id)",
    );
  } catch (e) {
    console.warn("[ash] 起手式覆写索引扩宽失败,忽略:", e);
  }
}

// 审查链状态瘦身（2026-08-11）：叙事状态改为推导，持久值只剩 reviewing/passed/failed/stopped。
// 老库的中间态**按旧语义逐类转换**，不能枚举压平（第 1 轮审查抓过三条丢语义）：
// - repairing：旧结算是「确认完成后直接续下一轮」，新结算只消费预约槽 → 必须回填
//   自动续轮预约（review_armed=1 + review_run_id），否则升级期间正在自动修复的任务静默断链。
// - superseded：旧语义「代码已改过，未通过结论已过期」。压成 stopped 会让前端重新露出
//   「按意见修复/未通过等待处理」。给该 run 最新一轮回填哨兵 reviewed_commit（永不等于任何
//   HEAD），新鲜度推导即显示「代码已有新修改」而不是把旧意见当成当前待办。
// - manual_repairing / reworking / exhausted：本来就是「未通过后停住」→ stopped。
// - 已验收（accepted/merged）自由任务的遗留预约一并注销，否则 reopen 后触发幽灵审查。
// 全部幂等：匹配 0 行就是空转。
export const LEGACY_SUPERSEDED_ANCHOR = "legacy-superseded";
async function migrateFreeReviewStatuses(client: Client): Promise<void> {
  try {
    // repairing：回填自动续轮预约（先回填，再改状态，中途失败重启后仍能续上）。
    const repairing = await client.execute(
      `SELECT id, task_id FROM free_review_runs WHERE status='repairing'`,
    );
    for (const row of repairing.rows) {
      await client.execute({
        sql: `INSERT INTO free_workflow_states (task_id, selected_reviewer_id, review_armed, review_run_id, updated_at)
              SELECT task_id, reviewer_id, 1, id, updated_at FROM free_review_runs WHERE id=:id
              ON CONFLICT(task_id) DO UPDATE SET review_armed=1, review_run_id=excluded.review_run_id`,
        args: { id: String(row.id) },
      });
    }
    // superseded：最新一轮回填哨兵锚点 → 新鲜度推导为「已过期」。
    await client.execute(
      `UPDATE free_review_rounds SET reviewed_commit='${LEGACY_SUPERSEDED_ANCHOR}'
       WHERE reviewed_commit IS NULL AND run_id IN (SELECT id FROM free_review_runs WHERE status='superseded')
         AND round=(SELECT MAX(r2.round) FROM free_review_rounds r2 WHERE r2.run_id=free_review_rounds.run_id)`,
    );
    await client.execute(
      `UPDATE free_review_runs
       SET status='stopped', finished_at=COALESCE(finished_at, updated_at)
       WHERE status IN ('repairing','manual_repairing','reworking','exhausted','superseded')`,
    );
    // 升级前已排队的答复没有 session_role：该任务有 reviewing 链的话，pending 消息几乎
    // 只可能是给审查者的答复（实现回合在审查挂着时进不来）——补成 reviewer，投递才能
    // 送回审查会话（启发式，注释于此备查）。
    await client.execute(
      `UPDATE scheduled_messages SET session_role='reviewer'
       WHERE status='pending' AND session_role IS NULL
         AND mode='queued' AND text LIKE '【答复】%'
         AND task_id IN (SELECT task_id FROM free_review_runs WHERE status='reviewing')`,
    );
    await disarmReservationsOnAcceptedTasks(client);
  } catch (e) {
    console.warn("[ash] 自由审查旧状态收敛失败,忽略:", e);
  }
}

// 已验收(accepted/merged)自由任务的遗留预约不自愈会变幽灵审查:任务日后被唤醒、再次
// 确认完成时,那条上一个验收生命周期的预约就会启动一轮语境全变的审查。
// **必须在 stage 定型之后再跑一次**:老库的 stage 是空的,accepted/merged 由后面的
// migrateFreeWorkflowMergeStates() 从旧 merge_status 列恢复;只在它之前清一遍,匹配不到
// 任何行,而旧 merge 列随后就被删了,预约永久留存(审查实测:old-merged/old-merging 两条
// 升级后都还 armed)。幂等,匹配 0 行就是空转。
async function disarmReservationsOnAcceptedTasks(client: Client): Promise<void> {
  await client.execute(
    `UPDATE free_workflow_states SET review_armed=0, review_run_id=NULL, review_note=NULL
     WHERE review_armed=1 AND task_id IN (
       SELECT id FROM tasks WHERE workflow_mode='free' AND stage IN ('accepted','merged')
     )`,
  );
}

// 辩论模式更名为讨论(duet,2026-08-07):列、mode 值、会话角色一起迁。全部幂等——
// RENAME 在已迁移/新库上报「no such column」被吞掉,UPDATE 匹配 0 行就是空转。
// tasks.duet JSON 里的旧字段(debaterA…)不迁,由 normalizeDuetConfig 兜底读旧写新;
// transcript.jsonl 里的旧事件类型(debate.*)也不迁,读取端归一。
async function migrateDebateToDuet(client: Client): Promise<void> {
  try {
    await client.execute("ALTER TABLE tasks RENAME COLUMN debate TO duet");
    console.log("[ash] tasks.debate 列已更名为 duet");
  } catch {
    /* 已迁移或新库 */
  }
  await client.execute("UPDATE tasks SET mode = 'duet' WHERE mode = 'debate'");
  await client.execute("UPDATE sessions SET role = 'voiceA' WHERE role = 'debaterA'");
  await client.execute("UPDATE sessions SET role = 'voiceB' WHERE role = 'debaterB'");
}

// notes.task_id 曾经只能记住最后一次转换。先把老值搬进多对多关联表，再由下面的
// retired-column 清理删掉旧列；顺序不能反，否则用户现存的回链会丢。
async function migrateLegacyNoteTaskLinks(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(notes)");
  if (!info.rows.some((r) => r.name === "task_id")) return;
  await client.execute(`
    INSERT OR IGNORE INTO note_tasks (note_id, task_id, created_at)
    SELECT id, task_id, updated_at
    FROM notes
    WHERE task_id IS NOT NULL AND TRIM(task_id) <> ''
  `);
}

// 退役列:功能改掉后没人再读、但老库里还留着的列。放这里一次性清掉,而不是让
// 它们静静躺着 —— 否则 `db:push` 每次都会拿它们吓唬人(「about to delete
// use_worktree column with 13 items / THIS ACTION WILL CAUSE DATA LOSS」),
// 真正该看的 schema 变更反而淹没在里面,久了就养成无脑 abort 的习惯。
// 新建库压根不会有这些列(上面的 CREATE TABLE 里没有),所以只对老库生效。
// 加一条的前提:全仓 grep 确认没有任何读写,且列里的值已无恢复价值。
const RETIRED_COLUMNS: { table: string; column: string; why: string }[] = [
  // 随手记现在通过 note_tasks 保留每一次转任务记录；迁移函数已先回填老值
  { table: "notes", column: "task_id", why: "随手记改为多任务历史关联" },
  // worktree 从「按分组配」改成「按任务 opt-in」(tasks.use_worktree)后废弃
  { table: "groups", column: "use_worktree", why: "worktree 改为按任务 opt-in" },
  // 「编排组/协调者」被 /team 团队模式取代(groups.owner_task_id + tasks.parent_id)
  { table: "groups", column: "coordinator_task_id", why: "编排组已被 /team 取代" },
  // 事项中心移除后，任务不再回链事项
  { table: "tasks", column: "issue_id", why: "事项中心已移除" },
  // 任务列表不再区分人工优先级，统一按状态/分区和最后更新时间展示
  { table: "tasks", column: "priority", why: "任务优先级已移除" },
  // 自由工作流专属「合并&清理」被统一验收（task-accept）取代，状态列一并退役
  { table: "free_workflow_states", column: "merge_status", why: "自由工作流合并已统一走验收" },
  { table: "free_workflow_states", column: "merge_message", why: "自由工作流合并已统一走验收" },
  { table: "free_workflow_states", column: "merged_at", why: "自由工作流合并已统一走验收" },
  // ssh 执行器整个功能删掉了(换机器改走「接力」):profile 不再记执行位置,
  // 会话也不再记 "local"/"ssh:host"。agents.target 删列前必须先清掉 ssh profile
  // 本身,见 removeSshExecutorProfiles。
  { table: "agents", column: "target", why: "ssh 执行器已移除,执行位置永远是本机" },
  { table: "sessions", column: "target", why: "ssh 执行器已移除,执行位置永远是本机" },
];

// 退役整表与退役列遵循同一原则：新库不创建，老库启动时幂等清理，失败只告警。
// 先删明细表再删主表，兼容未来可能启用外键约束的旧库。
const RETIRED_TABLES: { table: string; why: string }[] = [
  { table: "issue_comments", why: "事项中心已移除" },
  { table: "issues", why: "事项中心已移除" },
];

// 旧自由工作流「合并&清理」的三列（merge_status/message/merged_at）在 DROP 前必须把
// 事实迁走——旧实现先写 merging、Git 合并成功后才落 stage=accepted，「Git 已合、进程在
// 落 stage 前退出」是可达窗口；直接删列就是删掉唯一恢复凭据（审查实测：升级后合并已
// 发生的任务永久卡在未验收，failed 的错误原因也静默丢失）。规则：
// - merged：合并确实完成过 → task.stage 还空着就补成 accepted（不伪造 commit 区间，
//   acceptedMergeCommit 留空，快路验证自会按「无证据」保守处理）。
// - merging：Git 状态不可知 → 不动 stage，只留一条可见的时间线说明，让用户从验收页
//   重新验收（already_merged 走保留式判定，不会重复合并也不会伪造）。
// - failed：把原错误信息留进时间线，不再静默蒸发。
const MERGE_STATE_COLUMNS = new Set(["free_workflow_states.merge_status", "free_workflow_states.merge_message", "free_workflow_states.merged_at"]);

async function migrateFreeWorkflowMergeStates(client: Client): Promise<boolean> {
  const info = await client.execute("PRAGMA table_info(free_workflow_states)");
  if (!info.rows.some((r) => r.name === "merge_status")) return true; // 旧列已清，迁移早做完了
  const rows = await client.execute(
    "SELECT task_id, merge_status, merge_message FROM free_workflow_states WHERE merge_status IS NOT NULL AND merge_status != ''",
  );
  if (!rows.rows.length) return true;
  let allMigrated = true;
  const { appendTaskTimeline } = await import("../task-timeline.js");
  for (const row of rows.rows) {
    const taskId = String(row.task_id ?? "");
    const status = String(row.merge_status ?? "");
    if (!taskId) continue;
    try {
      if (status === "merged") {
        await client.execute({
          sql: "UPDATE tasks SET stage = 'accepted' WHERE id = ? AND (stage IS NULL OR stage = '')",
          args: [taskId],
        });
        await appendTaskTimeline(taskId, "升级迁移：上一版「合并&清理」已记录合并完成，验收标记已补上（合并区间无从考证，未伪造）。");
      } else if (status === "merging") {
        // 结构化恢复，不依赖时间线（没跑过会话的任务时间线写不进去）：stage=merged 让
        // 统一验收接管——source branch 还在会正常重合并/识别 already_merged；已清理的
        // 走「stage=merged 人工确认」路径而不是 stage=null 的死路。目标分支按旧实现
        // 同一条规则解析并冻结；commit 区间无从考证，留空（诚实，不伪造）。
        const ctx = (await client.execute({
          sql: "SELECT t.worktree_base AS wb, p.repo_path AS rp FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
          args: [taskId],
        })).rows.at(0);
        let target: string | null = null;
        if (ctx?.rp) {
          const { resolveTaskMergeTarget } = await import("../git.js");
          target = await resolveTaskMergeTarget(String(ctx.rp), ctx.wb == null ? null : String(ctx.wb)).catch(() => null) ?? null;
        }
        await client.execute({
          sql: "UPDATE tasks SET stage = 'merged', accepted_target_branch = COALESCE(accepted_target_branch, ?) WHERE id = ? AND (stage IS NULL OR stage = '')",
          args: [target, taskId],
        });
        await appendTaskTimeline(taskId, "升级迁移：上一版验收停在「合并进行中」，Git 合并可能已完成；已按「已合并待确认」恢复，请从验收页重新验收——已合并的会被安全识别，无法核对时会停下等人工确认，不会伪造区间。");
      } else if (status === "failed") {
        const message = String(row.merge_message ?? "").trim();
        // 错误原文是唯一证据：时间线写不进去（任务从没跑过会话）就保留旧列，下次启动再试。
        const wrote = await appendTaskTimeline(taskId, `升级迁移：上一版「合并&清理」失败${message ? `，原始错误：${message}` : ""}；请从验收页重新验收或人工处理。`);
        if (!wrote) {
          console.warn(`[ash] 旧合并失败原因写不进 ${taskId} 的时间线（无会话），本轮保留旧列`);
          allMigrated = false;
        }
      }
      console.log(`[ash] 迁移旧自由工作流合并状态 ${taskId}: ${status}`);
    } catch (e) {
      // 单条失败不拦启动，但这一轮不许删旧列（证据还没迁走），下次启动重试。
      console.warn(`[ash] 旧合并状态迁移失败 ${taskId}(${status})，本轮保留旧列：`, e);
      allMigrated = false;
    }
  }
  return allMigrated;
}

// ssh 执行器功能删掉后,老库里**已注册的 ssh profile 是删列前必须先处理掉的事实**:
// 光 DROP COLUMN 会让那一行原样留下、只丢掉「它跑在别的机器上」这一件事 —— 名字还叫
// claude@build.example、is_default 还挂着,派任务时被当成本机 profile 照常构造出来
// (第 1 轮审查实测:label 仍是 claude@build.example,resume 却已经是本机的
// `cd /repo && claude --resume sid`)。本来明确指向远端的活会**静默改在本机上跑**。
//
// 做法与用户在设置页手删一条 profile 完全一致(routes.ts 的 DELETE /agents/:id):删行,
// 并把**决定以后派给谁**的那些 executor_id 清空——执行随即按 agentType 的默认 profile 降级,
// 这条降级路径本来就是「这条 profile 没了」的既定语义(executors/index.ts 的 pickProfile)。
// 界线是「配置清空、历史保留」:sessions / free_review_runs 记的是那一回合当时真的用了谁,
// 改它就是改历史。sessions.executor_id 尤其不能清——重跑校验正是靠它认出「上一回合那条
// profile 已经没了」并拒绝原样重放(task-retry-turn 的 profileDrift="missing");清成 null
// 反而会让在远端跑过的会话被静默重放到本机,那正是这条迁移要挡的事。
// tasks.duet / tasks.team / mode_presets.config 这类 JSON 里的 executorId 不动:悬空 id 在
// pickProfile 里就是降级到类型默认,与手删 profile 后的现状一致,没必要再去改写用户的配置。
const SSH_PROFILE_REFERENCES: { table: string; column: string; touchUpdatedAt?: boolean }[] = [
  { table: "tasks", column: "executor_id", touchUpdatedAt: true },
  { table: "reviewer_profiles", column: "executor_id" },
  { table: "free_workflow_states", column: "review_executor_id" },
  { table: "scheduled_messages", column: "executor_id" },
];

async function removeSshExecutorProfiles(client: Client): Promise<boolean> {
  try {
    const info = await client.execute("PRAGMA table_info(agents)");
    if (!info.rows.some((r) => r.name === "target")) return true; // 列早清了 = 这一步早做完了
    const rows = await client.execute("SELECT id, name, target FROM agents");
    const ssh = rows.rows.filter((r) => {
      try {
        return (JSON.parse(String(r.target ?? "")) as { kind?: string }).kind === "ssh";
      } catch {
        return false; // 读不出来的当本机放过:宁可留一行,也不误删用户的本机 profile
      }
    });
    if (!ssh.length) return true;
    // 老到还没有某一列的库照样得清得动 profile 本身 —— 那种库里也不会有指向它的引用。
    const present = new Set<string>();
    for (const ref of SSH_PROFILE_REFERENCES) {
      const columns = await client.execute(`PRAGMA table_info(${ref.table})`);
      if (columns.rows.some((r) => r.name === ref.column)) present.add(`${ref.table}.${ref.column}`);
    }
    for (const row of ssh) {
      const id = String(row.id);
      for (const ref of SSH_PROFILE_REFERENCES) {
        if (!present.has(`${ref.table}.${ref.column}`)) continue;
        await client.execute({
          sql: `UPDATE ${ref.table} SET ${ref.column} = NULL${ref.touchUpdatedAt ? ", updated_at = ?" : ""} WHERE ${ref.column} = ?`,
          args: ref.touchUpdatedAt ? [new Date().toISOString(), id] : [id],
        });
      }
      await client.execute({ sql: "DELETE FROM agents WHERE id = ?", args: [id] });
      console.warn(
        `[ash] 已删除 ssh 执行器 profile ${String(row.name ?? id)}(${id}):该功能已移除,换机器请改用「接力」;`
        + "指向它的任务/审查者/待发送消息已改回按 CLI 类型的默认执行器",
      );
    }
    return true;
  } catch (e) {
    // 清不干净就把 agents.target 留到下次启动重试:那一列是唯一还认得出 ssh profile 的证据。
    console.warn("[ash] ssh 执行器 profile 清理失败,本轮保留 agents.target:", e);
    return false;
  }
}

// 团队派活自建的内部组：owner 任务已不存在的（旧版删除没做级联）没有任何入口可见或
// 清理，启动时幂等回收（审查实测：真实主库存量 1 条挂 6 个成员）。
async function reclaimOrphanOwnerGroups(client: Client): Promise<void> {
  try {
    const gone = await client.execute(
      "DELETE FROM groups WHERE owner_task_id IS NOT NULL AND owner_task_id NOT IN (SELECT id FROM tasks) RETURNING id",
    );
    if (gone.rows.length) console.log(`[ash] 回收 ${gone.rows.length} 个 owner 任务已不存在的内部组`);
    // 组的成员也要处理：lead 行已不存在的 worker 挂着悬空 parent_id，前端只把
    // parentId===null 列为顶层，它们永久不可见（审查实测：主库 6 个 done+accepted 的
    // worker 藏在已消失的团队下）。解绑而不是删除——数据（会话/产物）保留，回到顶层
    // 由用户自行处置；悬空 group_id 一并清。
    const unparented = await client.execute(
      "UPDATE tasks SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM tasks) RETURNING id",
    );
    if (unparented.rows.length) console.log(`[ash] 解绑 ${unparented.rows.length} 个 lead 已不存在的执行者（回到顶层可见）`);
    const ungrouped = await client.execute(
      "UPDATE tasks SET group_id = NULL WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM groups) RETURNING id",
    );
    if (ungrouped.rows.length) console.log(`[ash] 清理 ${ungrouped.rows.length} 个悬空的 group 引用`);
  } catch (e) {
    console.warn("[ash] 孤儿内部组回收失败，忽略：", e);
  }
}

async function dropRetiredColumns(client: Client, skip?: ReadonlySet<string>): Promise<void> {
  for (const { table, column, why } of RETIRED_COLUMNS) {
    if (skip?.has(`${table}.${column}`)) continue; // 事实还没迁走，证据列留到下次启动

    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((r) => r.name === column)) continue; // 早就清过了
    try {
      await client.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      console.log(`[ash] 清理退役列 ${table}.${column}(${why})`);
    } catch (e) {
      // 清不掉不该拦住启动(比如老 SQLite 不支持 DROP COLUMN):报一声继续跑,
      // 这列本来就没人读。
      console.warn(`[ash] 退役列 ${table}.${column} 没能清掉,忽略:`, e);
    }
  }
}

/**
 * DDL 之后跑的那一串。顺序不是随意的:
 *  · 合并状态迁移会把老库的 stage 补成 accepted/merged,所以「已验收任务的遗留预约
 *    清理」必须在它之后**再跑一遍**(见 disarmReservationsOnAcceptedTasks 的注释)。
 *  · 退役列最后摘:某几列是唯一还认得出旧状态的证据,对应迁移没跑成就把它们留到
 *    下次启动(`keepColumns`)。
 */
export async function runDataMigrations(client: Client): Promise<void> {
  await widenWorkflowBuiltinIndex(client);
  await migrateLegacyNoteTaskLinks(client);
  await migrateDebateToDuet(client);
  await migrateFreeReviewStatuses(client);
  const mergeStatesMigrated = await migrateFreeWorkflowMergeStates(client);
  // 无条件跑:部分失败(mergeStatesMigrated=false)时也已经有任务落了 stage,那几条同样得清。
  try {
    await disarmReservationsOnAcceptedTasks(client);
  } catch (e) {
    console.warn("[ash] 已验收任务遗留预约清理失败,忽略:", e);
  }
  await reclaimOrphanOwnerGroups(client);
  // 事实没迁走的那几列留到下次启动:它们各自是唯一还认得出旧状态的证据。
  const keepColumns = new Set<string>();
  if (!mergeStatesMigrated) for (const column of MERGE_STATE_COLUMNS) keepColumns.add(column);
  if (!(await removeSshExecutorProfiles(client))) keepColumns.add("agents.target");
  await dropRetiredColumns(client, keepColumns);
  await dropRetiredTables(client, RETIRED_TABLES);
}
