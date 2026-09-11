import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = fileURLToPath(new URL("../../output/playwright", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  // 抽屉是滑进来的：量位置前先等它的 CSS 动画跑完（fake clock 不影响 CSS 动画时间线）。
  const settled = async (locator) => {
    await locator.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    return locator;
  };
  // 关闭抽屉走滑出动画；reduced-motion 那条路靠 setTimeout，所以连 fake clock 一起推一下，
  // 再等它真的从 DOM 上消失。
  const closeDrawer = async () => {
    await page.getByRole("button", { name: "关闭子智能体抽屉", exact: true }).click();
    await page.clock.runFor(200);
    await page.getByLabel("子智能体执行详情", { exact: true }).waitFor({ state: "detached" });
  };
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/native-work.html`);
  await page.clock.install();

  assert.equal(await page.getByRole("tab", { name: "子智能体" }).count(), 0, "Inspector starts hidden");
  await page.getByRole("button", { name: "打开子智能体" }).click();
  await page.getByRole("tab", { name: "子智能体" }).waitFor();
  assert.equal(await page.locator(".native-work__row").count(), 6);
  assert.deepEqual((await page.locator(".native-work__status").allInnerTexts()).sort(),
    ["进行中", "待处理", "已完成", "失败", "已停止", "状态未知"].sort());

  const running = page.locator('.native-work__row[data-status="running"]');
  const card = page.locator('.native-work__entry[data-status="running"]');
  assert.match(await card.locator(".native-work__model").innerText(), /gpt-5.6-sol/);
  const timing = card.locator(".native-work__timing");
  assert.equal(await timing.getAttribute("open"), null, "卡片默认只显示时间摘要");
  assert.equal(await card.locator(".native-work__times").isVisible(), false);
  await timing.locator("summary").press("Enter");
  assert.equal(await card.locator(".native-work__times").isVisible(), true);
  assert.match(await card.locator(".native-work__times").innerText(), /开始时间[\s\S]*结束时间[\s\S]*尚未结束/);
  assert.equal(await card.locator("time").first().getAttribute("datetime"), "2026-09-08T00:00:01.000Z");
  assert.match(await card.locator("time").first().innerText(), /^09\/08\s+08:00$/, "日期按 MM/DD HH:mm 显示，不带年份也不带秒");
  await timing.locator("summary").press("Space");
  assert.equal(await card.locator(".native-work__times").isVisible(), false, "可重新收起完整时间");
  const pending = page.locator('.native-work__entry[data-status="pending"]');
  assert.equal(await pending.locator("time").count(), 0, "未开工不能显示开始时间");
  assert.equal(await pending.locator(".native-work__model").count(), 0, "内部待办没有执行模型");
  assert.match(await pending.locator(".native-work__timing > summary").innerText(), /尚未开始/);
  assert.equal(await pending.locator(".native-work__duration-value").count(), 0);
  const activeSpan = await card.locator(".native-work__duration-value").innerText();
  await page.clock.fastForward(60_000);
  assert.notEqual(await card.locator(".native-work__duration-value").innerText(), activeSpan, "运行项实时更新跨度");
  assert.equal(await pending.locator(".native-work__duration-value").count(), 0, "待处理项不会随时钟递增");
  await running.locator("summary").click();
  await page.getByText("核对浏览器状态", { exact: true }).click();
  assert.match(await page.locator(".native-work__detail").filter({ hasText: "所属子智能体" }).innerText(), /运行中的资料搜集/);

  const overflow = await page.locator(".native-work").evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(overflow.scroll <= overflow.width + 1, `narrow Inspector overflowed: ${JSON.stringify(overflow)}`);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/native-work-initial.png`, fullPage: true });

  await page.getByRole("button", { name: "查看执行：运行中的资料搜集", exact: true }).click();
  // 执行详情从左侧抽屉推出来（和团队模式点执行者同一套外壳）：只盖住主区那一栏，
  // 右侧 Inspector 的列表仍然看得见、点得到，并回显正在看的是哪一个。
  const drawer = page.getByLabel("子智能体执行详情：运行中的资料搜集", { exact: true });
  await drawer.waitFor();
  assert.equal(await drawer.locator(".side-drawer__kind").innerText(), "子智能体");
  assert.equal(await page.locator(".native-work__entry.is-open").count(), 1);
  assert.equal(await page.getByRole("button", { name: "查看执行：运行中的资料搜集", exact: true })
    .getAttribute("aria-pressed"), "true");
  const mainBox = await page.locator("main > div > section").boundingBox();
  const drawerBox = await (await settled(drawer)).boundingBox();
  assert.ok(Math.abs(drawerBox.x - mainBox.x) <= 1, `抽屉应贴主区左缘：${JSON.stringify({ drawerBox, mainBox })}`);
  assert.ok(drawerBox.x + drawerBox.width <= mainBox.x + mainBox.width + 1, "抽屉不该盖到 Inspector 上");
  const conversation = page.getByLabel("子智能体执行详情", { exact: true });
  const header = conversation.locator(".native-agent__header");
  const headline = header.locator(".native-agent__headline");
  // 模型与时间原本是正文顶上一块要点开的两列表格，现在顺着标题横向摊在抬头里。
  assert.equal(await conversation.locator(".native-agent__metadata").count(), 0, "正文里不再有单独的「模型与时间」折叠区");
  assert.equal(await conversation.locator(".native-work__meta").count(), 0, "抬头不复刻列表里那套两列表格");
  assert.match(await headline.innerText(), /codex@fixture[\s\S]*gpt-5\.6-sol[\s\S]*调用指定[\s\S]*09\/08 08:00 起[\s\S]*3天 6小时/);
  const headerBox = await header.boundingBox();
  const headlineBox = await headline.boundingBox();
  assert.ok(headlineBox.y >= headerBox.y - 1 && headlineBox.y + headlineBox.height <= headerBox.y + headerBox.height + 1,
    `抬头那一条要落在固定抬头内：${JSON.stringify({ headerBox, headlineBox })}`);
  // 横排的判据就是它只占一行：退回两列表格会立刻把这里撑高。
  assert.ok(headlineBox.height <= 24, `抬头那一条应排成一行：${JSON.stringify(headlineBox)}`);
  await conversation.getByText("子智能体侧栏", { exact: true }).waitFor();
  await conversation.locator(".task-execution-block > summary").click();
  assert.match(await conversation.innerText(), /思考过程|分析/);
  assert.match(await conversation.innerText(), /NativeWorkInspector.tsx/);
  await page.getByRole("button", { name: "推送执行进展", exact: true }).click();
  await conversation.getByText("实时进展 1：工具调用和输出已经接入。", { exact: true }).waitFor();
  await conversation.locator(".task-execution-block > summary").last().click();
  assert.match(await conversation.innerText(), /npm run verify-child/);
  const parentText = await page.getByLabel("主会话", { exact: true }).innerText();
  assert.ok(!parentText.includes("实时进展") && !parentText.includes("子智能体侧栏"));
  const detailSize = await conversation.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(detailSize.scroll <= detailSize.width + 1, "execution details fit the drawer");
  await page.screenshot({ path: `${output}/native-work-live.png`, fullPage: true });
  // 不关抽屉直接点列表里的下一个：换人不该被关闭动画吞掉。
  await page.getByRole("button", { name: "查看执行：用户停止的执行者", exact: true }).click();
  await page.getByLabel("子智能体执行详情：用户停止的执行者", { exact: true }).waitFor();
  assert.match(await conversation.innerText(), /另一个子智能体的独立记录/);
  assert.ok(!(await conversation.innerText()).includes("实时进展"));

  // 切到别的任务再切回来：抽屉必须保持关着。宿主组件跨任务复用，选中状态只按 row id
  // 记的话，切回来时这一条又能匹配上，抽屉会自己弹回来（用户根本没点过）。
  const switchTask = page.getByRole("button", { name: "切换任务", exact: true });
  await switchTask.click();
  await page.getByLabel("子智能体执行详情", { exact: true }).waitFor({ state: "detached" });
  await switchTask.click();
  assert.equal(await page.locator("[data-task-id='native-work-task']").count(), 1, "该切回原任务");
  assert.equal(await page.getByLabel("子智能体执行详情", { exact: true }).count(), 0,
    "切走再切回来，抽屉不该自己重新打开");
  assert.equal(await page.locator(".native-work__entry.is-open").count(), 0, "列表也不该还回显选中");
  // 切回来之后照样能重新打开。
  await page.getByRole("button", { name: "查看执行：运行中的资料搜集", exact: true }).click();
  await page.getByLabel("子智能体执行详情：运行中的资料搜集", { exact: true }).waitFor();
  await closeDrawer();

  await page.getByRole("button", { name: "完成运行项" }).click();
  await page.locator('.native-work__row[data-status="completed"] > summary').filter({ hasText: "运行中的资料搜集" }).waitFor();
  assert.equal(await page.locator('.native-work__row[data-status="completed"]').count(), 3);
  assert.match(await page.locator(".native-work__counts").innerText(), /3\s+已完成/);

  await page.reload();
  await page.getByRole("tab", { name: "子智能体" }).waitFor();
  assert.equal(await page.locator('.native-work__row[data-status="completed"]').count(), 3, "refresh rebuild keeps final states");
  assert.equal(await page.locator(".native-work__title", { hasText: "运行中的资料搜集" }).locator("xpath=ancestor::details[1]").getAttribute("data-status"), "completed");
  await page.getByRole("button", { name: "查看执行：运行中的资料搜集", exact: true }).click();
  await conversation.getByText("刷新后仍应保留的完成结果", { exact: false }).waitFor();
  assert.match(await headline.innerText(), /09\/08 08:00–08:08\s*·\s*8分 0秒/, "收工后抬头给出完整区间和跨度");
  await page.clock.fastForward(60_000);
  assert.match(await headline.innerText(), /8分 0秒/, "完成后跨度保持固定");
  assert.equal(await conversation.locator(".native-agent__live").count(), 0);
  await conversation.locator(".task-turn-process > summary").click();
  assert.match(await conversation.innerText(), /实时进展 1/);
  await closeDrawer();
  assert.equal(await page.locator(".native-work__entry.is-open").count(), 0, "抽屉关掉后列表不再回显选中");

  await page.getByRole("button", { name: "切换空状态" }).click();
  await page.getByText("暂无子智能体或内部任务").waitFor();
  assert.equal(await page.locator(".native-work__row").count(), 0);
  await page.screenshot({ path: `${output}/native-work-empty.png`, fullPage: true });
  await page.getByRole("button", { name: "切换计划快照", exact: true }).click();
  assert.equal(await page.locator(".native-work__row").count(), 4);
  assert.equal(await page.locator(".native-work__model").count(), 0);
  const snapshotPending = page.locator('.native-work__entry[data-status="pending"]');
  assert.equal(await snapshotPending.count(), 2);
  assert.equal(await snapshotPending.locator("time").count(), 0);
  assert.equal(await snapshotPending.locator(".native-work__duration-value").count(), 0);
  const firstCompleted = page.locator('.native-work__entry[data-status="completed"]');
  assert.equal(await firstCompleted.locator("time").count(), 1, "首次快照仅知道完成时间");
  await firstCompleted.locator(".native-work__timing > summary").click();
  assert.match(await firstCompleted.innerText(), /未记录开始时间，无法计算跨度/);
  await page.clock.fastForward(60_000);
  assert.equal(await snapshotPending.locator(".native-work__duration-value").count(), 0);
  await page.screenshot({ path: `${output}/native-work-plan-timing.png`, fullPage: true });
  await snapshotPending.first().screenshot({ path: `${output}/native-work-pending-fixed.png` });
  console.log("native work Inspector DOM regression passed");
} finally {
  await browser?.close();
  await server.close();
}
