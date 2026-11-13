// 预设工作流「打开预览」那一站：起来了不往会话里写地址，入口就长在这一站上，刷新后照样在。
// 跑：npm -w web run test:preview-preset-links
//
// 钉三条：
//   ① 没开着时不给链接（不能对着一个不在的服务给出入口）；
//   ② 点「重启预览」起来之后，这一站出现能点的预览页链接，地址就是当前那一份；
//   ③ 刷新页面（盘上那份预览还开着）不用再点，链接照样在。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();
const link = (page) => page.getByRole("link", { name: "在新窗口打开预览" });

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  const fixture = `${web.origin}/scripts/fixtures/preview-preset-links.html`;

  // ①
  await page.goto(fixture);
  await page.getByRole("button", { name: "重启预览" }).waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(await link(page).count(), 0, "预览没开着，这一站却给了入口");
  assert.doesNotMatch(await page.locator(".wf-vnote").innerText(), /时间线/, "说明里还写着地址进时间线");

  // ②
  await page.getByRole("button", { name: "重启预览" }).click();
  await link(page).waitFor();
  assert.equal(await link(page).getAttribute("href"), "http://localhost:51048/", "入口指的不是当前那一份预览");

  // ③
  await page.goto(`${fixture}?running=1`);
  await link(page).waitFor({ timeout: 5000 });
  assert.equal(await link(page).getAttribute("href"), "http://localhost:51048/", "刷新以后这一站找不到预览地址");

  console.log("preview preset links: ok");
} finally {
  await browser?.close();
  await web.close();
}
