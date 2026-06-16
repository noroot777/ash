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

    const prompt = task.body?.trim() || task.title;
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

    // Persist raw output alongside the DB row (DESIGN.md §11: long text -> files).
    const runDir = join(RUNS_DIR, taskId);
    mkdirSync(runDir, { recursive: true });
    const out = createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" });

    let exitStatus = 0;
    for await (const event of handle.events) {
      bus.publish({ type: "agent.event", taskId, sessionId: sessId, role: "single", event });
      if (event.kind === "session" && event.cliSessionId !== cliSessionId) {
        cliSessionId = event.cliSessionId;
        await db
          .update(sessions)
          .set({ cliSessionId, resumeCommand: ex.resumeCommand(ws.path, cliSessionId) })
          .where(eq(sessions.id, sessId));
      } else if (event.kind === "text" || event.kind === "thinking") {
        out.write(event.text + "\n");
      } else if (event.kind === "done") {
        exitStatus = event.exitStatus;
      }
    }
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
