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
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/selection-content.html`);
  await page.getByText("第 3 条改完了。", { exact: true }).waitFor();

  const memo = page.getByRole("button", { name: "添加到备忘", exact: true });
  const addToReply = page.getByRole("button", { name: "添加到对话", exact: true });
  const taken = page.getByTestId("taken");
  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  /* 等布局彻底平静下来。会话区会跟着内容高度自动贴底（useStickToBottom），那一下滚动是
     异步来的，而滚动本来就该把浮条收走 —— 不等它停就选，刚排上的那一帧会被当场掐掉。 */
  const settle = () => page.waitForTimeout(250);

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

  /* 把一个元素的内容整块选中（同样用真实 pointerup 收尾）。 */
  const selectAll = (locator) => locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    const box = range.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: box.right, clientY: box.bottom }));
  });

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
  assert.equal(await take(), summaryRaw, "整个落在装置内时一个字节都不改");
  await page.getByTestId("clear").click();
  await page.locator(".task-execution-block").first().evaluate((element) => { element.open = true; });
  await flush();
  const insideRaw = await select({ text: "case-1-2" }, { text: "case-1-3" });
  assert.match(insideRaw, /case-1-2/);
  assert.equal(await take(), insideRaw, "折叠块内部的选区一个字不改");

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

  // ⑧ 切口两边只许削换行:代码块首行那四个空格是正文自己的缩进,削掉它原本同级的两行
  //    会变成不同层级(审查第 1 轮必修 1)。
  await page.getByTestId("clear").click();
  await select({ text: "用户尾行" }, { text: 'print("第二行")' });
  assert.equal(await take(), '用户尾行\n\n    print("缩进不能丢")\n    print("第二行")');

  // ⑨ 排版语义归原页面:用户气泡那三行靠祖先限定的 `white-space: pre-wrap` 撑着,取文
  //    不许把它折成一行(审查第 1 轮必修 2)。
  await page.getByTestId("clear").click();
  await select({ text: "第 3 条改完了。" }, { text: "用户尾行" });
  assert.equal(await take(), "第 3 条改完了。\n\n用户首行\n    缩进内容\n用户尾行");

  // ⑩ 根因这一条:判据先读 HTML 语义,不靠「每个卡片的作者记得加标记」。这张卡一个
  //    选文标记都没有,头尾却照样剔得干净 —— 审查第 1 轮不拦项里那四处(审查泳道、
  //    辩论卡、问答历史、系统旁注)的头尾都是同一套语义标签写的,一个字都不用改。
  await page.getByTestId("clear").click();
  await selectAll(page.getByTestId("unmarked-card"));
  const unmarked = await take();
  assert.equal(unmarked, "审查卡自己的正文该留下。");
  for (const noise of ["第 1 轮独立验证", "Codex 在审", "收起", "查看报告", "10/30", "🛡", "已通过"]) {
    assert.equal(unmarked.includes(noise), false, `没标记的卡片漏出了「${noise}」`);
  }

  // ⑪ 折起来的问答卡:整张卡此刻**可见的只有 `<summary>` 那一行**,答复预览就长在里头。
  //    光按标签判的话 summary 整块算装置,于是用户选了一整张卡却什么都没取到(审查第 2 轮
  //    必修 2)。同类还有哨兵自动输入卡和系统旁注,都是「折着的时候摘要行就是全部内容」。
  await page.getByTestId("clear").click();
  const question = page.locator(".task-question-record");
  await question.scrollIntoViewIfNeeded();
  await settle();
  await selectAll(question);
  const folded = await take();
  assert.equal(folded, "按第二个方案做，先把开关关掉。");
  for (const noise of ["你的答复", "查看问答", "隐藏的问题正文", "你的答案", "10/30"]) {
    assert.equal(folded.includes(noise), false, `折着的问答卡漏出了「${noise}」`);
  }

  // 点开之后藏着的那半截成了正文,照样取得到 —— 「看不见就不算」判的是此刻,不是标签。
  await page.getByTestId("clear").click();
  await question.evaluate((card) => { card.open = true; });
  await question.scrollIntoViewIfNeeded();
  await settle();
  await selectAll(question);
  const opened = await take();
  assert.match(opened, /隐藏的问题正文/, "展开之后那段问答就该取得到");
  assert.match(opened, /按第二个方案做，先把开关关掉。/);

  // ⑫ 选区从上一条的代码块跨进折起来的问答卡,终点停在答复预览**中间**。藏着的那半截
  //    `Range.toString()` 照样读得到;而拿含隐藏内容的 range 重建 Selection 之后,
  //    `Selection.toString()` 还会越过 range 边界把后面的字一起带出来(必修 3)。
  await page.getByTestId("clear").click();
  await question.evaluate((card) => { card.open = false; });
  await question.scrollIntoViewIfNeeded();
  await settle();
  await select({ text: 'print("第二行")' }, { text: "按第二个方案做，" });
  const crossed = await take();
  assert.equal(crossed, 'print("第二行")\n\n按第二个方案做，');

  //    再把整张折叠卡整个跨过去,落到它后面那张卡的正文里 —— 审查复现的就是这个形状。
  //    中间那一截整个落在关着的子树里(`Range.toString()` 照样读得到那段问答),一个字都
  //    不许漏出来,也不许把选区终点之后的尾栏带进来。
  await page.getByTestId("clear").click();
  await question.scrollIntoViewIfNeeded();
  await settle();
  await select({ text: 'print("第二行")' }, { text: "审查卡自己的正文该留下。" });
  const over = await take();
  assert.equal(over, 'print("第二行")\n\n按第二个方案做，先把开关关掉。\n\n审查卡自己的正文该留下。');

  // ⑬ 浮条上那颗按钮按下去必须兑现得了。Tab 聚到浮条上之后正文被流式续写换掉(结论从
  //    段落变列表,原来那个 `<p>` 当场卸载、选区里的文本节点脱离文档),此时 selectionchange
  //    被「焦点在浮条上」那条早退吞掉、浮条还在 —— 存 Range 的实现这时取文得到空串,于是
  //    用户按了一下什么都没发生(审查第 2 轮必修 1)。
  await page.getByTestId("clear").click();
  await select({ text: "第 2 条改完，测试也过了。" }, { text: "接下来做第 3 条。" });
  await memo.waitFor();
  await page.keyboard.press("Tab");
  await page.evaluate(() => window.__restream());
  await flush();
  assert.equal(await memo.isVisible(), true, "焦点还在浮条上时它不该自己消失");
  assert.equal(await take(), "第 2 条改完，测试也过了。\n\n接下来做第 3 条。",
    "按下去要兑现当时选的那段话,不许静默丢弃");

  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("✓ 会话选文只取正文:折起来的卡片保住摘要行那段正文、隐藏子树一个字不漏、浮条按下去必定兑现、跨消息选区剔掉执行过程/头像身份头/账目尾栏(展开状态也剔)、装置压头压尾、整段都是装置时不给浮条、整个落在装置内时原样保留、无装置时与原生 toString 一致、代码缩进与多行用户消息的排版原样保住、没有任何标记的卡片靠 HTML 语义照样剔干净头尾");
} finally {
  await browser?.close();
  await server.close();
}
