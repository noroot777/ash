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
import { and, eq, or } from "drizzle-orm";
import {
  ACCEPT_GATE_DIAGNOSIS_GENERATION,
  ACCEPT_GATE_TIMEOUT_MS,
  summarizeAcceptGate,
  type AcceptGateBasisMode,
  type AcceptGateCancelResult,
  type AcceptGateFailure,
  type AcceptGateStatus,
  type AcceptGateView,
} from "@ash/shared/accept-gate";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import { freezeGateScene } from "./accept-gate-diagnosis.js";
import {
  acceptGateLogPath, appendGateLog, stampAshNote,
  spawnAcceptGate,
} from "./accept-gate-process.js";
import { isAncestor } from "./git-accept.js";
import { commitAt, plannedMergeTarget } from "./task-branch-plan.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { acceptGateCommandOf, gateView, latestRun, prepareGateCwd, runningRun } from "./accept-gate-state.js";
import { gateStoppedSummary } from "./accept-gate-messages.js";
import { startGateWatch, type GateWatch } from "./accept-gate-watch.js";
import { createGateSnapshot, gateSnapshotPath, gateSourceMatches, readGateSource, removeGateSnapshot, verifyGateSnapshot, type GateSource } from "./accept-gate-source.js";
import { existingTaskWorkspacePath } from "./task-workspace.js";
export { acceptGateCommandOf, acceptGateRunOf, acceptGateState } from "./accept-gate-state.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import { id as newId, now } from "./util.js";
import { abandonUnstartedGateProcess, attachGateProcess, claimGateProcess, hasOwnedGateProcess, hasStoppingGateProcess,
  forgetGateProcess, reconcileGateProcesses, stopGateRun, stopOwnedGateProcesses } from "./accept-gate-ownership.js";
import { prepareGateLaunch, readGateLaunch } from "./accept-gate-launch.js";
import { gateConfinementUnavailable, gateExecutionNotice, gateScopeNotice } from "./accept-gate-confinement.js";
import { releaseGateOwnership } from "./accept-gate-release.js";
import { diagnoseGateFailure } from "./accept-gate-attribution.js";
import { handOffGateFailure, parseChoices } from "./accept-gate-handoff.js";
export { rehandOffAcceptGate } from "./accept-gate-handoff.js";
export type { AcceptGateChoices } from "./accept-gate-handoff.js";
import type { AcceptGateChoices } from "./accept-gate-handoff.js";
import { encodeGateEntryProbe, probeGateEntry } from "./accept-gate-entry.js";

type TaskRow = typeof tasks.$inferSelect;
type GateRow = typeof acceptGateRuns.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;


/** 这一按对门禁的额外指令。undefined = 照常（有就复用、没有就跑）。 */
export type AcceptGateIntent = "skip" | "rerun";
export type AcceptGateSnapshot = Pick<TaskRow, "acceptedGateMode" | "acceptedGateRunId">;

/** 门禁给出的三种「这一按还不能合」。形状与其它验收失败完全一致（AcceptFailure）。 */
export type AcceptGateReason = "accept_gate_required" | "accept_gate_running" | "accept_gate_failed";

type PendingStart = {
  command: string;
  cwd: string;
  projectId: string;
  sourceCommit: string | null;
  source: GateSource;
  targetBranch: string | null;
  targetCommit: string | null;
  fastForward: boolean | null;
  choices: AcceptGateChoices;
};

const pendingStarts = new Map<string, PendingStart>();
// 正在跑的那条：看门的（超时 + 静默）只活在内存里（重启后由 recoverAcceptGates 收拾残留）。
const live = new Map<string, { runId: string; watch: GateWatch; pid: number; pidStartedAt: string | null }>();
// runId → 这一次「跑完 + 跑完之后那一步（自动续验收 / 回流）」都做完了。只给回归用。
const settlements = new Map<string, Promise<void>>();
const outcomeWrites = new Map<string, Promise<void>>();
// 正在收尾的 runId。进程退出、取消、超时三条路可能同时到，而「读行 → 改行」之间有 await：
// 只靠库里那个 running 判据会让两条路都认为自己是第一个（于是自动续验收跑两遍）。
const settling = new Set<string>();

async function cleanupGateSnapshot(taskId: string, runId: string): Promise<void> {
  const logPath = acceptGateLogPath(taskId, runId);
  const launch = readGateLaunch(logPath);
  if (launch?.confinementEnrolled && gateScopeNotice(launch.confinementId)) {
    appendGateLog(logPath, `\n[ash] macOS 兼容监督已收尾；独立测试快照保留：${gateSnapshotPath(taskId, runId)}\n`);
    return;
  }
  await removeGateSnapshot(taskId, runId);
}

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
 * 验收主流程在动 git 之前问的那一句。返回 null = 放行。
 *
 * **只在仓库锁里调用**：它要读任务工作区与目标分支的当下状态，而判断和随后的合并必须
 * 看同一个世界。真正起进程在锁外（见文件头 ②）。
 */
export async function acceptGateCheck(
  task: TaskRow,
  project: ProjectRow | null,
  opts: { choices: AcceptGateChoices; intent?: AcceptGateIntent; passedRunId?: string;
    onBasis: (basis: AcceptGateSnapshot) => void },
): Promise<AcceptFailure | null> {
  const blocked = (): AcceptFailure => ({
    accepted: false, httpStatus: 409, taskId: task.id, reason: "accept_gate_running",
    error: "验收前置命令仍占用工作区，正在启动或尚未确认整棵进程树退出；暂不能合并、重跑或清理。",
    status: task.status,
  });
  if (hasStoppingGateProcess(task.id)) return blocked();
  const inFlight = await runningRun(task.id);
  if (inFlight) {
    if (opts.intent !== "skip") return { ...blocked(), gate: gateView(inFlight) };
    await cancelAcceptGate(task.id, "你选择了这次跳过验收前置命令，直接合并");
  }
  if (hasLiveAcceptGate(task.id)) return blocked();
  if (task.stage === "merged") return null;
  const recordBasis = (mode: AcceptGateBasisMode, runId: string | null) =>
    opts.onBasis({ acceptedGateMode: mode, acceptedGateRunId: runId });
  const command = acceptGateCommandOf(project);
  // 没设(或刚被撤掉):这一按直接合,凭据就是「那一刻没有这一关」。这一句**必须也写**——
  // 不写的话,上一次验收留下的那份 passed 会原地留着,给一份从没测过的代码背书(F1 实测)。
  if (!command || !project) {
    recordBasis("unset", null);
    return null;
  }
  const unavailable = gateConfinementUnavailable();
  if (unavailable && opts.intent !== "skip") {
    await appendTaskTimeline(task.id, `验收前置命令未执行（本机能力不可用）：${unavailable}`);
    return { accepted: false, httpStatus: 409, taskId: task.id, reason: "accept_gate_unavailable",
      error: unavailable, status: task.status };
  }

  const cwd = await prepareGateCwd(task, project.repoPath);
  let source: GateSource;
  try { source = await readGateSource(cwd, gateSnapshotPath(task.id, "identity")); }
  catch (error) {
    if (opts.intent !== "skip") return { accepted: false, httpStatus: 409, taskId: task.id,
      reason: "accept_gate_source_unavailable", error: String(error), status: task.status };
    source = { commit: null, fingerprint: "", dependencies: [], ambient: "" };
  }
  const head = source.commit;

  // 门禁绿了之后系统自己接着做完的那一次：带着凭据进来，不再重判。
  //
  // 但凭据换的是「不再重判」，**不是「不用核对」**：那条命令验的是开跑那一刻的树，而
  // 这里要合的是此刻这一棵。中间任务工作区又进了提交（用户在另一个窗口让它接着干活），
  // 或者项目把命令换了一条，这张凭据就不作数 —— 落到下面重新登记一次，按现在这一份再跑
  // 一遍（第 1 轮审查实测：没有这道核对时，合进 main 的是这条命令从没跑过的代码）。
  if (opts.passedRunId) {
    const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, opts.passedRunId))).at(0);
    if (row && row.taskId === task.id && row.status === "passed"
      && row.command === command && gateSourceMatches(row, source)) {
      await noteTargetDrift(task, project.repoPath, row);
      recordBasis("passed", row.id);
      return null;
    }
  }

  if (opts.intent === "skip") {
    // 跑着的时候选跳过 = 「不等了，现在就合」。那条命令必须**先收掉**：合并紧接着就是
    // 清理，worktree 会在它脚下被删掉（它的 cwd 正是那儿），而它还在往一个已经不存在的
    // 目录里跑测试、写日志。界面不给这条路，HTTP/MCP 给得出来（第 1 轮审查）。
    await appendTaskTimeline(
      task.id,
      `本次验收**跳过**了验收前置命令 \`${command}\`：这是你在验收时明确选的，` +
        `ash 没有跑它，也没有任何它通过的证据。${inFlight ? "正在跑的那一次已经一并收掉。" : ""}`,
    );
    recordBasis("skipped", null);
    return null;
  }

  const previous = await latestRun(task.id);
  const sameTree = !!previous && gateSourceMatches(previous, source)
    && previous.command === command && opts.intent !== "rerun";
  if (sameTree && previous!.status === "passed") {
    await noteTargetDrift(task, project.repoPath, previous!);
    await appendTaskTimeline(
      task.id,
      `验收前置命令沿用上一次的结果：\`${previous!.command}\` 在当前源码快照（${source.fingerprint.slice(0, 12)}）上已经通过，不再重跑。`,
    );
    recordBasis("passed", previous!.id);
    return null;
  }
  const targetBranch = task.useWorktree ? await plannedMergeTarget(task, project.repoPath) : null;
  const targetCommit = targetBranch ? await commitAt(project.repoPath, targetBranch) : null;
  pendingStarts.set(task.id, {
    command, cwd, projectId: project.id,
    sourceCommit: head, source,
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
  const included = !!row.sourceCommit && await isAncestor(repoPath, current, row.sourceCommit);
  const notice = `注意：验收前置命令跑的时候 ${row.targetBranch} 还在 ${row.targetCommit.slice(0, 8)}，现在已经是 ${current.slice(0, 8)}。`
    + (included ? "目标分支现在的内容已经包含在被测提交中。"
      : "它跑过的是任务分支那棵树，不是这一次的合并结果 —— 目标分支这期间进来的改动没有被它验过。");
  appendGateLog(row.logPath, `\n[ash] ${notice}\n`);
  await appendTaskTimeline(task.id, notice);
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
  if (hasOwnedGateProcess(taskId)) return null;
  const runId = newId();
  const logPath = acceptGateLogPath(taskId, runId);
  const snapshotCwd = gateSnapshotPath(taskId, runId);
  claimGateProcess(runId, taskId, logPath);
  let inserted = false;
  try {
    prepareGateLaunch(logPath);
    const already = await runningRun(taskId);
    if (already) { abandonUnstartedGateProcess(runId); return gateView(already); }
    const startedAt = now();
    await db.insert(acceptGateRuns).values({
      id: runId, taskId, projectId: plan.projectId, command: plan.command, cwd: snapshotCwd,
      status: "running", exitCode: null, failure: null, pid: null, processPending: true, logPath,
      executionMode: gateExecutionNotice() ? "macos-observed" : null,
      sourceCommit: plan.sourceCommit, targetBranch: plan.targetBranch, targetCommit: plan.targetCommit,
      sourceFingerprint: plan.source.fingerprint, sourceAmbient: plan.source.ambient,
      fastForward: plan.fastForward, acceptOptions: JSON.stringify(plan.choices), startedAt, finishedAt: null,
    });
    inserted = true;
    appendGateLog(logPath, `[ash] ${startedAt} 验收前置命令开跑\n[ash] source: ${plan.cwd}\n[ash] snapshot: ${snapshotCwd}\n[ash] fingerprint: ${plan.source.fingerprint}\n[ash] $ ${plan.command}\n\n`);
    const executionNotice = gateExecutionNotice();
    if (executionNotice) appendGateLog(logPath, `[ash] ${executionNotice}\n`);
    await appendTaskTimeline(
      taskId,
      `验收前置命令开跑：\`${plan.command}\`（独立快照 ${snapshotCwd}，源自 ${plan.cwd}）。rc=0 且进程监督收尾后才会继续合并；`
        + `绿了会自动把这次验收做完，红了会把日志交回这个任务去修。`
        + (executionNotice ? ` ${executionNotice}` : "")
        + (plan.fastForward === false
          ? ` 注意：目标分支 ${plan.targetBranch} 已经领先于这棵树，所以它验的不是最终的合并结果。`
          : ""),
    );
    announceGate(taskId);
  } catch (error) {
    abandonUnstartedGateProcess(runId);
    if (inserted) await db.update(acceptGateRuns).set({ status: "failed", failure: "spawn_failed",
      finishedAt: now(), processPending: false }).where(eq(acceptGateRuns.id, runId));
    throw error;
  }

  // 起进程到登记超时闹钟这一段**必须一个 await 都没有**：命令可能几毫秒就退了（`false`
  // 这种），退出回调一来就要找得到这条登记，否则它会被当成「已经被别人收过」而静默丢掉，
  // 任务永远停在「正在跑」（审查前自测复现）。
  let started: Awaited<ReturnType<typeof spawnAcceptGate>>;
  try {
    await createGateSnapshot(plan.cwd, snapshotCwd, plan.source);
    // **起跑前**核一眼这条命令点名要跑的东西在不在这份快照里。「测试压根没启动」这个结论
    // 整副面孔（不要改代码 / 出路是合分支或跳过）都压在这份事实上（第 2 轮审查 F1），所以
    // 它只能是起跑那一刻的事实 —— 跑完之后再核拿到的是跑完之后的状态。
    //
    // 一次定死，之后只读不重算。它是**纯读**的（看文件在不在、读一份 manifest 的文本），
    // 不起任何进程：第 7 轮那版把两条 npm 查询插进这一次执行里去问 runner 自己，第 8 轮审查
    // 实测撤掉（答的是查询那一次的状态，还替用户多跑了两次项目代码）。因此它**不够**单独
    // 授权「测试没启动」，只是三件必要条件之一 —— 另两件在 accept-gate-miss.ts。
    await db.update(acceptGateRuns)
      .set({ entryProbe: encodeGateEntryProbe(probeGateEntry(snapshotCwd, plan.command)) })
      .where(eq(acceptGateRuns.id, runId));
    const prepared = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
    if (prepared?.status !== "running") {
      await cleanupGateSnapshot(taskId, runId);
      return prepared ? gateView(prepared) : null;
    }
    if (plan.choices.reviewAuthority) {
      const { withReviewAuthority } = await import("./review-ownership.js");
      await withReviewAuthority(plan.choices.reviewAuthority, async () => {});
    }
    started = await spawnAcceptGate({
      command: plan.command,
      cwd: snapshotCwd,
      logPath,
      hold: true,
      onExit: (exit) => void settleGate(runId, exit.code === 0
        ? { status: "passed", exitCode: 0, failure: null }
        // 信号打死的那一条可能是取消/超时先发的刀 —— 那两条路自己会落更准的理由，
        // 这里的结论会被 settleGate 的幂等挡掉，只有「命令自己被外人杀了」才落到这儿。
        : { status: "failed", exitCode: exit.code, failure: exit.signal ? "canceled" : exit.code === null ? "spawn_failed" : "exit_code" }),
    });
  } catch (error) {
    appendGateLog(logPath, `\n[ash] 起不来：${error instanceof Error ? error.message : String(error)}\n`);
    await stopGateRun(runId);
    await settleGate(runId, { status: "failed", exitCode: null, failure: "spawn_failed" });
    const failed = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
    return failed ? gateView(failed) : null;
  }
  // 看门的只管一件事：撞上限时交出一段「现场」（停在哪一行、静了多久、产出节奏）。只写
  // 一句「超时」的话，事后分不出是某一步卡住还是整台机器在爬，而这两种的处置完全相反。
  // 它**不自己写日志**：现场必须排在所有人后面写，否则会被停止期的清理输出顶出尾巴
  // （第 1 轮审查 F2）。它也不拿静默去掐命令，理由见 ACCEPT_GATE_SILENCE_MS。
  const watch = startGateWatch({ logPath, onVerdict: (verdict) => void (async () => {
    appendGateLog(logPath, `\n[ash] 超过 ${Math.round(ACCEPT_GATE_TIMEOUT_MS / 60_000)} 分钟，按超时处理，正在收掉它。\n`);
    // **先认领终态、再动刀**（同取消那条路）：反过来的话，刀落下去触发的退出回调会先把
    // 这一次收成「命令被外人杀了」，连带把日志当成一条红交给 agent 去修 —— 而它其实是
    // 超时。占用不会因此漏空：stopAcceptGate 从进场就立起「还没确认退出」那条记号。
    await settleGate(runId, { status: "failed", exitCode: null, failure: "timeout",
      note: verdict.note, scene: verdict.scene });
  })() });
  live.set(taskId, { runId, watch, pid: started.pid, pidStartedAt: started.startedAt });
  attachGateProcess(runId, started.pid, started.startedAt);

  try {
    await db.update(acceptGateRuns).set({ pid: started.pid, pidStartedAt: started.startedAt }).where(eq(acceptGateRuns.id, runId));
    if (plan.choices.reviewAuthority) {
      const { withReviewAuthority } = await import("./review-ownership.js");
      await withReviewAuthority(plan.choices.reviewAuthority, async () => { await started.authorize(); });
    } else await started.authorize();
  } catch (error) {
    appendGateLog(logPath, `\n[ash] 启动握手失败，命令未获放行：${String(error)}\n`);
    await settleGate(runId, { status: "failed", exitCode: null, failure: "spawn_failed" });
  }
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  // 「登记 → 起进程 → pid 落库」这一段里有 await，而取消那一下**可能正好插在中间**：它那时
  // 读到的 pid 还是 null，于是刀发给了空气，库里却已经落成 canceled —— 进程就此没人认领
  // （第 1 轮审查 F2 的第二个窗口）。所以这里回头再看一眼：不是 running 了就说明有人在这
  // 期间收过它，由**我们**来把刚起的这条收掉（两边都查一次，谁后到谁负责，窗口就封住了）。
  if (row && row.status !== "running") {
    appendGateLog(logPath, `\n[ash] 这一次在起跑的同时就被收掉了（${row.status}），正在停掉刚起的进程。\n`);
    const watching = live.get(taskId);
    if (watching?.runId === runId) { watching.watch.stop(); live.delete(taskId); }
    await noteIfStillAlive(taskId, logPath, await stopGateRun(runId));
  }
  return row ? gateView(row) : null;
}

/** 停不掉就**如实说**：工作区仍被占着，用户刷新后也看得见这句（根 AGENTS.md 那条）。 */
async function noteIfStillAlive(taskId: string, logPath: string, stopped: boolean): Promise<void> {
  if (stopped) return;
  appendGateLog(logPath, `\n[ash] 尚未取得整棵进程树退出的证据；身份未核实时不会盲发信号。\n`);
  await appendTaskTimeline(
    taskId,
    "验收前置命令尚未确认整棵进程树退出：可能是进程身份或归属暂时读不出，也可能仍有进程存活。"
      + "**这个工作区仍按被占用处理**，合并与清理继续阻止；再次取消、验收或清理时会重新核对。",
  );
}

/** 登记了却没能发射（主流程中途出错）时把登记撤掉，别留一条永远不跑的意图。 */
export function dropPendingAcceptGate(taskId: string): boolean {
  return pendingStarts.delete(taskId);
}

/**
 * 一次门禁的终点。三条路（命令自己退了 / 取消 / 超时）都走这里，**第一个到的说了算**，
 * 后到的原样丢掉 —— 否则「自动把验收接着做完」会跑两遍。
 */
async function settleGate(
  runId: string,
  outcome: { status: Exclude<AcceptGateStatus, "running">; exitCode: number | null; failure: AcceptGateFailure | null;
    /** 「卡在哪」的一句话版本，落进任务时间线。只有看门的（超时）给得出。 */
    note?: string;
    /** 同一件事的完整现场。结算一开头就冻结存盘，不追加进日志，见下面写它那一段。 */
    scene?: string },
  waitForContinuation = true,
): Promise<void> {
  if (settling.has(runId)) return waitForContinuation ? settlements.get(runId) : outcomeWrites.get(runId);
  settling.add(runId);
  let finishOutcome!: () => void;
  const written = new Promise<void>(resolve => { finishOutcome = resolve; });
  outcomeWrites.set(runId, written);
  let rowForFailure: GateRow | undefined;
  let outcomeSaved = false;
  const settle = (async () => {
    const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
    rowForFailure = row;
    if (!row || row.status !== "running") return;
    // 现场**排在所有可能失败的事情前面**存盘（第 3 轮审查 F1）。两条理由，缺一条都不够：
    //  · 下面任何一步抛出来（快照删不掉的 EACCES/EPERM 是实测发生过的）都会把这个 async
    //    甩进 catch，而那时这一行已经写成 failed、processPending=false，recoverAcceptGates
    //    不会再选中它 —— 只存在内存里的那份现场就**永久**没了；
    //  · 它必须早于终态落库：结果一旦可见，用户下一步就是来找这段说明。
    // 到这一句为止我们已经独占了这次结算（settling + 上面那句 running 核对），所以存下来的
    // 现场不会是某个没赢的判定留下的。
    const sceneFailure = outcome.scene ? freezeGateScene(row.logPath, outcome.scene) : null;
    if (sceneFailure) appendGateLog(row.logPath, `\n[ash] ${sceneFailure}\n${outcome.scene}\n`);
    const stopped = await stopGateRun(runId, false);
    await noteIfStillAlive(row.taskId, row.logPath, stopped);
    if (outcome.status === "passed" && !stopped) outcome = { status: "failed", exitCode: outcome.exitCode, failure: "process_unconfirmed" };
    if (outcome.status === "passed" && !await verifyGateSnapshot(row.cwd, {
      // ambient 不参与收尾核验:那一项问的是「依赖输入还新不新鲜」(复用判据),这里问的是
      // 「这份副本还是不是当初那一份」。原样带上 DB 里记的那一份，不另算一次。
      commit: row.sourceCommit, fingerprint: row.sourceFingerprint ?? "", dependencies: [],
      ambient: row.sourceAmbient ?? "",
    })) outcome = { status: "failed", exitCode: outcome.exitCode, failure: "source_changed" };
    // rc≠0 的那一档再问一句「这到底是不是代码红了」：命令点名要跑的东西在被测快照里解析
    // 不出来时，线索、目标分支上的情形、出路都跟「修某条断言」不是一回事。认不出就是
    // null，照旧按 exit_code 处理。判据见 accept-gate-miss.ts，I/O 在 accept-gate-attribution.ts。
    // 传 outcome 而不是 row：`row` 是结算**前**读出来的那一行，上面的 exitCode 还是插入时
    // 的 null，照它判就永远走不到按退出码兜底那一档（第 1 轮审查 N1）。
    // 这一处的 catch **留着**：看门的结论已经落下来了（`outcome` 就是它），归因只是往上面再贴一句
    // 「卡在哪」。它自己读不出来时正确的答案就是「不贴」—— 失败方向是少一句线索，不是放过一次验收。
    const diagnosed = outcome.status === "failed" ? await diagnoseGateFailure(row, outcome).catch(() => null) : null;
    // 展开保留 main 侧的 note / scene：看门的给出的「卡在哪」不能被这一步顶掉。
    if (diagnosed) outcome = { ...outcome, failure: diagnosed.failure };
    const watching = live.get(row.taskId);
    const finishedAt = now();
    await db.update(acceptGateRuns)
      .set({ status: outcome.status, exitCode: outcome.exitCode, failure: outcome.failure, finishedAt, processPending: !stopped,
        diagnosis: diagnosed?.diagnosis ?? null, missAttribution: diagnosed?.attribution ?? null,
        // 结论连**代号**一起落盘：判据下次再撤回时，这一代的结论就自动不再当事实用
        // （第 2 轮审查 F1，闸在 gateView）。
        diagnosisGeneration: diagnosed ? ACCEPT_GATE_DIAGNOSIS_GENERATION : null })
      // 状态闸：上面那句读到的 running 和这一句之间隔着 await，只有真的还 running 才翻。
      .where(and(eq(acceptGateRuns.id, runId), eq(acceptGateRuns.status, "running")));
    outcomeSaved = true;
    if (stopped) forgetGateProcess(runId);
    // 删不掉快照是磁盘上的事（EACCES/EPERM 实测会发生），不该把一条已经判完的门禁连同
    // 它的结论、时间线、交接一起甩进 catch（第 3 轮审查 F1）。
    if (stopped) await cleanupGateSnapshot(row.taskId, runId).catch((error) => appendGateLog(row.logPath,
      `\n[ash] 快照没能删掉，它还留在 ${gateSnapshotPath(row.taskId, runId)}：${String(error)}\n`));
    if (watching?.runId === runId) { watching.watch.stop(); live.delete(row.taskId); }
    const settled = { ...row, ...outcome, finishedAt, diagnosis: diagnosed?.diagnosis ?? null,
      missAttribution: diagnosed?.attribution ?? null,
      diagnosisGeneration: diagnosed ? ACCEPT_GATE_DIAGNOSIS_GENERATION : null };
    const view = gateView(settled);
    // 结论也追加进日志，而它是**多行**的 —— 逐行打标记，别让后面几行被归类那一层当成
    // 「别的程序写的」（见 accept-gate-process.ts 的 stampAshNote）。
    appendGateLog(row.logPath, `\n[ash] ${finishedAt} ${summarizeAcceptGate(view)}\n`
      + (diagnosed ? stampAshNote(`\n${diagnosed.diagnosis}\n`) : ""));
    await appendTaskTimeline(row.taskId,
      `${summarizeAcceptGate(view)}。${outcome.note ? ` ${outcome.note}` : ""}${sceneFailure ? ` ${sceneFailure}` : ""}`);
    // 归类结论要**单独进一条时间线**：它是用户刷新后唯一能找回「这条红是怎么来的」的地方，
    // 跟在摘要那一行后面会被折进去（根 AGENTS.md「停止/暂停必须留下持久可见的状态」同款判据）。
    if (diagnosed) await appendTaskTimeline(row.taskId, diagnosed.diagnosis);
    announceGate(row.taskId);
    finishOutcome();
    if (stopped && outcome.status === "passed") await continueAcceptance(row);
    else if (stopped && outcome.status === "failed") await handOffGateFailure(row, view);
  })().catch((error) => {
    if (rowForFailure && !outcomeSaved) appendGateLog(rowForFailure.logPath,
      `\n[ash] 终态写入失败，本次尚未结算；请重试取消，工作区仍受保护：${String(error)}\n`);
    console.error(`[ash] 验收前置命令收尾失败（${runId}）:`, error);
  }).finally(() => { finishOutcome(); settling.delete(runId); });
  settlements.set(runId, settle);
  // 内存账本只给「等这一次收完」用，留着历史没有意义，满了就把最老的挤掉。**两个账本
  // 一起裁**：从前只裁 settlements，settling 这个 Set 只 add 不删，每跑一轮就永久多存
  // 一个 run id（第 1 轮审查不拦项 4）。幂等不受影响 —— 被挤掉的那些早就收完了。
  while (settlements.size > 100) {
    const oldest = settlements.keys().next().value!;
    settlements.delete(oldest);
    outcomeWrites.delete(oldest);
    settling.delete(oldest);
  }
  await (waitForContinuation ? settle : written);
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
    reviewAuthority: choices.reviewAuthority,
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


/**
 * 这个任务现在有没有一条门禁真的在跑。**同步**判据（读进程内那张表），因为问这句话的
 * 是「这条任务动不动得」那三个入口（删任务 / 删项目 / 释放工作区），它们判完就动 git。
 */
export function hasLiveAcceptGate(taskId: string): boolean {
  return pendingStarts.has(taskId) || live.has(taskId) || hasOwnedGateProcess(taskId);
}

/**
 * 删任务之前把它名下还在跑的门禁进程收掉。
 */
export async function stopAcceptGatesForTask(taskId: string): Promise<boolean> {
  const running = live.get(taskId);
  if (running) running.watch.stop();
  // 这里**必须等**：紧接着就要删工作区，而它的 cwd 正在那儿。
  const stopped = await stopOwnedGateProcesses(taskId);
  if (stopped && running) live.delete(taskId);
  return stopped;
}

/**
 * 这一按会不会**真的**要跑一遍门禁。给批量验收按下去之前的预判用。
 *
 * 判据与 acceptGateCheck 的复用判据同源（提交 + 命令 + 上次是绿的），两边必须一起改 ——
 * 这边说「不用跑」、那边却登记一条去跑，统一验收就会停在半路。
 */
export async function acceptGateWouldRun(task: TaskRow, project: ProjectRow | null): Promise<boolean> {
  await reconcileGateProcesses(task.id);
  if (task.stage === "merged" || task.stage === "accepted") return false;
  if (hasLiveAcceptGate(task.id)) return true;
  const command = acceptGateCommandOf(project);
  if (!command || !project) return false;
  if (gateConfinementUnavailable()) return false;
  if (await runningRun(task.id)) return true;
  const cwd = await existingTaskWorkspacePath(task, project.repoPath);
  if (!cwd) return true;
  // 这一处的 catch **留着**，而且必须倒向 `false`：`readGateSource` 抛出来的主干就是「源码不可用」
  // （工作区有未提交/未跟踪文件、读不到提交），而那一档的既定语义是**验收在门禁之前就被拒**
  // （`acceptTask` 回 `accept_gate_source_unavailable`，一条运行记录都不建）。倒向 `true` 会让批量
  // 预判说「这一按要跑门禁」，而真按下去压根不会跑 —— `test-accept-gate-readonly.ts` 的
  // source-unavailable 夹具把这两边钉在一起。
  const source = await readGateSource(cwd, gateSnapshotPath(task.id, "identity")).catch(() => null);
  if (!source) return false;
  const previous = await latestRun(task.id);
  return !(previous && previous.status === "passed"
    && gateSourceMatches(previous, source) && previous.command === command);
}

export async function cancelAcceptGate(taskId: string, reason = "你在验收台上取消了这一次", runId?: string): Promise<AcceptGateCancelResult> {
  await reconcileGateProcesses(taskId);
  const row = runId !== undefined
    ? (await db.select().from(acceptGateRuns).where(and(eq(acceptGateRuns.taskId, taskId), eq(acceptGateRuns.id, runId)))).at(0)
    : await runningRun(taskId) ?? await latestRun(taskId);
  if (!row) {
    if (runId !== undefined) return { outcome: "not_running", runId, gate: null };
    const stopped = await stopOwnedGateProcesses(taskId);
    return { outcome: stopped ? "not_running" : "stopping", runId: runId ?? null, gate: null };
  }
  const wasRunning = row.status === "running";
  if (wasRunning) {
    appendGateLog(row.logPath, `\n[ash] ${reason}，正在收掉它。\n`);
    await settleGate(row.id, { status: "canceled", exitCode: null, failure: "canceled" }, false);
  } else if (row.processPending && await stopGateRun(row.id)) await cleanupGateSnapshot(row.taskId, row.id);
  const current = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id))).at(0) ?? row;
  announceGate(taskId);
  return { outcome: current.status === "running" ? "settlement_failed" : current.processPending ? "stopping"
    : wasRunning && current.status === "canceled" ? "canceled" : "already_finished",
    runId: current.id, gate: gateView(current) };
}

export async function forceReleaseAcceptGate(taskId: string, runId: string) {
  const result = await releaseGateOwnership(taskId, runId);
  if (result.ok) {
    const active = live.get(taskId);
    if (active?.runId === runId) { active.watch.stop(); live.delete(taskId); }
    announceGate(taskId);
  }
  return result;
}

/**
 * ash 重启后的收拾：上一轮留下的 `running` 行一律落成「被打断」，并把那个 pid 的进程树
 * 收掉。**不接着跑**（理由见 accept-gate-process.ts 顶部）——留一行刷新后看得见的
 * 「上次没跑完」，比留一个永远转圈的幽灵诚实。
 */
export async function recoverAcceptGates(): Promise<{ interrupted: number }> {
  const rows = await db.select().from(acceptGateRuns).where(or(
    eq(acceptGateRuns.status, "running"), eq(acceptGateRuns.processPending, true),
  ));
  for (const row of rows) {
    claimGateProcess(row.id, row.taskId, row.logPath);
    attachGateProcess(row.id, row.pid, row.pidStartedAt, true);
  }
  for (const row of rows) {
    // 跨重启**必须先核身份**：ash 停了几小时再起来，那个 pid 多半已经是别的进程了，
    // 盲发信号打死的是无辜的人（第 1 轮审查）。核不出来就不发，并在日志里说清。
    // 先把行落成「被打断」再动刀（同超时那条路）：这个收拾动作在同一个进程里也可能撞上
    // 那条命令自己的退出回调，而那个回调会把它收成一条**红**并交给 agent 去修 —— 被打断
    // 不是红，它根本没有结论。
    if (row.status === "running") await db.update(acceptGateRuns)
      .set({ status: "interrupted", failure: "server_restarted", finishedAt: now(), processPending: true })
      .where(eq(acceptGateRuns.id, row.id));
    const stopped = await stopGateRun(row.id);
    if (stopped) await cleanupGateSnapshot(row.taskId, row.id);
    const stoppedSummary = gateStoppedSummary(row.executionMode);
    appendGateLog(row.logPath, `\n[ash] ash 重启后核对进程，执行状态为 ${row.status === "running" ? "interrupted" : row.status}（${
      stopped ? stoppedSummary : "残留进程尚未确认退出，工作区仍被占用"}）。\n`);
    await appendTaskTimeline(
      row.taskId,
      (row.status === "running"
        ? `验收前置命令被打断：ash 重启时它还在跑（\`${row.command}\`），已按未完成收尾。`
        : `ash 重启后继续核对验收前置命令 \`${row.command}\` 的停止责任（原状态 ${row.status}）。`)
      + (stopped ? `${stoppedSummary}，工作区占用已释放。` : "尚未确认进程退出，合并和清理仍被阻止。"),
    );
    announceGate(row.taskId);
  }
  return { interrupted: rows.filter(row => row.status === "running").length };
}

/** 只给回归用：等这一次门禁连同「跑完之后那一步」全部做完。 */
export function whenAcceptGateSettled(runId: string): Promise<void> {
  return settlements.get(runId) ?? Promise.resolve();
}
