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
const artifacts = await mkdtemp(join(tmpdir(), "ash-side-chat-direct-browser-"));
let logs = "";
let browser;
let server;

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
  const createPayloads = [];
  const messagePayloads = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/tasks\/parent\/side-chats$/.test(request.url())) createPayloads.push(request.postDataJSON());
    if (request.method() === "POST" && /\/api\/chats\/[^/]+\/messages$/.test(request.url())) messagePayloads.push(request.postDataJSON());
  });
  const catalog = [{
    type: "codex",
    models: ["gpt-5.6-sol", "gpt-5.5"],
    defaultModel: "gpt-5.6-sol",
    source: "probe",
    probeSupported: true,
    available: true,
    probedAt: "2026-09-14T08:00:00.000Z",
    cliVersion: "fixture",
    error: null,
    skipped: null,
  }];
  await page.route("**/api/llm-providers", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/agents/models*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(catalog) }));
  const rooms = async () => await (await page.request.get(`${backend}/api/tasks/parent/side-chats`)).json();
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/side-chat.html`;

  await page.goto(url);
  await page.getByRole("tab", { name: /侧聊/ }).click();
  const pane = page.getByRole("region", { name: "任务侧聊", exact: true });
  const input = page.getByRole("textbox", { name: "侧聊消息输入" });
  const send = page.getByRole("button", { name: "发送侧聊消息" });
  const picker = page.getByRole("group", { name: "侧聊执行器", exact: true });
  const roomPicker = page.getByRole("combobox", { name: "切换侧聊" });
  await input.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "侧聊消息输入");
  assert.equal((await rooms()).length, 0);
  assert.equal(await roomPicker.count(), 0, "没有历史房间时不显示空下拉");
  assert.equal(await page.getByRole("log", { name: "侧聊消息" }).innerText(), "");
  assert.equal(await page.getByRole("button", { name: "开始侧聊", exact: true }).count(), 0);
  assert.equal(await page.getByText("这里聊，不打断思路", { exact: true }).count(), 0);
  const helpButton = page.getByRole("button", { name: "侧聊说明", exact: true });
  const helpPopover = page.getByRole("dialog", { name: "侧聊说明", exact: true });
  assert.equal(await helpPopover.count(), 0, "说明默认不占地方");
  await helpButton.click();
  await helpPopover.waitFor();
  assert.match(await helpPopover.innerText(), /Enter 发送/, "发送快捷键的说明并进 ⓘ");
  await page.screenshot({ path: join(artifacts, "side-chat-help-popover.png") });
  await page.getByTestId("outside-target").click();
  await helpPopover.waitFor({ state: "detached" });
  await picker.waitFor();
  assert.equal(await picker.evaluate((element) => !!element.closest(".side-chat-input")), true, "执行器胶囊在输入框里");
  const agentTrigger = picker.getByRole("button", { name: /智能体：/ });
  const modelTrigger = picker.getByRole("button", { name: /模型：/ });
  const effortTrigger = picker.getByRole("button", { name: /智能水平：/ });
  assert.match(await agentTrigger.getAttribute("aria-label") ?? "", /codex/);
  assert.match(await modelTrigger.getAttribute("aria-label") ?? "", /gpt-5\.6-sol/);
  assert.match(await effortTrigger.getAttribute("aria-label") ?? "", /high/);
  await page.screenshot({ path: join(artifacts, "side-chat-direct-empty.png") });

  await modelTrigger.click();
  await page.getByRole("option", { name: /^gpt-5\.5/ }).click();
  await page.getByRole("listbox", { name: "智能水平" }).waitFor();
  await page.getByRole("option", { name: /^medium/ }).click();
  assert.equal((await rooms()).length, 0, "修改新草稿执行器不创建房间");
  assert.equal(messagePayloads.length, 0, "打开、输入和改模型都不调用侧聊模型");
  assert.match(await modelTrigger.getAttribute("aria-label") ?? "", /gpt-5\.5/);
  assert.match(await effortTrigger.getAttribute("aria-label") ?? "", /medium/);

  const draft = "首次发送失败后必须完整保留";
  await input.fill(draft);
  await page.reload();
  if (!await pane.isVisible().catch(() => false)) await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), draft, "未建房草稿刷新后保留");
  assert.match(await modelTrigger.getAttribute("aria-label") ?? "", /gpt-5\.5/, "未建房执行器选择刷新后保留");

  let releaseCreateFailure;
  let markCreateSeen;
  const createSeen = new Promise((resolve) => { markCreateSeen = resolve; });
  const createFailureGate = new Promise((resolve) => { releaseCreateFailure = resolve; });
  await page.route("**/api/tasks/parent/side-chats", async (route) => {
    markCreateSeen();
    await createFailureGate;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "模拟创建失败" }) });
  }, { times: 1 });
  await input.press("Enter");
  await createSeen;
  await input.press("Enter");
  assert.equal(createPayloads.length, 1, "首个建房请求进行中时双击 Enter 不会并发创建");
  releaseCreateFailure();
  await page.getByRole("alert").getByText(/模拟创建失败/).waitFor();
  assert.equal(createPayloads.length, 1);
  assert.equal(messagePayloads.length, 0);
  assert.equal((await rooms()).length, 0);
  assert.equal(await input.inputValue(), draft);
  await page.unroute("**/api/tasks/parent/side-chats");

  await page.route("**/api/chats/*/messages", async (route) => {
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "模拟首次发送失败" }) });
  }, { times: 1 });
  await send.click();
  await page.getByRole("alert").getByText(/模拟首次发送失败/).waitFor();
  assert.equal(createPayloads.length, 2);
  assert.equal(createPayloads[0].id, createPayloads[1].id, "创建失败重试复用房间 ID");
  assert.deepEqual(createPayloads[1].member, {
    id: createPayloads[1].member.id,
    name: createPayloads[1].member.name,
    agentType: "codex",
    executorId: "side-codex",
    model: "gpt-5.5",
    reasoningEffort: "medium",
  });
  assert.equal((await rooms()).length, 1, "建房成功、消息失败时保留房间");
  assert.notEqual(await roomPicker.inputValue(), "");
  assert.equal(await roomPicker.evaluate((element) => !!element.closest(".inspector-host__panel-head")), true, "切换侧聊挂在面板头带上，不再单占一条工具栏");
  assert.equal(await input.inputValue(), draft);
  assert.equal(messagePayloads.length, 1);
  await page.unroute("**/api/chats/*/messages");

  const createCountBeforeRetry = createPayloads.length;
  const firstMessageId = messagePayloads[0].id;
  await send.click();
  await page.locator(".side-chat-message.is-agent.is-done").last().waitFor();
  assert.equal(createPayloads.length, createCountBeforeRetry, "消息重试不重复建房");
  assert.equal(messagePayloads.at(-1).id, firstMessageId, "消息失败重试复用消息 ID");
  assert.equal(await input.inputValue(), "");

  await input.fill("明确保存新模型后再发送");
  const savedModel = await modelTrigger.getAttribute("aria-label");
  await page.route(/\/api\/chats\/[^/]+$/, async (route) => {
    assert.equal(route.request().method(), "PATCH");
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "模拟更换失败" }) });
  }, { times: 1 });
  await modelTrigger.click();
  await page.getByRole("option", { name: /^gpt-5\.6-sol/ }).click();
  await page.getByRole("alert").getByText(/模拟更换失败/).waitFor();
  assert.equal(await modelTrigger.getAttribute("aria-label"), savedModel, "更换失败不能冒充已生效");
  assert.equal(await send.isDisabled(), true, "执行器状态不明确时禁止发送");
  assert.equal(await input.inputValue(), "明确保存新模型后再发送");

  await page.unroute(/\/api\/chats\/[^/]+$/);
  const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && /\/api\/chats\/[^/]+$/.test(response.url()));
  await modelTrigger.click();
  await page.getByRole("option", { name: /^gpt-5\.6-sol/ }).click();
  const saved = await saveResponse;
  assert.equal(saved.status(), 200);
  assert.equal(saved.request().postDataJSON().members[0].model, "gpt-5.6-sol");
  await page.waitForFunction(() => document.querySelector('[aria-label^="模型："]')?.getAttribute("aria-label")?.includes("gpt-5.6-sol"));
  assert.equal(await send.isEnabled(), true);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(artifacts, "side-chat-direct-configured.png") });

  const roomCount = (await rooms()).length;
  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  assert.equal(await roomPicker.inputValue(), "");
  assert.equal(await page.getByRole("log", { name: "侧聊消息" }).innerText(), "");
  await input.fill("尚未提交的新侧聊草稿");
  assert.equal((await rooms()).length, roomCount, "新建按钮和输入不会创建房间");
  await page.reload();
  await input.waitFor();
  assert.equal(await roomPicker.inputValue(), "");
  assert.equal(await input.inputValue(), "尚未提交的新侧聊草稿");

  await page.setViewportSize({ width: 390, height: 844 });
  const paneBox = await pane.boundingBox();
  assert.ok(paneBox && paneBox.width > 250 && paneBox.x >= 0 && paneBox.x + paneBox.width <= 391);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(artifacts, "side-chat-direct-mobile.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`✓ 侧聊直接提问：即时输入、延迟建房、双 Enter、建房/发送失败恢复、执行器继承与保存门禁、任务草稿、390px 通过\n截图：${artifacts}`);
} finally {
  await browser?.close();
  await server?.close();
  if (fixture.exitCode === null) {
    fixture.kill("SIGTERM");
    await once(fixture, "exit");
  }
}
