// 批量接力弹窗的信息层级回归：弹窗打开就得回答「哪些任务会被搬走、各带走什么」，
// 而不是先甩五段说明文字。跑：npm -w web run test:bulk-handoff-dialog
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  chromium.executablePath(),
].filter(Boolean);

async function executablePath() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local Chrome/Chromium candidate.
    }
  }
  throw new Error("找不到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定路径");
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch({ executablePath: await executablePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/bulk-handoff-dialog.html`);

  const picks = page.locator(".handoff-bulk-list");
  await picks.waitFor();

  // 1. 主体是任务清单：每条要接力的任务都点名列出，历史任务和搬不了的不混进来。
  const rows = picks.locator("li");
  await assert.doesNotReject(rows.nth(2).waitFor(), "三条在跑的单飞任务都应列出来");
  assert.equal(await rows.count(), 3);
  const titles = await picks.locator("li b").allInnerTexts();
  assert.deepEqual(titles, [
    "把批量接力弹窗的信息层级重排",
    "抓一遍 outbound-state 的超时分支",
    "补 handoff-return 的重试用例",
  ]);
  assert.match(await picks.locator("summary").innerText(), /接力 3 个正在跑的任务，先在本机停止，到 mac-mini 接着跑/);

  // 打开时只探第一条（拿目标项目清单），其余行如实说「待检查」，不装作已经查过。
  const states = () => picks.locator("li > span").allInnerTexts();
  assert.deepEqual((await states()).slice(1), ["待检查", "待检查"]);

  // 2. 逐个检查后，每行讲清楚这条任务带走什么，失败的就地给原因（而不是另开一个底部块）。
  await page.getByRole("button", { name: "检查 3 个接力任务" }).click();
  const failedRow = picks.locator("li.is-failed");
  await failedRow.waitFor();
  const checked = await states();
  assert.match(checked[0], /会话 2 个（缺 1 份[^）]*）/);
  assert.match(checked[0], /带 Git 分支\/改动 · 附件 3 个 · 待发消息 1 条/);
  assert.match(checked[1], /会话 1 个/);
  assert.equal(await failedRow.count(), 1, "预检失败的任务应就地标红");
  assert.match(await failedRow.innerText(), /连不上对端 mac-mini/);
  assert.match(
    await page.locator(".handoff-bulk-dialog footer .is-primary").innerText(),
    /停止并接力 2 个任务（跳过 1 个）/,
    "主按钮要说清最终会搬几个、跳过几个",
  );

  // 3. 身份/加密核对通过时压成一行元信息，不再占两张卡片抢视觉重量。
  const meta = await page.locator(".handoff-bulk-meta").allInnerTexts();
  assert.equal(await page.locator(".handoff-bulk-peer").count(), 0, "全绿时不该再有独立的身份/加密卡片");
  assert.ok(
    meta.some((line) => /D67F-CD07-48E7-1DDF-59B9 已核对，仓库和会话加密传输/.test(line)),
    "身份+加密压成一行元信息",
  );
  assert.ok(
    meta.some((line) => /项目里另外 3 个任务不参与本次接力/.test(line)),
    "搬不走的任务只报一个数，不铺开讲原因",
  );
  assert.ok(
    meta.some((line) => /1 个任务没通过检查，本次跳过；其余 2 个照常接力/.test(line)),
    "跳过结论也走同一档小字，别再开红色大块",
  );

  // 4. 落选原因一律不铺开：用户要的是搬得走的那些，不是一份「为什么不能搬」的清单。
  assert.equal(await page.locator(".handoff-bulk-skipped").count(), 0);
  assert.doesNotMatch(
    await page.locator(".handoff-bulk-body").innerText(),
    /搬不了|只支持单飞任务|不会移动/,
  );

  const shot = process.env.BULK_HANDOFF_SHOT;
  if (shot) await page.locator(".handoff-bulk-dialog").screenshot({ path: shot });

  // 5. 一个都没在跑时说清楚为什么、去哪儿单独搬，主按钮不能还亮着。
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/bulk-handoff-dialog.html?empty=1`);
  const empty = page.locator(".handoff-bulk-body .handoff-bulk-warning");
  await empty.waitFor();
  assert.match(await empty.innerText(), /没有正在跑的任务可接力[\s\S]*单任务接力/);
  assert.doesNotMatch(await empty.innerText(), /只支持单飞任务/, "空态也不铺开落选原因");
  assert.equal(await page.locator(".handoff-bulk-list").count(), 0);
  assert.equal(await page.locator(".handoff-bulk-dialog footer .is-primary").isDisabled(), true);
  const emptyShot = process.env.BULK_HANDOFF_SHOT_EMPTY;
  if (emptyShot) await page.locator(".handoff-bulk-dialog").screenshot({ path: emptyShot });
} finally {
  await browser?.close();
  await server.close();
}

console.log("bulk handoff dialog layout ok");
