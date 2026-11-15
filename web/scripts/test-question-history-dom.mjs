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
    // 答过的提问是你的一个气泡：问题引在答案上面，点那句引文看当时的完整选项。
    const live = page.locator(".task-question-record").filter({ hasText: "live的问题" });
    assert.equal(await live.locator(".task-question-quote-text").innerText(), "live的问题");
    await live.locator(".task-question-quote").click();
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
  assert.equal(await first.page.locator(".task-question-record .task-question-quote-text").innerText(), "loaded的问题");
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

  // 提问那一轮的结算说明（题目全文在里面）画不画，跟答过的气泡读的是同一份问答历史：调用方给的快照是旧的
  // （还没有这条记录），补读读到了，题目就只剩气泡那一处；推来一条删除，气泡没了，结算说明照画回来。
  // 任务页、团队页一样。去重要是另读 props 快照，补读一到同一道题就画两遍。
  for (const mode of ["", "mode=team&"]) {
    const where = mode ? "团队页" : "任务页";
    const deduped = await open(`${mode}history=empty&settle=task-a`, { respond: async () => ({ json: [record("task-a")] }) });
    await count(deduped.page, 1);
    const mentions = async () => {
      // 任务页的结算说明收在「N 条记录」里：摊开再数。
      for (const toggle of await deduped.page.locator(".turn-receipts-toggle[aria-expanded=false]").all()) await toggle.click();
      return deduped.page.evaluate(() => document.querySelector("main").textContent.split("task-a的问题").length - 1);
    };
    assert.equal(await mentions(), 1, `${where}：补读到的答复和结算说明不能把同一道题画两遍`);
    const tombstone = { ...record("task-a"), answer: "", reply: "", deleted: true };
    await sse(deduped.page, "message", { type: "task.updated", task: { id: "history-a", questionHistory: [tombstone] } });
    await count(deduped.page, 0);
    await waitUntil(async () => await mentions() === 1, `${where}：答复删掉以后结算说明照画`);
    await deduped.page.close();
  }

  // 删除不可逆，不管删除是从哪一路来的：这里它经调用方的快照到达（墓碑），下一份快照是不带问答历史的
  // 列表投影，删除之前发出的那发旧读取这时才落地——删掉的答复不能回来。任务页、团队页一样。
  for (const mode of ["", "mode=team&"]) {
    const where = mode ? "团队页" : "任务页";
    let releaseStale;
    const stale = new Promise((resolve) => { releaseStale = resolve; });
    pending.push(() => releaseStale({ json: [] }));
    const removed = await open(`${mode}history=seed`, { respond: async () => stale });
    await waitForCalls(removed, 1);
    await count(removed.page, 1);
    await removed.page.getByRole("button", { name: "快照里删掉" }).click();
    await count(removed.page, 0);
    await removed.page.getByRole("button", { name: "去掉快照" }).click();
    releaseStale({ json: [record("seed")] });
    await fetchesSettled(removed.page, 0, `${where}：删除之前那发旧读取已落地`);
    assert.equal(await removed.page.locator(".task-question-record").count(), 0, `${where}：快照里删掉的答复不能被迟到的旧读取复活`);
    await removed.page.close();
  }

  // 首次补读按任务算：A 连上过、读到过，事件流随后断了（普通请求还通），这时切到 B、再切回 A——
  // 每一次都得自己补读一次，不能因为「之前连上过」就不读。任务页、团队页一样。
  for (const mode of ["", "mode=team&"]) {
    const where = mode ? "团队页" : "任务页";
    const offline = await open(mode, { respond: async (path) => ({ json: [record(path.includes("history-b/") ? "task-b" : "task-a")] }) });
    await waitForCalls(offline, 1);
    await count(offline.page, 1);
    await sse(offline.page, "error");
    await offline.page.getByRole("button", { name: "切换任务" }).click();
    await waitForCalls(offline, 2);
    await waitUntil(async () => /task-b的问题/.test(await offline.page.locator("main").textContent()), `${where}：断线时切到 B，B 自己补读到`);
    await offline.page.getByRole("button", { name: "切回任务" }).click();
    await waitForCalls(offline, 3);
    await waitUntil(async () => /task-a的问题/.test(await offline.page.locator("main").textContent()), `${where}：断线时切回 A，A 这一次照样补读`);
    assert.equal(await offline.page.locator(".task-question-record").count(), 1);
    await offline.page.close();
  }

  const snapshot = await open("mode=snapshot&history=seed");
  await count(snapshot.page, 1);
  assert.equal(await snapshot.page.evaluate(() => window.__sources.length), 0, "远端快照不订阅本地事件");
  assert.equal(snapshot.calls.length, 0);
  await snapshot.page.close();

  assert.deepEqual(failures, []);
  console.log("question history DOM: seeded history, remount recovery, live receipts, single initial load, reconnect, stale responses, switching, retry/SSE recovery, settle-note dedupe on the merged history, snapshot tombstones kept, per-task first catch-up while disconnected, snapshot passed (the answer card itself: test-question-card-dom)");
} finally {
  pending.forEach((release) => release());
  await browser?.close();
  await web.close();
}
