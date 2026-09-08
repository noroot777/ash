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
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/preview-task-switch.html`);

  // ① A 上点开预览，请求挂着 —— 这颗现在是可点的取消。
  await page.getByRole("button", { name: "打开预览" }).click();
  await page.getByRole("button", { name: "启动中·点此取消" }).waitFor({ timeout: 5000 });

  // ② 切到 B：B 从来没起过预览，快照也明说 running:false / starting:false。
  await page.getByTestId("to-b").click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid=current-task]")?.textContent?.includes("T-B") ?? false,
    null,
    { timeout: 5000 },
  );
  const openOnB = page.getByRole("button", { name: "打开预览" });
  await openOnB.waitFor({ timeout: 5000 });
  assert.equal(
    await page.getByRole("button", { name: "启动中·点此取消" }).count(), 0,
    "A 的在途动作漂到了 B 的按钮上",
  );

  // ③ 在 B 上点这颗：必须是「起 B 的预览」，不能是「停 B 的预览」。
  await openOnB.click();
  await page.getByRole("button", { name: "启动中·点此取消" }).waitFor({ timeout: 5000 });
  // B 正在冷启动，日志入口就是它此刻唯一能看见的东西。
  await page.getByTestId("preview-log-open").waitFor({ timeout: 5000 });
  const afterClick = await page.evaluate(() => window.__calls);
  assert.equal(afterClick.postsB, 1, "在 B 上点「打开预览」没有起 B 的预览");
  assert.equal(afterClick.deletesB, 0, "在 B 上点下去反而给 B 发了停止请求");
  assert.equal(afterClick.postsA, 1, "A 的那次启动请求不该被重发");

  if (process.env.PREVIEW_SWITCH_SHOT) await page.screenshot({ path: process.env.PREVIEW_SWITCH_SHOT });

  // ④ A 的请求晚一步成功返回：它属于用户已经离开的那个任务，既不能清掉 B 的动作，
  //    也不能在 B 的页面上说话、开窗。
  await page.getByTestId("finish-a").click();
  await page.waitForTimeout(500);
  const afterLate = await page.evaluate(() => ({
    calls: window.__calls,
    notices: document.querySelector("[data-testid=notices]")?.textContent ?? "",
    label: document.querySelector("button.is-preview")?.textContent ?? "",
    logEntries: document.querySelectorAll("[data-testid=preview-log-open]").length,
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
  await server.close();
}
