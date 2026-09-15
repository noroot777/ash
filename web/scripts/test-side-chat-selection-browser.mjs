import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = spawn(process.execPath, ["--import", "tsx", "server/scripts/side-chat-browser-fixture.ts"], {
  cwd: workspace,
  stdio: ["ignore", "pipe", "pipe"],
});
const artifacts = await mkdtemp(join(tmpdir(), "ash-side-chat-selection-browser-"));
let logs = "";
let browser;
let server;

async function selectContents(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    const init = { bubbles: true, clientX: range.getBoundingClientRect().right, clientY: range.getBoundingClientRect().bottom };
    element.dispatchEvent(new PointerEvent("pointerup", init));
    element.dispatchEvent(new MouseEvent("mouseup", init));
  });
  return locator.page().evaluate(() => window.getSelection()?.toString() ?? "");
}

async function ensureSideChatOpen(page) {
  const pane = page.getByRole("region", { name: "任务侧聊", exact: true });
  if (!await pane.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  }
  await pane.waitFor();
  return pane;
}

try {
  const backend = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup timeout: ${logs}`)), 20_000);
    const consume = (chunk) => {
      logs += chunk;
      const match = logs.match(/SIDE_FIXTURE_URL=(http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    fixture.stdout.on("data", consume);
    fixture.stderr.on("data", consume);
    fixture.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exit ${code}: ${logs}`));
    });
  });
  server = await createServer({
    root: webRoot,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: backend } } },
  });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  let messageRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/chats\/[^/]+\/messages$/.test(request.url())) messageRequests += 1;
  });
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/side-chat.html`;
  const state = async () => await (await page.request.get(`${backend}/api/fixture/state`)).json();
  const roomsFor = async (taskId) => await (await page.request.get(`${backend}/api/tasks/${taskId}/side-chats`)).json();
  const ask = page.getByRole("button", { name: "在侧聊中提问", exact: true });
  const addToReply = page.getByRole("button", { name: "添加到对话", exact: true });
  const reply = page.getByRole("textbox", { name: "回复任务", exact: true });
  const quoted = (text) => text.replace(/\s+$/u, "").split("\n").map((line) => `> ${line}`).join("\n");
  const primary = page.locator("main .task-message--user p").filter({ hasText: "主任务正在实现方案 A，并记录验证结果。" });
  const secondary = page.locator(".task-message--agent .task-markdown p").first();

  await page.goto(url);
  await primary.waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await selectContents(page.getByTestId("non-conversation-label")), /主任务控制标签/);
  assert.equal(await ask.isVisible().catch(() => false), false, "会话外标签不能出现选文入口");
  await page.getByRole("textbox", { name: "主任务消息输入" }).evaluate((input) => {
    input.select();
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  assert.equal(await ask.isVisible().catch(() => false), false, "主输入选区不能出现选文入口");

  await selectContents(primary);
  await ask.waitFor();
  await addToReply.waitFor();
  const toolbarBox = await page.locator(".conversation-selection-action").boundingBox();
  assert.ok(toolbarBox && toolbarBox.x >= 0 && toolbarBox.x + toolbarBox.width <= 1280, "两颗按钮的浮条完整落在视口内");
  await page.screenshot({ path: join(artifacts, "selection-action.png") });
  await page.keyboard.press("Escape");
  await ask.waitFor({ state: "hidden" });
  await selectContents(primary);
  await ask.waitFor();
  await page.getByTestId("outside-target").click();
  await ask.waitFor({ state: "hidden" });

  // 选文送进主对话框:写进草稿、光标落到引用下面、既有草稿原样保留,且一路不碰侧聊。
  const replySelection = await selectContents(primary);
  await addToReply.waitFor();
  await addToReply.click();
  await addToReply.waitFor({ state: "hidden" });
  assert.equal(await reply.inputValue(), `${quoted(replySelection)}\n\n`, "引用按 Markdown 引用块写进对话框");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "回复任务");
  assert.equal(await reply.evaluate((element) => element.selectionStart === element.value.length), true, "光标落在引用下面那一行");
  assert.equal(await page.getByRole("region", { name: "主会话引用", exact: true }).count(), 0, "添加到对话不改动侧聊引用");
  await reply.fill("已经写了一半的回复");
  const replySecond = await selectContents(secondary);
  await addToReply.click();
  assert.equal(await reply.inputValue(), `已经写了一半的回复\n\n${quoted(replySecond)}\n\n`, "引用接在已有草稿后面,不覆盖");
  await page.screenshot({ path: join(artifacts, "selection-add-to-reply.png") });
  await reply.fill("");
  assert.equal((await roomsFor("parent")).length, 0, "添加到对话不建侧聊房间");

  const firstSelection = await selectContents(primary);
  assert.equal(firstSelection, "主任务正在实现方案 A，并记录验证结果。");
  await ask.waitFor();
  await page.keyboard.press("Tab");
  assert.equal(await addToReply.evaluate((element) => element === document.activeElement), true, "Tab 先落在浮条第一颗按钮");
  await page.keyboard.press("Tab");
  assert.equal(await ask.evaluate((element) => element === document.activeElement), true, "再按 Tab 到侧聊入口");
  await page.keyboard.press("Enter");
  const reference = page.getByRole("region", { name: "主会话引用", exact: true });
  await reference.waitFor();
  assert.equal(await reference.locator("blockquote").innerText(), firstSelection);
  const input = page.getByRole("textbox", { name: "侧聊消息输入" });
  const send = page.getByRole("button", { name: "发送侧聊消息" });
  const roomPicker = page.getByRole("combobox", { name: "切换侧聊" });
  await input.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "侧聊消息输入");
  assert.equal((await roomsFor("parent")).length, 0, "选文打开侧聊不会提前建房");
  assert.equal(await page.getByRole("button", { name: "开始侧聊", exact: true }).count(), 0);
  assert.equal(await page.getByText("这里聊，不打断思路", { exact: true }).count(), 0);
  await page.getByRole("group", { name: "侧聊执行器", exact: true }).waitFor();
  assert.equal(await reference.evaluate((element) => element.nextElementSibling?.classList.contains("side-chat-input")), true, "引用紧邻输入框上方");
  await page.screenshot({ path: join(artifacts, "selection-first-config.png") });

  await page.reload();
  await ensureSideChatOpen(page);
  await reference.waitFor();
  assert.equal(await reference.locator("blockquote").innerText(), firstSelection, "首次建房前引用刷新后仍保留");
  await input.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "侧聊消息输入");
  assert.equal((await roomsFor("parent")).length, 0);
  assert.equal(await reference.locator("blockquote").innerText(), firstSelection);

  const firstQuestion = "这段进展还缺什么验证？";
  await input.fill(firstQuestion);
  const expectedBody = `【主会话选文，仅作参考】\n> ${firstSelection}\n\n【当前问题】\n${firstQuestion}`;
  const createPromise = page.waitForRequest((request) => request.method() === "POST" && /\/api\/tasks\/parent\/side-chats$/.test(request.url()));
  const requestPromise = page.waitForRequest((request) => request.method() === "POST" && /\/api\/chats\/[^/]+\/messages$/.test(request.url()));
  await send.click();
  await createPromise;
  const sentRequest = await requestPromise;
  assert.equal(sentRequest.postDataJSON().body, expectedBody, "引用与问题按约定格式发送");
  await page.locator(".side-chat-message.is-agent.is-done").last().waitFor();
  assert.equal(await reference.count(), 0, "发送成功后清理引用");
  assert.equal(await input.inputValue(), "");
  const firstRoom = await roomPicker.inputValue();
  assert.notEqual(firstRoom, "");
  assert.equal((await roomsFor("parent")).length, 1);
  assert.equal((await state()).delivered.length, 0, "选文提问不投递到主任务");
  await page.screenshot({ path: join(artifacts, "selection-sent.png") });

  await input.fill("已有侧聊草稿");
  const secondSelection = await selectContents(secondary);
  await ask.click();
  assert.equal(await input.inputValue(), "已有侧聊草稿", "带入引用不替换已有草稿");
  assert.equal(await reference.locator("blockquote").innerText(), secondSelection);
  await page.reload();
  await ensureSideChatOpen(page);
  await input.waitFor();
  assert.equal(await input.inputValue(), "已有侧聊草稿");
  assert.equal(await reference.locator("blockquote").innerText(), secondSelection, "房间引用刷新后仍保留");
  await page.screenshot({ path: join(artifacts, "selection-refresh-draft.png") });

  let failedPayload;
  await page.route("**/api/chats/*/messages", async (route) => {
    failedPayload = route.request().postDataJSON();
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "模拟发送失败" }) });
  }, { times: 1 });
  await send.click();
  await page.getByRole("alert").getByText(/模拟发送失败/).waitFor();
  assert.equal(await input.inputValue(), "已有侧聊草稿", "发送失败保留问题");
  assert.equal(await reference.locator("blockquote").innerText(), secondSelection, "发送失败保留引用");
  assert.equal(failedPayload.body, `【主会话选文，仅作参考】\n${secondSelection.split("\n").map((line) => `> ${line}`).join("\n")}\n\n【当前问题】\n已有侧聊草稿`, "引用的每一行都加引用标记");
  await page.unroute("**/api/chats/*/messages");

  let releaseRetry;
  let markRetrySeen;
  const retrySeen = new Promise((resolve) => { markRetrySeen = resolve; });
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  let retryPayload;
  await page.route("**/api/chats/*/messages", async (route) => {
    retryPayload = route.request().postDataJSON();
    markRetrySeen();
    await retryGate;
    await route.continue();
  }, { times: 1 });
  const doneBeforeRetry = await page.locator(".side-chat-message.is-agent.is-done").count();
  await send.click();
  await retrySeen;
  assert.equal(retryPayload.id, failedPayload.id, "失败后重试复用消息 ID，避免重复消息");
  assert.equal(retryPayload.body, failedPayload.body);
  await selectContents(primary);
  await ask.click();
  assert.equal(await reference.locator("blockquote").innerText(), firstSelection, "发送等待回执时允许暂存新选文");
  releaseRetry();
  await page.locator(".side-chat-message.is-agent.is-done").nth(doneBeforeRetry).waitFor();
  assert.equal(await reference.locator("blockquote").innerText(), firstSelection, "迟到的发送回执不能清掉新选文");
  await page.unroute("**/api/chats/*/messages");

  const codeSelection = await selectContents(page.locator(".task-message--agent pre code"));
  assert.equal(codeSelection.trim(), "const selected = true;");
  await ask.click();
  assert.equal((await reference.locator("blockquote").innerText()).trim(), "const selected = true;", "真实 ConversationFeed 的代码块可带入侧聊");
  await selectContents(secondary);
  await ask.click();
  assert.equal(await reference.locator("blockquote").innerText(), secondSelection, "新选文替换当前引用");
  await page.getByRole("button", { name: "移除主会话引用", exact: true }).click();
  assert.equal(await reference.count(), 0);

  await selectContents(page.getByText("侧聊说明", { exact: true }));
  assert.equal(await ask.isVisible().catch(() => false), false, "侧聊正文选区不能出现主会话选文入口");
  await selectContents(primary);
  await ask.waitFor();
  await page.keyboard.press("Escape");

  await page.getByText("展开超长选文测试", { exact: true }).click();
  const longSelection = await selectContents(page.getByTestId("selection-long"));
  assert.ok(longSelection.length > 8000);
  await ask.waitFor();
  await ask.click();
  assert.equal(await reference.locator("blockquote").innerText(), longSelection, "超长引用完整展示且不截断");
  await input.fill("请解释这段内容");
  await page.getByText(/8000/).first().waitFor();
  assert.equal(await send.isDisabled(), true, "引用加问题超过 8000 字时禁止发送");
  const requestsBeforeLimitEnter = messageRequests;
  const usersBeforeLimitEnter = await page.locator(".side-chat-message.is-user").count();
  await input.press("Enter");
  await page.waitForTimeout(100);
  assert.equal(messageRequests, requestsBeforeLimitEnter, "超限时 Enter 也不能绕过发送门禁");
  assert.equal(await page.locator(".side-chat-message.is-user").count(), usersBeforeLimitEnter);
  assert.equal(await reference.locator("blockquote").innerText(), longSelection);
  await page.getByText("展开超长选文测试", { exact: true }).click();

  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="切换侧聊"]')?.value === "");
  assert.equal(await reference.count(), 0, "新侧聊不继承旧房间的引用");
  await page.getByText("展开超长选文测试", { exact: true }).click();
  await selectContents(page.getByTestId("selection-long"));
  await ask.click();
  await input.fill("新草稿里的超长引用也不能发送");
  await input.press("Enter");
  await page.waitForTimeout(100);
  assert.equal((await roomsFor("parent")).length, 1, "超长引用门禁不能创建新房间");
  await page.getByRole("button", { name: "移除主会话引用", exact: true }).click();
  await page.getByText("展开超长选文测试", { exact: true }).click();
  await selectContents(primary);
  await ask.click();
  assert.equal(await reference.locator("blockquote").innerText(), firstSelection);
  await input.fill("新侧聊首问");
  await send.click();
  await page.locator(".side-chat-message.is-agent.is-done").last().waitFor();
  const secondRoom = await roomPicker.inputValue();
  assert.notEqual(secondRoom, "");
  await selectContents(primary);
  await ask.click();
  await roomPicker.selectOption(firstRoom);
  assert.equal(await reference.locator("blockquote").innerText(), longSelection, "切回旧侧聊恢复旧房间引用");
  assert.equal(await input.inputValue(), "请解释这段内容");
  await roomPicker.selectOption(secondRoom);
  assert.equal(await reference.locator("blockquote").innerText(), firstSelection, "新侧聊保留自己的引用");
  await roomPicker.selectOption(firstRoom);

  await page.getByRole("button", { name: "切换主任务", exact: true }).click();
  await ensureSideChatOpen(page);
  assert.equal(await reference.count(), 0, "另一主任务不能看到 parent 的引用");
  const otherSelection = await selectContents(page.getByTestId("selection-other"));
  assert.equal(otherSelection, "当前属于主任务 other 的会话内容。");
  await ask.click();
  assert.equal(await reference.locator("blockquote").innerText(), otherSelection);
  await page.getByRole("button", { name: "切换主任务", exact: true }).click();
  await ensureSideChatOpen(page);
  assert.equal(await reference.locator("blockquote").innerText(), longSelection, "切回 parent 恢复自己的引用");
  assert.equal((await state()).delivered.length, 0, "所有选文操作都不直接投递主任务");

  await page.setViewportSize({ width: 390, height: 844 });
  const pane = await page.getByRole("region", { name: "任务侧聊", exact: true }).boundingBox();
  assert.ok(pane && pane.width > 250 && pane.x >= 0 && pane.x + pane.width <= 391);
  const quoteBox = await reference.boundingBox();
  assert.ok(quoteBox && quoteBox.x >= pane.x && quoteBox.x + quoteBox.width <= pane.x + pane.width + 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(artifacts, "selection-long-mobile.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`✓ 主会话选文两条去处：添加到对话（草稿追加/光标/不建房）、进入侧聊的键盘入口、首次配置、引用持久化/替换/失败保留、草稿与房间/任务隔离、8000 字门禁、390px 通过\n截图：${artifacts}`);
} finally {
  await browser?.close();
  await server?.close();
  if (fixture.exitCode === null) {
    fixture.kill("SIGTERM");
    await once(fixture, "exit");
  }
}
