// 切换任务时，预览按钮那点**在途状态不能跟着漂过去**。跑：npm -w web run test:preview-task-switch
//
// 钉三条，全是同一个根子（动作是本地状态、组件切任务时不重新挂载）长出来的：
//   ① A 的启动请求还挂着时切到 B，B 那颗必须是干净的「打开预览」——不是 A 遗留的
//      「启动中·点此取消」。
//   ② 因此点它发的是 `POST B`，不是 `DELETE B`：老实现会把 B 自己的预览停掉，而 A 那趟
//      照旧在跑。
//   ③ A 的请求**晚一步**回来时，不许清掉 B 正在进行的动作、不许关掉 B 的日志入口，
//      也不许在 B 的页面上弹通知、开新标签页 —— 用户此刻看的根本不是 A。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { fetchLog, settlePage, trackFetches, waitUntil } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  // 夹具在页面里当假服务端：记下每一发预览启动请求，好知道 A 那趟什么时候被页面读完。
  await trackFetches(page, "/free-workflow/preview$");
  await page.goto(`${web.origin}/scripts/fixtures/preview-task-switch.html`);

  // ① A 上点开预览，请求挂着 —— 这颗现在是可点的取消。
  await page.getByRole("button", { name: "打开预览" }).click();
  await page.getByRole("button", { name: "启动中·点此取消" }).waitFor();

  // ② 切到 B：B 从来没起过预览，快照也明说 running:false / starting:false。
  await page.getByTestId("to-b").click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid=current-task]")?.textContent?.includes("T-B") ?? false,
  );
  const openOnB = page.getByRole("button", { name: "打开预览" });
  await openOnB.waitFor();
  assert.equal(
    await page.getByRole("button", { name: "启动中·点此取消" }).count(), 0,
    "A 的在途动作漂到了 B 的按钮上",
  );

  // ③ 在 B 上点这颗：必须是「起 B 的预览」，不能是「停 B 的预览」。
  await openOnB.click();
  await page.getByRole("button", { name: "启动中·点此取消" }).waitFor();
  // B 正在冷启动，日志入口就是它此刻唯一能看见的东西。
  // 预览日志在「更多」里（reply-3）：这一页上「更多」里只有它，「更多」在 = 日志入口在。
  await page.locator(".free-workflow-toolbar .ui-menu-anchor > button").waitFor();
  const afterClick = await page.evaluate(() => window.__calls);
  assert.equal(afterClick.postsB, 1, "在 B 上点「打开预览」没有起 B 的预览");
  assert.equal(afterClick.deletesB, 0, "在 B 上点下去反而给 B 发了停止请求");
  assert.equal(afterClick.postsA, 1, "A 的那次启动请求不该被重发");

  if (process.env.PREVIEW_SWITCH_SHOT) await page.screenshot({ path: process.env.PREVIEW_SWITCH_SHOT });

  // ④ A 的请求晚一步成功返回：它属于用户已经离开的那个任务，既不能清掉 B 的动作，
  //    也不能在 B 的页面上说话、开窗。
  await page.getByTestId("finish-a").click();
  // A 那趟 200 已被页面读完（它的 then/finally 同一轮里就跑完了），再冲刷一轮渲染才读结果。
  await waitUntil(async () => (await fetchLog(page))
    .some((entry) => entry.url.includes("/T-A/") && entry.method === "POST" && entry.state === "settled"),
  "A 那趟迟到的启动请求已被页面消费完");
  await settlePage(page);
  const afterLate = await page.evaluate(() => ({
    calls: window.__calls,
    notices: document.querySelector("[data-testid=notices]")?.textContent ?? "",
    label: document.querySelector("button.is-preview")?.textContent ?? "",
    logEntries: document.querySelectorAll(".free-workflow-toolbar .ui-menu-anchor > button").length,
  }));
  assert.deepEqual(afterLate.calls.opens, [], "A 的成功回调在 B 的页面上弹开了新标签页");
  assert.equal(afterLate.notices.includes("预览已打开"), false, "A 的成功通知弹到了 B 的页面上");
  assert.match(afterLate.label, /启动中·点此取消/, "A 的旧请求回来时把 B 正在进行的动作清掉了");
  assert.equal(
    afterLate.logEntries, 1,
    "A 的 finally 把 B 冷启动期间唯一的日志入口关掉了——B 还要装六分钟依赖",
  );

  console.log("preview task switch: ok");
} finally {
  await browser?.close();
  await web.close();
}
