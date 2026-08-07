import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { AgentType, TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, projects, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt } from "./util.js";
import { setTaskStatus } from "./status.js";
import { trackRun, untrackRun, isRunning, takeStopped, claimTurn, releaseTurn } from "./runs.js";
import { consumeSingleRun, afterSettlement, STRICT_DONE_PROTOCOL } from "./single-run.js";
import { FOLLOW_UP_LABEL } from "./labels.js";
import { taskWorkspace } from "./task-workspace.js";
import { resolveExecutorFor } from "./executors/index.js";
import type { RunHandle } from "./executors/types.js";
import { detachedPathsFor } from "./executors/detached.js";
import { inspectProcess } from "./proc.js";
import { RUNS_DIR } from "./paths.js";
import { writeTurn as writeTurnLine, runTracePaths } from "./transcript.js";
import { startTeam, deliverToLead } from "./team/session.js";
import { workerPreambleFor } from "./team/dispatch.js";
import { reopenAcceptedStage } from "./task-stage.js";
import { reviewProtocolFor, reviewReminderFor, verifyReminderFor } from "./review-prompts.js";
import { peerNoticeFor } from "./peer-context.js";
import { recordTurnBaseline } from "./turn-baseline.js";
import { recordTurnStart } from "./turn-output.js";


// Single tasks run headless — nobody can answer a mid-run prompt. Tell the agent
// to act autonomously rather than stall waiting for confirmation; if it genuinely
// needs input it can still ask, and the user replies via continueTask (resume).
const AUTONOMY =
  "你在一个无人值守的自动化环境中运行，没有人能实时回复你。请尽量自主完成：遇到多个合理方案时，选最稳妥的一个并在结果中说明假设与取舍；不要停下来等待人工确认，除非信息确实不足以继续。\n\n";

// Prefix for an agent invited into an existing task via @-mention. It joins in
// the SAME working directory, so it should read the current state before acting.
const COLLAB_INVITE =
  "你被叫来加入这个任务的协作。当前工作目录里可能已经有其他 agent 的产出，请先了解现状再动手。\n\n";

// 被召唤进来的智能体只收到用户 @ 它的那一句话 —— 任务本身是干什么的，它一无所知
// （task.body 只进 fresh run 的 prompt，而它走的是 continueTask 这条路）。撞上
// 「审一下上面的提交」这种自带上下文的召唤还能靠工作目录补齐，换成依赖任务描述的
// 活就只能靠猜。所以首次入场时把原始描述一并给它，之后的回合不再重复（它自己的
// 会话里已经有了）。
const TASK_BRIEF = (body: string) =>
  `【本任务的原始描述】（你是中途被叫进来的，这是任务最初的交代，供你了解背景）\n${body.trim()}\n\n`;

// When a task that was interrupted (server restart → failed, manual stop →
// canceled, group pause → paused, or a non-zero exit) is (re)started, we RESUME
// its existing CLI session with this nudge instead of re-running from scratch —
// the agent already holds the full prior context via --resume, so no AUTONOMY
// preamble.
const RESUME_PROMPT =
  "继续：你上一次的运行被中断了（可能是服务重启、被手动停止或所在分组被暂停）。请从中断处接着完成这个任务，先简要说明你已做到哪一步、还差什么，然后继续推进直到完成。";
// Backend-initiated continue leaves this trace in the timeline (distinct from a
// user reply), shown identically live (SSE) and on reload (.md).
const SYS_MARKER = "〔系统〕继续（从中断处）";

// A non-text interjection in the run timeline is persisted as one sentinel line
// (see transcript.ts) so live and reloaded views read identically.
function writeTurn(
  out: NodeJS.WritableStream,
  turn: { t: "user" | "system"; agent: AgentType; text: string },
  at = now(),
): void {
  writeTurnLine(out, turn, at);
}

// 完成协议前言(严格 done):告诉 agent 它的 taskId 和「必须亲口确认完成」的
// 规则。fresh run 用长版(第一回合,完整交代);reply/resume 回合用短版追加在
// 消息尾部(每回合都提醒,上下文再长 agent 也不至于忘)。
//
// 宽松模式(HARNESS_LAX_DONE,典型:预览实例)下这三段一律退化成空串 —— 那台 harness
// 的 MCP 对 agent 不可达,交代了它也做不到,理由见 single-run.ts 的 STRICT_DONE_PROTOCOL。
const ACCEPTANCE_REMINDER = (taskId: string, sharedTeamWorker: boolean, verifying: boolean) => verifying
  ? "验收辅路:验证回合不适用 accept_task；这一轮只负责给出验证结论并留证。"
  : sharedTeamWorker
    ? "验收辅路:本共享执行者不适用 accept_task；合并与验收由团队级处理。"
    : `验收辅路:准备交给人工验收前可调用 report_stage(taskId="${taskId}", stage="awaiting_acceptance")；` +
      `只有用户明确表示「验收通过/可以合并」时，调用 accept_task(taskId="${taskId}")，不要自行运行 git merge、worktree remove 或 branch -d。`;
const COMPLETION_PROTOCOL = (taskId: string, sharedTeamWorker: boolean, reviewTask: boolean) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `【完成协议】本任务在 harness 的 taskId 是 ${taskId}。当且仅当你确定任务目标已经达成时,在结束前调用 harness MCP 的 complete_task(taskId="${taskId}")确认完成;未确认就结束,本回合会按未完成记为 failed。跑到需要等待外部条件的检查点时,改用 pause_task 写下续跑指令。\n\n${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask)}\n\n`;
const COMPLETION_REMINDER = (taskId: string, sharedTeamWorker: boolean, reviewTask: boolean) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `\n\n(harness 完成协议:taskId=${taskId}。若本回合结束时任务目标已达成,先调用 complete_task 确认再结束,否则按未完成记 failed;到等待检查点则用 pause_task。${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask)})`;

// 续聊(follow-up)回合的尾巴:任务早就到终态了,这一轮是「完成之后的对话」,
// 不该拿严格完成协议吓唬 agent(不确认就 failed)—— 这一轮不确认,任务状态原样
// 不动。只有它真把任务推进到新的完成时才需要确认。
const FOLLOW_UP_REMINDER = (taskId: string, from: string, sharedTeamWorker: boolean, reviewTask: boolean) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `\n\n(harness:这是任务在「${FOLLOW_UP_LABEL[from] ?? from}」之后的续聊,taskId=${taskId}。任务状态不会因为本回合而改变,本回合不需要 complete_task;只有当你在这一轮把任务推进到了新的完成状态时,才调用 complete_task(taskId="${taskId}")确认。${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask)})`;

// The task's worktree was gone AND its branch with it, so we rebuilt an empty one.
// The CLI conversation lives outside the worktree (~/.claude/projects/<escaped
// cwd>/), so `--resume` hands the agent a full memory of files that no longer
// exist — it would happily "finish the last bit" on top of nothing. Break that
// continuity explicitly: the agent must re-read reality before acting. Shown to
// the user too (its own timeline bubble), since a silently reset workspace is
// exactly the kind of thing you must not discover at review time.
const WORKSPACE_RESET = (path: string) =>
  `\n\n〔重要·工作目录已重建〕本任务原来的 worktree 和分支都已不存在(被删除了),harness 刚在 ${path} 建了一个空的工作目录:` +
  `你在上文里创建或修改过的文件**现在全都不在了**,git 历史也回到了基线。请不要相信上文中「我已经改过某某文件」的记忆——` +
  `动手之前先实际看一遍当前目录(ls / git status / git log),据此重新判断还要做什么。`;
const WORKSPACE_RESET_MARKER = "〔系统〕原工作目录(worktree 与分支)已不存在，已重建为空目录并提醒 agent 重新确认现状";

// Why a task is being (re)started — only used to label the resume; all reasons
// behave the same (resume if there's a resumable session, else fresh). Note: a
// scheduled cron fire is NOT here — it always starts a fresh run via runTask
// (schedules.ts), so it never resumes. `wake` = an upstream task just settled
// done and the settle hook is auto-resuming this paused dependent.
export type ResumeReason = "group" | "run" | "retry" | "wake" | "queue";

async function setStatus(taskId: string, status: Parameters<typeof setTaskStatus>[1]) {
  await setTaskStatus(taskId, status);
}


// On (re)start nothing is actually running, so any task still in an in-flight
// status was interrupted (e.g. the server restarted mid-run). Mark those failed
// so they're recoverable via retry/reply instead of being stuck forever.
// awaiting_review is left alone — its gate can still be resolved after a restart.
// 例外一:团队任务(mode:"team")没有「失败」这回事 —— 调度台进程随 server 一起
// 死了,但 CLI 会话还在,下次有人说话就 --resume 接回。落 idle(待命)。
// 例外二:被打断的是续聊回合(followUpFrom 非空)→ 回到续聊前的终态,别把一个
// 早就完成的任务记成 failed。
// **逐个走 setTaskStatus 单点**(而不是一条 UPDATE 批量改):它维护
// startedAt/endedAt、广播 task.status,并且触发队列推进 —— 否则重启把队列 head
// 打成 failed 之后没有任何人去推,整条串行队列就一直停在那等(实测:重启后
// 后面的任务再也不会自动开始,得手点一次「运行分组」)。
export async function reconcileInterrupted(): Promise<void> {
  // **必须在 reattachRunningTasks 之后调用**（index.ts 保证顺序）。被成功接管的
  // 任务此刻有活的 handle，isRunning 为真 —— 它们绝不能再被当成「被打断」判
  // failed：那会让一个正在干活的 agent 在界面上显示失败，用户一点重试就会有
  // 第二个 agent 进同一个 worktree。
  // 用 isRunning（runs.ts，中立模块）而不是回头 import reattach，依赖保持单向。
  const orphaned = (await db.select().from(tasks).where(inArray(tasks.status, ["running", "queued"])))
    .filter((t) => !isRunning(t.id));
  if (!orphaned.length) return;
  const teamIds = orphaned.filter((t) => t.mode === "team").map((t) => t.id);
  const others = orphaned.filter((t) => t.mode !== "team");
  for (const t of others) {
    const back = (t.followUpFrom as TaskStatus | null) ?? "failed";
    if (t.followUpFrom || t.completeConfirmedAt) {
      await db
        .update(tasks)
        .set({ followUpFrom: null, completeConfirmedAt: null, updatedAt: now() })
        .where(eq(tasks.id, t.id));
    }
    await setTaskStatus(t.id, back);
  }
  for (const teamId of teamIds) await setTaskStatus(teamId, "idle");
  const followUps = others.filter((t) => t.followUpFrom).length;
  console.log(
    `[harness] reconciled ${others.length - followUps} interrupted task(s) → failed` +
      (followUps ? `, ${followUps} follow-up turn(s) → 原终态` : "") +
      (teamIds.length ? `, ${teamIds.length} team task(s) → idle` : ""),
  );
  wakeInterruptedLeads(teamIds);
}

// 被打断在「正在思考/派活」当口的团队调度台，重启后必须主动叫醒一次。
//
// 平时调度台是被执行者事件唤醒的（提问 / 失败 / reportBack 完成，见
// team/inbox.ts）。但如果它被打断时手头那批执行者**已经全部跑完**，就再也没有
// 人会来敲它的门了 —— 它会一直 idle 躺着，只能等用户自己去戳一下。这是重启在
// 团队链路上唯一真正会「卡住」的地方。
//
// 只叫醒 teamIds（重启时正好是 running/queued 的那些，即确实被打断在半途）。
// 本来就 idle 的不动：它没有未竟的一轮，叫它等于白烧一次模型调用。
// startTeam 走的是 deliver → 内存里没有 lead → openLead 的 --resume 接回，
// 调度者会收到「你被中断过」的提示，自己 list_tasks 看现状。
function wakeInterruptedLeads(teamIds: string[]): void {
  if (!teamIds.length) return;
  // 稍等一下再叫：让 server 先把启动流程走完（含上面的接管），调度者一睁眼
  // 看到的执行者状态才是最终的，不会基于半截快照做决策。
  const t = setTimeout(() => {
    for (const teamId of teamIds) {
      void startTeam(teamId).catch((err) =>
        console.error(`[harness] 唤醒被打断的团队调度台 ${teamId} 失败:`, err),
      );
    }
    console.log(`[harness] 已叫醒 ${teamIds.length} 个被打断的团队调度台`);
  }, 3000);
  (t as { unref?: () => void }).unref?.();
}

// M1: execute a single-agent task in the project's working dir, stream output over
// SSE, and persist a session credential (DESIGN.md §1/§4/§12/§13).
export async function runTask(taskId: string): Promise<void> {
  // 团队任务(§Team)走常驻调度台,不占单飞锁 —— 它的「一次运行」是整段常驻,
  // 不是一个回合。放在最前面,于是 /tasks/:id/run、retry、queue 推进都自动生效。
  const mode = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.mode;
  if (mode === "team") return startTeam(taskId);
  if (!claimTurn(taskId)) return;
  let handle: RunHandle | undefined;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("duet mode runs in M4");

    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("project not found");

    // 新回合起点:清掉上一轮可能残留的完成确认/续聊标记(fresh run 从来不是续聊)。
    await db
      .update(tasks)
      .set({ followUpFrom: null, completeConfirmedAt: null, updatedAt: now() })
      .where(eq(tasks.id, taskId));
    await setStatus(taskId, "running");

    // Ordinary tasks resolve exactly as before. Team workers additionally inherit
    // their lead's shared workspace unless they explicitly request another worktree.
    const ws = await taskWorkspace(task, project.repoPath);
    // 这一轮到底留下了什么:只服务「没交卷」时的通知措辞(turn-output.ts)。fresh run
    // 也要记 —— 漏交卷最常发生在这一路,而 turn-baseline 只给真人续聊拍照。
    await recordTurnStart(taskId, ws.path);
    const agentType = (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutorFor({
      executorId: task.executorId,
      type: agentType,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
    });

    const autoTitle = !!task.autoTitle;
    const TITLE_HINT =
      "请在正式开始前，第一行只输出：标题：<不超过14字、概括本次任务的简短标题>，然后换行，再正常完成下面的任务。\n\n任务：\n";
    const objective = task.body?.trim() || task.title;
    // 团队执行者多一段前言(卡住走 ask_question 直达调度者、别自己扩张边界)。
    // 只拼进 prompt,不写进 tasks.body —— body 是调度者给的需求正文,界面展示那份。
    const teamPreamble = await workerPreambleFor(task);
    const sharedTeamWorker = !task.useWorktree && teamPreamble.length > 0;
    const reviewTask = !!task.reviewOf;
    const reviewProtocol = reviewTask ? await reviewProtocolFor(task, ws, project.repoPath) : "";
    // fresh run 通常是任务里的头一个智能体，但不总是：任务跑过 codex 之后用户把
    // agentType 换成 claude 再点运行，就会从这里起跑一条全新会话 —— 前面那位的
    // 对话记录还在盘上，同样该告知。prev 传 undefined（这个智能体自己没跑过），
    // 于是在场的都算新面孔；任务里只有它自己时返回空串，fresh run 一如往常。
    const priorSessions = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const peerNotice = peerNoticeFor({ taskId, self: agentType, all: priorSessions, prev: undefined });
    const prompt =
      AUTONOMY + COMPLETION_PROTOCOL(taskId, sharedTeamWorker, reviewTask) + teamPreamble + reviewProtocol +
      peerNotice +
      (autoTitle ? TITLE_HINT + objective : objective);
    const turnStart = now();
    const sessId = id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    // 解绑重启：输出落盘而不是走匿名管道，于是这个 agent 活得过 server 重启
    // （见 executors/detached.ts）。ssh 目标会在 spawnForRun 里自动退回管道。
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
      target: "local",
      worktreePath: ws.isWorktree ? ws.path : null,
      branch: ws.branch,
      cwd: ws.path,
      cliSessionId,
      resumeCommand: ex.resumeCommand(ws.path, cliSessionId),
      relayEnv: ex.relayEnvHint ?? null,
      commandLine: handle.commandLine,
      startedAt: turnStart,
      turnStartedAt: turnStart,
      activeMs: 0,
      exitStatus: null as number | null,
      // 重启后靠这几个字段找回并接管它。pid 为空 = 这一轮没走 detached
      //（ssh 目标 / 预检失败），那就是老语义：重启即中断。
      agentPid: handle.detached?.pid ?? null,
      agentStartedAt: handle.detached ? inspectProcess(handle.detached.pid)?.startedAt ?? null : null,
      agentOutPath: handle.detached ? detach.out : null,
      agentErrPath: handle.detached ? detach.err : null,
      agentRcPath: handle.detached ? detach.rc : null,
      agentOffset: 0,
    };
    await db.insert(sessions).values(sessRow);

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });
    await consumeSingleRun({
      taskId, sessId, agentType, ex, cwd: ws.path,
      handle, out, turnStart, cliSessionId, autoTitle,
    });
  } catch (err) {
    bus.publish({
      type: "agent.event",
      taskId,
      sessionId: "",
      role: "single",
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    const status = takeStopped(taskId) ?? "failed";
    await setStatus(taskId, status);
    await afterSettlement(taskId, status, false, false);
  } finally {
    if (handle) untrackRun(taskId, handle);
    releaseTurn(taskId);
  }
}



// Decide between a fresh run and a resume when (re)starting a single task. A task
// that was interrupted keeps a session row with a cliSessionId (server restart
// leaves exitStatus null; manual stop / non-zero exit keep the id too) — resume
// THAT session so the agent continues from where it stopped, like the user typing
// 继续. A never-started task (no resumable session) runs fresh. paused 任务带着
// agent 写下的 resumePrompt 进来 —— 把它当作 user 输入回灌给 CLI 会话再清空，所以
// 不会反复触发同一段 prompt。Tail-returns the delegate so callers (esp. the
// scheduler) keep chaining on the same promise.
export async function resumeOrRunTask(
  taskId: string,
  opts: { reason?: ResumeReason } = {},
): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.mode !== "single") return runTask(taskId); // duets/missing → unchanged path
  // 检查点续跑：把 agent 写好的 resumePrompt 当作 user 消息丢回 continueTask，
  // 跑同一会话同一目录；先清空字段避免回合内再次 settle 时又被认成 paused。
  // 调度器会先把可启动任务标成 queued，因此这里不能只看 status === "paused"。
  if (task.resumePrompt) {
    const rp = task.resumePrompt;
    await db.update(tasks).set({ resumePrompt: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    return continueTask(taskId, rp, { system: opts.reason ?? "run" });
  }
  const agent = (task.agentType as AgentType) ?? "claude";
  const prev = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((s) => s.agentType === agent)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  if (prev?.cliSessionId) return continueTask(taskId, RESUME_PROMPT, { system: opts.reason ?? "run" });
  return runTask(taskId); // no resumable session → fresh
}

// Continue a single task. By default this resumes the task's own agent (answer
// an agent that stopped to ask). With opts.agent it targets another agent: if
// that agent already has a session here, resume it; otherwise invite it fresh
// into the SAME working directory (same-dir collaboration). Single-flight by
// taskId keeps invitees from running concurrently with the main agent.
//
// opts.executorId / opts.model / opts.reasoningEffort 是 @ 提及那一步选定的**具体执行器、
// 模型与思考强度**（对话框里那个「智能体 · 模型」框）。只作用于这一回合：任务自己的
// executorId/model/reasoningEffort 是它的常设配置，被 @ 换成别的执行器时不该被这一次召唤改写。
export async function continueTask(
  taskId: string,
  userText: string,
  opts: {
    agent?: AgentType;
    executorId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    attachments?: string[];
    system?: ResumeReason;
    /**
     * 旁路回合：这一轮不是「任务本身在执行」，而是搭着这个任务的工作目录/会话另做一件事
     * （就地验证轮）。语义上跟续聊同一条：**只可能让任务变好，不会让它变差** ——
     * 本回合不确认完成，任务就原样回到进这一轮之前的终态。跟续聊的区别只在于它是后端
     * 发起的（带 system），所以要显式开这个开关，否则会被当成一次普通的系统续跑。
     */
    sideTurn?: boolean;
    /**
     * 这一轮的字是**后端代写**的（验证打回的报告、验收冲突的交接说明），但它必须占一个
     * 真人回合 —— 带 system 会被当成「系统续跑」，followUpFrom 就护不住任务原来的终态。
     * 于是落盘时标一位 by:"system"，让读端（Inspector 的「后续追问」、侧边栏铺开那一列）
     * 能把它跟我自己打的字分开。默认 false = 真人发的。
     */
    byBackend?: boolean;
    throwOnTeamUnavailable?: boolean;
  } = {},
): Promise<void> {
  // 已验收的任务收到真人消息 = 旧验收不再覆盖新增改动,stage 清回「进行中」。
  // 只认真人消息:带 opts.system 的 retry / 手点运行 / 队列推进 / 上游唤醒不算,跟下面
  // followUpFrom 用的是同一条口径。放在最前面,确保 single/team/duet 走同一规则。
  //
  // 摘牌必须**立刻**发生(界面上任务当场从「已验收」挪回进行中),可这时还不知道这一轮
  // 会不会真改东西 —— 纯询问也照摘。所以接住摘掉的是哪块牌子交给基线快照:结算发现
  // 工作目录一个字节没变,就把它原样挂回去(turn-baseline.ts)。team 走下面的 stdin 分支、
  // 不拍照,维持原样(调度台本来就不走验收链)。
  const reopenedStage = opts.system ? null : await reopenAcceptedStage(taskId);
  // 团队任务(§Team):插话直接写进常驻调度台的 stdin —— 即时、同一会话、用户侧
  // 感觉不断线。不占这里的单飞锁(那把锁是给「一次运行 = 一个回合」的单任务用的,
  // 调度台的一次运行是整段常驻)。于是 /reply、/answer、@提及全都自动生效。
  const teamMode = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.mode;
  if (teamMode === "team") {
    return deliverToLead(taskId, userText, {
      attachments: opts.attachments,
      throwOnOpenFailure: opts.throwOnTeamUnavailable,
    });
  }
  if (!claimTurn(taskId)) return;
  const agentType = opts.agent ?? "claude"; // re-derived below once the task loads; kept for the catch handler
  let handle: RunHandle | undefined;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("reply is for single tasks");

    const agent = opts.agent ?? (task.agentType as AgentType) ?? "claude";
    // 对话框里 @ 出来的那一步是**显式选择**（智能体 + 执行器 + 模型 + 思考强度），这一回合
    // 整套按它跑；没 @ 就沿用任务自己的常设配置。三个字段必须同进同出：思考强度的档位表
    // 是跟着 CLI 走的，只要换了智能体，任务自带的强度就属于另一张表，不能漏过来。
    const summoned = !!opts.agent;
    // 续聊(follow-up):任务已经到终态了,用户又发来一条消息 —— 这一轮是「任务
    // 之后的对话」,不是任务的执行。把续聊前的终态记下来:队列一律按它看待这个
    // 成员(既不算「有人在跑」冻住整条线,也不会被当成可启动项拉起来),结算时
    // 再回到它(见 settleTaskStatus 的续聊分支)。
    // 只认真人消息:后端发起的续跑(retry / 手点运行 / 队列推进 / 上游唤醒)带
    // opts.system,那是真的在执行这个任务,照旧占住队列位置。
    // 例外是旁路回合(opts.sideTurn,就地验证):它虽然由后端发起,却同样不是这个
    // 任务的执行 —— 验证没通过不该把一个 done 打成 failed。任务身上还挂着 verify_round
    // 时,这一轮同样算旁路:验证中途提问、答复回来续跑的那一回合仍属于这轮验证,
    // 走的却是普通的 /answer,不带 sideTurn。
    // 旁路回合恢复的是**进这一轮之前的原状态**,不限 done/failed/canceled —— 用户可以
    // 对一个 paused 的任务手点「再验一轮」,验完它该还是 paused。
    // **这一段必须排在所有可能抛错的解析之前**(执行器解析、工作目录解析都会抛:模型与
    // 思考强度不兼容、worktree 建不出来),catch 那边只认库里的 followUpFrom —— 落库晚
    // 一步,一个 done 的任务就会因为「验证没起来」被打成 failed。
    const sideTurn = !!opts.sideTurn || !!task.verifyRound;
    const followUpFrom = sideTurn
      ? (task.status === "running" || task.status === "queued" ? null : task.status)
      : !opts.system && ["done", "failed", "canceled"].includes(task.status)
        ? task.status
        : null;
    // 新回合起点:顺手清掉上一轮残留的完成确认(确认只在本回合内有效)。
    await db
      .update(tasks)
      .set({ followUpFrom, completeConfirmedAt: null, updatedAt: now() })
      .where(eq(tasks.id, taskId));

    const ex = await resolveExecutorFor({
      executorId: summoned ? opts.executorId ?? null : task.executorId,
      type: agent,
      model: summoned ? opts.model ?? null : task.model,
      reasoningEffort: summoned ? opts.reasoningEffort ?? null : task.reasoningEffort,
    });
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);

    // A single task can now host several agents — one session line per agentType,
    // each invited via @-mention. Newest first.
    const all = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const prev = all.find((s) => s.agentType === agent); // this agent's own session, if any
    const resuming = !!prev?.cliSessionId;

    // Where the work lives: the agent's own cwd, else any session's cwd (so the
    // invitee sees prior output), else materialize the task workdir.
    const recorded = prev?.cwd || prev?.worktreePath || all[0]?.cwd || all[0]?.worktreePath || "";
    // A recorded cwd that has since vanished (worktree cleaned up, project moved)
    // used to be handed to spawn as-is — which stuck the task in 'running' forever.
    // Re-resolve through the same path a fresh run takes: it RESTORES the worktree
    // when the branch outlived the directory, and only rebuilds an empty one when
    // the branch is gone too.
    let cwd = recorded;
    let workspaceReset = false;
    let freshWorkspace = false;
    if (!existsSync(cwd)) {
      if (project) {
        const ws = await taskWorkspace(task, project.repoPath);
        cwd = ws.path;
        freshWorkspace = !!ws.fresh;
        // Only a resumed session carries stale memory worth correcting; a fresh
        // session starts empty-handed and needs no warning.
        workspaceReset = freshWorkspace && resuming;
      } else if (!cwd) {
        cwd = ".";
      }
    }

    await setStatus(taskId, "running");
    // 起跑前给工作目录拍一张照，**并当场把上一版的验证/验收记录清掉**：新指令一到，
    // 上一版的成绩就作废，线退回「让 AI 干活」那一站（不然这几十分钟里线路图还写着
    // 「已过关口、停在验证站」，那两颗会真合并的按钮此刻就能点）。结算时再拍一张比对，
    // 这一轮要是一个字节都没改，刚才清掉的原样放回 —— 纯询问不该重置任何东西。
    // 只给真人消息拍 —— 系统续跑、队列推进、验证打回后叫 agent 修，那些轮次改代码是
    // 本分，清账反而打断正在跑的流程。详见 turn-baseline.ts。
    if (!opts.system && !sideTurn) await recordTurnBaseline(taskId, cwd, freshWorkspace, reopenedStage);
    // 「有产出却没交卷」的探针跟上面那张照片是两回事:它只管通知怎么措辞,所以**每一轮都记**
    // (系统续跑、队列推进的回合同样会漏交卷)。详见 turn-output.ts。
    await recordTurnStart(taskId, cwd);

    const invited = !prev; // first time this agent is pulled into the task
    const userTurnText = userText + attachmentsPrompt(opts.attachments);
    const sharedTeamWorker = !task.useWorktree && (await workerPreambleFor(task)).length > 0;
    // 验证回合（旧的独立审查任务，或这个任务自己身上的就地验证轮）：完成协议的
    // 验收那一句要换掉 —— 这一轮的产出是结论和证据，不是「这个任务可以合并了」。
    const reviewTask = !!task.reviewOf;
    const verifying = reviewTask || !!task.verifyRound;
    // 每回合都重贴一遍「你现在在干什么」：验证轮可能中途提问、被打断再续跑，
    // 那些回合都不带最初那段协议，只有从任务状态派生的提醒能跟到底。
    const reviewReminder = reviewTask
      ? reviewReminderFor(task)
      : task.verifyRound
        ? verifyReminderFor(task.id, task.verifyRound)
        : "";
    // 「本任务里还有别人」的告知。触发条件是**有新面孔**（上一轮跑完之后才进来的
    // 同伴），不是 invited —— 挂在 invited 上恰好漏掉最需要它的那个：任务的原生
    // agent 第一轮走 runTask 直接起跑、从没被「召唤」过，于是后来 @ 进来的同伴它
    // 一次都不会知道（正是 2026-08-04 那个「claude 自己考古 codex 会话」的现场）。
    // prev 必须是**更新 session 行之前**的快照：锚点取的 endedAt 会在 resume 时被清空。
    const peerNotice = peerNoticeFor({ taskId, self: agent, all, prev });
    const prompt =
      (invited ? COLLAB_INVITE : "") +
      (invited && task.body.trim() ? TASK_BRIEF(task.body) : "") +
      peerNotice +
      userTurnText +
      (workspaceReset ? WORKSPACE_RESET(cwd) : "") +
      (followUpFrom
        ? FOLLOW_UP_REMINDER(taskId, followUpFrom, sharedTeamWorker, verifying)
        : COMPLETION_REMINDER(taskId, sharedTeamWorker, verifying)) +
      (reviewReminder ? `\n${reviewReminder}` : "");
    const turnStart = now();
    const sessId = resuming ? prev!.id : id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    // 续聊/重试/队列推进/唤醒这一路也要解绑 —— 漏掉它等于只保护「全新起跑」的
    // 回合，而任务被 resume 的次数远多于第一次起跑（实测:重启时在跑的任务里
    // 一半是 resume 回合，全都还挂在匿名管道上）。
    const detach = detachedPathsFor(runDir, sessId, turnStart);
    handle = ex.run({
      prompt,
      cwd,
      sessionId: resuming ? prev!.cliSessionId! : undefined,
      trace: runTracePaths(runDir, sessId, turnStart),
      detach,
    });
    trackRun(taskId, handle);

    // Reuse the agent's session row when resuming; otherwise open a fresh line,
    // inheriting the task's worktree/branch from its first session.
    let cliSessionId = resuming ? prev!.cliSessionId! : handle.sessionId;
    if (resuming) {
      // New turn on the same session row: mark it live (clear the prior turn's
      // end) and stamp this turn's start, so execution-time accounting and the
      // live 用时 both track the turn actually running now. commandLine must also
      // reflect this invocation because task-level model/effort can change between turns.
      await db
        .update(sessions)
        .set({
          turnStartedAt: turnStart,
          endedAt: null,
          commandLine: handle.commandLine,
          executor: ex.label,
          relayEnv: ex.relayEnvHint ?? null,
          // 这一轮的解绑线索。**必须整组刷新**:沿用上一轮的 pid/offset 会让重启
          // 去接一个早就没了的进程,或者从上一轮的字节位置读这一轮的新文件。
          agentPid: handle.detached?.pid ?? null,
          agentStartedAt: handle.detached ? inspectProcess(handle.detached.pid)?.startedAt ?? null : null,
          agentOutPath: handle.detached ? detach.out : null,
          agentErrPath: handle.detached ? detach.err : null,
          agentRcPath: handle.detached ? detach.rc : null,
          agentOffset: 0,
        })
        .where(eq(sessions.id, sessId));
    } else {
      const base = all[0];
      await db.insert(sessions).values({
        id: sessId,
        taskId,
        role: "single",
        agentType: agent,
        executor: ex.label,
        target: "local",
        worktreePath: base?.worktreePath ?? null,
        branch: base?.branch ?? null,
        cwd,
        cliSessionId,
        resumeCommand: ex.resumeCommand(cwd, cliSessionId),
        relayEnv: ex.relayEnvHint ?? null,
        commandLine: handle.commandLine,
        startedAt: turnStart,
        turnStartedAt: turnStart,
        activeMs: 0,
        exitStatus: null,
        agentPid: handle.detached?.pid ?? null,
        agentStartedAt: handle.detached ? inspectProcess(handle.detached.pid)?.startedAt ?? null : null,
        agentOutPath: handle.detached ? detach.out : null,
        agentErrPath: handle.detached ? detach.err : null,
        agentRcPath: handle.detached ? detach.rc : null,
        agentOffset: 0,
      });
    }

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });
    if (opts.system) {
      // Backend-initiated 继续: a 〔系统〕 trace (its own bubble), NOT a 你→ reply.
      // Persist as a structured turn (reload) and emit a matching system event (live).
      writeTurn(out, { t: "system", agent, text: SYS_MARKER }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event: { kind: "system", text: SYS_MARKER } });
    } else {
      // 你→@agent reply, persisted as a structured turn so a reloaded thread shows
      // the human turn as its own bubble (live, the client already shows it).
      writeTurn(out, { t: "user", agent, text: userTurnText, ...(opts.byBackend ? { by: "system" as const } : {}) }, turnStart);
    }
    if (workspaceReset) {
      // 让用户也看见:agent 这一轮是在一个空目录上重新开始的。只发 toast 不算数,
      // 刷新后仍要能看出来(见 AGENTS.md 关于持久可见状态的约定)。
      writeTurn(out, { t: "system", agent, text: WORKSPACE_RESET_MARKER }, turnStart);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event: { kind: "system", text: WORKSPACE_RESET_MARKER } });
    }

    // 跟 fresh run 共用同一份消费+结算(autoTitle=false:标题在第一轮就定了)。
    // 原来这里是一份几乎一样的内联拷贝,两份会漂 —— 而且那份没有 offset 持久化,
    // 于是 resume 回合被重启接管时会从字节 0 重放整轮输出。
    await consumeSingleRun({
      taskId, sessId, agentType: agent, ex, cwd,
      handle, out, turnStart, cliSessionId, autoTitle: false,
    });
  } catch (err) {
    bus.publish({
      type: "agent.event", taskId, sessionId: "", role: "single", agentType,
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    // 续聊回合里出的岔子(典型:worktree 建不出来)不该把任务状态打差 —— 同
    // settleTaskStatus 的约定:续聊只能让任务变好,不能让它变坏。
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const back = row?.followUpFrom as TaskStatus | null | undefined;
    if (back) await db.update(tasks).set({ followUpFrom: null, updatedAt: now() }).where(eq(tasks.id, taskId));
    const status = takeStopped(taskId) ?? back ?? "failed";
    await setStatus(taskId, status);
    await afterSettlement(taskId, status, false, false);
  } finally {
    if (handle) untrackRun(taskId, handle);
    releaseTurn(taskId);
  }
}
