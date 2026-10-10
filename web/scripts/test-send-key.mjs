// 「输入框按哪一下算发送」这一档（设置 → 默认规则 → 输入框）。
// 跑：npm -w web run test:send-key
//
// 钉五条：
//   ① 服务端那份说 ⌘/Ctrl+回车，页面就得按那个来（GET /settings → adopt 这条路通着）：
//      裸回车真的换行，带修饰键才提交；
//   ② 设置卡上改一下就 PATCH 回服务端，并**当场**改掉输入框行为和提示文案（不用刷新）；
//   ③ 回车直发那一档：裸回车就提交，拿到的是框里的内容；
//   ④ Shift+回车在哪一档都是换行，不提交；
//   ⑤ /settings 还没到货时**裸回车一律当换行**（⌘/Ctrl+回车照常发送）—— 两档对裸回车
//      的解读正好相反，猜错一次就是「半句话被发出去」，而发送不可撤销；
//   ⑥ 保存之前发出的那条 GET 迟到回来，不许把刚存好的那一档顶掉；
//   ⑦ 读设置连着失败到放弃、先按出厂默认顶着之后，随后到货的真应答仍然算数 ——
//      那个兜底只是「等不到就先这样」，不是一句能压过服务端的权威答复。
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
  const base = `http://127.0.0.1:${address.port}/scripts/fixtures/send-key.html`;

  browser = await chromium.launch(await chromeLaunchOptions());
  // 同一个 context 跑完整条：本地镜像住在 localStorage 里，⑤ 要的就是「上一页学到的那一档」。
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();

  const log = page.locator('[data-testid="log"]');
  const hint = page.locator('[data-testid="hint"]');
  const objective = page.getByLabel("任务目标");
  const picker = page.getByLabel("输入框发送键");
  const entries = async () => (await log.innerText()).split(",").filter(Boolean);

  // ① 服务端那份说 ⌘/Ctrl+回车：裸回车只换行。
  await page.goto(`${base}?send-key=mod-enter`);
  await objective.waitFor();
  await assertHint(hint, "⌘ / Ctrl + Enter 发送 · Enter 换行");
  assert.equal(await picker.inputValue(), "mod-enter", "下拉该显示服务端那一份");
  await objective.focus();
  await page.keyboard.type("甲");
  await page.keyboard.press("Enter");
  await page.keyboard.type("乙");
  assert.deepEqual(await entries(), [], "⌘ 回车那一档下，裸回车不该提交");
  assert.equal(await objective.inputValue(), "甲\n乙", "那一下回车应该真的换了行");
  await page.keyboard.press("ControlOrMeta+Enter");
  assert.deepEqual(await entries(), ['submit("甲\\n乙")'], "⌘/Ctrl+回车应当提交，且拿到的是框里的内容");

  // ② 设置卡上切回「回车直发」：PATCH 落到服务端，提示文案当场跟着变。
  await picker.selectOption("enter");
  await assertHint(hint, "Enter 发送 · Shift Enter 换行");
  await page.waitForFunction(async () => {
    const response = await fetch("/api/settings");
    return (await response.json()).composerSendKey === "enter";
  }, undefined, { timeout: 5000 });

  // ③ 这一档下裸回车就提交。
  await objective.fill("");
  await objective.focus();
  await page.keyboard.type("改一下登录页");
  await page.keyboard.press("Enter");
  assert.deepEqual(
    await entries(), ['submit("甲\\n乙")', 'submit("改一下登录页")'],
    "回车直发那一档下，裸回车应当提交",
  );

  // ④ Shift+回车照旧是换行。
  await objective.focus();
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("第二行");
  assert.deepEqual(
    await entries(), ['submit("甲\\n乙")', 'submit("改一下登录页")'],
    "Shift+回车不该提交",
  );
  assert.equal(await objective.inputValue(), "改一下登录页\n第二行", "Shift+回车应该真的换了行");

  // ⑤ 还没学到这一档时：裸回车是换行，⌘/Ctrl+回车照常发送。
  await page.goto(`${base}?send-key=enter&hang=1`);
  await objective.waitFor();
  assert.equal(await page.evaluate(() => window.__sendKeyState()), null, "GET 没回来时这一档该是「未知」");
  await objective.focus();
  await page.keyboard.type("还没写完");
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), [], "还没学到这一档时，裸回车不该把半句话发出去");
  assert.equal(await objective.inputValue(), "还没写完\n", "这一下回车该是换行");
  await page.keyboard.press("ControlOrMeta+Enter");
  assert.deepEqual(
    await entries(), ['submit("还没写完\\n")'],
    "⌘/Ctrl+回车在两档下都是发送，不必等设置到货",
  );

  // ⑥ 迟到的旧应答不许顶掉刚保存的那一档：扣住开场那条 GET（它看到的还是 enter），
  //    期间把设置改成 mod-enter，再放行它。
  await page.goto(`${base}?send-key=enter&hold=1`);
  await objective.waitFor();
  await picker.selectOption("mod-enter");
  await assertHint(hint, "⌘ / Ctrl + Enter 发送 · Enter 换行");
  await page.evaluate(() => window.__releaseHeldSettings());
  // 放行之后再等一拍，让那条旧应答真的走完 adopt。
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => window.__sendKeyState()), "mod-enter",
    "保存之前发出的 GET 迟到回来，不该把刚存好的那一档顶回去",
  );
  await assertHint(hint, "⌘ / Ctrl + Enter 发送 · Enter 换行");
  await objective.fill("");
  await objective.focus();
  await page.keyboard.type("旧应答之后");
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), [], "旧应答之后裸回车仍该按已保存的那一档当换行");
  assert.equal(await objective.inputValue(), "旧应答之后\n", "这一下回车该是换行");

  // ⑦ 开场那轮读取全失败 → 先按出厂默认顶着；但**在那之前就发出**的那条真应答一旦
  //    到货，仍然说了算（兜底只是「等不到就先这样」，不该占掉应答取号的位置）。
  await page.goto(`${base}?send-key=mod-enter&fail=9`);
  await objective.waitFor();
  // 这条在兜底之前发出，被扣住，放行才回来。
  void page.evaluate(() => window.__probeSettings());
  await page.waitForFunction(() => window.__sendKeyState() === "enter", undefined, { timeout: 15000 });
  await page.evaluate(() => window.__releaseHeldSettings());
  await page.waitForFunction(() => window.__sendKeyState() === "mod-enter", undefined, { timeout: 15000 });
  await objective.focus();
  await page.keyboard.type("兜底之后");
  await page.keyboard.press("Enter");
  assert.deepEqual(await entries(), [], "真应答到货后该按服务端那一档，裸回车是换行");
  assert.equal(await objective.inputValue(), "兜底之后\n", "这一下回车该是换行");

  console.log("send-key test passed");
} finally {
  await browser?.close();
  await server.close();
}

async function assertHint(hint, expected) {
  await hint.filter({ hasText: expected }).waitFor({ timeout: 5000 })
    .catch(async () => {
      assert.equal(await hint.innerText(), expected, "提示文案没跟着这一档变");
    });
}
