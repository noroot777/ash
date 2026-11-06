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
//   ⑫ 同上，但后发的那次保存失败：它失败了，更不该把成功的发送键保存拒掉；
//   ⑬ 保存还在途中离开设置页再回来（卡片级的「保存中」就这么丢掉的），再改一次：
//      那条被延迟的旧 PATCH 不许最后才落到服务端把用户最后选的那一档覆盖掉
//      —— 顺序得在**请求发出前**排好，光挑应答管不到服务端里存的是什么（第 3 轮审查）；
//   ⑭ 发送键保存**失败**时，下拉、「当前」说明、输入框提示和真实的回车行为必须一起退回
//      已确认的那一档；两条真实路径各验一遍 —— 另一项设置同时存成了，以及保存在途中
//      离开设置页再回来（第 4 轮审查）。界面继续声称一个没存成的档位比显示滞后危险。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage, waitUntil, WAIT_TIMEOUT_MS } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  const base = `${web.origin}/scripts/fixtures/send-key.html`;

  browser = await launchChrome();
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
  const settleTo = async (predicate, message, arg) => {
    try {
      await page.waitForFunction(predicate, arg, { timeout: WAIT_TIMEOUT_MS });
    } catch {
      assert.fail(`${message}；实际 ${JSON.stringify(await state())}`);
    }
  };
  // 乱序要靠事实排，不靠睡：「那条请求已经扣在桩上」「那条应答已经被应用读完」都是夹具
  // 报出来的事实（__state 的 held / consumed），读完之后的处理在微任务里，再冲刷一轮就落定。
  const held = (kind, message) => settleTo((want) => window.__state().held[want], message, kind);
  const consumed = async (kind, after, message) => {
    await settleTo(([want, count]) => window.__state().consumed[want] > count, message, [kind, after]);
    await settlePage(page);
  };
  const consumedSoFar = async (kind) => (await state()).consumed[kind];

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
  await settleServerTo(page, "enter", "设置卡上改一下就该 PATCH 回服务端");

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
  // 盖过开场那轮重试：不睡，等它真的全败完 —— 设置页自己读的那一次 + 输入框那轮的 3 次
  // （useComposerSendKey 的 MAX_ATTEMPTS），4 条 503 都被应用读完，「放弃」就已经发生了。
  await consumed("reads", 3, "开场那 4 次读设置都失败并被处理完");
  assert.equal((await state()).mode, null, "读不到就该一直是未知，不许拿出厂默认冒充");
  await typeThen("读设置失败了", "Enter");
  assert.deepEqual(await entries(), [], "读设置失败不等于用户选过回车直发");
  assert.equal(await objective.inputValue(), "读设置失败了\n", "这一下回车该是换行");
  // 读通之后，服务端那一份立刻算数。
  await page.evaluate(() => window.__allowReads());
  await page.evaluate(() => window.__probe());
  await settleTo(() => window.__state().mode === "mod-enter", "读通之后服务端那一份立刻算数");

  // ⑥ 保存之前发出的那条 GET 迟到回来，不许顶掉刚存好的那一档。
  await open("?send-key=enter");
  await page.evaluate(() => window.__probeHeld()); // 这条在保存之前发出，被扣住
  await picker.selectOption("mod-enter");
  await settleTo(() => window.__state().mode === "mod-enter", "保存成功后该当场切到 ⌘/Ctrl 那一档");
  const readsBeforeLate = await consumedSoFar("reads");
  await page.evaluate(() => window.__releaseProbe());
  await consumed("reads", readsBeforeLate, "迟到的那条 GET 回来并被处理完");
  assert.equal((await state()).mode, "mod-enter", "迟到的旧读取不该把刚存好的那一档顶回去");
  await typeThen("旧读取之后", "Enter");
  assert.deepEqual(await entries(), [], "旧读取之后裸回车仍该按已保存的那一档当换行");

  // ⑦ 反向交错：PATCH 先发（服务端还没写），GET 后发、读到旧值、先回来。
  //    那条 GET 的号更大，但它跨过了一次写 —— 不算数。
  await open("?send-key=enter");
  await page.evaluate(() => window.__holdPatch(true)); // 放行才写：模拟「还没到服务端」
  await picker.selectOption("mod-enter");
  await held("patch", "发送键那条 PATCH 扣在桩上");
  const readsBeforeProbe = await consumedSoFar("reads");
  await page.evaluate(() => window.__probe());         // 读到的还是 enter，且先回来
  await consumed("reads", readsBeforeProbe, "那条后发的 GET 先回来并被处理完");
  await page.evaluate(() => window.__releasePatch());
  await settleTo(() => window.__state().mode === "mod-enter", "保存落地后该是 ⌘/Ctrl 那一档");
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
  await held("patch", "另一张卡那条 PATCH 已经写进服务端、应答扣在桩上");
  await picker.selectOption("mod-enter");
  await settleTo(() => window.__state().value === "mod-enter", "发送键自己那次保存该先生效");
  const writesBeforeLate = await consumedSoFar("writes");
  await page.evaluate(() => window.__releasePatch());
  await consumed("writes", writesBeforeLate, "另一张卡那条迟到的应答回来并被处理完");
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
  await held("patch", "发送键那条 PATCH 扣在桩上");
  await held("probe", "那条 GET 读到了旧值、应答扣在桩上");
  await page.evaluate(() => window.__releasePatch());  // 保存落地并结束
  await settleTo(() => window.__state().mode === "mod-enter", "保存成功后该当场切到 ⌘/Ctrl 那一档");
  const readsBeforeCross = await consumedSoFar("reads");
  await page.evaluate(() => window.__releaseProbe());  // 旧读取这才回来
  await consumed("reads", readsBeforeCross, "跨过保存的那条 GET 回来并被处理完");
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
  await held("patch", "发送键那条 PATCH 先发出、扣在桩上");
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
  await held("patch", "发送键那条 PATCH 先发出、扣在桩上");
  await page.evaluate(() => window.__failPatch(1));
  const writesBeforeFail = await consumedSoFar("writes");
  await page.evaluate(() => window.__patchSkill(7200)); // 503
  await consumed("writes", writesBeforeFail, "后发的那次保存先失败、503 已被处理完");
  await page.evaluate(() => window.__releasePatch());
  await settleTo(() => window.__state().value === "mod-enter", "另一项保存失败，不该把成功的发送键保存拒掉");
  assert.equal((await state()).mode, "mod-enter", "实际按键行为也得是存成的那一档");
  await typeThen("另一项保存失败", "Enter");
  assert.deepEqual(await entries(), [], "成功存成 ⌘/Ctrl 之后，裸回车仍该是换行");

  // ⑬ 同一字段的多次保存必须按用户的操作顺序落到服务端。构造报告里那条路：
  //    保存在途 → 离开设置页再回来（卡片重新挂载、「保存中」丢失）→ 再改一次。
  await open("?send-key=mod-enter");
  await settleTo(() => window.__state().mode === "mod-enter", "开场该学到服务端那一份");
  await page.evaluate(() => window.__holdPatch(true)); // 第一条:放行才写,还没到服务端
  await picker.selectOption("enter");
  await held("patch", "第一条 PATCH 扣在桩上");
  await page.evaluate(() => window.__reopenSettings()); // 离开再回来:卡片的 saving 丢了
  // 重新挂载的标志就是下拉不再禁用 —— 报告指出的正是这个:上一个实例的「保存中」没了。
  await picker.locator("xpath=.").waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[data-settings-anchor="send-key"] select')?.disabled,
    undefined, { timeout: WAIT_TIMEOUT_MS },
  ).catch(() => assert.fail("卡片该重新挂载、下拉不再带着上一个实例的「保存中」"));
  assert.equal((await state()).epoch, 1, "卡片确实重新挂载过一次");
  assert.equal(
    await picker.inputValue(), "enter",
    "重新挂载的下拉该显示用户最后选的那一档，不是他已经改掉的旧值",
  );
  await picker.selectOption("mod-enter");              // 第二条:排在第一条后面,还没发出
  // 不睡：第二条已经进了队（选完当场生效），它若不排队，发出与落到桩上都在这之后的微任务里，
  // 冲刷一轮就该看见；还是 0 就是没抢跑。
  await settleTo(() => window.__state().mode === "mod-enter", "第二次选择已经进队、当场生效");
  await settlePage(page);
  assert.equal(
    (await state()).applied, 0,
    "第一条还扣着，同字段的第二条就不该抢先落到服务端",
  );
  await page.evaluate(() => window.__releasePatch());  // 第一条落地,第二条才接着发
  await settleTo(() => window.__state().applied === 2, "两条保存都该落到服务端");
  await settleTo(() => window.__state().value === "mod-enter", "界面该停在用户最后选的那一档");
  assert.equal(
    await serverSendKey(page), "mod-enter",
    "旧保存不该最后才落到服务端、把用户最后选的那一档覆盖掉",
  );
  assert.equal((await state()).mode, "mod-enter", "按键行为跟服务端存成的那一档一致");
  await typeThen("离开再回来改了一次", "Enter");
  assert.deepEqual(await entries(), [], "服务端存的是 ⌘/Ctrl 那一档，裸回车该是换行");
  assert.equal(await objective.inputValue(), "离开再回来改了一次\n", "这一下回车该是换行");

  // ⑭ 保存失败：显示、提示、按键行为必须一起退回已确认的那一档。
  //    路径 A —— 另一项设置同时存成了（它的应答里捎着发送键的旧值）。
  await open("?send-key=enter");
  await settleTo(() => window.__state().mode === "enter", "开场该学到服务端那一份");
  await page.evaluate(() => window.__holdPatch(true, true)); // 扣住，放行时 503
  await picker.selectOption("mod-enter");
  await held("patch", "发送键那条 PATCH 扣在桩上");
  assert.equal((await state()).mode, "mod-enter", "在途期间按用户刚选的那一档走");
  assert.equal(await picker.inputValue(), "mod-enter", "下拉显示的也是它");
  await page.evaluate(() => window.__patchSkill(7200));      // 另一项设置存成了
  await settleTo(() => window.__state().skill === 7200, "另一项设置该存成");
  assert.equal(
    (await state()).value, "enter",
    "交给设置页的快照只能带服务端确认过的值，不许把没存成的那一档灌进去",
  );
  await page.evaluate(() => window.__releasePatch());        // 发送键保存失败
  await settleTo(() => window.__state().mode === "enter", "保存失败该退回已确认的那一档");
  assert.equal(await picker.inputValue(), "enter", "下拉当场跟着退，不许继续显示没存成的那一档");
  await assertHint(hint, "Enter 发送 · Shift Enter 换行");
  assert.equal(await serverSendKey(page), "enter", "服务端本来就一个字没写");
  await typeThen("保存失败之后", "Enter");
  assert.deepEqual(
    await entries(), ['submit("保存失败之后")'],
    "退回的是回车直发那一档，裸回车就该发送 —— 显示和行为得是同一件事",
  );

  //    路径 B —— 保存在途中离开设置页再回来（卡片重新挂载过），随后保存失败。
  await open("?send-key=enter");
  await settleTo(() => window.__state().mode === "enter", "开场该学到服务端那一份");
  await page.evaluate(() => window.__holdPatch(true, true));
  await picker.selectOption("mod-enter");
  await held("patch", "发送键那条 PATCH 扣在桩上");
  await page.evaluate(() => window.__reopenSettings());
  await page.waitForFunction(
    () => !document.querySelector('[data-settings-anchor="send-key"] select')?.disabled,
    undefined, { timeout: WAIT_TIMEOUT_MS },
  ).catch(() => assert.fail("卡片该重新挂载、下拉不再带着上一个实例的「保存中」"));
  assert.equal(await picker.inputValue(), "mod-enter", "重新挂载时显示在途的那一档");
  assert.equal((await state()).value, "enter", "交出去的快照仍只有已确认的值");
  await page.evaluate(() => window.__releasePatch());        // 失败
  await settleTo(() => window.__state().mode === "enter", "失败后该退回已确认的那一档");
  assert.equal(await picker.inputValue(), "enter", "重新挂载过的卡片同样当场退回");
  await assertHint(hint, "Enter 发送 · Shift Enter 换行");
  assert.equal(await serverSendKey(page), "enter", "服务端一个字没写");
  await typeThen("重进设置后保存失败", "Enter");
  assert.deepEqual(
    await entries(), ['submit("重进设置后保存失败")'],
    "退回回车直发那一档后，裸回车就该发送",
  );

  console.log("send-key test passed");
} finally {
  await browser?.close();
  await web.close();
}

function serverSendKey(page) {
  return page.evaluate(async () => (await (await fetch("/api/settings")).json()).composerSendKey);
}

/**
 * 轮询服务端那一份,直到它等于 expected。
 *
 * **不要**把 async 函数交给 `page.waitForFunction`:它不 await 返回的 Promise,而
 * Promise 对象本身是 truthy —— 断言会在 2ms 内「满足」,等于一行没写。这个坑让本文件
 * 原先那条「PATCH 真回到服务端了吗」的断言空转了三轮(实测:同步 `() => false` 会老实
 * 超时,`async () => false` 立刻通过)。要读页面以外的东西就用 `page.evaluate` 自己轮。
 */
async function settleServerTo(page, expected, message) {
  await waitUntil(async () => (await serverSendKey(page)) === expected, `${message}（等服务端那一份变成 ${expected}）`)
    .catch(async () => assert.fail(`${message}；服务端现在是 ${await serverSendKey(page)}`));
}

async function assertHint(hint, expected) {
  await hint.filter({ hasText: expected }).waitFor({ timeout: WAIT_TIMEOUT_MS })
    .catch(async () => {
      assert.equal(await hint.innerText(), expected, "提示文案没跟着这一档变");
    });
}
