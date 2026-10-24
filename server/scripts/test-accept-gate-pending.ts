import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-gate-pending-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
Object.assign(globalThis, { failAfterGateRegistration: true });
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (!/\/src\/repo-lock\.(?:ts|js)$/.test(resolved.url)) return resolved;
  const original = JSON.stringify(`${resolved.url}?pending-fault-original`);
  const source = `
    import * as original from ${original};
    export * from ${original};
    export async function withRepoLock(repoPath, callback) {
      const result = await original.withRepoLock(repoPath, callback);
      if (globalThis.failAfterGateRegistration && result?.reason === "accept_gate_required") {
        globalThis.failAfterGateRegistration = false;
        throw new Error("injected after gate registration");
      }
      return result;
    }`;
  return { ...resolved, format: "module", url: `data:text/javascript,${encodeURIComponent(source)}` };
} });

try {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  git("config", "user.name", "Gate Pending Test");
  git("config", "user.email", "gate@example.test");
  writeFileSync(join(repo, "seed.txt"), "seed");
  git("add", "-A");
  git("commit", "-m", "seed");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, sessions, acceptGateRuns } = await import("../src/db/schema.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { hasLiveAcceptGate, cancelAcceptGate } = await import("../src/accept-gate.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  await ensureSchema();
  const taskId = "pending-exception-task";
  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "pending-project", name: "pending", repoPath: repo,
    acceptGateCommand: `"${process.execPath}" -e "setTimeout(()=>{},120000)"`, createdAt: stamp });
  await db.insert(tasks).values({ id: taskId, projectId: "pending-project", title: "pending", status: "done",
    stage: "verified", workflowMode: "free", mode: "single", useWorktree: false, createdAt: stamp, updatedAt: stamp });
  await db.insert(sessions).values({ id: "pending-session", taskId, role: "single", agentType: "codex", executor: "codex",
    cwd: repo, startedAt: stamp, turnStartedAt: stamp, endedAt: stamp, activeMs: 0 });
  await assert.rejects(acceptTask(taskId), /injected after gate registration/);
  assert.equal(hasLiveAcceptGate(taskId), false);
  assert.equal((await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))).length, 0);
  const transcript = sessionTranscriptPath(taskId, "pending-session");
  assert.ok(existsSync(transcript));
  assert.match(readFileSync(transcript, "utf8"), /已撤销未执行的启动登记/);
  const retry = await acceptTask(taskId);
  assert.equal(retry.accepted, false);
  if (!retry.accepted) assert.equal(retry.reason, "accept_gate_running");
  await cancelAcceptGate(taskId);
  assert.equal(hasLiveAcceptGate(taskId), false);
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log("pending gate exception: real acceptTask fault after registration, durable audit and retry passed");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
