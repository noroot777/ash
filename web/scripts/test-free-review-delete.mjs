import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { fetchesSettled, settlePage, trackFetches, waitUntil } from "./wait-until.mjs";

// 派审对话框和「审查者被删掉」。审查者的新建、删除都在设置页「审查者」，对话框里只有一颗
// 「管理审查者…」走过去；但审查者是一份全局配置，对话框开着的时候别处随时能删掉一位，
// 这里管的是那时对话框怎么跟上。每一段一张干净页面：
// ① 基本面：四行（审查者、检查类型、失败后自动复审、附言），对话框里没有新建/删除入口；
//    下拉里每位审查者带一行「智能体 · 模型 · 智能水平」，最底下「管理审查者…」关掉对话框、
//    走到设置页那一节。
// ② 草稿面：被预约引用的审查者在别处被删，服务端撤掉预约、任务状态跟着变。那不等于「用户
//    重新打开了对话框」—— 正在写的审查者 / 检查类型 / 轮数 / 附言一个都不许被远端刷新打回。
// ④ 就绪面：任务状态还没到就**不开放编辑**（摆加载态、没有可填的表单、提交按钮灰着）。
//    否则在空表单上写的东西，等状态到了会被那一次初始化整套盖掉。
// ⑤ 失效面：别的页面删掉了本页选中的那位，而**本任务的状态一个字都没变**（删掉的那位
//    没被这项任务预约时，服务端根本不会发这项任务的 task.review）。审查者是全局配置，
//    清单该自己过期：选中项失效要回退并说一声，而不是继续摆着一个点下去才报「审查者不
//    存在」的配置；与此同时用户正在填的附言一个字都不能动。
// ⑦ 换任务面：对话框开着的时候任务被换掉（后退 / 切任务，容器不重建组件），草稿必须整套
//    重来，提交发出去的必须是**新任务**自己的内容，不能把写给 A 的附言保存到 B 身上。
// ⑨ 在飞面：在 A 上点了派审，响应回来时页面已经后退到 B 了。请求本身该做完就做完，
//    但它不许关掉 B 的对话框、不许把 B 卡成关不掉。
// ⑩ 回到本页：在别的标签页删完切回来，不用等轮询那一拍就该对齐。
// ⑫ 核对面：派出去之前跟权威清单核一次 —— 选中的那位刚在别处被删，就别发一个注定被
//    服务端退回的请求。
// ⑬ 回车面：在下拉里选完一位，焦点回到下拉上，这时按回车要发起派审，派出去的是选到的那位。
// ⑭ 这一次换个执行器：审查者行尾那颗钮点开才出；改了只带在这一次的请求上，不写回审查者。

const web = await startWebServer();

const AGENTS = [{
  id: "codex-local",
  name: "codex@local",
  type: "codex",
  target: { kind: "local" },
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  isDefault: true,
}];

const reviewer = (id, name) => ({
  id,
  name,
  agentType: "codex",
  executorId: "codex-local",
  executorLabel: "codex@local",
  model: null,
  reasoningEffort: "high",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const initialReviewers = () => [reviewer("reviewer-1", "顶级审查"), reviewer("reviewer-2", "opus5"), reviewer("reviewer-3", "grok4.6")];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
// 页面上只记「读清单」那一种请求（`/api/reviewer-profiles` 本身）：负向断言前要等的是
// 「那份可能贴回旧数据的清单读取已经被页面消费完」。
const LIST_READS = "/api/reviewer-profiles(?:$|\\?)";

let browser;
try {
  const base = `${web.origin}/scripts/fixtures/free-review-delete.html`;

  browser = await launchChrome();

  // 一个独立页面 + 一份独立的「服务端」内存清单。onList / onDispatch 返回 true 表示它已经
  // 自己 fulfill 了这一次请求（用来演慢响应）。
  const open = async ({ query = "", onList, onDispatch } = {}) => {
    const page = await browser.newPage({ viewport: { width: 1080, height: 820 } });
    const store = { reviewers: initialReviewers(), dispatched: [], listCalls: 0 };
    await trackFetches(page, LIST_READS);
    await page.route("**/api/llm-providers", (route) => json(route, []));
    await page.route("**/api/agents", (route) => json(route, AGENTS));
    await page.route("**/api/reviewer-profiles*", async (route) => {
      store.listCalls += 1;
      if (await onList?.(store, route)) return;
      return json(route, store.reviewers);
    });
    await page.route("**/free-workflow/review", async (route) => {
      const entry = {
        taskId: new URL(route.request().url()).pathname.split("/").at(-3),
        body: JSON.parse(route.request().postData() ?? "{}"),
      };
      if (await onDispatch?.(store, route, entry)) return;
      store.dispatched.push(entry);
      return json(route, { ok: true }, 200);
    });
    await page.goto(`${base}${query}`);
    const dialog = page.locator(".free-review-dialog");
    await dialog.waitFor();
    const reviewerTrigger = dialog.locator(".free-review-reviewer .ui-dropdown-trigger");
    if (!query) await reviewerTrigger.waitFor();
    const ui = {
      page,
      store,
      dialog,
      reviewerTrigger,
      selectedName: () => reviewerTrigger.innerText(),
      checkMode: () => dialog.locator(".free-review-check .ui-dropdown-trigger").innerText(),
      retry: () => dialog.getByRole("group", { name: "自动复审" }).locator("output").innerText(),
      submit: () => dialog.locator("footer button[type='submit']"),
      cancel: () => dialog.getByRole("button", { name: "取消", exact: true }),
      note: () => dialog.getByLabel("附言"),
      // 打开审查者下拉读一遍候选，再按 Esc 收起（只收下拉，不收对话框）。
      options: async () => {
        await reviewerTrigger.click();
        const panel = page.locator(".ui-dropdown-panel");
        await panel.waitFor();
        const names = await panel.locator(".ui-dropdown-row b").allInnerTexts();
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
        return names;
      },
      pick: async (name) => {
        await reviewerTrigger.click();
        await page.locator(".ui-dropdown-panel .ui-dropdown-row").filter({ hasText: name }).click();
        await page.locator(".ui-dropdown-panel").waitFor({ state: "detached" });
      },
      pickCheckMode: async (label) => {
        await dialog.locator(".free-review-check .ui-dropdown-trigger").click();
        await page.locator(".ui-dropdown-panel .ui-dropdown-row").filter({ hasText: label }).click();
        await page.locator(".ui-dropdown-panel").waitFor({ state: "detached" });
      },
      setRetry: async (value) => {
        for (let guard = 0; guard < 30 && Number(await ui.retry()) !== value; guard += 1) {
          await dialog.getByRole("button", { name: Number(await ui.retry()) < value ? "自动复审多一轮" : "自动复审少一轮" }).click();
        }
        assert.equal(Number(await ui.retry()), value);
      },
      // 用户切回这个标签页那一下：资源层拿它当「立刻跟权威清单对一次」的信号。
      refocus: () => page.evaluate(() => window.dispatchEvent(new Event("focus"))),
      // 同一下，但还要证明**这一读是切回本页自己发出来的**（而不是 4 秒一拍的轮询）：
      // 等到没有在飞的清单读（在飞时资源层会复用那一条，就分不清是谁发的），然后在同一个
      // 页面任务里派发 focus 并当场数新发出的读 —— 轮询的定时器插不进一段同步代码里。
      refocusIssuesRead: () => waitUntil(() => page.evaluate(() => {
        const log = window.__ashFetches ?? [];
        if (log.some((entry) => entry.state === "pending")) return false;
        const before = log.length;
        window.dispatchEvent(new Event("focus"));
        return log.length - before;
      }), "切回本页那一下没有当场发出清单读取"),
    };
    return ui;
  };

  // ── ① 基本面 ──────────────────────────────────────────────────────────
  {
    const ui = await open();
    const { page, dialog } = ui;
    assert.equal(await ui.selectedName(), "opus5", "进来时应当选中状态里记着的那位");
    assert.deepEqual(
      (await dialog.locator(".free-review-row > :first-child").allInnerTexts()),
      ["审查者", "检查类型", "失败后自动复审", "附言"],
      "四行字段",
    );
    assert.equal(await dialog.getByRole("button", { name: /删除审查者/ }).count(), 0, "删除在设置页，不在派审对话框里");
    assert.equal(await dialog.getByRole("button", { name: /新建/ }).count(), 0, "新建在设置页，不在派审对话框里");
    assert.equal(await dialog.locator("footer .insp-btn.is-pri").count(), 1, "只有一个主动作");

    await ui.reviewerTrigger.click();
    const panel = page.locator(".ui-dropdown-panel");
    await panel.waitFor();
    assert.deepEqual(await panel.locator(".ui-dropdown-row b").allInnerTexts(), ["顶级审查", "opus5", "grok4.6"]);
    assert.match(await panel.locator(".ui-dropdown-row").first().innerText(), /codex@local · gpt-5\.6-sol · high/, "每位审查者带一行它会怎么跑");
    await page.screenshot({ path: "/tmp/ash-free-review-dialog.png", fullPage: true });
    await panel.getByRole("button", { name: "管理审查者…" }).click();
    await page.getByTestId("closed").waitFor();
    const url = new URL(page.url());
    assert.equal(url.searchParams.get("view"), "settings", "「管理审查者…」要走到设置页");
    assert.equal(url.searchParams.get("settings"), "reviewers", "落在「审查者」那一节");
    await page.close();
  }

  // ── ② 草稿面：被预约引用的那位在别处被删 → 服务端撤预约 → 正在填的东西一个都不许丢 ────
  {
    const ui = await open();
    const { page } = ui;
    const note = "预约被撤也不该清掉我刚写的附言";
    await ui.pickCheckMode("只做语法检查");
    await ui.setRetry(7);
    await ui.note().fill(note);
    await ui.pick("grok4.6");
    assert.equal(await ui.selectedName(), "grok4.6");

    // 生产里这一步由 task.review 事件 → 重读状态完成：预约被撤、选中项被清空。
    // 状态是在这次 evaluate 里同步换掉的：冲刷掉它排上的提交与 effect，再等 effect 可能
    // 顺手发起的清单读被消费完，然后才断言「什么都没被打回」。
    await page.evaluate(() => window.freeReviewFixture.cancelReservation());
    await settlePage(page);
    await fetchesSettled(page, 0, "撤预约之后可能顺手发起的清单读取都已消费完");

    assert.equal(await ui.selectedName(), "grok4.6", "远端撤预约不该把我刚选的审查者换掉");
    assert.equal(await ui.checkMode(), "只做语法检查");
    assert.equal(await ui.retry(), "7");
    assert.equal(await ui.note().inputValue(), note);
    await page.close();
  }

  // ── ④ 就绪面：任务状态还没到就不开放编辑 ─────────────────────────────────
  {
    const ui = await open({ query: "?state=late" });
    const { page, dialog } = ui;
    await dialog.locator(".free-review-loading").waitFor();
    assert.match(await dialog.locator(".free-review-loading").innerText(), /正在读取任务状态/);
    assert.equal(await ui.reviewerTrigger.count(), 0);
    assert.equal(await ui.note().count(), 0, "状态没到就不该给出可填的表单");
    assert.equal(await ui.submit().isDisabled(), true);

    await page.evaluate(() => window.freeReviewFixture.arrive());
    await ui.reviewerTrigger.waitFor();
    assert.equal(await ui.selectedName(), "opus5", "状态到了之后要按这项任务的预约初始化");
    assert.equal(await ui.submit().isDisabled(), false);
    await page.close();
  }

  // ── ⑤ 失效面：别处删掉了本页选中的那位，本任务的状态一个字都没变 ─────────────────
  {
    const ui = await open();
    const { page, store } = ui;
    const note = "清单同步不该把我正在写的附言碰掉";
    await ui.note().fill(note);
    // 设置页把 opus5 删了。它这会儿只是本页的**草稿选择**，持久化预约里压根没它，服务端
    // 因此不会发这项任务的 task.review —— 本页的任务状态一个字都不会变。下面全程不碰
    // fixture 的任何状态接口，也不做任何本页动作：清单必须自己过期。
    store.reviewers = store.reviewers.filter((item) => item.id !== "reviewer-2");

    await waitUntil(async () => (await ui.selectedName()) === "顶级审查", { timeout: 15_000, message: "选中的那位没了，要替用户回退到还在的那位" });
    assert.match(await page.getByTestId("notices").innerText(), /原先选中的审查者已被删除，已替你改选「顶级审查」/);
    assert.equal(await ui.note().inputValue(), note, "清单同步不许动用户正在填的东西");
    assert.equal(await ui.submit().isDisabled(), false);
    assert.deepEqual(await ui.options(), ["顶级审查", "grok4.6"]);
    await page.close();
  }

  // ── ⑦ 换任务面：草稿属于「这个任务的这一次打开」 ────────────────────────────
  {
    // 换任务之后的清单读按住到「那一瞬」的断言做完才放：那一瞬的表单收起与否不能取决于
    // 清单恰好来得多快。
    let release;
    const gate = { slow: false, held: new Promise((resolve) => { release = resolve; }) };
    const ui = await open({
      onList: async (store, route) => {
        if (!gate.slow) return false;
        await gate.held;
        await json(route, store.reviewers);
        return true;
      },
    });
    const { page, store } = ui;
    await ui.note().fill("只给任务 A 的附言，不能发给任务 B");

    gate.slow = true;
    await page.evaluate(() => window.freeReviewFixture.switchTask());
    await page.getByTestId("current-task").getByText("task-b").waitFor();
    // 换任务那一瞬：旧草稿已经不属于当前任务，表单先收起来，提交按钮灰着。
    assert.equal(await ui.note().count(), 0, "任务换了，不能继续摆着上一个任务的草稿");
    assert.equal(await ui.submit().isDisabled(), true);

    gate.slow = false;
    release();
    await ui.reviewerTrigger.waitFor();
    assert.equal(await ui.note().inputValue(), "任务 B 自己的附言", "要按新任务自己的预约重新初始化");
    assert.equal(await ui.selectedName(), "grok4.6");
    assert.equal(await ui.checkMode(), "只做语法检查");
    assert.equal(await ui.retry(), "3");

    await ui.submit().click();
    await waitUntil(() => store.dispatched.length === 1, "派审请求没发出来");
    assert.deepEqual(store.dispatched.map((item) => [item.taskId, item.body.note]), [["task-b", "任务 B 自己的附言"]]);
    await page.close();
  }

  // ── ⑨ 在飞面：A 上发起的派审，响应回来时页面已经是 B 了 ──────────────────────
  {
    let release;
    const gate = { hold: true, held: new Promise((resolve) => { release = resolve; }) };
    const ui = await open({
      onDispatch: async (store, route, entry) => {
        if (!gate.hold) return false;
        gate.hold = false;
        await gate.held;
        store.dispatched.push(entry);
        await json(route, { ok: true });
        return true;
      },
    });
    const { page, store } = ui;
    await ui.submit().click();
    await waitUntil(() => page.evaluate(() => document.querySelector(".free-review-dialog footer button[type='submit']")?.textContent === "启动中…"), "A 的派审没有进入忙碌态");

    // 派审还挂在半空，用户已经后退到任务 B（容器不重建组件，只换 props）。
    await page.evaluate(() => window.freeReviewFixture.switchTask());
    await page.getByTestId("current-task").getByText("task-b").waitFor();
    await ui.reviewerTrigger.waitFor();
    assert.equal(await ui.note().inputValue(), "任务 B 自己的附言");
    assert.equal(await ui.cancel().isDisabled(), false, "上一个任务那次派审还在飞，不该把这个任务的对话框卡成关不掉");

    release();
    await waitUntil(() => store.dispatched.length === 1, "A 的派审请求本身还是要照常完成");
    await settlePage(page);
    assert.equal(store.dispatched[0].taskId, "task-a");
    assert.equal(await page.getByTestId("closed").count(), 0, "A 那次派审回来不许关掉 B 的对话框");
    assert.equal(await ui.selectedName(), "grok4.6", "A 那次派审不许改掉 B 已经初始化好的选择");
    assert.equal(await ui.note().inputValue(), "任务 B 自己的附言");
    await page.close();
  }

  // ── ⑩ 回到本页：在别的标签页删完切回来，不用等轮询那一拍 ──────────────────────
  {
    const ui = await open();
    const { store } = ui;
    // 删的是**没被选中、也没被本任务预约**的那位：本任务的状态更不会变。
    store.reviewers = store.reviewers.filter((item) => item.id !== "reviewer-3");
    // 这一下必须是「切回本页」自己触发的：refocusIssuesRead 当场数到了它发出的那一读。
    assert.equal(await ui.refocusIssuesRead(), 1, "切回本页要当场发出一次清单读取");
    await fetchesSettled(ui.page, 0, "切回本页那一读已消费完");
    assert.deepEqual(await ui.options(), ["顶级审查", "opus5"]);
    assert.equal(await ui.selectedName(), "opus5", "删的不是选中那位，选中项一个字都不该动");
    await ui.page.close();
  }

  // ── ⑫ 核对面：派出去之前跟权威清单核一次 ──────────────────────────────────
  {
    let release;
    const gate = { hold: false, held: new Promise((resolve) => { release = resolve; }) };
    const ui = await open({
      onList: async (store, route) => {
        if (!gate.hold) return false;
        // 压住之后再读 store.reviewers：放行时回的是**最新**那份权威清单。
        await gate.held;
        await json(route, store.reviewers);
        return true;
      },
    });
    const { page, store } = ui;
    assert.equal(await ui.selectedName(), "opus5");

    await fetchesSettled(page, 0, "压住清单读取之前，在飞的那次读已消费完");
    gate.hold = true;
    await ui.submit().click();
    // 点下去的这一瞬，另一个标签页把 opus5 删了。
    store.reviewers = store.reviewers.filter((item) => item.id !== "reviewer-2");
    release();

    await waitUntil(async () => (await ui.selectedName()) === "顶级审查", "核对完要替用户改选到还在的那位");
    assert.deepEqual(store.dispatched, [], "选中的那位已经不在权威清单里，这一次不许发出去");
    assert.match(await page.getByTestId("notices").innerText(), /这一次没有派出去/);
    assert.equal(await ui.submit().isDisabled(), false, "改选之后要能接着派");
    await page.close();
  }

  // ── ⑬ 回车面：选完一位，焦点回到下拉上，回车就派审 ─────────────────────────────
  {
    const ui = await open();
    const { page, store } = ui;
    await ui.pick("grok4.6");
    assert.equal(await ui.reviewerTrigger.evaluate((node) => node === document.activeElement), true, "选完焦点回到下拉上");
    await page.keyboard.press("Enter");
    await waitUntil(() => store.dispatched.length === 1, "选完审查者后按回车要发起派审");
    assert.equal(store.dispatched[0].body.reviewerId, "reviewer-3", "派出去的是刚选的那位");
    await page.close();
  }
  {
    // 键盘全程：下拉上按方向键打开、选一位、回车派审。
    const ui = await open();
    const { page, store } = ui;
    await ui.reviewerTrigger.focus();
    await page.keyboard.press("ArrowDown");
    await page.locator(".ui-dropdown-panel").waitFor();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.locator(".ui-dropdown-panel").waitFor({ state: "detached" });
    assert.equal(await ui.selectedName(), "顶级审查", "方向键在候选之间换选、回车选定");
    assert.deepEqual(store.dispatched, [], "在候选里按回车只是选定，不该顺手派出去");
    await page.keyboard.press("Enter");
    await waitUntil(() => store.dispatched.length === 1, "选定后再按回车要发起派审");
    assert.equal(store.dispatched[0].body.reviewerId, "reviewer-1", "派出去的是换到的那位");
    await page.close();
  }

  // ── ⑭ 这一次换个执行器 ──────────────────────────────────────────────────
  {
    const ui = await open();
    const { page, dialog, store } = ui;
    const toggle = dialog.getByRole("button", { name: "这一次换个执行器" });
    assert.equal(await dialog.locator(".free-review-run-once").count(), 0, "平时不摆，点开才出");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await dialog.locator(".free-review-run-once").waitFor();
    assert.equal(await dialog.locator(".free-review-run-once__hint").count(), 0, "没改动就不说话");
    // 收起再派：照审查者原配置跑，请求里不带覆盖。
    await toggle.click();
    await dialog.locator(".free-review-run-once").waitFor({ state: "detached" });
    await ui.submit().click();
    await waitUntil(() => store.dispatched.length === 1, "派审请求没发出来");
    assert.equal(store.dispatched[0].body.override, null, "没换执行器就不带覆盖");
    await page.close();
  }

  console.log("test-free-review-delete: OK");
} finally {
  await browser?.close();
  await web.close();
}
