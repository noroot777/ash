// 对话框顶边的拖动条:往上拖变高、往下拖变矮、双击复位、上下限收住、刷新后还在。
// 跑法:npm -w web run test:reply-resize
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
  const url = `http://127.0.0.1:${address.port}/scripts/fixtures/reply-resize.html`;

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(url);

  const handle = page.locator(".task-reply-resize");
  const field = page.getByTestId("field");
  await handle.waitFor();

  const fieldHeight = () => field.evaluate((el) => el.getBoundingClientRect().height);

  // 拖之前是 rows 撑出来的自然高度,不该被写死的默认值顶掉。
  assert.equal(await page.getByTestId("state").textContent(), "auto");
  const natural = await fieldHeight();

  // 没拖过时高度跟着输入的行数走,撑到上限为止(再多就在框内滚)。
  const fill = async (lines) => {
    await field.fill(Array.from({ length: lines }, (_, index) => `第 ${index + 1} 行`).join("\n"));
    await page.waitForTimeout(60);
    return fieldHeight();
  };
  const fiveLines = await fill(5);
  assert.ok(fiveLines > natural, `5 行应比 3 行高：${natural} → ${fiveLines}`);
  const autoCap = await fill(12);
  assert.ok(autoCap > fiveLines, `12 行应继续长高：${fiveLines} → ${autoCap}`);
  const overflowed = await fill(40);
  assert.ok(Math.abs(overflowed - autoCap) < 2, `超过上限不该再长高：${autoCap} → ${overflowed}`);
  assert.ok(
    await field.evaluate((el) => el.scrollHeight > el.clientHeight + 1),
    "撑到上限之后内容应当在框内滚动",
  );
  assert.ok(Math.abs((await fill(1)) - natural) < 2, "内容变少要能缩回自然高度");
  await field.fill("");
  await page.waitForTimeout(60);

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

  // 自动撑高那个上限只管自动撑高:拖能拖到比它高得多,拖过之后输入也不再把它改回去。
  assert.ok(ceiling > autoCap, `手动拖动应能超过自动撑高的上限：自动 ${autoCap} / 拖到 ${ceiling}`);
  await fill(40);
  assert.ok(Math.abs((await fieldHeight()) - ceiling) < 2, "拖过之后输入不该改动高度");
  await field.fill("");
  await page.waitForTimeout(60);
  assert.ok(Math.abs((await fieldHeight()) - ceiling) < 2, "拖过之后清空也不该缩回去");

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
