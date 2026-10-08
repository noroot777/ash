// 打开「其他机器」上那种行要先问一次持有机(异步)。这条用例钉住那段窗口里的三件事：
//   1. 正常情况下照常打开；
//   2. 等答复期间用户又选了本机任务 —— 迟到的应答一个字都不许写(审查第 1 轮抓到的是
//      主区过一会儿自己跳成远端那条)；
//   3. 两条在途的远端打开里只有**最后发起**的那一条落地，先发起的那条哪怕后回来也作废。
// 跑的是真 WorkspaceShell（接线、URL、主区都真），闸门只掐住 api.handoffTargets。
// 跑：npm -w web run test:sidebar-remote-race
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15_000);
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/sidebar-remote-race.html?project=p1`);

  const localRow = page.locator('.workspace-task-tree [data-task-id="local"]');
  const farRow = (id) => page.locator(`.workspace-handoff-task[data-task-id="${id}"]`);
  await localRow.waitFor();
  await farRow("far-1").waitFor();

  // 「其他机器」那一节夹在置顶和「任务」之间；这份数据没有置顶行，所以它排在最前面 ——
  // 从本机那条往上按 K 才会走到远端行上。
  const screenOrder = () => page.$$eval(
    ".workspace-task-tree [data-task-id]",
    (rows) => rows.filter((row) => row.offsetParent !== null).map((row) => row.dataset.taskId),
  );
  assert.deepEqual(await screenOrder(), ["far-1", "far-2", "local"], "屏幕上的行序");

  // 选中身份看的是**列表上亮着的那一行**和 URL —— 两处都是用户实际看到的东西。
  const selected = () => page.$eval(".workspace-task-tree", (tree) => tree.querySelector(
    '[data-task-id][aria-selected="true"], .workspace-handoff-task.is-selected[data-task-id]',
  )?.getAttribute("data-task-id") ?? null);
  const urlTask = () => page.evaluate(() => new URL(location.href).searchParams.get("task"));
  // 任务模式下 out 行摆在主列表里，而远端选中走的是 remoteSelection（本机 taskId 被清空），
  // 所以那一行**不会**亮起 aria-selected。主区顶上那行标题才是「现在打开的是谁」的权威说法。
  const openedRemoteTitle = () => page.$eval(
    ".remote-task-detail .task-detail-title",
    (node) => node.textContent?.trim() ?? "",
  ).catch(() => null);
  const waitRemoteTitle = async (want) => {
    await page.waitForFunction(
      (title) => document.querySelector(".remote-task-detail .task-detail-title")?.textContent?.trim() === title,
      want,
    ).catch(() => {});
    assert.equal(await openedRemoteTitle(), want);
  };
  const pending = () => page.evaluate(() => window.__pendingTargets());
  const waitPending = async (want) => {
    await page.waitForFunction((n) => window.__pendingTargets() === n, want);
    assert.equal(await pending(), want);
  };
  const waitSelected = async (want) => {
    await page.waitForFunction(
      (id) => (document.querySelector(
        '.workspace-task-tree [data-task-id][aria-selected="true"], .workspace-task-tree .workspace-handoff-task.is-selected[data-task-id]',
      )?.getAttribute("data-task-id") ?? null) === id,
      want,
    ).catch(() => {});
    assert.equal(await selected(), want);
  };

  // —— 零、不按闸门时远端行照常打开（别把功能改死了）。
  await farRow("far-1").click();
  await waitSelected("far-1");
  assert.equal(await urlTask(), null, "远端任务不写本机 task 参数");

  // —— 一、迟到的应答不许覆盖后来的本机选择。
  await localRow.click();
  await waitSelected("local");
  assert.equal(await urlTask(), "local");

  await page.evaluate(() => window.__holdTargets());
  await localRow.focus();
  // K 从本机那条往上走一格，落在「其他机器」那一节上 —— 真实里就是这一下按出的问题。
  await page.keyboard.press("k");
  await waitPending(1);
  await waitSelected("local");

  // 等答复期间点回本机那条（真实复现里就是这一步），再放行那份应答。
  await localRow.click();
  await waitSelected("local");
  await page.evaluate(() => window.__releaseTargets());
  await page.waitForFunction(() => window.__pendingTargets() === 0);
  // 给迟到的应答足够时间把它想写的东西写进去 —— 修好了的话它什么都写不进来。
  await page.waitForTimeout(600);
  assert.equal(await selected(), "local", "迟到的远端应答不得把选中顶成远端那条");
  assert.equal(await urlTask(), "local", "URL 也得还指向本机那条");

  // —— 二、在途的那条也不许顶掉后来选的**另一台机器上的任务**。
  // 「其他机器」那一节里点行走的是同步路径（onRemoteTask，不必再问一次持有机），
  // 所以这一下当场落地；随后回来的那份应答必须认出自己已经过期。
  await page.evaluate(() => window.__holdTargets());
  await localRow.focus();
  await page.keyboard.press("k");
  await waitPending(1);
  await farRow("far-1").click();
  await waitSelected("far-1");
  await page.evaluate(() => window.__releaseTargets());
  await page.waitForFunction(() => window.__pendingTargets() === 0);
  await page.waitForTimeout(600);
  assert.equal(await selected(), "far-1", "迟到的应答不得把选中顶成它自己那条");

  // —— 三、两条都在途时只有**最后发起**的那条落地，先发起的那条哪怕后回来也不翻盘。
  // 任务模式下主列表里直接摆着 out 行，点它走的就是「先问一次持有机」那条异步路径 ——
  // 这是真实里唯一能把两次远端打开同时挂在半空中的入口。
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  const listRow = (id) => page.locator(`.workspace-task-tree [data-task-id="${id}"]`);
  await listRow("far-1").waitFor();
  await listRow("far-2").waitFor();
  await page.evaluate(() => window.__holdTargets());
  await listRow("far-1").click();
  await waitPending(1);
  await listRow("far-2").click();
  await waitPending(2);
  // 倒序放行：far-2 先回来并落地，far-1 随后回来 —— 它必须认出自己已经过期。
  await page.evaluate(() => window.__releaseTargets("lifo"));
  await page.waitForFunction(() => window.__pendingTargets() === 0);
  await waitRemoteTitle("mac-mini 上另一条");
  await page.waitForTimeout(600);
  assert.equal(
    await openedRemoteTitle(),
    "mac-mini 上另一条",
    "先发起的那条远端打开后回来也不得翻盘",
  );

  // —— 四、**连着按**:远端那种行还没打开,第二下 J/K 也得照样往前挪一行。
  // 导航的位置和详情的打开是两件事（审查第 2 轮抓到的是把两件事绑在一起:第二下从同一个
  // 旧选中身份再算一遍,于是连按两下只挪一行）。两次按键之间**不放行**那份查询。
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-handoff-task").length > 0);
  await localRow.click();
  await waitSelected("local");

  // 向上两下 K：local → far-2 → far-1。两下都在同一个在途窗口里按完。
  await page.evaluate(() => window.__holdTargets());
  await localRow.focus();
  await page.keyboard.press("k");
  await waitPending(1);
  await page.keyboard.press("k");
  await waitPending(2);
  await waitSelected("local");
  await page.evaluate(() => window.__releaseTargets());
  await page.waitForFunction(() => window.__pendingTargets() === 0);
  await waitSelected("far-1");
  await page.waitForTimeout(400);
  assert.equal(await selected(), "far-1", "连按两下 K 要走到第二行远端任务上，不能只挪一行");

  // 向下两下 J：从「一行都没选」开始，far-1 → far-2。
  await page.reload();
  await localRow.waitFor();
  await farRow("far-1").waitFor();
  await page.evaluate(() => window.__holdTargets());
  await page.keyboard.press("j");
  await waitPending(1);
  await page.keyboard.press("j");
  await waitPending(2);
  await page.evaluate(() => window.__releaseTargets());
  await page.waitForFunction(() => window.__pendingTargets() === 0);
  await waitSelected("far-2");
  await page.waitForTimeout(400);
  assert.equal(await selected(), "far-2", "连按两下 J 要走到第二行，不能停在第一行");

  // 中间插一下别的动作，光标就该作废：点回本机那条之后按 K，要重新从它上面那行算起。
  await page.evaluate(() => window.__holdTargets());
  await localRow.click();
  await waitSelected("local");
  await page.keyboard.press("k");
  await waitPending(1);
  await page.evaluate(() => window.__releaseTargets());
  await page.waitForFunction(() => window.__pendingTargets() === 0);
  await waitSelected("far-2");
  assert.equal(await selected(), "far-2", "点过别的之后按 K 要从选中那行重新算，不接着上一串");

  console.log("outbound open race tests passed");
} finally {
  await browser?.close();
  await server.close();
}
