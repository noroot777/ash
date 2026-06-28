import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, projects, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, attachmentsPrompt } from "./util.js";
import { setTaskStatus } from "./status.js";
import { trackRun, untrackRun, takeCanceled } from "./runs.js";
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
// canceled, or a non-zero exit) is (re)started, we RESUME its existing CLI
// session with this nudge instead of re-running from scratch — the agent already
// holds the full prior context via --resume, so no AUTONOMY preamble.
const RESUME_PROMPT =
  "继续：你上一次的运行被中断了（可能是服务重启或被手动停止）。请从中断处接着完成这个任务，先简要说明你已做到哪一步、还差什么，然后继续推进直到完成。";
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

// Why a task is being (re)started — only used to label the resume; all reasons
// behave the same (resume if there's a resumable session, else fresh). Note: a
// scheduled cron fire is NOT here — it always starts a fresh run via runTask
// (schedules.ts), so it never resumes. `wake` = an upstream task just settled
// done and the settle hook is auto-resuming this paused dependent.
export type ResumeReason = "group" | "run" | "retry" | "wake";

async function setStatus(taskId: string, status: Parameters<typeof setTaskStatus>[1]) {
  await setTaskStatus(taskId, status);
}

// 任务跑完一回合时的状态落位：手停 → canceled；agent 在本回合内调过 pause_task
// （写下 resumePrompt） → paused，等依赖满足或用户手动 resume；否则按退出码定
// done/failed。一处算清楚，run / continue / 未来的 debate 共用同一规则。
async function settleTaskStatus(taskId: string, exitStatus: number, canceled: boolean): Promise<void> {
  if (canceled) return setStatus(taskId, "canceled");
  const r = (await db.select({ rp: tasks.resumePrompt }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (r?.rp) return setStatus(taskId, "paused");
  const final = exitStatus === 0 ? "done" : "failed";
  await setStatus(taskId, final);
  // 自动唤醒：一个任务 done 时，同组里**直接以它为 resumeDependsOn** 的 paused
  // 任务可能正等着这一刻 —— 检查它们 resumeDependsOn 是否**全部**满足，满足就
  // launch。不调 runGroup（runGroup 会扫整组、扯进无关 backlog、还嵌套同步等
  // 待所有 inflight done）。事件驱动、只唤醒被解锁的那一层；下一级 done 时再
  // 触发下一轮 hook，沿 dependsOn 图链式传播。failed/canceled 不触发：
  // resumeDependsOn 只看 done（跟 scheduler 的 resolved 集合一致）。
  if (final === "done") void wakePausedDependents(taskId);
}

// 同组、直接依赖 doneTaskId、且所有 resumeDependsOn 都已 done 的 paused 任务。
// resumeOrRunTask 内部有 single-flight (`running.has`)，所以并发触发（多个上游同时
// done）不会启动两次。fire-and-forget：不等下游跑完，链式传播靠后续的 settle hook。
export async function wakePausedDependents(doneTaskId: string): Promise<void> {
  try {
    const done = (await db.select().from(tasks).where(eq(tasks.id, doneTaskId))).at(0);
    if (!done?.groupId) return; // 无 group 就不传播（跨组依赖少见，用户可手点继续）
    const peers = await db.select().from(tasks).where(eq(tasks.groupId, done.groupId));
    const doneIds = new Set(peers.filter((p) => p.status === "done").map((p) => p.id));
    const peerIds = new Set(peers.map((p) => p.id));
    for (const p of peers) {
      if (p.status !== "paused" || p.archived) continue;
      const deps = JSON.parse(p.resumeDependsOn) as string[];
      if (!deps.includes(doneTaskId)) continue; // 不直接依赖刚 done 的，跳过
      // 剩下的 deps 也要全 done（不在同组的 id 视作满足，跟 scheduler 一致）
      const allReady = deps.every((d) => !peerIds.has(d) || doneIds.has(d));
      if (allReady) void resumeOrRunTask(p.id, { reason: "wake" });
    }
  } catch (err) {
    // hook 是兜底，失败不该让源任务的 done 回退。打日志、吞掉。
    console.error(`[harness] wakePausedDependents(${doneTaskId}) failed:`, err);
  }
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
    const prompt = AUTONOMY + (autoTitle ? TITLE_HINT + objective : objective);
    const turnStart = now();
    handle = ex.run({ prompt, cwd: ws.path });
    trackRun(taskId, handle);

    const sessId = id();
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
      commandLine: handle.commandLine,
      startedAt: turnStart,
      turnStartedAt: turnStart,
      activeMs: 0,
      exitStatus: null as number | null,
    };
    await db.insert(sessions).values(sessRow);

    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
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
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType, event });
        if (event.kind === "done") exitStatus = event.exitStatus;
      }
    }
    if (!titleDone && head) emitText(head); // agent never produced a newline

    // A manual stop kills the subprocess → the stream ends like a normal exit;
    // settle as canceled (not done/failed) so it can be re-run / continued.
    const canceled = takeCanceled(taskId);
    const endIso = now();
    writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
    out.end();
    await db
      .update(sessions)
      .set({ exitStatus, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(turnStart))}` })
      .where(eq(sessions.id, sessId));
    await settleTaskStatus(taskId, exitStatus, canceled);
  } catch (err) {
    bus.publish({
      type: "agent.event",
      taskId,
      sessionId: "",
      role: "single",
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, takeCanceled(taskId) ? "canceled" : "failed");
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
    const prompt = (invited ? COLLAB_INVITE : "") + userText + attachmentsPrompt(opts.attachments);
    const turnStart = now();
    handle = ex.run({ prompt, cwd, sessionId: resuming ? prev!.cliSessionId! : undefined });
    trackRun(taskId, handle);

    // Reuse the agent's session row when resuming; otherwise open a fresh line,
    // inheriting the task's worktree/branch from its first session.
    let sessId: string;
    let cliSessionId = resuming ? prev!.cliSessionId! : handle.sessionId;
    if (resuming) {
      sessId = prev!.id;
      // New turn on the same session row: mark it live (clear the prior turn's
      // end) and stamp this turn's start, so execution-time accounting and the
      // live 用时 both track the turn actually running now.
      await db.update(sessions).set({ turnStartedAt: turnStart, endedAt: null }).where(eq(sessions.id, sessId));
    } else {
      sessId = id();
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
        commandLine: handle.commandLine,
        startedAt: turnStart,
        turnStartedAt: turnStart,
        activeMs: 0,
        exitStatus: null,
      });
    }

    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
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
      if (event.kind === "done") exitStatus = event.exitStatus;
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", agentType: agent, event });
    }
    const canceled = takeCanceled(taskId);
    const endIso = now();
    writeTurnEnd(out, endIso); // fence this turn's real end before closing the .md
    out.end();
    await db
      .update(sessions)
      .set({ exitStatus, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${Math.max(0, Date.parse(endIso) - Date.parse(turnStart))}` })
      .where(eq(sessions.id, sessId));
    await settleTaskStatus(taskId, exitStatus, canceled);
  } catch (err) {
    bus.publish({
      type: "agent.event", taskId, sessionId: "", role: "single", agentType,
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, takeCanceled(taskId) ? "canceled" : "failed");
  } finally {
    if (handle) untrackRun(taskId, handle);
    running.delete(taskId);
  }
}
