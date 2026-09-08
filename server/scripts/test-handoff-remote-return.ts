import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Task, TaskHandoff } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-handoff-remote-return-"));
process.env.ASH_DB = join(stage, "local.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("handoff-remote-return");
const { startSignedHandoffPeer } = await import("./handoff-signed-peer-fixture.js");
const peer = await startSignedHandoffPeer();
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { patchAppSettings } = await import("../src/app-settings.js");
  const { SINGLE_ACTOR, setActor } = await import("../src/auth/context.js");
  const { mountHandoffRemoteRoutes } = await import("../src/handoff-remote.js");
  await ensureSchema();
  await patchAppSettings({ handoffTargets: [{ name: "holder", url: peer.url, peerFp: peer.fingerprint }] });
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "project", name: "project", repoPath: stage, createdAt: at });
  const marker: TaskHandoff = {
    direction: "out", transferId: "original", peerUrl: peer.url, peerName: "holder",
    peerFp: peer.fingerprint, peerTaskId: "task", at, sessions: 0, git: "none",
  };
  await db.insert(tasks).values({
    id: "task", projectId: "project", title: "return task", status: "canceled",
    createdAt: at, updatedAt: at, handoff: JSON.stringify(marker),
  });
  const api = new Hono();
  api.use("*", async (context, next) => { setActor(context, SINGLE_ACTOR); await next(); });
  mountHandoffRemoteRoutes(api);
  const request = () => api.request("/tasks/task/remote-return", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUrl: peer.url }),
  });
  const setMarker = (next: TaskHandoff) => db.update(tasks).set({ handoff: JSON.stringify(next) }).where(eq(tasks.id, "task"));
  const readMarker = async () => JSON.parse((await db.select().from(tasks).where(eq(tasks.id, "task")))[0]!.handoff!);

  const unchanged = await request();
  assert.equal(unchanged.status, 409, "对端 200 但本机仍为 out，不能报告成功");
  assert.match((await unchanged.json() as { error: string }).error, /尚未确认任务已移回本机/);
  assert.deepEqual(await readMarker(), marker, "失败校验不应修改任务所有权");

  for (const direction of ["out", "returned"] as const) {
    await setMarker(marker);
    const held = peer.holdNextProbe();
    const response = request();
    try {
      await held.received;
      await setMarker({ ...marker, direction, ...(direction === "out" ? { pending: true } : {}) });
    } finally {
      held.release();
    }
    const result = await response;
    if (direction === "out") {
      assert.equal(result.status, 409, "pending 也不是已确认移回");
    } else {
      assert.equal(result.status, 200, "本机已接回任务才返回成功");
      assert.equal((await result.json() as { task: Task }).task.handoff?.direction, "returned");
    }
  }
} finally {
  await peer.close();
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

console.log("handoff remote return tests passed: unchanged/pending archives rejected, confirmed ownership accepted");
