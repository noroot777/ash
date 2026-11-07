import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { fetchLog, fetchesSettled, outlastPageTimers, settlePage, trackFetches, waitUntil, WAIT_TIMEOUT_MS } from "./wait-until.mjs";

const web = await startWebServer();
let browser;
const failures = [];
const pending = [];
const record = (id) => ({ id, question: `${id}的问题`, answer: `${id}的答案`, reply: `【答复】\n${id}的答案`, answeredAt: `2026-09-10T02:00:00Z` });
try {
  browser = await launchChrome();
  const origin = web.origin;
  const open = async (query, { autoOpen = true, clock = false, respond = async () => ({ json: [] }) } = {}) => {
    const page = await browser.newPage();
    // 条件等待的期限按满载给（门禁 8 路并行），真坏了也只是晚几秒报。
    page.setDefaultTimeout(WAIT_TIMEOUT_MS);
    page.on("pageerror", (error) => failures.push(error.message));
    const calls = [];
    await page.addInitScript(({ autoOpen }) => {
      window.__sources = [];
      window.EventSource = class {
        constructor(url) {
          this.url = url;
          this.closed = false;
          window.__sources.push(this);
          // 零延迟只是让 open 像真连接那样异步到达（订阅方先挂上 onopen），没有断言依赖它的时长。
          if (autoOpen) setTimeout(() => { if (!this.closed) this.onopen?.({}); }, 0);
        }
        close() { this.closed = true; }
      };
    }, { autoOpen });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      // 任务历史里的挡回记录:生产组件**无条件**读它(见 useRejectionNotices.ts),这一屏
      // 不验它,给一份空的就行 —— 不计进 calls,那一串是这一屏自己的请求账。
      if (path.endsWith("/notices")) {
        await route.fulfill({ json: { notices: [], remedy: null } });
        return;
      }
      calls.push(path);
      if (!path.endsWith("/question-history")) {
        failures.push(`unexpected API request: ${path}`);
        await route.fulfill({ status: 500, json: { error: "unexpected request" } });
        return;
      }
      await route.fulfill(await respond(path, calls.length));
    });
    await trackFetches(page, "/api/");
    if (clock) await page.clock.install();
    await page.goto(`${origin}/scripts/fixtures/question-history.html?${query}`);
    await page.getByRole("button", { name: "挂载切换" }).waitFor();
    return { page, calls };
  };
  const sse = (page, type, event) => page.evaluate(({ type, event }) => {
    for (const source of window.__sources.filter((item) => !item.closed)) {
      if (type === "message") source.onmessage?.({ data: JSON.stringify(event) });
      else source[type === "open" ? "onopen" : "onerror"]?.({});
    }
  }, { type, event });
  const answer = (page, receipt, taskId = "history-a") => sse(page, "message", {
    type: "task.question", taskId, question: null, questionOptions: null, questionItems: null,
    updatedAt: receipt.answeredAt, answeredQuestion: receipt,
  });
  const count = async (page, expected) => {
    await page.waitForFunction((value) => document.querySelectorAll(".task-question-record").length === value, expected);
  };
  const waitForCalls = async ({ calls }, expected) => {
    await waitUntil(() => calls.length >= expected, `桩收到第 ${expected} 发问答历史读取`);
    assert.equal(calls.length, expected);
  };
  /** 页面这一侧发出的问答历史读取（桩那一侧会晚到）。 */
  const historyFetches = async (page) => (await fetchLog(page)).filter((entry) => entry.url.includes("/question-history"));
  /**
   * 「只读一次」的正向信号：没连上时那条兜底读取排在 1 秒后（QuestionHistory.tsx），一个 1.1 秒
   * 后到期的页面定时器触发时它要发早就发了 —— 发了的话页面这一侧立刻记得到，不必等桩。
   */
  /**
   * 装了假时钟（`clock: true`）的页面：首发读取靠的是连上那两个零延迟定时器（桩的 open、
   * useCatchUpLink 的发车），都在假时钟上 —— 一毫秒一毫秒地推、每推一下冲刷一轮渲染，直到
   * 那一发到了桩上。推的总量只有几毫秒，追平层那条 5 秒后的重试不会被推到。
   */
  const kickFirstRead = ({ page, calls }) => waitUntil(async () => {
    await page.clock.runFor(1);
    await settlePage(page);
    return calls.length >= 1;
  }, "假时钟上推到首发问答历史读取到达桩");
  const outlastFallback = async (page) => {
    await outlastPageTimers(page, 1100);
    return (await historyFetches(page)).length;
  };

  for (const mode of ["feed", "team"]) for (const supplied of ["seed", "empty"]) {
    let saved = [];
    const { page, calls } = await open(`mode=${mode}&history=${supplied}&warm=1`, { respond: async () => ({ json: saved }) });
    await sse(page, "open");
    await page.getByRole("button", { name: "挂载切换" }).click();
    await count(page, supplied === "seed" ? 1 : 0);
    assert.equal(await outlastFallback(page), 1, "已有快照也只读一次轻量历史（页面这一侧）");
    await fetchesSettled(page, 0, "那一发问答历史已被页面读完");
    assert.deepEqual(calls, ["/api/tasks/history-a/question-history"], "已有快照也只读一次轻量历史，补齐可能过期的记录");
    const receipt = { ...record("live"), questionOptions: ["live的答案", "其他选项"], answers: ["live的答案"] };
    saved = [receipt];
    await answer(page, receipt);
    await answer(page, receipt);
    await count(page, supplied === "seed" ? 2 : 1);
    await page.getByRole("button", { name: "提供快照" }).click();
    await count(page, 2);
    assert.match(await page.locator("main").textContent(), /live的问题/);
    await page.getByRole("button", { name: "挂载切换" }).click();
    await count(page, 0);
    await page.getByRole("button", { name: "挂载切换" }).click();
    await count(page, 2);
    assert.equal(calls.length, 2, "重挂载后补齐旧快照遗漏的最新答复");
    await page.locator(".task-question-record").filter({ hasText: "live的问题" }).locator("summary").click();
    assert.equal(await page.getByText("live的问题", { exact: true }).isVisible(), true);
    assert.equal(await page.getByText("其他选项", { exact: true }).isVisible(), true, "回看仍有当时的完整选项");
    await page.close();
  }

  const first = await open("warm=1", { respond: async () => ({ json: [record("loaded")] }) });
  await sse(first.page, "open");
  await first.page.getByRole("button", { name: "挂载切换" }).click();
  await count(first.page, 1);
  assert.equal(await outlastFallback(first.page), 1, "已连接后挂载也只读取一次轻量历史（页面这一侧）");
  await fetchesSettled(first.page, 0, "那一发问答历史已被页面读完");
  assert.deepEqual(first.calls, ["/api/tasks/history-a/question-history"], "已连接后挂载也只读取一次轻量历史");
  await first.page.locator(".task-question-record summary").click();
  assert.equal(await first.page.getByText("loaded的问题", { exact: true }).isVisible(), true);
  await first.page.close();

  let release;
  let secondResponse = new Promise((resolve) => { release = resolve; });
  pending.push(() => release({ json: [] }));
  const reconnect = await open("", { respond: async (_path, n) => n === 1 ? { json: [record("old")] } : secondResponse });
  await count(reconnect.page, 1);
  // 第二发会被桩扣住，所以这里只数页面这一侧发了几发，不等它们落完。
  assert.equal(await outlastFallback(reconnect.page), 1, "挂载和初次 SSE 连接合成一次请求（页面这一侧）");
  assert.equal(reconnect.calls.length, 1, "挂载和初次 SSE 连接合成一次请求");
  await sse(reconnect.page, "error");
  await sse(reconnect.page, "open");
  await waitForCalls(reconnect, 2);
  await answer(reconnect.page, record("fresh"));
  release({ json: [record("old"), record("missed")] });
  await count(reconnect.page, 3);
  assert.equal(reconnect.calls.length, 2, "重连拉一次历史，补齐断线期间的答复");
  assert.match(await reconnect.page.locator("main").textContent(), /fresh的问题/);
  await reconnect.page.close();

  const fallback = await open("", { autoOpen: false, respond: async () => ({ json: [record("offline")] }) });
  await count(fallback.page, 1);
  assert.equal(fallback.calls.length, 1, "事件流不可用时仍能读取历史");
  await fallback.page.close();

  // 读失败之后追平层 5 秒后会自己重试一次：满载时这一段走得比 5 秒还慢，那一发就会抢在「点
  // 重试」之前把记录读回来、把计数多算一发。用假时钟把那条重试按住，这里只验「点了就读」。
  const retry = await open("", { clock: true, respond: async (_path, n) => n === 1 ? { status: 503, json: { error: "暂时不可用" } } : { json: [record("retried")] } });
  await kickFirstRead(retry);
  await retry.page.getByText("问答记录加载失败").waitFor();
  await retry.page.getByRole("button", { name: "重试", exact: true }).click();
  await count(retry.page, 1);
  assert.equal(await retry.page.getByText("问答记录加载失败").count(), 0);
  assert.equal(retry.calls.length, 2);
  await retry.page.close();

  // **主动取消不是读取失败**(本轮审查 N1)。断线会把在途那一发掐断(useCatchUpLink 的 cleanup),
  // 它的 rejection 一路冒上来曾被写成「问答记录加载失败」—— 那一刻压根没有任何读取失败,而且
  // 要等重连后的那一发成功才消得掉。
  //
  // **第二发也吊着**:这一条要验的是「错误压根没出现」,而一发成功的读取会把错误清掉 —— 第二发
  // 要是落了地,有 bug 的那一版也能擦干净自己,这条用例就白写了(实测:先让它落地,这条用例在
  // 没修的代码上照旧绿)。
  let releaseStale;
  let releaseSecond;
  const stalePending = new Promise((resolve) => { releaseStale = resolve; });
  const secondPending = new Promise((resolve) => { releaseSecond = resolve; });
  pending.push(() => { releaseStale({ json: [] }); releaseSecond({ json: [] }); });
  const cancelled = await open("", { respond: async (_path, n) => (n === 1 ? stalePending : secondPending) });
  await waitForCalls(cancelled, 1);
  await sse(cancelled.page, "error");
  await sse(cancelled.page, "open");
  await waitForCalls(cancelled, 2);
  // 掐断那一发的 rejection 是个微任务，第二发是 setTimeout(0) —— 读到第二发已经发车，就说明
  // 那个 rejection 早已处理完。这里再按事实确认一遍「第一发在页面上已经结算（被掐掉）」，
  // 然后冲刷 React 已排上的更新（它的非紧急更新走 MessageChannel）再读。
  await waitUntil(async () => (await historyFetches(cancelled.page))[0]?.state === "settled", "断线掐断的第一发在页面上已结算");
  await settlePage(cancelled.page);
  assert.equal(await cancelled.page.getByText("问答记录加载失败").count(), 0, "断线掐断在途那一发，不许显示成读取失败");
  releaseStale({ json: [record("stale-response")] });
  releaseSecond({ json: [record("reconnected")] });
  await count(cancelled.page, 1);
  assert.equal(await cancelled.page.getByText("问答记录加载失败").count(), 0, "被接替的那一发落地也不许留下失败提示");
  assert.match(await cancelled.page.locator("main").textContent(), /reconnected的问题/);
  assert.doesNotMatch(await cancelled.page.locator("main").textContent(), /stale-response/);
  await cancelled.page.close();

  for (const eventType of ["task.question", "task.updated"]) {
    // 同上：5 秒后那条自动重试会多读一发（还会再写一遍失败），这里验的是「实时事件本身就能
    // 恢复、不靠再读」，所以把重试按在假时钟上。
    const recovered = await open("", { clock: true, respond: async () => ({ status: 503, json: { error: "暂时不可用" } }) });
    await kickFirstRead(recovered);
    await recovered.page.getByText("问答记录加载失败").waitFor();
    await answer(recovered.page, record("other"), "another-task");
    assert.equal(await recovered.page.getByText("问答记录加载失败").count(), 1, "其他任务的事件不清除当前错误");
    if (eventType === "task.question") await answer(recovered.page, record("recovered"));
    else await sse(recovered.page, "message", { type: "task.updated", task: { id: "history-a", questionHistory: [record("recovered")] } });
    await count(recovered.page, 1);
    assert.equal(await recovered.page.getByText("问答记录加载失败").count(), 0, "实时记录恢复后清除过期的失败提示");
    assert.equal(recovered.calls.length, 1);
    await recovered.page.close();
  }

  let releaseOld;
  const old = new Promise((resolve) => { releaseOld = resolve; });
  pending.push(() => releaseOld({ json: [] }));
  const switched = await open("", { respond: async (path) => path.includes("history-a/") ? old : { json: [record("task-b")] } });
  await waitForCalls(switched, 1);
  await switched.page.getByRole("button", { name: "切换任务" }).click();
  await count(switched.page, 1);
  releaseOld({ json: [record("task-a")] });
  await answer(switched.page, record("wrong-task"));
  // 旧任务那一发要么切任务时已被掐掉、要么此刻才回来：等它在页面上结算；事件是 evaluate 里
  // 同步派发的，fetchesSettled 末尾那轮冲刷把它引起的渲染一并落掉。
  await fetchesSettled(switched.page, 0, "旧任务那发迟到的问答历史已被页面读完或掐掉");
  assert.equal(await switched.page.locator(".task-question-record").count(), 1);
  assert.match(await switched.page.locator("main").textContent(), /task-b的问题/);
  assert.doesNotMatch(await switched.page.locator("main").textContent(), /task-a的问题|wrong-task/);
  await switched.page.close();

  // 删除是单向的：删除之前发出、删除事件之后才落地的那一发旧读取，不能把墓碑盖回未删的答复
  // （否则正文里已经没有它，末尾却又补出一张没有删除入口的卡）。
  let releaseBeforeDelete;
  const beforeDelete = new Promise((resolve) => { releaseBeforeDelete = resolve; });
  pending.push(() => releaseBeforeDelete({ json: [] }));
  const tombstoned = await open("", { respond: async () => beforeDelete });
  await waitForCalls(tombstoned, 1);
  const tombstone = { id: "gone", answeredAt: record("gone").answeredAt, question: null, answer: "", reply: "", deleted: true };
  await sse(tombstoned.page, "message", { type: "task.updated", task: { id: "history-a", questionHistory: [tombstone] } });
  releaseBeforeDelete({ json: [record("gone"), record("kept")] });
  await count(tombstoned.page, 1);
  assert.match(await tombstoned.page.locator("main").textContent(), /kept的答案/, "旧读取里别的记录照常补上");
  assert.doesNotMatch(await tombstoned.page.locator("main").textContent(), /gone的答案/, "迟到的旧读取不能复活删掉的答复");
  await tombstoned.page.close();

  const snapshot = await open("mode=snapshot&history=seed");
  await count(snapshot.page, 1);
  assert.equal(await snapshot.page.evaluate(() => window.__sources.length), 0, "远端快照不订阅本地事件");
  assert.equal(snapshot.calls.length, 0);
  await snapshot.page.close();

  const form = await browser.newPage();
  await form.goto(`${origin}/scripts/fixtures/question-card.html`);
  await form.evaluate(() => localStorage.clear());
  await form.reload();
  await form.getByRole("button", { name: "留在会话里，点击展开", exact: true }).click();
  assert.match(await form.locator(".task-question-card footer").innerText(), /已答 1\/2 · 留空的题会标记为未答/);
  assert.doesNotMatch(await form.locator("main").innerText(), /可稍后补充/);
  // 提问卡停在滚动容器**外面**的坞里：会话照常滚，问题不会被滚走、也压不到浮动按钮上。
  assert.equal(await form.locator(".task-conversation .task-question-card").count(), 0);
  assert.equal(await form.locator(".task-question-dock > .task-question-card").count(), 1);
  // 一次只出一题；翻到第 2 题后第 1 题连同它的选项都不在 DOM 里。
  assert.equal(await form.locator(".task-question-step").innerText().then((t) => t.includes("同时提供历史入口")), true);
  await form.getByRole("button", { name: /下一题/ }).click();
  assert.match(await form.locator(".task-question-step").innerText(), /发给智能体的回复保留哪些内容/);
  assert.doesNotMatch(await form.locator(".task-question-step").innerText(), /同时提供历史入口/);
  // 翻页后焦点落在选项上，数字键立刻可用。
  await form.keyboard.press("2");
  assert.equal(await form.locator(".task-question-step textarea").inputValue(), "加一句简短说明");
  assert.match(await form.locator(".task-question-card footer").innerText(), /已答 2\/2/);
  // 题号既是进度也是跳转：点回第 1 题，之前的答案还在。
  await form.getByRole("button", { name: "第 1 题（已答）" }).click();
  assert.equal(await form.locator(".task-question-step textarea").inputValue(), "留在会话里，点击展开");
  // 收起后只剩一条标题栏，仍然看得出还欠几题。
  await form.getByRole("button", { name: "收起答复卡，先看上文" }).click();
  assert.equal(await form.locator(".task-question-step").count(), 0);
  assert.match(await form.locator(".task-question-heading").innerText(), /2\/2 · 待答复/);
  await form.close();
  assert.deepEqual(failures, []);
  console.log("question history DOM: seeded history, remount recovery, live receipts, single initial load, reconnect, stale responses, switching, retry/SSE recovery, snapshot, docked one-at-a-time form and truthful copy passed");
} finally {
  pending.forEach((release) => release());
  await browser?.close();
  await web.close();
}
