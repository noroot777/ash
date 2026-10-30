// 「回合占位占着不动」那条救援路在**真实浏览器里**的三件事,都是上一轮审查点过的缺口:
//   ① 服务端读不准的那条记录(outcome=unknown)不许被说成「没有执行」—— 那和「生效了但
//      没到位」是相反的两件事,猜错方向会让用户对一次已经发生的操作再点一次;
//   ② 放开之后任务仍点不动时,开关和那句「接着该做什么」必须留在页面上(remedy 还在);
//   ③ 凭据对不上(用过了/过期了/上次启动发的)时服务端回 403,页面必须给出恢复路径
//      ——「重新加载页面」那颗按钮,否则用户看到的只是一个按下去没反应的开关。
// 顺带钉住凭据本身的链路:meta → 请求头 → 按响应轮换,且轮换对**整页所有真人动作表面**
// 生效(凭据是一份,不是每个开关一份)。
// 设 SHOT=<路径> 顺带截一张图自查版式。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });

const HEADER = "x-ash-human-action-token";
const REFUSAL = "这个动作需要本次会话的页面凭据：请在 ash 页面上点这个开关。凭据随页面下发、用一次就失效，刷新页面可以换一份新的";
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const notices = (rows, remedy = "reclaim-turn") => ({ notices: rows, remedy });
const at = (n) => `2026-10-31T0${n}:00:00.000Z`;

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, timezoneId: "Asia/Shanghai" });
  const origin = `http://127.0.0.1:${address.port}`;
  const fixture = `${origin}/scripts/fixtures/turn-remedy.html`;

  /** 每次 reclaim 请求带上来的凭据,按顺序记下 —— 轮换对不对全看这串。 */
  const sent = [];

  await page.route("**/api/tasks/t-stale/notices", (route) => json(route, notices([
    { id: "n4", action: "放开回合占位", outcome: "unknown", reason: "占位身份 single、已持有约 3 分钟", occurredAt: at(4) },
    { id: "n3", action: "回合占位已放开", outcome: "system", reason: "这个任务的回合占位已放开，由本机页面发起。", occurredAt: at(3) },
    { id: "n2", action: "放开回合占位", outcome: "incomplete", reason: "任务还停在「排队中」—— 点一次停止把它收成「已取消」", occurredAt: at(2) },
    { id: "n1", action: "运行", outcome: "rejected", reason: "任务回合正在进行，结束后再运行", occurredAt: at(1) },
  ])));
  await page.route("**/api/tasks/t-second/notices", (route) => json(route, notices([])));
  await page.route("**/api/tasks/t-denied/notices", (route) => json(route, notices([])));

  // 放开成功、但任务仍点不动:这一档必须留在页面上(它是用户唯一看得见的下一步)。
  await page.route("**/api/tasks/t-stale/reclaim-turn", (route) => {
    sent.push(route.request().headers()[HEADER]);
    return json(route, {
      reclaimed: true, role: "single", heldMs: 185_000, runnable: false, status: "queued",
      nextStep: "任务还停在「排队中」——点一次停止把它收成「已取消」，之后就能重新运行",
      // 照服务端那条路拼(task-run-routes.ts 的 reclaim-turn):note = 结论 + nextStep + 副作用。
      note: "已放开这个任务的回合占位，但它还点不动运行：任务还停在「排队中」——点一次停止把它收成「已取消」，之后就能重新运行"
        + "；如果原来那一位其实还活着，互斥就没了，同一个任务可能有两个回合并行改同一个工作区",
      nextHumanActionToken: "page-token-2",
    });
  });
  // 另一个任务的同类开关:凭据是整页共享的一份,这里必须收到轮换之后的那一份。
  await page.route("**/api/tasks/t-second/reclaim-turn", (route) => {
    sent.push(route.request().headers()[HEADER]);
    return json(route, { reclaimed: true, role: "single", heldMs: 1, runnable: true, status: "done", nextStep: null, note: "已放开这个任务的回合占位，现在可以继续运行" });
  });
  // 凭据对不上:服务端的真实形状(personal-gate.ts 的 403)。
  await page.route("**/api/tasks/t-denied/reclaim-turn", (route) => {
    sent.push(route.request().headers()[HEADER]);
    return json(route, { error: REFUSAL }, 403);
  });

  // ── ① 读不准的那一条:措辞不许往任何一个方向猜 ──
  await page.goto(`${fixture}?task=t-stale&second=t-second`);
  const lines = page.locator('[data-stage="t-stale"] .turn-remedy-notices li');
  await lines.first().waitFor();
  const texts = await lines.allInnerTexts();
  assert.equal(texts.length, 4, "四条记录都该进任务历史");
  const unknown = texts.find((t) => t.includes("读不准"));
  assert.ok(unknown, "服务端认不出那一格时,页面要照实说这条记录读不准");
  assert.match(unknown, /「放开回合占位」的结果读不准/);
  assert.doesNotMatch(unknown, /没有执行|生效了/, "读不准的那一条不许被说成已执行或未执行");
  assert.ok(texts.some((t) => /「运行」没有执行/.test(t)), "挡回那一条照旧说「没有执行」");
  assert.ok(texts.some((t) => /「放开回合占位」生效了，但还没到位/.test(t)), "没到位那一条措辞不变");
  assert.ok(texts.some((t) => /^〔系统〕/.test(t)), "系统诊断那一条带〔系统〕前缀");

  // ── ② 放开了却仍点不动:开关留在原地,并说出下一步 ──
  const stale = page.locator('[data-stage="t-stale"] .task-turn-remedy');
  await stale.waitFor();
  await stale.locator("button", { hasText: "放开回合占位" }).click();
  const result = stale.locator(".task-turn-remedy__result");
  await result.waitFor();
  assert.match(await result.innerText(), /还点不动运行.*点一次停止/s, "没恢复时必须给出接着该做的那一步");
  assert.equal(await stale.count(), 1, "没恢复就不许把开关收起来 —— 收起来等于让用户对着消失的入口猜");
  assert.equal(await result.locator("button").count(), 0, "这一档不是凭据问题,不该出现重新加载按钮");
  assert.equal(sent[0], "page-token-1", "请求必须带上页面文档里那份凭据");

  // ── 凭据轮换对整页生效:另一个表面接着按,带的是服务端刚给回的那一份 ──
  const second = page.locator('[data-stage="t-second"] .task-turn-remedy');
  await second.locator("button", { hasText: "放开回合占位" }).click();
  await second.locator(".task-turn-remedy__result").waitFor();
  assert.equal(sent[1], "page-token-2", "烧过一份之后,下一个真人动作必须换上响应里给回的那一份");

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  // ── ③ 403:给出恢复路径,而不是一个按下去没反应的开关 ──
  await page.goto(`${fixture}?task=t-denied`);
  const denied = page.locator('[data-stage="t-denied"] .task-turn-remedy');
  await denied.waitFor();
  await denied.locator("button", { hasText: "放开回合占位" }).click();
  const deniedResult = denied.locator(".task-turn-remedy__result");
  await deniedResult.waitFor();
  assert.match(await deniedResult.innerText(), /页面凭据/, "403 的原话要原样给用户看");
  const reload = deniedResult.locator("button", { hasText: "重新加载页面" });
  assert.equal(await reload.count(), 1, "凭据对不上时必须给出恢复路径");
  assert.equal(
    await denied.locator("button", { hasText: "放开回合占位" }).isDisabled(),
    false,
    "被拒之后开关要还能再按(换一份凭据就能成)",
  );
  if (process.env.SHOT_DENIED) await page.screenshot({ path: process.env.SHOT_DENIED, fullPage: true });

  console.log("turn remedy: 读不准的记录照实说、没恢复时开关与下一步都留着、凭据 403 给出重新加载入口 ✔");
} finally {
  await browser?.close();
  await server.close();
}
