import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

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

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  const base = `http://127.0.0.1:${address.port}/scripts/fixtures/accept-gate.html`;

  browser = await chromium.launch(await chromeLaunchOptions());

  const open = async ({ gate, role = "admin", query = "", command } = {}) => {
    const page = await browser.newPage({ viewport: { width: 980, height: 820 } });
    const store = { patches: [], canceled: 0, handoffs: 0, command: command === undefined ? gate.command ?? null : command, gate };
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
      store.gate = { ...store.gate, running: null, latest: { ...store.gate.running, status: "canceled", failure: "canceled" } };
      return json(route, { canceled: true, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/handoff", (route) => {
      store.handoffs += 1;
      store.gate = { ...store.gate, latest: { ...store.gate.latest, handoff: { at: new Date().toISOString(), error: null } } };
      return json(route, { handedOff: true, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/gate-task/accept-gate", (route) => json(route, store.gate));
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
    await page.locator("[aria-label='操作结果']", { hasText: "已收掉" }).waitFor();
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
    assert.equal(await page.locator(".accept-gate-card").count(), 0, "门禁都撤了，卡上还摆出路只会误导");
    await page.close();
  }

  // ⑩ 已经验收完、门禁通过：卡**留着**当回执（用户 2026-10-23），但只读 —— 不再摆任何
  //    会改变状态的按钮（重跑/跳过/交给智能体/改这条命令/刷新），只留「看完整日志」。
  {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: run() }, query: "?stage=accepted" });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /验收前置命令通过了/, "盖完章也得留下「这次是拿什么放的行」");
    assert.match(await card.innerText(), /abc12345/, "回执要说清验的是哪棵树");
    for (const name of ["重跑一次", "这次跳过它，直接合并", "交给智能体去修", "改这条命令", "刷新"]) {
      assert.equal(await card.getByRole("button", { name }).count(), 0, `验收做完之后不该还摆「${name}」`);
    }
    assert.equal(await card.getByRole("button", { name: "看完整日志" }).count(), 1);
    await page.close();
  }

  // ⑪ 已经验收完、而上一次是红的：只有「你明确跳过了它」这一条路到得了这儿。这一态
  //    原先和「门禁通过后验收完成」在界面上完全同形 —— 那正是要补的那一行。
  {
    const failed = run({ status: "failed", exitCode: 1, failure: "exit_code", logTail: "1 failed\n" });
    const { page } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: failed }, query: "?stage=accepted",
    });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /这次跳过了验收前置命令/);
    assert.match(await card.innerText(), /合并是你明确选的/, "得说破合并没有凭据、是谁决定的");
    assert.equal(await card.evaluate((el) => el.classList.contains("is-skipped")), true, "跳过是琥珀不是红：此刻什么都没拦着");
    assert.equal(await card.getByRole("button", { name: "交给智能体去修" }).count(), 0, "都合完了，这条红的出路是新开一个任务");
    await page.close();
  }

  // ⑫ 命令后来被撤掉了，但这个任务当初跑过：验收做完之后仍要留痕（⑨ 那条早退只管
  //    「还没盖章」的任务 —— 那时摆出路才会误导）。
  {
    const { page } = await open({ gate: { command: null, running: null, latest: run() }, query: "?stage=accepted", command: null });
    const card = page.locator(".accept-gate-card");
    await card.waitFor();
    assert.match(await card.innerText(), /验收前置命令通过了/);
    await page.close();
  }

  // ⑬ 主会话页那条折叠条（用户 2026-10-23 的 04-A）：门禁跑的十几分钟里任务本身
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

  // ⑭ 没在跑就彻底不占地方：跑完之后该看的是验收台上那张回执，不是这条。
  {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: run() }, query: "?wait=1" });
    await page.locator("h1").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".accept-gate-wait").count(), 0);
    await page.close();
  }

  console.log("accept gate card DOM regression passed");
} finally {
  await browser?.close();
  await server.close();
}
