import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { db } from "./db/index.js";
import { tasks, projects, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now } from "./util.js";
import { setTaskStatus } from "./status.js";
import { trackRun, untrackRun, takeSteered, takeStopped, claimTurn, reclaimTurn, releaseTurn } from "./runs.js";
import { consumeSingleRun, afterSettlement } from "./single-run.js";
import { taskWorkspace } from "./task-workspace.js";
import type { Workspace } from "./git.js";
import { resolveExecutorWithProfile } from "./executors/index.js";
import type { RunHandle } from "./executors/types.js";
import { detachedPathsFor } from "./executors/detached.js";
import { inspectProcess } from "./proc.js";
import { RUNS_DIR } from "./paths.js";
import { writeTurn, runTracePaths } from "./transcript.js";
import { startTeam } from "./team/session.js";
import { workerPreambleFor } from "./team/dispatch.js";
import { reopenAcceptedStage } from "./task-stage.js";
import { reviewProtocolFor } from "./review-prompts.js";
import { peerNoticeFor } from "./peer-context.js";
import { recordTurnStart } from "./turn-output.js";
import { abortIfFrozen } from "./turn-freeze.js";
import { withSkillInvocation } from "./skills.js";
import { initialTaskObjective } from "./invited-task-brief.js";
import { withGlobalBrowserPolicy } from "./browser-verification-policy.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { reportTurnFailure } from "./turn-failure.js";
import { AUTONOMY, COMPLETION_PROTOCOL } from "./run-prompts.js";
import { announceBaseFallback, baseFallbackNote } from "./base-fallback-notice.js";

// 单任务的 **fresh run**:从任务描述起一条全新会话。续聊/召唤那一路(resume 已有会话、
// 把用户原话送进去)在 orchestrator.ts 的 continueTask —— 两条路的前置条件、prompt 拼法
// 和失败交代都不一样,分开住;共用的措辞在 run-prompts.ts,共用的判据各自成文件。

// M1: execute a single-agent task in the project's working dir, stream output over
// SSE, and persist a session credential.
export async function runTask(taskId: string, opts: { turnHeld?: boolean } = {}): Promise<void> {
  // 团队任务(§Team)走常驻调度台,不占单飞锁 —— 它的「一次运行」是整段常驻,
  // 不是一个回合。放在最前面,于是 /tasks/:id/run、retry、queue 推进都自动生效。
  const head = (await db
    .select({ mode: tasks.mode, handoff: tasks.handoff })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  const mode = head?.mode;
  // 验收互斥排在 team 分支**之前**:调度台同样会往工作目录里写(共享执行者跑在同一个
  // cwd),验收正在合并/删 worktree 时把它拉起来,跟单飞撞上是同一类破坏。早先这道检查
  // 排在 team 分支之后,team 完全绕过(审查实测:验收锁下仍真的 startTeam)。
  if (isAcceptingTask(taskId)) {
    if (opts.turnHeld) releaseTurn(taskId);
    return; // 验收(含尾段)进行中,不与合并/清理抢工作区
  }
  if (mode === "team") {
    if (opts.turnHeld) releaseTurn(taskId);
    return startTeam(taskId);
  }
  // 接力出去的任务在本机只是历史存档 —— 路由层各有 409,但队列推进/定时班次/重试
  // 等程序化路径全都汇到这里,必须在 spawn 之前收口,否则就是双机并跑。
  if (handoffBlockReason(head?.handoff)) {
    if (opts.turnHeld) releaseTurn(taskId);
    return;
  }
  // turnHeld:入口已原子占位(见 continueTask 同名选项),接管而不是再抢。
  if (opts.turnHeld) reclaimTurn(taskId, "single");
  else if (!claimTurn(taskId)) return;
  let handle: RunHandle | undefined;
  // 解析工作目录那一刻就可能把登记的基线**落库换掉**了(persistBaseFallback)，而说明写在
  // 下面 spawn 成功之后 —— 所以这两件事得挂在 try 外面，失败那条路才补得上同一句话
  //（见 base-fallback-notice.ts）。
  let baseFallback: Workspace["baseFallback"];
  let baseFallbackTold = false;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("duet mode runs in M4");

    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("project not found");

    // 新回合起点:清掉上一轮可能残留的完成确认/续聊标记(fresh run 从来不是续聊,
    // 也从来不是 CLI 原生命令 —— 上一轮崩在半路留下的标记必须在这里归零)。
    await db
      .update(tasks)
      .set({ followUpFrom: null, nativeTurn: false, completeConfirmedAt: null, updatedAt: now() })
      .where(eq(tasks.id, taskId));
    await setTaskStatus(taskId, "running");
    // 已验收任务被 fresh 重跑（Cron 到点 / fire）：旧「已验收」牌子当场摘掉——新一版
    // 产出不能躲在旧牌子下继续改（enterHumanGate 见 merged 会静默放行；审查实测：
    // fire 后任务 failed 而 stage 仍 accepted）。fresh 重跑是「再做一版」的明确意图，
    // 没有「纯询问挂回」一说，启动即摘；后续启动失败牌子也不放回——方向是保守的
    // 「要求重新验收」，不是丢数据（合并事实在 git 历史与时间线里都有）。
    await reopenAcceptedStage(taskId);

    // Ordinary tasks resolve exactly as before. Team workers additionally inherit
    // their lead's shared workspace unless they explicitly request another worktree.
    const ws = await taskWorkspace(task, project.repoPath);
    baseFallback = ws.baseFallback;
    // 这一轮到底留下了什么:只服务「没交卷」时的通知措辞(turn-output.ts)。fresh run
    // 也要记 —— 漏交卷最常发生在这一路,而 turn-baseline 只给真人续聊拍照。
    await recordTurnStart(taskId, ws.path);
    const agentType = (task.agentType as AgentType) ?? "claude";
    const { executor: ex, profileId, profileFingerprint } = await resolveExecutorWithProfile({
      executorId: task.executorId,
      type: agentType,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
    });

    const autoTitle = !!task.autoTitle;
    const TITLE_HINT =
      "请在正式开始前，第一行只输出：标题：<不超过14字、概括本次任务的简短标题>，然后换行，再正常完成下面的任务。\n\n任务：\n";
    const reviewTask = !!task.reviewOf;
    const objective = withSkillInvocation({ agentType, cwd: ws.path, text: initialTaskObjective(task.body, task.title, reviewTask) });
    // 团队执行者多一段前言(卡住走 ask_question 直达调度者、别自己扩张边界)。
    // 只拼进 prompt,不写进 tasks.body —— body 是调度者给的需求正文,界面展示那份。
    const teamPreamble = await workerPreambleFor(task);
    const sharedTeamWorker = !task.useWorktree && teamPreamble.length > 0;
    const reviewProtocol = reviewTask ? await reviewProtocolFor(task, ws, project.repoPath) : "";
    // fresh run 通常是任务里的头一个智能体，但不总是：任务跑过 codex 之后用户把
    // agentType 换成 claude 再点运行，就会从这里起跑一条全新会话 —— 前面那位的
    // 对话记录还在盘上，同样该告知。prev 传 undefined（这个智能体自己没跑过），
    // 于是在场的都算新面孔；任务里只有它自己时返回空串，fresh run 一如往常。
    const priorSessions = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const peerNotice = peerNoticeFor({ taskId, self: agentType, all: priorSessions, prev: undefined });
    const prompt = withGlobalBrowserPolicy(
      AUTONOMY + COMPLETION_PROTOCOL(taskId, sharedTeamWorker, reviewTask, task.workflowMode === "free") + teamPreamble + reviewProtocol +
      peerNotice +
      (autoTitle ? TITLE_HINT + objective : objective),
      "full",
    );
    // 起跑前的最后一道闸（说明见 turn-freeze.ts）：这一句之后到 spawn 之间没有 await，
    // 所以「已 claim、还没 spawn」的窗口里收到的暂停请求一定在这里被消费。fresh run 的
    // 冻结事实由调度侧（scheduler/queue）负责，这里只消费内存标记。
    await abortIfFrozen(taskId);
    const turnStart = now();
    const sessId = id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    // 解绑重启：输出落盘而不是走匿名管道，于是这个 agent 活得过 server 重启
    // （见 executors/detached.ts）。
    const detach = detachedPathsFor(runDir, sessId, turnStart);
    handle = ex.run({ prompt, cwd: ws.path, trace: runTracePaths(runDir, sessId, turnStart), detach });
    trackRun(taskId, handle);

    let cliSessionId = handle.sessionId;
    const sessRow = {
      id: sessId,
      taskId,
      role: "single",
      agentType,
      executor: ex.label,
      // 这一轮真正跑在哪条 profile、哪个模型/思考强度上（见 db/schema.ts 的同名列）：
      // 「原样再跑一遍上一回合」只认它们，不认可改名的展示名，也不认任务此刻的配置。
      executorId: profileId,
      turnModel: ex.model ?? null,
      turnReasoningEffort: ex.reasoningEffort ?? null,
      // 那一刻这套执行环境的指纹：重跑前用它认出「profile 后来被改过/删了」。
      executorFingerprint: profileFingerprint,
      // fresh run 从来不是旁路回合，也不可能带着上一轮的停止事实。
      sideTurn: false,
      stoppedAs: null as string | null,
      worktreePath: ws.isWorktree ? ws.path : null,
      branch: ws.branch,
      cwd: ws.path,
      cliSessionId,
      ...ex.resumeFields(ws.path, cliSessionId),
      commandLine: handle.commandLine,
      startedAt: turnStart,
      turnStartedAt: turnStart,
      activeMs: 0,
      exitStatus: null as number | null,
      // 重启后靠这几个字段找回并接管它。pid 为空 = 这一轮没走 detached
      //（预检失败），那就是老语义：重启即中断。
      agentPid: handle.detached?.pid ?? null,
      agentStartedAt: handle.detached ? inspectProcess(handle.detached.pid)?.startedAt ?? null : null,
      agentOutPath: handle.detached ? detach.out : null,
      agentErrPath: handle.detached ? detach.err : null,
      agentRcPath: handle.detached ? detach.rc : null,
      agentOffset: 0,
    };
    await db.insert(sessions).values(sessRow);

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });
    const baseNote = baseFallbackNote(ws.baseFallback);
    if (baseNote) {
      // fresh run 也会撞上「登记的 base 已经没了」（任务验收合并后分支被删，用户又点了
      // 一次运行）。这一档不像续聊那样起不来，但基线被换掉、甚至跟着改了任务登记值，
      // 只在日志里发生就等于没发生 —— 同样落一条持久可见的气泡。说不说由
      // baseFallbackNote 判（见 base-fallback-notice.ts），跟失败那条路共用一套。
      writeTurn(out, { t: "system", agent: agentType, text: baseNote }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event: { kind: "system", text: baseNote, at: turnStart } });
      baseFallbackTold = true;
    }
    await consumeSingleRun({
      taskId, sessId, agentType, ex, cwd: ws.path,
      handle, out, turnStart, cliSessionId, autoTitle,
    });
  } catch (err) {
    // handle 已登记后收到「引导方向」时，kill 可能恰好让 parser 抛而不是正常收流。
    // 它仍是受控交接：旧回合不落 failed，releaseTurn 后由已登记的回调续送新方向。
    if (takeSteered(taskId)) return;
    const message = String(err instanceof Error ? err.message : err);
    // 基线的事先说：它在这一轮更早的时候就**已经落库**了，说在失败交代之前才对得上
    // 发生顺序。没说过才补（spawn 成功后崩的那种，上面已经写过一条）。
    if (!baseFallbackTold) await announceBaseFallback(taskId, baseFallback, { role: "single" });
    await reportTurnFailure({ taskId, message, role: "single" });
    const status = takeStopped(taskId) ?? "failed";
    await setTaskStatus(taskId, status);
    await afterSettlement(taskId, status, false, false);
  } finally {
    if (handle) untrackRun(taskId, handle);
    releaseTurn(taskId);
  }
}
