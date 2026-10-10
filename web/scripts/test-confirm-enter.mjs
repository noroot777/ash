// 确认框的回车：弹出来就该能直接按回车确认，不用先把鼠标挪到那颗按钮上。
//
// 容易失守的几处各钉一条：
//   ① 打开时焦点还留在外面那颗触发按钮上的话，回车会重新按一次触发按钮而不是确认；
//   ② 焦点在「取消」上时回车归取消，抢过来就成了「既取消又确认」；
//   ③ 多行输入里那一下回车跟着「输入框发送键」那一档走（设置 → 默认规则 → 输入框）：
//      默认档回车就确认，选了「⌘/Ctrl+回车」那一档才把回车让回换行；
//   ④ 按钮按不动（busy / confirmDisabled）时回车也不该越过去；
//   ⑤ 框里又开了一层时，回车只作用于最上面那层（和 Esc 同一套层序）。
//
// 跑法：npm -w web run test:confirm-enter
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
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/confirm-enter.html`);

  const log = page.locator('[data-testid="log"]');
  const dialog = page.locator(".task-confirm-dialog");
  await page.locator('[data-testid="open-plain"]').waitFor();
  const entries = async () => (await log.innerText()).split(",").filter(Boolean);

  // ① 点开就能直接回车确认：焦点得先从触发按钮收进对话框，否则这一下回车会落回按钮上。
  await page.locator('[data-testid="open-plain"]').click();
  await dialog.waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.closest(".task-confirm-dialog") !== null),
    true,
    "确认框打开后焦点应收进框里，别留在外面那颗触发按钮上",
  );
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), ["confirm:plain"], "对话框开着时回车应当确认");
  assert.equal(await dialog.count(), 0, "确认之后框该关掉");
  // 关掉后焦点还给触发按钮，接着 Tab 的人不会被扔回页面开头。
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
    "open-plain",
    "关掉后焦点应还给打开它的那颗按钮",
  );

  // ② 焦点在取消上时，回车归取消。
  await page.locator('[data-testid="reset"]').click();
  await page.locator('[data-testid="open-plain"]').click();
  await dialog.waitFor();
  await page.getByRole("button", { name: "取消" }).focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), ["close:plain"], "焦点在取消上时回车只该取消，不该同时确认");

  // ③ 多行输入里的回车：默认档（回车直发）就是确认，拿到的是输入框里的内容。
  await page.locator('[data-testid="send-key-enter"]').click();
  await page.locator('[data-testid="reset"]').click();
  await page.locator('[data-testid="open-textarea"]').click();
  const feedback = page.locator('[data-testid="feedback"]');
  await feedback.waitFor();
  await page.keyboard.type("第一行");
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), ['confirm:textarea("第一行")'], "默认档下多行输入里的回车应当确认");

  // Shift+Enter 在哪一档都是换行，不是确认。
  await page.locator('[data-testid="reset"]').click();
  await page.locator('[data-testid="open-textarea"]').click();
  await feedback.waitFor();
  await page.keyboard.type("甲");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("乙");
  assert.deepEqual(await entries(), [], "Shift+Enter 是换行，不该确认");
  assert.equal(await feedback.inputValue(), "甲\n乙", "Shift+Enter 应该真的换了行");
  await page.keyboard.press("Escape");

  // 切到「⌘/Ctrl+回车发送」那一档：回车让回换行，带修饰键才确认。
  await page.locator('[data-testid="send-key-mod"]').click();
  await page.locator('[data-testid="reset"]').click();
  await page.locator('[data-testid="open-textarea"]').click();
  await feedback.waitFor();
  await page.keyboard.type("第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二行");
  assert.deepEqual(await entries(), [], "⌘ 回车那一档下，多行输入里的回车是换行，不该确认");
  assert.equal(await feedback.inputValue(), "第一行\n第二行", "那一下回车应该真的换了行");
  await page.keyboard.press("ControlOrMeta+Enter");
  assert.deepEqual(await entries(), ['confirm:textarea("第一行\\n第二行")'], "Cmd/Ctrl+Enter 应当确认，且拿到的是输入框里的内容");

  // 回到默认档，后面几条按原来的语义跑。
  await page.locator('[data-testid="send-key-enter"]').click();

  // 单行输入里回车照常确认（新建分组那种：填完名字直接回车）。
  await page.locator('[data-testid="reset"]').click();
  await page.locator('[data-testid="open-input"]').click();
  await page.locator('[data-testid="name"]').waitFor();
  await page.keyboard.type("每日流水线");
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), ["confirm:input"], "单行输入里回车应当提交");

  // ④ 按钮按不动时，回车也不该越过去。
  await page.locator('[data-testid="reset"]').click();
  await page.locator('[data-testid="open-disabled"]').click();
  await dialog.waitFor();
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), [], "确认按钮不可按时，回车不该绕过去执行");
  assert.equal(await dialog.count(), 1, "这一下回车既不确认也不该把框关掉");
  await page.keyboard.press("Escape");

  // ⑤ 框里再开一框：回车只作用于最上面那层，和 Esc 一样一次退一层。
  await page.locator('[data-testid="reset"]').click();
  await page.locator('[data-testid="open-plain"]').click();
  await page.locator('[data-testid="open-inner"]').click();
  await page.locator(".task-confirm-dialog", { hasText: "里层的确认" }).waitFor();
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), ["confirm:inner"], "里层开着时回车归里层，不该越过它确认外层");
  assert.equal(await dialog.count(), 1, "里层确认完外层还得留着");
  // 里层退掉后焦点还在「再开一层」那颗按钮上，那一下回车按原生语义归它；把焦点挪开，
  // 外层就重新接管回车。
  await dialog.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), ["confirm:inner", "confirm:plain"], "里层退掉后回车回到外层");

  console.log("confirm-enter test passed");
} finally {
  await browser?.close();
  await server.close();
}
