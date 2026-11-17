// 预设工作流「打开预览」那一站：起来了不往会话里写地址，入口就长在这一站上，刷新后照样在。
// 跑：npm -w web run test:preview-preset-links
//
// 钉五条：
//   ① 没开着时不给链接（不能对着一个不在的服务给出入口）；
//   ② 点「重启预览」起来之后，这一站出现能点的预览页链接，地址就是当前那一份；
//   ③ 刷新页面（盘上那份预览还开着）不用再点，链接照样在；
//   ④ 断线期间预览停了、那条事件丢了：重连那一下重读，旧链接不再冒充能打开；
//   ⑤ 读不到当前状态时不给入口，读得到了再给回来（不靠下一条事件碰运气）；
//   ⑥ 每一发都比重试间隔慢：重试不作废还在路上的那一发，慢的照样落地，入口回得来；
//   ⑦ 某一发挂死不回：等到上限就放掉、再读，入口回得来，不会永远卡在那一发上。
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { settlePage, waitUntil } from "./wait-until.mjs";

const web = await startWebServer();
const link = (page) => page.getByRole("link", { name: "在新窗口打开预览" });

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  // ⑦ 要等一发读取挂到上限（useTaskPreview 的 READ_TIMEOUT_MS = 10 秒）、再等一个重拉间隔
  // （PULL_MS = 2.5 秒）：装上假时钟，到那一步拨过去。时间照常在走，前面几步不受影响。
  await page.clock.install();
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

  // ④ 连上事件通道（之后只靠推，不再自己拉）；断线期间预览停了，事件没送到；重连。
  const stage = (call) => page.evaluate(call);
  await stage(() => window.__stage.open());
  await stage(() => window.__stage.drop());
  await stage(() => window.__stage.setRunning(false));
  await stage(() => window.__stage.open());
  await link(page).waitFor({ state: "detached" });

  // ⑤ 连着的时候来一条事件，但那一次没读到：入口先收起来，读得到了自己回来。
  await stage(() => window.__stage.setRunning(true));
  await stage(() => window.__stage.review());
  await link(page).waitFor();
  await stage(() => window.__stage.failReads(true));
  await stage(() => window.__stage.review());
  await link(page).waitFor({ state: "detached" });
  await stage(() => window.__stage.failReads(false));
  await link(page).waitFor({ timeout: 6000 });

  // ⑥ 断着事件通道（只能靠拉），先读不到，然后每一发都要 4 秒才回（比 2.5 秒的重试间隔慢）。
  await stage(() => window.__stage.drop());
  await stage(() => window.__stage.failReads(true));
  await stage(() => window.__stage.review());
  await link(page).waitFor({ state: "detached", timeout: 6000 });
  await stage(() => window.__stage.slowReads(4000));
  await stage(() => window.__stage.failReads(false));
  await link(page).waitFor({ timeout: 15000 });
  // 读的途中又来了事件，不另起一发：最多一发在路上，回来以后补读一次。
  const before = await stage(() => window.__stage.reads());
  await stage(() => { window.__stage.review(); window.__stage.review(); window.__stage.review(); });
  // 夹具在请求**发出那一刻**记数，叠出并行请求的话冲刷一轮就读得到；固定睡一秒反而会把
  // 「在途那一发回来后补读一次」（正确行为）算进来。
  await settlePage(page);
  assert.ok((await stage(() => window.__stage.reads())) - before <= 1, "读的途中来了三条事件，叠出了好几发并行的请求");
  await stage(() => window.__stage.slowReads(0));

  // ⑦ 连着事件通道、入口在；来一条事件，那一发挂死不回。
  await stage(() => window.__stage.open());
  await page.waitForTimeout(500);
  await stage(() => window.__stage.setRunning(false));
  await stage(() => window.__stage.hangNextRead());
  const hung = await stage(() => window.__stage.reads());
  await stage(() => window.__stage.review());
  await waitUntil(async () => (await stage(() => window.__stage.reads())) > hung, "挂死的那一发已经出门");
  await settlePage(page);
  assert.equal(await link(page).count(), 1, "上限之前不放掉那一发，入口还是上一份");
  await page.clock.fastForward(10_001);
  await link(page).waitFor({ state: "detached", timeout: 2000 });
  // 放掉以后不发任何事件：入口得靠接着再读自己回来。
  await stage(() => window.__stage.setRunning(true));
  await page.clock.fastForward(2_501);
  await link(page).waitFor({ timeout: 2000 });

  console.log("preview preset links: ok");
} finally {
  await browser?.close();
  await web.close();
}
