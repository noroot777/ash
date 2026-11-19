// 「继续本轮审查」「重试这一回合」挂着的那一句，后面又落了几句别的话以后，在会话里还在、键还挂在它后面
// （夹具 fixtures/footnote-actions.tsx，四种情形见 footnote-actions-cases.ts）：
//   lane-event   还没收口的审查卡里那条原因旁注（卡里的尾注重新并成一句时同样不许挤掉，第 1 轮审查第 1 条）；
//   lane-cause   收了口的那一轮，结论气泡下面的原因句；
//   turn-live    直播的异常边界；
//   turn-reload  刷新以后从会话行补出来的那一句。
// 跑：npm -w web run test:footnote-actions
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const CASES = [
  ["lane-event", "继续本轮审查", /^第 1 轮审查中断：模型上游连不上（503）$/],
  ["lane-cause", "继续本轮审查", /^中断 · 模型上游连不上（503）$/],
  ["turn-live", "重试这一回合", /^这一轮异常结束$/],
  ["turn-reload", "重试这一回合", /^这一轮异常结束$/],
];

const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 1600 } });
  await page.goto(`${web.origin}/scripts/fixtures/footnote-actions.html`);
  await page.locator(".lane-event-fixture").waitFor();
  for (const [id, action, sentence] of CASES) {
    const scope = page.locator(`.${id}-fixture`);
    await scope.locator(".turn-footnote").first().waitFor();
    const cta = scope.getByRole("button", { name: action });
    assert.equal(await cta.count(), 1, `${id}：后面又落了几句别的话，「${action}」还在（尾注：${await scope.locator(".turn-footnote").allInnerTexts()}）`);
    const host = await cta.evaluate((element) => element.previousElementSibling?.querySelector(".turn-footnote-text")?.textContent ?? null);
    assert.match(host ?? "", sentence, `${id}：键挂在说这件事的那一句后面（实际挂在「${host}」后面）`);
    await cta.click();
  }
  assert.deepEqual(await page.evaluate(() => window.__ran), CASES.map(([id]) => id), "每一颗键都走它自己的那个动作");
  console.log("footnote actions dom tests passed");
} finally {
  await browser?.close();
  await web.close();
}
