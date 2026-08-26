// 对话框顶边的拖动条:往上拖变高、往下拖变矮、双击复位、上下限收住、刷新后还在。
// 跑法:npm -w web run test:reply-resize
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeExecutablePath } from "./chrome-path.mjs";
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
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/reply-resize.html`;

  browser = await chromium.launch({ executablePath: await chromeExecutablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(url);

  const handle = page.locator(".task-reply-resize");
  const field = page.getByTestId("field");
  await handle.waitFor();

  const fieldHeight = () => field.evaluate((el) => el.getBoundingClientRect().height);

  // 拖之前是 rows 撑出来的自然高度,不该被写死的默认值顶掉。
  assert.equal(await page.getByTestId("state").textContent(), "auto");
  const natural = await fieldHeight();

  // 往上拖 80px:回复框跟着高 80px。
  const drag = async (dy) => {
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - dy, { steps: 6 });
    await page.mouse.up();
  };

  await drag(80);
  const taller = await fieldHeight();
  assert.ok(
    Math.abs(taller - (natural + 80)) < 2,
    `往上拖 80 应长高 80：${natural} → ${taller}`,
  );

  // 往下拖回去。
  await drag(-50);
  const shorter = await fieldHeight();
  assert.ok(Math.abs(shorter - (taller - 50)) < 2, `往下拖 50 应变矮 50：${taller} → ${shorter}`);

  // 下限收住:一直往下拖不会拖没,也不会变负。
  await drag(-4000);
  const floored = await fieldHeight();
  assert.ok(floored >= 58 && floored < 80, `下限应收在 58 附近，实际 ${floored}`);

  // 上限收住:给上面的会话留地方,不许拖满整屏。
  await drag(4000);
  const ceiling = await fieldHeight();
  assert.ok(ceiling <= 900 - 260 + 2, `上限应给会话留出空间，实际 ${ceiling}`);

  // 刷新后高度还在。
  const kept = await page.getByTestId("state").textContent();
  await page.reload();
  await handle.waitFor();
  assert.equal(await page.getByTestId("state").textContent(), kept, "刷新后应记住拖过的高度");

  // 双击复位,并且复位状态也要落盘 —— 否则刷新又跳回拖过的高度。
  await handle.dblclick();
  assert.equal(await page.getByTestId("state").textContent(), "auto");
  await page.reload();
  await handle.waitFor();
  assert.equal(await page.getByTestId("state").textContent(), "auto", "复位后刷新不该退回旧高度");
  assert.ok(Math.abs((await fieldHeight()) - natural) < 2, "复位后应回到自然高度");

  console.log("reply resize test passed");
} finally {
  await browser?.close();
  await server.close();
}
