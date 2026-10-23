// 「验收前置命令」的编排：什么时候该跑、跑完算什么、红了找谁。
//
// 语义本体（为什么钉在「点验收」那一刻、判据是什么）在 shared/src/accept-gate.ts 顶部；
// 起进程那一层在 accept-gate-process.ts。这里只有三件事：
//
//  ① **判**（acceptGateCheck）：在验收主流程的仓库锁**里**回答「这一按能不能直接合」。
//     能 → null；不能 → 结构化失败，并把「要跑哪条命令」登记下来。
//  ② **跑**（startPendingAcceptGate）：在仓库锁**外**真的起进程。必须在锁外 —— 这条
//     命令动辄十几分钟，占着仓库锁会让同一个仓库里其它任务的验收/worktree 操作全部干等。
//     登记-再发射这一手跟验收冲突交接（accept-conflict.ts）是同一个形状。
//  ③ **收**（settleGate）：绿了**自动把这次验收接着做完**（用户只点了一次，剩下的是
//     系统欠他的），红了把日志回流给 agent 去修，跟撞冲突叫醒 agent 同一套退路。
//
// 一个任务同时只会有一条门禁在跑（库里 running 行 + 进程表双保险）。
import { and, desc, eq } from "drizzle-orm";
import {
  ACCEPT_GATE_STATUS_LABELS,
  ACCEPT_GATE_TIMEOUT_MS,
  normalizeAcceptGateCommand,
  summarizeAcceptGate,
  type AcceptGateBasis,
  type AcceptGateBasisMode,
  type AcceptGateFailure,
  type AcceptGateState,
  type AcceptGateStatus,
  type AcceptGateView,
} from "@ash/shared/accept-gate";
import type { AcceptBy } from "@ash/shared/workflow-policy";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import {
  acceptGateLogPath, acceptGateLogTail, appendGateLog, hasUnconfirmedGateProcess,
  isSameGateProcess, spawnAcceptGate, stopAcceptGate,
} from "./accept-gate-process.js";
import { isAncestor } from "./git-accept.js";
import { commitAt, plannedMergeTarget } from "./task-branch-plan.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { taskWorkspace } from "./task-workspace.js";
import { continueWhenIdle } from "./runs.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import { id as newId, now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
type GateRow = typeof acceptGateRuns.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** 用户在确认框里做的那几个选择：门禁绿了之后要**原样**替他接着做完。 */
export type AcceptGateChoices = { by: AcceptBy; commit?: boolean; confirmUnverified?: boolean };

/** 这一按对门禁的额外指令。undefined = 照常（有就复用、没有就跑）。 */
export type AcceptGateIntent = "skip" | "rerun";

/** 门禁给出的三种「这一按还不能合」。形状与其它验收失败完全一致（AcceptFailure）。 */
export type AcceptGateReason = "accept_gate_required" | "accept_gate_running" | "accept_gate_failed";

type PendingStart = {
  command: string;
  cwd: string;
  projectId: string;
  sourceCommit: string | null;
  targetBranch: string | null;
  targetCommit: string | null;
  fastForward: boolean | null;
  choices: AcceptGateChoices;
};

const pendingStarts = new Map<string, PendingStart>();
// 正在跑的那条：超时闹钟只活在内存里（重启后由 recoverAcceptGates 收拾残留）。
// 进程身份也记一份 —— 删任务那条路要在**不碰库**的前提下把进程收掉（行马上就没了）。
const live = new Map<string, { runId: string; timer: NodeJS.Timeout; pid: number; pidStartedAt: string | null }>();
// runId → 这一次「跑完 + 跑完之后那一步（自动续验收 / 回流）」都做完了。只给回归用。
const settlements = new Map<string, Promise<void>>();
// 正在收尾的 runId。进程退出、取消、超时三条路可能同时到，而「读行 → 改行」之间有 await：
// 只靠库里那个 running 判据会让两条路都认为自己是第一个（于是自动续验收跑两遍）。
const settling = new Set<string>();

/**
 * 门禁状态变了，**两条都要发**。
 *
 * `task.acceptGate` 只有验收台那张卡在听；而「这个任务此刻有条命令在跑」还要进到任务
 * 本身（`Task.acceptGateRunning` 由 enrichTasks 现查），侧栏那颗圆点和会话页输入框上方
 * 那条才看得见。少了后面这一条，门禁跑的那十几分钟里任务在列表上和平时一模一样。
 */
function announceGate(taskId: string): void {
  bus.publish({ type: "task.acceptGate", taskId });
  void publishTaskUpdated(taskId).catch((error) => {
    console.error(`[ash] 门禁状态广播失败（${taskId}）:`, error);
  });
}

/**
 * 把「这一按拿什么放的行」钉在任务上。**门禁每放行一次就写一次**。
 *
 * 为什么写在放行那一刻、而不是等合并真的成了:放行之后那一段(冻结目标、合并、清理)还会
 * 失败,但失败的那次不会落 accepted,而回执只在 accepted/merged 时才读这份凭据 —— 于是
 * 「写早了」在任何可达状态下都看不见;而下一次验收必然再走一遍这里,凭据跟着重写。反过来
 * 想等到终点再写,就得把它穿过 acceptTask 里五条各自 return 的分支,漏一条就又是一次无
 * 凭据的盖章。
 *
 * 不动 updatedAt:它决定侧栏的排序,而这是一次用户看不见的内部记账。
 */
async function recordAcceptBasis(taskId: string, mode: AcceptGateBasisMode, runId: string | null): Promise<void> {
  await db.update(tasks).set({ acceptedGateMode: mode, acceptedGateRunId: runId }).where(eq(tasks.id, taskId));
}

const gateView = (row: GateRow): AcceptGateView => ({
  id: row.id,
  taskId: row.taskId,
  command: row.command,
  cwd: row.cwd,
  status: row.status as AcceptGateStatus,
  exitCode: row.exitCode ?? null,
  failure: (row.failure as AcceptGateFailure | null) ?? null,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt ?? null,
  sourceCommit: row.sourceCommit ?? null,
  targetBranch: row.targetBranch ?? null,
  targetCommit: row.targetCommit ?? null,
  fastForward: row.fastForward ?? null,
  stale: false,
  logPath: row.logPath,
  logTail: acceptGateLogTail(row.logPath),
  handoff: row.handoffAt ? { at: row.handoffAt, error: row.handoffError ?? null } : null,
});

async function latestRun(taskId: string): Promise<GateRow | null> {
  return (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))
    .orderBy(desc(acceptGateRuns.startedAt), desc(acceptGateRuns.id)).limit(1)).at(0) ?? null;
}

async function runningRun(taskId: string): Promise<GateRow | null> {
  return (await db.select().from(acceptGateRuns)
    .where(and(eq(acceptGateRuns.taskId, taskId), eq(acceptGateRuns.status, "running")))
    .orderBy(desc(acceptGateRuns.startedAt)).limit(1)).at(0) ?? null;
}

/** 这个任务干活的那个目录。worktree 没了/不是 git 项目时回落到项目目录（同 workflow 的命令站）。 */
async function gateCwd(task: TaskRow, repoPath: string): Promise<string> {
  try { return (await taskWorkspace(task, repoPath)).path; }
  catch { return repoPath; }
}

/**
 * 被测的那棵树：工作区当前 HEAD。
 *
 * 拿不到（非 git 项目）就是 null —— 那时**一次结果只作数一次**（没有能比对的身份，
 * 复用等于拿上一棵树的结论替这一棵背书）。
 */
const headCommit = (cwd: string) => commitAt(cwd, "HEAD");

export function acceptGateCommandOf(project: Pick<ProjectRow, "acceptGateCommand"> | null | undefined): string | null {
  return normalizeAcceptGateCommand(project?.acceptGateCommand);
}

/**
 * 验收主流程在动 git 之前问的那一句。返回 null = 放行。
 *
 * **只在仓库锁里调用**：它要读任务工作区与目标分支的当下状态，而判断和随后的合并必须
 * 看同一个世界。真正起进程在锁外（见文件头 ②）。
 */
export async function acceptGateCheck(
  task: TaskRow,
  project: ProjectRow | null,
  opts: { choices: AcceptGateChoices; intent?: AcceptGateIntent; passedRunId?: string },
): Promise<AcceptFailure | null> {
  const command = acceptGateCommandOf(project);
  // 没设(或刚被撤掉):这一按直接合,凭据就是「那一刻没有这一关」。这一句**必须也写**——
  // 不写的话,上一次验收留下的那份 passed 会原地留着,给一份从没测过的代码背书(F1 实测)。
  if (!command || !project) {
    await recordAcceptBasis(task.id, "unset", null);
    return null;
  }

  const cwd = await gateCwd(task, project.repoPath);
  const head = await headCommit(cwd);

  // 门禁绿了之后系统自己接着做完的那一次：带着凭据进来，不再重判。
  //
  // 但凭据换的是「不再重判」，**不是「不用核对」**：那条命令验的是开跑那一刻的树，而
  // 这里要合的是此刻这一棵。中间任务工作区又进了提交（用户在另一个窗口让它接着干活），
  // 或者项目把命令换了一条，这张凭据就不作数 —— 落到下面重新登记一次，按现在这一份再跑
  // 一遍（第 1 轮审查实测：没有这道核对时，合进 main 的是这条命令从没跑过的代码）。
  // 定不出 HEAD（非 git 项目）时没有可比的身份，只能认凭据本身，否则会无限自我触发。
  if (opts.passedRunId) {
    const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, opts.passedRunId))).at(0);
    if (row && row.taskId === task.id && row.status === "passed"
      && row.command === command && (!head || row.sourceCommit === head)) {
      await recordAcceptBasis(task.id, "passed", row.id);
      return null;
    }
  }

  const inFlight = await runningRun(task.id);
  if (inFlight && opts.intent !== "skip") {
    return {
      accepted: false, httpStatus: 409, taskId: task.id, reason: "accept_gate_running",
      error: `验收前置命令正在跑（${inFlight.command}）。跑完如果是绿的，这次验收会自动接着做完，不用再点；`
        + `不想等就在验收台上取消它。`,
      status: task.status, gate: gateView(inFlight),
    };
  }

  if (opts.intent === "skip") {
    // 跑着的时候选跳过 = 「不等了，现在就合」。那条命令必须**先收掉**：合并紧接着就是
    // 清理，worktree 会在它脚下被删掉（它的 cwd 正是那儿），而它还在往一个已经不存在的
    // 目录里跑测试、写日志。界面不给这条路，HTTP/MCP 给得出来（第 1 轮审查）。
    if (inFlight) await cancelAcceptGate(task.id, "你选择了这次跳过验收前置命令，直接合并");
    await appendTaskTimeline(
      task.id,
      `本次验收**跳过**了验收前置命令 \`${command}\`：这是你在验收时明确选的，` +
        `ash 没有跑它，也没有任何它通过的证据。${inFlight ? "正在跑的那一次已经一并收掉。" : ""}`,
    );
    await recordAcceptBasis(task.id, "skipped", null);
    return null;
  }

  const previous = await latestRun(task.id);
  // 同一棵树上的结论直接作数：通过就放行，没通过就把那次的红原样摆回去（不自动重跑——
  // 一棵没变过的树多半还是同样的红，而用户点这一下的意思是「合」，不是「再烧十几分钟」）。
  //
  // 「同一棵树」的身份是**提交 + 命令**两件事。只认提交的话，用户把命令从 A 改成 B 再点
  // 验收，系统会拿 A 的绿灯直接放行，B 一次都没跑过（第 1 轮审查实测）。
  const sameTree = !!previous && !!head && previous.sourceCommit === head
    && previous.command === command && opts.intent !== "rerun";
  if (sameTree && previous!.status === "passed") {
    await noteTargetDrift(task, project.repoPath, previous!);
    await appendTaskTimeline(
      task.id,
      `验收前置命令沿用上一次的结果：\`${previous!.command}\` 在当前这棵树（${head!.slice(0, 8)}）上已经通过，不再重跑。`,
    );
    await recordAcceptBasis(task.id, "passed", previous!.id);
    return null;
  }
  // interrupted / canceled 不走这条:那两种**根本没有结论**(ash 重启打断、用户自己收掉),
  // 没有红可以摆给用户看。这一按的意思就是「现在跑」,所以落到下面重新起一次。
  if (sameTree && previous!.status === "failed") {
    return {
      accepted: false, httpStatus: 409, taskId: task.id, reason: "accept_gate_failed",
      error: `${summarizeAcceptGate(gateView(previous!))}。代码自那次之后一个字没改，所以没有重跑，也没有合并。`
        + `出路：改完再点验收（会自动重跑）、在验收台上点「重跑一次」、或者明确选择这次跳过门禁。`,
      status: task.status, gate: gateView(previous!),
    };
  }

  const targetBranch = task.useWorktree ? await plannedMergeTarget(task, project.repoPath) : null;
  const targetCommit = targetBranch ? await commitAt(project.repoPath, targetBranch) : null;
  pendingStarts.set(task.id, {
    command, cwd, projectId: project.id,
    sourceCommit: head,
    targetBranch,
    targetCommit,
    // 合并会不会是纯 fast-forward：是 → 被测的就是合并结果；否 → 只记一行，不拦。
    fastForward: targetCommit && head ? await isAncestor(project.repoPath, targetCommit, head) : null,
    choices: opts.choices,
  });
  return {
    accepted: false, httpStatus: 409, taskId: task.id, reason: "accept_gate_required",
    error: `这个项目设了验收前置命令 \`${command}\`，合并前要先跑一遍。`,
    status: task.status,
  };
}

/** 复用旧结果时的诚实交代：被测的那棵树还是不是最终会合出来的那一棵。 */
async function noteTargetDrift(task: TaskRow, repoPath: string, row: GateRow): Promise<void> {
  if (!row.targetBranch || !row.targetCommit) return;
  const current = await commitAt(repoPath, row.targetBranch);
  if (!current || current === row.targetCommit) return;
  await appendTaskTimeline(
    task.id,
    `注意：验收前置命令跑的时候 ${row.targetBranch} 还在 ${row.targetCommit.slice(0, 8)}，现在已经是 ${current.slice(0, 8)}。`
      + `它跑过的是任务分支那棵树，不是这一次的合并结果 —— 目标分支这期间进来的改动没有被它验过。`,
  );
}

/**
 * 把登记好的那一条真的起起来（**仓库锁之外**调用）。返回这次的视图；没有登记过返回 null。
 *
 * 起不来也返回视图（status=failed, failure=spawn_failed）：一条起不来的门禁必须留下
 * 刷新后仍看得见的痕迹，不能只在这一次 HTTP 响应里说一句。
 */
export async function startPendingAcceptGate(taskId: string): Promise<AcceptGateView | null> {
  const plan = pendingStarts.get(taskId);
  if (!plan) return null;
  pendingStarts.delete(taskId);
  // 两次点击挤在一起时，后一次登记的那条不要再起一遍 —— 已经在跑的那条就是答案。
  const already = await runningRun(taskId);
  if (already) return gateView(already);

  const runId = newId();
  const logPath = acceptGateLogPath(taskId, runId);
  const startedAt = now();
  await db.insert(acceptGateRuns).values({
    id: runId, taskId, projectId: plan.projectId, command: plan.command, cwd: plan.cwd,
    status: "running", exitCode: null, failure: null, pid: null, logPath,
    sourceCommit: plan.sourceCommit, targetBranch: plan.targetBranch, targetCommit: plan.targetCommit,
    fastForward: plan.fastForward, acceptOptions: JSON.stringify(plan.choices), startedAt, finishedAt: null,
  });
  appendGateLog(logPath, `[ash] ${startedAt} 验收前置命令开跑\n[ash] cwd: ${plan.cwd}\n[ash] $ ${plan.command}\n\n`);
  await appendTaskTimeline(
    taskId,
    `验收前置命令开跑：\`${plan.command}\`（在 ${plan.cwd}）。rc=0 才会继续合并；`
      + `绿了会自动把这次验收做完，红了会把日志交回这个任务去修。`
      + (plan.fastForward === false
        ? ` 注意：目标分支 ${plan.targetBranch} 已经领先于这棵树，所以它验的不是最终的合并结果。`
        : ""),
  );
  announceGate(taskId);

  // 起进程到登记超时闹钟这一段**必须一个 await 都没有**：命令可能几毫秒就退了（`false`
  // 这种），退出回调一来就要找得到这条登记，否则它会被当成「已经被别人收过」而静默丢掉，
  // 任务永远停在「正在跑」（审查前自测复现）。
  let started: { pid: number; startedAt: string | null };
  try {
    started = spawnAcceptGate({
      command: plan.command,
      cwd: plan.cwd,
      logPath,
      onExit: (exit) => void settleGate(runId, exit.code === 0
        ? { status: "passed", exitCode: 0, failure: null }
        // 信号打死的那一条可能是取消/超时先发的刀 —— 那两条路自己会落更准的理由，
        // 这里的结论会被 settleGate 的幂等挡掉，只有「命令自己被外人杀了」才落到这儿。
        : { status: "failed", exitCode: exit.code, failure: exit.signal ? "canceled" : exit.code === null ? "spawn_failed" : "exit_code" }),
    });
  } catch (error) {
    appendGateLog(logPath, `\n[ash] 起不来：${error instanceof Error ? error.message : String(error)}\n`);
    await settleGate(runId, { status: "failed", exitCode: null, failure: "spawn_failed" });
    const failed = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
    return failed ? gateView(failed) : null;
  }
  const timer = setTimeout(() => void (async () => {
    appendGateLog(logPath, `\n[ash] 超过 ${Math.round(ACCEPT_GATE_TIMEOUT_MS / 60_000)} 分钟，按超时处理，正在收掉它。\n`);
    // **先认领终态、再动刀**（同取消那条路）：反过来的话，刀落下去触发的退出回调会先把
    // 这一次收成「命令被外人杀了」，连带把日志当成一条红交给 agent 去修 —— 而它其实是
    // 超时。占用不会因此漏空：stopAcceptGate 从进场就立起「还没确认退出」那条记号。
    await settleGate(runId, { status: "failed", exitCode: null, failure: "timeout" });
    await noteIfStillAlive(taskId, logPath, await stopAcceptGate(taskId, started.pid, started.startedAt));
  })(), ACCEPT_GATE_TIMEOUT_MS);
  timer.unref?.();
  live.set(taskId, { runId, timer, pid: started.pid, pidStartedAt: started.startedAt });

  await db.update(acceptGateRuns).set({ pid: started.pid, pidStartedAt: started.startedAt }).where(eq(acceptGateRuns.id, runId));
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  // 「登记 → 起进程 → pid 落库」这一段里有 await，而取消那一下**可能正好插在中间**：它那时
  // 读到的 pid 还是 null，于是刀发给了空气，库里却已经落成 canceled —— 进程就此没人认领
  // （第 1 轮审查 F2 的第二个窗口）。所以这里回头再看一眼：不是 running 了就说明有人在这
  // 期间收过它，由**我们**来把刚起的这条收掉（两边都查一次，谁后到谁负责，窗口就封住了）。
  if (row && row.status !== "running") {
    appendGateLog(logPath, `\n[ash] 这一次在起跑的同时就被收掉了（${row.status}），正在停掉刚起的进程。\n`);
    const timerNow = live.get(taskId);
    if (timerNow?.runId === runId) { clearTimeout(timerNow.timer); live.delete(taskId); }
    await noteIfStillAlive(taskId, logPath, await stopAcceptGate(taskId, started.pid, started.startedAt));
  }
  return row ? gateView(row) : null;
}

/** 停不掉就**如实说**：工作区仍被占着，用户刷新后也看得见这句（根 AGENTS.md 那条）。 */
async function noteIfStillAlive(taskId: string, logPath: string, stopped: boolean): Promise<void> {
  if (stopped) return;
  appendGateLog(logPath, `\n[ash] 两刀（TERM、KILL）都发过了，仍然确认不到它退出。\n`);
  await appendTaskTimeline(
    taskId,
    "验收前置命令收不掉：TERM 和 KILL 都发过了，仍然确认不到那棵进程树退出 —— 它可能卡在"
      + "内核里（不可中断的 I/O），也可能 ash 没权限收它。**这个工作区仍按被占用处理**，"
      + "合并与清理都会继续拦着，直到它真的退出（这件事会自己复查，不用再点什么）。",
  );
}

/** 登记了却没能发射（主流程中途出错）时把登记撤掉，别留一条永远不跑的意图。 */
export function dropPendingAcceptGate(taskId: string): void {
  pendingStarts.delete(taskId);
}

/**
 * 一次门禁的终点。三条路（命令自己退了 / 取消 / 超时）都走这里，**第一个到的说了算**，
 * 后到的原样丢掉 —— 否则「自动把验收接着做完」会跑两遍。
 */
async function settleGate(
  runId: string,
  outcome: { status: Exclude<AcceptGateStatus, "running">; exitCode: number | null; failure: AcceptGateFailure | null },
): Promise<void> {
  if (settling.has(runId)) return settlements.get(runId);
  settling.add(runId);
  const settle = (async () => {
    const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
    if (!row || row.status !== "running") return;
    const timer = live.get(row.taskId);
    if (timer?.runId === runId) { clearTimeout(timer.timer); live.delete(row.taskId); }
    const finishedAt = now();
    await db.update(acceptGateRuns)
      .set({ status: outcome.status, exitCode: outcome.exitCode, failure: outcome.failure, finishedAt })
      // 状态闸：上面那句读到的 running 和这一句之间隔着 await，只有真的还 running 才翻。
      .where(and(eq(acceptGateRuns.id, runId), eq(acceptGateRuns.status, "running")));
    const view = gateView({ ...row, ...outcome, finishedAt });
    appendGateLog(row.logPath, `\n[ash] ${finishedAt} ${summarizeAcceptGate(view)}\n`);
    await appendTaskTimeline(row.taskId, `${summarizeAcceptGate(view)}。`);
    announceGate(row.taskId);
    if (outcome.status === "passed") await continueAcceptance(row);
    else if (outcome.status === "failed") await handOffGateFailure(row, view);
  })().catch((error) => {
    console.error(`[ash] 验收前置命令收尾失败（${runId}）:`, error);
  });
  settlements.set(runId, settle);
  // 内存账本只给「等这一次收完」用，留着历史没有意义，满了就把最老的挤掉。**两个账本
  // 一起裁**：从前只裁 settlements，settling 这个 Set 只 add 不删，每跑一轮就永久多存
  // 一个 run id（第 1 轮审查不拦项 4）。幂等不受影响 —— 被挤掉的那些早就收完了。
  while (settlements.size > 100) {
    const oldest = settlements.keys().next().value!;
    settlements.delete(oldest);
    settling.delete(oldest);
  }
  await settle;
}

/**
 * 绿了：把用户那一下点的验收接着做完。
 *
 * 必须带上当初的选择（commit / confirmUnverified）——他在确认框里选的是什么，这一次就
 * 该发生什么；也必须带上 `passedRunId`，否则非 git 项目定不出 HEAD，会再触发一次门禁。
 */
async function continueAcceptance(row: GateRow): Promise<void> {
  const choices = parseChoices(row.acceptOptions);
  const { acceptTask } = await import("./task-accept.js");
  const result = await acceptTask(row.taskId, choices.by, {
    commit: choices.commit,
    confirmUnverified: choices.confirmUnverified,
    acceptGatePassedRunId: row.id,
  }).catch((error) => ({ accepted: false as const, error: error instanceof Error ? error.message : String(error) }));
  if (!result.accepted) {
    const reason = "reason" in result ? result.reason : null;
    // 「又要跑一遍门禁」不是失败：它跑着的这十几分钟里树又动了（或者命令被换了一条），
    // 于是这一按按新的那一份重跑。说清这件事，别让用户以为验收砸了。
    if (reason === "accept_gate_required" || reason === "accept_gate_running") {
      await appendTaskTimeline(
        row.taskId,
        `验收前置命令通过了，但它验的已经不是现在这一份（命令跑的那十几分钟里工作区又有了新提交，`
          + `或者这条命令被改过）。所以没有直接合并，而是按**现在**这一份重新跑一遍；绿了仍会自动接着合。`,
      );
      return;
    }
    // acceptTask 自己已经把失败原因写进时间线了，这里只补一句「这是门禁之后自动续的那一次」，
    // 否则用户只看见一条没头没尾的验收失败，不知道是谁点的。
    await appendTaskTimeline(
      row.taskId,
      `验收前置命令通过后自动继续验收，但没能完成：${"error" in result ? result.error : "未知原因"}。处理完上面那条原因后再点一次验收即可。`,
    );
  }
}

function parseChoices(raw: string | null): AcceptGateChoices {
  try {
    const parsed = JSON.parse(raw ?? "{}") as AcceptGateChoices;
    return { by: parsed.by === "workflow" ? "workflow" : "human", commit: parsed.commit, confirmUnverified: parsed.confirmUnverified };
  } catch { return { by: "human" }; }
}

const FAILURE_PROMPT = (p: { command: string; summary: string; logPath: string; tail: string; cwd: string }) =>
  `【验收未通过 · 验收前置命令没过】\n` +
  `用户点了「验收通过」。这个项目设了验收前置命令，ash 在合并**之前**先跑了它：\n\n` +
  `    cd ${p.cwd} && ${p.command}\n\n` +
  `结果：${p.summary}。所以**没有合并、没有清理**，目标分支一个字节都没动。\n\n` +
  `完整日志在 \`${p.logPath}\`，末尾是：\n\n\`\`\`\n${p.tail.trim() || "（日志为空）"}\n\`\`\`\n\n` +
  `请你来处理：\n` +
  `1. 在自己的工作目录里重跑这条命令，定位到底是哪一条红的；\n` +
  `2. 确属本次改动引入 → 修掉并提交，然后告诉用户可以重新点验收（验收会自动再跑一遍这条命令）；\n` +
  `3. 如果你判断它**跟本次改动无关**（基线既有的红、环境缺件、负载敏感的 flake），不要硬改：` +
  `把依据写清楚（单跑复核的结果、基线上同样红的证据），让用户决定是这次跳过门禁，还是另立一个任务去修。\n\n` +
  `不要自己去动目标分支，也不要绕过这条命令 —— 它是用户给这个项目定的放行条件。`;

async function handOffGateFailure(row: GateRow, view: AcceptGateView, again = false): Promise<void> {
  const prompt = FAILURE_PROMPT({
    command: row.command, summary: summarizeAcceptGate(view), logPath: row.logPath,
    tail: view.logTail, cwd: row.cwd,
  });
  // 先把「这一次交接发起了」落盘再投递：投递是异步的，中间用户刷新页面的话，不落盘
  // 那张卡只能说「不知道」。失败由下面的 onError 补写原因（两件事都写同一行）。
  await markHandoff(row.id, { at: now(), error: null });
  await appendTaskTimeline(
    row.taskId,
    `门禁交接：已叫醒该任务去看这条命令为什么红（日志 ${row.logPath}）。${
      again ? "这是你在验收台上手动再交一次。" : ""}修完重新点验收即可，验收会自动再跑一遍。`,
  );
  // byBackend：占真人回合，但字是后端写的（同验收冲突交接）。
  continueWhenIdle(row.taskId, prompt, { byBackend: true }, async (why) => {
    await markHandoff(row.id, { at: now(), error: why });
    await appendTaskTimeline(
      row.taskId,
      `门禁交接失败：没能叫醒该任务（${why}）。日志在 ${row.logPath}，请手动点运行或直接回复它。`,
    );
  });
}

async function markHandoff(runId: string, value: { at: string; error: string | null }): Promise<void> {
  await db.update(acceptGateRuns)
    .set({ handoffAt: value.at, handoffError: value.error })
    .where(eq(acceptGateRuns.id, runId));
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  if (row) bus.publish({ type: "task.acceptGate", taskId: row.taskId });
}

/**
 * 「再交给智能体去修」：红了之后那次自动交接没落地（回合被抢占、任务当时归档着），或者
 * agent 那一轮跑完了还没修好，用户在验收台上再推一次。
 *
 * 只对**没通过的最近一次**有效：通过了没什么可修的，正在跑的还没有结论。取消/被打断
 * 同样没有结论——那两种的出路是重新点验收，不是把一份不存在的红交给 agent。
 */
export async function rehandOffAcceptGate(taskId: string): Promise<
  { ok: true; gate: AcceptGateView } | { ok: false; error: string }
> {
  const row = await latestRun(taskId);
  if (!row) return { ok: false, error: "这个任务还没跑过验收前置命令" };
  if (row.status === "running") return { ok: false, error: "命令还在跑，等它出结论再说" };
  if (row.status !== "failed") {
    return { ok: false, error: `最近一次是「${ACCEPT_GATE_STATUS_LABELS[row.status as AcceptGateStatus]}」，没有红可以交给智能体修` };
  }
  await handOffGateFailure(row, gateView(row), true);
  const fresh = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id))).at(0);
  return { ok: true, gate: gateView(fresh ?? row) };
}

/**
 * 这个任务现在有没有一条门禁真的在跑。**同步**判据（读进程内那张表），因为问这句话的
 * 是「这条任务动不动得」那三个入口（删任务 / 删项目 / 释放工作区），它们判完就动 git。
 *
 * 不查库是故意的：库里的 `running` 行跨重启留得下来，而重启后那个进程早没了（会被
 * recoverAcceptGates 落成 interrupted）。这里要的是「**现在**有没有一个活着的进程正
 * 踩在那个工作区里」—— 工作区被抽走时它还在往里写。
 */
export function hasLiveAcceptGate(taskId: string): boolean {
  // 两刀都下过、仍然确认不了退出的那些也算：它的 cwd 还踩在那个工作区里，而这个判据的
  // 下一步就是动 git（第 1 轮审查 F2）。那张记号表自己会在进程真的退出时清掉。
  return live.has(taskId) || hasUnconfirmedGateProcess(taskId);
}

/**
 * 删任务之前把它名下还在跑的门禁进程收掉。**不写库**：那些行紧接着就要被删掉，而
 * 这里唯一要防的是留下一个没人认领的进程（pid 这条线索随行一起没了就再也找不回来）。
 */
export async function stopAcceptGatesForTask(taskId: string): Promise<boolean> {
  const running = live.get(taskId);
  if (!running) return !hasUnconfirmedGateProcess(taskId);
  clearTimeout(running.timer);
  live.delete(taskId);
  // 这里**必须等**：紧接着就要删工作区，而它的 cwd 正在那儿。
  return await stopAcceptGate(taskId, running.pid, running.pidStartedAt);
}

/**
 * 这一按会不会**真的**要跑一遍门禁。给批量验收按下去之前的预判用。
 *
 * 判据与 acceptGateCheck 的复用判据同源（提交 + 命令 + 上次是绿的），两边必须一起改 ——
 * 这边说「不用跑」、那边却登记一条去跑，统一验收就会停在半路。
 */
export async function acceptGateWouldRun(task: TaskRow, project: ProjectRow | null): Promise<boolean> {
  const command = acceptGateCommandOf(project);
  if (!command || !project) return false;
  if (await runningRun(task.id)) return true;
  const head = await headCommit(await gateCwd(task, project.repoPath));
  const previous = await latestRun(task.id);
  return !(previous && head && previous.status === "passed"
    && previous.sourceCommit === head && previous.command === command);
}

/** 取消正在跑的那一条。返回 null = 当前没有在跑的。 */
export async function cancelAcceptGate(taskId: string, reason = "你在验收台上取消了这一次"): Promise<AcceptGateView | null> {
  const row = await runningRun(taskId);
  if (!row) return null;
  appendGateLog(row.logPath, `\n[ash] ${reason}，正在收掉它。\n`);
  // 进程表里那一份可能比库里新（pid 是起跑之后才落库的），两边取其一。
  const mine = live.get(taskId);
  await settleGate(row.id, { status: "canceled", exitCode: null, failure: "canceled" });
  const after = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id))).at(0);
  const pid = mine?.pid ?? after?.pid ?? row.pid;
  const pidStartedAt = mine?.pidStartedAt ?? after?.pidStartedAt ?? row.pidStartedAt;
  // **等它真的停下来**才返回：这个返回值被「跳过门禁直接合并」那条路当成「可以动工作区了」
  // 的信号，而合并紧接着就会把它脚下那个 worktree 删掉（第 1 轮审查 F2）。
  await noteIfStillAlive(taskId, row.logPath, await stopAcceptGate(taskId, pid, pidStartedAt));
  return (await latestRun(taskId).then(r => r && gateView(r))) ?? null;
}

/**
 * 这一按**当初**拿什么放的行。没验收过 / 老数据没留 → null（如实的「不知道」）。
 *
 * `passed` 那一档要把真的跑绿的那一次原样捞出来（按 id，不是「最近一次」）；记录本身可能
 * 已经随归档清理没了，那时只留 mode —— 回执据此说「凭据的明细已经不在了」。
 */
async function acceptBasis(task: TaskRow): Promise<AcceptGateBasis | null> {
  const mode = task.acceptedGateMode as AcceptGateBasisMode | null;
  if (mode !== "passed" && mode !== "skipped" && mode !== "unset") return null;
  if (mode !== "passed" || !task.acceptedGateRunId) return { mode, run: null };
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, task.acceptedGateRunId))).at(0);
  return { mode, run: row && row.taskId === task.id ? gateView(row) : null };
}

/** 这个任务名下的某一次（给「看完整日志」按 run 取用，顺带挡住跨任务的 id）。 */
export async function acceptGateRunOf(taskId: string, runId: string): Promise<AcceptGateView | null> {
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  return row && row.taskId === taskId ? gateView(row) : null;
}

/** 界面要的那一份：这个项目设没设、上一次跑成什么样、这次结果还作不作数、凭据是什么。 */
export async function acceptGateState(taskId: string): Promise<AcceptGateState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return { command: null, running: null, latest: null, basis: null };
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0) ?? null;
  const command = acceptGateCommandOf(project);
  const basis = await acceptBasis(task);
  const latestRow = await latestRun(taskId);
  if (!latestRow) return { command, running: null, latest: null, basis };
  const view = gateView(latestRow);
  if (latestRow.status === "running") return { command, running: view, latest: view, basis };
  // 新鲜度按**现在**这棵树算：前端据它决定说「已通过，可以直接验收」还是「要重跑」。
  // 判据与 acceptGateCheck 的复用判据必须是同一条（提交 + 命令），否则卡上说「不会重跑」、
  // 一点下去却真的重跑了。
  const head = project ? await headCommit(await gateCwd(task, project.repoPath)) : null;
  const stale = !head || head !== latestRow.sourceCommit || latestRow.command !== command;
  return { command, running: null, latest: { ...view, stale }, basis };
}

/**
 * ash 重启后的收拾：上一轮留下的 `running` 行一律落成「被打断」，并把那个 pid 的进程树
 * 收掉。**不接着跑**（理由见 accept-gate-process.ts 顶部）——留一行刷新后看得见的
 * 「上次没跑完」，比留一个永远转圈的幽灵诚实。
 */
export async function recoverAcceptGates(): Promise<{ interrupted: number }> {
  const rows = await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.status, "running"));
  for (const row of rows) {
    // 跨重启**必须先核身份**：ash 停了几小时再起来，那个 pid 多半已经是别的进程了，
    // 盲发信号打死的是无辜的人（第 1 轮审查）。核不出来就不发，并在日志里说清。
    const mine = isSameGateProcess(row.pid, row.pidStartedAt);
    // 先把行落成「被打断」再动刀（同超时那条路）：这个收拾动作在同一个进程里也可能撞上
    // 那条命令自己的退出回调，而那个回调会把它收成一条**红**并交给 agent 去修 —— 被打断
    // 不是红，它根本没有结论。
    await db.update(acceptGateRuns)
      .set({ status: "interrupted", failure: "server_restarted", finishedAt: now() })
      .where(eq(acceptGateRuns.id, row.id));
    const stopped = !mine || await stopAcceptGate(row.taskId, row.pid, row.pidStartedAt);
    appendGateLog(row.logPath, `\n[ash] ash 重启了，这一次没跑完，已按「被打断」收尾（${
      !mine ? (row.pid ? `没有向 pid ${row.pid} 发信号：它已经不是当初那条命令了` : "没有记下 pid")
        : stopped ? "残留进程已收掉" : "残留进程收不掉：TERM、KILL 都发过了仍确认不到它退出"}）。\n`);
    await appendTaskTimeline(
      row.taskId,
      `验收前置命令被打断：ash 重启时它还在跑（\`${row.command}\`），已按未完成收尾。重新点验收会从头跑一遍。`,
    );
    announceGate(row.taskId);
  }
  return { interrupted: rows.length };
}

/** 只给回归用：等这一次门禁连同「跑完之后那一步」全部做完。 */
export function whenAcceptGateSettled(runId: string): Promise<void> {
  return settlements.get(runId) ?? Promise.resolve();
}
