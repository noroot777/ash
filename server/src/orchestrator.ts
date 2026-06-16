import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentType, TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, projects, groups, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { id, now } from "./util.js";
import { prepareWorkspace } from "./git.js";
import { resolveExecutor } from "./executors/index.js";
import { RUNS_DIR } from "./paths.js";

const running = new Set<string>(); // taskIds currently executing (single-flight)

async function setStatus(taskId: string, status: TaskStatus) {
  await db.update(tasks).set({ status, updatedAt: now() }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.status", taskId, status });
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

    const ws = await prepareWorkspace(project.repoPath, taskId, useWorktree);
    const agentType = (task.agentType as AgentType) ?? "claude";
    const ex = await resolveExecutor(agentType);

    const autoTitle = !!task.autoTitle;
    const TITLE_HINT =
      "请在正式开始前，第一行只输出：标题：<不超过14字、概括本次任务的简短标题>，然后换行，再正常完成下面的任务。\n\n任务：\n";
    const objective = task.body?.trim() || task.title;
    const prompt = autoTitle ? TITLE_HINT + objective : objective;
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
