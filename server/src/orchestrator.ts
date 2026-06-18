import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { AgentType, TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, projects, groups, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now, imagesPrompt } from "./util.js";
import { resolveWorkspace, ensureWorkdir } from "./git.js";
import { resolveExecutor } from "./executors/index.js";
import { RUNS_DIR } from "./paths.js";

const running = new Set<string>(); // taskIds currently executing (single-flight)

// Single tasks run headless — nobody can answer a mid-run prompt. Tell the agent
// to act autonomously rather than stall waiting for confirmation; if it genuinely
// needs input it can still ask, and the user replies via continueTask (resume).
const AUTONOMY =
  "你在一个无人值守的自动化环境中运行，没有人能实时回复你。请尽量自主完成：遇到多个合理方案时，选最稳妥的一个并在结果中说明假设与取舍；不要停下来等待人工确认，除非信息确实不足以继续。\n\n";

async function setStatus(taskId: string, status: TaskStatus) {
  await db.update(tasks).set({ status, updatedAt: now() }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.status", taskId, status });
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
    .set({ status: "failed", updatedAt: now() })
    .where(inArray(tasks.status, ["running", "queued"]));
  console.log(`[harness] reconciled ${orphaned.length} interrupted task(s) → failed`);
}

// M1: execute a single-agent task in an isolated worktree, stream output over
// SSE, and persist a session credential (DESIGN.md §1/§4/§12/§13).
export async function runTask(taskId: string): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("debate mode runs in M4");

    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("project not found");

    await setStatus(taskId, "running");

    const group = task.groupId
      ? (await db.select().from(groups).where(eq(groups.id, task.groupId))).at(0)
      : undefined;
    const useWorktree = group ? group.useWorktree : true;

    const ws = await resolveWorkspace(project.repoPath, taskId, useWorktree);
    const agentType = (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutor(agentType);

    const autoTitle = !!task.autoTitle;
    const TITLE_HINT =
      "请在正式开始前，第一行只输出：标题：<不超过14字、概括本次任务的简短标题>，然后换行，再正常完成下面的任务。\n\n任务：\n";
    const objective = task.body?.trim() || task.title;
    const prompt = AUTONOMY + (autoTitle ? TITLE_HINT + objective : objective);
    const handle = ex.run({ prompt, cwd: ws.path });

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
      startedAt: now(),
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
      out.write(text + "\n");
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", event: { kind: "text", text } });
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
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", event });
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
        out.write(event.text + "\n");
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", event });
      } else {
        bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", event });
        if (event.kind === "done") exitStatus = event.exitStatus;
      }
    }
    if (!titleDone && head) emitText(head); // agent never produced a newline
    out.end();

    await db.update(sessions).set({ exitStatus }).where(eq(sessions.id, sessId));
    await setStatus(taskId, exitStatus === 0 ? "done" : "failed");
  } catch (err) {
    bus.publish({
      type: "agent.event",
      taskId,
      sessionId: "",
      role: "single",
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, "failed");
  } finally {
    running.delete(taskId);
  }
}

// Continue a single task by resuming its CLI session with the user's reply — so
// when an agent stops to ask, the human can answer and it keeps going in the
// SAME session (full context retained), instead of the task being a dead end.
export async function continueTask(taskId: string, userText: string, opts: { images?: string[] } = {}): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new Error("task not found");
    if (task.mode !== "single") throw new Error("reply is for single tasks");

    const prev = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
      .filter((s) => s.role === "single")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!prev || !prev.cliSessionId) throw new Error("没有可恢复的会话，请先运行一次");

    const agentType = (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutor(agentType);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    const cwd = prev.cwd || prev.worktreePath || (project ? ensureWorkdir(project.repoPath, taskId) : ".");

    await setStatus(taskId, "running");
    let cliSessionId = prev.cliSessionId;
    const handle = ex.run({ prompt: userText + imagesPrompt(opts.images), cwd, sessionId: cliSessionId });

    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    const out = createWriteStream(join(runDir, `${prev.id}.md`), { flags: "a" });
    out.write(`\n\n〔你〕${userText}\n`); // so a reloaded thread shows the human turn too

    let exitStatus = 0;
    for await (const event of handle.events) {
      if (event.kind === "session") {
        if (event.cliSessionId !== cliSessionId) {
          cliSessionId = event.cliSessionId;
          await db
            .update(sessions)
            .set({ cliSessionId, resumeCommand: ex.resumeCommand(cwd, cliSessionId) })
            .where(eq(sessions.id, prev.id));
        }
        bus.publish({ type: "agent.event", taskId, sessionId: prev.id, role: "single", event });
        continue;
      }
      if (event.kind === "text" || event.kind === "thinking") out.write(event.text + "\n");
      if (event.kind === "done") exitStatus = event.exitStatus;
      bus.publish({ type: "agent.event", taskId, sessionId: prev.id, role: "single", event });
    }
    out.end();

    await db.update(sessions).set({ exitStatus }).where(eq(sessions.id, prev.id));
    await setStatus(taskId, exitStatus === 0 ? "done" : "failed");
  } catch (err) {
    bus.publish({
      type: "agent.event", taskId, sessionId: "", role: "single",
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, "failed");
  } finally {
    running.delete(taskId);
  }
}
