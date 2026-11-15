// 时间线上那条「执行者驳回了，等你裁定」旁注。
//
// 裁定挪到了回复框顶上那一行（用户 2026-11-15），这条旁注上不再挂「去裁定」把人送去别处——
// 但那一句本身留着，它说的是此刻的状态（e431l1YYjoBu）。这份回归盯：
// ① 那一句一直在（它是历史记录，不随裁定消失），任何形态下都没有「去裁定」；
// ② 还在等你时字前一颗琥珀点；裁定完、任务已验收时它就是过去的事，不带点；
// ③ 驳回之后同一回合又落了别的话，驳回那一句不被盖掉（R8M9Tsn2q0aj）；
// ④ 任务已验收时，从没裁过的驳回照普通规则可以被后来的话盖过；
// ⑤ 原文点那半句就地摊开。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.goto(`${web.origin}/scripts/fixtures/dispute-timeline-cta.html`);

  const open = page.locator(".open-fixture");
  const resolved = page.locator(".resolved-fixture");
  const readonly = page.locator(".readonly-fixture");
  await open.locator(".turn-footnote").first().waitFor();

  // ① 三份渲染的是同一条旁注，差别只在审查链状态和有没有入口；哪一份都没有「去裁定」。
  for (const [name, scope] of [["open", open], ["resolved", resolved], ["readonly", readonly]]) {
    assert.match(await scope.innerText(), /第 2 轮审查意见被驳回，等你裁定/, `${name}: 那一句必须一直在——它是历史记录，不随裁定消失`);
  }
  assert.equal(await page.getByRole("button", { name: "去裁定" }).count(), 0, "裁定在回复框顶上那一行，时间线上不再挂「去裁定」");
  assert.equal(await page.locator(".system-event-cta").count(), 0, "旁注上没有别的实心键");

  // ② 还在等你：字前一颗琥珀点；裁定完就是过去的事。
  assert.equal(await open.locator(".turn-footnote-dot.is-warn").count(), 1, "等你裁定的那一句字前一颗琥珀点");
  assert.equal(await resolved.locator(".turn-footnote-dot").count(), 0, "裁定完了，那一句就是过去的事，不再带点");

  // ③ 驳回之后同一回合又落了别的话：驳回那一句还在、仍带点。
  const heldNote = page.locator(".held-fixture .turn-footnote");
  assert.match(await heldNote.innerText(), /第 2 轮审查意见被驳回，等你裁定[\s\S]*本回合没有交卷/, "两句都在尾注里，驳回那一句不被盖掉");
  assert.equal(await heldNote.locator(".turn-footnote-part").filter({ hasText: "等你裁定" }).locator(".turn-footnote-dot.is-warn").count(), 1,
    "等你裁定的那一句仍带琥珀点");

  // ④ 任务已验收：从没裁过的驳回不再是等你裁定的事——不带点，可以被后来的话盖过。
  assert.doesNotMatch(await page.locator(".accepted-fixture .turn-footnote").innerText(), /等你裁定/, "照普通规则被后来的结算说明盖过，退回记录");
  const acceptedAlone = page.locator(".accepted-alone-fixture");
  assert.match(await acceptedAlone.locator(".turn-footnote").innerText(), /等你裁定/, "后面没有别的话时那一句还在");
  assert.equal(await acceptedAlone.locator(".turn-footnote-dot").count(), 0, "已验收：那一句不带点");

  // ⑤ 原文点那半句就地摊开。
  const ruling = open.locator(".turn-footnote button.turn-footnote-part").filter({ hasText: "等你裁定" });
  assert.equal(await ruling.count(), 1);
  await ruling.click();
  assert.match(await open.locator(".turn-footnote-detail").innerText(), /现在由你裁定/, "驳回的原文点开再看");
  assert.deepEqual(await page.evaluate(() => window.__opened), [], "点那半句不把人送去审查格");

  console.log("dispute timeline cta tests passed");
} finally {
  await browser?.close();
  await web.close();
}
