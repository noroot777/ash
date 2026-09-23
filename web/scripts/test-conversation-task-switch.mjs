// 切任务的那一下：上一个任务的正文还在 state 里，新任务的问答历史已经随任务快照到位。
// 修之前这两份东西会在同一帧里撞上——正文认不出任何一条记录，于是整段问答历史被当成
// 「还没出现过」补渲染出来，屏幕上闪过一列答复卡，正文读完又整批消失。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const turn = (text, at) => `${JSON.stringify({ t: "user", text, at })}`;
const outputs = {
  "task-a": `${turn("【答复】\na1的答案", "2026-09-10T02:00:00Z")}\n任务 A 的回复正文\n`,
  "task-b": `${turn("【答复】\nb1的答案", "2026-09-10T02:00:00Z")}\n任务 B 的回复正文\n`,
};
const session = (taskId) => ({
  id: `${taskId}-s1`, taskId, role: "single", agentType: "claude",
  startedAt: "2026-09-10T01:00:00Z", endedAt: "2026-09-10T02:10:00Z",
});

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
let releaseB;
const held = new Promise((resolve) => { releaseB = resolve; });
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.addInitScript(() => {
    window.EventSource = class { constructor() { this.closed = false; } close() { this.closed = true; } };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const sessions = /^\/api\/tasks\/([^/]+)\/sessions$/.exec(path);
    if (sessions) {
      // 任务 B 的正文卡住不放：切过去之后那段「还没读到」的状态会一直摆在那，
      // 中间态就能稳稳地断言，而不用去赌某一帧。
      if (sessions[1] === "task-b") await held;
      await route.fulfill({ json: [session(sessions[1])] });
      return;
    }
    const output = /^\/api\/sessions\/([^/]+)-s1\/output$/.exec(path);
    if (output) return route.fulfill({ body: outputs[output[1]] ?? "" });
    if (/^\/api\/sessions\/[^/]+\/trace$/.test(path)) return route.fulfill({ json: [] });
    failures.push(`unexpected API request: ${path}`);
    await route.fulfill({ status: 500, json: { error: "unexpected request" } });
  });
  await page.goto(`${origin}/scripts/fixtures/conversation-task-switch.html`);

  const cards = () => page.locator(".task-question-record");
  await page.waitForFunction(() => document.querySelectorAll(".task-question-record").length === 1);
  assert.match(await page.locator(".task-conversation").innerText(), /任务 A 的回复正文/);

  // 切换过程中每一次 DOM 变动都记一笔：闪一下也算数。
  await page.evaluate(() => {
    window.__flash = { cards: 0, texts: [] };
    const sample = () => {
      // 只认切过去之后的帧：切换前那张卡是任务 A 自己的正文渲染出来的，不是抢跑。
      if (document.querySelector("nav output")?.textContent !== "task-b") return;
      const feed = document.querySelector(".task-conversation");
      window.__flash.cards = Math.max(window.__flash.cards, document.querySelectorAll(".task-question-record").length);
      if (feed) window.__flash.texts.push(feed.innerText);
    };
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole("button", { name: "切换任务" }).click();
  await page.waitForTimeout(200);
  assert.equal(await cards().count(), 0, "任务 B 的正文还没读到，它的问答历史不该先摆出来");
  const flash = await page.evaluate(() => window.__flash);
  assert.equal(flash.cards, 0, "切换过程中一帧都不该闪出答复卡");
  assert.equal(flash.texts.some((text) => text.includes("任务 A 的回复正文")), false, "切过去之后不该还留着上一个任务的正文");
  assert.equal(flash.texts.some((text) => text.includes("点击「运行」开始")), false, "会话只是还没读完，不是空会话");
  await page.getByText("正在读取会话…").waitFor();

  releaseB();
  await page.waitForFunction(() => document.querySelectorAll(".task-question-record").length === 2);
  const feed = await page.locator(".task-conversation").innerText();
  assert.match(feed, /任务 B 的回复正文/);
  assert.match(feed, /b1的答案/);
  assert.match(feed, /b2的答案/, "正文里没出现过的那条问答仍要补上");
  assert.doesNotMatch(feed, /a1的答案/);
  assert.deepEqual(failures, []);
  await page.close();
  console.log("conversation task switch: no question-card flash, no stale transcript, no false empty state");
} finally {
  releaseB?.();
  await browser?.close();
  await server.close();
}
