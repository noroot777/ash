// 任务模式空态里不许把离线提示吞掉：接力出去的行因为持有机联系不上退回冻住的状态、
// 又正好是唯一候选时，用户看到的必须是「联系不上 mac-mini」+「没有在跑…」两句话，
// 而不是只剩后一句 —— 那正是最需要解释「接力那条怎么没了」的时刻。
// 回归的那个 bug：空态有两份拷贝，其中一份是提前 return，把离线提示整个绕过去了。
// 跑：npm -w web run test:task-tree-offline
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-tree-offline-empty.html`);

  const offline = page.locator(".workspace-task-offline-peers");
  const empty = page.locator(".workspace-task-empty");
  await empty.waitFor();

  assert.equal(await page.locator(".workspace-task-row").count(), 0, "冻住的出站存档不该还算「还没落地」");
  assert.equal(await offline.count(), 1, "空态不许把离线提示吞掉：那是「接力那条怎么没了」的唯一解释");
  assert.match(await offline.innerText(), /联系不上 mac-mini/);
  assert.equal(await empty.count(), 1, "空态只该有一份 —— 两份拷贝就是这个 bug 的来源");
  assert.match(await empty.innerText(), /没有在跑、等你答复或待验收的任务/);

  // 顺序也是判据的一部分：先说清楚「有台机器问不到」，再说「剩下的没有」。
  const order = await page.evaluate(() => {
    const notice = document.querySelector(".workspace-task-offline-peers");
    const blank = document.querySelector(".workspace-task-empty");
    return notice.compareDocumentPosition(blank) & Node.DOCUMENT_POSITION_FOLLOWING ? "notice-first" : "empty-first";
  });
  assert.equal(order, "notice-first", "离线提示要排在空态之前");

  console.log("✓ 任务模式空态：离线提示与空态同时出现");
} finally {
  await browser?.close();
  await server.close();
}
