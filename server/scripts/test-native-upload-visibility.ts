import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { finished } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentEvent, ServerEvent } from "@ash/shared";
import type { AgentExecutor, ResidentHandle } from "../src/executors/types.js";
import type { Lead } from "../src/team/session-types.js";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-native-upload-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("test-native-upload-visibility");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, uploads } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { createUser, resetUserKey } = await import("../src/auth/store.js");
const { addProjectMember } = await import("../src/auth/visibility.js");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");
const { consumeSingleRun } = await import("../src/single-run.js");
const { createSessionConsumer } = await import("../src/team/session-consumer.js");
const { persistToolResultImages } = await import("../src/agent-attachments.js");
const { childActivity } = await import("../src/executors/native-agent-activity.js");
const { parseSessionTrace } = await import("../src/transcript.js");
const { bus } = await import("../src/bus.js");

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.route("/api", api);
const live: ServerEvent[] = [];
const unsubscribe = bus.subscribe((event) => live.push(event));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const image = () => persistToolResultImages([{ type: "image", mimeType: "image/png", data: png }])[0]!;
const at = new Date().toISOString();
const noResume = () => ({ resumeCommand: "fixture", resumeEnv: null, resumeArgs: null });
const ex: AgentExecutor = { type: "claude", label: "fixture", run: () => { throw new Error("No real executor in fixture"); }, resumeFields: noResume, resumeCommand: () => "fixture" };
const outputs: ReturnType<typeof createWriteStream>[] = [];

try {
  await ensureSchema();
  const usersRoot = join(stage, "users");
  for (const name of ["owner", "member", "outsider"]) mkdirSync(join(usersRoot, name), { recursive: true });
  await setInstanceMode("multi", usersRoot);
  const people = await Promise.all(["owner", "member", "outsider"].map((name) => createUser({ name, role: "member", dirName: name,
    gitName: name, gitEmail: `${name}@example.test`, createdBy: null })));
  const [owner, member, outsider] = people;
  const keys = await Promise.all(people.map((person) => resetUserKey(person.id)));
  await db.insert(projects).values({ id: "project", name: "Native uploads", repoPath: stage, createdAt: at });
  for (const person of [owner!, member!]) await addProjectMember({ projectId: "project", userId: person.id, role: "member", addedBy: null });

  for (const mode of ["single", "team"] as const) for (const agentType of ["claude", "codex"] as const) {
    const taskId = `${mode}-${agentType}`;
    const sessId = `s-${taskId}`;
    const role = mode === "team" ? "lead" : "single";
    await db.insert(tasks).values({ id: taskId, projectId: "project", title: taskId, body: "fixture", mode, status: "running",
      ownerUserId: owner!.id, agentType, nativeTurn: mode === "single", autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at });
    await db.insert(sessions).values({ id: sessId, taskId, role, agentType, executor: "fixture", startedAt: at, turnStartedAt: at, cwd: stage });
    const childImage = image();
    const mainImage = image();
    const get = (file: string, key: string) => app.request(`/api/uploads/${encodeURIComponent(basename(file))}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal((await get(childImage, keys[0]!)).status, 404, "an unregistered image starts private");
    const events: AgentEvent[] = [
      childActivity("native-child", { kind: "text", text: "子智能体的截图" }),
      childActivity("native-child", { kind: "attachment", path: childImage }),
      { kind: "attachment", path: mainImage },
      { kind: "done", exitStatus: 0 },
    ];
    const handle: ResidentHandle = { sessionId: "fixture", commandLine: "fixture", events: (async function* () { yield* events; })(),
      kill() {}, close() {}, interrupt() {}, send: () => true };
    const runDir = join(stage, "runs", taskId);
    mkdirSync(runDir, { recursive: true });
    const out = createWriteStream(join(runDir, `${sessId}.md`));
    outputs.push(out);
    if (mode === "single") {
      await consumeSingleRun({ taskId, sessId, agentType, ex, cwd: stage, handle, out, turnStart: at, cliSessionId: "fixture", autoTitle: false });
    } else {
      const lead: Lead = { taskId, sessId, agentType, cliSessionId: "fixture", ownerUserId: owner!.id, executorId: null, model: null,
        reasoningEffort: null, cwd: stage, handle, out, busy: true, turnStart: at, pending: [], notices: [], pendingCredential: null,
        wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: null };
      const leads = new Map([[taskId, lead]]);
      await createSessionConsumer({ leads, adoptInbound: async () => {}, flushUnqueued: async () => {}, releasePending: () => {} }).consume(lead);
      assert.equal(leads.size, 0);
    }
    await finished(out);
    for (const file of [childImage, mainImage]) {
      const row = (await db.select().from(uploads).where(eq(uploads.file, basename(file)))).at(0);
      assert.equal(row?.taskId, taskId, `${taskId} registered the image on its task`);
      for (const key of keys.slice(0, 2)) {
        const response = await get(file, key);
        assert.equal(response.status, 200, `${taskId}: owner/project member can open the image`);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, "base64"));
      }
      assert.equal((await get(file, keys[2]!)).status, 404, `${outsider!.name} remains unauthorized`);
    }
    const trace = parseSessionTrace(readFileSync(join(runDir, `${sessId}.trace.jsonl`), "utf8"));
    assert.ok(trace.some(({ event }) => event.kind === "tool" && event.nativeWork?.type === "activity" && event.nativeWork.event.kind === "attachment" && event.nativeWork.event.path === childImage));
    assert.ok(!trace.some(({ event }) => event.kind === "attachment" && event.path === childImage), "authorization does not move the image into the main conversation");
    assert.ok(live.some((event) => event.type === "agent.event" && event.taskId === taskId && event.event.kind === "tool" && event.event.nativeWork?.type === "activity" && event.event.nativeWork.event.kind === "attachment"));
  }
  console.log("native image authorization passed: single/team × Claude/Codex; owners and project members get image bytes, outsiders get 404; child scope preserved");
} finally {
  unsubscribe();
  for (const out of outputs) out.destroy();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
