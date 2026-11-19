// 答题卡（task-detail/QuestionCard.tsx + QuestionSlot.tsx）在真浏览器里：停在回复框那一格、全页只有一处
// 打字一颗发送键、勾选不抄进输入框而答复里有它、多题跳题与「下一题 / 发送答复」、数字键与最后一格、
// 收起后平常的回复框出现、那一轮没结束点不动、发送失败答案不丢、问题全文只出现一次、自由回复区能贴图。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS, waitUntil } from "./wait-until.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PROFILES = [
  { id: "profile-codex", name: "codex@local", type: "codex", isDefault: true },
  { id: "profile-claude", name: "claude@local", type: "claude", isDefault: true },
];

const web = await startWebServer();
let browser;
const failures = [];
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  page.setDefaultTimeout(WAIT_TIMEOUT_MS);
  page.on("pageerror", (error) => failures.push(error.message));
  // 夹具不该连服务端；会话区那几条后台读取（挡回记录之类）给空的。上传扣住不放，等用例放行：
  // 「还在传」那一段要看得见。
  const held = new Map();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/agents") return route.fulfill({ json: PROFILES });
    if (path !== "/api/uploads" || request.method() !== "POST") return route.fulfill({ json: [] });
    const { name } = JSON.parse(request.postData() ?? "{}");
    await new Promise((resolve) => held.set(name, resolve));
    await route.fulfill({ json: { id: `up-${name}`, path: `/navi/data/uploads/up12345678ab-${name}`, url: `data:image/png;base64,${PNG}`, name, kind: "image" } })
      .catch(() => {});
  });
  await page.goto(`${web.origin}/scripts/fixtures/question-card.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const card = page.locator(".question-card");
  const send = card.locator(".question-card-send");
  const note = card.locator(".question-card-note textarea");
  const replyBox = page.getByRole("textbox", { name: "回复任务" });
  const option = (name) => card.getByRole("button", { name, exact: true });
  const visibleInputs = () => page.locator("textarea:visible, input[type=text]:visible").count();

  // 卡停在回复框那一格（会话滚动区外面），展开时平常那个框不出现：全页一处输入、一颗发送键。
  await card.waitFor();
  assert.equal(await page.locator(".task-conversation .question-card").count(), 0);
  assert.equal(await page.locator(".task-reply-shell > .question-dock > .question-card").count(), 1);
  assert.equal(await replyBox.isVisible(), false, "卡展开时不出现平常的回复框");
  assert.equal(await visibleInputs(), 1, "全页只有一处打字的地方");
  assert.equal(await page.locator("button:visible", { hasText: /^(发送答复|下一题)$/ }).count(), 1, "只有一颗发送键");
  // 卡刚出现时不抢焦点。
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".question-card") ? "card" : "elsewhere"), "elsewhere");
  // 问题全文只出现一次：会话里那句「以提问暂停,等待答复:「…」」不画。
  const mainText = await page.locator("main").innerText();
  assert.equal(mainText.split("开始前，确认两个细节。").length - 1, 1, "共同背景只出现在卡上");
  assert.equal(mainText.split("回答过的卡片放在哪里？").length - 1, 1, "题目只出现在卡上");
  assert.doesNotMatch(mainText, /以提问暂停/);

  // 什么都没答时那颗键点不动；勾了就是选了，不把那句话抄进输入框。
  assert.equal(await send.innerText(), "下一题");
  assert.equal(await send.isDisabled(), true);
  await option("留在会话里，点击展开").click();
  assert.equal(await option("留在会话里，点击展开").getAttribute("aria-pressed"), "true");
  assert.equal(await note.inputValue(), "", "勾选不再写进输入框");
  assert.equal(await card.getByRole("button", { name: "第 1 题（已答）" }).count(), 1);
  assert.equal(await send.isDisabled(), false);

  // 下一题：焦点落在第一个选项上，数字键立刻能按；按下一个数字（最后一格）光标落进输入行。
  await send.click();
  assert.match(await card.locator(".question-card-title").innerText(), /发给智能体的回复保留哪些内容/);
  assert.equal(await card.getByText("同时提供历史入口").count(), 0, "一次只出一题");
  assert.equal(await send.innerText(), "发送答复", "到最后一题那颗键写「发送答复」");
  await page.waitForFunction(() => document.activeElement?.matches(".question-card-options button"));
  await page.keyboard.press("2");
  assert.equal(await option("加一句简短说明").getAttribute("aria-pressed"), "true");
  await page.keyboard.press("3");
  assert.equal(await page.evaluate(() => document.activeElement?.matches(".question-card-note textarea")), true, "最后一格的数字把光标送进输入行");
  // 焦点在输入框里时数字是字，不是勾选。
  await page.keyboard.type("1 份就够");
  assert.equal(await note.inputValue(), "1 份就够");
  assert.equal(await option("只发答案和必要编号").getAttribute("aria-pressed"), "false");

  // 题号跳题：回到第 1 题，勾的还在；题号上看得出答过。
  await card.getByRole("button", { name: "第 1 题（已答）" }).click();
  assert.equal(await option("留在会话里，点击展开").getAttribute("aria-pressed"), "true");
  assert.equal(await send.innerText(), "下一题");

  // 收起：只剩题目一行，平常的回复框出现在它下面；再展开，勾的写的都不丢。
  await card.getByRole("button", { name: "收起答题卡，先看上文" }).click();
  assert.equal(await card.locator(".question-card-peek").innerText(), "回答过的卡片放在哪里？");
  assert.equal(await replyBox.isVisible(), true, "收起后出现平常的回复框");
  assert.equal(await visibleInputs(), 1, "收起后仍只有一处打字的地方");
  await card.locator(".question-card-peek").click();
  assert.equal(await replyBox.isVisible(), false);
  assert.equal(await option("留在会话里，点击展开").getAttribute("aria-pressed"), "true");
  await card.getByRole("button", { name: "第 2 题（已答）" }).click();
  assert.equal(await note.inputValue(), "1 份就够");

  // 发送失败：说得出来，答案不丢。
  await page.getByLabel("模拟发送失败").check();
  await send.click();
  await card.getByRole("alert").waitFor();
  assert.match(await card.getByRole("alert").innerText(), /发送失败/);
  assert.equal(await note.inputValue(), "1 份就够");
  assert.equal(await option("加一句简短说明").getAttribute("aria-pressed"), "true");

  // 发出去的答复 = 勾了的几项 + 补充的话，形状跟从前一样；已答气泡照样认得出选了哪几项。
  await page.getByLabel("模拟发送失败").uncheck();
  await send.click();
  await page.getByLabel("发给智能体的回复", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("发给智能体的回复", { exact: true }).innerText(), "【答复】\n1. 留在会话里，点击展开\n2. 加一句简短说明\n1 份就够");
  await card.waitFor({ state: "detached" });
  assert.equal(await replyBox.isVisible(), true, "答完卡收回，平常的回复框回来");
  const bubble = page.locator(".task-question-record").last();
  await bubble.locator(".task-question-quote").filter({ hasText: "发给智能体的回复保留哪些内容" }).click();
  assert.equal(await bubble.locator("li.is-selected").innerText(), "加一句简短说明", "已答气泡标出选了哪一项");

  // 那一轮还没结束：选项点不动，最后一行写着什么时候能答。
  await page.getByRole("button", { name: "单题" }).click();
  await card.waitFor();
  assert.equal(await send.innerText(), "发送答复");
  assert.equal(await card.locator(".question-card-steps").count(), 0);
  await page.getByRole("button", { name: "切换提问状态" }).click();
  assert.equal(await option("清楚展示问题").isDisabled(), true);
  assert.equal(await note.getAttribute("placeholder"), "这一轮结束后即可答复");
  assert.equal(await note.isDisabled(), true);
  await page.getByRole("button", { name: "切换提问状态" }).click();
  assert.equal(await option("清楚展示问题").isDisabled(), false);

  // 没有选项：最后一行就是「写下你的答案…」，写了才能发。
  await page.getByRole("button", { name: "没有选项" }).click();
  await card.locator(".question-card-options").waitFor({ state: "detached" });
  assert.equal(await note.getAttribute("placeholder"), "写下你的答案…");
  assert.equal(await send.isDisabled(), true);
  await note.fill("ask-card");
  assert.equal(await send.isDisabled(), false);

  // 自由回复区能贴图：粘贴进来先挂成「上传中」、这时发不出去；传完图跟着答复一起发出，答过的气泡里看得见。
  await note.evaluate((textarea, png) => {
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await card.locator(".task-upload-chip.is-uploading").waitFor();
  assert.equal(await note.inputValue(), "ask-card", "贴图不动输入框里的字");
  assert.equal(await send.isDisabled(), true, "图还在传时发不出去");
  await waitUntil(() => held.has("shot.png"), "贴的图发出上传请求");
  held.get("shot.png")();
  await card.locator(".task-upload-chip:not(.is-uploading)").waitFor();
  assert.equal(await send.isDisabled(), false);
  assert.equal(await card.getByRole("button", { name: "上传附件" }).count(), 1, "最后一行也有回形针");
  await send.click();
  await card.waitFor({ state: "detached" });
  assert.match(await page.getByLabel("发给智能体的回复", { exact: true }).innerText(), /ask-card\n\n\[用户附带的文件[^\]]*\]\n- \/navi\/data\/uploads\/up12345678ab-shot\.png$/, "图跟着答复一起发出");
  const answered = page.locator(".task-question-record").last();
  assert.equal(await answered.locator(".task-message-image img").count(), 1, "答过的气泡里画出贴的图");
  assert.doesNotMatch(await answered.innerText(), /用户附带的文件/, "附件块不当成答案文字");

  // 收起再展开以后，多行补充照样跟着行数长高（输入框换了新节点，撑高的记账跟着重来）。
  await page.getByRole("button", { name: "重置" }).click();
  await card.waitFor();
  const fits = () => note.evaluate((el) => el.clientHeight >= el.scrollHeight - 1);
  await note.fill("第一行\n第二行\n第三行\n第四行");
  assert.equal(await fits(), true, "多行补充撑开输入框");
  await card.getByRole("button", { name: "收起答题卡，先看上文" }).click();
  await card.locator(".question-card-peek").click();
  assert.equal(await note.inputValue(), "第一行\n第二行\n第三行\n第四行");
  assert.equal(await fits(), true, "展开后多行补充仍然撑开");
  await note.press("End");
  await note.pressSequentially("\n第五行");
  assert.equal(await fits(), true, "展开后继续写还会长高");

  // 答题卡接管的是整套输入：普通回复框里敲到一半的斜杠菜单，在卡展开时跟着退下，草稿原样留着。
  await page.getByRole("button", { name: "撤下提问" }).click();
  await card.waitFor({ state: "detached" });
  await replyBox.fill("/讨");
  const slashMenu = page.locator(".task-reply-command-menu");
  await slashMenu.getByRole("option", { name: /\/讨论/ }).waitFor();
  await page.evaluate(() => window.fixtureAsk());
  await card.waitFor();
  assert.equal(await slashMenu.count(), 0, "卡展开时普通回复框的补全菜单不能还挂着");
  assert.equal(await visibleInputs(), 1);
  await card.getByRole("button", { name: "收起答题卡，先看上文" }).click();
  assert.equal(await replyBox.inputValue(), "/讨", "收起后普通回复的草稿原样在");
  await card.locator(".question-card-peek").click();

  // 框里的工具开出来的浮层（选执行器、发送设置、截图批注）都 portal 在 body 上：卡展开时它们跟着框一起
  // 不挂，不是框藏起来了、浮层还开着能打字。题是推来的（fixtureAsk）——点页面上任何一颗键都会先把浮层
  // 点关，那样验不出来。收起以后浮层不自己弹回来，草稿原样在，换了新节点的输入框照样长高。
  const composerLayers = ".agent-model-picker, .send-key-panel, .annotation-dialog";
  const openThenAsk = async ({ input, open, layer, what }) => {
    await page.getByRole("button", { name: "撤下提问" }).click();
    await card.waitFor({ state: "detached" });
    await input.fill("先写一半的话");
    await open();
    await page.locator(layer).waitFor();
    await page.evaluate(() => window.fixtureAsk());
    await card.waitFor();
    assert.equal(await page.locator(composerLayers).count(), 0, `${what}：卡展开时普通回复框的浮层不能还挂着`);
    assert.equal(await visibleInputs(), 1, `${what}：卡展开时全页仍只有一处打字的地方`);
    assert.equal(await page.locator("button:visible", { hasText: /^(发送答复|下一题)$/ }).count(), 1, `${what}：只有一颗发送键`);
    await card.getByRole("button", { name: "收起答题卡，先看上文" }).click();
    await input.waitFor();
    assert.equal(await page.locator(composerLayers).count(), 0, `${what}：收起后浮层不自己弹回来`);
    assert.equal(await input.inputValue(), "先写一半的话", `${what}：草稿原样在`);
    await input.fill("一\n二\n三\n四\n五\n六");
    assert.equal(await input.evaluate((el) => el.clientHeight >= el.scrollHeight - 1), true, `${what}：收起后回来的输入框照样跟着行数长高`);
    await input.fill("");
  };
  await openThenAsk({ input: replyBox, what: "选执行器",
    open: () => page.locator(".task-reply-box").getByRole("button", { name: /^智能体：/ }).click(), layer: ".agent-model-picker" });
  await openThenAsk({ input: replyBox, what: "发送设置",
    open: () => page.locator(".task-reply-box .send-key-opt").click(), layer: ".send-key-panel" });
  await openThenAsk({ input: replyBox, what: "截图批注", layer: ".annotation-dialog", open: async () => {
    await page.locator(".task-reply-box .task-reply-more button").first().click();
    await page.getByRole("menuitem", { name: "截图批注" }).click();
  } });

  // 改发别的话把题撤下（不留问答记录）：那道题只剩会话里那句结算说明能看，它照画；
  // 题目在答题卡上、或答完跟着气泡留着的那几道，结算说明不画。
  await page.getByRole("button", { name: "重置" }).click();
  await card.waitFor();
  assert.equal(await page.locator(".turn-receipts-toggle").count(), 0, "题在卡上时那句结算说明不画");
  await page.getByRole("button", { name: "撤下提问" }).click();
  await card.waitFor({ state: "detached" });
  await page.locator(".turn-receipts-toggle").click();
  assert.match(await page.locator(".task-conversation").innerText(), /开始前，确认两个细节。/, "撤下的旧题仍能在会话里读到");

  // 窄屏不横向溢出。
  await page.setViewportSize({ width: 360, height: 720 });
  await page.getByRole("button", { name: "重置" }).click();
  await card.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "窄屏不横向溢出");

  // 窄屏一次选一大批图：附件区在自己里面滚，最后一行和发送键始终留在卡里、看得见。
  const names = Array.from({ length: 24 }, (_, i) => `many-${i}.png`);
  await card.locator("input[type=file]").setInputFiles(names.map((name) => ({ name, mimeType: "image/png", buffer: Buffer.from(PNG, "base64") })));
  for (const name of names) {
    await waitUntil(() => held.has(name), `${name} 发出上传请求`);
    held.get(name)();
  }
  await waitUntil(async () => await card.locator(".task-upload-chip:not(.is-uploading)").count() === names.length, "整批图都传完");
  const uploadList = card.locator(".task-upload-list");
  assert.equal(await uploadList.evaluate((el) => el.scrollHeight > el.clientHeight), true, "图多了附件区在自己里面滚");
  const [cardBox, sendBox] = [await card.boundingBox(), await send.boundingBox()];
  assert.ok(sendBox.y >= cardBox.y && sendBox.y + sendBox.height <= cardBox.y + cardBox.height, "发送键没被挤出卡外");
  assert.ok(sendBox.y + sendBox.height <= 720, "发送键在视口里");
  assert.equal(await note.isVisible(), true, "输入行还在");

  // 团队页同一副形状：TeamReplyBox 的发送设置开着时题到了，一样跟着框退下。
  await page.goto(`${web.origin}/scripts/fixtures/question-card.html?host=team`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await card.waitFor();
  assert.equal(await page.locator(".team-reply-box").count(), 0, "团队页卡展开时平常的框不挂");
  assert.equal(await visibleInputs(), 1);
  await openThenAsk({ input: page.locator(".team-reply-box textarea"), what: "团队页发送设置",
    open: () => page.locator(".team-reply-box .send-key-opt").click(), layer: ".send-key-panel" });

  assert.deepEqual(failures, []);
  console.log("question card DOM: docked in the reply slot, one input + one send key (composer portals unmounted in task and team hosts), picks not copied but sent, jump/next/send switch, digit keys + last cell, collapse shows the reply box, settling locked, failure keeps answers, question shown once, pasted images ride along with the answer, narrow screen (incl. many images keep the send row) passed");
} finally {
  await browser?.close();
  await web.close();
}
