// 回复框里 `@` 一个人（ReplyBox + ReplyCallDock + replyDispatch）：框顶一行定它来做什么，胶囊换成它，
// 发送键写这一按的名字。
//
// 盯的是：
// ① 选完人默认停在「问一句」，中间不再弹选模型；发出去跟原来的一次性召唤一样（agent/执行器/模型/智能
//    水平随这一句走，发完退回任务自己的执行器）；对他用过的模型下次叫他时先摆上；
// ② `@` 这条任务自己的执行器：只有「派出去」能选；
// ③ 换做法、点小叉、空框退格取消：写的字一个不丢；
// ④ 派出去：建一条交给他的新任务——带着这场对话（来源任务、会话记录路径）、挂在这条任务名下
//    （dispatchedBy）、从哪开工照胶囊最后那一段、建完就起跑；这条任务自己一个字都没收到（没有多出回合）；
// ⑤ 任务在跑时也能派，不排队；
// ⑥ 派失败：人、做法、字都留着，说清楚哪儿没成；
// ⑦ 有驳回等裁定 / 答题卡在时：框顶任何时候只有一行——叫着人是做法那一行，不叫了换回裁定那一行；
//    答题卡展开着两者都不出；
// ⑧ 派不出去的地方（团队执行者）：没有那一行，`@` 只是问一句；
// ⑨ `/派`：从没叫过人就先开 `@` 菜单，选中的直接停在「派出去」；叫过就叫上次那个人，后面的话留在框里。
//    那张菜单没选人就收起：「停在派出去」跟着作废，之后普通的 `@` 照旧停在「问一句」；
// ⑩ 从哪开工没读到：不是「没得选」——拦着不让派、说清楚，给一颗重试，读到了照这条任务的分支开工；
// ⑪ 派出去还没回来时又换了做法、写了下一句：回来只清发出去的那一版，下一句的人和做法留着；
// ⑫ 叫着人派出去时敲命令：发送键照实写这一按干的事（叫人），不写「派出去」。
// 跑法：npm -w web run test:reply-call-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { waitUntil } from "./wait-until.mjs";

const PROFILES = [
  { id: "profile-codex", name: "codex@local", type: "codex", isDefault: true },
  { id: "profile-claude", name: "claude@local", type: "claude", isDefault: true },
];

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const requests = [];
  let branchesFail = true;
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/agents") return json(PROFILES);
    if (path === "/projects") return json([{ id: "p1", name: "p1", useWorktreeDefault: true }, { id: "p2", name: "p2", useWorktreeDefault: true }]);
    if (path === "/projects/p2/health") return json({ isRepo: true });
    if (path === "/projects/p2/branches") {
      return branchesFail ? json({ error: "分支读取失败（夹具）" }, 503) : json({ branches: ["main", "ash/t-flaky"], current: "main" });
    }
    if (path === "/projects/p1/health") return json({ isRepo: true });
    if (path === "/projects/p1/branches") return json({ branches: ["main", "ash/t-send", "ash/t-runnin", "ash/t-fail"], current: "main" });
    let match = /^\/tasks\/([^/]+)\/sessions$/.exec(path);
    if (match) return json([{ id: "s1", taskId: match[1], startedAt: "2026-11-15T01:00:00.000Z", transcriptPath: `/runs/${match[1]}/s1.md` }]);
    if (path === "/tasks" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      requests.push({ kind: "create", body });
      if (body.dispatchedBy === "t-fail") return json({ error: "建任务失败（夹具）" }, 500);
      if (body.dispatchedBy === "t-slow") await slowGate;
      return json({ ...body, id: `child-${body.dispatchedBy}`, status: "backlog", createdAt: "2026-11-15T02:00:00.000Z", updatedAt: "2026-11-15T02:00:00.000Z" }, 201);
    }
    match = /^\/tasks\/([^/]+)\/(run|reply)$/.exec(path);
    if (match) {
      requests.push({ kind: match[2], task: match[1] });
      return json({});
    }
    return json([]);
  });
  await page.goto(`${web.origin}/scripts/fixtures/reply-call.html`);

  const scope = (name) => page.locator(`.${name}-fixture`);
  const input = (name) => scope(name).getByRole("textbox", { name: "回复任务" });
  const rows = (name) => scope(name).locator(".reply-dock-row");
  const row = (name, agent) => scope(name).getByRole("group", { name: `叫 ${agent} 来做什么` });
  const key = (name, agent, label) => row(name, agent).getByRole("button", { name: label, exact: true });
  const agentChip = (name) => scope(name).getByRole("button", { name: /^智能体：/ });
  const logged = (name) => page.evaluate((key) => window[key] ?? [], name);
  const call = async (name, text, agent) => {
    await input(name).fill(`${text}@${agent.slice(0, 2)}`);
    await scope(name).getByRole("option", { name: new RegExp(`@${agent}`) }).click();
    await row(name, agent).waitFor();
  };
  await input("ask").waitFor();

  // ⑨-0 `/派`，还没叫过任何人，开了菜单却没选人就 Esc：「停在派出去」跟着作废。
  await input("slash").fill("/派");
  await scope("slash").getByRole("option", { name: /\/派/ }).waitFor();
  await input("slash").press("Enter");
  await scope("slash").getByRole("option", { name: /@codex/ }).waitFor();
  await input("slash").press("Escape");
  await waitUntil(async () => (await scope("slash").getByRole("option", { name: /@codex/ }).count()) === 0, "Esc 收起选人菜单");
  await input("slash").fill("另问一件事 @co");
  await scope("slash").getByRole("option", { name: /@codex/ }).click();
  await row("slash", "codex").waitFor();
  assert.equal(await key("slash", "codex", "问一句").getAttribute("aria-pressed"), "true", "放弃过的 /派 不留给之后的普通 @");
  assert.equal(await scope("slash").getByRole("button", { name: "问 codex", exact: true }).count(), 1);
  await scope("slash").getByRole("button", { name: "不叫 codex 了" }).click();

  // ⑨-a `/派`，还没叫过任何人：先开 `@` 菜单，选中的直接停在「派出去」。
  await input("slash").fill("/派");
  await scope("slash").getByRole("option", { name: /\/派/ }).waitFor();
  await input("slash").press("Enter");
  assert.equal(await input("slash").inputValue(), "@", "没叫过人：框里落一个 @ 让选");
  await scope("slash").getByRole("option", { name: /@codex/ }).click();
  await row("slash", "codex").waitFor();
  assert.equal(await key("slash", "codex", "派出去").getAttribute("aria-pressed"), "true", "/派 选中的人直接停在「派出去」");
  await scope("slash").getByRole("button", { name: "不叫 codex 了" }).click();
  assert.equal(await rows("slash").count(), 0);

  // ① 选完人默认「问一句」，不弹选模型；胶囊换成他，发送键写「问 codex」。
  await call("ask", "看一下这个改法 ", "codex");
  assert.equal(await page.getByRole("listbox", { name: "可选模型" }).count(), 0, "选完人不再接着弹选模型");
  assert.equal(await key("ask", "codex", "问一句").getAttribute("aria-pressed"), "true", "默认停在「问一句」");
  assert.equal(await key("ask", "codex", "派出去").getAttribute("aria-pressed"), "false");
  assert.match(await agentChip("ask").getAttribute("aria-label") ?? "", /^智能体：codex/, "胶囊换成被叫的人");
  assert.equal(await input("ask").inputValue(), "看一下这个改法 ", "@codex 是指令不是内容，从正文里摘掉");
  assert.equal(await input("ask").getAttribute("placeholder"), "问 codex…");
  // 要改模型照现有做法点胶囊。
  await scope("ask").getByRole("button", { name: /^模型：/ }).click();
  await page.getByRole("option", { name: /^gpt-5\.6-sol/ }).click();
  await page.keyboard.press("Escape");
  await scope("ask").getByRole("button", { name: "问 codex", exact: true }).click();
  await waitUntil(async () => (await logged("__sent_ask")).length === 1, "问一句发出去");
  assert.deepEqual(await logged("__sent_ask"), [{ text: "看一下这个改法", agent: "codex", executorId: "profile-codex", model: "gpt-5.6-sol", reasoningEffort: null }],
    "问一句 = 原来的一次性召唤：执行器、模型随这一句走");
  await waitUntil(async () => (await rows("ask").count()) === 0, "发完不再叫着人");
  assert.match(await agentChip("ask").getAttribute("aria-label") ?? "", /^智能体：claude/, "发完退回任务自己的执行器");
  assert.equal(await scope("ask").getByRole("button", { name: "发送回复" }).count(), 1, "发送键回到平常那颗");

  // ② @ 这条任务自己的执行器：只有「派出去」。
  await call("self", "", "claude");
  assert.equal(await key("self", "claude", "派出去").getAttribute("aria-pressed"), "true", "自己默认就是派出去");
  assert.equal(await key("self", "claude", "问一句").getAttribute("aria-disabled"), "true", "问自己按不动");
  await key("self", "claude", "问一句").click({ force: true });
  assert.equal(await key("self", "claude", "派出去").getAttribute("aria-pressed"), "true", "点了也不换");
  assert.equal(await scope("self").getByRole("button", { name: "派出去", exact: true }).count(), 2, "框顶那颗 + 发送键「派出去」");

  // ③ 换做法、小叉、空框退格：字一个不丢；上次对他用的模型先摆上。
  await call("keep", "先写好的一段 ", "codex");
  assert.match(await scope("keep").getByRole("button", { name: /^模型：/ }).getAttribute("aria-label") ?? "", /gpt-5\.6-sol/, "记得上次对 codex 用的模型");
  await key("keep", "codex", "派出去").click();
  assert.equal(await input("keep").getAttribute("placeholder"), "交代清楚要做成什么样…");
  assert.equal(await input("keep").inputValue(), "先写好的一段 ", "换到派出去不丢字");
  await key("keep", "codex", "问一句").click();
  assert.equal(await input("keep").inputValue(), "先写好的一段 ", "换回问一句不丢字");
  await scope("keep").getByRole("button", { name: "不叫 codex 了" }).click();
  assert.equal(await rows("keep").count(), 0, "小叉：不叫了");
  assert.equal(await input("keep").inputValue(), "先写好的一段 ", "不叫了也不丢字");
  assert.match(await agentChip("keep").getAttribute("aria-label") ?? "", /^智能体：claude/);
  await call("keep", "", "codex");
  assert.equal(await input("keep").inputValue(), "");
  await input("keep").press("Backspace");
  assert.equal(await rows("keep").count(), 0, "空框里退格 = 不叫了");

  // ④ 派出去：建一条交给他的新任务，带着这场对话、挂在这条任务名下、从哪开工照胶囊；这条任务不收任何话。
  await call("send", "", "codex");
  await key("send", "codex", "派出去").click();
  const base = scope("send").getByRole("button", { name: /^新任务从哪开工：/ });
  await base.waitFor();
  assert.equal(await base.innerText(), "接着这里的代码", "默认接着这条任务的代码");
  await input("send").fill("补一组登录页的单测");
  await scope("send").getByRole("button", { name: "派出去", exact: true }).last().click();
  await waitUntil(async () => (await logged("__created_send")).length === 1, "派出去建好了任务");
  const created = requests.filter((item) => item.kind === "create" && item.body.dispatchedBy === "t-send");
  assert.equal(created.length, 1);
  const body = created[0].body;
  assert.equal(body.mode, "single");
  assert.equal(body.agentType, "codex");
  assert.equal(body.model, "gpt-5.6-sol", "交给他时用的是胶囊上那一套");
  assert.equal(body.worktreeBase, "ash/t-send", "接着这里的代码 = 从这条任务的分支开工");
  assert.equal(body.title, "补一组登录页的单测");
  assert.equal(body.autoTitle, true);
  assert.ok(body.body.startsWith("补一组登录页的单测"), "写的那句话是新任务要做的事");
  assert.match(body.body, /## 来源普通任务\n任务标题：叫人\n把登录页改成新样式/, "带着来源任务");
  assert.match(body.body, /\/runs\/t-send\/s1\.md/, "带着这场对话的会话记录");
  assert.ok(requests.some((item) => item.kind === "run" && item.task === "child-t-send"), "建完就起跑");
  assert.ok(!requests.some((item) => item.task === "t-send"), "这条任务自己没有被叫醒、没有多出回合");
  assert.deepEqual(await logged("__sent_send"), [], "没走回复那条路");
  await waitUntil(async () => (await rows("send").count()) === 0, "派完不再叫着人");
  assert.equal(await input("send").inputValue(), "");

  // ⑤ 任务在跑时也能派，立即建，不排队；「从 main 开工」点一下就换。
  await call("running", "", "codex");
  await key("running", "codex", "派出去").click();
  const runningBase = scope("running").getByRole("button", { name: /^新任务从哪开工：/ });
  await runningBase.click();
  assert.equal(await runningBase.innerText(), "从 main 开工");
  await input("running").fill("顺手修一下文案");
  assert.equal(await scope("running").getByRole("button", { name: /^(停止|排队发送)/ }).count(), 0, "在跑时这一按也是「派出去」，不是停止、不是排队");
  await scope("running").getByRole("button", { name: "派出去", exact: true }).last().click();
  await waitUntil(async () => (await logged("__created_running")).length === 1, "在跑时照样派出去");
  assert.equal(requests.find((item) => item.kind === "create" && item.body.dispatchedBy === "t-running").body.worktreeBase, "main");
  assert.ok(!requests.some((item) => item.task === "t-running"), "在跑的那条任务不收任何话");
  assert.deepEqual(await logged("__sent_running"), []);

  // ⑥ 派失败：人、做法、字都留着。
  await call("fail", "", "codex");
  await key("fail", "codex", "派出去").click();
  await input("fail").fill("这一条会失败");
  await scope("fail").getByRole("button", { name: "派出去", exact: true }).last().click();
  await scope("fail").locator(".task-reply-error").waitFor();
  assert.match(await scope("fail").locator(".task-reply-error").innerText(), /建任务失败/);
  assert.equal(await key("fail", "codex", "派出去").getAttribute("aria-pressed"), "true", "失败后还停在派出去");
  assert.equal(await input("fail").inputValue(), "这一条会失败", "失败后字还在");
  assert.match(await agentChip("fail").getAttribute("aria-label") ?? "", /^智能体：codex/, "失败后人还在");

  // ⑦-a 有驳回等裁定：框顶只有一行，叫着人是做法那一行，不叫了换回裁定那一行。
  await scope("ruling").getByRole("group", { name: "怎么裁定这条驳回" }).waitFor();
  assert.equal(await rows("ruling").count(), 1);
  await call("ruling", "", "codex");
  assert.equal(await rows("ruling").count(), 1, "叫着人：框顶只有做法那一行");
  assert.equal(await scope("ruling").getByRole("group", { name: "怎么裁定这条驳回" }).count(), 0);
  await scope("ruling").getByRole("button", { name: "不叫 codex 了" }).click();
  await scope("ruling").getByRole("group", { name: "怎么裁定这条驳回" }).waitFor();
  assert.equal(await rows("ruling").count(), 1, "不叫了：换回裁定那一行");

  // ⑦-b 答题卡展开着：两者都不出；收起来才有回复框和那一行。
  const card = scope("question").getByRole("region", { name: "等待答复的问题" });
  await card.waitFor();
  assert.equal(await rows("question").count(), 0);
  await scope("question").getByRole("button", { name: "收起答题卡，先看上文" }).click();
  await call("question", "", "codex");
  assert.equal(await rows("question").count(), 1);
  await scope("question").locator(".question-card-peek").click();
  await scope("question").getByRole("button", { name: "收起答题卡，先看上文" }).waitFor();
  assert.equal(await rows("question").count(), 0, "答题卡展开着：做法那一行也不出");
  assert.equal(await scope("question").locator(".task-reply-box").count(), 0, "只有一处打字的地方");

  // ⑧ 团队执行者：派不出去，没有那一行，@ 只是问一句。
  await input("member").fill("问问 @co");
  await scope("member").getByRole("option", { name: /@codex/ }).click();
  await waitUntil(async () => /^智能体：codex/.test(await agentChip("member").getAttribute("aria-label") ?? ""), "团队执行者里叫上 codex");
  assert.equal(await rows("member").count(), 0, "派不出去的地方不摆做法那一行");
  assert.match(await agentChip("member").getAttribute("aria-label") ?? "", /^智能体：codex/);
  await scope("member").getByRole("button", { name: "问 codex", exact: true }).click();
  await waitUntil(async () => (await logged("__sent_member")).length === 1, "团队执行者里问一句");
  assert.equal((await logged("__sent_member"))[0].agent, "codex");

  // ⑨-b `/派 …`，叫过人了：叫上次那个人（codex），停在派出去，后面的话留在框里。
  await input("slash").fill("/派 写一份接口文档");
  await scope("slash").getByRole("button", { name: "叫人", exact: true }).click();
  await row("slash", "codex").waitFor();
  assert.equal(await key("slash", "codex", "派出去").getAttribute("aria-pressed"), "true");
  assert.equal(await input("slash").inputValue(), "写一份接口文档");

  // ⑩ 从哪开工没读到：拦着不让派，给重试；读到了照这条任务的分支开工。
  await call("flaky", "", "codex");
  await key("flaky", "codex", "派出去").click();
  await input("flaky").fill("接着这里补测试");
  const baseError = scope("flaky").locator(".reply-dock-error");
  await baseError.waitFor();
  assert.match(await baseError.innerText(), /确认不了新任务从哪开工/);
  const flakySend = scope("flaky").getByRole("button", { name: "派出去", exact: true }).last();
  assert.equal(await flakySend.isDisabled(), true, "没读到从哪开工：不让派，不按默认悄悄从别处开工");
  assert.equal(await scope("flaky").getByRole("button", { name: /^新任务从哪开工：/ }).count(), 0);
  await key("flaky", "codex", "问一句").click();
  await key("flaky", "codex", "派出去").click();
  await baseError.waitFor();
  assert.equal(await flakySend.isDisabled(), true, "读失败不缓存成「没得选」：再进来照样读、照样拦");
  branchesFail = false;
  await scope("flaky").getByRole("button", { name: "重试", exact: true }).click();
  await scope("flaky").getByRole("button", { name: /^新任务从哪开工：/ }).waitFor();
  assert.equal(await baseError.count(), 0);
  await flakySend.click();
  await waitUntil(async () => (await logged("__created_flaky")).length === 1, "读到之后派出去");
  assert.equal(requests.find((item) => item.kind === "create" && item.body.dispatchedBy === "t-flaky").body.worktreeBase, "ash/t-flaky");

  // ⑪ 派出去还没回来：换回问一句、写下一句；回来后下一句的人和做法都还在。
  await call("slow", "", "codex");
  await key("slow", "codex", "派出去").click();
  await input("slow").fill("这一条先派出");
  await scope("slow").getByRole("button", { name: "派出去", exact: true }).last().click();
  await waitUntil(async () => requests.some((item) => item.kind === "create" && item.body.dispatchedBy === "t-slow"), "派出去的请求发出");
  await key("slow", "codex", "问一句").click();
  await input("slow").fill("这是下一句，要问 codex 的");
  releaseSlow();
  await waitUntil(async () => (await logged("__created_slow")).length === 1, "上一条派出去回来了");
  await waitUntil(async () => await scope("slow").getByRole("button", { name: "问 codex", exact: true }).isEnabled(), "发送结束");
  assert.equal(await input("slow").inputValue(), "这是下一句，要问 codex 的", "下一句的字留着");
  assert.equal(await key("slow", "codex", "问一句").getAttribute("aria-pressed"), "true", "下一句的做法留着");
  assert.match(await agentChip("slow").getAttribute("aria-label") ?? "", /^智能体：codex/, "下一句的人留着");

  // ⑫ 叫着人派出去时敲命令：发送键写这一按干的事。
  await key("slow", "codex", "派出去").click();
  await input("slow").fill("/派");
  await scope("slow").getByRole("option", { name: /\/派/ }).waitFor();
  assert.equal(await scope("slow").getByRole("button", { name: "叫人", exact: true }).count(), 1, "这一按是叫人");
  assert.equal(await scope("slow").getByRole("button", { name: "派出去", exact: true }).count(), 1, "只剩框顶那颗「派出去」");

  console.log("reply call dom test passed");
} finally {
  await browser?.close();
  await web.close();
}
