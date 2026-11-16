import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { resizeViewport } from "./wait-until.mjs";

// 回复框上方那一行「排队 N」,点开是几行(ScheduledMessageTray.tsx)。真浏览器钉住:收着只占一行且
// 带着自己最早那条和引导键;点开向上长、回复框不动;每条行尾的键按来源给;指到才出的键键盘与触屏够得着;
// 全文就地摊开;要留意的条数能跳过去;哨兵取消的确认框;任务 / 团队两个宿主同一副画法;四档宽度不横溢。
const artifacts = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
const web = await startWebServer();
const message = (index) => {
  const kind = index % 5;
  const time = new Date(Date.UTC(2026, 9, 24, 10, 0, index)).toISOString();
  return {
    id: `msg-${index}`, taskId: "task-a", text: kind === 0 || kind === 4
      ? `【哨兵事件】检查-${index}（monitorId=monitor-${index}）\nREGRESSION_FINISHED exitCode=${kind === 4 ? 1 : 0} monitor=${index}`
      : `输入-${index}\n${"保留完整的正文与排队顺序。".repeat(8)}<img src=x onerror=alert(1)>`,
    attachments: kind === 1 ? ["/tmp/brief.txt"] : [], agent: "codex", executorId: null, model: null, reasoningEffort: null,
    sessionRole: kind === 2 ? "reviewer" : null, origin: kind === 0 || kind === 4 ? `monitor:${index}` : null,
    mode: kind === 3 ? "timed" : "queued", sendAt: time, status: "pending", createdAt: time, sentAt: null,
  };
};
let pending = Array.from({ length: 10 }, (_, index) => message(index));
let failCancel = false;
// 置成一个 Promise 时,排队消息列表的 GET 先扣住、等它放行再答 —— 用来摆出「入队回执晚于重拉」的次序。
let holdList = null;
let releaseCancel;
const deleted = [];
const steered = [];
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/tasks\/[^/]+\/scheduled-messages$/.test(path)) {
      if (holdList) await holdList;
      // 能不能引导由服务端判(task-steer-gate.ts):这里照它的口径,只给最早一条用户自己的排队消息。
      const first = pending.find((item) => item.mode === "queued" && !item.origin && !item.sessionRole);
      await route.fulfill({ json: pending.map((item) => ({ ...item, steerable: item === first })) });
    } else if (/\/scheduled-messages\/[^/]+\/steer$/.test(path)) {
      const messageId = path.split("/").at(-2);
      steered.push(messageId);
      pending = pending.filter((item) => item.id !== messageId);
      await route.fulfill({ json: {} });
    } else if (/\/scheduled-messages\/[^/]+$/.test(path) && route.request().method() === "DELETE") {
      const messageId = path.split("/").at(-1);
      deleted.push(messageId);
      if (failCancel) {
        await route.fulfill({ status: 409, json: { error: "取消失败，输入继续排队" } });
      } else {
        await new Promise((resolve) => { releaseCancel = resolve; });
        pending = pending.filter((item) => item.id !== messageId);
        await route.fulfill({ json: {} });
      }
    } else await route.fulfill({ json: [] });
  });
  await page.goto(`${web.origin}/scripts/fixtures/scheduled-message-tray.html`);
  const tray = page.locator(".scheduled-message-tray");
  const trayLine = page.locator(".scheduled-tray-line");
  const list = page.getByRole("region", { name: "排队输入完整列表" });
  const draft = page.getByRole("textbox", { name: "回复草稿" });
  const toggle = page.getByRole("button", { name: /^排队 \d+$/ });
  const item = (id) => page.locator(`.scheduled-message-item[data-message-id="${id}"]`);
  const focused = (locator) => locator.evaluate((element) => element === document.activeElement);
  const opacity = (locator) => locator.evaluate((element) => Number(getComputedStyle(element).opacity));
  const reload = async (messages) => {
    pending = messages;
    await page.getByRole("button", { name: "重新载入", exact: true }).click();
    await page.waitForFunction((count) => count === 0 ? !document.querySelector(".scheduled-message-tray")
      : document.querySelector(".scheduled-message-announcement")?.textContent?.startsWith(`${count} 条待发送消息`), messages.length);
  };
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = () => page.evaluate(() => {
    const rect = (selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height }; };
    return { tray: rect(".scheduled-message-tray"), draft: rect("textarea"), conversation: rect(".conversation-scroll-region") };
  });
  const expand = async () => { await toggle.click(); await list.waitFor(); await settle(); };

  // ── 收着:只占一行,带着自己最早那条和它的引导键 ───────────────────────────────
  await page.getByRole("button", { name: "排队 10", exact: true }).waitFor();
  assert.equal(await trayLine.count(), 1);
  assert.equal(await list.count(), 0, "默认收着");
  const collapsed = await geometry();
  assert.ok(collapsed.tray.height < 36, `收着时只占一行：${collapsed.tray.height}`);
  assert.match(await trayLine.innerText(), /排队 10\s*2 条要留意\s*你\s*输入-1/, "那一行：条数、要留意、自己最早那条");
  assert.doesNotMatch(await tray.innerText(), /我的消息|审查答复 \d|筛选|展开全部|#\d|按发送时间|monitorId=|REGRESSION_FINISHED|@codex/);
  const lineGuide = trayLine.getByRole("button", { name: /引导会话/ });
  assert.match(await lineGuide.getAttribute("aria-label"), /输入-1/, "引导键在这一行上,指向自己最早那条");
  assert.equal(await opacity(lineGuide), 1, "引导键不用指上去就看得见");
  assert.equal(await tray.evaluate((element) => getComputedStyle(element).borderTopWidth), "0px", "不再是带框的卡片");

  // ── 点开:向上长,回复框不动 ────────────────────────────────────────────────
  await expand();
  const expanded = await geometry();
  assert.ok(expanded.tray.top < collapsed.tray.top - 50, "点开向上长，而非另开浮层");
  assert.ok(Math.abs(expanded.tray.bottom - collapsed.tray.bottom) < 1, "底边保持锚定");
  assert.ok(Math.abs(expanded.draft.top - collapsed.draft.top) < 1, "输入框不被挤走");
  assert.ok(expanded.conversation.height >= 99, "点开保留会话阅读空间");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await trayLine.locator(".scheduled-tray-head").count(), 0, "点开后那一行不再重复带最早那条");
  assert.equal(await list.locator(".scheduled-message-item").count(), 10);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await list.evaluate((element) => element.scrollHeight > element.clientHeight), true, "条数多时列表自己滚");
  await page.getByRole("button", { name: "会话区域按钮" }).click();
  assert.equal(await list.isVisible(), true, "点会话区域不收起");

  // ── 每条行尾的键按来源给 ────────────────────────────────────────────────────
  const actionsOf = async (id) => (await item(id).locator(".scheduled-message-actions button").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")))).map((label) => label.replace(/“.*$/s, ""));
  assert.deepEqual(await actionsOf("msg-1"), ["用最早的排队消息", "撤回排队中的待发送消息"], "自己最早那条：引导 + 撤回");
  assert.deepEqual(await actionsOf("msg-6"), ["撤回排队中的待发送消息"], "后面的自己的消息只有撤回");
  assert.deepEqual(await actionsOf("msg-0"), ["取消哨兵事件"], "哨兵：取消这次唤醒");
  assert.deepEqual(await actionsOf("msg-2"), [], "审查答复行尾没有键");
  assert.match(await item("msg-3").locator(".scheduled-message-when").innerText(), /\d\d\/\d\d \d\d:\d\d 发/, "定时的写时刻");
  assert.match(await item("msg-1").innerText(), /@codex/, "指定了智能体的照旧带上");
  // 撤回、取消是指到才出的；引导是带字的键，一直在。
  const withdraw6 = item("msg-6").getByRole("button", { name: /^撤回/ });
  await page.mouse.move(0, 0);
  await settle();
  assert.equal(await opacity(withdraw6), 0, "没指到这一行时撤回键不出");
  assert.equal(await opacity(item("msg-1").getByRole("button", { name: /引导会话/ })), 1, "引导键一直看得见");
  await item("msg-6").locator(".scheduled-message-summary").hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-message-id="msg-6"] .scheduled-message-withdraw')).opacity === "1");
  await page.mouse.move(0, 0);
  await withdraw6.focus();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-message-id="msg-6"] .scheduled-message-withdraw')).opacity === "1");
  // 退出码非零的哨兵：「哨兵」琥珀色并写出 exit N；是 0 的不写。
  assert.match(await item("msg-4").locator(".scheduled-message-source").innerText(), /哨兵\s*exit 1/);
  assert.doesNotMatch(await item("msg-0").locator(".scheduled-message-source").innerText(), /exit/);
  const colors = await page.evaluate(() => ["msg-4", "msg-0"].map((id) =>
    getComputedStyle(document.querySelector(`[data-message-id="${id}"] .scheduled-message-source`)).color));
  assert.notEqual(colors[0], colors[1], "要留意的哨兵换成琥珀色");

  // ── 全文就地摊开 ──────────────────────────────────────────────────────────
  const summary1 = item("msg-1").locator(".scheduled-message-summary");
  await summary1.click();
  const full1 = item("msg-1").locator(".scheduled-message-full");
  await full1.waitFor();
  assert.equal(await summary1.getAttribute("aria-expanded"), "true");
  assert.equal(await full1.locator(".scheduled-message-body img").count(), 0, "消息文本不得作为 HTML 执行");
  assert.match(await full1.innerText(), /brief.txt/, "附件清单一起摊开");
  assert.match(await full1.innerText(), /保留完整的正文与排队顺序/);
  await list.evaluate((element) => { element.scrollTop = 130; });
  const scrollTop = await list.evaluate((element) => element.scrollTop);
  await reload([...pending, message(10)]);
  assert.equal(await full1.count(), 1, "新输入不收回已摊开的正文");
  assert.ok(Math.abs(await list.evaluate((element) => element.scrollTop) - scrollTop) < 1, "新输入不重置阅读位置");
  await summary1.click();
  assert.equal(await full1.count(), 0, "再点收回");

  // ── 收着那一行上的那条：点它 = 点开并摊开它的全文，焦点交给它；Esc 收起 ────────────
  await toggle.click();
  assert.equal(await list.count(), 0);
  await trayLine.getByRole("button", { name: /^查看完整输入：输入-1/ }).click();
  await full1.waitFor();
  assert.equal(await focused(summary1), true);
  await page.keyboard.press("Escape");
  assert.equal(await list.count(), 0);
  assert.equal(await focused(toggle), true, "Esc 收起后焦点回到那一行");
  // 「N 条要留意」：点开并滚到第一条要留意的。
  await trayLine.getByRole("button", { name: /查看 2 条退出码非零的输入/ }).click();
  await list.waitFor();
  await settle();
  const summary4 = item("msg-4").locator(".scheduled-message-summary");
  assert.equal(await focused(summary4), true, "焦点落在第一条要留意的那一条上");
  // 列表从顶上开始；滚到它那一行（滚到底时停在可滚的最远处），它整行都在列表的可视范围里。
  const reach = await page.evaluate(() => {
    const target = document.querySelector('[data-message-id="msg-4"] .scheduled-message-summary').getBoundingClientRect();
    const list = document.querySelector(".scheduled-tray-list");
    const box = list.getBoundingClientRect();
    return { scrolled: list.scrollTop > 0, inside: target.top >= box.top - 1 && target.bottom <= box.bottom + 1 };
  });
  assert.deepEqual(reach, { scrolled: true, inside: true }, "滚到第一条要留意的");

  // ── 哨兵：取消这次唤醒，确认框照旧 ─────────────────────────────────────────
  const cancel = item("msg-0").getByRole("button", { name: /^取消哨兵事件/ });
  await cancel.click();
  const dialog = page.getByRole("dialog", { name: "取消这次唤醒？" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /不执行停止哨兵操作/);
  assert.doesNotMatch(await dialog.innerText(), /仍在运行|后续事件仍会/);
  assert.equal(deleted.length, 0, "弹出确认框不能直接删除输入");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await list.isVisible(), true, "第一次 Esc 只关闭确认框");
  failCancel = true;
  await cancel.click();
  await dialog.getByRole("button", { name: "取消这次唤醒", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.innerText(), /取消失败，输入继续排队/);
  assert.equal(pending.length, 11);
  failCancel = false;
  await dialog.getByRole("button", { name: "取消这次唤醒", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.task-confirm-dialog footer button:last-child')?.disabled);
  assert.equal(await dialog.getByRole("button", { name: "处理中…" }).isDisabled(), true);
  // 忙着的那颗键一直亮着，转圈看得见（鼠标此刻在确认框上，不在那一行）。
  await page.waitForFunction(() => document.querySelector('[data-message-id="msg-0"]')
    ?.classList.contains("is-busy") && getComputedStyle(document.querySelector('[data-message-id="msg-0"] .scheduled-message-reveal')).opacity === "1");
  assert.equal(typeof releaseCancel, "function");
  releaseCancel();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".scheduled-message-announcement")?.textContent?.startsWith("10 条"));
  assert.deepEqual(deleted, ["msg-0", "msg-0"], "每次确认只取消所选输入，不停止哨兵");
  assert.equal(await list.isVisible(), true);

  // ── 引导会话 ───────────────────────────────────────────────────────────────
  await list.getByRole("button", { name: /引导会话/ }).click();
  await page.waitForFunction(() => document.querySelector(".scheduled-message-announcement")?.textContent?.startsWith("9 条"));
  assert.deepEqual(steered, ["msg-1"]);
  assert.match(await list.getByRole("button", { name: /引导会话/ }).getAttribute("aria-label"), /输入-6/, "队首换人后引导键跟着换");
  // 入队回执(POST /reply 的那一行)不带 wait / steerable,而且可能晚于事件触发的重拉到达:
  // 它不能把已经取到的完整记录盖掉 —— 重拉被扣着的这段时间里,引导键得一直在。
  let releaseList;
  holdList = new Promise((resolve) => { releaseList = resolve; });
  await page.getByRole("button", { name: "模拟入队回执", exact: true }).click();
  await settle();
  assert.equal(await list.getByRole("button", { name: /引导会话/ }).count(), 1, "不完整的入队回执盖掉了引导键");
  holdList = null;
  releaseList();
  await settle();
  assert.equal(await list.getByRole("button", { name: /引导会话/ }).count(), 1);
  // 收着那一行上的引导键同样能用。
  await toggle.click();
  await trayLine.getByRole("button", { name: /引导会话/ }).click();
  await page.waitForFunction(() => document.querySelector(".scheduled-message-announcement")?.textContent?.startsWith("8 条"));
  assert.deepEqual(steered, ["msg-1", "msg-6"]);
  assert.equal(await list.count(), 0, "从那一行引导不必先点开");

  // ── 条数变化 ──────────────────────────────────────────────────────────────
  for (const count of [0, 1, 2, 3]) {
    await reload(Array.from({ length: count }, (_, index) => message(index)));
    assert.equal(await trayLine.count(), count > 0 ? 1 : 0, "没有排着的东西，这一行不存在");
    assert.equal(await page.locator(".scheduled-message-item").count(), 0, "收着时不列出每一条");
  }
  await expand();
  const managed = { ...message(2), attachments: ["/tmp/review-notes.txt"] };
  await reload([message(0), message(1), managed]);
  const managedSummary = item("msg-2").locator(".scheduled-message-summary");
  const managedFull = item("msg-2").locator(".scheduled-message-full");
  await managedSummary.click();
  await reload([message(1), managed]);
  assert.equal(await list.count(), 1, "三条降两条保持点开");
  assert.equal(await managedFull.count(), 1, "三条降两条保留已摊开的正文");
  assert.equal(await managedFull.getByText("/tmp/review-notes.txt", { exact: true }).isVisible(), true);
  assert.match(await managedFull.locator(".scheduled-message-body").innerText(), /保留完整的正文与排队顺序/);
  await reload([managed]);
  assert.equal(await managedFull.count(), 1, "只剩一条审查答复仍可读全文");
  assert.equal(await page.getByRole("button", { name: /撤回|引导会话|取消哨兵事件/ }).count(), 0, "查看审查答复不扩大操作权限");
  await page.reload();
  await expand();
  await managedSummary.click();
  assert.equal(await managedFull.getByText("/tmp/review-notes.txt", { exact: true }).isVisible(), true, "刷新后一条消息仍有全文入口");
  await reload([message(0), message(1)]);
  for (const summary of await list.locator(".scheduled-message-summary").all()) await summary.click();
  assert.equal(await list.locator(".scheduled-message-full").count(), 2, "哨兵和个人输入均可完整阅读");
  await reload(Array.from({ length: 10 }, (_, index) => message(index)));
  assert.equal(await list.isVisible(), true, "消息数量增加时保持点开");

  // ── 带 origin 但不是哨兵的那几种 ──────────────────────────────────────────────
  // origin 早期只有哨兵唤醒在写，审查结算的修复交接（review-settlement:<代次>）、检查点
  // 续跑后来也写它。按 !!origin 判哨兵会把一条审查交接标成哨兵、还配上「取消这次唤醒 /
  // 不执行停止哨兵操作」的措辞，用户据此以为有个哨兵在盯（2026-10-31 实例：任务
  // CKjeps4QSRTE 的 review-repair-dde14804…）。这里钉的是「哨兵口径只落在真哨兵上」。
  const systemRow = (id, text, origin, at) => ({
    id, taskId: "task-a", text, attachments: [], agent: null, executorId: null, model: null, reasoningEffort: null,
    sessionRole: null, origin, mode: "queued", sendAt: at, status: "pending", createdAt: at, sentAt: null,
  });
  await reload([
    message(0),
    systemRow("repair", "【自由工作流审查未通过 · 第 1 轮】\nREGRESSION_FINISHED exitCode=1 monitor=m9",
      "review-settlement:gen-1", "2026-10-24T11:00:00.000Z"),
    systemRow("resume", "继续：把剩下两处改完", "checkpoint:resume", "2026-10-24T11:00:01.000Z"),
    systemRow("mine-2", "我自己写的", null, "2026-10-24T11:00:02.000Z"),
  ]);
  assert.match(await item("repair").locator(".scheduled-message-source").innerText(), /^系统$/);
  assert.match(await item("resume").locator(".scheduled-message-source").innerText(), /^系统$/, "认不出来源的 origin 归到「系统」");
  assert.equal(await list.locator(".scheduled-message-source", { hasText: "哨兵" }).count(), 1, "只有真哨兵标成哨兵");
  assert.deepEqual(await actionsOf("repair"), [], "系统排进来的不是用户打的字、也不是哨兵唤醒：行尾没有键");
  assert.deepEqual(await actionsOf("resume"), []);
  assert.doesNotMatch(await tray.innerText(), /由系统排入|不可撤回|由审查链投递/, "那几句说明不再常驻");
  assert.equal(await trayLine.locator(".scheduled-tray-attention").count(), 0, "正文里引着的退出码不许算成要留意");

  // ── 四档宽度：不横溢，键都在 ────────────────────────────────────────────────
  await reload(Array.from({ length: 30 }, (_, index) => message(index)));
  for (const width of [1280, 768, 390, 320]) {
    await resizeViewport(page, { width, height: width < 500 ? 700 : 900 });
    await settle();
    const position = await geometry();
    assert.ok(position.tray.top >= 48, `${width}px 不裁剪托盘顶部`);
    assert.ok(position.draft.bottom <= (width < 500 ? 700 : 900), `${width}px 输入框保持可见`);
    assert.equal(await tray.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, `${width}px 托盘不横溢`);
    assert.equal(await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, `${width}px 列表不横溢`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 页面不横溢`);
    const keys = await page.evaluate(() => {
      const box = document.querySelector(".scheduled-tray-list").getBoundingClientRect();
      return [...document.querySelectorAll(".scheduled-message-actions button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.left >= box.left - 1 && rect.right <= box.right + 1;
      });
    });
    assert.ok(keys.length > 0 && keys.every(Boolean), `${width}px 行尾的键都在列表里、没被挤出去`);
    if (width === 1280 || width === 390) await page.screenshot({ path: `${artifacts}scheduled-message-production-${width}.png`, fullPage: true });
  }
  // 窄窗收着、排队 + 哨兵 + 要留意 + 引导撤回全挤在一行：摘要仍留得下一截（第 1 轮审查 N1：300px 时被挤成 0 宽）。
  await page.getByRole("button", { name: "排队 30", exact: true }).click();
  await page.getByRole("button", { name: "挂上哨兵", exact: true }).click();
  await page.getByRole("button", { name: "排队 30，哨兵 4", exact: true }).waitFor();
  for (const width of [420, 340, 300]) {
    await resizeViewport(page, { width, height: 700 });
    await settle();
    const head = await trayLine.locator(".scheduled-tray-head-summary").evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(head >= 24, `${width}px 收着那一行的摘要还看得见（${head}px）`);
    assert.equal(await trayLine.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, `${width}px 收着那一行不横溢`);
  }
  await page.getByRole("button", { name: "挂上哨兵", exact: true }).click();
  await page.getByRole("button", { name: "排队 30", exact: true }).click();
  await resizeViewport(page, { width: 320, height: 700 });
  await settle();
  // 深色主题：颜色都取主题变量，琥珀色仍与普通来源分得开。
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await settle();
  const dark = await page.evaluate(() => ["msg-4", "msg-0"].map((id) =>
    getComputedStyle(document.querySelector(`[data-message-id="${id}"] .scheduled-message-source`)).color));
  assert.notEqual(dark[0], dark[1]);
  assert.notDeepEqual(dark, colors, "深色主题换了一套颜色");
  await page.screenshot({ path: `${artifacts}scheduled-message-production-dark.png`, fullPage: true });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  await page.getByRole("button", { name: "切换团队", exact: true }).click();
  await settle();
  assert.equal(await page.getByRole("button", { name: /引导会话/ }).count(), 0, "团队入口不新增引导权限");
  const teamPosition = await geometry();
  assert.ok(teamPosition.tray.top >= 48 && teamPosition.draft.bottom <= 700, "团队托盘和回复框同样保持可见");
  await page.screenshot({ path: `${artifacts}scheduled-message-production-team.png`, fullPage: true });
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.getByRole("button", { name: "排队 30", exact: true }).waitFor();
  assert.equal(await list.count(), 0, "切换任务重置点开状态");
  assert.equal(await draft.inputValue(), "未发送的草稿", "浏览、引导和取消哨兵不改动草稿");
  assert.deepEqual(errors, []);
  console.log("✓ 排队输入那一行：收着只占一行且带着自己最早那条与引导键、点开向上长、行尾的键按来源给、"
    + "指到才出的键键盘可达、全文就地摊开、要留意的跳转、确认失败/重试、引导、实时新增、任务切换、深色及四档宽度通过");
} finally {
  releaseCancel?.();
  await browser?.close();
  await web.close();
}
