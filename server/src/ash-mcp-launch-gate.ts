// 「起跑之前先确认这一轮交得了卷」—— 所有靠 ash MCP 交卷的系统起跑路径共用的那道闸。
//
// 判据本体在 `ash-mcp-reachability.ts`（问 CLI 本人，问不了退到配置文件，只有「确定没有」
// 才说没有）。这里只管**哪条路怎么用它**：
//
// 第 1 版只装在派审一条路上（`launchReviewRound`），而预设工作流的验证轮靠 `report_stage`、
// 审查意见辩论靠 `debate_reply`、普通回合靠 `complete_task`，缺了 ash MCP 一样是跑满几十分钟
// 才发现交不上（原任务第 1 轮审查第 3 条）。按路径分两档：
//
//  · **拦**（本文件 `gateAshMcpBeforeLaunch`）：派审、验证轮、辩论。三条都是**系统替用户起的
//    旁路回合**，一跑几十分钟，产出只有最后那一次交卷 —— 交不了卷就等于整轮白跑，起跑前说
//    清楚比跑完再说强。
//  · **只提示、不拦**（`ash-mcp-turn-hint.ts`）：普通回合（含重跑上一回合、团队执行者）。那是
//    用户自己派的活，改动和提交不靠交卷也留得下；而在问不了 CLI 的机器上判据只是读配置推断，
//    拿推断拦掉用户亲手点的活不值。
//
// 只在**起跑那一刻**查，不在每段续跑时查：辩论后几段、验证轮中途答复续跑都排在上一回合的
// 结算路径上，在那里再等一次预检，Windows 上会把收尾拖十几秒，而通道在开头已经核过了。
import { desc, eq } from "drizzle-orm";
import { ashMcpReachability } from "./ash-mcp-reachability.js";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { existingTaskWorkspacePath } from "./task-workspace.js";

type TaskRow = typeof tasks.$inferSelect;

/** `launchCwdCandidates` 吃的会话形状（只要两个目录字段）。 */
export type ReviewCwdSession = { cwd: string | null; worktreePath: string | null };

/**
 * 这一轮**可能**跑在哪些目录里 —— 给预检用的**超集**，不是「哪一个」。
 *
 * ── 为什么是超集而不是复刻 orchestrator ─────────────────────────────────────
 *
 * 前两轮都栽在「再维护一份近似的目录选择」上：第 1 版压根没传目录，第 2 版照抄了
 * `recorded` 那条 `||` 链，仍跟真货有三处分歧（诊断会话没过滤、没有显式 resumeSessionId
 * 时的 prev 选择规则、失效目录的回退方式）—— 每一处都够拦掉一轮本来能跑的审查。
 *
 * 而真正的解析没法共用：它跟 prev 的选择绑在一起（`cliGoalSessionCandidates`、
 * `sessionResumableHere`、codex 版本守卫），中途还会写库、往旧会话里写说明。预检必须
 * **只读**，也必须排在起跑之前，拿不到那份结果。
 *
 * 所以换个角度：预检的职责是「**确定**拿不到才拦」，它不需要知道是哪一个目录，只需要
 * 一个能论证的超集 —— orchestrator 的 `recorded` 必然取自
 * `opts.cwd / prev?.cwd / prev?.worktreePath / all[*]?.cwd / all[*]?.worktreePath`，
 * 失效时回退 `taskWorkspace`，而 `prev` 和 `all[0]` 都来自这条任务的会话集合。把**全部**
 * 会话的那两个字段加上显式 cwd 和任务工作区都收进来，就一定罩得住它最终选中的那个。
 *
 * 配上预检那边「任一目录有登记就放行」，误拦就不可能发生：它选中的目录若有登记，那个
 * 目录一定在这张表里，一定会被问到。orchestrator 以后改选法也不会把这条打破。
 * 代价是「确实没有登记」时要多问几次 —— 而那时本来就要拦人。
 */
export function reviewCwdCandidates(
  explicitCwd: string | undefined,
  sessionsOfTask: ReviewCwdSession[],
  workspacePath: string | undefined,
): string[] {
  const out: string[] = [];
  const push = (dir: string | null | undefined) => {
    if (dir && !out.includes(dir)) out.push(dir);
  };
  push(explicitCwd);
  for (const s of sessionsOfTask) { push(s.cwd); push(s.worktreePath); }
  push(workspacePath);
  return out;
}

/** 这一轮由谁来跑：执行器类型 + profile。归属人一律取任务归属人（这几条路都不带 actingUserId）。 */
export type LaunchAgent = { agentType: string; executorId: string | null };

/**
 * 起跑前那道闸。确定交不了卷就抛（消息以 `${who}交不了卷：` 开头，调用方原样交给用户）；
 * 放行时登记看着起不来的那句提示写进时间线，**写失败也不拦** —— 那只是提示，不该因为
 * 时间线写不进去就把一轮本该放行的拦掉（原任务第 1 轮审查「不拦」第 4 条）。
 *
 * `cwd` / `workspacePath` 是调用方手里已经确定的那两个（派审在这之前已经把工作区建出来了）；
 * 没给工作区时按只读方式找一次「它本来该在哪」，不替它建 —— 预检不许有写盘副作用。项目主仓
 * 也收进候选：工作区还没建出来时 orchestrator 会当场建，claude 对工作树的项目级登记键在主仓
 * 根上（`ash-mcp-file.ts` 的 `claudeProjectKeys`），问主仓根只会让超集更大，不会更窄。
 */
export async function gateAshMcpBeforeLaunch(
  task: TaskRow,
  agent: LaunchAgent,
  who: string,
  where: { cwd?: string; workspacePath?: string } = {},
): Promise<void> {
  const reach = await ashMcpReachability({
    ownerUserId: task.ownerUserId,
    agentType: agent.agentType,
    executorId: agent.executorId,
    cwdCandidates: await launchCwdCandidates(task, where),
  });
  if (!reach.reachable) throw new Error(`${who}交不了卷：${reach.problem}`);
  // 放行了、但登记看着起不来：不拦（那是推断），但得留在时间线上 —— 这一轮要是又跑完没结论，
  // 用户回头能看到这一句，而不是只剩「未能正常给出结论」（新链第 1 轮审查第 3 条）。
  if (reach.warning) {
    await appendTaskTimeline(task.id, `起跑预检提示（${who}）：${reach.warning}`)
      .catch((error) => console.error(`[ash] 起跑预检提示写不进时间线(${task.id}):`, error));
  }
}

async function launchCwdCandidates(task: TaskRow, where: { cwd?: string; workspacePath?: string }): Promise<string[]> {
  const sess = await db.select({ cwd: sessions.cwd, worktreePath: sessions.worktreePath })
    .from(sessions).where(eq(sessions.taskId, task.id)).orderBy(desc(sessions.startedAt));
  const project = (await db.select({ repoPath: projects.repoPath }).from(projects)
    .where(eq(projects.id, task.projectId))).at(0);
  let workspacePath = where.workspacePath;
  if (!workspacePath && project) {
    workspacePath = await existingTaskWorkspacePath(task, project.repoPath).catch(() => null) ?? undefined;
  }
  const out = reviewCwdCandidates(where.cwd, sess, workspacePath);
  if (project && !out.includes(project.repoPath)) out.push(project.repoPath);
  return out;
}
