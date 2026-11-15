// 详情页左边那几屉同一时刻只有一屉 + 右侧「派出的任务」那一格（真浏览器）。
//
// 三屉：子智能体执行详情、读全文（审查报告 / 辩论记录）、派出的任务。从任意一屉开另一屉，
// 前一屉必须收起 —— 它们叠在同一个位置，两屉同时开着就是一屉盖住另一屉、关掉上面那屉
// 才露出一份早该收起的旧内容。夹具挂的是 TaskDetail 自己那个 useTaskDrawers。
// 跑：npm -w web run test:task-drawers-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  await page.goto(`${web.origin}/scripts/fixtures/task-drawers.html`);

  const drawer = (label) => page.locator(`aside.side-drawer[aria-label="${label}"]`);
  const drawers = page.locator("aside.side-drawer");
  const dispatchedDrawer = (title) => drawer(`派出的任务：${title}`);
  const subagentDrawer = page.locator("aside.side-drawer--subagent");
  const report = drawer("审查报告：第 1 轮");
  // 子智能体那一屉从右侧那一格里的一行开：先点开那一行，再点「执行过程」。换过格再回来，那一行是收着的。
  const openSubagent = async () => {
    await page.getByRole("button", { name: "切到子智能体" }).click();
    const toggle = page.locator(".native-work__agent .native-work__row").first();
    await toggle.waitFor();
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await page.getByRole("button", { name: /^查看执行：/ }).first().click();
  };
  const only = async (locator, what) => {
    await locator.waitFor();
    assert.equal(await drawers.count(), 1, `${what}：左边同一时刻只有这一屉`);
  };

  // —— 右侧那一格：名下有派出的任务时冒到竖轨上，图标带个数；格头一句「N 个 · 怎么跑」。
  const tab = page.getByRole("tab", { name: /^派出的任务/ });
  await tab.waitFor();
  assert.equal(await tab.locator(".insp-counted-icon > i").textContent(), "2", "竖轨上那颗键带个数");
  await page.getByRole("button", { name: "切到派出的任务" }).click();
  const pane = page.locator(".dispatched-pane");
  await pane.waitFor();
  assert.equal((await pane.locator(".dispatched-head").innerText()).trim(), "2 个 · 一个接一个");
  const rowA = pane.getByRole("button", { name: /^第一条派出去的，运行中/ });
  const rowB = pane.getByRole("button", { name: /^第二条派出去的，等你答复/ });
  assert.equal(await rowA.count(), 1);
  assert.match(await rowA.locator("small").innerText(), /^codex@cpa · 用时 /, "一行小字是执行器和用时");
  assert.equal(await rowB.locator("em").getAttribute("class"), "is-ask", "只有要你处理的状态词带颜色");
  assert.equal(await rowA.locator("em").getAttribute("class"), null);

  // —— 点一行：左边推出那条任务（会话在里面），头上一颗「到这个任务里去」。
  await rowA.click();
  await only(dispatchedDrawer("第一条派出去的"), "派出的任务");
  await page.locator('[data-drawer-task="kid-a"]').waitFor();
  assert.equal(await rowA.getAttribute("aria-pressed"), "true", "开着的那一行看得出来");

  // —— 读全文推出来：派出的任务那一屉收起。
  await page.getByRole("button", { name: "读审查报告" }).click();
  await only(report, "读全文");

  // —— 再点派出的任务：读全文那一屉收起，换成另一条。
  await rowB.click();
  await only(dispatchedDrawer("第二条派出去的"), "派出的任务（换一条）");

  // —— 子智能体推出来：派出的任务那一屉收起。
  await openSubagent();
  await only(subagentDrawer, "子智能体");

  // —— 从派出的任务再开：子智能体那一屉收起。
  await page.getByRole("button", { name: "切到派出的任务" }).click();
  await rowA.click();
  await only(dispatchedDrawer("第一条派出去的"), "派出的任务（从子智能体切回）");

  // —— 读全文 → 子智能体，原来那两屉之间的互斥照旧。
  await page.getByRole("button", { name: "读审查报告" }).click();
  await only(report, "读全文（第二次）");
  await openSubagent();
  await only(subagentDrawer, "子智能体（从读全文切过来）");

  // —— 「到这个任务里去」：整页进那条任务，抽屉收起。
  await page.getByRole("button", { name: "切到派出的任务" }).click();
  await rowB.click();
  await dispatchedDrawer("第二条派出去的").getByRole("button", { name: "到这个任务里去" }).click();
  await page.waitForFunction(() => document.querySelector("output")?.dataset.opened === "kid-b");
  await page.waitForFunction(() => !document.querySelector("aside.side-drawer"));

  // —— 新派出去的一条不刷新就出现，竖轨上的数跟着变。
  await page.evaluate(() => window.__add({ id: "kid-c", title: "第三条派出去的", dispatchedBy: "lead", status: "failed" }));
  const rowC = pane.getByRole("button", { name: /^第三条派出去的，失败/ });
  await rowC.waitFor();
  assert.equal(await rowC.locator("em").getAttribute("class"), "is-bad");
  assert.equal(await tab.locator(".insp-counted-icon > i").textContent(), "3");
  assert.equal((await pane.locator(".dispatched-head").innerText()).trim(), "3 个", "混着派的（有的在队列里、有的不在）不写怎么跑");

  console.log("✓ 详情页：左边几屉互斥，右侧「派出的任务」那一格");
} finally {
  await browser?.close();
  await web.close();
}
