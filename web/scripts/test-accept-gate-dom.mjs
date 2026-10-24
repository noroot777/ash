import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";
import { testAcceptGateRecovery } from "./test-accept-gate-recovery.mjs";

// 验收台上那张「验收前置命令」卡。钉住的是四件在真实页面上才看得出来的事：
//
// ① **在这儿就能把命令设上**（用户 2026-10-23 要求）：想起这件事的时刻就是站在验收台
//    前那一刻，为了设它跳去项目设置再找回来中间隔着三次跳转。所以没设命令时这张卡是
//    一个入口，保存发的是**项目级** PATCH，提示要说破这一点。
// ② 没有管理权限的人看不到这个入口：摆一颗必然 403 的按钮，点的人只会以为是自己点坏了。
// ③ 正在跑的时候不给改：这一次用的是开跑时那条命令原文，改了也不作数。
// ④ 红了之后那两条出路（重跑一次 / 这次跳过）走的是 onIntent，由验收控件接到同一道
//    验收确认框上 —— 卡自己不许偷偷发起验收。
// ⑤ 「交给智能体去修」这件事 ash 红了就**自动**做过一次，所以卡上要先说清它做没做成：
//    做成了按钮改口「再交给智能体一次」，没做成就得直说「那条红现在没人在管」。
// ⑥ 「上次那个绿灯还作不作数」有两种不作数（树变了 / 命令换了一条），出路一样但原因
//    完全不同，说错一种用户会去查错的地方。
// ⑦ 取消和被打断**不是红**：没有结论，所以不套失败色、也没有「交给智能体去修」。
// ⑧ **验收做完之后这张卡留着**（用户 2026-10-23）：它换成一张只读回执。原先在盖章那一
//    刻整个消失，于是「门禁通过了」和「我明确跳过了那条红」在界面上长得一模一样 ——
//    而两者的区别恰恰是这次合并到底有没有凭据。
// ⑨ 回执**只认这一按自己的凭据**（`basis`），绝不拿「最近一次门禁」反推（第 1 轮审查
//    F1 实测出一份假回执：命令在 A 上跑绿、代码改成 B、项目再撤掉命令，那时「最近一次」
//    仍是那条绿的，而真正放行的理由是「现在没有门禁」）。
// ⑩ 并发读取只有**最后发出**的那一次能落地（第 1 轮审查 F3）：迟到的旧响应会把已经结束
//    的那次又写回「正在跑」，而此后没有任何事件会来纠正它。
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const run = (over = {}) => ({
  id: "run-1",
  taskId: "gate-task",
  command: "./kb.sh test full",
  cwd: "/repo/.worktrees/gate-task",
  status: "passed",
  exitCode: 0,
  failure: null,
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  finishedAt: new Date().toISOString(),
  sourceCommit: "abc12345",
  targetBranch: "main",
  targetCommit: "def67890",
  fastForward: true,
  stale: false,
  logPath: "/runs/gate-task/accept-gate-run-1.log",
  logTail: "640 passed\n",
  handoff: null,
  ...over,
});

/** 已验收那张回执的凭据。`passed` 要指着真的跑绿的那一次，不是「最近一次」。 */
const basis = (mode, runRow = null) => ({ mode, run: runRow });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  const base = `http://127.0.0.1:${address.port}/scripts/fixtures/accept-gate.html`;

  browser = await chromium.launch(await chromeLaunchOptions());

  // `states` 给的是**按请求次序**排好的几份响应（用来排并发/乱序那一类场面）：每份可以
  // 带 delay（响应体迟到多久）或 status（直接给个 500）。不给就一直回 store.gate。
  const open = async ({ gate, role = "admin", query = "", command, states, tasks = [], events = false, cancelOutcome = "canceled" } = {}) => {
    const page = await browser.newPage({ viewport: { width: 980, height: 820 } });
    if (events) await page.addInitScript(() => {
      const streams = new Set();
      window.EventSource = class {
        constructor() { streams.add(this); queueMicrotask(() => this.onopen?.()); }
        close() { streams.delete(this); }
      };
      window.emitGateEvent = event => {
        for (const stream of streams) stream.onmessage?.({ data: JSON.stringify(event) });
      };
    });
    const store = { patches: [], canceled: 0, handoffs: 0, reads: 0, tasks, taskReads: 0, taskPlan: null,
      requestIds: [], status: 0, logText: "checking 42 / 640", command: command === undefined ? gate?.command ?? null : command, gate };
    await page.route("**/api/tasks", async route => {
      const snapshot = store.tasks;
      const plan = store.taskPlan;
      store.taskPlan = null;
      store.taskReads += 1;
      if (plan?.delay) await new Promise(resolve => setTimeout(resolve, plan.delay));
      return json(route, snapshot);
    });
    await page.route("**/api/tasks/gate-task/accept-gate/log?*", route => route.fulfill({
      status: 200, contentType: "text/plain", body: store.logText,
    }));
    // SSE 在这一屏里只负责「有变化就重读」，测试里不发事件，挂一条空流免得它反复重连。
    await page.route("**/api/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }));
    await page.route("**/api/projects", (route) =>
      json(route, [{ id: "proj-1", name: "kb", repoPath: "/repo", myRole: role, acceptGateCommand: store.command }]));
    await page.route("**/api/projects/proj-1", async (route) => {
      store.patches.push(JSON.parse(route.request().postData() ?? "{}"));
      store.command = store.patches.at(-1).acceptGateCommand;
      store.gate = { ...store.gate, command: store.command };
      return json(route, { id: "proj-1", name: "kb", repoPath: "/repo", myRole: role, acceptGateCommand: store.command });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/cancel", (route) => {
      store.canceled += 1;
      assert.equal(JSON.parse(route.request().postData()).runId, store.gate.running.id);
      if (cancelOutcome === "settlement_failed") return json(route, {
        outcome: cancelOutcome, runId: store.gate.running.id, gate: store.gate.running,
      });
      if (cancelOutcome !== "canceled") {
        const latest = run({ ...store.gate.running, status: "passed", exitCode: 0 });
        store.gate = { ...store.gate, running: null, latest, basis: basis("passed", latest) };
        return json(route, { outcome: cancelOutcome, runId: latest.id, gate: latest });
      }
      store.gate = { ...store.gate, running: null, latest: { ...store.gate.running, status: "canceled", failure: "canceled" } };
      return json(route, { outcome: "canceled", runId: store.gate.latest.id, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/handoff", (route) => {
      store.handoffs += 1;
      store.gate = { ...store.gate, latest: { ...store.gate.latest, handoff: { at: new Date().toISOString(), error: null } } };
      return json(route, { handedOff: true, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/force-release", route => {
      const body = JSON.parse(route.request().postData());
      assert.equal(body.runId, store.gate.running.id);
      assert.equal(body.confirmation, "release-without-exit-proof");
      store.released = (store.released ?? 0) + 1;
      store.gate = { ...store.gate, running: null, latest: { ...store.gate.running,
        status: "interrupted", failure: "ownership_waived", processPending: false } };
      return json(route, { ok: true, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/*/accept-gate", async (route) => {
      const plan = states?.[store.reads] ?? null;
      store.reads += 1;
      store.requestIds.push(route.request().url().split("/").at(-2));
      if (plan?.delay) await new Promise((resolve) => setTimeout(resolve, plan.delay));
      if (plan?.status || store.status) return json(route, { error: "数据库忙" }, plan?.status || store.status);
      return json(route, plan?.body ?? store.gate);
    });
    await page.goto(`${base}${query}`);
    return { page, store };
  };

  // ① 没设命令：卡是一个入口，设完发的是项目级 PATCH，提示说破「对这个项目之后每一次验收生效」。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null } });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.textContent(), /没设验收前置命令/, "没设时要给一句说明");
    assert.equal(await card.locator(".accept-gate-edit input").count(), 0, "没点之前不该直接摆输入框");

    await card.getByRole("button", { name: "设一条" }).click();
    const input = card.locator(".accept-gate-edit input");
    await input.waitFor();
    assert.match(await card.locator(".accept-gate-edit small").textContent(), /项目设置/,
      "在任务页上改一个项目设置，必须说破它不只影响这一个任务");
    await input.fill("  ./kb.sh test full  ");
    await card.getByRole("button", { name: "保存" }).click();

    await page.locator("[aria-label='操作结果']", { hasText: "验收前置命令" }).waitFor();
    assert.deepEqual(store.patches, [{ acceptGateCommand: "./kb.sh test full" }], "两头空白要掐掉再发");
    assert.equal(await card.locator(".accept-gate-edit input").count(), 0, "保存完要收起输入框");
    await page.close();
  }

  // ② 成员（改不动项目设置）：没设命令时整张卡都不出现 —— 对他只是一句无关的话。
  {
    const { page } = await open({ gate: { command: null, running: null, latest: null }, role: "member" });
    await page.locator("h1").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".accept-gate-card").count(), 0, "没权限改的人不该看到这个入口");
    await page.close();
  }

  // ③ 正在跑：给的是「收掉它」，不给「改这条命令」。
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null, logTail: "正在跑 42/640\n" });
    const { page, store } = await open({ gate: { command: running.command, running, latest: running } });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.textContent(), /正在跑/);
    assert.equal(await card.getByRole("button", { name: "改这条命令" }).count(), 0,
      "跑着的那一次用的是开跑时那条命令，这时摆「改」只会让人以为能中途换一条");
    await card.getByRole("button", { name: "不等了，收掉它" }).click();
    await page.locator("[aria-label='操作结果']", { hasText: "已取消" }).waitFor();
    assert.equal(store.canceled, 1);
    await page.close();
  }

  // ④ 红了：两条出路都只是上报意图，卡自己不发起验收。
  {
    const failed = run({ status: "failed", exitCode: 3, failure: "exit_code", logTail: "2 failed\n" });
    const { page } = await open({ gate: { command: failed.command, running: null, latest: failed } });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.textContent(), /未通过/);
    await card.getByRole("button", { name: "重跑一次" }).click();
    assert.equal(await page.locator("[aria-label='验收意图']").textContent(), "rerun");
    await card.getByRole("button", { name: "这次跳过它，直接合并" }).click();
    assert.equal(await page.locator("[aria-label='验收意图']").textContent(), "skip");
    // 红着也得能就地改命令（最常见的修法就是把命令本身改对）。
    assert.equal(await card.getByRole("button", { name: "改这条命令" }).count(), 1);
    await page.close();
  }

  // ⑤ 交给智能体去修：ash 已经自动交过一次要说出来，按钮跟着改口；那一次没叫醒它的话
  //    这颗按钮是主操作 —— 那条红此刻没人在管，再不点就真的没人管了。
  {
    const failed = run({ status: "failed", exitCode: 3, failure: "exit_code" });
    const { page, store } = await open({ gate: { command: failed.command, running: null, latest: failed } });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.textContent(), /日志还没交给智能体/);
    await card.getByRole("button", { name: "交给智能体去修" }).click();
    await page.locator("[aria-label='操作结果']", { hasText: "交回给智能体" }).waitFor();
    assert.equal(store.handoffs, 1);
    // 交过之后卡上要说清「它已经在修了」，按钮改口成「再交给智能体一次」。
    await card.getByRole("button", { name: "再交给智能体一次" }).waitFor();
    assert.match(await card.textContent(), /已经交回这个任务的智能体去修/);
    await page.close();
  }

  // ⑥ 那次自动交接没叫醒它：卡上必须说破「这条红现在没人在管」。
  {
    const failed = run({
      status: "failed", exitCode: 3, failure: "exit_code",
      handoff: { at: "2026-10-23T02:00:00.000Z", error: "回合被其它执行抢占，消息未能投递" },
    });
    const { page } = await open({ gate: { command: failed.command, running: null, latest: failed } });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.textContent(), /没叫醒它/);
    assert.match(await card.textContent(), /没人在管/);
    assert.equal(await card.getByRole("button", { name: "交给智能体去修" }).count(), 1, "没叫醒就还是「交给智能体去修」");
    await page.close();
  }

  // ⑥ 上一次的绿灯为什么不作数：树变了说树，命令换了说命令。
  {
    const passed = run({ stale: true, command: "./kb.sh test quick" });
    const { page } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: passed },
      command: "./kb.sh test full",
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    const text = await card.textContent();
    assert.match(text, /上次通过的不是现在这条命令/, "命令换了一条，就别说成「代码改过了」");
    assert.match(text, /一次都没跑过/);
    await page.close();
  }

  // ⑦ 被取消的那一次：没有结论 —— 不套失败色，也没有红可以交给智能体。
  {
    const canceled = run({ status: "canceled", exitCode: null, failure: "canceled" });
    const { page } = await open({ gate: { command: canceled.command, running: null, latest: canceled } });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.equal((await card.getAttribute("class")).includes("is-failed"), false, "取消不是红");
    assert.equal(await card.getByRole("button", { name: "交给智能体去修" }).count(), 0,
      "没有结论的那一次，没有「红」可以交给它修");
    await page.close();
  }

  // ⑧ 验收动作被禁用时（任务在跑/归档），「交给智能体去修」也得跟着禁用 —— 它同样会
  //    真的去起一轮。
  {
    const failed = run({ status: "failed", exitCode: 3, failure: "exit_code" });
    const { page, store } = await open({
      gate: { command: failed.command, running: null, latest: failed }, query: "?disabled=1",
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.equal(await card.getByRole("button", { name: "交给智能体去修" }).isDisabled(), true);
    assert.equal(store.handoffs, 0);
    await page.close();
  }

  // ⑨ 命令被撤掉了：这一按就是直接合并，这张卡不该再摆「重跑 / 这次跳过」。
  {
    const { page } = await open({ gate: { command: null, running: null, latest: run() } });
    await page.locator("h1").waitFor();
    await page.waitForTimeout(300);
    const card = page.locator(".accept-gate-card");
    assert.match(await card.innerText(), /历史记录/);
    assert.equal(await card.getByRole("button", { name: "设一条" }).count(), 1);
    assert.equal(await card.getByRole("button", { name: "重跑一次" }).count(), 0);
    await page.close();
  }

  // ⑩ 已经验收完、而且这一按**真的是拿一次跑绿放的行**：卡留着当回执（用户 2026-10-23），
  //    但只读 —— 不再摆任何会改变状态的按钮（重跑/跳过/交给智能体/改这条命令）。
  {
    const evidence = run();
    const { page } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: evidence, basis: basis("passed", evidence) },
      query: "?stage=accepted",
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /验收前置命令通过了/, "盖完章也得留下「这次是拿什么放的行」");
    assert.match(await card.innerText(), /abc12345/, "回执要说清验的是哪棵树");
    for (const name of ["重跑一次", "这次跳过它，直接合并", "交给智能体去修", "改这条命令"]) {
      assert.equal(await card.getByRole("button", { name }).count(), 0, `验收做完之后不该还摆「${name}」`);
    }
    assert.equal(await card.getByRole("button", { name: "看完整日志" }).count(), 1);
    assert.equal(await card.getByRole("button", { name: "刷新", exact: true }).count(), 1);
    await page.close();
  }

  // ⑪ 已经验收完、凭据是「你明确跳过了它」：这一态原先和「门禁通过后验收完成」在界面上
  //    完全同形 —— 那正是要补的那一行。
  {
    const failed = run({ status: "failed", exitCode: 1, failure: "exit_code", logTail: "1 failed\n" });
    const { page } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: failed, basis: basis("skipped") },
      query: "?stage=accepted",
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /这次跳过了验收前置命令/);
    assert.match(await card.innerText(), /验收是你明确选的/, "得说破验收没有测试凭据、是谁决定的");
    assert.match(await card.innerText(), /那条红没有人修过/);
    assert.equal(await card.evaluate((el) => el.classList.contains("is-skipped")), true, "跳过是琥珀不是红：此刻什么都没拦着");
    assert.equal(await card.getByRole("button", { name: "交给智能体去修" }).count(), 0, "都合完了，这条红的出路是新开一个任务");
    await page.close();
  }

  // ⑫ 命令后来被撤掉了，但这一按的凭据确实是那次跑绿：验收做完之后仍要留痕（⑨ 那条
  //    早退只管「还没盖章」的任务 —— 那时摆出路才会误导）。
  {
    const evidence = run();
    const { page } = await open({
      gate: { command: null, running: null, latest: evidence, basis: basis("passed", evidence) },
      query: "?stage=accepted", command: null,
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /验收前置命令通过了/);
    await page.close();
  }

  // ⑬ **第 1 轮审查 F1 的那份假回执**：命令在 A 上跑绿（latest 还是那条绿的、只是 stale），
  //    代码改成了 B、项目又把命令撤掉，于是真正放行的理由是「那一刻没有门禁」。回执必须
  //    照凭据说话 —— 一个字都不许出现「通过了 / 拿它放的行」。
  {
    const greenOnA = run({ stale: true });
    const { page } = await open({
      gate: { command: null, running: null, latest: greenOnA, basis: basis("unset") },
      query: "?stage=accepted", command: null,
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    const text = await card.innerText();
    assert.match(text, /没有经过验收前置命令/);
    assert.match(text, /本次验收没有经过这道测试/);
    assert.doesNotMatch(text, /通过了/, "那条绿不是这次合并的凭据，说「通过了」就是给没测过的代码背书");
    assert.doesNotMatch(text, /拿它放的行/);
    assert.match(text, /不是这次验收的凭据/, "历史记录照常摆出来，但要标清它不是凭据");
    await page.close();
  }

  // ⑭ 凭据是后来才开始记的：老数据如实说「查不到凭据」，不拿最近一次替它背书。
  {
    const { page } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: run(), basis: null },
      query: "?stage=accepted",
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    const text = await card.innerText();
    assert.match(text, /没有留下门禁凭据/);
    assert.match(text, /并不能证明本次验收前跑过它/);
    await page.close();
  }

  // ⑮ 主会话页那条折叠条（用户 2026-10-23 的 04-A）：门禁跑的十几分钟里任务本身
  //    status/stage 一个字都不变，这条是会话页上**唯一**看得出「有东西在跑」的东西。
  //    折叠态要把命令和已经跑了多久都写在一行；展开能就地收掉它。
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null, logTail: "RUN x_post\n" });
    const { page, store } = await open({ gate: { command: running.command, running, latest: null }, query: "?wait=1" });
    const bar = page.locator(".accept-gate-wait");
    await bar.waitFor();
    const text = await bar.innerText();
    assert.match(text, /验收前置命令在跑/);
    assert.match(text, /\.\/kb\.sh test full/, "折叠那一行要说清在跑的是哪条命令");
    assert.match(text, /已经 1 分 30 秒/, "秒表要自己走，不能定在点下去那一刻");
    // 折叠态不许把出路摆出来占地方，但点开就得有。
    assert.equal(await bar.getByRole("button", { name: /不等了/ }).count(), 0);
    await bar.locator(".wait-bar__bar").click();
    await bar.getByRole("button", { name: /不等了/ }).click();
    await page.waitForTimeout(200);
    assert.equal(store.canceled, 1, "收掉它要真打那一发 cancel");
    assert.equal(await page.locator(".accept-gate-wait").count(), 0, "收掉之后这条就该消失 —— 它只说「正在跑」");
    await page.close();
  }

  // ⑯ 没在跑就彻底不占地方：跑完之后该看的是验收台上那张回执，不是这条。
  {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: run() }, query: "?wait=1" });
    await page.locator("h1").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".accept-gate-wait").count(), 0);
    await page.close();
  }

  // ⑰ **第 1 轮审查 F3**：并发读取乱序。页面一打开天然就有两次读取（挂载那一次 + SSE
  //    连上之后的对账那一次）。让**先发出**的那一次响应体迟到、并且回的是「正在跑」，
  //    后发出的那一次先回来、回的是「已通过」—— 落地的必须是后者。从前旧响应会把它写回
  //    「正在跑」，秒表接着加，而此后没有任何事件会来纠正它。
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page } = await open({
      gate: { command: running.command, running: null, latest: run(), basis: null },
      query: "?wait=1&expected=1",
      states: [
        // 第 1 次（挂载）：慢，而且说「在跑」。
        { delay: 1200, body: { command: running.command, running, latest: running, basis: null } },
        // 第 2 次（连上之后对账）：快，说「已经通过了」。
        { body: { command: running.command, running: null, latest: run(), basis: null } },
      ],
    });
    await page.locator("h1").waitFor();
    // 等那条迟到的响应落回来（1200ms + 余量），期间它一旦落地就会把这条重新画出来。
    await page.waitForTimeout(1800);
    assert.equal(await page.locator(".accept-gate-wait").count(), 0,
      "迟到的旧响应不许把已经结束的那次又写回「正在跑」");
    await page.close();
  }

  // ⑱ 状态读不出来、而任务投影说有命令在跑：这条**仍然要出现**并如实说读不出来。从前
  //    一次 500 之后它整个消失，跟「什么都没在跑」长得一模一样（第 1 轮审查不拦项 3）。
  {
    const { page, store } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: null, basis: null },
      query: "?wait=1&expected=1",
      states: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }],
    });
    const bar = page.locator(".accept-gate-wait");
    await bar.waitFor();
    assert.match(await bar.innerText(), /状态读不出来/);
    const before = store.reads;
    await bar.getByRole("button", { name: "重试" }).click();
    await page.waitForTimeout(200);
    assert.ok(store.reads > before, "重试要真的再读一次");
    await page.close();
  }

  for (const event of [
    { type: "task.acceptGate", taskId: "gate-task" },
    { type: "task.stage", taskId: "gate-task", stage: "accepted", updatedAt: new Date().toISOString() },
    { type: "task.updated", task: { id: "gate-task", stage: "accepted" } },
  ]) {
    const passed = run();
    const { page, store } = await open({ gate: { command: passed.command, running: null, latest: passed, basis: null },
      query: "?stage=accepted", events: true });
    const card = page.locator(".accept-gate-card");
    await card.getByText(/这次验收没有留下门禁凭据/).waitFor();
    store.gate = { ...store.gate, basis: basis("passed", passed) };
    await page.evaluate(event => window.emitGateEvent(event), event);
    await card.getByText(/本次验收前，验收前置命令通过了/).waitFor();
    assert.doesNotMatch(await card.innerText(), /没有留下门禁凭据/);
    await page.close();
  }
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page, store } = await open({ gate: { command: running.command, running, latest: running }, query: "?wait=1" });
    const bar = page.locator(".accept-gate-wait");
    await bar.locator(".wait-bar__bar").click();
    await bar.getByRole("button", { name: "看完整日志" }).click();
    await bar.getByText("checking 42 / 640", { exact: true }).waitFor();
    store.logText = "NEW PROGRESS 500 / 640";
    await bar.getByRole("button", { name: "刷新日志" }).click();
    await bar.getByText("NEW PROGRESS 500 / 640", { exact: true }).waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const animations = await page.evaluate(() => {
      return ["workspace-status-dot--active", "workspace-status-dot--working", "team-status-dot--active", "team-status-dot--working"].map(className => {
        const dot = document.createElement("span");
        dot.className = className;
        document.body.append(dot);
        const animation = getComputedStyle(dot).animationName;
        dot.remove();
        return animation;
      });
    });
    assert.deepEqual(animations, ["none", "none", "none", "none"]);
    await page.close();
  }
  for (const wait of [false, true]) {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page } = await open({ gate: { command: running.command, running, latest: running },
      cancelOutcome: "already_finished", query: wait ? "?wait=1" : "?stage=accepted" });
    if (wait) await page.locator(".wait-bar__bar").click();
    await page.getByRole("button", { name: "不等了，收掉它" }).click();
    const notice = page.getByRole("status", { name: "操作结果" });
    await notice.filter({ hasText: "已经结束" }).waitFor();
    assert.doesNotMatch(await notice.innerText(), /没有合并|已取消|已收掉/);
    if (!wait) assert.match(await page.locator(".accept-gate-card").innerText(), /本次验收就是拿它放的行/);
    await page.close();
  }
  {
    const { page } = await open({ gate: { command: null, running: null, latest: null, basis: basis("unset") },
      query: "?stage=accepted" });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /本次验收没有经过验收前置命令/);
    assert.doesNotMatch(await card.innerText(), /设一条之后|直接合了/);
    await page.close();
  }
  for (const wait of [false, true]) {
    const pending = run({ status: "interrupted", processPending: true });
    const { page } = await open({ gate: { command: null, running: pending, latest: pending }, query: wait ? "?wait=1" : "" });
    const card = page.locator(wait ? ".accept-gate-wait" : ".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /尚待停止/);
    await page.close();
  }
  for (const wait of [false, true]) {
    const active = run({ status: "running", exitCode: null });
    const { page } = await open({ gate: { command: active.command, running: active, latest: active },
      query: wait ? "?wait=1" : "", cancelOutcome: "settlement_failed" });
    const card = page.locator(wait ? ".accept-gate-wait" : ".accept-gate-card");
    await card.waitFor();
    if (wait) await page.locator(".wait-bar__bar").click();
    await card.getByRole("button", { name: "不等了，收掉它" }).click();
    const notice = page.getByRole("status", { name: "操作结果" });
    await notice.filter({ hasText: "取消结果保存失败" }).waitFor();
    assert.match(await notice.innerText(), /重试取消/);
    assert.doesNotMatch(await notice.innerText(), /已经结束|已取消这一次/);
    await card.getByRole("button", { name: "不等了，收掉它" }).waitFor();
    if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/cancel-settlement-failed-${wait ? "wait" : "card"}.png`, fullPage: true });
    await page.close();
  }
  {
    const moved = run({ logAvailable: false, logTail: "" });
    const { page } = await open({ gate: { command: moved.command, running: null, latest: moved, basis: basis("passed", moved) }, query: "?stage=accepted" });
    const missing = page.getByRole("button", { name: "日志未迁入或已清理，当前不可查" });
    await missing.waitFor();
    assert.equal(await missing.isDisabled(), true);
    if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/handoff-log-unavailable.png`, fullPage: true });
    await page.close();
  }
  {
    const { page, store } = await open({ gate: { command: "npm test", running: null, latest: null,
      unavailable: "监督能力不可用，本机未执行；请换机或明确跳过" } });
    const card = page.locator(".accept-gate-card");
    await card.getByText("验收前置命令未执行：本机能力不可用").waitFor();
    assert.equal(await card.locator(".is-spinning").count(), 0);
    assert.equal(store.handoffs, 0);
    await card.getByRole("button", { name: "这次跳过它，直接合并" }).click();
    assert.equal(await page.getByLabel("验收意图").innerText(), "skip");
    if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/supervision-unavailable.png`, fullPage: true });
    await page.close();
  }
  {
    const executionNotice = "macOS 兼容监督：不具备 cgroup/Job 的整次运行内核保证。独立测试快照保留，不自动删除。";
    for (const query of ["", "?stage=accepted", "?wait=1"]) {
      const current = run({ status: query === "?wait=1" ? "running" : "passed", executionNotice });
      const { page, store } = await open({ gate: { command: current.command, running: query === "?wait=1" ? current : null,
        latest: current, executionNotice, basis: query === "?stage=accepted" ? basis("passed", current) : null }, query });
      if (query === "?wait=1") await page.getByRole("button", { name: /验收前置命令在跑/ }).click();
      await page.getByRole("note").filter({ hasText: executionNotice }).waitFor();
      assert.equal(store.handoffs, 0);
      assert.equal(await page.getByText("验收前置命令未执行：本机能力不可用").count(), 0);
      if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/macos-compatible-${query === "?wait=1" ? "running" : query ? "receipt" : "ready"}.png`, fullPage: true });
      await page.close();
    }
  }
  for (const wait of [false, true]) {
    const pending = run({ status: "failed", failure: "process_unconfirmed", processPending: true });
    const { page, store } = await open({ gate: { command: pending.command, running: pending, latest: pending }, query: wait ? "?wait=1" : "" });
    const card = page.locator(wait ? ".accept-gate-wait" : ".accept-gate-card");
    await card.waitFor();
    if (wait) {
      assert.match(await card.innerText(), /等待退出证据/);
      assert.equal(await card.locator(".is-spinning").count(), 0);
      await page.locator(".wait-bar__bar").click();
    }
    await card.getByRole("button", { name: "停止证据丢失？确认风险并强制释放…" }).click();
    assert.equal(store.released ?? 0, 0, "展开风险说明不是确认释放");
    await card.getByRole("button", { name: "保留保护" }).click();
    assert.equal(store.released ?? 0, 0);
    await card.getByRole("button", { name: "停止证据丢失？确认风险并强制释放…" }).click();
    assert.match(await card.getByRole("alert").innerText(), /不等于停止或测试通过/);
    if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/force-release-confirm-${wait ? "wait" : "card"}.png`, fullPage: true });
    await card.getByRole("button", { name: "我确认风险，强制释放本次占用" }).click();
    await page.getByRole("status", { name: "操作结果" }).filter({ hasText: "没有取得退出证据" }).waitFor();
    assert.equal(store.released, 1);
    assert.equal(store.gate.latest.failure, "ownership_waived");
    await page.close();
  }
  {
    const timestamp = new Date().toISOString();
    const rows = [
      { id: "single", title: "普通任务（暂停）", mode: "single", status: "paused" },
      { id: "lead", title: "团队（执行者暂停）", mode: "team", status: "idle" },
      { id: "worker", title: "执行者（暂停）", mode: "single", status: "paused", parentId: "lead" },
    ].map(row => ({ projectId: "proj-1", updatedAt: timestamp, monitorRunning: false, ...row }));
    const { page, store } = await open({ query: "?dots=1", events: true, tasks: rows });
    const assertDots = async kind => {
      for (const row of rows) {
        const dot = page.locator(`[data-task-id="${row.id}"] .${row.mode === "team" ? "team" : "workspace"}-status-dot--${kind}`);
        await dot.waitFor();
        assert.equal(await dot.evaluate(element => getComputedStyle(element).animationName), kind === "working" ? "task-status-dot-pulse" : "none");
      }
    };
    await assertDots("attention");
    if (process.env.ASH_BROWSER_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ASH_BROWSER_EVIDENCE_DIR}/dots-paused.png` });
    store.tasks = rows.map(row => ({ ...row, monitorRunning: row.id !== "lead" }));
    await page.evaluate(() => window.emitGateEvent({ type: "task.monitors", taskId: "worker" }));
    await assertDots("working");
    if (process.env.ASH_BROWSER_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ASH_BROWSER_EVIDENCE_DIR}/dots-monitor-running.png` });
    store.tasks = rows;
    await page.evaluate(() => window.emitGateEvent({ type: "task.monitors", taskId: "worker" }));
    await assertDots("attention");
    await page.reload();
    await assertDots("attention");
    await page.close();
  }
  {
    const previous = run();
    const { page, store } = await open({ events: true, gate: { command: previous.command, running: null, latest: previous } });
    await page.getByText("源码、依赖输入和命令仍与被测快照一致", { exact: false }).waitFor();
    store.gate = { command: "npm run replacement", running: null, latest: { ...previous, stale: true } };
    await page.evaluate(() => window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" }));
    await page.locator(".accept-gate-card").filter({ hasText: "npm run replacement" }).waitFor();
    assert.doesNotMatch(await page.locator(".accept-gate-card").innerText(), /源码、依赖输入和命令仍与被测快照一致/);
    if (process.env.ASH_BROWSER_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ASH_BROWSER_EVIDENCE_DIR}/command-invalidated.png` });
    store.gate = { command: null, running: null, latest: previous };
    await page.evaluate(() => window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" }));
    await page.locator(".accept-gate-card").filter({ hasText: "历史记录" }).waitFor();
    await page.close();
  }
  await testAcceptGateRecovery({ open, run, basis });
  console.log("accept gate card DOM regression passed");
} finally {
  await browser?.close();
  await server.close();
}
