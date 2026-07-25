import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, projects, sessions, groups, scheduledMessages } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt } from "./util.js";
import { setTaskStatus } from "./status.js";
import { trackRun, untrackRun, takeStopped, takeConfirmed, type StopSettle } from "./runs.js";
import { resolveWorkspace, ensureWorkdir, prepareWorktree } from "./git.js";
import { resolveExecutor } from "./executors/index.js";
import type { RunHandle } from "./executors/types.js";
import { RUNS_DIR } from "./paths.js";

const running = new Set<string>(); // taskIds currently executing (single-flight)

// Single tasks run headless — nobody can answer a mid-run prompt. Tell the agent
// to act autonomously rather than stall waiting for confirmation; if it genuinely
// needs input it can still ask, and the user replies via continueTask (resume).
const AUTONOMY =
  "你在一个无人值守的自动化环境中运行，没有人能实时回复你。请尽量自主完成：遇到多个合理方案时，选最稳妥的一个并在结果中说明假设与取舍；不要停下来等待人工确认，除非信息确实不足以继续。\n\n";

// Prefix for an agent invited into an existing task via @-mention. It joins in
// the SAME working directory, so it should read the current state before acting.
const COLLAB_INVITE =
  "你被叫来加入这个任务的协作。当前工作目录里可能已经有其他 agent 的产出，请先了解现状再动手。\n\n";

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

// A non-text interjection in the run timeline — a 你→@agent reply or a 〔系统〕
// continue — is persisted as ONE sentinel line: RS (\x1e, which never occurs in
// agent text) + JSON. JSON keeps it to a single physical line even when the text
// has newlines, so the reload parser can lift it back into its own bubble (with
// the timestamp it carries) instead of letting it bleed into the surrounding
// agent Markdown. Live, the same turn rides its own channel (a user reply shows
// optimistically client-side; a system trace via a `system` event), so both
// surfaces read identically.
const TURN_SENTINEL = "\x1e";
function writeTurn(out: NodeJS.WritableStream, turn: { t: "user" | "system"; agent: AgentType; text: string }): void {
  out.write(`\n${TURN_SENTINEL}${JSON.stringify({ ...turn, at: now() })}\n`);
}

// Fence where an agent turn ACTUALLY finished (real exec end), so per-turn 用时 in
// the conversation brackets [你→ reply → agent done] instead of [reply → your NEXT
// reply] — i.e. it excludes the idle wait while the agent sat waiting for you.
// Distinct from writeTurn (which fences human/system interjections, not exec ends).
function writeTurnEnd(out: NodeJS.WritableStream, at: string): void {
  out.write(`\n${TURN_SENTINEL}${JSON.stringify({ t: "agentEnd", at })}\n`);
}

function writeRunError(out: NodeJS.WritableStream, message: string): void {
  const quoted = message.trim().split("\n").map((line) => `> ${line}`).join("\n");
  out.write(`\n> **执行诊断**\n${quoted}\n`);
}

function runTracePaths(runDir: string, sessionId: string, turnStart: string) {
  const turn = turnStart.replace(/[^0-9A-Za-z]/g, "");
  const base = join(runDir, `${sessionId}-${turn}`);
  return {
    eventsPath: `${base}.codex-events.jsonl`,
    stderrPath: `${base}.stderr.log`,
    diagnosticsPath: `${base}.diagnostics.json`,
  };
}

// 完成协议前言(严格 done):告诉 agent 它的 taskId 和「必须亲口确认完成」的
// 规则。fresh run 用长版(第一回合,完整交代);reply/resume 回合用短版追加在
// 消息尾部(每回合都提醒,上下文再长 agent 也不至于忘)。
const COMPLETION_PROTOCOL = (taskId: string) =>
  `【完成协议】本任务在 harness 的 taskId 是 ${taskId}。当且仅当你确定任务目标已经达成时,在结束前调用 harness MCP 的 complete_task(taskId="${taskId}")确认完成;未确认就结束,本回合会按未完成记为 failed。跑到需要等待外部条件的检查点时,改用 pause_task 写下续跑指令。\n\n`;
const COMPLETION_REMINDER = (taskId: string) =>
  `\n\n(harness 完成协议:taskId=${taskId}。若本回合结束时任务目标已达成,先调用 complete_task 确认再结束,否则按未完成记 failed;到等待检查点则用 pause_task。)`;

// ── 编排组(Coordination)────────────────────────────────────────────────────
// 组可以指定一个「协调者」任务(groups.coordinator_task_id)。此后:
//   • 组内 worker 结算为 done / failed 时,自动给协调者投递一条唤醒消息;
//   • worker 调 ask_question 提问后,结算落 paused(队列不推进、不自动续跑,
//     见 scheduler.pickNextLaunchable),问题同样投递给协调者;
//   • 协调者用 answer_question 答复 → 清空问题并带着答复 resume worker 会话。
// 投递复用 scheduledMessages(sendAt=now):调度器只在目标空闲时发送,天然
// 避开「协调者正在跑,continueTask 单飞锁静默丢消息」的竞态;协调者忙碌时
// 消息排队等下一个 tick。
const COORD_PREAMBLE = (taskId: string) =>
  `【编排组协调者】你是所在分组的协调者:组内 worker 任务结束(done/failed)或提问时,harness 会把通知作为新消息自动唤醒你。收到提问 → 先调查(get_task 看它的任务、读仓库现状),再调用 answer_question(taskId=提问任务的 id)答复,答复会自动唤醒对方续跑;拿不准就 pause_task 把问题留给用户。收到结束通知 → 核查产物,决定验收/派修复任务/收尾。每个回合把手头的事处理完后,调用 complete_task(taskId="${taskId}")再结束回合。\n\n`;
const WORKER_PREAMBLE = (taskId: string) =>
  `【编排组成员】本组配有协调者。遇到不拍板就无法继续的问题(这正是上面「信息确实不足以继续」的正规通道),调用 harness MCP 的 ask_question(taskId="${taskId}", question=...),然后正常结束回合——问题会自动送达协调者,答复会作为新消息唤醒你接着干;不要为等答复空转,也不要用 pause_task 来提问。\n\n`;

// 本任务在编排关系里的前言(没有编排关系 → 空串)。fresh run 时拼进 prompt。
async function coordinationPreamble(task: { id: string; groupId: string | null }): Promise<string> {
  if (!task.groupId) return "";
  const g = (await db.select().from(groups).where(eq(groups.id, task.groupId))).at(0);
  if (!g?.coordinatorTaskId) return "";
  return g.coordinatorTaskId === task.id ? COORD_PREAMBLE(task.id) : WORKER_PREAMBLE(task.id);
}

// 给协调者投递一条唤醒消息(fire-and-forget;协调者缺席/已归档则静默跳过)。
async function notifyCoordinator(
  task: { id: string; title: string; groupId: string | null },
  kind: "done" | "failed" | "failed_unconfirmed" | "question",
  question?: string,
): Promise<void> {
  if (!task.groupId) return;
  const g = (await db.select().from(groups).where(eq(groups.id, task.groupId))).at(0);
  const coordId = g?.coordinatorTaskId;
  if (!coordId || coordId === task.id) return; // 非编排组 / 协调者自己结算不通知
  const coord = (await db.select().from(tasks).where(eq(tasks.id, coordId))).at(0);
  if (!coord || coord.archived) return;
  const text =
    kind === "question"
      ? `【worker 提问】任务「${task.title}」(taskId=${task.id})已暂停等待答复,问题:\n${question}\n\n请先调查(get_task 查它的任务详情、按需读仓库现状),再调用 answer_question(taskId="${task.id}", answer=...)答复——答复会自动唤醒它续跑。拿不准就 pause_task 把问题留给用户。`
      : `【worker 结束】任务「${task.title}」(taskId=${task.id})本回合以 ${kind === "done" ? "done" : "failed"} 结束${kind === "failed_unconfirmed" ? "(回合正常退出但未调 complete_task——按严格协议记 failed,可能实际已完成)" : ""}。请核查其产物与状态:确实完成 → patch_task 修正;未完成 → 安排修复或重试;再决定组内下一步。`;
  await db.insert(scheduledMessages).values({
    id: id(),
    taskId: coordId,
    text,
    attachments: "[]",
    agent: null,
    sendAt: now(),
    status: "pending",
    createdAt: now(),
  });
}

// Why a task is being (re)started — only used to label the resume; all reasons
// behave the same (resume if there's a resumable session, else fresh). Note: a
// scheduled cron fire is NOT here — it always starts a fresh run via runTask
// (schedules.ts), so it never resumes. `wake` = an upstream task just settled
// done and the settle hook is auto-resuming this paused dependent.
export type ResumeReason = "group" | "run" | "retry" | "wake" | "queue";

async function setStatus(taskId: string, status: Parameters<typeof setTaskStatus>[1]) {
  await setTaskStatus(taskId, status);
}

// 任务跑完一回合时的状态落位：手停 → canceled；分组暂停停 → paused（恢复分组时
// 队列 head 还是它，从原 CLI 会话续跑，而不是被当 canceled 跳过去启动下一个）；
// agent 在本回合内调过 ask_question（留下 question） → paused 且队列挂起等答复；
// 调过 pause_task（写下 resumePrompt） → paused，等依赖满足或用户手动 resume；
// 退出码非 0 → failed。exit 0 走严格 done
// 协议：agent 必须在回合内调过 complete_task 确认
// 「目标真的达成了」才落 done —— exit 0 只证明 CLI 进程正常退出,agent 报错后
// 退出照样 exit 0,假 done 会误推进队列、错误唤醒下游。未确认 → failed(重试
// 会 resume 续跑,代价低)。逃生口:HARNESS_LAX_DONE=1 退回「exit 0 即 done」
// (接没配 harness MCP 的 agent 时用)。一处算清楚,run / continue 共用。
// 队列推进：done / canceled / failed / paused 进 setTaskStatus 后会触发同 queue 推进。
// 返回落位状态 + note(未确认降级的说明,调用方写进时间线让用户知道为什么)。
const STRICT_DONE = !process.env.HARNESS_LAX_DONE;
const UNCONFIRMED_NOTE =
  "回合正常结束,但本回合内没有收到 complete_task 的完成确认 —— 按严格完成协议记为 failed。可能是 agent 没调用;也可能它调了但被拒(409,如任务状态在运行中被外部改动)。若任务其实已完成,可手动把状态改成已完成;重试则会从中断处续跑。";
const GROUP_PAUSED_NOTE =
  "分组被暂停,本回合被中止 —— 任务落为已暂停;点「运行/继续」恢复分组时会从当前会话接着跑。";
async function settleTaskStatus(
  taskId: string,
  exitStatus: number,
  stopped: StopSettle | null,
): Promise<{ status: "canceled" | "paused" | "done" | "failed"; note?: string }> {
  const confirmed = takeConfirmed(taskId); // 无条件消费,别让标记漏到下一回合
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const notify = (kind: Parameters<typeof notifyCoordinator>[1], q?: string) => {
    if (!t) return;
    void notifyCoordinator({ id: t.id, title: t.title, groupId: t.groupId }, kind, q).catch((err) =>
      console.error(`[harness] notifyCoordinator(${taskId}) failed:`, err),
    );
  };
  if (stopped === "canceled") {
    await setStatus(taskId, "canceled");
    return { status: "canceled" };
  }
  if (stopped === "paused") {
    // 组暂停打断:落 paused 占住队列位置(组是 paused 的,推进钩子不会动)。
    // 恢复分组 → advanceQueue 选中它 → resumeOrRunTask 无 resumePrompt 走
    // RESUME_PROMPT 续原会话。若它被杀前调过 ask_question,question 仍在,
    // pickNextLaunchable 会继续挡住等答复——提问通知照发(scheduledMessages
    // 排队,协调者空闲时送达),不因组暂停而丢。
    await setStatus(taskId, "paused");
    if (t?.question) {
      notify("question", t.question);
      return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」` };
    }
    return { status: "paused", note: GROUP_PAUSED_NOTE };
  }
  // 提问优先于检查点:question 非空 → paused,但队列不推进、不自动续跑
  // (pickNextLaunchable 会挡住),等 answer_question 带答复唤醒。
  if (t?.question) {
    await setStatus(taskId, "paused");
    notify("question", t.question);
    return { status: "paused", note: `本回合以提问暂停,等待答复:「${t.question}」` };
  }
  if (t?.resumePrompt) {
    await setStatus(taskId, "paused");
    return { status: "paused" };
  }
  if (exitStatus !== 0) {
    await setStatus(taskId, "failed");
    notify("failed");
    return { status: "failed" };
  }
  if (confirmed || !STRICT_DONE) {
    await setStatus(taskId, "done");
    notify("done");
    return { status: "done" };
  }
  await setStatus(taskId, "failed");
  notify("failed_unconfirmed");
  return { status: "failed", note: UNCONFIRMED_NOTE };
}

// On (re)start nothing is actually running, so any task still in an in-flight
// status was interrupted (e.g. the server restarted mid-run). Mark those failed
// so they're recoverable via retry/reply instead of being stuck forever.
// awaiting_review is left alone — its gate can still be resolved after a restart.
export async function reconcileInterrupted(): Promise<void> {
  const orphaned = await db.select().from(tasks).where(inArray(tasks.status, ["running", "queued"]));
  if (!orphaned.length) return;
  await db
    .update(tasks)
    .set({ status: "failed", updatedAt: now(), endedAt: now() })
    .where(inArray(tasks.status, ["running", "queued"]));
  console.log(`[harness] reconciled ${orphaned.length} interrupted task(s) → failed`);
}

// M1: execute a single-agent task in the project's working dir, stream output over
// SSE, and persist a session credential (DESIGN.md §1/§4/§12/§13).
export async function runTask(taskId: string): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  let handle: RunHandle | undefined;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("debate mode runs in M4");

    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("project not found");

    await setStatus(taskId, "running");

    // Per-task worktree opt-in (§4): when the user ticked "worktree" in the new-
    // task form, materialize (or reuse) <repo>/.worktrees/<id> on harness/<id8>
    // before handing the cwd to the agent. Failure surfaces as the task failing,
    // not a silent fallback to repoPath — the user explicitly asked for isolation.
    const ws = task.useWorktree
      ? await prepareWorktree(project.repoPath, taskId, task.worktreeBase)
      : await resolveWorkspace(project.repoPath, taskId);
    const agentType = (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutor(agentType);

    const autoTitle = !!task.autoTitle;
    const TITLE_HINT =
      "请在正式开始前，第一行只输出：标题：<不超过14字、概括本次任务的简短标题>，然后换行，再正常完成下面的任务。\n\n任务：\n";
    const objective = task.body?.trim() || task.title;
    const coordination = await coordinationPreamble({ id: taskId, groupId: task.groupId });
    const prompt = AUTONOMY + COMPLETION_PROTOCOL(taskId) + coordination + (autoTitle ? TITLE_HINT + objective : objective);
    const turnStart = now();
    const sessId = id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    handle = ex.run({ prompt, cwd: ws.path, trace: runTracePaths(runDir, sessId, turnStart) });
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
    };
    await db.insert(sessions).values(sessRow);

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });

    let exitStatus = 0;
    let titleDone = !autoTitle; // when autoTitle, swallow text until the title line is parsed
    let head = "";
    const emitText = (text: string) => {
      if (!text) return;
      out.write(text);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event: { kind: "text", text } });
    };

    for await (const event of handle.events) {
      if (event.kind === "session") {
        if (event.cliSessionId !== cliSessionId) {
          cliSessionId = event.cliSessionId;
          await db
            .update(sessions)
            .set({ cliSessionId, resumeCommand: ex.resumeCommand(ws.path, cliSessionId) })
            .where(eq(sessions.id, sessId));
        }
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
        continue;
      }
      if (event.kind === "text" && !titleDone) {
        head += event.text;
        const nl = head.indexOf("\n");
        if (nl < 0) continue; // still buffering the first line
        const firstLine = head.slice(0, nl);
        const rest = head.slice(nl + 1);
        const m = firstLine.match(/标题[:：]\s*(.+)/);
        if (m) {
          const newTitle = m[1].trim().replace(/[`*"]/g, "").slice(0, 30);
          if (newTitle) {
            await db.update(tasks).set({ title: newTitle, autoTitle: false, updatedAt: now() }).where(eq(tasks.id, taskId));
            bus.publish({ type: "task.title", taskId, title: newTitle });
          }
        }
        titleDone = true;
        emitText(m ? rest : head); // matched: drop the title line; else flush buffer
        continue;
      }
      if (event.kind === "text" || event.kind === "thinking") {
        out.write(event.text);
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
      } else {
        if (event.kind === "error") writeRunError(out, event.message);
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
        if (event.kind === "done") exitStatus = event.exitStatus;
      }
    }
    if (!titleDone && head) emitText(head); // agent never produced a newline

    // A stop kills the subprocess → the stream ends like a normal exit; settle
    // by the stop kind (manual → canceled, group pause → paused) so it can be
    // re-run / continued.
    const stopped = takeStopped(taskId);
    const endIso = now();
    await db
      .update(sessions)
      .set({ exitStatus, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(turnStart))}` })
      .where(eq(sessions.id, sessId));
    const settled = await settleTaskStatus(taskId, exitStatus, stopped);
    if (settled.note) {
      // 未确认降级为 failed:写进 .md(reload 可见)+ 广播(live 可见)
      out.write(`\n> ${settled.note}\n`);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event: { kind: "error", message: settled.note } });
    }
    writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
    out.end();
  } catch (err) {
    bus.publish({
      type: "agent.event",
      taskId,
      sessionId: "",
      role: "single",
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, takeStopped(taskId) ?? "failed");
  } finally {
    if (handle) untrackRun(taskId, handle);
    running.delete(taskId);
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
  if (!task || task.mode !== "single") return runTask(taskId); // debates/missing → unchanged path
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
export async function continueTask(
  taskId: string,
  userText: string,
  opts: { agent?: AgentType; attachments?: string[]; system?: ResumeReason } = {},
): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  const agentType = opts.agent ?? "claude"; // re-derived below once the task loads; kept for the catch handler
  let handle: RunHandle | undefined;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("reply is for single tasks");

    const agent = opts.agent ?? (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutor(agent);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);

    // A single task can now host several agents — one session line per agentType,
    // each invited via @-mention. Newest first.
    const all = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const prev = all.find((s) => s.agentType === agent); // this agent's own session, if any
    const resuming = !!prev?.cliSessionId;
    // Where the work lives: the agent's own cwd, else any session's cwd (so the
    // invitee sees prior output), else materialize the task workdir.
    const cwd =
      prev?.cwd || prev?.worktreePath ||
      all[0]?.cwd || all[0]?.worktreePath ||
      (project ? ensureWorkdir(project.repoPath, taskId) : ".");

    await setStatus(taskId, "running");

    const invited = !prev; // first time this agent is pulled into the task
    const prompt = (invited ? COLLAB_INVITE : "") + userText + attachmentsPrompt(opts.attachments) + COMPLETION_REMINDER(taskId);
    const turnStart = now();
    const sessId = resuming ? prev!.id : id();
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    handle = ex.run({
      prompt,
      cwd,
      sessionId: resuming ? prev!.cliSessionId! : undefined,
      trace: runTracePaths(runDir, sessId, turnStart),
    });
    trackRun(taskId, handle);

    // Reuse the agent's session row when resuming; otherwise open a fresh line,
    // inheriting the task's worktree/branch from its first session.
    let cliSessionId = resuming ? prev!.cliSessionId! : handle.sessionId;
    if (resuming) {
      // New turn on the same session row: mark it live (clear the prior turn's
      // end) and stamp this turn's start, so execution-time accounting and the
      // live 用时 both track the turn actually running now.
      await db.update(sessions).set({ turnStartedAt: turnStart, endedAt: null }).where(eq(sessions.id, sessId));
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
      });
    }

    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });
    if (opts.system) {
      // Backend-initiated 继续: a 〔系统〕 trace (its own bubble), NOT a 你→ reply.
      // Persist as a structured turn (reload) and emit a matching system event (live).
      writeTurn(out, { t: "system", agent, text: SYS_MARKER });
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event: { kind: "system", text: SYS_MARKER } });
    } else {
      // 你→@agent reply, persisted as a structured turn so a reloaded thread shows
      // the human turn as its own bubble (live, the client already shows it).
      writeTurn(out, { t: "user", agent, text: userText });
    }

    let exitStatus = 0;
    for await (const event of handle.events) {
      if (event.kind === "session") {
        if (event.cliSessionId !== cliSessionId) {
          cliSessionId = event.cliSessionId;
          await db
            .update(sessions)
            .set({ cliSessionId, resumeCommand: ex.resumeCommand(cwd, cliSessionId) })
            .where(eq(sessions.id, sessId));
        }
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event });
        continue;
      }
      if (event.kind === "text" || event.kind === "thinking") out.write(event.text);
      else if (event.kind === "error") writeRunError(out, event.message);
      if (event.kind === "done") exitStatus = event.exitStatus;
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event });
    }
    const stopped = takeStopped(taskId);
    const endIso = now();
    await db
      .update(sessions)
      .set({ exitStatus, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(turnStart))}` })
      .where(eq(sessions.id, sessId));
    const settled = await settleTaskStatus(taskId, exitStatus, stopped);
    if (settled.note) {
      out.write(`\n> ${settled.note}\n`);
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event: { kind: "error", message: settled.note } });
    }
    writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
    out.end();
  } catch (err) {
    bus.publish({
      type: "agent.event", taskId, sessionId: "", role: "single", agentType,
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, takeStopped(taskId) ?? "failed");
  } finally {
    if (handle) untrackRun(taskId, handle);
    running.delete(taskId);
  }
}
