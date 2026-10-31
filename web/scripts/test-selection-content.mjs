// 会话里选中一段话,「添加到备忘 / 添加到对话」拿到的是**正文**,不是选区扫过的每一个
// 字符。用户反馈:跨两条回复选一段加进备忘,中间六条「执行过程」也跟着进去了。
//
// 真浏览器 + 真 ConversationFeed 才测得了:气泡头上的身份与时间、折起来的
// 「执行过程 · N 工具」、尾栏的账目胶囊,在 DOM 里和正文混排,`Selection.toString()`
// 照单全收。同时钉住反向那一条 —— 用户点开折叠块、专门去选里面某条工具输出时,
// 拿到的仍是那条输出本身(别为了去噪把人家要的东西也抹了)。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/selection-content.html`);
  await page.getByText("第 3 条改完了。", { exact: true }).waitFor();

  const memo = page.getByRole("button", { name: "添加到备忘", exact: true });
  const addToReply = page.getByRole("button", { name: "添加到对话", exact: true });
  const taken = page.getByTestId("taken");
  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

  /* 选区按「第一个文本节点的第 from 个字」到「某个文本节点的第 to 个字」画,用真实的
     pointerup 收尾 —— 浮条就是靠它出来的。`anchor` 是那段文字所在元素的特征文案。 */
  const select = (start, end) => page.evaluate(([a, b]) => {
    const node = (text) => {
      const walker = document.createTreeWalker(document.querySelector(".conversation-selection-scope"), NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (walker.currentNode.textContent?.includes(text)) return walker.currentNode;
      throw new Error(`没找到文本节点: ${text}`);
    };
    const head = node(a.text);
    const tail = node(b.text);
    const range = document.createRange();
    range.setStart(head, a.at ?? head.textContent.indexOf(a.text));
    range.setEnd(tail, b.at ?? tail.textContent.indexOf(b.text) + b.text.length);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    const box = range.getBoundingClientRect();
    const init = { bubbles: true, clientX: box.right, clientY: box.bottom };
    (tail.parentElement ?? document.body).dispatchEvent(new PointerEvent("pointerup", init));
    return selection?.toString() ?? "";
  }, [start, end]);

  const take = async (button = memo) => {
    await button.waitFor();
    await button.click();
    await flush();
    return taken.textContent();
  };

  // ① 用户报的那一幕:从上一条回复的结论拖到下一条回复的结论。中间横着上一条的账目
  //    尾栏、下一条的头像与身份头、以及那条折起来的「执行过程 · 2 工具」。
  const raw = await select({ text: "第 2 条改完，测试也过了。" }, { text: "第 3 条改完了。" });
  assert.match(raw, /执行过程/, "原生选区确实扫到了执行过程(没扫到的话这条用例什么都没证明)");
  assert.equal(await take(), "第 2 条改完，测试也过了。\n\n接下来做第 3 条。\n\n第 3 条改完了。",
    "段内那两段的换行照旧在(靠排版,不是靠文本节点首尾相接)");
  assert.equal(await page.getByTestId("taken-from").textContent(), "memo");

  // 同一个选区换一颗按钮:三颗共用一份取文,不是备忘那条路上单独补的。
  await select({ text: "第 2 条改完，测试也过了。" }, { text: "第 3 条改完了。" });
  assert.equal(await take(addToReply), "第 2 条改完，测试也过了。\n\n接下来做第 3 条。\n\n第 3 条改完了。");

  // ② 装置压在选区头上:从折叠摘要里起步,到下一段正文收尾。
  await page.getByTestId("clear").click();
  await select({ text: "执行过程 · 2 工具" }, { text: "第 3 条改完了。" });
  assert.equal(await take(), "第 3 条改完了。");

  // ③ 装置压在选区尾上:从正文起步,停在下一条的折叠摘要里。
  await page.getByTestId("clear").click();
  await select({ text: "第 2 条改完，测试也过了。" }, { text: "执行过程 · 2 工具" });
  assert.equal(await take(), "第 2 条改完，测试也过了。\n\n接下来做第 3 条。");

  // ④ 选区横跨两块装置、中间一个字正文都没有(上一条的账目尾栏 → 下一条的头像身份头):
  //    没有正文可取,浮条就不出现——总比给一条「🪙 本轮 10.5k C Claude 2」的备忘强。
  await page.getByTestId("clear").click();
  await select({ text: "本轮" }, { text: "Claude 2" });
  await flush();
  assert.equal(await memo.isVisible().catch(() => false), false, "整段都是装置时浮条不出现");
  assert.equal(await taken.textContent(), "", "也没有任何东西被取走");

  // ⑤ 反过来:选区**整个**落在一块装置里 = 用户就是冲它去的,原样给他。
  //    折叠摘要那几个字是这样,点开之后里面那条命令也是这样。
  await page.getByTestId("clear").click();
  const summaryRaw = await select({ text: "执行过程 · 6 工具" }, { text: "执行过程 · 6 工具" });
  assert.equal(await take(), summaryRaw.trim());
  await page.getByTestId("clear").click();
  await page.locator(".task-execution-block").first().evaluate((element) => { element.open = true; });
  await flush();
  const insideRaw = await select({ text: "case-1-2" }, { text: "case-1-3" });
  assert.match(insideRaw, /case-1-2/);
  assert.equal(await take(), insideRaw.trim(), "折叠块内部的选区一个字不改");

  // ⑥ 没有装置相交的普通选区,结果必须跟原生 toString 一字不差——去噪不许顺手改排版。
  await page.getByTestId("clear").click();
  const plainRaw = await select({ text: "第 2 条改完就接着做第 3 条。" }, { text: "第 2 条改完就接着做第 3 条。" });
  assert.equal(await take(), plainRaw);

  // ⑦ 跨用户气泡到 agent 结论。此刻第一条的折叠块**是展开的**(上面点开没收回去):
  //    展开之后过程里的工具行和那句过程正文都在 DOM 里,照样一个字都不许混进来。
  await page.getByTestId("clear").click();
  await select({ text: "第 2 条改完就接着做第 3 条。" }, { text: "第 2 条改完，测试也过了。" });
  const across = await take();
  assert.equal(across, "第 2 条改完就接着做第 3 条。\n\n第 2 条改完，测试也过了。");
  for (const noise of ["执行过程", "case-1-", "先把启动自检", "本轮", "Claude 1", "用时", "你"]) {
    assert.equal(across.includes(noise), false, `取到的正文里混进了「${noise}」`);
  }

  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("✓ 会话选文只取正文:跨消息选区剔掉执行过程/头像身份头/账目尾栏(展开状态也剔)、装置压头压尾、整段都是装置时不给浮条、整个落在装置内时原样保留、无装置时与原生 toString 一致");
} finally {
  await browser?.close();
  await server.close();
}
