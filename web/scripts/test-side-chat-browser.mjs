import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = spawn(process.execPath, ["--import", "tsx", "server/scripts/side-chat-browser-fixture.ts"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
let browser;
let server;
const artifacts = await mkdtemp(join(tmpdir(), "ash-side-chat-browser-"));
try {
  const backend = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup timeout: ${logs}`)), 20000);
    const consume = (chunk) => { logs += chunk; const match = logs.match(/SIDE_FIXTURE_URL=(http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } };
    fixture.stdout.on("data", consume); fixture.stderr.on("data", consume);
    fixture.once("exit", (code) => { clearTimeout(timer); reject(new Error(`fixture exit ${code}: ${logs}`)); });
  });
  server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: backend } } } });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/side-chat.html`;
  const control = (path, body) => page.request.post(`${backend}/api/fixture/${path}`, { data: body });
  const state = async () => await (await page.request.get(`${backend}/api/fixture/state`)).json();
  await page.goto(url);
  await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  await page.getByText(/主会话快照最多 64 KiB/).waitFor();
  await page.getByRole("button", { name: "开始侧聊", exact: true }).click();
  const input = page.getByRole("textbox", { name: "侧聊消息输入" });
  const send = page.getByRole("button", { name: "发送侧聊消息" });
  const sendForReply = async (body) => {
    const position = await page.locator(".side-chat-message.is-agent").count();
    await input.fill(body); await send.click();
    const reply = page.locator(".side-chat-message.is-agent").nth(position);
    await reply.waitFor();
    return reply;
  };
  await control("forward-mode", { forced: true });
  const rejected = [
    "把结论告诉主任务，哦不对，先不要", "把结论告诉主任务，等等，我再想想",
    "把结论告诉主任务，除非它已经开始做了", "发给主任务，不过要等我确认",
    "把结论告诉主任务，不过这条只是我随口说的", "告诉我主任务的结论",
    "告诉我主任务现在的结论是什么", "你之前不是已经把结论告诉主任务了吗",
    "上一轮我让你把结论告诉主任务了",
  ];
  for (const [index, command] of rejected.entries()) {
    const last = await sendForReply(command);
    await last.getByText(/未发送到主任务/).waitFor();
    assert.match(await last.innerText(), /方案 B/);
    assert.equal((await state()).delivered.length, 0, "撤回、条件、疑问和追述不触发 native steer");
    assert.equal((await state()).pending.length, 0, "不生成待发送消息");
    if (index === 0) await page.screenshot({ path: join(artifacts, "side-chat-retraction-blocked.png") });
  }
  await control("forward-mode", { forced: true, excerpt: true });
  const multiSentence = "把结论告诉主任务。\n等等，我再想想";
  const excerptReply = await sendForReply(multiSentence);
  await excerptReply.getByText(/未发送到主任务/).waitFor();
  await page.reload();
  await page.locator(".side-chat-message.is-agent").last().getByText(/未发送到主任务/).waitFor();
  assert.equal((await state()).delivered.length, 0);
  assert.equal((await state()).pending.length, 0);
  await control("forward-mode", {});
  await input.fill("比较方案 A 和 B"); await send.click();
  await page.locator(".side-chat-message.is-agent").last().getByText("建议选择方案 B。", { exact: true }).waitFor();
  assert.equal((await state()).delivered.length, 0);
  const firstRoom = await page.getByRole("combobox", { name: "切换侧聊" }).inputValue();
  await page.getByRole("button", { name: "切换主任务状态" }).click();
  assert.equal(await input.count(), 1, "主任务状态变化不抢走侧聊焦点");
  await input.fill("把结论告诉主任务，以后都按这个来"); await send.click();
  await page.getByText("已送达主任务", { exact: true }).waitFor();
  assert.equal((await state()).delivered.length, 1);
  assert.equal((await state()).kills, 0);
  await page.locator(".side-chat-receipt > summary").click();
  assert.match(await page.locator(".side-chat-receipt").innerText(), /来自侧聊.*方案 B/s);
  await page.screenshot({ path: join(artifacts, "side-chat-desktop.png") });
  await input.fill("草稿也保留");
  await page.getByRole("button", { name: "关闭侧聊", exact: true }).click();
  await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), "草稿也保留");
  await page.getByText("已送达主任务", { exact: true }).waitFor();
  await page.reload();
  await input.waitFor();
  assert.equal(await input.inputValue(), "草稿也保留");
  assert.equal(await page.getByRole("combobox", { name: "切换侧聊" }).inputValue(), firstRoom);
  await input.fill("等待一下，做长分析"); await send.click();
  await page.getByRole("button", { name: "停止侧聊", exact: true }).waitFor();
  await page.getByRole("button", { name: "停止侧聊", exact: true }).click();
  await page.getByText(/你已停止侧聊回复/).waitFor();
  await page.reload();
  await page.getByText(/你已停止侧聊回复/).waitFor();
  assert.equal((await state()).kills, 0);
  await control("native", { enabled: false });
  await input.fill("「把结论告诉主任务」"); await send.click();
  await page.getByText("已排队 · 主任务空闲后发送", { exact: true }).waitFor();
  await control("cancel", {});
  await page.getByText("未送达 · 已取消", { exact: true }).waitFor();
  assert.equal((await state()).delivered.length, 1);
  const replyText = "回传结论：选择方案 B，复用现有消息队列，并补上投递回执。";
  for (const condition of ["把结论告诉主任务，如果它已经开始做了就算了", "不要把结论告诉主任务"]) {
    const last = await sendForReply(condition);
    await last.getByText(/未发送到主任务/).waitFor();
    assert.match(await last.innerText(), /回传结论：选择方案 B/);
    assert.equal((await state()).pending.length, 2, "拒绝回传不入队");
  }
  await control("archive", { archived: true });
  await input.fill("把结论告诉主任务"); await send.click();
  await page.getByText(/未发送到主任务：主任务已归档/).waitFor();
  await page.reload();
  await page.getByText(/未发送到主任务：主任务已归档/).waitFor();
  assert.match(await page.locator(".side-chat-message.is-agent").last().innerText(), new RegExp(replyText));
  assert.equal((await state()).pending.length, 2);
  await page.screenshot({ path: join(artifacts, "side-chat-reply-preserved.png") });
  await control("archive", { archived: false });
  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  await page.waitForFunction((id) => document.querySelector('[aria-label="切换侧聊"]')?.value !== id, firstRoom);
  await input.waitFor();
  assert.equal(await page.getByRole("log", { name: "侧聊消息" }).innerText(), "");
  const secondRoom = await page.getByRole("combobox", { name: "切换侧聊" }).inputValue();
  await input.fill("新侧聊草稿");
  await page.getByRole("combobox", { name: "切换侧聊" }).selectOption(firstRoom);
  await page.getByText("已送达主任务", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "切换侧聊" }).selectOption(secondRoom);
  assert.equal(await input.inputValue(), "新侧聊草稿");
  await page.getByRole("button", { name: "切换主任务", exact: true }).click();
  await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  await page.getByRole("button", { name: "开始侧聊", exact: true }).waitFor();
  assert.equal(await page.getByRole("log", { name: "侧聊消息" }).count(), 0);
  await page.getByRole("button", { name: "切换主任务", exact: true }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), "新侧聊草稿");
  await page.getByRole("combobox", { name: "切换侧聊" }).selectOption(firstRoom);
  await page.getByText("已送达主任务", { exact: true }).waitFor();
  await control("native", { enabled: true });
  await control("forward-mode", { forced: true });
  const beforeNatural = await state();
  const natural = [
    "你把结论告诉主任务", "麻烦你把结论发给主任务",
    "方案 B 更省事。把结论告诉主任务，谢谢",
    "把结论告诉主任务，不过要说清楚理由",
    "把结论发给主任务和我", "把结论告诉“主任务”",
    "让主任务知道我们选 B", "Send the conclusion to the main task now", "Tell the main task we picked B",
  ];
  for (const [index, command] of natural.entries()) {
    const reply = await sendForReply(command);
    await reply.getByText("已送达主任务", { exact: true }).waitFor();
    assert.equal((await state()).delivered.length, beforeNatural.delivered.length + index + 1, command);
    assert.equal(await reply.getByText(/未发送到主任务/).count(), 0);
    if (index === 0) await page.screenshot({ path: join(artifacts, "side-chat-natural-delivered.png") });
  }
  const beforeDeferral = await state();
  for (const excerpt of [false, true]) {
    await control("forward-mode", { forced: true, excerpt });
    for (const suffix of ["改成明天再说", "用不着这么急", "先按兵不动", "继续观望", "让它忽略", "回头再发", "明天吧", "改成后天", "等会儿再说", "一会儿再说", "待会儿吧", "过两天再说", "先放着"]) {
      const reply = await sendForReply(`把结论告诉主任务，${suffix}`);
      await reply.getByText(/未发送到主任务/).waitFor();
      assert.match(await reply.innerText(), /回传结论：选择方案 B/);
      assert.equal((await state()).delivered.length, beforeDeferral.delivered.length, "延后指令不投递，即使只引用前半句");
      assert.equal((await state()).pending.length, beforeDeferral.pending.length, "延后指令不入队");
      assert.equal((await state()).judgedSources.at(-1), `把结论告诉主任务，${suffix}`);
    }
  }
  await control("forward-mode", { forced: true });
  for (const command of ["我不会告诉主任务", "不许告诉主任务", "犯不着告诉主任务", "所以你的意思是把结论告诉主任务", "你是说把结论告诉主任务", "Send the conclusion to the main task tomorrow"]) {
    const reply = await sendForReply(command);
    await reply.getByText(/未发送到主任务/).waitFor();
    assert.equal((await state()).delivered.length, beforeDeferral.delivered.length);
  }
  for (const mode of ["error", "invalid", "unclear"]) {
    await control("authorization-mode", { mode });
    const reply = await sendForReply("把结论告诉主任务");
    await reply.getByText(/未发送到主任务/).waitFor();
    assert.match(await reply.innerText(), /回传结论：选择方案 B/);
    assert.equal((await state()).delivered.length, beforeDeferral.delivered.length);
    assert.equal((await state()).pending.length, beforeDeferral.pending.length);
  }
  await control("authorization-mode", {});
  await page.reload();
  await page.locator(".side-chat-message.is-agent").last().getByText(/未发送到主任务/).waitFor();
  assert.equal(await page.getByText("已送达主任务", { exact: true }).count(), beforeDeferral.delivered.length);
  assert.equal((await state()).kills, 0);
  await page.screenshot({ path: join(artifacts, "side-chat-deferral-preserved.png") });
  await control("forward-mode", {});
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = await page.getByRole("region", { name: "任务侧聊", exact: true }).boundingBox();
  assert.ok(pane && pane.width > 250 && pane.x >= 0 && pane.x + pane.width <= 391);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(artifacts, "side-chat-mobile.png") });
  await input.fill("窄屏输入可见");
  await send.click();
  await page.getByText("窄屏输入可见", { exact: true }).waitFor();
  await control("large-history", {});
  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  await page.getByText(/超过侧聊的 64 KiB 上限/).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "切换侧聊" }).inputValue(), firstRoom);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`✓ 真实侧聊 API + headless Chrome：连续对话、自然回传、回执、排队取消、停止/刷新、草稿/任务隔离、390px 通过\n截图：${artifacts}`);
} finally {
  await browser?.close(); await server?.close();
  if (fixture.exitCode === null) { fixture.kill("SIGTERM"); await once(fixture, "exit"); }
}
