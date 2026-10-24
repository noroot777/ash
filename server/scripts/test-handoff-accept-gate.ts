import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-gate-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.HOME = join(root, "home");
process.env.USERPROFILE = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, projects, tasks } = await import("../src/db/schema.js");
  const { collectGateRuns } = await import("../src/handoff-accept-gate.js");
  const { collectRunArtifacts, collectRunArtifactTexts } = await import("../src/handoff-collect.js");
  const { isTextRel } = await import("../src/handoff-uploads.js");
  const { importHandoff } = await import("../src/handoff-import.js");
  const { validate } = await import("../src/handoff-import-payload.js");
  const { acceptGateState } = await import("../src/accept-gate-state.js");
  const { acceptGateLogPath } = await import("../src/accept-gate-process.js");
  type Manifest = import("../src/handoff-types.js").HandoffManifest;
  await ensureSchema();
  const stamp = new Date().toISOString();
  const from = "a".repeat(64);
  const back = "b".repeat(64);
  mkdirSync(join(root, "project-a"));
  mkdirSync(join(root, "project-b"));
  await db.insert(projects).values([
    { id: "gate-machine-a", name: "A", repoPath: join(root, "project-a"), createdAt: stamp },
    { id: "gate-machine-b", name: "B", repoPath: join(root, "project-b"), createdAt: stamp },
  ]);
  const taskId = "gate-handoff-task";
  await db.insert(tasks).values({ id: taskId, projectId: "gate-machine-a", title: "gate transfer", body: "",
    status: "done", stage: "accepted", workflowMode: "free", useWorktree: false, acceptedGateMode: "passed",
    acceptedGateRunId: "gate-passed", createdAt: stamp, updatedAt: stamp });
  await db.insert(acceptGateRuns).values([
    { id: "gate-failed", taskId, projectId: "gate-machine-a", command: "old-test", status: "failed", exitCode: 1,
      failure: "exit_code", cwd: "foreign/path", logPath: "/unavailable/original.log", startedAt: stamp, finishedAt: stamp },
    { id: "gate-passed", taskId, projectId: "gate-machine-a", command: "new-test", status: "passed", exitCode: 0,
      cwd: "foreign/snapshot", logPath: acceptGateLogPath(taskId, "gate-passed"), sourceCommit: "c".repeat(40),
      sourceFingerprint: "d".repeat(64), executionMode: "macos-observed", startedAt: stamp, finishedAt: stamp },
  ]);
  const log = acceptGateLogPath(taskId, "gate-passed");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "tested immutable source: passed\n");
  writeFileSync(`${log}.launch.json`, '{"phase":"armed","pid":1234}');
  mkdirSync(join(dirname(log), "accept-gate-gate-passed.source"));
  writeFileSync(join(dirname(log), "accept-gate-gate-passed.source", "private.txt"), "not a transfer artifact");
  const history = await collectGateRuns(taskId);
  assert.equal(history.length, 2);
  assert.ok(history.every(run => !("pid" in run) && !("cwd" in run) && !("sourceFingerprint" in run)));
  const artifacts = await collectRunArtifacts(taskId, []);
  assert.deepEqual(artifacts.map(file => file.rel), ["accept-gate-gate-passed.log"]);
  assert.deepEqual(await collectRunArtifactTexts(taskId, []), [], "gate logs are transferred but not scanned for attachments");
  const reportText = JSON.stringify({ attachment: join(root, "uploads", "artifact-only.txt") });
  writeFileSync(join(dirname(log), "report.json"), reportText);
  const nested = join(dirname(log), "accept-gate-gate-passed.source", "node_modules", "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "package.json"), JSON.stringify({ attachment: join(root, "uploads", "snapshot-only.txt") }));
  writeFileSync(`${log}.macos-processes.json`, JSON.stringify({ private: join(root, "uploads", "control-only.txt") }));
  const previewTexts = await collectRunArtifactTexts(taskId, []);
  const exportedTexts = (await collectRunArtifacts(taskId, [])).filter(file => isTextRel(file.rel))
    .map(file => Buffer.from(file.dataBase64, "base64").toString("utf8"));
  assert.deepEqual(previewTexts, [reportText], "eligible artifact text is included in attachment preview");
  assert.deepEqual(previewTexts, exportedTexts, "preview and export exclude retained snapshots and supervision files before traversal");
  assert.equal(previewTexts.some(text => /snapshot-only|control-only/.test(text)), false);
  const sourceTask = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  const manifest: Manifest = { version: 1, sourceHost: "A", sourceFingerprint: from, originFingerprint: from,
    targetProjectId: "gate-machine-b", transferId: "gate-outbound", autoResume: false, sourceWorkspace: null,
    task: { ...sourceTask, agentType: "claude", model: null, reasoningEffort: null,
      acceptedGateMode: "passed", acceptedGateRunId: "gate-passed" }, sessions: [], files: artifacts, git: null,
    acceptGateRuns: history };
  await db.delete(tasks).where(eq(tasks.id, taskId));
  await db.delete(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  await importHandoff(manifest);
  let state = await acceptGateState(taskId);
  assert.equal(state.basis?.mode, "passed");
  assert.equal(state.basis?.run?.id, "gate-passed");
  assert.equal(state.basis?.run?.logAvailable, true);
  assert.match(state.basis?.run?.executionNotice!, /macOS 兼容监督/);
  assert.match(state.basis!.run!.logTail, /immutable source/);
  let importedRows = await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  assert.ok(importedRows.every(run => run.projectId === "gate-machine-b" && !run.pid && !run.processPending && !run.sourceFingerprint));
  assert.equal((await importHandoff(manifest)).idempotent, true);
  const unknownLog = importedRows.find(run => run.id === "gate-failed")!.logPath;
  assert.ok(unknownLog.endsWith(".not-transferred"));
  const returned: Manifest = { ...manifest, sourceHost: "B", sourceFingerprint: back, transferId: "gate-return",
    targetProjectId: "gate-machine-a", acceptGateRuns: await collectGateRuns(taskId), files: [],
    task: { ...manifest.task, acceptedGateMode: "skipped", acceptedGateRunId: null } };
  await db.update(tasks).set({ handoff: JSON.stringify({ direction: "out", pending: false, peerFp: back }) }).where(eq(tasks.id, taskId));
  await importHandoff(returned);
  state = await acceptGateState(taskId);
  assert.equal(state.basis?.mode, "skipped", "return replaces the frozen receipt instead of preserving the outbound pass");
  assert.equal(state.latest?.logAvailable, false, "old local logs cannot masquerade as logs carried on this transfer");
  importedRows = await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  assert.equal(importedRows.length, 2);
  assert.ok(importedRows.every(run => run.projectId === "gate-machine-a"));
  assert.equal(readFileSync(log, "utf8"), "tested immutable source: passed\n");
  assert.throws(() => validate({ ...manifest, acceptGateRuns: [{ ...history[0], id: "../escape" }] }), /记录非法/);
  assert.throws(() => validate({ ...manifest, acceptGateRuns: [{ ...history[0], status: "running" }] }), /记录非法/);
  assert.throws(() => validate({ ...manifest, acceptGateRuns: [{ ...history[0], executionMode: "fake-kernel" }] }), /executionMode 非法/);
  assert.throws(() => validate({ ...manifest, acceptGateRuns: [{ ...history[0], id: "gate-passed" }] }), /未通过/);
  await db.insert(acceptGateRuns).values({ id: "active-gate", taskId, projectId: "gate-machine-a", command: "busy",
    status: "running", processPending: true, cwd: "foreign", logPath: join(root, "unknown.log"), startedAt: stamp });
  await assert.rejects(collectGateRuns(taskId), /仍占用/);
  assert.equal((await importHandoff(returned)).idempotent, true, "an acknowledgement replay must not reimport an active local task");
  await db.update(tasks).set({ handoff: JSON.stringify({ direction: "out", pending: false, peerFp: back }) }).where(eq(tasks.id, taskId));
  await assert.rejects(importHandoff({ ...returned, transferId: "blocked-return" }), /仍占用/);
  console.log("handoff-accept-gate: outbound/return receipts, history, logs, absent logs, idempotency and active-run protection passed");
} finally { await releaseTmpDb(); rmSync(root, { recursive: true, force: true }); }
