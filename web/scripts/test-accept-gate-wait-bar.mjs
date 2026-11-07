// 主会话页上那条「验收前置命令在跑」的折叠条(`AcceptGateWaitCard`)。从
// test-accept-gate-dom.mjs 拆出来 —— 那份贴着 700 行的上限,而这是**另一个表面**:验收台
// 那张卡回答「这次验收拿什么放的行」,这条只回答一件事「现在有东西在跑」。四条钉的是
// ⑮ 折叠那一行说清在跑哪条命令、秒表自己走 ⑯ 没在跑就不占地方 ⑰ 迟到的旧响应不许落地
// ⑱ 读不出来要照实说(各自的理由与出处写在下面它们自己头上)。
import assert from "node:assert/strict";
import { stopwatchSeconds, waitForStopwatchTick } from "./accept-gate-stopwatch.mjs";
import { fetchLog, fetchesSettled, settlePage, waitUntil } from "./wait-until.mjs";

export async function testAcceptGateWaitBar({ open, run }) {
  // ⑮ 主会话页那条折叠条（用户 2026-10-23 的 04-A）：门禁跑的十几分钟里任务本身
  //    status/stage 一个字都不变，这条是会话页上**唯一**看得出「有东西在跑」的东西。
  //    折叠态要把命令和已经跑了多久都写在一行；展开能就地收掉它。
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null, logTail: "RUN x_post\n" });
    const { page, store } = await open({ gate: { command: running.command, running, latest: null }, query: "?wait=1" });
    const bar = page.locator(".accept-gate-wait");
    await bar.waitFor();
    const text = await bar.innerText();
    assert.match(text, /验收前置命令在跑/);
    assert.match(text, /\.\/kb\.sh test full/, "折叠那一行要说清在跑的是哪条命令");
    // 秒表要自己走，不能定在点下去那一刻 —— 两条读数一起证，容差与理由见 stopwatchSeconds。
    const first = stopwatchSeconds(text);
    assert.ok(first >= 90,
      `秒表要从开跑那一刻（startedAt 是 90 秒前）起算，不能定在点下去那一刻：读到 ${first} 秒`);
    await waitForStopwatchTick(page, bar, first);
    // 折叠态不许把出路摆出来占地方，但点开就得有。
    assert.equal(await bar.getByRole("button", { name: /不等了/ }).count(), 0);
    await bar.locator(".wait-bar__bar").click();
    await bar.getByRole("button", { name: /不等了/ }).click();
    await waitUntil(() => store.canceled === 1, "收掉它要真打那一发 cancel");
    await page.locator(".accept-gate-wait").waitFor({ state: "detached" })
      .catch(() => assert.fail("收掉之后这条就该消失 —— 它只说「正在跑」"));
    assert.equal(store.canceled, 1, "只打一发 cancel");
    await page.close();
  }

  // ⑯ 没在跑就彻底不占地方：跑完之后该看的是验收台上那张回执，不是这条。
  {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest: run() }, query: "?wait=1" });
    await fetchesSettled(page, 1, "门禁状态已读到");
    assert.equal(await page.locator(".accept-gate-wait").count(), 0);
    await page.close();
  }

  // ⑰ **第 1 轮审查 F3**：并发读取乱序。追平层是单飞的，同一页上两发读取同时在外只有一种
  //    来路：在途那一发被作废（断线、开发期 StrictMode 的卸载重挂），随后另发一发，而作废的
  //    那一发在传输层上还可能回来。让最先到服务端的那一次扣着、回的是「正在跑」，其余的都回
  //    「已通过」；等页面已经落在「已通过」上再放它回来 —— 它不许把已经结束的那次又写回
  //    「正在跑」。从前旧响应会这样写回去，秒表接着加，而此后没有任何事件会来纠正它。
  //
  //    每一步都靠事实，不靠睡，也不赌请求到达的先后：StrictMode 作废的那一发在满载下可能
  //    没到路由就被掐掉，于是「第 0 次」有时是它、有时是真正在途的那一发 —— 所以测试显式
  //    断一次线再重连，扣着的那一发无论是谁，放行时都已经作废了；而且它必须是**最后**落地的，
  //    否则后面的读取会把它写回的东西盖掉，断言什么都证明不了。更早这里是「迟到 1200ms +
  //    睡 1800ms」，门禁 8 路并行时 1.8 秒连第 2 次都还没落地（2026-11-06 闪红）。
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const late = Promise.withResolvers();
    const { page, store } = await open({
      gate: { command: running.command, running: null, latest: run(), basis: null },
      query: "?wait=1&expected=1",
      events: true,
      states: [{ hold: late.promise, body: { command: running.command, running, latest: running, basis: null } }],
    });
    await page.locator("h1").waitFor();
    await waitUntil(() => store.reads >= 1, "挂载那一次读取发出去");
    const gateReads = async () => (await fetchLog(page)).filter((entry) => entry.url.endsWith("/accept-gate"));
    await page.evaluate(() => window.dropGateStream());
    await settlePage(page);
    await page.evaluate(() => window.reopenGateStream());
    await waitUntil(async () => (await gateReads()).some((entry) => entry.outcome === "ok"),
      () => `重连之后的对账读取落地「已通过」（服务端收到 ${store.reads} 次）`);
    await settlePage(page);
    late.resolve();
    await store.served(0);
    const log = await fetchesSettled(page, 0, "扣着的那一发放回来之后被页面消费完（读完或已被 abort）");
    await settlePage(page);
    assert.equal(await page.locator(".accept-gate-wait").count(), 0,
      `迟到的旧响应不许把已经结束的那次又写回「正在跑」（各次读取的结局：${log.filter((entry) => entry.url.endsWith("/accept-gate")).map((entry) => entry.outcome).join(" / ")}）`);
    await page.close();
  }

  // ⑱ 状态读不出来、而任务投影说有命令在跑：这条**仍然要出现**并如实说读不出来。从前
  //    一次 500 之后它整个消失，跟「什么都没在跑」长得一模一样（第 1 轮审查不拦项 3）。
  {
    const { page, store } = await open({
      gate: { command: "./kb.sh test full", running: null, latest: null, basis: null },
      query: "?wait=1&expected=1",
      states: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }],
    });
    const bar = page.locator(".accept-gate-wait");
    await bar.waitFor();
    assert.match(await bar.innerText(), /状态读不出来/);
    const before = store.reads;
    await bar.getByRole("button", { name: "重试" }).click();
    await waitUntil(() => store.reads > before, "重试要真的再读一次");
    await page.close();
  }
}
