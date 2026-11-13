// 用户消息里的 Markdown 引用画成引文（components/MessageText.tsx）：淡一档、左边一道竖线、截成
// 两行，跟答过的提问卡里那段问题引文同一种长相。「添加到对话」写进对话框的就是 `> ` 前缀的
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

  // 截成两行：长引文高度两行、被截；短引文刚好两行，不截也就不能点。
  const lines = (locator) => locator.evaluate((element) => Math.round(element.clientHeight / parseFloat(getComputedStyle(element).lineHeight)));
  assert.equal(await lines(quote), 2, "长引文截成两行");
  assert.match(await quote.getAttribute("class"), /\bis-toggle\b/, "被截掉的引文能点开");
  assert.doesNotMatch(await short.locator("blockquote").getAttribute("class"), /\bis-toggle\b/, "没被截的引文不装成能点");
  const style = await quote.evaluate((element) => {
    const css = getComputedStyle(element);
    return { border: css.borderLeftWidth, color: css.color, size: parseFloat(css.fontSize) };
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

  // 点开看全，再点收回。
  await quote.click();
  await settlePage(page);
  assert.ok(await lines(quote) > 2, "点开后显示全文");
  await quote.click();
  await settlePage(page);
  assert.equal(await lines(quote), 2, "再点收回两行");

  // 双击选词是选文，不是展开：第二下 click 时已经选中了字，引文不跟着切。
  const box = await quote.boundingBox();
  await page.mouse.click(box.x + 60, box.y + 6, { clickCount: 2, delay: 40 });
  await settlePage(page);
  assert.notEqual(await page.evaluate(() => window.getSelection()?.toString() ?? ""), "", "双击选中了引文里的字");
  // 第一下 click 时还没有选区，会展开 —— 第二下不该再把它收回去。
  assert.ok(await lines(quote) > 2, "双击的第二下不把刚展开的引文收回");

  // 围栏里的 `>` 是代码，原样留在正文里。
  assert.equal(await fenced.locator("blockquote").count(), 0);
  assert.match(await fenced.locator("p").innerText(), /> npm run build/);

  assert.deepEqual(errors, []);
  console.log("message quote: 引用切分、两行截断、点开收回、双击选词不切换、围栏不误认 ✔");
} finally {
  await browser?.close();
  await web.close();
}
