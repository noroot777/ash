// 摘要内部那第二层折叠的 DOM 回归：报告照格式写了、问题却超过 5 条时，前 5 条铺开、
// 其余收进「展开其余 N 条问题」，第四栏「不拦验收、但你该知道的」跨过这一层继续留在首屏。
// （用户 2026-09-27 裁定，见 `5a34b180`。）
//
// 跟 `test-review-report-split-dom.mjs` 分开是因为盯的东西不同：那一份盯「技术记录默认
// 不占屏幕」，这一份盯**两个折叠互不干扰**——
//
// ① 里面那个装的是**问题**，按钮照实写有几条，绝不套用技术明细那句「验证过程、证据、
//    清场记录」的承诺；
// ② 两个折叠各开各的：点开一个，另一个的 `aria-expanded` 不动、正文也不该冒出来。
//    `aria-controls` 各指各的容器——这是屏幕阅读器能分清「这个按钮管哪一块」的唯一依据，
//    两个按钮共用一个 id 的话，展开状态在无障碍树里就是一笔糊涂账；
// ③ 折叠不是丢弃：两层都展开后，每条问题的标题和三行、第四栏，各自**恰好出现一次**——
//    解析层的守恒证得了「切片没丢字节」，证不了「同一段被渲染了两遍」，那得在这里验；
// ④ 恰好 5 条的报告一个按钮都不该多画；
// ⑤ 这一层**跟权威结论无关**。同一份正文配 `verify_failed` 和 `verified` 各挂一份：里层
//    的文案、条数、切点一模一样，只有外层那个按钮跟着结论变。问题多到 6 条的报告几乎
//    必然是没通过的那一批——把这一层绑到 `contract` 档上等于原地关掉它。
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

/** 一段文本里某个片段出现几次。数「恰好一次」用它，不用 `getByText`——后者连祖先一起算。 */
const times = (text, needle) => text.split(needle).length - 1;

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/review-report-split.html`);

  const six = page.locator(".six-problems-fixture");
  await six.locator(".task-markdown").first().waitFor();

  const moreToggle = six.getByRole("button", { name: /其余 1 条问题/ });
  const detailToggle = six.getByRole("button", { name: /完整报告/ });

  // ① 默认态：前五条在屏幕上，第六条和技术记录都不在 DOM 上。
  const head = await six.locator(".task-markdown").first().innerText();
  assert.match(head, /有 6 条必须先修/, "报了几条要默认可见");
  assert.match(head, /5\. 第 5 处操作会出错/, "第五条仍在首屏");
  assert.match(head, /建议怎么修：把第 5 处的判断改回来/, "第五条的三行也在首屏");
  assert.doesNotMatch(head, /第 6 处操作会出错/, "第六条默认不该铺在首屏");
  assert.equal(await six.locator(".review-report-detail").count(), 0, "两层折叠默认都不挂在 DOM 上");

  // 第四栏跨过中段留在首屏——它要是被卷进折叠，用户就得点一下才知道「还有什么不拦验收」。
  const aside = six.locator(".task-markdown").nth(1);
  assert.match(await aside.innerText(), /不拦验收、但你该知道的/, "第四栏单独一段，默认可见");

  assert.equal(await moreToggle.count(), 1, "超过五条要给一个照实说话的出口");
  assert.equal(await detailToggle.count(), 1, "外层那个出口照旧");
  assert.doesNotMatch(
    await moreToggle.innerText(),
    /验证过程|证据|清场|完整报告/,
    "里层装的是问题，按钮只说条数，不准套用外层任何一句文案",
  );
  assert.equal(await moreToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await detailToggle.getAttribute("aria-expanded"), "false");

  // ② 点开里层：外层一动不动。
  await moreToggle.click();
  const moreId = await six.getByRole("button", { name: /收起其余 1 条问题/ }).getAttribute("aria-controls");
  assert.ok(moreId, "展开后按钮必须指得出自己管的那一块");
  const morePanel = page.locator(`[id="${moreId}"]`);
  assert.equal(await morePanel.count(), 1, "`aria-controls` 指向的容器得真在 DOM 上");
  assert.match(await morePanel.innerText(), /6\. 第 6 处操作会出错/, "第六条展开后就在里面");
  assert.match(await morePanel.innerText(), /建议怎么修：把第 6 处的判断改回来/, "三行齐全");
  assert.doesNotMatch(await morePanel.innerText(), /基线|清场|退出 0/, "技术记录不该混进里层");
  assert.equal(
    await detailToggle.getAttribute("aria-expanded"),
    "false",
    "点开里层不许连带把外层的状态也翻过去",
  );
  assert.equal(
    await six.locator(".review-report-detail").count(),
    1,
    "外层正文这时还不该挂在 DOM 上",
  );

  // 展开里层之后，第四栏仍然在屏幕上，而且在第六条**后面**——它是摘要的收尾，不是被
  // 中段顶到折叠里去的东西。
  const shown = await six.innerText();
  assert.ok(
    shown.indexOf("第 6 处操作会出错") < shown.indexOf("不拦验收、但你该知道的"),
    "第四栏排在中段之后，顺序不能乱",
  );

  // ③ 再点开外层：两块同时在，各自的 id 不同。
  await detailToggle.click();
  const detailId = await six.getByRole("button", { name: /收起完整报告/ }).getAttribute("aria-controls");
  assert.ok(detailId, "外层展开后同样要指得出自己管的那一块");
  assert.notEqual(detailId, moreId, "两个折叠不能共用一个 id，否则无障碍树上分不清谁管谁");
  assert.match(await page.locator(`[id="${detailId}"]`).innerText(), /基线/, "技术记录在外层里");
  assert.equal(
    await six.getByRole("button", { name: /收起其余 1 条问题/ }).getAttribute("aria-expanded"),
    "true",
    "点开外层不该把里层关掉",
  );

  // 折叠不是丢弃，也不是重复：两层都开着时，每条问题、每一行、第四栏各出现一次。
  const all = await six.innerText();
  for (let at = 1; at <= 6; at += 1) {
    assert.equal(times(all, `第 ${at} 处操作会出错`), 1, `第 ${at} 条的标题只该出现一次`);
    assert.equal(times(all, `把第 ${at} 处的判断改回来`), 1, `第 ${at} 条的「建议怎么修」只该出现一次`);
  }
  assert.equal(times(all, "不拦验收、但你该知道的"), 1, "第四栏只该出现一次");

  // 收起里层，外层不受影响。
  await six.getByRole("button", { name: /收起其余 1 条问题/ }).click();
  assert.doesNotMatch(await six.innerText(), /第 6 处操作会出错/, "里层收得回去");
  assert.equal(
    await six.getByRole("button", { name: /收起完整报告/ }).getAttribute("aria-expanded"),
    "true",
    "收起里层不该把外层也关掉",
  );

  // ④ 恰好五条：一个按钮都不多画。「展开其余 0 条问题」是纯噪音。
  const five = page.locator(".five-problems-fixture");
  assert.equal(await five.getByRole("button", { name: /其余/ }).count(), 0, "五条不该分层");
  assert.equal(await five.getByRole("button", { name: /完整报告/ }).count(), 1, "外层那个照旧");
  const fiveHead = await five.locator(".task-markdown").first().innerText();
  assert.match(fiveHead, /5\. 第 5 处操作会出错/, "五条全在首屏");
  assert.match(fiveHead, /不拦验收、但你该知道的/, "不分层时第四栏就在同一段里");

  // ⑤ 换一轮报告，两个折叠都得复位。漏一个，下一轮一打开就是上一轮展开着的样子。
  const switchable = page.locator(".six-switch-fixture");
  await switchable.getByRole("button", { name: /展开其余 1 条问题/ }).click();
  await switchable.getByRole("button", { name: /展开技术明细/ }).click();
  assert.equal(await switchable.locator(".review-report-detail").count(), 2, "两层都开着");
  await switchable.getByRole("button", { name: "切换轮次" }).click();
  assert.equal(
    await switchable.locator(".review-report-detail").count(),
    0,
    "换一轮报告，两个折叠都要回到收起",
  );
  assert.equal(
    await switchable.getByRole("button", { name: /展开其余 1 条问题/ }).count(),
    1,
    "复位后按钮回到「展开」那一面",
  );

  // ⑤ 同一份正文、换一个权威结论：里层一个字不变，只有外层按钮换文案。
  const verified = page.locator(".six-verified-fixture");
  assert.equal(
    await verified.getByRole("button", { name: /展开技术明细（验证过程、证据、清场记录）/ }).count(),
    1,
    "通过了的那一份，外层才配写那句承诺",
  );
  assert.equal(
    await verified.getByRole("button", { name: /展开其余 1 条问题/ }).count(),
    1,
    "里层跟权威结论无关，通过与否都照折照说",
  );
  assert.equal(
    await verified.locator(".task-markdown").first().innerText(),
    await six.locator(".task-markdown").first().innerText(),
    "换个结论不许动首屏那一刀",
  );
  assert.equal(
    await verified.getByRole("button", { name: /其余/ }).innerText(),
    await moreToggle.innerText(),
    "里层按钮的文案不跟着结论变",
  );

  console.log("review report summary fold dom ok");
} finally {
  await browser?.close();
  await server.close();
}
