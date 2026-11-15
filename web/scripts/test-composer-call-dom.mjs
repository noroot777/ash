// 新建框里 `@` 一个人（TaskComposerPanel + ComposerCall + composerOpening）。新建只有一种任务：建出来的一律是
// 普通任务，归胶囊上那个执行器；被叫的人只管开头这一下。
//
// 盯的是：
// ① `@` 菜单里没有这条任务自己的执行器；选了人框顶多出「叫他来做什么」那一行，只有「问一句」「讨论」，没有「派出去」；
//    两颗胶囊同时在：任务自己的缩成一段排前面，被叫的人在后面；
// ② 问一句：建的是普通任务、执行器是胶囊上那个；第一回合是带着他的一次性召唤（reply 带 agent），不另起 run；
// ③ 讨论：建的是普通任务；第一回合是一场讨论（discussions，各方是被叫的人），不另起 run、不发 reply；附件跟着话题走；
// ④ 叫着人时排队、仅创建、定时都兑现不了，那几档置灰；
// ⑤ 不叫了：写的字一个不丢，那一行收起，回到普通的创建并运行；
// ⑥ 第一回合没被接下（问一句、讨论都一样）：任务已建好，字、叫的人原样留着，面板不收、写明原因；再按一次只对
//    那一条重发，不再建一条，接下了才收尾；
// ⑦ 叫的人跟正文一起存在草稿里：面板关了再开还在；
// ⑧ 任务自己那颗胶囊收着时只露智能体；键盘进来就摆出模型、智能水平，照样能改；点智能体那段选完接着开模型。
// 跑法：npm -w web run test:composer-call-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const PROFILES = [
  { id: "profile-claude", name: "claude@local", type: "claude", isDefault: true },
  { id: "profile-codex", name: "codex@local", type: "codex", isDefault: true },
];

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  let created = 0;
  // 第一回合（reply / discussions）还要失败几次。
  let failOpenings = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/agents") return json(PROFILES);
    if (path === "/settings") return json({ defaultWorkflowId: null });
    if (path.endsWith("/branches")) return json({ branches: ["main"], current: "main" });
    if (path === "/uploads" && request.method() === "POST") {
      return json({ id: "u1", name: "shot.png", path: "/tmp/uploads/shot.png", kind: "image" });
    }
    if (path === "/tasks" && request.method() === "POST") {
      const body = request.postDataJSON();
      created += 1;
      requests.push({ kind: "create", body });
      return json({ ...body, id: `task-${created}`, status: "backlog", createdAt: "2026-11-15T02:00:00.000Z", updatedAt: "2026-11-15T02:00:00.000Z" }, 201);
    }
    const match = /^\/tasks\/([^/]+)\/(run|reply|discussions)$/.exec(path);
    if (match && request.method() === "POST") {
      requests.push({ kind: match[2], task: match[1], body: request.postDataJSON() });
      if (match[2] !== "run" && failOpenings > 0) {
        failOpenings -= 1;
        return json({ error: "暂时不可用（夹具）" }, 503);
      }
      return json(match[2] === "discussions" ? { discussionId: "d1", state: {} } : { started: true });
    }
    return json([]);
  });
  await page.goto(`${web.origin}/scripts/fixtures/composer-call.html`);

  const objective = page.getByRole("textbox", { name: "任务目标" });
  const row = (agent) => page.getByRole("group", { name: `叫 ${agent} 来做什么` });
  const key = (agent, label) => row(agent).getByRole("button", { name: label, exact: true });
  const send = page.locator(".studio-card .send-key-main");
  const call = async (text, agent) => {
    await objective.fill(`${text}@${agent.slice(0, 2)}`);
    await page.getByRole("option", { name: new RegExp(`@${agent}`) }).click();
    await row(agent).waitFor();
  };
  const since = (start) => requests.slice(start);
  await page.getByRole("button", { name: /^智能体：claude/ }).waitFor();
  assert.equal(await page.getByRole("tablist", { name: "任务模式" }).count(), 0, "新建框没有模式那一排");

  // ① 自己的执行器不在 `@` 菜单里；叫的是别人：两种做法，没有「派出去」；两颗胶囊都在。
  await objective.fill("先看看 @c");
  await page.getByRole("option", { name: /@codex/ }).waitFor();
  assert.equal(await page.getByRole("option", { name: /@claude/ }).count(), 0, "@ 菜单里没有任务自己的执行器");
  await call("看一下这个改法 ", "codex");
  assert.equal(await objective.inputValue(), "看一下这个改法 ", "@codex 是指令不是内容，从正文里摘掉");
  assert.equal(await key("codex", "问一句").getAttribute("aria-pressed"), "true", "默认停在「问一句」");
  assert.equal(await key("codex", "讨论").count(), 1);
  assert.equal(await key("codex", "派出去").count(), 0, "新建框里没有「派出去」");
  assert.equal(await page.getByRole("button", { name: /派出去/ }).count(), 0, "整块面板都没有「派出去」");
  assert.match(await page.getByRole("button", { name: /^智能体：/ }).first().getAttribute("aria-label") ?? "", /^智能体：claude/,
    "任务自己的胶囊还在、还是 claude");
  assert.equal(await page.locator('[aria-label^="叫来的智能体：codex"]').count() > 0, true, "被叫的人有自己的一颗胶囊");
  assert.match(await send.innerText(), /问 codex/, "发送键写这一按干的事");

  // ④ 叫着人时只能创建并运行。
  await page.getByRole("button", { name: /^启动设置：/ }).click();
  for (const name of ["创建并排队", "仅创建", "一次性定时", "循环 Cron"]) {
    assert.equal(await page.getByRole("radio", { name: new RegExp(`^${name}`) }).isDisabled(), true, `叫着人时「${name}」置灰`);
  }
  await page.keyboard.press("Escape");

  // ② 问一句：普通任务 + 带着他的一次性召唤，不另起 run。
  let start = requests.length;
  await send.click();
  await page.getByText("已创建：", { exact: false }).first().waitFor();
  await waitUntil(async () => since(start).length >= 2, "建任务之后起第一回合");
  let [create, first, ...rest] = since(start);
  assert.equal(create.kind, "create");
  assert.equal(create.body.mode, "single", "新建出来的是普通任务");
  assert.equal(create.body.agentType, "claude", "任务归胶囊上那个执行器");
  assert.equal(create.body.team, undefined);
  assert.equal(create.body.duet, undefined);
  assert.equal(first.kind, "reply", "问一句的第一回合是一次性召唤");
  assert.equal(first.task, "task-1");
  assert.equal(first.body.agent, "codex");
  assert.equal(first.body.text, "看一下这个改法");
  assert.deepEqual(rest, [], "问一句不再另起 run");
  await page.getByText("提示：任务已创建，第一句交给 codex 答").waitFor();

  // ⑤ 不叫了：字一个不丢，那一行收起，发送键回到普通的创建并运行。
  await objective.waitFor();
  await call("这句话要留着 ", "codex");
  await page.getByRole("button", { name: "不叫 codex 了" }).click();
  await row("codex").waitFor({ state: "detached" });
  assert.equal(await objective.inputValue(), "这句话要留着 ", "不叫了字也在");
  assert.doesNotMatch(await send.innerText(), /codex/);

  // ③ 讨论：普通任务 + 一场讨论开头；附件跟着话题走。
  await call("比较两种缓存方案 ", "codex");
  await key("codex", "讨论").click();
  assert.equal(await key("codex", "讨论").getAttribute("aria-pressed"), "true");
  await page.locator('[aria-label^="一起讨论的智能体："]').first().waitFor();
  await page.locator(".studio-card input[type=file]").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from("png") });
  await page.locator(".studio-input-status").waitFor();
  assert.match(await send.innerText(), /开始讨论/);
  start = requests.length;
  await send.click();
  await waitUntil(async () => since(start).length >= 2, "建任务之后开讨论");
  [create, first, ...rest] = since(start);
  assert.equal(create.body.mode, "single", "讨论开头的也是普通任务");
  assert.equal(create.body.agentType, "claude");
  assert.equal(first.kind, "discussions", "讨论的第一回合是一场讨论");
  assert.equal(first.task, "task-2");
  assert.equal(first.body.topic, "比较两种缓存方案");
  assert.deepEqual(first.body.guests.map((guest) => guest.agentType), ["codex"], "各方是被叫的人（加任务自己的执行器）");
  assert.deepEqual(first.body.attachments, ["/tmp/uploads/shot.png"], "附件跟着话题走");
  assert.deepEqual(rest, [], "讨论不再另起 run 或 reply");
  await page.getByText("提示：任务已创建，和 codex 的讨论开始了").waitFor();

  // ⑥ 问一句的第一回合没被接下：任务建好了，字和叫的人都在，面板不收；再按一次只重发给那一条。
  await objective.waitFor();
  await call("第三条要问的 ", "codex");
  failOpenings = 1;
  start = requests.length;
  const createdBefore = await page.getByTestId("created").getByRole("listitem").count();
  await send.click();
  const stuck = page.getByRole("alert").filter({ hasText: "第一回合没发出去" });
  await stuck.waitFor();
  assert.match(await stuck.innerText(), /暂时不可用（夹具）/, "写明没发出去的原因");
  assert.deepEqual(since(start).map((item) => item.kind), ["create", "reply"]);
  assert.equal(await objective.inputValue(), "第三条要问的 ", "字留着");
  await row("codex").waitFor();
  assert.equal(await page.getByTestId("created").getByRole("listitem").count(), createdBefore, "没办成就不收面板、不跳走");
  await page.getByText("提示：任务已创建，但给 codex 的这一句没发出去：暂时不可用（夹具）。再按一次只重发这一下，不会再建一条").waitFor();
  start = requests.length;
  await send.click();
  await page.getByText("提示：任务已创建，第一句交给 codex 答").nth(1).waitFor();
  assert.deepEqual(since(start).map((item) => [item.kind, item.task]), [["reply", "task-3"]], "重发只对已建好的那一条，不再建一条");
  assert.equal(await page.getByTestId("created").getByRole("listitem").count(), createdBefore + 1, "接下了才收尾");

  // ⑥ 讨论同样：开不起来就留着，再按一次只对那一条开讨论。
  await objective.waitFor();
  await call("第四条要讨论的 ", "codex");
  await key("codex", "讨论").click();
  failOpenings = 1;
  start = requests.length;
  await send.click();
  await page.getByRole("alert").filter({ hasText: "第一回合没发出去" }).waitFor();
  assert.equal(await key("codex", "讨论").getAttribute("aria-pressed"), "true", "叫的人和做法都留着");

  // ⑦ 面板关了再开：字、叫的人、做法、待重发的那条都还在。
  await page.getByTestId("reopen").click();
  await page.getByRole("alert").filter({ hasText: "第一回合没发出去" }).waitFor();
  assert.equal(await objective.inputValue(), "第四条要讨论的 ");
  assert.equal(await key("codex", "讨论").getAttribute("aria-pressed"), "true", "重开面板叫的人还在");
  await send.click();
  await page.getByText("提示：任务已创建，和 codex 的讨论开始了").nth(1).waitFor();
  assert.deepEqual(since(start).map((item) => [item.kind, item.task]), [["create", undefined], ["discussions", "task-4"], ["discussions", "task-4"]],
    "讨论也只建一次、对同一条重开");

  // ⑧ 叫着人时任务自己的胶囊收着；键盘进来就摆出模型和智能水平，选得了；点智能体那段选完接着开模型。
  await objective.waitFor();
  await call("再问一句 ", "codex");
  const own = page.locator(".studio-inline-executor > .composer-field .run-target-picker");
  const ownAgent = own.getByRole("button", { name: /^智能体：/ });
  const ownModel = own.getByRole("button", { name: /^模型：/ });
  const width = (locator) => locator.evaluate((element) => element.getBoundingClientRect().width);
  assert.equal(await width(ownModel) <= 1, true, "收着时只露智能体那一段");
  await ownAgent.focus();
  await page.keyboard.press("Tab");
  assert.equal(await ownModel.evaluate((element) => element === document.activeElement), true, "模型那一段还在 Tab 顺序里");
  assert.equal(await width(ownModel) > 1, true, "键盘进来就摆出模型那一段");
  await page.keyboard.press("Enter");
  await page.getByRole("listbox", { name: "可选模型" }).waitFor();
  assert.equal(await width(ownModel) > 1, true, "弹层开着时那一段不收回去");
  await page.keyboard.press("Escape");
  await objective.focus();
  await waitUntil(async () => (await width(ownModel)) <= 1, "离开就收回一段");
  await ownAgent.click();
  await page.getByRole("listbox", { name: "已注册的智能体" }).getByRole("option", { name: /claude/ }).first().click();
  await page.getByRole("listbox", { name: "可选模型" }).waitFor();
  assert.equal(await width(ownModel) > 1, true, "选完智能体照常向右接着选模型");
  await page.keyboard.press("Escape");

  assert.deepEqual(errors, []);
  console.log("composer call dom test passed");
} finally {
  await browser?.close();
  await web.close();
}
