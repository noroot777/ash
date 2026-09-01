// 刷新页面时不许先闪一屏登录外壳。跑：npm -w web run test:auth-boot
//
// 用户报的现象:远程访问的实例,每次刷新都先「唰」地出现一屏深色品牌登录页,然后才进
// 工作台。成因不是设计,是首屏时序 —— `GET /api/auth/state` 决定渲染工作台/向导/登录页,
// 而它原本**串**在 bundle 之后(mount → effect → fetch),本机零延迟看不出来,远程那一个
// RTT 刚好够把外壳闪出来再跳走。两头一起修,所以这里钉四条:
//   ① 状态很快回来(本机/预热命中):从头到尾**一个过渡屏都不出现**,直接是工作台;
//   ② 状态真的慢:仍然不许出现整块外壳,但要给出低调的等待态,别让人对着空屏猜;
//   ③ 等待态的阈值以 AuthGate 的源码为准 —— 测试跟着它走,改阈值不用改这里;
//   ④ index.html 里那发预热请求还在,而且确实**赶在 bundle 之前**发出去(整个修复的
//      前提就是它俩并行;它被删掉的话 ① 会静默退化成「本机也要等一个 RTT」)。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { readSource } from "../../scripts/read-source.mjs";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const gateSource = readSource(new URL("../src/auth/AuthGate.tsx", import.meta.url));
const indexSource = readSource(new URL("../index.html", import.meta.url));
const probeSource = readSource(new URL("../src/lib/authProbe.ts", import.meta.url));

// ③ 阈值从源码里读,测试的两个延迟按它算 —— 写死一个 400 就会在改阈值那天变成假绿。
const thresholdMatch = /setWaitedLong\(true\), (\d+)\)/.exec(gateSource);
assert(thresholdMatch, "AuthGate 里那个「等多久才给等待态」的 setTimeout 没了或改了形状");
const threshold = Number(thresholdMatch[1]);
assert.ok(threshold >= 200 && threshold <= 1200, `等待阈值 ${threshold}ms 不在合理区间`);

// ④ 预热脚本必须还在,而且两头对得上:全局名一致、路径就是 authApi 打的那一条。
assert.match(indexSource, /window\.__ashAuthProbe\s*=\s*fetch\(\s*"\/api\/auth\/state"/,
  "index.html 里的身份预热请求没了 —— 没有它,首屏那一个 RTT 又会串回 bundle 后面");
assert.ok(indexSource.indexOf("__ashAuthProbe") < indexSource.indexOf('src="/src/main.tsx"'),
  "预热脚本必须排在 bundle 那条 script 之前,否则它就不是并行的");
// 装它的必须是**同步的经典脚本**:带上 type="module" 就成了 defer,跟 bundle 一起排到
// 解析之后跑,提前量当场归零 —— 而这种改法从渲染结果上完全看不出来。
const probeAt = indexSource.indexOf("window.__ashAuthProbe");
const tagStart = indexSource.lastIndexOf("<script", probeAt);
assert.ok(tagStart >= 0, "没在 index.html 里找到装预热请求的那个 <script>");
const probeAttrs = indexSource.slice(tagStart + "<script".length, indexSource.indexOf(">", tagStart));
assert.doesNotMatch(probeAttrs, /type\s*=/, "预热脚本不能带 type —— module 会让它 defer,就不再抢在 bundle 前面了");
assert.doesNotMatch(probeAttrs, /\b(?:defer|async)\b/, "预热脚本不能 defer/async,那正好抵消它存在的理由");
assert.match(probeSource, /window\.__ashAuthProbe/, "authProbe.ts 接的全局名要和 index.html 写的那个一致");

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

// 每个页面都从零开始记:React 把外壳插进来又拿掉,轮询采样抓不住,只有 MutationObserver
// 能回答「它有没有出现过」—— 而「闪一下」正是这个问题。
const watchTransitions = `
  window.__seen = { shell: false, booting: false };
  const mark = () => {
    if (document.querySelector(".auth-shell")) window.__seen.shell = true;
    if (document.querySelector(".auth-booting")) window.__seen.booting = true;
  };
  new MutationObserver(mark).observe(document, { childList: true, subtree: true });
  mark();
`;

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  const origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  // 这里每一步都该是秒级的:真卡住时要看见「卡在哪一步」,而不是让整条 build 无限期挂着。
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  await page.addInitScript(watchTransitions);

  // 预热一次:vite dev 首次编译那几百毫秒会把下面的时序判断搅浑,而它跟被测行为无关。
  await page.goto(`${origin}/scripts/fixtures/auth-boot.html?delay=0`);
  await page.locator(".probe-workbench").waitFor();

  // ① 快路径:一个过渡屏都不该出现。
  await page.goto(`${origin}/scripts/fixtures/auth-boot.html?delay=0`);
  await page.locator(".probe-workbench").waitFor();
  const fast = await page.evaluate(() => window.__seen);
  assert.equal(fast.shell, false, "状态很快回来时闪了一屏登录外壳 —— 这正是用户报的那个现象");
  assert.equal(fast.booting, false, "状态很快回来时不该出现等待态,它比什么都不显示更吵");

  // ② 慢路径:外壳仍然不许出现,但要有低调的等待态,而且状态到了要让位给工作台。
  await page.goto(`${origin}/scripts/fixtures/auth-boot.html?delay=${threshold + 600}`);
  await page.locator(".auth-booting").waitFor({ timeout: threshold + 3000 });
  assert.equal(
    await page.locator(".auth-booting").innerText(),
    "正在确认身份…",
    "等待态要说清楚在等什么",
  );
  assert.equal(await page.locator(".probe-workbench").count(), 0, "身份没确认完就不该放行工作台");
  await page.locator(".probe-workbench").waitFor({ timeout: threshold + 3000 });
  const slow = await page.evaluate(() => window.__seen);
  assert.equal(slow.shell, false, "慢的时候也只给一行等待态,不许把整块品牌外壳搬出来");
  assert.equal(slow.booting, true, "等待态没出现过 —— 慢响应下用户会对着空屏猜");
  assert.equal(await page.locator(".auth-booting").count(), 0, "状态到手后等待态要撤掉");

  // ④ 真 index.html:预热请求确实赶在 bundle **执行**之前起飞。比的不是两条请求谁先发出
  // —— 浏览器的预扫描器会提前把 `<script src>` 抓下来,那个顺序说明不了问题;串行与否
  // 取决于「fetch 起飞时,bundle 跑起来没有」。main.tsx 被换成一行打点的替身:这条只量
  // 时序,不需要把整个工作台拉起来。
  //
  // 身份那条也自己接住:放它走 vite 的 /api 代理,这个测试就变成「本机 4317 上有没有真
  // ash 在跑」的函数 —— 结果不稳,而且那条代理连接会吊着不放,跑完了进程都退不出去。
  await page.route("**/api/auth/state", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "single", needsSetup: false, user: null, rootDir: null, homeDir: null }),
    }));
  await page.route("**/src/main.tsx", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "window.__bundleRanAt = performance.now();",
    }));
  await page.goto(origin, { waitUntil: "load" });
  const timing = await page.evaluate(() => {
    const entry = performance
      .getEntriesByType("resource")
      .find((item) => new URL(item.name).pathname === "/api/auth/state");
    return { probeStart: entry ? entry.startTime : null, bundleRanAt: window.__bundleRanAt ?? null };
  });
  assert.ok(timing.probeStart !== null, "打开首页没有发出身份预热请求");
  assert.ok(timing.bundleRanAt !== null, "bundle 没跑起来,这条断言的前提不成立");
  assert.ok(
    timing.probeStart <= timing.bundleRanAt,
    `预热请求比 bundle 执行还晚(${timing.probeStart} vs ${timing.bundleRanAt}) —— 又串行了`,
  );

  console.log("auth boot: 快路径无过渡屏、慢路径只给等待态、预热请求与 bundle 并行 ✔");
} finally {
  await browser?.close();
  await server.close();
}
