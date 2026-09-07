import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "ash-chat-browser-"));
console.log(`Chat screenshots: ${output}`);
const fixture = spawn(process.execPath, ["--import", "tsx", "server/scripts/chat-browser-fixture.ts"], {
  cwd: root, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
let server;
let page;
let releaseUpload = () => {};
let fixtureLogs = "";
fixture.stderr.on("data", (chunk) => { fixtureLogs += chunk.toString(); });
try {
  const fixtureUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup timed out: ${fixtureLogs}`)), 20000);
    fixture.once("exit", (code) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${fixtureLogs}`)); });
    fixture.stdout.on("data", (chunk) => {
      const match = chunk.toString().match(/Chat browser fixture: (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  server = await createServer({ root: `${root}/web`, logLevel: "error", server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixtureUrl, changeOrigin: true } } } });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch({ ...await chromeLaunchOptions(), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/?project=chat-demo&view=chat`);
  await page.getByRole("heading", { name: "创建一个聊天空间" }).waitFor();
  await page.getByLabel("群聊名称", { exact: true }).fill("产品研发");
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  assert.equal(await page.getByLabel("点名名称", { exact: true }).count(), 2);
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  assert.deepEqual(await page.getByLabel("点名名称", { exact: true }).evaluateAll((inputs) => inputs.map((input) => input.value)), ["codex", "claude", "grok"]);
  await page.getByText("所有已注册智能体均可参与", { exact: false }).waitFor();
  await page.screenshot({ path: `${output}/chat-members.png`, animations: "disabled" });
  await page.getByRole("button", { name: "创建群聊", exact: true }).click();
  const input = page.getByLabel("群聊消息输入");
  await input.waitFor();
  const send = async (body) => {
    await input.fill(body);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText(body, { exact: true }).waitFor();
  };
  await send("先记下来：频道导航要清晰，任务进度留在对话里。");
  assert.equal(await page.locator(".chat-message:not(.is-user)").count(), 0);
  await input.fill("@co");
  await page.getByRole("listbox", { name: "点名成员" }).waitFor();
  await input.press("Enter");
  assert.equal(await input.inputValue(), "@codex ");
  await send("请@codex看看：你建议先做什么？");
  await page.getByText("建议先跑通点名唤醒，再连接任务状态。", { exact: false }).waitFor();
  assert.equal(await page.locator(".chat-message:not(.is-user)").count(), 1);
  assert.equal(await page.locator(".chat-task-card").count(), 0);
  await send("@claude 给一句设计建议。");
  await page.getByText("建议保留清晰的频道导航，把任务进度嵌入消息流。", { exact: false }).waitFor();
  await send("@grok 给一句建议。");
  await page.getByText("建议先确认用户需求，再查看当前项目。", { exact: false }).waitFor();
  assert.equal(await page.locator(".chat-message:not(.is-user)").count(), 3);
  assert.equal(await page.locator(".chat-task-card").count(), 0);
  for (const [scenario, path] of [["越界验证", "unexpected-side-effect.txt"], ["依赖越界验证", "node_modules"]]) {
    await send(`@codex 你建议怎么改？${scenario}`);
    const boundary = page.locator(".chat-message.is-failed").filter({ hasText: path });
    await boundary.getByText("咨询已中止", { exact: false }).waitFor();
    assert.equal(await page.getByText("不应显示为正常咨询", { exact: true }).count(), 0);
    assert.equal(await page.locator(".chat-task-card").count(), 0);
    await page.reload();
    await boundary.getByText("未自动撤销改动", { exact: false }).waitFor();
  }
  await page.screenshot({ path: `${output}/chat-boundary.png`, animations: "disabled" });
  await send("@codex 请实现频道导航与任务状态卡。");
  await page.locator(".chat-task-card").getByText("运行中", { exact: false }).waitFor();
  await page.locator(".chat-task-card.is-done").waitFor();
  await page.locator(".chat-task-card").getByText("ASH 任务 · codex").waitFor();
  await page.screenshot({ path: `${output}/chat-desktop.png`, animations: "disabled" });
  await send("@codex 等待一下，我要测试停止。");
  await page.getByRole("button", { name: "停止回复", exact: true }).click();
  await page.getByText("你已停止这次回复。", { exact: false }).waitFor();
  await page.reload();
  await page.getByText("你已停止这次回复。", { exact: false }).waitFor();
  assert.equal(await page.locator(".chat-task-card.is-done").count(), 1);
  await page.locator(".chat-task-card").click();
  await page.getByText("浏览器测试产物：频道导航和任务状态已通过模拟流程验证。", { exact: false }).waitFor();
  assert.ok(page.url().includes("task="));
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await input.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator(".chat-shell").boundingBox();
  assert(bounds && bounds.width >= 370);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: `${output}/chat-mobile.png`, animations: "disabled" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".chat-message").first().evaluate((element) => getComputedStyle(element).animationName), "none");
  await page.getByRole("button", { name: "新建群聊", exact: true }).click();
  await page.getByLabel("群聊名称", { exact: true }).fill("另一个群");
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  await page.getByRole("button", { name: "创建群聊", exact: true }).click();
  await input.waitFor();
  assert.equal(await page.locator(".chat-message").count(), 0);
  await send("这个群的独立消息。");
  await page.getByRole("button", { name: "产品研发 3", exact: true }).click();
  await page.getByText("你已停止这次回复。", { exact: false }).waitFor();
  assert.equal(await page.getByText("这个群的独立消息。", { exact: true }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "单任务", exact: true }).click();
  const objective = page.locator(".composer-objective textarea");
  await objective.fill("切换聊天后，这份任务草稿仍然保留。");
  const modeTabs = page.getByRole("tablist", { name: "任务模式" });
  const chatTab = modeTabs.getByRole("tab", { name: "聊天", exact: true });
  assert.equal(await objective.count(), 1, "合并后只保留新版目标输入框");
  assert.equal(await page.locator(".studio-card").count(), 1);
  assert.equal(await modeTabs.count(), 1, "聊天与任务模式共用新版内联模式栏");
  assert.equal(await modeTabs.getByRole("tab").count(), 4);
  for (const name of ["团队", "讨论", "单任务"]) {
    await modeTabs.getByRole("tab", { name, exact: true }).click();
    assert.equal(await objective.inputValue(), "切换聊天后，这份任务草稿仍然保留。");
    assert.equal(await chatTab.isVisible(), true, `${name} 模式保留聊天入口`);
  }
  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  for (const width of [320, 390, 700, 900, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const tabBounds = await modeTabs.boundingBox();
    assert(tabBounds && tabBounds.x >= 0 && tabBounds.x + tabBounds.width <= width, `${width}px 侧栏收起时模式栏不越界`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  }
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  await page.route("**/api/uploads", async (route) => {
    await uploadGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      id: "merge-draft", name: "merge-draft.txt", path: "/tmp/uploads/merge-draft.txt", kind: "file",
    }) }).catch(() => {});
  });
  await page.locator(".studio-card input[type=file]").setInputFiles({
    name: "merge-draft.txt", mimeType: "text/plain", buffer: Buffer.from("合并兼容验证附件"),
  });
  await page.locator(".task-upload-chip.is-uploading").waitFor();
  assert.equal(await chatTab.isDisabled(), true, "上传期间不能切走聊天丢失在途附件");
  releaseUpload();
  await page.locator(".task-upload-chip.is-uploading").waitFor({ state: "detached" });
  assert.equal(await chatTab.isEnabled(), true);
  assert.equal(await page.locator(".task-upload-chip").count(), 1, "附件只展示一次");
  await page.screenshot({ path: `${output}/composer-chat-merged.png`, animations: "disabled" });
  await chatTab.click();
  await input.waitFor();
  await page.getByRole("button", { name: "单任务", exact: true }).click();
  assert.equal(await objective.inputValue(), "切换聊天后，这份任务草稿仍然保留。");
  await page.locator(".composer-seed-attachment").getByText("merge-draft.txt", { exact: true }).waitFor();
  assert.equal(await page.locator(".composer-seed-attachment").count(), 1, "聊天往返保留附件且不重复");
  assert.deepEqual(errors, []);
  console.log("chat browser passed: 创建群聊、三段成员选择、键盘点名、无点名静默、禁止转发唤醒、实际模拟源码及 node_modules 写入均被标记失败且刷新保留警告、不误建任务、任务卡实时状态、停止持久化、详情回跳、390px 窄屏、减少动态效果、群间隔离、新编辑器四模式入口、320–1440px 模式栏、上传切换门禁、跨模式任务草稿与附件保留；无页面异常。");
} catch (error) {
  await page?.screenshot({ path: `${output}/chat-failure.png` }).catch(() => {});
  throw error;
} finally {
  releaseUpload();
  await browser?.close();
  await server?.close();
  fixture.kill("SIGTERM");
  if (fixture.exitCode === null && fixture.signalCode === null) await new Promise((resolve) => fixture.once("exit", resolve));
}
