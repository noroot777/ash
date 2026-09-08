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
    await page.locator(".chat-message.is-user .chat-message-body").getByText(body, { exact: true }).last().waitFor();
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
  const replies = page.locator(".chat-message:not(.is-user)");
  await input.fill("@al");
  await page.getByRole("listbox", { name: "点名成员" }).getByText("全体成员 · 3 位", { exact: true }).waitFor();
  await input.press("Enter");
  assert.equal(await input.inputValue(), "@all ");
  await page.getByText("将唤醒全部 3 位成员", { exact: true }).waitFor();
  await send("@all 请各给一句建议。");
  await page.waitForFunction(() => document.querySelectorAll(".chat-message:not(.is-user)").length === 6 && !document.querySelector(".chat-typing"));
  assert.equal(await replies.count(), 6, "@all 一次唤醒全部三位成员");
  await page.locator(".chat-message.is-user mark").filter({ hasText: "@all" }).last().waitFor();
  const settings = page.getByRole("button", { name: "群聊设置：产品研发" });
  await settings.click();
  const roomName = page.getByLabel("群聊名称", { exact: true });
  assert.equal(await roomName.inputValue(), "产品研发");
  await roomName.fill("产品研发 · 改名后");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("button", { name: "群聊设置：产品研发 · 改名后" }).waitFor();
  const channel = page.getByRole("button", { name: "产品研发 · 改名后 3", exact: true });
  await channel.waitFor();
  await page.reload();
  await channel.waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".chat-message:not(.is-user)").length === 6);
  await channel.click();
  assert.equal(await replies.count(), 6, "点已经选中的群仍留在这个群，不掉回空态");
  assert.equal(await page.locator(".chat-empty").count(), 0, "重复点选当前群不掉回空态");
  await input.waitFor();
  const jump = page.locator(".chat-jump");
  await page.waitForFunction(() => {
    const feed = document.querySelector(".chat-feed");
    return feed && feed.scrollHeight - feed.clientHeight > 120;
  });
  assert.equal(await jump.evaluate((el) => el.classList.contains("is-hidden")), true, "已经贴底时不显示「最新消息」");
  await page.locator(".chat-feed").evaluate((feed) => feed.scrollTo({ top: 0 }));
  await page.waitForFunction(() => !document.querySelector(".chat-jump")?.classList.contains("is-hidden"));
  assert.equal(await jump.isVisible(), true, "向上翻阅时才出现「最新消息」");
  await jump.click();
  await page.waitForFunction(() => {
    const feed = document.querySelector(".chat-feed");
    return feed && feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 2;
  });
  await page.waitForFunction(() => document.querySelector(".chat-jump")?.classList.contains("is-hidden"));
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
  await page.waitForFunction(() => document.querySelectorAll(".chat-message.is-running").length === 1);
  await page.getByRole("button", { name: "停止回复", exact: true }).click();
  const stoppedBody = "你已停止这次回复。再次 @ 才会继续；已创建的任务可在任务卡中管理。";
  await page.getByText(stoppedBody, { exact: true }).waitFor();
  await page.reload();
  await page.getByText(stoppedBody, { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-composer-area [role=status]").count(), 0, "短群没有发生过历史整理，停止回复不显示虚构的整理提示");
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
  await page.getByRole("button", { name: "产品研发 · 改名后 3", exact: true }).click();
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
  await chatTab.click();
  await input.waitFor();
  const currentRoomId = await page.evaluate(() => localStorage.getItem("ash:chat:chat-demo"));
  assert.ok(currentRoomId);
  await page.request.post(`${fixtureUrl}/api/fixture/chat-context/${currentRoomId}`, { data: { seed: true, mode: "hold" } });
  await send("@all 请讨论这些背景资料");
  await page.getByRole("status").filter({ hasText: "正在整理较早的群聊历史" }).waitFor();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "正在整理较早的群聊历史" }).waitFor();
  await page.getByRole("button", { name: "停止回复", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "你已停止历史整理" }).waitFor();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "你已停止历史整理" }).waitFor();
  await page.request.post(`${fixtureUrl}/api/fixture/chat-context/${currentRoomId}`, { data: { mode: "invalid" } });
  await send("@codex 再给一点建议");
  await page.getByRole("status").filter({ hasText: "历史整理失败" }).waitFor();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "原文已保留" }).waitFor();
  await page.screenshot({ path: `${output}/chat-context-failed.png`, animations: "disabled" });
  await page.getByRole("button", { name: "新建群聊", exact: true }).click();
  await page.getByLabel("群聊名称", { exact: true }).fill("摘要成功验证");
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  await page.getByRole("button", { name: "创建群聊", exact: true }).click();
  await input.waitFor();
  const summaryRoomId = await page.evaluate(() => localStorage.getItem("ash:chat:chat-demo"));
  await page.request.post(`${fixtureUrl}/api/fixture/chat-context/${summaryRoomId}`, { data: { seed: true, mode: "ok" } });
  await send("@codex 请给建议");
  await page.getByRole("status").filter({ hasText: "较早历史已整理为共享摘要" }).waitFor();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "近期消息保留原文" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: `${output}/chat-context-mobile.png`, animations: "disabled" });
  await send("/clear");
  await page.getByRole("status").filter({ hasText: "上下文已清空" }).waitFor();
  await page.locator(".chat-feed .chat-history-note").filter({ hasText: "之前的消息仍可查看" }).waitFor();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "上下文已清空" }).waitFor();
  assert.ok(await page.locator(".chat-message.is-user").filter({ hasText: "资料-0:" }).count(), "清空保留旧聊天消息");
  const beforeFreshReplies = await page.locator(".chat-message:not(.is-user)").count();
  await send("@codex 从新上下文开始");
  await page.waitForFunction((expected) => {
    const replies = [...document.querySelectorAll(".chat-message:not(.is-user)")];
    return replies.length === expected && replies.at(-1)?.classList.contains("is-done") && !document.querySelector(".chat-typing");
  }, beforeFreshReplies + 1);
  assert.equal(await page.getByRole("status").filter({ hasText: "较早历史已整理为共享摘要" }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: `${output}/chat-context-clear.png`, animations: "disabled" });
  console.log("chat clear browser passed: /clear 命令、持久分界提示、保留旧消息、后续新对话不恢复旧摘要。");
  console.log("chat context browser passed: 后台预压缩、停止和失败状态刷新可见、成功摘要持久化、390px 提示无横向溢出。");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "新建群聊", exact: true }).click();
  await page.getByLabel("群聊名称", { exact: true }).fill("停止整理回归");
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "添加成员", exact: true }).click();
  await page.getByRole("button", { name: "创建群聊", exact: true }).click();
  await input.waitFor();
  const stopRoomId = await page.evaluate(() => localStorage.getItem("ash:chat:chat-demo"));
  for (const clear of [false, true]) {
    await page.request.post(`${fixtureUrl}/api/fixture/chat-context/${stopRoomId}`, { data: { seed: true, count: 65, mode: "hold" } });
    await send(`@all 前台整理期间${clear ? "清空" : "停止"}`);
    await page.getByRole("status").filter({ hasText: "正在整理较早的群聊历史" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".chat-message.is-running").length === 3);
    if (clear) await send("/clear");
    else await page.getByRole("button", { name: "停止回复", exact: true }).click();
    await page.waitForFunction((count) => document.querySelectorAll(".chat-message.is-stopped").length === count, clear ? 6 : 3);
    await page.reload();
    await page.locator(".chat-message.is-stopped").first().waitFor();
    assert.deepEqual(await page.locator(".chat-message.is-stopped .chat-message-body").allTextContents(), Array(clear ? 6 : 3).fill(stoppedBody));
    const status = page.locator(".chat-composer-area [role=status]");
    if (clear) await status.filter({ hasText: "上下文已清空" }).waitFor();
    else {
      assert.equal(await status.textContent(), "你已停止历史整理；摘要和原文已保留，下次点名时按需继续。");
      await page.screenshot({ path: `${output}/chat-stop-compaction-after-reload.png`, animations: "disabled" });
      await send("/clear");
      await status.filter({ hasText: "上下文已清空" }).waitFor();
    }
    assert.equal(await page.getByText("This operation was aborted", { exact: false }).count(), 0);
  }
  await page.screenshot({ path: `${output}/chat-clear-compaction-after-reload.png`, animations: "disabled" });
  console.log("chat review browser passed: running 停止文案精确校验、短群无虚构整理状态、三成员前台整理时停止和 /clear 刷新后均无内部英文异常。");
  assert.deepEqual(errors, []);
  console.log("chat browser passed: 创建群聊、三段成员选择、键盘点名、@all 唤醒全体、群聊改名、重复点选当前群不掉空态、贴底时隐藏「最新消息」且点击真的回到底部、无点名静默、禁止转发唤醒、实际模拟源码及 node_modules 写入均被标记失败且刷新保留警告、不误建任务、任务卡实时状态、停止持久化、详情回跳、390px 窄屏、减少动态效果、群间隔离、新编辑器四模式入口、320–1440px 模式栏、上传切换门禁、跨模式任务草稿与附件保留；无页面异常。");
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
