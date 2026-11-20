// 回复框顶上那一行「可以派出去的活」（suggestions/useSuggestionDock.tsx + SuggestionDock.tsx + SuggestionReader.tsx），
// 和正文任何位置都能敲的 `/派`、`/讨论`（useReplySlash.ts + lib/slashMatch.ts）。
//
// 盯的是：
// ① 一件：行尾「派出去」一按就派——照那一行此刻的样子（交给谁默认同这里、从主分支开工），派完那一行没了；
// ② 点标题 = 选中：框变成「补一句」（框里已有的字算补的话），右下角写「派出去」，行尾那颗和底栏胶囊收起；
//    从哪开工两段可换、点完焦点回到框里；完整说明从左边出，「改」了标题和正文，派出去的就是改过的；
//    Esc 退出选中、字留着；选中时回车 = 带着那句话派出去，派完框清空；
// ③ 好几件：平时一行「N 件可以派出去」，点开一行一件；叉掉一件打 DELETE；「一个接一个」+「全部派出去」；
//    收起那一段 = 退出选中；
// ④ 框顶只有一行：叫着人时让给叫人那一行、不叫了回来；有驳回等裁定时让给裁定那一行；
// ⑥ 这条任务的分支已经清掉了：「接着这条的代码」没了，建议说的从主分支开工照旧落在合入目标上，
//    不落到项目此刻检出的那一支；
// ⑤ `/派` 在句中：从菜单里选中只拿掉命令（两边空格并成一个）、光标留在原处、叫上次那个人停在「派出去」；
//    `/讨论` 句中也出；a/b、web/、http:// 不弹；输入法组字时不弹；句中敲全了 `/派` 没从菜单选、直接发 = 原样发出去。
// 跑法：npm -w web run test:dispatch-suggestion-dom
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  // 叫过 codex：`/派` 直接叫他，不再先开 `@` 菜单（没叫过人的那一路在 test-reply-call-dom.mjs）。
  await page.addInitScript(() => localStorage.setItem("navi:reply-call", JSON.stringify({ last: "codex", byAgent: {} })));
  const requests = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/agents") return json(PROFILES);
    if (path === "/projects") return json([{ id: "p1", name: "p1", useWorktreeDefault: true }]);
    if (path === "/projects/p1/health") return json({ isRepo: true });
    if (path === "/projects/p1/branches") {
      return json({ branches: ["main", "navi/t-one", "navi/t-arm", "navi/t-three", "navi/t-ruling", "navi/t-slash", "release"], current: "main" });
    }
    let match = /^\/tasks\/([^/]+)\/dispatch-suggestions\/launch$/.exec(path);
    if (match) {
      requests.push({ kind: "launch", task: match[1], body: JSON.parse(request.postData() ?? "{}") });
      return json({ tasks: [] });
    }
    match = /^\/tasks\/([^/]+)\/dispatch-suggestions\/([^/]+)$/.exec(path);
    if (match && request.method() === "DELETE") {
      requests.push({ kind: "drop", task: match[1], id: match[2] });
      return json({ dropped: true });
    }
    match = /^\/tasks\/([^/]+)\/sessions$/.exec(path);
    if (match) return json([{ id: "s1", taskId: match[1], startedAt: "2026-11-17T01:00:00.000Z", transcriptPath: `/runs/${match[1]}/s1.md` }]);
    if (/\/file-search$/.test(path)) return json({ hits: [], more: false });
    return json([]);
  });
  await page.goto(`${web.origin}/scripts/fixtures/dispatch-suggestion.html`);

  const scope = (name) => page.locator(`.${name}-fixture`);
  const box = (name) => scope(name).locator("textarea");
  const dock = (name) => scope(name).getByRole("group", { name: "可以派出去的活" });
  const button = (name, label) => scope(name).getByRole("button", { name: label, exact: true });
  const standing = (name) => scope(name).getByRole("group", { name: "这个任务以后由谁来跑" });
  const launches = (task) => requests.filter((item) => item.kind === "launch" && item.task === task);
  const logged = (name) => page.evaluate((key) => window[key] ?? [], name);
  const caretAt = (name) => box(name).evaluate((element) => [element.selectionStart, element.selectionEnd]);
  const focused = (name) => box(name).evaluate((element) => document.activeElement === element);
  await dock("one").waitFor();

  // ① 一件：行尾「派出去」一按就派。
  const one = "修好斜杠菜单那条红测试";
  assert.equal(await standing("one").count(), 1, "没选中时底栏胶囊照常在");
  await waitUntil(async () => await button("one", `把「${one}」派出去`).isEnabled(), "读到从哪开工后能派");
  await button("one", `把「${one}」派出去`).click();
  await waitUntil(async () => launches("t-one").length === 1, "一件派出去");
  // 谁来审照那一行：智能体没说、卡上也没换就是默认审查者，这里没设默认，落成不审。
  assert.deepEqual(launches("t-one")[0].body, {
    order: "parallel",
    items: [{ id: "s-one", title: one, body: `## 目标\n${one}的完整说明`,
      target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null }, review: "none", worktreeBase: "main" }],
  }, "照那一行此刻的样子派：交给谁同这里、从主分支开工、没有补的话");
  await waitUntil(async () => (await dock("one").count()) === 0, "派完那一行没了");

  // ② 点标题 = 选中；框里已有的字算补的话。
  const arm = "拖高回复框后切走再回来高度没记住";
  await box("arm").fill("先写好的一段");
  await button("arm", `选中「${arm}」，补一句再派`).click();
  const armed = button("arm", `「${arm}」已选中，再点一下退出`);
  assert.equal(await armed.getAttribute("aria-pressed"), "true");
  assert.equal(await box("arm").getAttribute("aria-label"), `给「${arm}」补一句`);
  assert.equal(await box("arm").getAttribute("placeholder"), `给「${arm}」补一句（可不写）…`);
  assert.equal(await box("arm").inputValue(), "先写好的一段", "框里已有的字留着，算补的话");
  assert.equal(await button("arm", `把「${arm}」派出去`).count(), 0, "选中时行尾那颗收起（右下角那颗就是它）");
  assert.equal(await button("arm", "派出去").count(), 1, "右下角写「派出去」");
  assert.equal(await standing("arm").count(), 0, "交给谁写在框顶那一行上，底栏胶囊收起");
  assert.match(await dock("arm").innerText(), /和这条任务改的东西无关/, "选中时多一句为什么");
  const bases = scope("arm").getByRole("group", { name: "从哪开工" });
  assert.equal(await bases.getByRole("button", { name: "从 main 开工" }).getAttribute("aria-pressed"), "true", "默认从主分支开工");
  await bases.getByRole("button", { name: "接着这条的代码" }).click();
  assert.equal(await bases.getByRole("button", { name: "接着这条的代码" }).getAttribute("aria-pressed"), "true");
  await waitUntil(() => focused("arm"), "点完从哪开工，焦点回到框里");

  // 完整说明从左边出：交给谁、从哪开工、你补的话；「改」了标题和正文。
  await button("arm", "完整说明").click();
  const reader = page.getByRole("complementary", { name: `完整说明：${arm}` });
  await reader.waitFor();
  assert.match(await reader.locator("header").innerText(), /交给 claude@local · 接着这条的代码/);
  assert.match(await reader.innerText(), /你补的话\s*先写好的一段/);
  await reader.getByRole("button", { name: "改", exact: true }).click();
  await reader.getByRole("textbox", { name: "任务标题" }).fill("改过的标题");
  await reader.getByRole("textbox", { name: "完整说明" }).fill("## 改过的说明");
  await reader.getByRole("button", { name: "改好了", exact: true }).click();
  assert.match(await reader.innerText(), /改过的说明/, "改好了回到排好版的样子");
  await waitUntil(async () => (await button("arm", "「改过的标题」已选中，再点一下退出").count()) === 1, "改过的标题同步回那一行");
  await reader.getByRole("textbox", { name: "任务标题" }).count().then((count) => assert.equal(count, 0));
  await page.getByRole("button", { name: "关上完整说明" }).click();
  await waitUntil(async () => (await reader.count()) === 0, "抽屉关上");

  // Esc 退出选中，字留着；再选中，回车带着那句话派出去。
  await box("arm").focus();
  await box("arm").press("Escape");
  assert.equal(await box("arm").getAttribute("aria-label"), "回复任务", "Esc 退出选中");
  assert.equal(await box("arm").inputValue(), "先写好的一段", "退出选中不动字");
  assert.equal(await standing("arm").count(), 1, "底栏胶囊回来");
  await button("arm", "选中「改过的标题」，补一句再派").click();
  await box("arm").fill("高度要按任务记");
  await box("arm").press("Enter");
  await waitUntil(async () => launches("t-arm").length === 1, "回车派出去");
  assert.deepEqual(launches("t-arm")[0].body.items, [{
    id: "s-arm", title: "改过的标题", body: "## 改过的说明", extra: "高度要按任务记",
    target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null }, review: "none", worktreeBase: "navi/t-arm",
  }], "派出去的是改过的标题、正文、补的话和选的开工起点");
  await waitUntil(async () => (await box("arm").inputValue()) === "", "派完框清空");
  assert.equal(await dock("arm").count(), 0);
  assert.equal(await box("arm").getAttribute("aria-label"), "回复任务", "回到平常的框");
  assert.deepEqual(await logged("__sent_arm"), [], "这条任务自己一个字都没收到");

  // ④ 叫着人时框顶让给叫人那一行，不叫了回来。
  await box("three").fill("问问 @co");
  await scope("three").getByRole("option", { name: /@codex/ }).click();
  await scope("three").getByRole("group", { name: "叫 codex 来做什么" }).waitFor();
  assert.equal(await dock("three").count(), 0, "叫着人：让开");
  await button("three", "不叫 codex 了").click();
  await dock("three").waitFor();
  await box("three").fill("");

  // ③ 好几件：一行「3 件可以派出去」，点开一行一件。
  const toggle = (count) => button("three", `${count} 件可以派出去`);
  assert.equal(await toggle(3).getAttribute("aria-expanded"), "false");
  assert.equal(await button("three", "全部派出去").count(), 0, "收着时只有一行");
  await toggle(3).click();
  assert.equal(await scope("three").locator(".sg-list > li").count(), 3);
  await button("three", "选中「第一件」，补一句再派").click();
  assert.equal(await box("three").getAttribute("aria-label"), "给「第一件」补一句");
  await toggle(3).click();
  assert.equal(await box("three").getAttribute("aria-label"), "回复任务", "收起那一段 = 退出选中");
  await toggle(3).click();
  await scope("three").locator(".sg-list > li").nth(1).hover();
  await button("three", "不派「第二件」").click();
  await waitUntil(async () => requests.some((item) => item.kind === "drop" && item.id === "s-b"), "叉掉打 DELETE");
  await toggle(2).waitFor();
  await scope("three").getByRole("group", { name: "派出顺序" }).getByRole("button", { name: "一个接一个" }).click();
  await button("three", "全部派出去").click();
  await waitUntil(async () => launches("t-three").length === 1, "全部派出去");
  const all = launches("t-three")[0].body;
  assert.equal(all.order, "serial");
  assert.deepEqual(all.items.map((item) => [item.id, item.worktreeBase]), [["s-a", "main"], ["s-c", "main"]]);
  assert.equal("extra" in all.items[0] && all.items[0].extra !== undefined, false, "没选中就派：没有补的话");
  await waitUntil(async () => (await dock("three").count()) === 0, "全派完那一段没了");

  // ④ 有驳回等裁定：框顶是裁定那一行。
  await scope("ruling").getByRole("group", { name: "怎么裁定这条驳回" }).waitFor();
  assert.equal(await dock("ruling").count(), 0, "裁定在前，建议让开");

  // ⑥ 分支清掉了：只剩从合入目标开工，没有那一组可选，派出去落在 release 上。
  const gone = "分支清掉后还挂着的一件";
  await button("gone", `选中「${gone}」，补一句再派`).click();
  assert.equal(await scope("gone").getByRole("group", { name: "从哪开工" }).count(), 0, "只剩一种开工起点：不摆那一组");
  await button("gone", `「${gone}」已选中，再点一下退出`).click();
  await waitUntil(async () => await button("gone", `把「${gone}」派出去`).isEnabled(), "读到分支后能派");
  await button("gone", `把「${gone}」派出去`).click();
  await waitUntil(async () => launches("t-gone").length === 1, "分支清掉后照样派出去");
  assert.equal(launches("t-gone")[0].body.items[0].worktreeBase, "release", "从合入目标开工，不是项目此刻检出的那一支");

  // ⑦ 上线前的老派活单：没动过就照它说定的——一个接一个；开工起点不管写没写（没写读成 null = 不指定）都不交，
  //   服务端照存着的开工，不拿页面现算的起点盖掉旧单的缺省。
  await button("legacy", "2 件可以派出去").click();
  await waitUntil(async () => await button("legacy", "全部派出去").isEnabled(), "读到分支后能派");
  await button("legacy", "全部派出去").click();
  await waitUntil(async () => launches("t-legacy").length === 1, "老单子全部派出去");
  const old = launches("t-legacy")[0].body;
  assert.equal(old.order, "serial", "没改顺序：照老单子的一个接一个");
  assert.equal("worktreeBase" in old.items[0], false, "指定过分支、卡上没换：不交起点");
  assert.equal("worktreeBase" in old.items[1], false, "没写开工起点的旧单：也不交，照旧接口的「不指定」开工");

  // ⑤ 句中 `/派`：从菜单选中只拿掉命令，光标留在原处，叫上次那个人停在「派出去」。
  await box("slash").fill("前面的话 /派 后面的话");
  for (let index = 0; index < " 后面的话".length; index += 1) await box("slash").press("ArrowLeft");
  await scope("slash").getByRole("option", { name: /\/派/ }).waitFor();
  await box("slash").press("Enter");
  const row = scope("slash").getByRole("group", { name: "叫 codex 来做什么" });
  await row.waitFor();
  assert.equal(await row.getByRole("button", { name: "派出去", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await box("slash").inputValue(), "前面的话 后面的话", "只拿掉命令，两边空格并成一个");
  await waitUntil(async () => (await caretAt("slash"))[0] === "前面的话 ".length, "光标留在原处");
  await button("slash", "不叫 codex 了").click();

  // 文末、`/讨论`也一样；路径和网址不弹。
  await box("slash").fill("这个改法 /讨");
  await scope("slash").getByRole("option", { name: /\/讨论/ }).waitFor();
  for (const text of ["看 a/b", "改 web/src", "打开 http://x"]) {
    await box("slash").fill(text);
    await waitUntil(async () => (await scope("slash").getByRole("option").count()) === 0, `${text} 不弹`);
  }
  // 输入法组字时不弹，上屏了才弹。
  await box("slash").fill("");
  await box("slash").dispatchEvent("compositionstart", { data: "" });
  await box("slash").fill("先 /");
  await page.waitForTimeout(150);
  assert.equal(await scope("slash").getByRole("option").count(), 0, "组字时不弹");
  await box("slash").dispatchEvent("compositionend", { data: "/" });
  await scope("slash").getByRole("option", { name: /\/派/ }).waitFor();
  await box("slash").press("Escape");
  assert.equal(await box("slash").inputValue(), "先 /", "句中斜杠 Esc 只收菜单，不清正文");

  // 句中敲全了 `/派` 没从菜单选：普通正文，原样发出去。
  await box("slash").fill("我刚才输入了 /派 你去修");
  assert.equal(await scope("slash").getByRole("option").count(), 0);
  await box("slash").press("Enter");
  await waitUntil(async () => (await logged("__sent_slash")).length === 1, "原样发出去");
  assert.deepEqual(await logged("__sent_slash"), ["我刚才输入了 /派 你去修"]);

  console.log("dispatch suggestion dom test passed");
} finally {
  await browser?.close();
  await web.close();
}
