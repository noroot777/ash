// 「一个数字、进来就是要换掉」的小输入框：鼠标点一下就该把旧值整个选中，直接敲新数字。
//
// 两条容易失守的地方，各钉一条：
//   ① type=number 上 `select()` 到底管不管用 —— 这类框不支持 selectionStart/setSelectionRange，
//      只能靠「点完直接敲一个字符，值是不是被整个换掉」来判定；顺带钉住原生 mouseup
//      把光标落回点击处、从而冲掉全选的那条老路已经被拦住。
//   ② 已经聚焦之后必须放行 —— 否则用户永远没法在框里挪光标或拖选，只能整段重敲。
//
// 跑法：npm -w web run test:select-all-on-focus
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
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/select-all-on-focus.html`);

  const number = page.locator('[data-testid="number"]');
  const text = page.locator('[data-testid="text"]');
  await number.waitFor();

  // ① 鼠标点一下就能直接敲新数字，不用先退格清掉旧值。
  await number.click();
  await page.keyboard.type("5");
  assert.equal(await number.inputValue(), "5", "点进数字框后敲一个字符，应该整个换掉旧值");

  // 键盘 Tab 进来同样是全选（onFocus 那一半）。
  await page.locator('[data-testid="elsewhere"]').click();
  await number.focus();
  await page.keyboard.type("7");
  assert.equal(await number.inputValue(), "7", "Tab/编程聚焦进来也该是全选状态");

  // ② 已经聚焦之后放行：再点一次是落光标，不是又一次全选。
  await text.click();
  await page.keyboard.type("X");
  assert.equal(await text.inputValue(), "X", "第一次点进文本框也该全选");
  await text.fill("abcdefgh");
  await text.click(); // 第一次点：聚焦 + 全选
  await text.click(); // 第二次点：已聚焦，交还给浏览器落光标
  await page.keyboard.type("Z");
  const after = await text.inputValue();
  assert.notEqual(after, "Z", "已经聚焦时再点不该继续全选，否则没法挪光标");
  assert.equal(after.length, 9, `第二次点击应该只是插入一个字符，实际得到 ${after}`);

  console.log("select-all-on-focus test passed");
} finally {
  await browser?.close();
  await server.close();
}
