import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage } from "./wait-until.mjs";

const output = fileURLToPath(new URL("../../output/playwright", import.meta.url));
const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
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
  await page.goto(`${web.origin}/scripts/fixtures/native-work.html`);
  await page.clock.install();

  // 「执行过程」在点开的那一行里：先把那一行展开（已经展开就不动），再点它。
  const agentRow = (title) => page.locator(".native-work__agent").filter({ has: page.locator(".native-work__title", { hasText: title }) });
  const viewRun = async (title) => {
    const row = agentRow(title);
    const toggle = row.locator(".native-work__row");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await page.getByRole("button", { name: `查看执行：${title}`, exact: true }).click();
  };

  assert.equal(await page.getByRole("tab", { name: "子智能体" }).count(), 0, "Inspector starts hidden");
  await page.getByRole("button", { name: "打开子智能体" }).click();
  await page.getByRole("tab", { name: "子智能体" }).waitFor();
  const agents = page.locator(".native-work__agent");
  assert.equal(await agents.count(), 5, "一行一个子智能体；内部待办不混进来");
  assert.equal(await agents.first().getAttribute("data-status"), "running", "在跑的排在最前");
  const side = (status) => page.locator(`.native-work__agent[data-status="${status}"] .native-work__side`);
  assert.match(await side("running").innerText(), /\d/, "在跑的右边是用时");
  assert.match(await side("running").getAttribute("class"), /insp-live/, "在跑的用时是主色");
  assert.equal(await side("completed").innerText(), "1分 35秒", "跑完的右边是用时");
  assert.equal(await side("failed").innerText(), "失败");
  assert.match(await side("failed").getAttribute("class"), /insp-bad/);
  assert.equal(await side("stopped").innerText(), "已停止", "停了的只换右边那几个字");
  assert.equal(await side("unknown").innerText(), "状态未知");
  assert.equal(await page.locator(".native-work__doing").count(), 1, "只有在跑的那一行底下多一行它此刻在做什么");
  assert.ok((await page.locator('.native-work__agent[data-status="running"] .native-work__doing').innerText()).trim().length > 0);
  assert.equal(await page.locator(".native-work__counts, .native-work__intro").count(), 0, "三格统计和那段说明都不要了");
  assert.equal(await page.locator(".native-work__more").count(), 0, "默认都收着");

  await mkdir(output, { recursive: true });
  const inspector = page.locator(".inspector-host");
  const inspectorStyle = await inspector.getAttribute("style");
  assert.ok((await agentRow("调研 ash").locator(".native-work__title").innerText()).length >= 50, "夹具覆盖超长标题");
  for (const width of [280, 316, 340, 448, 720]) {
    await inspector.evaluate((el, width) => {
      el.style.setProperty("--inspector-width", `${width}px`);
      el.style.transition = "none";
    }, width);
    const rows = await page.locator(".native-work__row").evaluateAll((items) => items.map((item) => ({
      height: item.getBoundingClientRect().height, overflow: item.scrollWidth > item.clientWidth + 1,
    })));
    assert.ok(rows.every((row) => row.height <= 34 && !row.overflow), `每个子智能体一行、不横向溢出：${JSON.stringify({ width, rows })}`);
    if ([340, 448].includes(width)) await inspector.screenshot({ path: `${output}/native-work-compact-${width}.png` });
  }
  await inspector.evaluate((el, style) => {
    if (style === null) el.removeAttribute("style");
    else el.setAttribute("style", style);
  }, inspectorStyle);
  await settled(inspector);

  // 点开：先是它带回来的话，再是一行出处（类型 · 模型 · 智能水平 · 几点派的）；收到的输入折着。
  const running = agentRow("运行中的资料搜集");
  await running.locator(".native-work__row").press("Enter");
  assert.equal(await running.locator(".native-work__row").getAttribute("aria-expanded"), "true");
  assert.match(await running.locator(".native-work__result").innerText(), /还没带回来话/);
  const facts = await running.locator(".native-work__facts").innerText();
  assert.match(facts, /gpt-5\.6-sol（调用指定）\s*·\s*智能水平 xhigh\s*·\s*09\/08 08:00 派出/, "模型和智能水平实跑值优先，只有退回到派活时点的那个才标调用指定");
  assert.equal(facts.match(/调用指定/g).length, 1, "已上报实跑智能水平的那一项不该再标调用指定");
  assert.equal(await running.locator(".native-work__input").count(), 0, "收到的输入默认折着");
  await running.getByRole("button", { name: "收到的输入", exact: true }).click();
  assert.match(await running.locator(".native-work__input").innerText(), /需要检查一个不会自然换行的超长说明/);
  const activeSpan = await side("running").innerText();
  await page.clock.fastForward(60_000);
  await settlePage(page); // 假时钟触发的秒表 setState 还排在 React 调度里；冲刷掉再读 DOM
  assert.notEqual(await side("running").innerText(), activeSpan, "运行项实时更新用时");
  const stopped = agentRow("用户停止的执行者");
  await stopped.locator(".native-work__row").click();
  assert.match(await stopped.locator(".native-work__result").innerText(), /没有带回来的话/);
  await stopped.getByRole("button", { name: "收到的输入", exact: true }).click();
  assert.match(await stopped.locator(".native-work__input").innerText(), /未记录主会话给它的输入[\s\S]*加密/, "没有派活正文时照实说为什么空着");
  await stopped.locator(".native-work__row").click();

  // 待办收成最底下一行：有子智能体时默认收着，点开一项一行，带上它属于哪个子智能体。
  const todoRow = page.locator(".native-work__todo-row");
  assert.match(await todoRow.innerText(), /待办[\s\S]*0 \/ 1/);
  assert.equal(await todoRow.getAttribute("aria-expanded"), "false");
  await todoRow.click();
  assert.match(await page.locator(".native-work__todo-list li").innerText(), /核对浏览器状态\s*·\s*运行中的资料搜集/);
  await todoRow.click();

  const overflow = await page.locator(".native-work").evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(overflow.scroll <= overflow.width + 1, `narrow Inspector overflowed: ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: `${output}/native-work-initial.png`, fullPage: true });

  await page.getByRole("button", { name: "查看执行：运行中的资料搜集", exact: true }).click();
  // 执行详情从左侧抽屉推出来（和团队模式点执行者同一套外壳）：只盖住主区那一栏，
  // 右侧 Inspector 的列表仍然看得见、点得到，并回显正在看的是哪一个。
  const drawer = page.getByLabel("子智能体执行详情：运行中的资料搜集", { exact: true });
  await drawer.waitFor();
  assert.equal(await drawer.locator(".side-drawer__kind").innerText(), "子智能体");
  assert.equal(await page.locator(".native-work__agent.is-viewing").count(), 1);
  assert.equal(await page.getByRole("button", { name: "查看执行：运行中的资料搜集", exact: true })
    .getAttribute("aria-pressed"), "true");
  const mainBox = await page.locator("main > div > section").boundingBox();
  const drawerBox = await (await settled(drawer)).boundingBox();
  assert.ok(Math.abs(drawerBox.x - mainBox.x) <= 1, `抽屉应贴主区左缘：${JSON.stringify({ drawerBox, mainBox })}`);
  assert.ok(drawerBox.x + drawerBox.width <= mainBox.x + mainBox.width + 1, "抽屉不该盖到 Inspector 上");
  const conversation = page.getByLabel("子智能体执行详情", { exact: true });
  const header = conversation.locator(".native-agent__header");
  const headline = header.locator(".native-agent__headline");
  const avatar = await header.locator(".native-agent__avatar").evaluate((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { width: box.width, height: box.height, display: style.display,
      border: style.borderTopWidth, radius: style.borderTopLeftRadius, background: style.backgroundColor };
  });
  assert.deepEqual({ width: avatar.width, height: avatar.height, display: avatar.display, border: avatar.border, radius: avatar.radius },
    { width: 30, height: 30, display: "grid", border: "1px", radius: "8px" }, "抽屉抬头保留圆角方块图标");
  assert.notEqual(avatar.background, "rgba(0, 0, 0, 0)");
  await header.screenshot({ path: `${output}/native-agent-drawer-header.png` });
  // 模型与时间原本是正文顶上一块要点开的两列表格，现在顺着标题横向摊在抬头里。
  assert.equal(await conversation.locator(".native-agent__metadata").count(), 0, "正文里不再有单独的「模型与时间」折叠区");
  assert.equal(await conversation.locator(".native-work__meta").count(), 0, "抬头不复刻列表里那套两列表格");
  // 跨度这里只验形状：运行中的项按真实时钟一直在走，写死「3天 6小时」会随日期自然失效。
  // 具体文案由下面收工后那条（endedAt 固定）钉住。
  assert.match(await headline.innerText(),
    /codex@fixture\s*·\s*gpt-5\.6-sol\s*调用指定\s*·\s*xhigh\s*·\s*09\/08 08:00 起\s*·\s*\d+\s*(?:天|小时|分|秒)/);
  const headerBox = await header.boundingBox();
  const headlineBox = await headline.boundingBox();
  assert.ok(headlineBox.y >= headerBox.y - 1 && headlineBox.y + headlineBox.height <= headerBox.y + headerBox.height + 1,
    `抬头那一条要落在固定抬头内：${JSON.stringify({ headerBox, headlineBox })}`);
  // 横排的判据就是它只占一行：退回两列表格会立刻把这里撑高。
  assert.ok(headlineBox.height <= 24, `抬头那一条应排成一行：${JSON.stringify(headlineBox)}`);
  await conversation.getByText("子智能体侧栏", { exact: true }).waitFor();
  // 主会话发给它的那段输入:有就折在抬头下面（点开看全），没有就照实说为什么没有。
  await conversation.locator(".native-agent__assignment > summary").click();
  assert.match(await conversation.innerText(), /收到的输入[\s\S]*需要检查一个不会自然换行的超长说明/);
  assert.ok(!(await conversation.innerText()).includes("未记录主会话给它的输入"));
  await conversation.locator(".task-execution-block > summary").click();
  assert.match(await conversation.innerText(), /思考\s*核对侧栏事件的归属/);
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
  await viewRun("用户停止的执行者");
  await page.getByLabel("子智能体执行详情：用户停止的执行者", { exact: true }).waitFor();
  assert.match(await conversation.innerText(), /另一个子智能体的独立记录/);
  assert.match(await conversation.innerText(), /未记录主会话给它的输入[\s\S]*加密/,
    "执行器没上报派活正文时，抽屉里要说清为什么空着");
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
  assert.equal(await page.locator(".native-work__agent.is-viewing").count(), 0, "列表也不该还回显选中");
  // 切回来之后照样能重新打开。
  await viewRun("运行中的资料搜集");
  await page.getByLabel("子智能体执行详情：运行中的资料搜集", { exact: true }).waitFor();
  await closeDrawer();

  await page.getByRole("button", { name: "完成运行项" }).click();
  await page.locator('.native-work__agent[data-status="completed"]').filter({ hasText: "运行中的资料搜集" }).waitFor();
  assert.equal(await page.locator('.native-work__agent[data-status="completed"]').count(), 2);
  assert.match(await page.locator(".native-work__todo-row").innerText(), /1 \/ 1/, "它名下那条待办跟着做完了");

  await page.reload();
  await page.getByRole("tab", { name: "子智能体" }).waitFor();
  assert.equal(await page.locator('.native-work__agent[data-status="completed"]').count(), 2, "refresh rebuild keeps final states");
  assert.equal(await agentRow("运行中的资料搜集").getAttribute("data-status"), "completed");
  assert.equal(await page.locator(".native-work__doing").count(), 0, "没有在跑的就没有「此刻在做什么」");
  await agentRow("运行中的资料搜集").locator(".native-work__row").click();
  assert.match(await agentRow("运行中的资料搜集").locator(".native-work__result").innerText(), /刷新后仍应保留的完成结果/, "点开先是它带回来的话");
  await viewRun("运行中的资料搜集");
  await conversation.getByText("刷新后仍应保留的完成结果", { exact: false }).waitFor();
  assert.match(await headline.innerText(), /09\/08 08:00 → 08:08\s*·\s*8分 0秒/, "收工后抬头给出完整区间和跨度");
  await page.clock.fastForward(60_000);
  await settlePage(page); // 假时钟触发的秒表 setState 还排在 React 调度里；冲刷掉再读 DOM
  assert.match(await headline.innerText(), /8分 0秒/, "完成后跨度保持固定");
  assert.equal(await conversation.locator(".native-agent__live").count(), 0);
  await conversation.locator(".task-turn-process > summary").click();
  assert.match(await conversation.innerText(), /实时进展 1/);
  await closeDrawer();
  assert.equal(await page.locator(".native-work__agent.is-viewing").count(), 0, "抽屉关掉后列表不再回显选中");

  await page.getByRole("button", { name: "切换空状态" }).click();
  await page.getByText("这个任务没有派过子智能体。", { exact: true }).waitFor();
  assert.equal(await page.locator(".native-work__agent").count(), 0);
  await page.screenshot({ path: `${output}/native-work-empty.png`, fullPage: true });
  // 只有待办、没有子智能体：那一行默认铺开，不再说「没有派过」。
  await page.getByRole("button", { name: "切换计划快照", exact: true }).click();
  await page.locator(".native-work__todo-list").waitFor();
  assert.equal(await page.locator(".native-work__agent").count(), 0);
  assert.equal(await page.getByText("这个任务没有派过子智能体。", { exact: true }).count(), 0);
  assert.match(await page.locator(".native-work__todo-row").innerText(), /1 \/ 4/);
  assert.deepEqual(await page.locator(".native-work__todo-list li").evaluateAll((items) => items.map((item) => item.dataset.status)),
    ["completed", "running", "pending", "pending"]);
  assert.equal(await page.locator('.native-work__todo-list li[data-status="running"] .insp-live').innerText(), "进行中");
  await page.screenshot({ path: `${output}/native-work-plan-timing.png`, fullPage: true });
  console.log("native work Inspector DOM regression passed");
} finally {
  await browser?.close();
  await web.close();
}
