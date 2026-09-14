// 预览起多大一摊（`$ASH_PREVIEW_MODE`）照谁的意思来。
//
// 钉的是这条：自由预览这一档**曾经写死 `"frontend"`**，项目在设置里配什么都没用。
// 这个 bug 的症状是隐形的 —— 用户改完后端、打开预览、看到的是**另一个进程**（自带
// 的 dev 脚本把 /api 打回正在跑的那台 ash）上的旧行为，页面上没有一个字提过这件事，
// 于是只能得出「我改的东西没生效」。真实排查耗掉了一整轮对话。
//
// 所以这里不测「函数返回了什么」，测**启动命令手上真正拿到的那个环境变量** —— 中间
// 任何一环把它换掉，命令自己就会 exit，预览起不来。
//
// 跑法：npm -w server run test:preview-launch
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PREVIEW_MODE, parsePreviewConfig, previewLaunchOf, type ProjectPreviewConfig } from "@ash/shared/preview";

const root = mkdtempSync(join(realpathSync(tmpdir()), "ash-preview-launch-"));
process.env.ASH_DB = join(root, "test.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
const { mountFreePreviewRoutes } = await import("../src/free-workflow-preview.js");
const { stopPreview } = await import("../src/preview.js");
const { previewShell } = await import("../src/preview-shell.js");
await ensureSchema();

// ── 纯函数那一层：老配置读出来是什么 ────────────────────────────────────────
const base: ProjectPreviewConfig = { mode: "script", proxy: "off", primaryServiceId: null, services: [], launch: "frontend" };
// 这个字段是后加的，库里存量配置一条都没有。补 frontend 而不是别的，因为那是它存在
// 之前写死的值 —— 补别的等于在一次升级里把所有项目的预览悄悄换一种起法。
const { launch: _dropped, ...legacy } = base;
assert.equal(parsePreviewConfig(legacy)!.launch, "frontend", "老配置补成 frontend");
assert.equal(parsePreviewConfig({ ...base, launch: "test" })!.launch, "test", "配了就照配的存");
assert.throws(() => parsePreviewConfig({ ...base, launch: "halfstack" }), "不认识的档要拦在保存那一刻");
assert.equal(previewLaunchOf({ launch: "full" }), "full");
assert.equal(previewLaunchOf({}), "frontend", "没有这个字段 = 老配置");
assert.equal(previewLaunchOf(null), "frontend", "整份配置都没有");
assert.equal(previewLaunchOf({ launch: 7 }), "frontend", "坏值不抛，按默认起 —— 开预览这一刻不是报配置错的时候");
assert.deepEqual([...PREVIEW_MODE], ["command", "frontend", "full", "test"], "值域是编排那边共用的同一份");

// ── 端到端：启动命令手上拿到的到底是哪一档 ──────────────────────────────────
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
// 命令自己验：环境变量不是期待的那一档就立刻退出，预览于是起不来，断言在 200 上失败。
const probe = (expected: string) => `${previewShell().quote(process.execPath)} -e "if(process.env.ASH_PREVIEW_MODE!=='${expected}')process.exit(21);const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('http://localhost:'+s.address().port+'/'))"`;
const stamp = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "Preview", repoPath: repo, createdAt: stamp });
await db.insert(tasks).values({
  id: "t", projectId: "p", title: "Preview", status: "done",
  workflowMode: "free", mode: "single", useWorktree: false, createdAt: stamp, updatedAt: stamp,
});

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
const api = new Hono();
mountProjectRoutes(api); mountFreePreviewRoutes(api);
app.route("/api", api);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
if (!server.listening) await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}`;
const request = (path: string, method = "GET", body?: unknown) => fetch(url + path, {
  method, redirect: "manual",
  headers: body === undefined ? {} : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function openWith(config: Partial<ProjectPreviewConfig> | null, expected: string, why: string) {
  const saved = await request("/api/projects/p", "PATCH", {
    previewCommand: probe(expected),
    previewConfig: config === null ? null : { ...base, ...config },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const started = await request("/api/tasks/t/free-workflow/preview", "POST");
  assert.equal(started.status, 200, `${why}：${await started.clone().text()}`);
  await stopPreview("t", null);
}

try {
  // 没配过预览的项目（previewConfig 为 null）仍走老行为，别把存量项目换一种起法。
  await openWith(null, "frontend", "没有配置时仍是只起前端");
  await openWith({ launch: "frontend" }, "frontend", "配了只起前端");
  // 这一条就是原来那个 bug：配了整栈，自由预览却照样递 frontend。
  await openWith({ launch: "test" }, "test", "配了前后端 + 测试库快照");
  await openWith({ launch: "full" }, "full", "配了前后端全启动");
  await openWith({ launch: "command" }, "command", "配了按项目启动命令");
  console.log("test-preview-launch: ok");
} finally {
  await stopPreview("t", null).catch(() => {});
  server.close();
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
