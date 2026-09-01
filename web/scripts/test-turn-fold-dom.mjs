// 回合折叠的时机（渲染结果，切分逻辑本身由 test:turn-fold 钉住）。
//
// 钉的是一条硬规矩：**一条回合还在飞的时候一律平铺，它自己收口那一下才折**。
//
// 折叠是个重组动作 —— 它把最后一次动手之前的一切（连同已经说出口、已经露在外面的正文）
// 收进「执行过程」块，外面只留最后那段话。跑的过程中干这件事，用户看到的就是：agent 一
// 说话，上面读到一半的内容被吸走；下一个工具调用又把它们吐回来。所以运行期连切都不切。
//
// 另一头同样要钉：闸只看**这一条回合**，不看整个任务停没停。任务往下还有换轮、就地验证、
// 审查门、团队执行者要跑，拿任务状态当闸，讲完的回合会一直摊着不收（用户 2026-09-01：
// 「这个执行完了怎么没有自动折叠」）。折起来之后用户自己动过折角，重绘也不许按回去。
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/turn-fold.html`);

  const turn = (name) => page.locator(`[data-case="${name}"]`);
  const fold = (name) => turn(name).locator("details.task-turn-process");
  const folded = (name) => fold(name).count();
  const isOpen = (name) => fold(name).evaluate((el) => el.open);
  // 过程里那句话：折起来就该看不见，没折就该露在外面。
  const processText = (name) => turn(name).getByText("真实页面已在后台标签打开并操作");
  const conclusionText = (name) => turn(name).getByText("第 2 轮结论");
  // 开合/重排是 useEffect 与重渲染干的。「不该发生」这类负向断言没法 waitFor，等两帧。
  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const click = async (name, role) => {
    await turn(name).locator(`[data-role="${role}"]`).click();
    await flush();
  };

  await turn("live").waitFor();

  // 1. 回合正在飞：**一个过程块都不该有**。说过的话全在外面，工具各自一条折叠行（默认
  //    收起，那是它本来的样子，这次不动它）。
  assert.equal(await folded("live"), 0, "跑的时候不该把回合重组成「过程 + 结论」");
  assert.equal(await processText("live").isVisible(), true, "跑的时候说过的话必须留在外面");
  assert.equal(await conclusionText("live").isVisible(), true);
  assert.equal(await turn("live").locator("details.task-execution-block").count(), 3, "工具照旧逐段一条");
  assert.equal(
    await turn("live").locator("details.task-execution-block").evaluateAll((els) => els.some((el) => el.open)),
    false,
    "逐段那几条保持原样（默认收起，用户自己点开）",
  );

  // 2. 这一回合收口了：这一下才折 —— 过程收进去（且是收起的），结论留在外面。
  await click("live", "end-turn");
  await fold("live").waitFor();
  assert.equal(await isOpen("live"), false, "折的时候就该是收起的");
  assert.equal(await processText("live").isVisible(), false, "过程正文该被折进去");
  assert.equal(await conclusionText("live").isVisible(), true, "结论任何时候都不该被折起来");
  assert.equal(await turn("live").getByText("工作树保持干净").isVisible(), true, "记账之后的收尾句也是结论");

  // 3. 记账调用不当切点：complete_task 并进过程块，不在结论区自成一条折叠行。
  assert.equal(await fold("live").locator(".task-tool-line").count(), 3);
  assert.equal(
    await turn("live").locator("details.task-execution-block:not(.task-turn-process)").count(),
    0,
    "结论区不该再夹一条「执行过程」折叠行",
  );

  // 4. 折起来之后用户自己展开：后续重绘不许再把它按回去。
  await fold("live").locator("summary").click();
  assert.equal(await isOpen("live"), true);
  await click("live", "repaint");
  await turn("live").getByText("触发重绘 1").waitFor();
  await click("live", "repaint");
  await turn("live").getByText("触发重绘 2").waitFor();
  assert.equal(await isOpen("live"), true, "用户手动展开后被重绘按了回去");

  // 5. 又被续跑（回复 / resume）：回合重新活了，折叠整个撤掉，回到平铺。
  await click("live", "restart-turn");
  await flush();
  assert.equal(await folded("live"), 0, "重新开跑之后不该还留着过程块");
  assert.equal(await processText("live").isVisible(), true);

  // 6. 刷新后读到的历史回合（早就收口了）：首屏就是折好的，不该先摊开再收。
  assert.equal(await folded("persisted"), 1);
  assert.equal(await isOpen("persisted"), false, "已结束的回合首屏就该是折好的");
  assert.equal(await processText("persisted").isVisible(), false);
  assert.equal(await conclusionText("persisted").isVisible(), true);

  // 7. 未确认完成的失败回合（老会话形状）：结算补的那条异常不是切点 —— 整篇回答留在
  //    折叠外面，异常并进过程块（折叠条标红）。
  assert.equal(await isOpen("failed"), false);
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

  // 8. 用户抱怨的那条时序，逐帧钉死：同一条回合边跑边长 —— 说话 → 工具 → 又说话 →
  //    又工具 → 再说一句。每一帧都必须 (a) 没有过程块 (b) 之前说过的每句话都还在外面。
  //    原来的行为是：第 3 帧、第 5 帧（最后一步是文字）会把上面全部收编进过程块。
  const saidSoFar = [
    "类型检查的失败仍是",
    "可见改动涉及抽屉",
    "node_repl 没能解析到 Vite",
  ];
  const visibleSays = async () => {
    const shown = [];
    for (const text of saidSoFar) {
      if (await turn("grow").getByText(text).count()) shown.push(text);
    }
    return shown;
  };
  await turn("grow").getByText(saidSoFar[0]).waitFor();
  // 第 n 帧时应该露在外面的正文（帧序：说话 / 工具 / 说话 / 工具 / 说话）。
  const expected = [[0], [0], [0, 1], [0, 1], [0, 1, 2]];
  for (let frame = 0; frame < expected.length; frame += 1) {
    if (frame) await click("grow", "grow");
    await flush();
    assert.equal(await folded("grow"), 0, `第 ${frame + 1} 帧：跑的中途把回合折了`);
    assert.deepEqual(
      await visibleSays(),
      expected[frame].map((index) => saidSoFar[index]),
      `第 ${frame + 1} 帧：说过的话被收编进过程块了`,
    );
  }
  // 收口这一下才折：三段正文里，只有最后一句留在外面。
  await click("grow", "end-turn");
  await fold("grow").waitFor();
  assert.equal(await isOpen("grow"), false);
  assert.equal(await turn("grow").getByText(saidSoFar[0]).isVisible(), false, "讲完了，前面的正文该折进去");
  assert.equal(await turn("grow").getByText(saidSoFar[2]).isVisible(), true, "最后那句是结论，留在外面");

  // 9. 会话流喂给回合的那个「在飞没有」：走真实时序 —— 单飞 running → 停在检查点 →
  //    卡在审查门 → 收尾；团队 调度台在说话 → 落回 idle 但执行者还在跑 → 全队收工。
  //    **任务没走完不是不折的理由**：回合一收口就该折，否则用户要等整条链路结束才见到
  //    折叠（2026-09-01 的现场就是「任务运行中，讲完的那一回合一直摊着」）。
  const feedFolded = (name) => page.locator(`[data-case="${name}"] details.task-turn-process`).count();
  const feedStep = async (name, role) => {
    await page.locator(`[data-case="${name}"] [data-role="${role}"]`).click();
    await flush();
  };

  assert.equal(await feedFolded("feed-single"), 0, "回合在飞，会话流里不该有过程块");
  await feedStep("feed-single", "to-paused");
  assert.equal(await feedFolded("feed-single"), 1, "回合收口了（哪怕任务停在检查点）就该折");
  await feedStep("feed-single", "to-gate");
  assert.equal(await feedFolded("feed-single"), 1, "任务卡在审查门上，讲完的那一回合照折");
  await feedStep("feed-single", "to-done");
  assert.equal(await feedFolded("feed-single"), 1, "任务收尾后照旧是折着的");

  assert.equal(await feedFolded("feed-team"), 0, "调度台还在说话，不该折");
  await feedStep("feed-team", "to-dispatched");
  assert.equal(await feedFolded("feed-team"), 1, "调度台这一回合讲完了，执行者还在跑也该折");
  await feedStep("feed-team", "to-settled");
  assert.equal(await feedFolded("feed-team"), 1, "全队收工后照旧是折着的");

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  console.log("turn fold dom tests passed");
} finally {
  await browser?.close();
  await server.close();
}
