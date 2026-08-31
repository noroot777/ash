// 回合折叠的开合时机（渲染结果，切分逻辑本身由 test:turn-fold 钉住）。
//
// 钉的就是「什么时候自动折起来」这一条：跑的时候必须摊开（不然用户盯着一行摘要不知道
// 在干嘛），**只有整个任务停下来那一刻**才收起 —— 回合边界在一次运行里能出现好几次
// （换轮、就地验证、会话行落 endedAt），跟着它折用户会在跑的中途被反复折叠。刷新后读到
// 的历史回合一上来就是折好的。还有一条同样要紧的反向约束：用户自己动过折角之后，后续
// 重绘不许再把它按回去。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/turn-fold.html`);

  const turn = (name) => page.locator(`[data-case="${name}"]`);
  const fold = (name) => turn(name).locator("details.task-turn-process");
  const isOpen = (name) => fold(name).evaluate((el) => el.open);
  // 过程里那句话：折起来就该看不见。
  const processText = (name) => turn(name).getByText("真实页面已在后台标签打开并操作");
  // 结论：任何时候都露在外面。
  const conclusionText = (name) => turn(name).getByText("第 2 轮结论");
  // 摘要条上的运行小圆点只在 running 时渲染，拿它当「新的 running 已经渲染」的信标。
  const settled = (name, running) =>
    turn(name).locator(".task-execution-pulse").waitFor({ state: running ? "attached" : "detached" });
  // 开合是 useEffect 干的，跑在渲染之后 —— 小圆点比它早到。「不该被掀开」这类负向断言
  // 没法 waitFor，只能等两帧确保 effect 已经有过机会，否则读到的是还没提交的旧值。
  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

  await fold("live").waitFor();

  // 1. 正在跑：摊开，过程和结论都看得见。
  assert.equal(await isOpen("live"), true, "回合还在跑，过程块不该是收起的");
  assert.equal(await processText("live").isVisible(), true);
  assert.equal(await conclusionText("live").isVisible(), true);

  // 2. 回合收口了、任务还在跑：**不许折**。这是本功能的主约束 —— 一次运行里回合边界
  //    出现好几次（换轮、就地验证、endedAt 落下来的那一瞬），跟着它折就等于跑的中途
  //    把用户正读的过程收走。
  await turn("live").locator('[data-role="end-turn"]').click();
  await settled("live", false);
  await flush();
  assert.equal(await isOpen("live"), true, "任务还在跑，回合结束不该把过程折起来");
  assert.equal(await processText("live").isVisible(), true);

  // 3. 最后一步确认执行完了：这时才自动收起，只留结论。
  await turn("live").locator('[data-role="end-task"]').click();
  await page.waitForFunction(
    () => !document.querySelector('[data-case="live"] details.task-turn-process').open,
  );
  assert.equal(await processText("live").isVisible(), false, "收工后过程正文该被折进去");
  assert.equal(await conclusionText("live").isVisible(), true, "结论任何时候都不该被折起来");
  assert.equal(await turn("live").getByText("工作树保持干净").isVisible(), true, "记账之后的收尾句也是结论");

  // 4. 记账调用不当切点：complete_task 被并进过程块，不在结论区自成一条折叠行。
  assert.equal(await fold("live").locator(".task-tool-line").count(), 3);
  assert.equal(
    await turn("live").locator("details.task-execution-block:not(.task-turn-process)").count(),
    0,
    "结论区不该再夹一条「执行过程」折叠行",
  );

  // 5. 用户自己展开之后，后续重绘不许再把它按回去。
  await fold("live").locator("summary").click();
  assert.equal(await isOpen("live"), true);
  await turn("live").locator('[data-role="repaint"]').click();
  await turn("live").getByText("触发重绘 1").waitFor();
  await turn("live").locator('[data-role="repaint"]').click();
  await turn("live").getByText("触发重绘 2").waitFor();
  await flush();
  assert.equal(await isOpen("live"), true, "用户手动展开后被重绘按了回去");
  assert.equal(await processText("live").isVisible(), true);

  // 6. 刷新后读到的历史回合：首屏就是折好的，不该先闪一下再收。
  assert.equal(await isOpen("persisted"), false, "已结束的回合首屏就该是折好的");
  assert.equal(await processText("persisted").isVisible(), false);
  assert.equal(await conclusionText("persisted").isVisible(), true);

  // 7. 任务还在跑时挂在上面的历史回合（跑到中途刷新页面、或续跑前面的那些轮）：
  //    「不折」不等于「掀开」，它自己没在飞就该保持折好。
  assert.equal(await isOpen("history"), false, "任务在跑不是把每一条历史回合都掀开的理由");
  assert.equal(await processText("history").isVisible(), false);

  // 8. 折好的历史回合又被续跑（回复、resume）：没人动过它，就跟着重新摊开。
  await turn("persisted").locator('[data-role="restart-turn"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-case="persisted"] details.task-turn-process').open,
  );
  assert.equal(await processText("persisted").isVisible(), true);

  // 9. 但用户自己收起来的，续跑不许替他掀开 —— 这是 touched 那道闸唯一起作用的方向。
  await fold("persisted").locator("summary").click();
  assert.equal(await isOpen("persisted"), false);
  await turn("persisted").locator('[data-role="end-task"]').click();
  await settled("persisted", false);
  await flush();
  await turn("persisted").locator('[data-role="restart-turn"]').click();
  await settled("persisted", true);
  await flush();
  assert.equal(await isOpen("persisted"), false, "用户收起来的过程块被续跑掀开了");

  // 10. 未确认完成的失败回合：结算补的那条异常不是切点。整篇回答留在折叠外面，异常并进
  //     过程块（折叠条标红），失败说明那段引用照旧露在外面。
  assert.equal(await isOpen("failed"), false, "已结束的失败回合首屏就该是折好的");
  assert.equal(
    await turn("failed").getByText("会覆盖，而且只有一个槽").first().isVisible(),
    true,
    "整篇回答被结算那条异常折进过程了",
  );
  assert.equal(
    await turn("failed").getByText("没有收到 complete_task 的完成确认。").first().isVisible(),
    true,
    "失败说明该露在外面",
  );
  assert.equal(await fold("failed").evaluate((el) => el.classList.contains("has-error")), true);
  assert.equal(
    await turn("failed").locator("details.task-execution-block:not(.task-turn-process)").count(),
    0,
    "异常该并进过程块，不在结论区自成一条折叠行",
  );

  // 11. 会话流自己判「链路停没停」：走真实时序，回合先在飞、再收口，而任务这时卡在
  //     审查门上（单飞）/ 执行者还在干活（团队调度台已落回 idle）。这两档都不许折，
  //     直到整条链路真停下来。只钉 nextProcessFoldOpen 的话，喂给它的那个布尔算错了
  //     照样红不了 —— 所以这一段钉的是两个 feed 的接线。
  const feedFold = (name) => page.locator(`[data-case="${name}"] details.task-turn-process`);
  const feedOpen = (name) => feedFold(name).evaluate((el) => el.open);
  const step = async (name, role) => {
    await page.locator(`[data-case="${name}"] [data-role="${role}"]`).click();
    await flush();
  };

  await feedFold("feed-single").waitFor();
  assert.equal(await feedOpen("feed-single"), true, "回合在飞，会话流里的过程块该是摊开的");
  await step("feed-single", "to-gate");
  assert.equal(await feedOpen("feed-single"), true, "任务卡在审查门上，执行链路没走完，不该自动折");
  await step("feed-single", "to-done");
  assert.equal(await feedOpen("feed-single"), false, "任务收尾了才该折");

  assert.equal(await feedOpen("feed-team"), true, "调度台在说话，过程块该是摊开的");
  await step("feed-team", "to-dispatched");
  assert.equal(await feedOpen("feed-team"), true, "调度台派完活落回 idle，但执行者还在跑，不该折");
  await step("feed-team", "to-settled");
  assert.equal(await feedOpen("feed-team"), false, "全队收工了才该折");

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  console.log("turn fold dom tests passed");
} finally {
  await browser?.close();
  await server.close();
}
