// 「输入框按哪一下算发送」这一档（设置 → 默认规则 → 输入框）。
// 跑：npm -w web run test:send-key
//
// 两档的键盘语义：
//   ① 服务端说 ⌘/Ctrl+回车，页面就得按那个来：裸回车真的换行，带修饰键才提交；
//   ② 设置卡上改一下就 PATCH 回服务端，并**当场**改掉输入框行为和提示文案；
//   ③ 回车直发那一档：裸回车就提交，拿到的是框里的内容；
//   ④ Shift+回车在哪一档都是换行。
//
// 应答乱序与失败路径——这一档按错就是「半句话被发出去」，所以每条都真按一次回车：
//   ⑤ 还没学到时裸回车一律当换行，⌘/Ctrl+回车照常发送，**提示也念这一档**；
//   ⑥ 保存之前发出的那条 GET 迟到回来，不许把刚存好的那一档顶掉；
//   ⑦ 反过来也不行：PATCH 先发、GET 后发但读到的是写之前的旧值，那条 GET 同样不算数
//      —— 请求的发出顺序不是数据的版本顺序（第 2 轮审查问题 1）；
//   ⑧ 读设置一直失败**不许**退回出厂默认：读不到就一直换行（第 2 轮审查问题 2）；
//   ⑨ 同一页上另一张卡的旧应答回来，不许把发送键的显示值倒灌回去（第 2 轮审查问题 3）；
//   ⑩ 一条读取**整段跨过**一次保存（保存开始→它读到旧值→保存结束→它才回来），两个
//      端点都「没有写在途」，仍然不算数（第 3 轮审查问题 1）；
//   ⑪ 发送键保存在先、另一项设置的保存后发**先完成**，两次保存都要生效 —— 不同字段
//      之间不存在「谁更晚谁赢」（第 3 轮审查问题 2）；
//   ⑫ 同上，但后发的那次保存失败：它失败了，更不该把成功的发送键保存拒掉。
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
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();

  const log = page.locator('[data-testid="log"]');
  const hint = page.locator('[data-testid="hint"]');
  const objective = page.getByLabel("任务目标");
  const picker = page.getByLabel("输入框发送键");
  const entries = async () => (await log.innerText()).split(",").filter(Boolean);
  const state = () => page.evaluate(() => window.__state());
  const open = async (query = "") => {
    await page.goto(`${base}${query}`);
    await objective.waitFor();
  };
  const typeThen = async (text, key) => {
    await objective.fill("");
    await objective.focus();
    await page.keyboard.type(text);
    await page.keyboard.press(key);
  };
  // 等某个可观察状态落定。超时时报出「等的是什么 + 实际是什么」—— 这几条用例靠等待
  // 本身当断言，只剩一行 TimeoutError 的话，下一个人没法知道是哪一档没跟上。
  const settleTo = async (predicate, message) => {
    try {
      await page.waitForFunction(predicate, undefined, { timeout: 5000 });
    } catch {
      assert.fail(`${message}；实际 ${JSON.stringify(await state())}`);
    }
  };

  // ① 服务端那份说 ⌘/Ctrl+回车：裸回车只换行。
  await open("?send-key=mod-enter");
  await assertHint(hint, "⌘ / Ctrl + Enter 发送 · Enter 换行");
  assert.equal(await picker.inputValue(), "mod-enter", "下拉该显示服务端那一份");
  await typeThen("甲", "Enter");
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
  await typeThen("改一下登录页", "Enter");
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

  // ⑤ 还没学到这一档时：裸回车是换行，⌘/Ctrl+回车照常发送，提示也得念这一档。
  await open("?send-key=enter&fail=999");
  assert.equal((await state()).mode, null, "读不到设置时这一档该是「未知」");
  await assertHint(hint, "⌘ / Ctrl + Enter 发送 · Enter 换行");
  await typeThen("还没写完", "Enter");
  assert.deepEqual(await entries(), [], "还没学到这一档时，裸回车不该把半句话发出去");
  assert.equal(await objective.inputValue(), "还没写完\n", "这一下回车该是换行");
  await page.keyboard.press("ControlOrMeta+Enter");
  assert.deepEqual(
    await entries(), ['submit("还没写完\\n")'],
    "⌘/Ctrl+回车在两档下都是发送，不必等设置到货",
  );

  // ⑧ 读设置一直失败也**不许**退回出厂默认（这里服务端存的是 mod-enter）。
  await open("?send-key=mod-enter&fail=999");
  await page.waitForTimeout(2000); // 盖过开场那轮重试（3 次、每次间隔 0.5s）
  assert.equal((await state()).mode, null, "读不到就该一直是未知，不许拿出厂默认冒充");
  await typeThen("读设置失败了", "Enter");
  assert.deepEqual(await entries(), [], "读设置失败不等于用户选过回车直发");
  assert.equal(await objective.inputValue(), "读设置失败了\n", "这一下回车该是换行");
  // 读通之后，服务端那一份立刻算数。
  await page.evaluate(() => window.__allowReads());
  await page.evaluate(() => window.__probe());
  await page.waitForFunction(() => window.__state().mode === "mod-enter", undefined, { timeout: 5000 });

  // ⑥ 保存之前发出的那条 GET 迟到回来，不许顶掉刚存好的那一档。
  await open("?send-key=enter");
  await page.evaluate(() => window.__probeHeld()); // 这条在保存之前发出，被扣住
  await picker.selectOption("mod-enter");
  await page.waitForFunction(() => window.__state().mode === "mod-enter", undefined, { timeout: 5000 });
  await page.evaluate(() => window.__releaseProbe());
  await page.waitForTimeout(300);
  assert.equal((await state()).mode, "mod-enter", "迟到的旧读取不该把刚存好的那一档顶回去");
  await typeThen("旧读取之后", "Enter");
  assert.deepEqual(await entries(), [], "旧读取之后裸回车仍该按已保存的那一档当换行");

  // ⑦ 反向交错：PATCH 先发（服务端还没写），GET 后发、读到旧值、先回来。
  //    那条 GET 的号更大，但它跨过了一次写 —— 不算数。
  await open("?send-key=enter");
  await page.evaluate(() => window.__holdPatch(true)); // 放行才写：模拟「还没到服务端」
  await picker.selectOption("mod-enter");
  await page.evaluate(() => window.__probe());         // 读到的还是 enter，且先回来
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__releasePatch());
  await page.waitForFunction(() => window.__state().mode === "mod-enter", undefined, { timeout: 5000 });
  assert.equal(
    await page.evaluate(async () => (await (await fetch("/api/settings")).json()).composerSendKey),
    "mod-enter", "服务端这时确实存的是 mod-enter",
  );
  await typeThen("保存成功之后", "Enter");
  assert.deepEqual(await entries(), [], "保存成功之后裸回车该是换行，不该把没写完的任务发出去");
  assert.equal(await objective.inputValue(), "保存成功之后\n", "这一下回车该是换行");

  // ⑨ 同一页另一张卡的旧应答回来，不许把发送键的显示值倒灌回去。
  await open("?send-key=enter");
  await page.evaluate(() => window.__holdPatch(false)); // 服务端已经写了，只是应答在路上
  await page.evaluate(() => window.__patchSkill(7200));
  await page.waitForTimeout(200);
  await picker.selectOption("mod-enter");
  await page.waitForFunction(() => window.__state().value === "mod-enter", undefined, { timeout: 5000 });
  await page.evaluate(() => window.__releasePatch());
  await page.waitForTimeout(400);
  const after = await state();
  assert.equal(after.value, "mod-enter", "另一张卡的旧应答不该把发送键的显示值退回去");
  assert.equal(after.mode, "mod-enter", "实际按键行为同样不该退");
  assert.equal(await picker.inputValue(), "mod-enter", "下拉显示的也得是用户刚选的那一档");
  await assertHint(hint, "⌘ / Ctrl + Enter 发送 · Enter 换行");

  // ⑩ 读取整段跨过一次保存：保存开始 → 它读到旧值 → 保存结束 → 它迟到的应答才回来。
  //    两个端点都看不到「写在途」，可它中间完整跨过了一次保存。
  await open("?send-key=enter");
  await page.evaluate(() => window.__holdPatch(true)); // 放行才写：保存还没到服务端
  await picker.selectOption("mod-enter");
  await page.evaluate(() => window.__probeHeld());     // 这条真读到 enter，应答也扣住
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__releasePatch());  // 保存落地并结束
  await settleTo(() => window.__state().mode === "mod-enter", "保存成功后该当场切到 ⌘/Ctrl 那一档");
  await page.evaluate(() => window.__releaseProbe());  // 旧读取这才回来
  await page.waitForTimeout(300);
  assert.equal((await state()).mode, "mod-enter", "整段跨过一次保存的读取不算数");
  assert.equal(await picker.inputValue(), "mod-enter", "下拉同样不该退档");
  await assertHint(hint, "⌘ / Ctrl + Enter 发送 · Enter 换行");
  await typeThen("读取跨了一次保存", "Enter");
  assert.deepEqual(await entries(), [], "保存已成功，裸回车不该把没写完的任务发出去");
  assert.equal(await objective.inputValue(), "读取跨了一次保存\n", "这一下回车该是换行");

  // ⑪ 两个互不冲突的部分写入：发送键先发、技能间隔后发先完成，两次都该生效。
  await open("?send-key=enter");
  await page.evaluate(() => window.__holdPatch(true)); // 发送键这条扣住，还没到服务端
  await picker.selectOption("mod-enter");
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__patchSkill(3600)); // 后发、先完成，应答里发送键还是 enter
  await settleTo(() => window.__state().skill === 3600, "另一项设置自己那次保存该先生效");
  await page.evaluate(() => window.__releasePatch());
  await settleTo(() => window.__state().value === "mod-enter", "较晚的另一项保存不该撤销较早的发送键保存");
  const merged = await state();
  assert.equal(merged.mode, "mod-enter", "较晚的另一项保存不该撤销较早的发送键保存");
  assert.equal(merged.skill, 3600, "另一项设置也得留住 —— 两次保存都是用户的意思");
  assert.equal(await picker.inputValue(), "mod-enter", "下拉显示的是实际存成的那一档");
  await typeThen("两项同时保存", "Enter");
  assert.deepEqual(await entries(), [], "裸回车该按已存成的 ⌘/Ctrl 那一档当换行");

  // ⑫ 后发的那次保存失败：它自己没存上，更不该连累成功的那次。
  await open("?send-key=enter");
  await page.evaluate(() => window.__holdPatch(true));
  await picker.selectOption("mod-enter");
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__failPatch(1));
  await page.evaluate(() => window.__patchSkill(7200)); // 503
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__releasePatch());
  await settleTo(() => window.__state().value === "mod-enter", "另一项保存失败，不该把成功的发送键保存拒掉");
  assert.equal((await state()).mode, "mod-enter", "实际按键行为也得是存成的那一档");
  await typeThen("另一项保存失败", "Enter");
  assert.deepEqual(await entries(), [], "成功存成 ⌘/Ctrl 之后，裸回车仍该是换行");

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
