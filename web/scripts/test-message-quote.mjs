// 用户消息里的 Markdown 引用画成引文（components/MessageText.tsx）：淡一档、左边一道竖线、截成
// 两行，跟答过的提问卡里那段问题引文同一种长相；真被截了才有展开键。「添加到对话」写进对话框的就是 `> ` 前缀的
// 引文，不认的话气泡里是一排裸的 `>`。设 SHOT=<路径> 可以顺带截一张图自查版式。
import assert from "node:assert/strict";
import { splitMessageQuotes } from "../src/lib/messageQuotes.ts";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage } from "./wait-until.mjs";

// —— 切分：连续的 `>` 行合成一段，分隔用的空行不算内容，围栏里的 `>` 是代码。
assert.deepEqual(splitMessageQuotes("> 第一行\n> 第二行\n\n回复"), [
  { kind: "quote", text: "第一行\n第二行" },
  { kind: "text", text: "回复" },
]);
assert.deepEqual(splitMessageQuotes("前情\n>紧贴的引文\n>\n> 空行之后\n后话"), [
  { kind: "text", text: "前情" },
  { kind: "quote", text: "紧贴的引文\n\n空行之后" },
  { kind: "text", text: "后话" },
]);
assert.deepEqual(splitMessageQuotes("没有引用\n  缩进原样留着"), [{ kind: "text", text: "没有引用\n  缩进原样留着" }]);
assert.deepEqual(splitMessageQuotes("```\n> npm run build\n```\n> 围栏外才是引文"), [
  { kind: "text", text: "```\n> npm run build\n```" },
  { kind: "quote", text: "围栏外才是引文" },
]);
assert.deepEqual(splitMessageQuotes("    > 四格缩进是代码"), [{ kind: "text", text: "    > 四格缩进是代码" }]);
// 关围栏后面只许有空白：围栏里一行 ```not-a-fence 还是代码，不能把围栏提前关掉。
for (const mark of ["```", "~~~"]) {
  assert.deepEqual(splitMessageQuotes(`${mark}\n${mark}not-a-fence\n> 还是代码\n${mark}  \n> 这才是引文`), [
    { kind: "text", text: `${mark}\n${mark}not-a-fence\n> 还是代码\n${mark}  ` },
    { kind: "quote", text: "这才是引文" },
  ], `${mark} 围栏`);
}
// 没有引用就一字不动；有引用时只去掉贴着引文那一侧的空行，另一侧用户自己打的留着。
assert.deepEqual(splitMessageQuotes("\n  前后留白\n\n"), [{ kind: "text", text: "\n  前后留白\n\n" }]);
assert.deepEqual(splitMessageQuotes("\n开头空行留着\n\n> 引文\n\n末尾空行留着\n"), [
  { kind: "text", text: "\n开头空行留着" },
  { kind: "quote", text: "引文" },
  { kind: "text", text: "末尾空行留着\n" },
]);

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/message-quote.html`);
  const long = page.locator(".task-user-bubble").nth(0);
  const short = page.locator(".task-user-bubble").nth(1);
  const fenced = page.locator(".task-user-bubble").nth(2);
  await long.waitFor();

  // 引文是 blockquote、回复是 p，裸的 `>` 一个都不剩。
  const quote = long.locator("blockquote.message-quote");
  assert.equal(await quote.count(), 1);
  assert.doesNotMatch(await long.innerText(), /^>/m, "气泡里不再出现裸的引用记号");
  assert.equal(await long.locator("p").innerText(), "改成回合结束时读 codex 自己写的运行记录来算");
  assert.equal(await short.locator("blockquote").innerText(), "要不要我在它的说明里补一句？\n它正在跑，补了也不会打断它。");

  // 截成两行：长引文高度两行、被截，尾巴上有展开键；短引文刚好两行，不截也就没有键。
  const text = quote.locator(".message-quote__text");
  const toggle = quote.getByRole("button", { name: "展开引文" });
  const lines = () => text.evaluate((element) => Math.round(element.clientHeight / parseFloat(getComputedStyle(element).lineHeight)));
  assert.equal(await lines(), 2, "长引文截成两行");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await short.locator("blockquote button").count(), 0, "没被截的引文没有展开键");
  const style = await quote.evaluate((element) => {
    const css = getComputedStyle(element);
    return { border: css.borderLeftWidth, size: parseFloat(css.fontSize) };
  });
  const replySize = await long.locator("p").evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  assert.equal(style.border, "2px", "左边一道竖线");
  assert.ok(style.size < replySize, "引文比回复小一档");

  // 引文贴着它下面那句话。
  const gap = await long.evaluate((element) => {
    const q = element.querySelector("blockquote").getBoundingClientRect();
    const p = element.querySelector("p").getBoundingClientRect();
    return p.top - q.bottom;
  });
  assert.ok(gap >= 0 && gap <= 6, `引文与回复间距 ${gap}`);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // 引文正文不接点击：点一下不改排版。
  await text.click();
  await settlePage(page);
  assert.equal(await lines(), 2, "点引文正文不展开");

  // 只用键盘：Tab 走得到展开键，Enter 展开、空格收回，状态读得出来。
  await page.evaluate(() => { window.getSelection()?.removeAllRanges(); document.activeElement instanceof HTMLElement && document.activeElement.blur(); });
  let reached = false;
  for (let step = 0; step < 10 && !reached; step += 1) {
    await page.keyboard.press("Tab");
    reached = await toggle.evaluate((element) => element === document.activeElement);
  }
  assert.ok(reached, "Tab 走得到展开键");
  await page.keyboard.press("Enter");
  await settlePage(page);
  const collapse = quote.getByRole("button", { name: "收起引文" });
  assert.equal(await collapse.getAttribute("aria-expanded"), "true");
  assert.ok(await lines() > 2, "键盘展开后显示全文");
  await page.keyboard.press(" ");
  await settlePage(page);
  assert.equal(await lines(), 2, "空格收回两行");

  // 展开着双击原本藏起来的末行：选中的是双击的那几个字，引文不收、下面那句话不挪。
  await toggle.click();
  await settlePage(page);
  const tail = await text.evaluate((element) => {
    const node = element.firstChild;
    const at = node.textContent.indexOf("起止");
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const box = range.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(tail.x, tail.y, { clickCount: 2, delay: 40 });
  await settlePage(page);
  const picked = await page.evaluate(() => {
    const selection = window.getSelection();
    return { text: selection?.toString() ?? "", inQuote: !!selection?.anchorNode?.parentElement?.closest(".message-quote") };
  });
  assert.ok(picked.inQuote && picked.text && "每一次工具调用的起止都有。".includes(picked.text), `双击选中的是引文末行的字：${JSON.stringify(picked)}`);
  assert.ok(await lines() > 2, "双击不把展开的引文收回");

  // 围栏里的 `>` 是代码，原样留在正文里。
  assert.equal(await fenced.locator("blockquote").count(), 0);
  assert.match(await fenced.locator("p").innerText(), /> npm run build/);

  assert.deepEqual(errors, []);
  console.log("message quote: 引用切分与留白、两行截断、展开键（鼠标/键盘）、展开后双击选词不错位、围栏不误认 ✔");
} finally {
  await browser?.close();
  await web.close();
}
