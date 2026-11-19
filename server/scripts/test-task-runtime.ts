import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { NAVI_HEADERS } from "@ash/shared/http-headers";
import type { BrowserObservation } from "@ash/shared/task-runtime";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-runtime-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { mountTaskRuntimeRoutes } = await import("../src/task-runtime-routes.js");
const { mountPreviewRoutes } = await import("../src/preview-routes.js");
const { mountFreePreviewRoutes } = await import("../src/free-workflow-preview.js");
const { startPreview, stopPreview, stopPreviewAtAccept, stopPreviewOnRerun, isPreviewStarting } = await import("../src/preview.js");
const { beginPreviewStart, endPreviewStart, previewStartCanceled } = await import("../src/preview-start-state.js");
const { setTaskStatus } = await import("../src/status.js");
const { readAnyPreview, alive } = await import("../src/preview-store.js");
const { taskBrowserState, closeTaskBrowser } = await import("../src/task-browser.js");
const { browserFile } = await import("../src/task-browser-store.js");
const { startDevelopmentService } = await import("../src/task-runtime-service.js");
const screenshots = process.env.ASH_RUNTIME_SCREENSHOTS || join(root, "screenshots");
mkdirSync(screenshots, { recursive: true });
const repo = join(root, "repo");
const workspace = join(repo, ".worktrees", "runtime");
mkdirSync(workspace, { recursive: true });
const stamp = new Date().toISOString();
await ensureSchema();
await db.insert(projects).values({ id: "runtime-project", name: "Runtime", repoPath: repo, createdAt: stamp });
await db.insert(tasks).values(["runtime", "other", "missing"].map((id) => ({ id, projectId: "runtime-project", title: id,
  workflowMode: "free", mode: "single", status: "running", useWorktree: true, createdAt: stamp, updatedAt: stamp,
  activeTurnToken: `turn-${id}`, activeDirectionToken: `direction-${id}` })));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>账户与令牌</title><style>
body{font:16px system-ui;background:#f5f6f8;color:#202b3b;margin:0;padding:28px} main{max-width:900px;margin:auto}
h1{font-size:27px;margin:0 0 24px} .row{background:white;padding:24px;border-radius:12px;margin-bottom:16px;border:1px solid #e1e5eb}
input{padding:10px;border:1px solid #cbd2dd;border-radius:6px;font:inherit;max-width:90%}button{background:#315ed0;color:white;border:0;border-radius:6px;padding:10px 18px;margin:16px 10px 0 0;font:inherit}
p{color:#647187}a{color:#315ed0}label{display:block;margin-bottom:12px;font-size:13px}section{display:flex;gap:15px}section div{flex:1}
@media(max-width:480px){body{padding:16px}section{display:block}}
</style></head><body><main><h1>账户与令牌</h1><section><div class="row"><p>本周额度</p><h2>¥ 2,000</h2></div><div class="row"><p>剩余额度</p><h2>¥ 1,480</h2></div></section>
<div class="row"><label for="name">成员姓名</label><input id="name" placeholder="输入成员姓名"><br><button onclick="document.querySelector('#result').textContent='已保存：'+document.querySelector('#name').value">保存</button><p id="result">等待保存</p>
<a href="/next">下一页</a> · <a href="https://example.com/">外站</a></div></main></body></html>`;
writeFileSync(join(repo, "service.cjs"), "throw Error('WRONG WORKSPACE')");
writeFileSync(join(workspace, "service.cjs"), `const http=require('node:http'); const html=${JSON.stringify(html)}; const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)});server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/'));`);
const app = new Hono();
const api = new Hono();
mountTaskRuntimeRoutes(api); mountPreviewRoutes(api); mountFreePreviewRoutes(api);
app.route("/api", api);
const agentHeaders = { [NAVI_HEADERS.sourceTaskId]: "runtime", [NAVI_HEADERS.turnToken]: "turn-runtime", [NAVI_HEADERS.directionToken]: "direction-runtime" };
const request = (suffix: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => app.request(`/api/tasks/runtime/${suffix}`, {
  method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function okJson(response: Response) {
  const value = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
const action = async (body: unknown, agent = true): Promise<BrowserObservation> => okJson(await request("runtime/browser", "POST", body, agent ? agentHeaders : {}));
let uiBrowser: any;
let web: any;
try {
  const ordinaryStart = beginPreviewStart("other");
  const developmentStart = beginPreviewStart("other", undefined, "development");
  try {
    await stopPreviewOnRerun("other");
    assert.equal(previewStartCanceled(ordinaryStart), true);
    assert.equal(previewStartCanceled(developmentStart), false);
    assert.equal(isPreviewStarting("other"), true);
    await stopPreview("other", null);
    assert.equal(previewStartCanceled(developmentStart), true);
  } finally {
    endPreviewStart("other", ordinaryStart);
    endPreviewStart("other", developmentStart);
  }
  assert.deepEqual(await okJson(await request("runtime")), { service: null, browser: null });
  assert.equal((await request("runtime/service", "POST", { command: "node service.cjs" })).status, 409);
  assert.equal((await request("runtime/service", "POST", { command: "node service.cjs" }, { ...agentHeaders, [NAVI_HEADERS.directionToken]: "old" })).status, 409);
  assert.equal((await request("runtime/service", "POST", { command: "node service.cjs" }, { ...agentHeaders, [NAVI_HEADERS.sourceTaskId]: "other", [NAVI_HEADERS.turnToken]: "turn-other" })).status, 409);
  assert.equal((await request("free-workflow/preview", "POST")).status, 409);
  await assert.rejects(() => startDevelopmentService("missing", { command: "node service.cjs" }, async () => {}), /工作区/);
  const started = await okJson(await request("runtime/service", "POST", { command: "node service.cjs", name: "额度 Demo" }, agentHeaders));
  assert.equal(started.reused, false);
  assert.ok(started.service.url);
  const first = readAnyPreview("runtime")!;
  assert.equal(first.purpose, "development");
  assert.equal((await fetch(first.url!)).status, 200);
  const reused = await okJson(await request("runtime/service", "POST", { command: "node service.cjs" }, agentHeaders));
  assert.equal(reused.reused, true);
  assert.equal(readAnyPreview("runtime")?.pid, first.pid);
  const realChrome = process.env.CHROME_BIN;
  process.env.CHROME_BIN = join(root, "missing-chrome");
  assert.equal((await request("runtime/browser", "POST", { action: "open" }, agentHeaders)).status, 409);
  assert.equal(taskBrowserState("runtime")?.status, "failed");
  assert.match(taskBrowserState("runtime")!.error!, /不可用/);
  if (realChrome) process.env.CHROME_BIN = realChrome; else delete process.env.CHROME_BIN;
  let observed = await action({ action: "open", width: 1280, height: 800, screenshot: true }, false);
  let browserId = observed.state.id;
  assert.equal(observed.state.control, "agent");
  assert.equal((await request("runtime/browser", "POST", { action: "reload", id: browserId })).status, 409);
  observed = await action({ action: "open", screenshot: true });
  assert.equal(observed.state.id, browserId);
  assert.ok(observed.image);
  const { registerTaskRuntimeTools } = await import("../../mcp/src/tools/task-runtime.js");
  const registered = new Map<string, (...args: any[]) => Promise<any>>();
  registerTaskRuntimeTools({ registerTool: (name: string, _config: unknown, handler: (...args: any[]) => Promise<any>) => registered.set(name, handler) } as any);
  assert.deepEqual([...registered.keys()], ["start_dev_service", "stop_dev_service", "browser_action"]);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/api\/tasks\/runtime\/runtime\/browser$/);
      assert.equal(new Headers(init?.headers).get(NAVI_HEADERS.directionToken), "direction-runtime");
      return new Response(JSON.stringify(observed), { status: 200 });
    };
    const toolResult = await registered.get("browser_action")!({ taskId: "runtime", directionToken: "direction-runtime", action: "snapshot", id: browserId, screenshot: true });
    assert.deepEqual(toolResult.content.map((item: any) => item.type), ["text", "image"]);
    assert.equal(toolResult.content[1].mimeType, "image/png");
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "用户已接管" }), { status: 409 });
    const toolError = await registered.get("browser_action")!({ taskId: "runtime", directionToken: "direction-runtime", action: "reload", id: browserId });
    assert.equal(toolError.isError, true);
    assert.match(toolError.content[0].text, /用户已接管/);
  } finally { globalThis.fetch = realFetch; }
  assert.match(observed.text, /等待保存/);
  const name = observed.targets.find((target) => target.name === "成员姓名")!;
  assert.ok(name?.ref);
  assert.equal((await request("runtime/browser", "POST", { action: "resize", id: browserId, width: 100, height: 800 }, agentHeaders)).status, 409);
  observed = await action({ action: "fill", id: browserId, ref: name.ref, text: "智能体已验证" });
  assert.equal((await request("runtime/browser", "POST", { action: "click", id: browserId, ref: name.ref }, agentHeaders)).status, 409);
  observed = await action({ action: "click", id: browserId, ref: observed.targets.find((target) => target.name === "保存")!.ref });
  assert.match(observed.text, /已保存：智能体已验证/);
  assert.equal((await request("runtime/browser", "POST", { action: "navigate", id: browserId, path: "http://127.0.0.1:4317/" }, agentHeaders)).status, 409);
  observed = await action({ action: "snapshot", id: browserId });
  assert.equal(observed.state.error, null);
  if (process.env.ASH_RUNTIME_SERVER_ONLY !== "1") {
    await action({ action: "close", id: browserId });
    const { launchChrome, startWebServer } = await import("../../web/scripts/dom-stage.mjs");
    web = await startWebServer();
    uiBrowser = await launchChrome();
    const page = await uiBrowser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.route("**/api/**", async (route: any) => {
      const req = route.request();
      const url = new URL(req.url());
      const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(`${web.origin}/scripts/fixtures/task-runtime.html`);
    const pane = page.getByRole("complementary", { name: "共享浏览器" });
    await page.getByRole("button", { name: "浏览器", exact: true }).click();
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    await pane.getByRole("img").waitFor();
    browserId = taskBrowserState("runtime")!.id;
    assert.equal(taskBrowserState("runtime")?.control, "agent");
    assert.equal((await action({ action: "open" })).state.id, browserId);
    await page.getByRole("button", { name: "接管", exact: true }).click();
    await page.getByRole("button", { name: "交还", exact: true }).waitFor();
    assert.equal(taskBrowserState("runtime")?.control, "user");
    assert.equal((await request("runtime/browser", "POST", { action: "reload", id: browserId }, agentHeaders)).status, 409);
    const sharedName = (await action({ action: "snapshot", id: browserId })).targets.find((target) => target.name === "成员姓名")!;
    observed = await action({ action: "fill", id: browserId, ref: sharedName.ref, text: "" }, false);
    await action({ action: "click", id: browserId, ref: observed.targets.find((target) => target.name === "成员姓名")!.ref }, false);
    await page.getByRole("textbox", { name: "向页面输入文字" }).fill("同一个页面");
    await page.getByRole("button", { name: "输入", exact: true }).click();
    await page.getByRole("button", { name: "交还", exact: true }).click();
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    observed = await action({ action: "snapshot", id: browserId });
    assert.equal(observed.targets.find((target) => target.name === "成员姓名")?.value, "同一个页面");
    await page.screenshot({ path: join(screenshots, "shared-browser-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "收起浏览器", exact: true }).click();
    await pane.waitFor({ state: "hidden" });
    await action({ action: "snapshot", id: browserId });
    await page.reload();
    await page.getByRole("button", { name: "浏览器", exact: true }).waitFor();
    assert.equal(await pane.count(), 0);
    await page.getByRole("button", { name: "浏览器", exact: true }).click();
    await pane.getByRole("img").waitFor();
    await page.reload();
    await pane.getByRole("img").waitFor();
    await page.getByRole("button", { name: "日志", exact: true }).click();
    await page.getByRole("region", { name: "服务日志" }).getByText(/node service.cjs/).waitFor();
    await page.getByRole("button", { name: "日志", exact: true }).click();
    await page.getByRole("button", { name: "接管", exact: true }).click();
    await page.getByRole("button", { name: "交还", exact: true }).waitFor();
    await page.getByRole("combobox", { name: "浏览器尺寸" }).selectOption("mobile");
    await page.getByText("390 × 844", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".task-browser-viewport img")?.naturalWidth === 390);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(screenshots, "shared-browser-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "关闭浏览器", exact: true }).click();
    await page.getByRole("button", { name: "重连", exact: true }).waitFor();
    assert.equal(readAnyPreview("runtime")?.pid, first.pid);
    assert.equal(taskBrowserState("runtime")?.status, "closed");
    assert.equal(await pane.getByRole("img").count(), 1);
    await page.getByRole("button", { name: "重连", exact: true }).click();
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    assert.equal(taskBrowserState("runtime")?.control, "agent");
    assert.equal((await action({ action: "open" })).state.id, taskBrowserState("runtime")?.id);
    assert.notEqual(taskBrowserState("runtime")?.id, browserId);
    assert.equal((await request("runtime/browser", "POST", { action: "reload", id: browserId }, agentHeaders)).status, 409);
    await db.update(tasks).set({ activeTurnToken: null, activeDirectionToken: null, status: "done" }).where(eq(tasks.id, "runtime"));
    await page.reload();
    await pane.getByRole("img").waitFor();
    assert.ok(readAnyPreview("runtime")?.url);
    assert.equal((await request("runtime/browser", "POST", { action: "snapshot", id: browserId }, agentHeaders)).status, 409);
    const continuedBrowser = taskBrowserState("runtime")!.id;
    await setTaskStatus("runtime", "running");
    assert.equal(readAnyPreview("runtime")?.pid, first.pid);
    assert.equal(taskBrowserState("runtime")?.id, continuedBrowser);
    assert.equal(taskBrowserState("runtime")?.status, "ready");
    await page.reload();
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    await pane.getByRole("img").waitFor();
    await page.screenshot({ path: join(screenshots, "shared-browser-continued.png"), fullPage: true });
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "runtime"));
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.getByRole("button", { name: "重启", exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, "shared-browser-stopped.png"), fullPage: true });
    assert.equal(await page.getByRole("link", { name: "打开", exact: true }).count(), 0);
    await page.reload();
    await page.getByRole("button", { name: "重启", exact: true }).waitFor();
    await pane.getByRole("img").waitFor();
    assert.equal(await pane.getByRole("img").count(), 1);
    assert.deepEqual(pageErrors, []);
    console.log(`UI screenshots: ${screenshots}`);
  }
  await stopPreview("runtime", null);
  assert.equal(readAnyPreview("runtime"), null);
  assert.equal(alive(first.pid), false);
  assert.equal(taskBrowserState("runtime")?.status, "closed");
  assert.ok(existsSync(browserFile("runtime", "png")));
  assert.ok(JSON.parse(readFileSync(browserFile("runtime", "json"), "utf8")).activity.length);
  await db.update(tasks).set({ activeTurnToken: "turn-runtime", activeDirectionToken: "direction-runtime", status: "running" }).where(eq(tasks.id, "runtime"));
  let allowStartup = () => {};
  let startupReached = () => {};
  const startupBlocked = new Promise<void>((resolve) => { allowStartup = resolve; });
  const startupReady = new Promise<void>((resolve) => { startupReached = resolve; });
  let checks = 0;
  const coldStart = startDevelopmentService("runtime", { command: "node service.cjs" }, async () => {
    if (++checks === 2) { startupReached(); await startupBlocked; }
  });
  try {
    await startupReady;
    assert.equal(readAnyPreview("runtime"), null);
    await stopPreviewOnRerun("runtime");
    assert.equal(isPreviewStarting("runtime"), true);
  } finally { allowStartup(); }
  await coldStart;
  const continuedService = readAnyPreview("runtime")!;
  const continuedBrowser = (await action({ action: "open" })).state.id;
  const pendingPreview = beginPreviewStart("runtime");
  try {
    for (const previous of ["done", "paused", "failed"] as const) {
      await db.update(tasks).set({ status: previous }).where(eq(tasks.id, "runtime"));
      await setTaskStatus("runtime", "running");
      assert.equal(readAnyPreview("runtime")?.gen, continuedService.gen);
      assert.equal(alive(continuedService.pid), true);
      assert.equal(taskBrowserState("runtime")?.id, continuedBrowser);
      assert.equal((await action({ action: "snapshot", id: continuedBrowser })).state.status, "ready");
    }
    assert.equal(previewStartCanceled(pendingPreview), true);
  } finally { endPreviewStart("runtime", pendingPreview); }
  const replacement = await okJson(await request("runtime/service", "POST", { command: "node ./service.cjs" }, agentHeaders));
  assert.equal(replacement.reused, false);
  assert.notEqual(readAnyPreview("runtime")?.gen, continuedService.gen);
  assert.equal(alive(continuedService.pid), false);
  assert.equal(taskBrowserState("runtime")?.status, "closed");
  await action({ action: "open" });
  assert.equal((await stopPreviewAtAccept("runtime")).stopped, true);
  assert.equal(readAnyPreview("runtime"), null);
  assert.equal(taskBrowserState("runtime")?.status, "closed");
  const ordinary = await startPreview("runtime", {
    id: "preview", kind: "preview", p: { cmd: "node service.cjs", mode: "command", life: "task", ready: "port" }, fail: null,
  }, workspace);
  assert.equal(ordinary.ok, true);
  await assert.rejects(() => startDevelopmentService("runtime", { command: "node ./service.cjs" }, async () => {}), /已有另一项预览服务/);
  await stopPreviewOnRerun("runtime");
  assert.equal(readAnyPreview("runtime"), null);
  if (ordinary.ok) assert.equal(alive(ordinary.record.pid), false);
  console.log("PASS task runtime: service ownership/reuse/replacement, continuation and cold-start lifetimes, watch-only open/reconnect, takeover, persistent frames, acceptance and ordinary preview cleanup");
} finally {
  await uiBrowser?.close();
  await web?.close();
  await closeTaskBrowser("runtime");
  await stopPreview("runtime", null);
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
