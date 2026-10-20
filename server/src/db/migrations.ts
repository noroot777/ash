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
import { migrateSessionTurnIdentity } from "./migrate-session-turns.js";
import type { Client } from "./node-sqlite-client.js";
import { markPendingCallKey, pendingCallKeyBlocker, pendingCallKeyLive } from "./schema-readiness.js";
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
// 「新任务默认开不开 worktree」从系统级搬到项目级（2026-09-14，用户拍板：一个项目吃不吃
// 得住 worktree 是项目自己的性质，不是个人口味也不是这台机器的性质）。
//
// DDL 那句 `ADD COLUMN ... NOT NULL DEFAULT 1` 会把**所有**存量项目置成「开」，所以紧跟着
// 要把老库那颗全局值灌回去，否则关掉过 worktree 的用户升级后会突然开始到处长 worktree。
//
// 幂等靠 app_settings 里那一行的存废当标记：灌完就删掉它，第二次启动匹配 0 行即空转。
// 多人模式下 user_settings 里还有一人一份的旧值 —— 合并不出一个项目值（两个人可以设得
// 相反），所以只用实例那份当种子，把个人行删掉并在日志里点名，让管理员知道该去项目设置
// 里复核一遍；不声不响地挑一个人的值当全项目的值才是真的坑。
async function migrateWorktreeDefaultToProjects(client: Client): Promise<void> {
  try {
    const info = await client.execute("PRAGMA table_info(projects)");
    if (!info.rows.some((r) => r.name === "use_worktree_default")) return; // DDL 还没跑到
    const legacy = await client.execute(
      "SELECT value FROM app_settings WHERE key = 'worktreeDefault'",
    );
    const personal = await client.execute(
      "SELECT COUNT(*) AS n FROM user_settings WHERE key = 'worktreeDefault'",
    ).catch(() => null); // 没转过多人模式的库没有这张表
    const personalCount = Number(personal?.rows.at(0)?.n ?? 0);
    if (!legacy.rows.length && !personalCount) return; // 新库，或早就迁过了
    if (legacy.rows.length) {
      // 存的是 JSON，所以 'false' 才是假；别的值（手改坏的）一律当默认「开」。
      const on = String(legacy.rows[0].value) === "false" ? 0 : 1;
      await client.execute(`UPDATE projects SET use_worktree_default = ${on}`);
      await client.execute("DELETE FROM app_settings WHERE key = 'worktreeDefault'");
      console.log(`[ash] worktree 默认值已从全局设置搬进各项目（统一置为${on ? "开" : "关"}，之后按项目单独改）`);
    }
    if (personalCount) {
      await client.execute("DELETE FROM user_settings WHERE key = 'worktreeDefault'");
      console.log(`[ash] 多人模式下 ${personalCount} 份个人 worktree 默认值已作废：这颗开关改成项目级，请到「项目设置 → 工作目录」复核`);
    }
  } catch (e) {
    console.warn("[ash] worktree 默认值搬迁失败,忽略:", e);
  }
}

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
  // 单槽缺口(gap_from/gap_need)改成全集 gaps(JSON 数组):一个文件可能跳过不止一条记录,
  // 单槽会被后一条顶掉。这两列只在未合并的分支上存在过,没有值得迁走的事实。
  { table: "monitor_scan_cursors", column: "gap_from", why: "缺口改为 gaps 全集" },
  { table: "monitor_scan_cursors", column: "gap_need", why: "缺口改为 gaps 全集" },
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
// 清引用一律不碰 updated_at —— 同 task-refs.ts 里那段:那是任务的「最后活动时间」,
// 列表排序、24 小时折叠和未读事件键都读它,而删掉一个用不了的 ssh profile 不是任务的进展。
// 这条迁移在每次启动时跑,悄悄推平几百条历史任务的时间戳尤其没法追查。
const SSH_PROFILE_REFERENCES: { table: string; column: string }[] = [
  { table: "tasks", column: "executor_id" },
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
          sql: `UPDATE ${ref.table} SET ${ref.column} = NULL WHERE ${ref.column} = ?`,
          args: [id],
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
// 一轮意见原来只许挂一条辩论（唯一索引）。中断过的辩论因此没法重开——系统自己崩了
// 却把用户的出路关掉了。改成非唯一：辩完的那条仍然挡着再辩（判据在
// free-review-debate.ts），中断的可以重开，历史逐条留着。
async function relaxDebateRoundIndex(client: Client): Promise<void> {
  try {
    const list = await client.execute("PRAGMA index_list(free_review_debates)");
    const old = list.rows.find((row) => String((row as Record<string, unknown>).name) === "free_review_debates_round_idx");
    if (!old || Number((old as Record<string, unknown>).unique) !== 1) return;
    await client.execute("DROP INDEX IF EXISTS free_review_debates_round_idx");
    await client.execute(
      "CREATE INDEX IF NOT EXISTS free_review_debates_round_idx ON free_review_debates (round_id, started_at)",
    );
  } catch (e) {
    console.warn("[ash] 辩论轮次索引放宽失败,忽略:", e);
  }
}

// 把**旧版本算法推算出来**的 claude 投影期限降回 unknown。
//
// 判据是 `lifetime_evidence IS NULL`:那一列是第 4 轮才加的,所以旧行必然为 NULL,而新代码
// 落 bounded 时一定同时写 'receipt'(来源回执明说的)。于是「谁的期限没有事实依据」这个问题
// 有了确定答案,不必去猜。
//
// **上一版的判据是错的**:它用 `cli_session_id IS NULL`,理由写的是「归属列和 source_lifetime
// 同一批加入,早期代码不写它」—— 这条事实不成立。第 4 轮审查用 `git show` 核出:归属列在本
// 功能第一个提交 `579e58dc` 就有,`source_lifetime` 到第 2 轮 `af4ea0e2` 才加。所以那批**带
// 归属的**错期限行一条都没被纠正(实测 legacyLifetimes:一行 60 秒、一行假 5 分钟的持续监听,
// 迁移跑两次 + 完整回填之后仍然原样显示「盯到 …」)。
//
// 降级不会丢真实期限:下次打开那个任务的哨兵面板,历史回填会重读来源回执把它升回去,并写上
// 'receipt'(claude-monitor-backfill 的 mergeInto)。已经带 'receipt' 的新行一条都不碰 ——
// 不为了修旧行去破坏已经正确的记录。
//
// 幂等:降过之后 source_lifetime 不再是 'bounded',不会重复匹配。
async function relaxUnfoundedClaudeMonitorLifetimes(client: Client): Promise<void> {
  try {
    await client.execute(
      `UPDATE monitors SET source_lifetime='unknown'
       WHERE kind='claude' AND source_lifetime<>'unknown' AND lifetime_evidence IS NULL`,
    );
  } catch (e) {
    // **只吞「列还不存在」**(新库在 DDL 之前跑到这里)。原来 catch 是空的,于是权限、
    // SQLITE_BUSY/FULL 这些真失败也被当成「列没有」静静放过,旧假期限留在库里而且没人知道
    // (第 4 轮审查按代码推断指出)。真失败往外抛,由 runDataMigrations 的调用方处理。
    if (!/no such column|no such table/i.test((e as Error | null)?.message ?? "")) throw e;
  }
}

/**
 * 存量 `bounded` 行回算 `timeout_ms`（**时长**），起点证据一律不动。
 *
 * 为什么非做不可：对外那个精确到期时刻改成由 `started_at + timeout_ms` 现算了（见
 * `shared/src/monitor.ts` 的 `monitorExactExpiry`），而升级前的行只有 `expires_at` 没有
 * `timeout_ms`。不补的话两类行会一起出事：
 *
 * - **ash 自己的哨兵**：起点和时长本来都确定，却因为少了时长列而不再显示期限（纯倒退）。
 * - **claude 投影里时长曾被回执证明过的行**：旧算法拿**回执时刻**当起点，实测比真实起点晚
 *   一分钟（第 6 轮审查 legacyReceipt：显示误差 60 秒），而旧判据凭「时长可信」就把这个
 *   时刻放出去了。回算时长、**`start_evidence` 留空**，于是它降级成「总共盯 90 秒（起点
 *   不确定）」——时长是真的，起点不编。
 *
 * 回算是**精确**的：那一列当初就是 `起点 + 时长` 写进去的，减回来就是时长本身。
 *
 * 幂等：`timeout_ms IS NULL` 是谓词，补完就再也匹配不上。**也不会反复降级正确数据**
 * ——实时投影写的行要么 `source_lifetime='unknown'`（期限未知，不在范围内），要么时长列
 * 已经有值（回执落过），两种都被谓词排除（`runDataMigrations` 没有版本表，每条迁移都得
 * 自己对「每次启动都跑一遍」成立，教训见第 3 轮审查）。
 */
async function backfillMonitorTimeoutFromExpiry(client: Client): Promise<void> {
  try {
    // 用 SQL 选、用 JS 算：ISO-8601 带毫秒和 Z，julianday 的解析与浮点精度都得另外论证，
    // 而这张表的行数本来就只有几十上百。字符串比较对同格式同时区的 ISO 串就是时间序。
    const rows = await client.execute(
      `SELECT id, started_at, expires_at FROM monitors
       WHERE timeout_ms IS NULL AND source_lifetime='bounded' AND expires_at > started_at`,
    );
    for (const row of rows.rows) {
      const ms = Date.parse(String(row.expires_at)) - Date.parse(String(row.started_at));
      if (!Number.isFinite(ms) || ms <= 0) continue; // 占位值/脏数据：宁可不显示期限
      await client.execute({
        sql: `UPDATE monitors SET timeout_ms=:ms WHERE id=:id AND timeout_ms IS NULL`,
        args: { ms, id: String(row.id) },
      });
    }
  } catch (e) {
    // 只吞「列/表还不存在」（新库在 DDL 之前跑到这里），真失败往外抛——理由同
    // relaxUnfoundedClaudeMonitorLifetimes。
    if (!/no such column|no such table/i.test((e as Error | null)?.message ?? "")) throw e;
  }
}

/**
 * 未决调用表的**键重建**（2026-10-15）。
 *
 * 这张表的身份是 `(task_id, session_key, source_run, tool_use_id)` —— 来源那一维非有不可：
 * 一条 ash 会话跨好几个 run 文件，而 tool_use 号只在一条 CLI 会话内唯一，撞号时少了来源就
 * 只能存下一条，另一条的入参（唯一出处）就此不存在（判据见
 * `server/src/claude-monitor-pending.ts`）。
 *
 * 两种旧库都要接上来：
 *   - 声明式路径（`npm -w server run db:push`）在加上 Drizzle 侧 primaryKey 之前建的表 ——
 *     **没有任何唯一约束**，`onConflictDoNothing` 防不住重复，每轮同步都能再插一条（第 13
 *     轮审查 N4 实测）；
 *   - 上一代 bootstrap DDL 建的表 —— 主键是更粗的三列。
 *
 * SQLite 既不能加主键也不能改主键，所以这里**重建整张表**（`CREATE TABLE IF NOT EXISTS` 不会
 * 回头改已有表）。搬运时来源不明的行填空串：那种行从此谁也证明不了同源，于是不会被销账 ——
 * 保守的那一边（毁掉入参是永久的，留着未决责任只是多读一行）。已经是当代键的库上空转。
 *
 * **失败路径和成功路径一样要紧**（新一轮第 2 轮审查 F1，两种失败各有实测）：
 *
 *   ① 五条独立 `execute` 换表，中间任何一条失败都留下半成品库，而启动照常成功 —— 旧三列键
 *      继续承接当代写入，一条调用被冲突吞掉，位置却照常被确认成「读完了」；下次启动迁成功
 *      也不重放，因为前缀已经带着当代戳。→ 整个换表收进**一个原子批**（`client.batch`：
 *      BEGIN 到 COMMIT 之间没有缝，失败整批回滚、原表原样留着）。
 *   ② 失败发生在「原表已删、改名还没成」之后：正式表不存在，下一次 bootstrap 的
 *      `CREATE TABLE IF NOT EXISTS` 建出一张**空的当代键表**，而光看「键已经是当代」就返回
 *      的迁移把带着事实的搬运表永远留在一边。→ 开头先 `adoptInterruptedRekey` 收尾。
 *
 * 还有第三件事：**结论要核验、不能推断**。走到最后一步再读一次真实形状（`PRAGMA`），只有
 * 它说得对才允许上层按当代语义对外确认事实（见 `db/schema-readiness.ts`）。
 */
const PENDING_CALL_KEY = ["task_id", "session_key", "source_run", "tool_use_id"];
const PENDING_CALLS = "monitor_pending_calls";
const PENDING_CALLS_STAGING = "monitor_pending_calls_rekey";
const PENDING_CALL_COLUMNS =
  "task_id, session_key, tool_use_id, command, description, at, source_run, cli_session_id";
const createPendingCalls = (table: string) => `CREATE TABLE ${table} (
  task_id TEXT NOT NULL, session_key TEXT NOT NULL, tool_use_id TEXT NOT NULL,
  command TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  at TEXT, source_run TEXT NOT NULL DEFAULT '', cli_session_id TEXT,
  PRIMARY KEY (task_id, session_key, source_run, tool_use_id))`;

type TableShape = { exists: boolean; columns: string[]; key: string[] };

/** 这张表**现在**长什么样（运行期事实，不是 drizzle 里的声明）。 */
async function shapeOf(client: Client, table: string): Promise<TableShape> {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  return {
    exists: info.rows.length > 0,
    columns: info.rows.map((row: any) => String(row.name)),
    key: info.rows.filter((row: any) => Number(row.pk) > 0)
      .sort((a: any, b: any) => Number(a.pk) - Number(b.pk))
      .map((row: any) => String(row.name)),
  };
}

const isCurrentPendingShape = (shape: TableShape): boolean =>
  shape.key.join(",") === PENDING_CALL_KEY.join(",") && shape.columns.includes("cli_session_id");

/**
 * 上一次换表中断在半路：**把搬运表里的事实接回去**。
 *
 * 怎么分清中断在哪一边：**正式表还在、而且还是旧键** ⇒ 中断在删原表之前，事实都还在原表
 * 身上，搬运表只是一份残缺拷贝 —— 丢掉它，下面重搬一遍。其余情况（正式表不存在，或者已经
 * 是当代键的空表 —— 多半是 bootstrap 随后建出来的那张）都说明事实在搬运表里，并回去。
 *
 * 并表一句 `CREATE TABLE IF NOT EXISTS` 打头，于是「正式表不存在」和「正式表是空的当代表」
 * 收成同一条路：不必依赖 bootstrap 先把表建出来（它自己也可能失败），也不留一条平时跑不到
 * 的分支。`OR IGNORE`：撞键的留哪一条都一样（同一行日志的同一次调用）。
 *
 * 整段走原子批：并表失败就整批回滚，搬运表原样留在原地等下一次启动，不会出现「两边都半截」
 * 的第三种状态；而这一次没接回来的事实由核验那一步兜住（当代语义不发布）。
 */
async function adoptInterruptedRekey(client: Client): Promise<void> {
  const staging = await shapeOf(client, PENDING_CALLS_STAGING);
  if (!staging.exists) return;
  const main = await shapeOf(client, PENDING_CALLS);
  if (main.exists && !isCurrentPendingShape(main)) {
    await client.execute(`DROP TABLE IF EXISTS ${PENDING_CALLS_STAGING}`);
    return;
  }
  console.warn("[ash] 未决调用表:上一次键重建中断在半路,正在把"
    + ` ${PENDING_CALLS_STAGING} 里的行接回正式表`);
  await client.batch([
    createPendingCalls(PENDING_CALLS).replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
    `INSERT OR IGNORE INTO ${PENDING_CALLS} (${PENDING_CALL_COLUMNS})
       SELECT ${PENDING_CALL_COLUMNS} FROM ${PENDING_CALLS_STAGING}`,
    `DROP TABLE ${PENDING_CALLS_STAGING}`,
  ]);
}

async function repairPendingCallKey(client: Client): Promise<void> {
  // 先把结论清掉:这一轮核验通过之前,上层一律按「当代语义还没发布」办事。
  markPendingCallKey(false, "这一轮核验还没跑完");
  try {
    await adoptInterruptedRekey(client);
    const main = await shapeOf(client, PENDING_CALLS);
    if (main.exists && !isCurrentPendingShape(main)) {
      // 归属那一列可能已经由容错 ALTER 补上了（db/index.ts），也可能这是更老的库 —— 两种都搬。
      const owner = main.columns.includes("cli_session_id") ? "cli_session_id" : "NULL";
      // **一个原子批**（理由见上面的 ①）。`DROP TABLE IF EXISTS` 留在批内第一句:上一步
      // 丢掉残缺拷贝之后它一般是空转,但同一批里重建一次是幂等的,也省掉一次往返。
      await client.batch([
        `DROP TABLE IF EXISTS ${PENDING_CALLS_STAGING}`,
        createPendingCalls(PENDING_CALLS_STAGING),
        // `OR IGNORE` 顺带去重：同一条调用的内容来自同一行不变的日志，留哪一条都一样。
        `INSERT OR IGNORE INTO ${PENDING_CALLS_STAGING} (${PENDING_CALL_COLUMNS})
           SELECT task_id, session_key, tool_use_id, command, description, at,
                  COALESCE(source_run, ''), ${owner}
             FROM ${PENDING_CALLS}`,
        `DROP TABLE ${PENDING_CALLS}`,
        `ALTER TABLE ${PENDING_CALLS_STAGING} RENAME TO ${PENDING_CALLS}`,
      ]);
    }
    // **结论只认真实形状。** 上面每一步都可能失败而只留下一句 warn,所以「可以按当代持久键
    // 对外确认事实」这句话必须由这一次 PRAGMA 说出口 —— 包括「搬运表清掉了没有」:它还在
    // 就说明有一批事实没有入口（实测 B）。
    //
    // 搬运表那一问是**硬闸**:现在每条留下它的路都会先抛异常(上面那个 catch 已经把结论
    // 落成 false),所以没有哪条回归打在它身上。留着是为了下一次改动绕不过去 —— 判据是
    // 「键已是当代」推不出「上次搬走的事实已经回来了」,不是某一次实测。
    const after = await shapeOf(client, PENDING_CALLS);
    const leftover = await shapeOf(client, PENDING_CALLS_STAGING);
    if (!after.exists) markPendingCallKey(false, `${PENDING_CALLS} 这张表不存在`);
    else if (!isCurrentPendingShape(after)) {
      markPendingCallKey(false, `持久键还是 (${after.key.join(", ") || "没有键"})`);
    } else if (leftover.exists) markPendingCallKey(false, `还有没接回去的 ${PENDING_CALLS_STAGING}`);
    else markPendingCallKey(true);
  } catch (e) {
    markPendingCallKey(false, String((e as Error | null)?.message ?? e));
    console.warn("[ash] 未决调用表键重建失败,忽略:", e);
  }
  // 失败不抛（同本文件所有迁移）：整台 ash 不该被一张表挡住启动。代价由
  // `schema-readiness.ts` 那个标记承担 —— 内置 Monitor 这一轮不确认读取位置,下一轮重读。
  if (!pendingCallKeyLive()) {
    console.warn(`[ash] 未决调用表的持久键没核验通过（${pendingCallKeyBlocker()}）：`
      + "内置 Monitor 的历史读取位置这一轮不会落盘,升级成功之后自己补齐");
  }
}

export async function runDataMigrations(client: Client): Promise<void> {
  await widenWorkflowBuiltinIndex(client);
  await relaxDebateRoundIndex(client);
  await migrateLegacyNoteTaskLinks(client);
  await migrateWorktreeDefaultToProjects(client);
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
  await repairPendingCallKey(client);
  await relaxUnfoundedClaudeMonitorLifetimes(client);
  // 必须排在 relax 之后：那一步先把「时长没有依据」的行降成 unknown，这一步才只给真正
  // 可信的时长回算列值。
  await backfillMonitorTimeoutFromExpiry(client);
  await migrateSessionTurnIdentity(client);
  // 事实没迁走的那几列留到下次启动:它们各自是唯一还认得出旧状态的证据。
  const keepColumns = new Set<string>();
  if (!mergeStatesMigrated) for (const column of MERGE_STATE_COLUMNS) keepColumns.add(column);
  if (!(await removeSshExecutorProfiles(client))) keepColumns.add("agents.target");
  await dropRetiredColumns(client, keepColumns);
  await dropRetiredTables(client, RETIRED_TABLES);
}
