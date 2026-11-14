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
//  ③ **收**（settleGate，引擎在 accept-gate-settle.ts；重启接管在 accept-gate-recover.ts）：绿了**自动把这次验收接着做完**（用户只点了一次，剩下的是
//     系统欠他的），红了把日志回流给 agent 去修，跟撞冲突叫醒 agent 同一套退路。
//
// 一个任务同时只会有一条门禁在跑（库里 running 行 + 进程表双保险）。
import { and, eq } from "drizzle-orm";
import {
  type AcceptGateBasisMode,
  type AcceptGateCancelResult,
  type AcceptGateView,
} from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import { acceptGateLogPath, appendGateLog, spawnAcceptGate } from "./accept-gate-process.js";
import { isAncestor } from "./git-accept.js";
import { commitAt } from "./task-branch-plan.js";
import { appendTaskTimeline, alertLine, receiptLine } from "./task-timeline.js";
import { acceptGateCommandOf, acceptGatePrepareOf, gateView, latestRun, prepareGateCwd, runningRun, sameGateRecipe } from "./accept-gate-state.js";
import { createGateSnapshot, gateSnapshotPath, gateSourceMatches, readGateSource, type GateSource } from "./accept-gate-source.js";
import { readOnlyGit, snapshotMaterialization } from "./accept-gate-preview.js";
import { checkoutDivergence, encodePhysical, snapshotPhysical } from "./accept-gate-physical.js";
import { existingTaskWorkspacePath } from "./task-workspace.js";
export { acceptGateCommandOf, acceptGateRunOf, acceptGateState } from "./accept-gate-state.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import { id as newId, now } from "./util.js";
import { abandonUnstartedGateProcess, attachGateProcess, claimGateProcess, hasOwnedGateProcess, hasStoppingGateProcess,
  reconcileGateProcesses, stopGateRun, stopOwnedGateProcesses } from "./accept-gate-ownership.js";
import { prepareGateLaunch } from "./accept-gate-launch.js";
import { gateConfinementUnavailable, gateExecutionNotice } from "./accept-gate-confinement.js";
import { releaseGateOwnership } from "./accept-gate-release.js";
import { gateExitOutcome, recordedGateExit, unrecordedGateExit } from "./accept-gate-exit.js";
import { announceGate, cleanupGateSnapshot, live, noteIfStillAlive, settleGate, superviseGate } from "./accept-gate-settle.js";
export { whenAcceptGateSettled } from "./accept-gate-settle.js";
export { recoverAcceptGates } from "./accept-gate-recover.js";
export { rehandOffAcceptGate } from "./accept-gate-handoff.js";
export type { AcceptGateChoices } from "./accept-gate-handoff.js";
import type { AcceptGateChoices } from "./accept-gate-handoff.js";
import { encodeGateEntryProbe, probeGateEntry } from "./accept-gate-entry.js";
import { gateBaselineMatches, gateBaselineNotice, gateDriftBesidesTree, resolveGateBaseline, type GateBaselineBlock,
  type GateBaselinePlan } from "./accept-gate-baseline.js";
import { handOffConflict } from "./accept-conflict.js";

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
  /** 快照里先跑的准备命令（null = 没配，依赖借用工作区那一份）。 */
  prepare: string | null;
  cwd: string;
  projectId: string;
  repoPath: string;
  sourceCommit: string | null;
  source: GateSource;
  targetBranch: string | null;
  targetCommit: string | null;
  fastForward: boolean | null;
  baseline: GateBaselinePlan;
  choices: AcceptGateChoices;
};

const pendingStarts = new Map<string, PendingStart>();
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
  const prepare = acceptGatePrepareOf(project);
  // 没设(或刚被撤掉):这一按直接合,凭据就是「那一刻没有这一关」。这一句**必须也写**——
  // 不写的话,上一次验收留下的那份 passed 会原地留着,给一份从没测过的代码背书(F1 实测)。
  if (!command || !project) {
    recordBasis("unset", null);
    return null;
  }
  const unavailable = gateConfinementUnavailable();
  if (unavailable && opts.intent !== "skip") {
    await appendTaskTimeline(task.id, alertLine(`验收前置命令未执行（本机能力不可用）：${unavailable}`));
    return { accepted: false, httpStatus: 409, taskId: task.id, reason: "accept_gate_unavailable",
      error: unavailable, status: task.status };
  }

  const cwd = await prepareGateCwd(task, project.repoPath);
  let source: GateSource;
  try { source = await readGateSource(cwd, gateSnapshotPath(task.id, "identity", !!prepare), !!prepare); }
  catch (error) {
    if (opts.intent !== "skip") return { accepted: false, httpStatus: 409, taskId: task.id,
      reason: "accept_gate_source_unavailable", error: String(error), status: task.status };
    source = { commit: null, fingerprint: "", dependencies: [], ambient: "" };
  }
  const head = source.commit;
  // 门禁基准（项目级）：拦在一切复用与登记之前 —— 「没含目标分支」「预演冲突」这两种在跑之前就
  // 说得清，不该先烧十几分钟再告诉用户。明确跳过门禁的那一按不受它管：什么都不跑，就无所谓测哪棵。
  const baseline = opts.intent === "skip" ? null : await resolveGateBaseline(task, project, head, { cwd, dependencies: source.dependencies });
  if (baseline?.block) return await baselineRefusal(task, baseline.block);
  const plan = baseline?.plan ?? null;

  // 门禁绿了之后系统自己接着做完的那一次：带着凭据进来，不再重判。
  //
  // 但凭据换的是「不再重判」，**不是「不用核对」**：那条命令验的是开跑那一刻的树，而
  // 这里要合的是此刻这一棵。中间任务工作区又进了提交（用户在另一个窗口让它接着干活），
  // 或者项目把命令换了一条，这张凭据就不作数 —— 落到下面重新登记一次，按现在这一份再跑
  // 一遍（第 1 轮审查实测：没有这道核对时，合进 main 的是这条命令从没跑过的代码）。
  if (opts.passedRunId) {
    const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, opts.passedRunId))).at(0);
    if (row && row.taskId === task.id && row.status === "passed"
      && sameGateRecipe(row, command, prepare) && gateSourceMatches(row, source)) {
      // 合并预览档的凭据还要核基准：这一次绿的是「分支 + 当时的目标分支」，跑的那十几分钟里目标
      // 分支又进了别的合并，它就不是这一次要合出来的那棵树 —— 落到下面按新的目标分支重新预演。
      if (gateBaselineMatches(row, plan)) {
        await noteTargetDrift(task, project.repoPath, row);
        recordBasis("passed", row.id);
        return null;
      }
      const besides = gateDriftBesidesTree(row, plan);
      if (besides === "materialization") await appendTaskTimeline(task.id, receiptLine("验收前置命令通过了，但它跑的那会儿之后项目的换行配置"
        + "（core.autocrlf / core.eol）变了：同一棵树合进去之后检出的字节已经不是测过的那份。旧结果不拿来合，按现在的配置重新跑一遍。"));
      else if (besides === "physical") await appendTaskTimeline(task.id, receiptLine(`验收前置命令通过了，但它跑的那会儿之后目标分支 ${plan?.targetBranch ?? ""} 的检出里`
        + "有这次合并不会重写的文件变了（字节和测的时候不是同一份，树和 `git status` 看不出来）。旧结果不拿来合，按现在的检出重新跑一遍。"));
      else await appendTaskTimeline(task.id, receiptLine(`验收前置命令通过了，但它预演的是 ${row.targetBranch ?? "目标分支"}@${row.previewBase?.slice(0, 8) ?? "（分支快照）"}，`
        + `现在要合的已经是 ${plan?.targetBranch ?? "目标分支"}@${plan?.previewBase?.slice(0, 8) ?? "（分支快照）"}。旧结果不拿来合这一棵，按现在的目标分支重新跑一遍。`));
    }
  }

  if (opts.intent === "skip") {
    // 跑着的时候选跳过 = 「不等了，现在就合」。那条命令必须**先收掉**：合并紧接着就是
    // 清理，worktree 会在它脚下被删掉（它的 cwd 正是那儿），而它还在往一个已经不存在的
    // 目录里跑测试、写日志。界面不给这条路，HTTP/MCP 给得出来（第 1 轮审查）。
    await appendTaskTimeline(
      task.id,
      receiptLine(`本次验收**跳过**了验收前置命令 \`${command}\`：这是你在验收时明确选的，` +
        `ash 没有跑它，也没有任何它通过的证据。${inFlight ? "正在跑的那一次已经一并收掉。" : ""}`),
    );
    recordBasis("skipped", null);
    return null;
  }

  const previous = await latestRun(task.id);
  const sameTree = !!previous && gateSourceMatches(previous, source) && gateBaselineMatches(previous, plan)
    && sameGateRecipe(previous, command, prepare) && opts.intent !== "rerun";
  if (sameTree && previous!.status === "passed") {
    await noteTargetDrift(task, project.repoPath, previous!);
    await appendTaskTimeline(
      task.id,
      receiptLine(`验收前置命令沿用上一次的结果：\`${previous!.command}\` 在当前源码快照（${source.fingerprint.slice(0, 12)}）上已经通过，不再重跑。`),
    );
    recordBasis("passed", previous!.id);
    return null;
  }
  // 走到这里一定不是 skip（那一档上面已经返回了），所以 plan 必在。
  const { targetBranch, targetCommit } = plan!;
  pendingStarts.set(task.id, {
    command, prepare, cwd, projectId: project.id, repoPath: project.repoPath,
    sourceCommit: head, source,
    targetBranch,
    targetCommit,
    // 合并会不会是纯 fast-forward：是 → 被测的就是合并结果；否 → 分支快照档只记一行，不拦。
    fastForward: targetCommit && head ? await isAncestor(project.repoPath, targetCommit, head) : null,
    baseline: plan!,
    choices: opts.choices,
  });
  return {
    accepted: false, httpStatus: 409, taskId: task.id, reason: "accept_gate_required",
    error: `这个项目设了验收前置命令 \`${command}\`，合并前要先跑一遍。`,
    status: task.status,
  };
}

/**
 * 基准拦下来的那一按。冲突那一种**跟真合并撞冲突同一个口径**：同样的 reason / 冲突文件，同样把来源
 * 任务叫醒去解（交接在锁释放之后才真的发出，见 accept-conflict.ts）。
 */
async function baselineRefusal(task: TaskRow, block: GateBaselineBlock): Promise<AcceptFailure> {
  await appendTaskTimeline(task.id, alertLine(`验收未完成：${block.error}`));
  const conflictHandoff = block.reason === "merge_conflict"
    ? await handOffConflict(task, { ...block, preview: true }) : null;
  return { accepted: false, httpStatus: 409, taskId: task.id, reason: block.reason, error: block.error,
    status: task.status, targetBranch: block.targetBranch, sourceBranch: block.sourceBranch,
    conflictFiles: block.conflictFiles, ...(conflictHandoff ? { conflictHandoff } : {}) };
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
  await appendTaskTimeline(task.id, alertLine(notice));
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
  const snapshotCwd = gateSnapshotPath(taskId, runId, !!plan.prepare);
  claimGateProcess(runId, taskId, logPath);
  let inserted = false;
  try {
    prepareGateLaunch(logPath);
    const already = await runningRun(taskId);
    if (already) { abandonUnstartedGateProcess(runId); return gateView(already); }
    const startedAt = now();
    await db.insert(acceptGateRuns).values({
      id: runId, taskId, projectId: plan.projectId, command: plan.command, prepareCommand: plan.prepare, cwd: snapshotCwd,
      status: "running", exitCode: null, failure: null, pid: null, processPending: true, logPath,
      executionMode: gateExecutionNotice() ? "macos-observed" : null,
      sourceCommit: plan.sourceCommit, targetBranch: plan.targetBranch, targetCommit: plan.targetCommit,
      sourceFingerprint: plan.source.fingerprint, sourceAmbient: plan.source.ambient,
      fastForward: plan.fastForward, previewBase: plan.baseline.previewBase, previewTree: plan.baseline.previewTree,
      previewMaterialization: plan.baseline.previewMaterialization,
      acceptOptions: JSON.stringify(plan.choices), startedAt, finishedAt: null,
    });
    inserted = true;
    const baselineNotice = gateBaselineNotice(plan.baseline);
    appendGateLog(logPath, `[ash] ${startedAt} 验收前置命令开跑\n[ash] source: ${plan.cwd}\n[ash] snapshot: ${snapshotCwd}\n[ash] fingerprint: ${plan.source.fingerprint}\n`
      + (baselineNotice ? `[ash] baseline: ${baselineNotice}（预览基准 ${plan.baseline.targetBranch} = ${plan.baseline.previewBase}）\n` : "")
      + (plan.prepare ? `[ash] 准备命令（在快照里先装依赖）\n[ash] $ ${plan.prepare}\n\n` : `[ash] $ ${plan.command}\n\n`));
    const executionNotice = gateExecutionNotice();
    if (executionNotice) appendGateLog(logPath, `[ash] ${executionNotice}\n`);
    await appendTaskTimeline(
      taskId,
      receiptLine(`验收前置命令开跑：\`${plan.command}\`（独立快照 ${snapshotCwd}，源自 ${plan.cwd}`
        + (plan.prepare ? `；先在快照里跑准备命令 \`${plan.prepare}\` 装依赖` : "") + "）。rc=0 且进程监督收尾后才会继续合并；"
        + `绿了会自动把这次验收做完，红了会把日志交回这个任务去修。`
        + (executionNotice ? ` ${executionNotice}` : "")
        + (baselineNotice ? ` ${baselineNotice}。`
          : plan.fastForward === false
            ? ` 注意：目标分支 ${plan.targetBranch} 已经领先于这棵树，所以它验的不是最终的合并结果。`
            : "")),
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
    const previewCommit = await createGateSnapshot(plan.cwd, snapshotCwd, plan.source,
      // 合并预览档一律走封好的快照（已含目标分支时 tree 为 null：不合，只在封好的环境里检出分支那棵树）。
      plan.baseline.previewBase && plan.baseline.previewSettings
        ? { targetCommit: plan.baseline.previewBase, tree: plan.baseline.previewTree, settings: plan.baseline.previewSettings } : undefined);
    if (previewCommit) appendGateLog(logPath, `[ash] preview: 快照里的合并结果 ${previewCommit}（tree ${plan.baseline.previewTree}）\n\n`);
    // 快照是全新写的，真合并只重写改到的文件：目标检出里没改到的那些磁盘上和快照不是同一份，就不跑
    // （accept-gate-physical.ts）。拦在起进程之前，落成「起不来」并把原因写进日志。对得上就把测过的这份
    // 记成摘要进凭据：复用旧绿与最终落地都按它再核目标检出（第 5 轮复审 F2）。
    let physical: string | null = null;
    if (plan.baseline.previewBase && plan.targetBranch && plan.sourceCommit) {
      const tree = plan.baseline.previewTree ?? (await readOnlyGit(plan.repoPath, ["rev-parse", `${plan.sourceCommit}^{tree}`])).stdout.trim();
      const drifted = await checkoutDivergence(plan.repoPath, plan.targetBranch, plan.baseline.previewBase, tree, snapshotCwd, plan.source.dependencies);
      if (drifted.length) {
        const named = drifted.slice(0, 5).join("、") + (drifted.length > 5 ? ` 等 ${drifted.length} 个` : "");
        throw new Error(`合并预览这次没有跑：目标分支 ${plan.targetBranch} 的检出里有文件（${named}）和按现在的检出设置重新写出来的不一样`
          + "（多半是改换行 / 链接设置之前检出的），合并不会重写它们，快照里却是新写的，测了也说明不了合进去之后怎样。"
          + "在那个检出里把它们重新检出一遍（比如 `git rm --cached -r -q . && git reset --hard`，会丢掉未提交的改动，先确认工作区干净），"
          + "或者在项目设置 → 验收里换成「要求已含目标分支」或「分支快照」。");
      }
      physical = encodePhysical(await snapshotPhysical(plan.repoPath, plan.targetBranch, plan.baseline.previewBase, tree, snapshotCwd,
        plan.source.dependencies, await snapshotMaterialization(snapshotCwd)));
    }
    // **起跑前**核一眼这条命令点名要跑的东西在不在这份快照里。「测试压根没启动」这个结论
    // 整副面孔（不要改代码 / 出路是合分支或跳过）都压在这份事实上（第 2 轮审查 F1），所以
    // 它只能是起跑那一刻的事实 —— 跑完之后再核拿到的是跑完之后的状态。
    //
    // 一次定死，之后只读不重算。它是**纯读**的（看文件在不在、读一份 manifest 的文本），
    // 不起任何进程：第 7 轮那版把两条 npm 查询插进这一次执行里去问 runner 自己，第 8 轮审查
    // 实测撤掉（答的是查询那一次的状态，还替用户多跑了两次项目代码）。因此它**不够**单独
    // 授权「测试没启动」，只是三件必要条件之一 —— 另两件在 accept-gate-miss.ts。
    await db.update(acceptGateRuns)
      // 配了准备命令就不核：命令起跑那一刻的快照是准备命令装完之后的样子，现在核到的是装之前，
      // 「node_modules/.bin 里没有它」这种事实在那时并不成立，记下来只会变成一条反向的线索。
      .set({ entryProbe: plan.prepare ? null : encodeGateEntryProbe(probeGateEntry(snapshotCwd, plan.command)), previewCommit,
        // 凭据记快照**实际**用的那一份，不是判定那一刻读到的：两者之间项目改了配置，记下的就是测过的。
        ...(plan.baseline.previewBase ? { previewMaterialization: await snapshotMaterialization(snapshotCwd), previewPhysical: physical } : {}) })
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
      prepare: plan.prepare,
      cwd: snapshotCwd,
      logPath,
      hold: true,
      // 先认启动器留下的退出档：它带着用时，过了时限的退出码按超时收（accept-gate-exit.ts）。
      onExit: (exit) => void settleGate(runId, gateExitOutcome(recordedGateExit(logPath) ?? unrecordedGateExit(exit, !!plan.prepare))),
    });
  } catch (error) {
    appendGateLog(logPath, `\n[ash] 起不来：${error instanceof Error ? error.message : String(error)}\n`);
    await stopGateRun(runId);
    await settleGate(runId, { status: "failed", exitCode: null, failure: "spawn_failed" });
    const failed = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
    return failed ? gateView(failed) : null;
  }
  superviseGate(taskId, runId, logPath, started.pid, started.startedAt);
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

/** 登记了却没能发射（主流程中途出错）时把登记撤掉，别留一条永远不跑的意图。 */
export function dropPendingAcceptGate(taskId: string): boolean {
  return pendingStarts.delete(taskId);
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
 * 判据与 acceptGateCheck 的复用判据同源（提交 + 命令 + 门禁基准 + 上次是绿的），两边必须一起改 ——
 * 这边说「不用跑」、那边却登记一条去跑，统一验收就会停在半路。
 */
export async function acceptGateWouldRun(task: TaskRow, project: ProjectRow | null): Promise<boolean> {
  await reconcileGateProcesses(task.id);
  if (task.stage === "merged" || task.stage === "accepted") return false;
  if (hasLiveAcceptGate(task.id)) return true;
  const command = acceptGateCommandOf(project);
  if (!command || !project) return false;
  const prepare = acceptGatePrepareOf(project);
  if (gateConfinementUnavailable()) return false;
  if (await runningRun(task.id)) return true;
  const cwd = await existingTaskWorkspacePath(task, project.repoPath);
  if (!cwd) return true;
  // 这一处的 catch **留着**，而且必须倒向 `false`：`readGateSource` 抛出来的主干就是「源码不可用」
  // （工作区有未提交/未跟踪文件、读不到提交），而那一档的既定语义是**验收在门禁之前就被拒**
  // （`acceptTask` 回 `accept_gate_source_unavailable`，一条运行记录都不建）。倒向 `true` 会让批量
  // 预判说「这一按要跑门禁」，而真按下去压根不会跑 —— `test-accept-gate-readonly.ts` 的
  // source-unavailable 夹具把这两边钉在一起。
  const source = await readGateSource(cwd, gateSnapshotPath(task.id, "identity", !!prepare), !!prepare).catch(() => null);
  if (!source) return false;
  // 基准拦得下的那一按同理倒向 `false`：真按下去会在门禁之前被拒（没含目标分支 / 预演冲突），
  // 一条运行记录都不建。复用判据也要连基准一起比 —— 预览基准过期的旧绿真按下去会重跑。
  const baseline = await resolveGateBaseline(task, project, source.commit, { cwd, dependencies: source.dependencies });
  if (baseline.block) return false;
  const previous = await latestRun(task.id);
  return !(previous && previous.status === "passed"
    && gateSourceMatches(previous, source) && gateBaselineMatches(previous, baseline.plan) && sameGateRecipe(previous, command, prepare));
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
