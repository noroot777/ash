// 会话里选中一段话,「添加到备忘 / 添加到对话」拿到的是**正文**,不是选区扫过的每一个
// 字符。用户反馈:跨两条回复选一段加进备忘,中间六条「执行过程」也跟着进去了。
//
// 真浏览器 + 真 ConversationFeed 才测得了:气泡头上的身份与时间、折起来的
// 「执行过程 · N 工具」、尾栏的账目胶囊,在 DOM 里和正文混排,`Selection.toString()`
// 照单全收。同时钉住反向那一条 —— 用户点开折叠块、专门去选里面某条工具输出时,
// 拿到的仍是那条输出本身(别为了去噪把人家要的东西也抹了)。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/selection-content.html`);
  await page.getByText("第 3 条改完了。", { exact: true }).waitFor();

  const memo = page.getByRole("button", { name: "添加到备忘", exact: true });
  const addToReply = page.getByRole("button", { name: "添加到对话", exact: true });
  const taken = page.getByTestId("taken");
  const flush = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  /* 等布局彻底平静下来。会话区会跟着内容高度自动贴底（useStickToBottom），那一下滚动是
     异步来的，而滚动本来就该把浮条收走 —— 不等它停就选，刚排上的那一帧会被当场掐掉。
     「停了」按帧数，不按毫秒：贴底在 rAF / ResizeObserver 里排、scroll 事件在下一帧派发，
     所以连着 QUIET_FRAMES 帧既没有 scroll 事件、各滚动容器的 scrollTop 也没再变，这一串
     连锁反应就已经走完了 —— 负载再重也只是每帧更慢，次序不变。 */
  const QUIET_FRAMES = 3;
  const settle = () => page.evaluate(async (quietFrames) => {
    const deadline = performance.now() + 15_000;
    const offsets = () => [document.scrollingElement, ...document.querySelectorAll("*")]
      .filter((element) => element && element.scrollHeight > element.clientHeight)
      .map((element) => element.scrollTop).join(",");
    let scrolled = false;
    const onScroll = () => { scrolled = true; };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    try {
      let last = offsets();
      for (let quiet = 0; quiet < quietFrames;) {
        if (performance.now() > deadline) throw new Error(`滚动 15 秒内没停下来（scrollTop：${last}）`);
        await new Promise((done) => requestAnimationFrame(() => done()));
        const now = offsets();
        quiet = scrolled || now !== last ? 0 : quiet + 1;
        scrolled = false;
        last = now;
      }
    } finally {
      document.removeEventListener("scroll", onScroll, { capture: true });
    }
  }, QUIET_FRAMES);
  /* 在页面里等 n 个动画帧。用来给「每帧重算一轮」的那种空转留出观察窗：数的是帧，不是毫秒。 */
  const frames = (n) => page.evaluate(async (count) => {
    for (let i = 0; i < count; i += 1) await new Promise((done) => requestAnimationFrame(() => done()));
  }, n);

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
    range.setStart(head, a.atEnd ? head.textContent.indexOf(a.text) + a.text.length : a.at ?? head.textContent.indexOf(a.text));
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
  //    尾栏、下一条的头像与身份头、以及那条折起来的「跑了 2 条命令」。
  const raw = await select({ text: "第 2 条改完，测试也过了。" }, { text: "第 3 条改完了。" });
  assert.match(raw, /跑了 2 条命令/, "原生选区确实扫到了执行过程(没扫到的话这条用例什么都没证明)");
  assert.equal(await take(), "第 2 条改完，测试也过了。\n\n接下来做第 3 条。\n\n第 3 条改完了。",
    "段内那两段的换行照旧在(靠排版,不是靠文本节点首尾相接)");
  assert.equal(await page.getByTestId("taken-from").textContent(), "memo");

  // 同一个选区换一颗按钮:三颗共用一份取文,不是备忘那条路上单独补的。
  await select({ text: "第 2 条改完，测试也过了。" }, { text: "第 3 条改完了。" });
  assert.equal(await take(addToReply), "第 2 条改完，测试也过了。\n\n接下来做第 3 条。\n\n第 3 条改完了。");

  // ② 装置压在选区头上:从折叠摘要里起步,到下一段正文收尾。
  await page.getByTestId("clear").click();
  await select({ text: "跑了 2 条命令" }, { text: "第 3 条改完了。" });
  assert.equal(await take(), "第 3 条改完了。");

  // ③ 装置压在选区尾上:从正文起步,停在下一条的折叠摘要里。
  await page.getByTestId("clear").click();
  await select({ text: "第 2 条改完，测试也过了。" }, { text: "跑了 2 条命令" });
  assert.equal(await take(), "第 2 条改完，测试也过了。\n\n接下来做第 3 条。");

  // ④ 选区横跨两块装置、中间一个字正文都没有(上一条正文的句末 → 上一条的回合尾操作 →
  //    下一条的头像身份头):没有正文可取,浮条就不出现——总比给一条「C Claude 2」的备忘强。
  await page.getByTestId("clear").click();
  await select({ text: "接下来做第 3 条。", atEnd: true }, { text: "Claude 2" });
  await flush();
  assert.equal(await memo.isVisible().catch(() => false), false, "整段都是装置时浮条不出现");
  assert.equal(await taken.textContent(), "", "也没有任何东西被取走");

  // ⑤ 反过来:选区**整个**落在一块装置里 = 用户就是冲它去的,原样给他。
  //    折叠摘要那几个字是这样,点开之后里面那条命令也是这样。
  await page.getByTestId("clear").click();
  const summaryRaw = await select({ text: "跑了 6 条命令" }, { text: "跑了 6 条命令" });
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
  for (const noise of ["条命令", "case-1-", "先把启动自检", "本轮", "Claude 1", "用时", "你"]) {
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

  // ⑪ 答过的提问:你的一个气泡,问题引在答案上面。引文是一颗键(点开看完整问题),按语义算装置;
  //    选一整个气泡取到的是你的答案,不夹「你」、时刻和引文。
  await page.getByTestId("clear").click();
  const question = page.locator(".task-question-record");
  await question.scrollIntoViewIfNeeded();
  await settle();
  await selectAll(question);
  const folded = await take();
  assert.equal(folded, "按第二个方案做，先把开关关掉。");
  for (const noise of ["你", "隐藏的问题正文", "10/30"]) {
    assert.equal(folded.replace("按第二个方案做，先把开关关掉。", "").includes(noise), false, `问答气泡漏出了「${noise}」`);
  }

  // 点开引文之后,完整的问题成了正文,照样取得到 —— 「看不见就不算」判的是此刻,不是标签。
  await page.getByTestId("clear").click();
  await question.locator(".task-question-quote").click();
  await question.locator(".task-question-quote-full").waitFor();
  await question.scrollIntoViewIfNeeded();
  await settle();
  await selectAll(question);
  const opened = await take();
  assert.match(opened, /隐藏的问题正文/, "展开之后那段问题就该取得到");
  assert.match(opened, /按第二个方案做，先把开关关掉。/);

  // ⑫ 选区从上一条的代码块跨进收着引文的问答气泡,终点停在答案**中间**。收起的那段完整问题
  //    已经不在页面上;引文那颗键是装置,一个字都不许漏进来(必修 3)。
  await page.getByTestId("clear").click();
  await question.locator(".task-question-quote").click();
  await question.locator(".task-question-quote-full").waitFor({ state: "detached" });
  await question.scrollIntoViewIfNeeded();
  await settle();
  await select({ text: 'print("第二行")' }, { text: "按第二个方案做，" });
  const crossed = await take();
  assert.equal(crossed, 'print("第二行")\n\n按第二个方案做，');

  //    再把整个问答气泡跨过去,落到它后面那张卡的正文里 —— 审查复现的就是这个形状。
  //    中间只该带上答案:引文、身份头一个字都不许漏出来,也不许把选区终点之后的尾栏带进来。
  await page.getByTestId("clear").click();
  await question.scrollIntoViewIfNeeded();
  await settle();
  await select({ text: 'print("第二行")' }, { text: "审查卡自己的正文该留下。" });
  const over = await take();
  assert.equal(over, 'print("第二行")\n\n按第二个方案做，先把开关关掉。\n\n审查卡自己的正文该留下。');

  // ⑬ 反过来:从答案**中间**起步、跨到气泡外面。答案前面那一截装置(身份头、引文)整个落在
  //    选区起点之前,照原样拿它去挪起点就会把起点拽回答案的开头 —— 用户没选的前半句跟着被
  //    存进备忘(审查第 2 轮必修)。两头各一道闸,每一截都得是原选区的子区间。
  await page.getByTestId("clear").click();
  await question.scrollIntoViewIfNeeded();
  await settle();
  await select({ text: "先把开关关掉。" }, { text: "审查卡自己的正文该留下。" });
  assert.equal(await take(), "先把开关关掉。\n\n审查卡自己的正文该留下。");

  // ⑭ 只选中代码块行首那几个空格:剔不出正文,浮条就该撤掉 —— 否则要等存的时候才说
  //    「内容不能为空」。先在同一处选一段真正文做对照,免得浮条其实是因为滚出视口才没出来。
  await page.getByTestId("clear").click();
  await page.getByText('print("缩进不能丢")').first().scrollIntoViewIfNeeded();
  await settle();
  await select({ text: 'print("缩进不能丢")' }, { text: 'print("缩进不能丢")' });
  await memo.waitFor();
  await select({ text: 'print("缩进不能丢")', at: 0 }, { text: 'print("缩进不能丢")', at: 4 });
  await flush();
  assert.equal(await memo.isVisible().catch(() => false), false, "只选到空白时浮条该撤掉");

  // ⑮ 剔不出正文时也得**停下来**。取文要借用全局选区读排版、读完还原,还原本身又是一次
  //    selectionchange —— 空结果那条路上要是把「这一段算过了」跟浮条一起忘掉,下一帧就
  //    重算同一个选区,一帧一轮转下去(审查实测 1.1 秒 66 次)。浮条没出来不等于已经停了,
  //    所以这条数的是事件,不是看界面。
  await page.getByTestId("clear").click();
  await page.evaluate(() => {
    window.__selectionEvents = 0;
    document.addEventListener("selectionchange", () => { window.__selectionEvents += 1; });
  });
  await page.getByText("Claude 2", { exact: true }).scrollIntoViewIfNeeded();
  await settle();
  await select({ text: "Claude 2" }, { text: "跑了 2 条命令" });
  // 空转是「一帧一轮」（审查实测 1.1 秒 66 次），所以观察窗按帧数给：先让这一次选区自己
  // 引起的那几下收完（约 18 帧 ≈ 原先的 300ms），再数接下来 30 帧（≈ 原先的 500ms）里还来了
  // 几次。负载重时每帧更慢，但每帧一轮的空转照样每帧至少一次，数出来的不会因此变少。
  await frames(18);
  const spun = await page.evaluate(() => window.__selectionEvents);
  await frames(30);
  const stillSpinning = await page.evaluate(() => window.__selectionEvents) - spun;
  assert.equal(await memo.isVisible().catch(() => false), false, "只选到身份行和过程标题时不出浮条");
  assert.ok(stillSpinning <= 2, `选区没再动过,却还在转:30 帧内又来了 ${stillSpinning} 次 selectionchange`);

  // ⑯ 浮条上那颗按钮按下去必须兑现得了。Tab 聚到浮条上之后正文被流式续写换掉(结论从
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
  console.log("✓ 会话选文只取正文:剔不出正文时内部还原能收口(不逐帧重算)、每一截都是原选区的子区间(从正文岛中间起步不补前半句)、只选到空白时撤掉浮条、折起来的卡片保住摘要行那段正文、隐藏子树一个字不漏、浮条按下去必定兑现、跨消息选区剔掉执行过程/头像身份头/账目尾栏(展开状态也剔)、装置压头压尾、整段都是装置时不给浮条、整个落在装置内时原样保留、无装置时与原生 toString 一致、代码缩进与多行用户消息的排版原样保住、没有任何标记的卡片靠 HTML 语义照样剔干净头尾");
} finally {
  await browser?.close();
  await web.close();
}
