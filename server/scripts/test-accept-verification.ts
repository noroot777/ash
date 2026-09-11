import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Called by test:accept-merge after its throwaway database is initialized.
export async function testAcceptanceVerification(root: string) {
  const { db } = await import("../src/db/index.js");
  const { projects, tasks, sessions } = await import("../src/db/schema.js");
  const { acceptTask, mountTaskAcceptanceRoutes } = await import("../src/task-accept.js");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { acceptFamily, readBranchPlan } = await import("../src/task-branch-routes.js");
  const { testVerificationStations, multiVerifyWorkflow } = await import("./test-accept-verification-stations.js");
  const repo = join(root, "verification");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(repo, "config", "user.name", "Acceptance test");
  git(repo, "config", "user.email", "accept@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-qm", "seed");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "verification", name: "verification", repoPath: repo, createdAt: at, updatedAt: at });
  const run = { id: "s1", kind: "run", p: { instruction: null, executorId: null, model: null, reasoningEffort: null }, fail: null };
  const verify = { id: "s2", kind: "verify", p: { executorId: null, model: null, reasoningEffort: null, checks: [] }, fail: { mode: "stop", max: 1 } };
  const human = { id: "s4", kind: "human", p: { show: [], notify: [] }, fail: null };
  const accept = { id: "s5", kind: "accept", p: { strategy: "safe", clean: "all" }, fail: { mode: "stop", max: 1 } };
  const line = { workspace: "isolated", steps: [run, verify, human, accept] };
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  async function make(id: string, patch: Partial<typeof tasks.$inferInsert> = {}) {
    await db.insert(tasks).values({ id, projectId: "verification", title: id, body: "", mode: "single", status: "done",
      stage: "awaiting_acceptance", workflow: JSON.stringify(line), workflowAt: "s4", useWorktree: false,
      createdAt: at, updatedAt: at, ...patch });
  }
  const api = new Hono();
  mountTaskAcceptanceRoutes(api);
  const post = (id: string, body: unknown = {}) => api.request(`/tasks/${id}/accept`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  async function warning(id: string) {
    const response = await post(id);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "verify_not_run");
    assert.equal(result.confirmationRequired, "confirmUnverified");
    assert.match(result.error, /独立验证尚未执行/);
    assert.deepEqual(result.verification.stepIds, ["s2"]);
  }

  await make("neververify1", { useWorktree: true, worktreeBase: "main" });
  const ws = await prepareWorktree(repo, "neververify1", "main");
  writeFileSync(join(ws.path, "result.txt"), "review me\n");
  git(ws.path, "add", "result.txt");
  git(ws.path, "commit", "-qm", "result");
  await db.insert(sessions).values({ id: "never-session", taskId: "neververify1", role: "single", agentType: "codex", executor: "codex", startedAt: at, endedAt: at });
  const head = git(repo, "rev-parse", "main");
  const before = await row("neververify1");
  await warning("neververify1");
  assert.equal((await post("neververify1", { confirmUnverified: "true" })).status, 409);
  assert.deepEqual(await row("neververify1"), before, "refusal cannot mutate task state");
  assert.equal(git(repo, "rev-parse", "main"), head);
  assert.ok(existsSync(ws.path));
  assert.match(readFileSync(sessionTranscriptPath("neververify1", "never-session"), "utf8"), /独立验证尚未执行/);
  assert.equal((await post("neververify1", { confirmUnverified: true })).status, 200);
  assert.equal((await row("neververify1")).stage, "accepted");
  assert.equal((await row("neververify1")).verifyRounds, 0);
  assert.equal(git(repo, "show", "main:result.txt"), "review me");
  assert.equal(existsSync(ws.path), false);
  assert.match(readFileSync(sessionTranscriptPath("neververify1", "never-session"), "utf8"), /已显式确认继续/);
  assert.equal((await post("neververify1")).status, 200, "idempotent acceptance needs no second confirmation");

  for (const [id, patch] of [
    ["normalverify", { verifyRounds: 1, verifyRound: null }],
    ["failedverify", { verifyRounds: 1, stage: "verify_failed" }],
    ["noverify", { workflow: JSON.stringify({ ...line, steps: [run, human, accept] }) }],
  ] as const) {
    await make(id, patch);
    assert.equal((await (await api.request(`/tasks/${id}/acceptance-check`)).json()).verification, null);
    assert.equal((await post(id)).status, 200, id);
  }
  await make("stageonly", { stage: "verified" });
  await warning("stageonly");
  const automatic = await acceptTask("stageonly", "workflow");
  assert.equal(automatic.accepted, false, "automatic accept cannot silently bypass verification either");
  await make("legacytarget");
  await make("legacyreview", { reviewOf: "legacytarget", workflow: null, status: "backlog" });
  await warning("legacytarget");
  await db.insert(sessions).values({ id: "old-review-session", taskId: "legacyreview", role: "single", agentType: "codex", executor: "codex", startedAt: at, endedAt: at });
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "legacyreview"));
  assert.equal((await post("legacytarget")).status, 200, "executed legacy review is compatible");
  for (const [id, patch] of [["busyverify", { status: "running" }], ["pendingverify", { verifyRound: 1 }]] as const) {
    await make(id, patch);
    const response = await post(id, { confirmUnverified: true });
    assert.equal(response.status, 409);
    assert.notEqual((await response.json()).reason, "verify_not_run", "confirmation cannot bypass active-run guards");
  }

  const gateLine = { ...line, steps: [run, human, verify, accept] };
  await make("postgateverify", { workflow: JSON.stringify(gateLine), useWorktree: true, worktreeBase: "main" });
  const gateWs = await prepareWorktree(repo, "postgateverify", "main");
  let started = 0;
  const released = await acceptTask("postgateverify", "human", { confirmUnverified: true, startVerifyRound: async id => {
    started++;
    assert.equal(id, "postgateverify");
    assert.equal((await row(id)).workflowAt, "s2");
  } });
  assert.ok(released.accepted && released.kind === "gate_released");
  assert.equal(started, 1, "human after run must dispatch the later verify exactly once");
  assert.notEqual((await row("postgateverify")).stage, "accepted");
  assert.ok(existsSync(gateWs.path));
  git(repo, "show-ref", "--verify", `refs/heads/${worktreeBranchName("postgateverify")}`);
  assert.equal(git(repo, "show", "main:result.txt"), "review me");

  await make("familyverify", { useWorktree: true, worktreeBase: "main" });
  await prepareWorktree(repo, "familyverify", "main");
  const familyPlan = (await readBranchPlan("familyverify"))!;
  assert.equal(familyPlan.task.unexecutedVerification?.reason, "verify_not_run");
  const family = await acceptFamily("familyverify", [familyPlan.task], acceptTask);
  assert.equal(family.ok, false);
  assert.deepEqual(family.completed, []);
  assert.equal((await acceptFamily("familyverify", [{ ...familyPlan.task, confirmUnverified: true }], acceptTask)).ok, true);

  await testVerificationStations();
  await make("mcpverify");
  await make("mcpmultiverify", { workflow: multiVerifyWorkflow, workflowAt: "h2", reviewStep: "v1", verifyRounds: 1, verifyStationRounds: 1 });
  const backend = serve({ fetch: new Hono().route("/api", api).fetch, hostname: "127.0.0.1", port: 0 });
  if (!backend.listening) await new Promise<void>(resolve => backend.once("listening", resolve));
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "acceptance-regression", version: "1" });
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("../../mcp/src/index.ts", import.meta.url))],
      env: { ...process.env, ASH_URL: `http://127.0.0.1:${address.port}`, ASH_TASK_ID: "", ASH_TURN_TOKEN: "", ASH_DIRECTION_TOKEN: "" } as Record<string, string>, stderr: "pipe" });
    await client.connect(transport);
    for (const [taskId, missingStep] of [["mcpverify", "s2"], ["mcpmultiverify", "v2"]] as const) {
      const result = await client.callTool({ name: "accept_task", arguments: { taskId } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /verify_not_run/);
      assert.match(JSON.stringify(result.content), /confirmUnverified/);
      assert.ok(JSON.stringify(result.content).includes(missingStep));
      const confirmed = await client.callTool({ name: "accept_task", arguments: { taskId, confirmUnverified: true } });
      assert.notEqual(confirmed.isError, true);
      assert.equal((await row(taskId)).stage, "accepted");
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  }
  console.log("accept verification: HTTP/MCP confirmation, unchanged Git on refusal, legacy/completed rounds, family acceptance and post-human dispatch passed");
}
