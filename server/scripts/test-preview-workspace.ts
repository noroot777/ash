import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { WorkspacePreviewLaunch } from "@ash/shared/preview";

const root = mkdtempSync(join(realpathSync(tmpdir()), "ash-workspace-preview-"));
process.env.ASH_DB = join(root, "test.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, tasks, scheduledMessages } = await import("../src/db/schema.js");
const { mountFreePreviewRoutes } = await import("../src/free-workflow-preview.js");
const { mountPreviewRoutes } = await import("../src/preview-routes.js");
const { mountPreviewOpenRoutes } = await import("../src/preview-access.js");
const { mountPreviewProxy } = await import("../src/preview-proxy.js");
const { authGate } = await import("../src/auth/middleware.js");
const { previewState } = await import("../src/preview-public.js");
const { readPreview, stopPreview } = await import("../src/preview.js");
const { restartTaskPreview } = await import("../src/workflow-steps.js");
const { beginRerunGate, endRerunGate } = await import("../src/rerun-gate.js");
const { claimTurn, releaseTurn } = await import("../src/runs.js");
const { previewShell } = await import("../src/preview-shell.js");
await ensureSchema();
const repo = join(root, "repo");
mkdirSync(repo);
writeFileSync(join(repo, "index.html"), "<html><head></head><body>PROJECT ROOT</body></html>");
const stamp = new Date().toISOString();
await db.insert(projects).values({ id: "project", name: "workspace", repoPath: repo, previewCommand: null, createdAt: stamp });
const ids = ["free", "preset", "nostep", "missing", "legacy"];
for (const id of ids) {
  await db.insert(tasks).values({ id, projectId: "project", title: id, workflowMode: id === "free" || id === "legacy" ? "free" : "preset",
    status: "done", mode: "single", useWorktree: id !== "legacy", createdAt: stamp, updatedAt: stamp,
    workflow: id === "preset" ? JSON.stringify({ workspace: "isolated", steps: [
      { id: "run", kind: "run", p: {}, fail: null },
      { id: "preview-step", kind: "preview", p: { cmd: "exit 9", mode: "frontend", ready: "port+log", life: "gate" }, fail: null },
      { id: "human", kind: "human", p: {}, fail: null },
    ] }) : null });
  if (id === "missing") continue;
  const dir = id === "legacy" ? repo : join(repo, ".worktrees", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<html><head></head><body>TASK ${id}</body></html>`);
  writeFileSync(join(dir, "service.cjs"), `const http = require('node:http'); const server = http.createServer((req,res) => { res.setHeader('content-type','text/html'); res.end('<html><head></head><body>CUSTOM TASK</body></html>'); }); server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('http://localhost:'+server.address().port+'/'));`);
}
const app = new Hono();
mountPreviewProxy(app);
app.use("*", authGate());
const api = new Hono();
mountPreviewRoutes(api); mountFreePreviewRoutes(api); mountPreviewOpenRoutes(api);
app.route("/api", api);
const request = (path: string, method = "GET", body?: unknown) => app.request(path, { method,
  headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const launch = async (id: string): Promise<WorkspacePreviewLaunch> => {
  const response = await request(`/api/tasks/${id}/preview?launch=1`);
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const endpoint = (id: string) => `/api/tasks/${id}/${id === "free" || id === "legacy" ? "free-workflow/preview" : "preview/restart"}`;
const custom = `${previewShell().quote(process.execPath)} service.cjs`;
try {
  for (const id of ["free", "preset", "nostep"]) {
    assert.equal(previewState(id).running, false);
    const info = await launch(id);
    assert.equal(info.reason, "");
    assert.equal(info.directory, join(repo, ".worktrees", id));
    assert.equal(info.steps.length, id === "preset" ? 1 : 0);
    assert(info.candidates.length > 0);
    const candidate = info.candidates.find((item) => item.requiresSelection)!;
    assert(candidate, "static candidates require an explicit selection");
    const started = await request(endpoint(id), "POST", { workspace: true, command: candidate.command });
    assert.equal(started.status, 200, await started.clone().text());
    const state = await (await request(`/api/tasks/${id}/preview`)).json();
    assert.equal(state.starting, false); assert.equal(state.running, true); assert.equal(state.proxied, true);
    const service = state.services.find((s: { status: string }) => s.status === "ready");
    assert(service?.url.startsWith(`/api/tasks/${id}/preview/open/`));
    const gateway = await request(service.url);
    assert.equal(gateway.status, 302);
    const page = await request(gateway.headers.get("location")!);
    assert.equal(page.status, 200, `iframe page at ${gateway.headers.get("location")}`);
    const html = await page.text();
    assert(html.includes(`TASK ${id}`), "preview must use task files, not the project root");
    assert(html.includes("ash-preview-annotation"), "iframe document must contain the existing annotation runtime");
    assert.equal(readPreview(id)?.life, id === "preset" ? "gate" : "task");
    const generation = previewState(id).gen;
    await launch(id);
    assert.equal(previewState(id).gen, generation, "reading candidates must not restart existing services");
    await stopPreview(id, "test cleanup");
  }
  const info = await launch("missing");
  assert.equal(info.directory, null); assert.match(info.reason, /工作目录已不存在/);
  const missing = await request(endpoint("missing"), "POST", { workspace: true, command: custom });
  assert.notEqual(missing.status, 200); assert.match(await missing.text(), /工作目录已不存在/);
  assert(!existsSync(join(repo, ".worktrees", "missing")), "missing task worktrees must not be recreated");

  const failed = await request(endpoint("free"), "POST", { workspace: true, command: `${previewShell().quote(process.execPath)} -e "console.error('PREVIEW_BROKEN');process.exit(7)"` });
  assert.equal(failed.status, 409); assert.match(await failed.text(), /PREVIEW_BROKEN/);
  const log = await (await request("/api/tasks/free/preview?log=1")).json();
  assert.equal(log.exists, true); assert.match(log.text, /PREVIEW_BROKEN/);

  await db.insert(scheduledMessages).values({ id: "pending", taskId: "free", text: "new feedback", sendAt: stamp, createdAt: stamp });
  assert.match((await launch("free")).reason, /后续消息/);
  assert.equal((await request(endpoint("free"), "POST", { workspace: true, command: custom })).status, 409);
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, "pending"));
  for (const id of ["free", "preset"]) {
    beginRerunGate(id);
    try { assert.notEqual((await request(endpoint(id), "POST", { workspace: true, command: custom })).status, 200); }
    finally { endRerunGate(id); }
    assert(claimTurn(id));
    try { assert.notEqual((await request(endpoint(id), "POST", { workspace: true, command: custom })).status, 200); }
    finally { releaseTurn(id); }
  }

  const canceled = restartTaskPreview("preset", undefined, { workspace: true, command: custom });
  const stopped = await request("/api/tasks/preset/preview", "DELETE");
  assert.equal((await stopped.json()).stopped, true);
  assert.equal((await canceled).ok, false);
  assert.equal(previewState("preset").running, false);

  const config = { mode: "services", proxy: "off", primaryServiceId: "app", services: [
    { id: "app", name: "配置服务", command: custom, enabled: true, kind: "web" },
  ] };
  await db.update(projects).set({ previewCommand: "exit 3", previewConfig: config }).where(eq(projects.id, "project"));
  const saved = (await launch("free")).configured!;
  assert(saved.config);
  const configured = await request(endpoint("free"), "POST", { workspace: true, ...saved });
  assert.equal(configured.status, 200, await configured.clone().text());
  assert.equal(previewState("free").services?.[0].id, "app");
  assert.equal(previewState("free").proxied, true);
  await stopPreview("free", "test cleanup");
  const original = await request(endpoint("legacy"), "POST");
  assert.equal(original.status, 200, await original.clone().text());
  assert.equal(previewState("legacy").proxied, false, "legacy preview still follows project proxy settings");
  await stopPreview("legacy", "test cleanup");
  writeFileSync(join(repo, ".worktrees", "free", "package.json"), JSON.stringify({ private: true, scripts: { dev: "node service.cjs" } }));
  const frameworks = await launch("free");
  assert(frameworks.candidates.some((c) => c.command.includes("run dev")));
  assert(frameworks.candidates.every((c) => !c.requiresSelection));
  const dev = await request(endpoint("free"), "POST", { workspace: true, command: frameworks.candidates[0].command });
  assert.equal(dev.status, 200, await dev.clone().text());
  const project = (await db.select().from(projects).where(eq(projects.id, "project")))[0];
  assert.equal(project.previewCommand, "exit 3"); assert.deepEqual(project.previewConfig, config);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "preset")))[0].workflowAt, null);
  assert(!previewState("missing").running);
  console.log("preview workspace: task-local static/framework/custom/config launches, proxy + annotation document, missing workspace, logs, pending/turn/rerun guards, cancellation and unchanged lifecycle passed");
} finally {
  await Promise.all(ids.map((id) => stopPreview(id, null)));
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
