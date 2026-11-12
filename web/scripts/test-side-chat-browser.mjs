import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { launchChrome } from "./dom-stage.mjs";
import { resizeViewport } from "./wait-until.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = spawn(process.execPath, ["--import", "tsx", "server/scripts/side-chat-browser-fixture.ts"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
let browser;
let server;
const artifacts = await mkdtemp(join(tmpdir(), "ash-side-chat-browser-"));
try {
  const backend = await new Promise((resolve, reject) => {
    // 这是启动期限，不是睡眠：读到 SIDE_FIXTURE_URL 当场清掉，只有夹具 20 秒都起不来才报错。
    const timer = setTimeout(() => reject(new Error(`fixture startup timeout: ${logs}`)), 20000);
    const consume = (chunk) => { logs += chunk; const match = logs.match(/SIDE_FIXTURE_URL=(http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } };
    fixture.stdout.on("data", consume); fixture.stderr.on("data", consume);
    fixture.once("exit", (code) => { clearTimeout(timer); reject(new Error(`fixture exit ${code}: ${logs}`)); });
  });
  server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: backend } } } });
  await server.listen();
  const address = server.httpServer.address();
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/side-chat.html`;
  const control = (path, body) => page.request.post(`${backend}/api/fixture/${path}`, { data: body });
  const state = async () => await (await page.request.get(`${backend}/api/fixture/state`)).json();
  const roomsFor = async (taskId) => await (await page.request.get(`${backend}/api/tasks/${taskId}/side-chats`)).json();
  await page.goto(url);
  await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  const input = page.getByRole("textbox", { name: "侧聊消息输入" });
  const send = page.getByRole("button", { name: "发送侧聊消息" });
  // 换一场走面板头那颗钟：点开是一场一行的列表；当前是哪一场看面板上的 data-room-id（新的一场是空串）。
  const currentRoom = async () => await page.locator(".side-chat-pane").getAttribute("data-room-id");
  const waitRoom = (roomId) => page.waitForFunction((id) => document.querySelector(".side-chat-pane")?.dataset.roomId === id, roomId);
  const pickRoom = async (roomId) => {
    await page.getByRole("button", { name: "换一场侧聊", exact: true }).click();
    await page.getByRole("listbox", { name: "切换侧聊" }).locator(`[data-room-id="${roomId}"]`).click();
    await waitRoom(roomId);
  };
  await input.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "侧聊消息输入");
  assert.equal((await roomsFor("parent")).length, 0, "只打开侧聊不创建房间");
  assert.equal(await page.getByRole("button", { name: "开始侧聊", exact: true }).count(), 0);
  assert.equal(await page.getByText("这里聊，不打断思路", { exact: true }).count(), 0);
  // 说明不常驻：那段话拆进了快照那一行和发送键的悬停提示里，头带上不再有 ⓘ。
  assert.equal(await page.getByRole("button", { name: "侧聊说明", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "换一场侧聊", exact: true }).count(), 0, "还没聊过别的场，就没有那颗钟");
  assert.equal(await page.getByRole("log", { name: "侧聊消息" }).innerText(), "");
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
  // 说完之后过程折起来待在正文上方，条上按主会话那套词说（只有一步时直接说那一步）。
  assert.match(await page.locator(".side-chat-message.is-agent").last().innerText(), /跑了 git log --oneline \| head/);
  assert.equal((await state()).delivered.length, 0);
  const firstRoom = await currentRoom();
  assert.match(await page.locator(".side-chat-snap").innerText(), /^主会话快照 \d\d\/\d\d \d\d:\d\d$/, "第一行说清带着的是主会话哪一刻");
  // 你的话靠右、它的话靠左，都不报名字。
  assert.equal(await page.locator(".side-chat-message header").count(), 0, "不再报「你 / 侧聊助手」");
  // 指到一条答完的回答才出复制和发给主任务；点了就把原文交给主任务。
  const plain = page.locator(".side-chat-message.is-agent").last();
  const forwardKey = plain.getByRole("button", { name: "发给主任务", exact: true });
  assert.equal(await forwardKey.evaluate((element) => getComputedStyle(element.parentElement).opacity), "0", "两颗键平时藏着");
  await plain.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelectorAll(".side-chat-message.is-agent .side-chat-ans__acts")[document.querySelectorAll(".side-chat-message.is-agent .side-chat-ans__acts").length - 1]).opacity === "1");
  await plain.getByRole("button", { name: "复制", exact: true }).waitFor();
  const deliveredBeforeButton = (await state()).delivered.length;
  await forwardKey.click();
  await plain.getByText("已送达主任务", { exact: true }).waitFor();
  assert.equal((await state()).delivered.length, deliveredBeforeButton + 1, "点「发给主任务」就投递");
  assert.equal(await plain.getByRole("button", { name: "发给主任务", exact: true }).count(), 0, "送到了就不再给那颗键");
  await page.getByRole("button", { name: "切换主任务状态" }).click();
  assert.equal(await input.count(), 1, "主任务状态变化不抢走侧聊焦点");
  await input.fill("把结论告诉主任务，以后都按这个来"); await send.click();
  await page.locator(".side-chat-message.is-agent").last().getByText("已送达主任务", { exact: true }).waitFor();
  assert.equal((await state()).delivered.length, 2);
  assert.equal((await state()).kills, 0);
  // 发出去的原文在回执的悬停提示里。
  await page.locator(".side-chat-receipt.is-sent > span").last().hover();
  assert.match(await page.getByRole("tooltip").innerText(), /来自侧聊.*方案 B/s);
  await page.screenshot({ path: join(artifacts, "side-chat-desktop.png") });
  await input.fill("草稿也保留");
  await page.getByRole("button", { name: "关闭侧聊", exact: true }).click();
  await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  await input.waitFor();
  await waitRoom(firstRoom);
  assert.equal(await input.inputValue(), "草稿也保留");
  await page.getByText("已送达主任务", { exact: true }).first().waitFor();
  await page.reload();
  await input.waitFor();
  await waitRoom(firstRoom);
  assert.equal(await input.inputValue(), "草稿也保留");
  assert.equal(await currentRoom(), firstRoom);
  const analyzingPosition = await page.locator(".side-chat-message.is-agent").count();
  await input.fill("等待一下，做长分析"); await send.click();
  // 执行过程跟主会话一样：跑的中途就露在外面，展开能看见跑了什么命令。
  const analyzing = page.locator(".side-chat-message.is-agent").nth(analyzingPosition);
  await analyzing.locator(".task-execution-block").waitFor();
  await analyzing.locator(".task-execution-block > summary").click();
  await analyzing.getByText("git log --oneline | head", { exact: true }).waitFor();
  await analyzing.getByText("先确认主任务改了哪些文件", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "side-chat-execution-live.png") });
  await page.getByRole("button", { name: "停止侧聊", exact: true }).waitFor();
  await page.getByRole("button", { name: "停止侧聊", exact: true }).click();
  await page.getByText(/你已停止侧聊回复/).waitFor();
  await page.reload();
  await page.getByText(/你已停止侧聊回复/).waitFor();
  // 停下、刷新之后那段过程还在原地：刷新后仍看得出它停之前做了什么。
  const stopped = page.locator(".side-chat-message.is-agent").nth(analyzingPosition);
  await stopped.locator(".task-execution-block").waitFor();
  await stopped.locator(".task-execution-block > summary").click();
  await stopped.getByText("git log --oneline | head", { exact: true }).waitFor();
  assert.equal((await state()).kills, 0);
  await control("native", { enabled: false });
  await input.fill("「把结论告诉主任务」"); await send.click();
  await page.getByText("排着，主任务空下来就发", { exact: true }).waitFor();
  await control("cancel", {});
  await page.getByText("已撤回，没有发给主任务", { exact: true }).waitFor();
  assert.equal((await state()).delivered.length, 2);
  // 撤回过的可以再发：这回用「发给主任务」那颗键，主任务不收（native 关着）就排着，排着时能撤回。
  const revoked = page.locator(".side-chat-message.is-agent").last();
  await revoked.hover();
  await revoked.getByRole("button", { name: "发给主任务", exact: true }).click();
  await revoked.getByText("排着，主任务空下来就发", { exact: true }).waitFor();
  await revoked.getByRole("button", { name: "撤回", exact: true }).click();
  await revoked.getByText("已撤回，没有发给主任务", { exact: true }).waitFor();
  assert.equal((await state()).delivered.length, 2, "撤回的那条没有投递");
  const replyText = "回传结论：选择方案 B，复用现有消息队列，并补上投递回执。";
  for (const condition of ["把结论告诉主任务，如果它已经开始做了就算了", "不要把结论告诉主任务"]) {
    const last = await sendForReply(condition);
    await last.getByText(/未发送到主任务/).waitFor();
    assert.match(await last.innerText(), /回传结论：选择方案 B/);
    assert.equal((await state()).pending.length, 3, "拒绝回传不入队");
  }
  await control("archive", { archived: true });
  await input.fill("把结论告诉主任务"); await send.click();
  await page.getByText(/未发送到主任务：主任务已归档/).waitFor();
  await page.reload();
  await page.getByText(/未发送到主任务：主任务已归档/).waitFor();
  assert.match(await page.locator(".side-chat-message.is-agent").last().innerText(), new RegExp(replyText));
  assert.equal((await state()).pending.length, 3);
  await page.screenshot({ path: join(artifacts, "side-chat-reply-preserved.png") });
  await control("archive", { archived: false });
  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  await waitRoom("");
  await input.waitFor();
  assert.equal(await page.getByRole("log", { name: "侧聊消息" }).innerText(), "");
  assert.equal((await roomsFor("parent")).length, 1, "新建侧聊只切到新草稿，不提前建房");
  await input.fill("新侧聊草稿");
  await pickRoom(firstRoom);
  await page.getByText("已送达主任务", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  await waitRoom("");
  assert.equal(await input.inputValue(), "新侧聊草稿");
  await input.fill("新侧聊首问");
  await send.click();
  await page.locator(".side-chat-message.is-agent.is-done").last().waitFor();
  const secondRoom = await currentRoom();
  assert.notEqual(secondRoom, "");
  assert.equal((await roomsFor("parent")).length, 2);
  await input.fill("新侧聊草稿");
  await page.getByRole("button", { name: "切换主任务", exact: true }).click();
  await page.getByRole("button", { name: "打开侧聊", exact: true }).click();
  await input.waitFor();
  assert.equal((await roomsFor("other")).length, 0);
  assert.equal(await page.getByRole("log", { name: "侧聊消息" }).innerText(), "");
  await page.getByRole("button", { name: "切换主任务", exact: true }).click();
  await input.waitFor();
  await waitRoom(secondRoom);
  assert.equal(await input.inputValue(), "新侧聊草稿");
  // 列表里一场一行，名字是它的第一句话。
  await page.getByRole("button", { name: "换一场侧聊", exact: true }).click();
  assert.match(await page.getByRole("listbox", { name: "切换侧聊" }).innerText(), /新侧聊首问/);
  await page.keyboard.press("Escape");
  await pickRoom(firstRoom);
  await page.getByText("已送达主任务", { exact: true }).first().waitFor();
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
  await resizeViewport(page, { width: 390, height: 844 });
  const pane = await page.getByRole("region", { name: "任务侧聊", exact: true }).boundingBox();
  assert.ok(pane && pane.width > 250 && pane.x >= 0 && pane.x + pane.width <= 391);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(artifacts, "side-chat-mobile.png") });
  await input.fill("窄屏输入可见");
  await send.click();
  await page.getByText("窄屏输入可见", { exact: true }).waitFor();
  // 快照体积不再是门槛（用户 2026-09-21 指定：侧聊和主会话一样不设限）：几十万字的主任务
  // 背景照样建房、照样回复，不再在第一次发送时撞一句「超过上限」。
  await control("large-history", {});
  await page.getByRole("button", { name: "新建侧聊", exact: true }).click();
  await input.fill("长历史首次发送照常建房");
  const roomsBeforeLargeHistory = (await roomsFor("parent")).length;
  await send.click();
  await page.getByText("长历史首次发送照常建房", { exact: true }).waitFor();
  await page.locator(".side-chat-message.is-agent").last().getByText(/建议选择方案 B/).waitFor();
  assert.equal((await roomsFor("parent")).length, roomsBeforeLargeHistory + 1, "长历史照常建房");
  assert.equal(await input.inputValue(), "");
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`✓ 真实侧聊 API + headless Chrome：连续对话、执行过程实时/停止后留存、自然回传、回执、排队取消、停止/刷新、草稿/任务隔离、长历史照常建房、390px 通过\n截图：${artifacts}`);
} finally {
  await browser?.close(); await server?.close();
  if (fixture.exitCode === null) { fixture.kill("SIGTERM"); await once(fixture, "exit"); }
}
