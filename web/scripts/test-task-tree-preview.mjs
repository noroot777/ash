// 任务树「展开(N/N) / 收起」：展开后点几条旧任务，收起必须真的收得回去。
// 回归的那个 bug：选中项落在 24h 预览之外时，用 selectedTaskIsHidden 持续顶住展开，
// 点收起只是改了用户自己的展开集合，列表还是全开。
// 跑：npm -w web run test:task-tree-preview
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
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

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/task-tree-preview.html`);

  const recent = page.getByRole("button", { name: "今天刚改过" });
  const handoffOutRow = page.getByRole("button", { name: "已经转出的接力任务" });
  const handoffPendingRow = page.getByRole("button", { name: "送达未确认的接力任务" });
  const handoffInRow = page.getByRole("button", { name: "刚刚转入的接力任务" });
  const handoffOutMark = page.locator('[aria-label="接力转出"]');
  const handoffInMark = page.locator('[aria-label="接力转入"]');
  const oldJia = page.getByRole("button", { name: "很久以前的任务甲" });
  const oldYi = page.getByRole("button", { name: "很久以前的任务乙" });
  const oldBing = page.getByRole("button", { name: "很久以前的任务丙" });
  const oldStarred = page.getByRole("button", { name: "很久以前但加了星" });
  const oldUnaccepted = page.getByRole("button", { name: "很久以前但没验收" });
  const expand = page.getByRole("button", { name: "展开(3/3)" });
  const collapse = page.getByRole("button", { name: "收起", exact: true });

  await recent.waitFor();
  // 接力的三种行各有各的去处（d2070cf0 起）：已确认转出的只出现在「其他机器」那一节，
  // 主任务树里根本没有；送达未确认的还在本机，留在树里带小飞机；转入的已经是本机任务，
  // 按普通行展示、不再挂标记。三条一起断言，少哪条都会让下面的 opacity 检查跑空。
  assert.equal(await handoffOutRow.count(), 0, "已确认转出的任务不留在主任务树里");
  assert.equal(await handoffPendingRow.count(), 1, "送达未确认的转出任务仍在主任务树里");
  assert.equal(await handoffOutMark.count(), 1, "送达未确认的转出任务应带小飞机标记");
  assert.equal(await handoffInRow.count(), 1, "转入的任务按普通任务展示");
  assert.equal(await handoffInMark.count(), 0, "转入的任务不再挂接力标记");
  assert.equal(await handoffOutMark.locator("..").evaluate((node) => getComputedStyle(node).opacity), "0");
  // 行尾那批(meta 图标、星标)在 hover 和**选中**两种状态下都要浮出来,标题必须同步让开
  // 它们。曾经只有 hover 让位、选中不让:鼠标一移开,标题就叠印在小飞机和星星上。
  // 判据用同一行在三种状态下的标题遮罩:选中态必须和 hover 态一模一样,且都不同于静置。
  const titleMask = () => handoffPendingRow.evaluate((node) =>
    getComputedStyle(node.closest(".workspace-task-row-wrap").querySelector(".workspace-task-title")).maskImage);
  const idleMask = await titleMask();
  await handoffPendingRow.hover();
  await page.waitForTimeout(180);
  assert.equal(await handoffOutMark.locator("..").evaluate((node) => getComputedStyle(node).opacity), "1", "指向转出任务时标记应显示");
  const hoverMask = await titleMask();
  assert.notEqual(hoverMask, idleMask, "指到时标题要额外让开星标那格");
  await handoffPendingRow.click();
  await page.mouse.move(4, 4);
  await page.waitForTimeout(180);
  const selectedTail = await handoffPendingRow.evaluate((node) => {
    const wrap = node.closest(".workspace-task-row-wrap");
    return {
      meta: getComputedStyle(wrap.querySelector(".workspace-task-meta")).opacity,
      star: getComputedStyle(wrap.querySelector(".workspace-task-star")).opacity,
    };
  });
  assert.equal(selectedTail.meta, "1", "选中的行也要露出 meta 图标");
  assert.equal(selectedTail.star, "1", "选中的行也要露出星标");
  assert.equal(await titleMask(), hoverMask, "选中态的标题让位必须和 hover 一致,否则鼠标一移开文字就压在图标上");
  assert.equal(await oldJia.count(), 0, "默认只显示 24 小时内的任务");
  assert.equal(await oldStarred.count(), 1, "星标的任务再旧也不进折叠");
  assert.equal(await oldUnaccepted.count(), 1, "还没验收的任务再旧也不进折叠");
  await expand.click();
  await oldJia.waitFor();
  assert.equal(await oldYi.count(), 1);
  assert.equal(await oldBing.count(), 1);

  await oldJia.click();
  await oldYi.click();
  await collapse.click();

  await expand.waitFor();
  assert.equal(await oldJia.count(), 0, "点过旧任务后再点收起，旧任务必须藏回去");
  assert.equal(await oldYi.count(), 0);
  assert.equal(await oldBing.count(), 0);
  assert.equal(await recent.count(), 1);
  assert.equal(await oldStarred.count(), 1, "收起之后星标的仍然在");
  assert.equal(await oldUnaccepted.count(), 1, "收起之后未验收的仍然在");

  console.log("✓ 任务树预览：展开后点旧任务，收起仍能收回去");
} finally {
  await browser?.close();
  await server.close();
}
