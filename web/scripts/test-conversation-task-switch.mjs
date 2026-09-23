// 切任务的那一下：上一个任务的正文还在 state 里，新任务的问答历史已经随任务快照到位。
// 修之前这两份东西会在同一帧里撞上——正文认不出任何一条记录，于是整段问答历史被当成
// 「还没出现过」补渲染出来，屏幕上闪过一列答复卡，正文读完又整批消失。
//
// 另外两条同源的路，第 1 轮审查逮到的，一并钉在这里：
// - 直播事件顺手补的那发 sessions 没有代号守卫，切走后才回来会盖掉新任务的会话；
// - 正文读失败时如果也算「读完了」，问答卡照样铺满一屏——那正是要消除的形态。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

// 会话 .md 里每条回合行的前导分隔符（0x1e），前端按它切出 user/system 段。
const RS = String.fromCharCode(30);
const turn = (text, at) => `${RS}${JSON.stringify({ t: "user", text, at })}`;
const outputs = {
  "task-a": `${turn("【答复】\na1的答案", "2026-09-10T02:00:00Z")}\n任务 A 的回复正文\n`,
  "task-b": `${turn("【答复】\nb1的答案", "2026-09-10T02:00:00Z")}\n任务 B 的回复正文\n`,
  "task-a-s2": "任务 A 第二条会话的正文\n",
};
const session = (id, taskId, startedAt = "2026-09-10T01:00:00Z") => ({
  id, taskId, role: "single", agentType: "claude",
  startedAt, endedAt: "2026-09-10T02:10:00Z",
});
const outputFor = (sessionId) => outputs[sessionId] ?? outputs[sessionId.replace(/-(s\d+|late)$/, "")] ?? "";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
const pending = [];
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const failures = [];

  /** 开一页，路由交给调用方按段定制；默认行为是「两个任务都正常」。 */
  const open = async (handler) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => failures.push(error.message));
    await page.addInitScript(() => {
      window.__sources = [];
      window.EventSource = class {
        constructor(url) { this.url = url; this.closed = false; window.__sources.push(this); setTimeout(() => { if (!this.closed) this.onopen?.({}); }, 0); }
        close() { this.closed = true; }
      };
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (handler && await handler(route, path)) return;
      const sessions = /^\/api\/tasks\/([^/]+)\/sessions$/.exec(path);
      if (sessions) return route.fulfill({ json: [session(`${sessions[1]}-s1`, sessions[1])] });
      const output = /^\/api\/sessions\/([^/]+)\/output$/.exec(path);
      if (output) return route.fulfill({ body: outputFor(output[1]) });
      if (/^\/api\/sessions\/[^/]+\/trace$/.test(path)) return route.fulfill({ json: [] });
      failures.push(`unexpected API request: ${path}`);
      await route.fulfill({ status: 500, json: { error: "unexpected request" } });
    });
    await page.goto(`${origin}/scripts/fixtures/conversation-task-switch.html`);
    return page;
  };
  const sessionsOf = (page) => page.getByTestId("sessions").textContent();
  const readyOf = (page) => page.getByTestId("ready").textContent();

  // ── 正常切换：正文没到位之前，一张问答卡都不该出现 ──────────────────────
  {
    let releaseB;
    const held = new Promise((resolve) => { releaseB = resolve; });
    pending.push(() => releaseB());
    // 任务 B 的正文卡住不放：切过去之后那段「还没读到」的状态会一直摆在那，
    // 中间态就能稳稳地断言，而不用去赌某一帧。
    const page = await open(async (route, path) => {
      if (path === "/api/tasks/task-b/sessions") {
        await held;
        await route.fulfill({ json: [session("task-b-s1", "task-b")] });
        return true;
      }
      return false;
    });
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
    assert.equal(await page.locator(".task-question-record").count(), 0, "任务 B 的正文还没读到，它的问答历史不该先摆出来");
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
    await page.close();
  }

  // ── 直播事件补的那发 sessions：切走之后才回来，不许盖到当前任务上 ────────
  {
    let releaseLate;
    const late = new Promise((resolve) => { releaseLate = resolve; });
    pending.push(() => releaseLate());
    // 初次挂载那两发（StrictMode 会双跑）照常放过，稳定之后才开始拦——要拦的是
    // 直播事件补的那一发。
    let holdTaskA = false;
    let heldCalls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/sessions" || !holdTaskA) return false;
      heldCalls += 1;
      await late;
      await route.fulfill({ json: [session("task-a-late", "task-a")] });
      return true;
    });
    await page.waitForFunction(() => document.querySelector('[data-testid="sessions"]')?.textContent === "task-a-s1");
    holdTaskA = true;
    await page.evaluate(() => {
      for (const source of window.__sources.filter((item) => !item.closed)) {
        source.onmessage?.({ data: JSON.stringify({
          type: "conversation.turn", taskId: "task-a", sessionId: "task-a-s1",
          text: "刚说的一句", at: "2026-09-10T03:00:00Z",
        }) });
      }
    });
    // 等那一发真的出门，否则下面的切换会把它连同旧 token 一起甩在后面，什么都没测到。
    const deadline = Date.now() + 5000;
    while (heldCalls < 1 && Date.now() < deadline) await page.waitForTimeout(20);
    assert.equal(heldCalls, 1, "直播事件确实补发了一次 sessions（否则这一段什么都没测）");
    await page.getByRole("button", { name: "切换任务" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="sessions"]')?.textContent === "task-b-s1");
    assert.equal(await readyOf(page), "true/true");

    releaseLate();
    await page.waitForTimeout(300);
    assert.equal(await sessionsOf(page), "task-b-s1", "切走之后才回来的那发 sessions 不该盖到当前任务上");
    await page.close();
  }

  // ── 同一个任务里两个写者撞车：先发出的那份晚到，也不许盖掉已经写进去的新快照 ──
  {
    let releaseOutput;
    const heldOutput = new Promise((resolve) => { releaseOutput = resolve; });
    pending.push(() => releaseOutput());
    // warmup/reloading 期间给旧快照，live 之后才有新起的 s2。
    let phase = "warmup";
    let holdOutput = false;
    let sessionsCalls = 0;
    const page = await open(async (route, path) => {
      if (path === "/api/tasks/task-a/sessions") {
        sessionsCalls += 1;
        await route.fulfill({ json: phase === "live"
          ? [session("task-a-s1", "task-a"), session("task-a-s2", "task-a")]
          : [session("task-a-s1", "task-a")] });
        return true;
      }
      if (path === "/api/sessions/task-a-s1/output" && holdOutput) {
        await heldOutput;
        await route.fulfill({ body: outputFor("task-a-s1") });
        return true;
      }
      return false;
    });
    await page.waitForFunction(() => document.querySelector('[data-testid="sessions"]')?.textContent === "task-a-s1");

    // 全量重读先出门：它的 sessions 已经拿到旧快照，然后卡在正文上。
    holdOutput = true;
    const before = sessionsCalls;
    await page.getByRole("button", { name: "重读会话" }).click();
    const reloadDeadline = Date.now() + 5000;
    while (sessionsCalls <= before && Date.now() < reloadDeadline) await page.waitForTimeout(20);
    assert.ok(sessionsCalls > before, "重读确实发出了一发 sessions");

    // 这中间起了一条新会话，直播事件补刷把它写了进去。
    phase = "live";
    await page.evaluate(() => {
      for (const source of window.__sources.filter((item) => !item.closed)) {
        source.onmessage?.({ data: JSON.stringify({
          type: "agent.event", taskId: "task-a", event: { kind: "session", sessionId: "task-a-s2" },
        }) });
      }
    });
    await page.waitForFunction(() => document.querySelector('[data-testid="sessions"]')?.textContent === "task-a-s1,task-a-s2");

    releaseOutput();
    await page.waitForTimeout(300);
    assert.equal(
      await sessionsOf(page),
      "task-a-s1,task-a-s2",
      "重读发得更早、回得更晚，不许把已经写进去的新会话抹掉",
    );
    assert.equal(await readyOf(page), "true/true");
    await page.close();
  }

  // ── 到达顺序跟发起顺序相反：先发的那一发最后回来，带的却是**更新**的快照 ──
  // 连接池/代理会把请求打乱，客户端判不出谁的快照更新，所以这一段必须跟上一段同时成立。
  {
    let releaseReload;
    const heldReload = new Promise((resolve) => { releaseReload = resolve; });
    pending.push(() => releaseReload());
    let armed = false;
    let reloadHeld = false;
    let liveCalls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/sessions" || !armed) return false;
      if (!reloadHeld) {
        // 手动重读这一发先出门，却卡在连接层；放行时服务端那边已经有 s2 了。
        reloadHeld = true;
        await heldReload;
        await route.fulfill({ json: [
          session("task-a-s1", "task-a"),
          session("task-a-s2", "task-a", "2026-09-10T01:30:00Z"),
        ] });
        return true;
      }
      // 直播补刷后出门却先到，它读到的还是只有 s1 的旧快照。
      liveCalls += 1;
      await route.fulfill({ json: [session("task-a-s1", "task-a")] });
      return true;
    });
    await page.waitForFunction(() => document.querySelector('[data-testid="sessions"]')?.textContent === "task-a-s1");

    armed = true;
    await page.getByRole("button", { name: "重读会话" }).click();
    const heldDeadline = Date.now() + 5000;
    while (!reloadHeld && Date.now() < heldDeadline) await page.waitForTimeout(20);
    assert.ok(reloadHeld, "重读那一发已经出门并卡住");

    await page.evaluate(() => {
      for (const source of window.__sources.filter((item) => !item.closed)) {
        source.onmessage?.({ data: JSON.stringify({
          type: "agent.event", taskId: "task-a", event: { kind: "session", sessionId: "task-a-s1" },
        }) });
      }
    });
    const liveDeadline = Date.now() + 5000;
    while (liveCalls < 1 && Date.now() < liveDeadline) await page.waitForTimeout(20);
    await page.waitForTimeout(100);
    assert.equal(await sessionsOf(page), "task-a-s1", "旧快照先到，此刻确实还只有 s1");

    releaseReload();
    const settleDeadline = Date.now() + 3000;
    while (Date.now() < settleDeadline && await sessionsOf(page) !== "task-a-s1,task-a-s2") {
      await page.waitForTimeout(50);
    }
    assert.equal(
      await sessionsOf(page),
      "task-a-s1,task-a-s2",
      "先发后到的那一份带着新会话，不能因为「发得早」就判定它更旧",
    );
    assert.match(
      await page.locator(".task-conversation").innerText(),
      /任务 A 第二条会话的正文/,
      "正文读到了 s2，会话列表就不能只剩 s1——那是自相矛盾的 ready 状态",
    );
    assert.equal(await readyOf(page), "true/true");
    await page.close();
  }

  // ── 正文读失败：错误要显示，但问答历史不能又铺满一屏 ────────────────────
  for (const failing of ["sessions", "output"]) {
    let broken = true;
    const page = await open(async (route, path) => {
      if (failing === "sessions" && path === "/api/tasks/task-b/sessions" && broken) {
        await route.fulfill({ status: 500, json: { error: "会话列表暂时不可读" } });
        return true;
      }
      if (failing === "output" && path === "/api/sessions/task-b-s1/output" && broken) {
        await route.fulfill({ status: 503, body: "" });
        return true;
      }
      return false;
    });
    await page.waitForFunction(() => document.querySelectorAll(".task-question-record").length === 1);
    await page.getByRole("button", { name: "切换任务" }).click();
    // 等这一轮读取结束（失败也是结束），再看它有没有把问答历史铺出来。
    const failureNote = failing === "sessions" ? /会话列表暂时不可读|会话读取失败/ : /正文暂未读全/;
    await page.locator(".task-conversation-error").filter({ hasText: failureNote }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(
      await page.locator(".task-question-record").count(),
      0,
      `${failing} 读失败时正文对不上号，整段问答历史不能当成「没出现过」铺出来`,
    );
    assert.equal(await readyOf(page), "true/false", "读完了，但正文没读全");
    const shell = await page.locator(".task-conversation").innerText();
    assert.equal(/点击「运行」开始/.test(shell), false, "读失败不是空会话");

    // 重试成功之后照常补齐：这一条门禁只在正文缺失时生效，不是把补渲染永久关掉。
    broken = false;
    await page.getByRole("button", { name: "重读会话" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".task-question-record").length === 2);
    assert.equal(await readyOf(page), "true/true");
    await page.close();
  }

  assert.deepEqual(failures, []);
  console.log("conversation task switch: no card flash, no stale transcript/sessions, failed reads never refill the history");
} finally {
  pending.forEach((release) => release());
  await browser?.close();
  await server.close();
}
