import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { NAVI_HEADERS } from "@navi/shared/http-headers";
import type { BrowserObservation } from "@navi/shared/task-runtime";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-task-runtime-"));
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.env.NAVI_DEPS_DIR = join(root, "deps");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { mountTaskRuntimeRoutes } = await import("../src/task-runtime-routes.js");
const { mountPreviewRoutes } = await import("../src/preview-routes.js");
const { mountFreePreviewRoutes } = await import("../src/free-workflow-preview.js");
const { startPreview, stopPreview, stopPreviewAtAccept, stopPreviewOnRerun, isPreviewStarting } = await import("../src/preview.js");
const { beginDriving, beginPreviewStart, endPreviewStart, previewStartCanceled } = await import("../src/preview-start-state.js");
const { setTaskStatus } = await import("../src/status.js");
const { readAnyPreview, alive } = await import("../src/preview-store.js");
const { taskBrowserState, closeTaskBrowser } = await import("../src/task-browser.js");
const { browserFile } = await import("../src/task-browser-store.js");
const { startDevelopmentService } = await import("../src/task-runtime-service.js");
const screenshots = process.env.NAVI_RUNTIME_SCREENSHOTS || join(root, "screenshots");
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
  if (process.env.NAVI_RUNTIME_SERVER_ONLY !== "1") {
    await action({ action: "close", id: browserId });
    const { launchChrome, startWebServer } = await import("../../web/scripts/dom-stage.mjs");
    web = await startWebServer();
    uiBrowser = await launchChrome();
    const page = await uiBrowser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    // 扣住「runtime」任务的下一次状态查询，放行前切到别的任务：模拟上一个任务迟到的响应。
    let holdNext = false;
    let releaseHeld: (() => void) | null = null;
    let heldSeen: (() => void) | null = null;
    let holdAction = false;
    let releaseAction: (() => void) | null = null;
    let actionSeen: (() => void) | null = null;
    let pollGate: Promise<void> | null = null;
    let browserPosts = 0;
    let refuseOpen = "";
    await page.route("**/api/**", async (route: any) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "POST" && url.pathname === "/api/tasks/runtime/runtime/browser") {
        browserPosts += 1;
        if (refuseOpen && JSON.parse(req.postData() ?? "{}").action === "open") {
          const error = refuseOpen;
          refuseOpen = "";
          await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error }) });
          return;
        }
      }
      if (holdNext && req.method() === "GET" && url.pathname === "/api/tasks/runtime/runtime") {
        holdNext = false;
        await new Promise<void>((resolve) => { releaseHeld = resolve; heldSeen?.(); });
      }
      if (pollGate && req.method() === "GET" && url.pathname === "/api/tasks/runtime/runtime") await pollGate;
      if (holdAction && req.method() === "POST" && url.pathname === "/api/tasks/runtime/runtime/browser") {
        // 动作在后端照常执行，只是把真实响应晚一点交回页面。
        holdAction = false;
        const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
        const body = Buffer.from(await response.arrayBuffer());
        await new Promise<void>((resolve) => { releaseAction = resolve; actionSeen?.(); });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body });
        return;
      }
      const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(`${web.origin}/scripts/fixtures/task-runtime.html`);
    // 服务、浏览器两格在右栏：服务托管起来就上条；浏览器关着时不自己切过去。
    const pane = page.getByRole("region", { name: "共享浏览器" });
    const tab = (name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
    await tab("服务").waitFor();
    await tab("浏览器").waitFor();
    assert.equal(await pane.count(), 0);
    await tab("服务").click();
    await page.getByRole("region", { name: "服务日志" }).getByText(/node service.cjs/).waitFor();
    assert.ok(await page.getByRole("link", { name: "打开", exact: true }).count());
    await page.screenshot({ path: join(screenshots, "runtime-service-inspector.png") });
    // 智能体一开浏览器，右栏自己切到「浏览器」那一格，宽到跟会话大约五五开。
    await tab("信息").click();
    observed = await action({ action: "open" });
    browserId = observed.state.id;
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    await pane.getByRole("img").waitFor();
    const share = await page.evaluate(() => document.querySelector(".inspector-host")!.getBoundingClientRect().width / window.innerWidth);
    assert.ok(share > 0.45 && share < 0.55, `浏览器那一格约占一半宽，实际 ${share}`);
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
    await page.screenshot({ path: join(screenshots, "shared-browser-controlled.png") });
    await page.getByRole("button", { name: "交还", exact: true }).click();
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    observed = await action({ action: "snapshot", id: browserId });
    assert.equal(observed.targets.find((target) => target.name === "成员姓名")?.value, "同一个页面");
    await page.screenshot({ path: join(screenshots, "shared-browser-desktop.png") });
    // 切走就是切走：同一个浏览器会话刷新后不再把你拽回来；换回那一格，刷新后还停在那。
    await tab("信息").click();
    await pane.waitFor({ state: "hidden" });
    await action({ action: "snapshot", id: browserId });
    await page.reload();
    await tab("浏览器").waitFor();
    assert.equal(await pane.count(), 0);
    await tab("浏览器").click();
    await pane.getByRole("img").waitFor();
    await page.reload();
    await pane.getByRole("img").waitFor();
    await page.getByRole("button", { name: "接管", exact: true }).click();
    await page.getByRole("button", { name: "交还", exact: true }).waitFor();
    await page.getByRole("button", { name: "手机尺寸", exact: true }).click();
    await page.getByText("390 × 844", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".task-browser-viewport img")?.naturalWidth === 390);
    await page.screenshot({ path: join(screenshots, "shared-browser-mobile-size.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(screenshots, "shared-browser-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("button", { name: "断开", exact: true }).click();
    await page.getByRole("button", { name: "重连", exact: true }).waitFor();
    assert.equal(readAnyPreview("runtime")?.pid, first.pid);
    assert.equal(taskBrowserState("runtime")?.status, "closed");
    assert.equal(await pane.getByRole("img").count(), 1);
    // 从「服务」那格打开浏览器被拒：切到的「浏览器」格（有历史会话）当场写着原因，不用切回去找。
    refuseOpen = "已有 4 个共享浏览器，请关闭不用的会话后重试";
    await tab("服务").click();
    await page.getByRole("button", { name: "在共享浏览器里查看", exact: true }).click();
    await pane.getByRole("alert").filter({ hasText: /已有 4 个共享浏览器/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: "重连", exact: true }).count(), 1);
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
    // 接管后连敲两个键，第一个的响应还没回来就切到别的任务：排着的第二个不再发出去，第一个迟到的结果
    // 也落不到新任务上（新任务没有浏览器，那一格就不该冒出来）。
    await page.getByRole("button", { name: "接管", exact: true }).click();
    await page.getByRole("button", { name: "交还", exact: true }).waitFor();
    const typed = new Promise<void>((resolve) => { actionSeen = resolve; });
    holdAction = true;
    browserPosts = 0;
    await pane.getByRole("group", { name: "共享页面画面" }).focus();
    await page.keyboard.press("x");
    await typed;
    await page.keyboard.press("y");
    await page.getByRole("button", { name: "切换任务", exact: true }).click();
    await pane.waitFor({ state: "hidden" });
    releaseAction!();
    await page.waitForTimeout(800);
    assert.equal(browserPosts, 1, "切走后，排着的输入还是发了出去");
    assert.equal(await tab("浏览器").count(), 0, "上一个任务的浏览器结果串进了当前任务");
    assert.equal(await page.getByText("你在操作", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "切换任务", exact: true }).click();
    await tab("浏览器").waitFor(); // 右栏记着停在「浏览器」，回来就是那一格（再点一下是收起）
    await page.getByRole("button", { name: "交还", exact: true }).click();
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    // A→B→A：在 A 点了接管、响应还没回来就切到 B；期间 A 的浏览器被关掉重开成新会话；切回 A 后旧接管的
    // 响应才到。它属于上一次访问、上一个浏览器会话，不能把新会话画成「你在操作」。
    const actionHeld = new Promise<void>((resolve) => { actionSeen = resolve; });
    holdAction = true;
    await page.getByRole("button", { name: "接管", exact: true }).click();
    await actionHeld;
    await page.getByRole("button", { name: "切换任务", exact: true }).click();
    await pane.waitFor({ state: "hidden" });
    const replacedId = taskBrowserState("runtime")!.id;
    await action({ action: "close", id: replacedId }, false);
    const reopened = (await action({ action: "open" }, false)).state.id;
    assert.notEqual(reopened, replacedId);
    await page.getByRole("button", { name: "切换任务", exact: true }).click();
    await tab("浏览器").click();
    await page.getByRole("button", { name: "接管", exact: true }).waitFor();
    let openGate!: () => void;
    pollGate = new Promise<void>((resolve) => { openGate = resolve; });
    releaseAction!();
    await page.waitForTimeout(800);
    assert.equal(await page.getByRole("button", { name: "交还", exact: true }).count(), 0, "上一次访问的接管结果盖到了新的浏览器会话上");
    assert.equal(await page.getByText("智能体在操作", { exact: true }).count(), 1);
    pollGate = null;
    openGate();
    await pane.getByRole("img").waitFor();
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "runtime"));
    await tab("服务").click();
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.getByRole("button", { name: "重启", exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, "shared-browser-stopped.png"), fullPage: true });
    assert.equal(await page.getByRole("link", { name: "打开", exact: true }).count(), 0);
    await page.reload();
    await page.getByRole("button", { name: "重启", exact: true }).waitFor();
    await tab("浏览器").click();
    await pane.getByRole("img").waitFor();
    assert.equal(await pane.getByRole("img").count(), 1);
    // 动作被拒的原因一直挂着：后面成功的状态轮询（1.5s 一次）不会把它冲掉。
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "runtime"));
    await tab("服务").click();
    const restart = page.getByRole("button", { name: "重启", exact: true });
    await restart.click();
    const refused = page.getByRole("alert").filter({ hasText: /任务正在执行/ });
    await refused.waitFor();
    await page.waitForTimeout(3500);
    assert.equal(await refused.count(), 1, "重启被拒的原因被后来的轮询清掉了");
    // 任务执行中服务端本就不让用户起服务：重启键直接灰着，不留一颗点了才被拒的键。
    await page.goto(`${web.origin}/scripts/fixtures/task-runtime.html?running=1`);
    await restart.waitFor(); // 右栏记着停在「服务」（再点一下已选中的格是收起整栏）
    assert.equal(await restart.isDisabled(), true);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "runtime"));
    // 换任务时上一个任务迟到的状态不能落到当前任务上（否则服务格会拿上一个任务的命令去重启）。
    await page.goto(`${web.origin}/scripts/fixtures/task-runtime.html`);
    await tab("服务").waitFor();
    const held = new Promise<void>((resolve) => { heldSeen = resolve; });
    holdNext = true;
    await held;
    await page.getByRole("button", { name: "切换任务", exact: true }).click();
    await tab("服务").waitFor({ state: "hidden" });
    releaseHeld!();
    await page.waitForTimeout(1000);
    assert.equal(await tab("服务").count(), 0, "上一个任务迟到的服务状态串进了当前任务");
    assert.equal(await page.getByText("node service.cjs").count(), 0);
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
  if (!ordinary.ok) throw new Error(ordinary.reason);
  const ordinaryRecord = ordinary.record;
  for (const command of ["node service.cjs", "node ./service.cjs"]) {
    const reusedOrdinary = await okJson(await request("runtime/service", "POST", { command }, agentHeaders));
    assert.equal(reusedOrdinary.reused, true);
    assert.equal(reusedOrdinary.service.gen, ordinaryRecord.gen);
    assert.equal(reusedOrdinary.service.command, ordinaryRecord.cmd);
    assert.equal(reusedOrdinary.service.url, ordinaryRecord.url);
    assert.equal(readAnyPreview("runtime")?.purpose, undefined);
  }
  let ordinaryPage = await action({ action: "open" });
  const ordinaryBrowser = ordinaryPage.state.id;
  ordinaryPage = await action({ action: "fill", id: ordinaryBrowser, ref: ordinaryPage.targets.find(target => target.name === "成员姓名")!.ref, text: "续聊后保留" });
  await action({ action: "click", id: ordinaryBrowser, ref: ordinaryPage.targets.find(target => target.name === "保存")!.ref });
  const pendingOrdinary = beginPreviewStart("runtime");
  beginDriving("runtime", ordinaryRecord.gen!);
  try {
    for (const previous of ["done", "paused", "failed", "canceled"] as const) {
      await db.update(tasks).set({ status: previous }).where(eq(tasks.id, "runtime"));
      await setTaskStatus("runtime", "running");
      const continuedOrdinary = await okJson(await request("runtime/service", "POST", { command: "node ./service.cjs" }, agentHeaders));
      assert.equal(continuedOrdinary.reused, true);
      assert.equal(continuedOrdinary.service.gen, ordinaryRecord.gen);
      assert.equal(readAnyPreview("runtime")?.gen, ordinaryRecord.gen);
      assert.equal(readAnyPreview("runtime")?.url, ordinaryRecord.url);
      assert.equal(alive(ordinaryRecord.pid), true);
      assert.equal(taskBrowserState("runtime")?.id, ordinaryBrowser);
      assert.match((await action({ action: "snapshot", id: ordinaryBrowser })).text, /已保存：续聊后保留/);
      assert.equal((await fetch(ordinaryRecord.url!)).status, 200);
    }
    assert.equal(previewStartCanceled(pendingOrdinary), true);
    assert.equal(previewStartCanceled(ordinaryRecord.gen!), false);
  } finally {
    endPreviewStart("runtime", pendingOrdinary);
    endPreviewStart("runtime", ordinaryRecord.gen!);
  }
  const { state: _state, ...legacyRecord } = ordinaryRecord;
  writeFileSync(join(root, "runs", "runtime", "preview.json"), JSON.stringify(legacyRecord));
  await stopPreviewOnRerun("runtime");
  assert.equal((await startDevelopmentService("runtime", { command: "node ./service.cjs" }, async () => {})).reused, true);
  assert.equal(alive(ordinaryRecord.pid), true);
  assert.equal(readAnyPreview("runtime")?.gen, ordinaryRecord.gen);
  assert.equal((await stopPreviewAtAccept("runtime")).stopped, true);
  assert.equal(readAnyPreview("runtime"), null);
  assert.equal(alive(ordinaryRecord.pid), false);
  assert.equal(taskBrowserState("runtime")?.status, "closed");
  console.log("PASS task runtime: service ownership/reuse/replacement, continuation and cold-start lifetimes, watch-only open/reconnect, takeover, persistent frames, ordinary preview continuation and acceptance cleanup");
} finally {
  await uiBrowser?.close();
  await web?.close();
  await closeTaskBrowser("runtime");
  await stopPreview("runtime", null);
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
