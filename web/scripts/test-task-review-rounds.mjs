import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  await page.goto(`${web.origin}/scripts/fixtures/task-review-rounds.html`);

  // 一轮一行（InspRecord）：第几轮、在哪验，右边是结论；点开就在这一行底下铺报告。
  const rounds = page.locator(".insp-rec > .insp-go");
  await rounds.first().waitFor();

  // 单任务列的是轮次（团队那边列的是审查对象），一轮一条、不合并。
  assert.deepEqual(
    (await rounds.locator(".insp-cut").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
    ["第 1 轮 独立审查 · 完成", "第 2 轮 就地验证", "第 3 轮 就地验证"],
  );
  assert.deepEqual(await rounds.locator(".insp-meta").allInnerTexts(), ["未通过", "进行中", "已通过"]);

  // 没点开就不铺报告和截图。
  assert.equal(await page.getByText("第 1 轮的验证报告").count(), 0, "没点开就不该把报告铺在侧栏里");
  assert.equal(await page.locator(".review-screenshot-strip").count(), 0, "没点开就不该把证据截图铺在侧栏里");

  // 只有「未通过 / 无结论」标红：进行中那轮还没有结论，先标红等于提前判它死刑。
  const tones = await rounds.locator(".insp-meta > span").evaluateAll((nodes) => nodes.map((node) => node.className || "plain"));
  assert.deepEqual(tones, ["insp-bad", "insp-live", "plain"]);

  // 读全文那一屉：从左边推出来，跟子智能体那个抽屉同一个位置（LeftDrawer → SideDrawer）。
  const drawer = page.locator(".side-drawer");
  assert.equal(await drawer.count(), 0, "进来时不该自动弹出验证内容");

  // 点一轮 → 就地展开，不弹抽屉。
  await rounds.nth(0).click();
  const firstBody = page.locator(".insp-rec__body").first();
  await firstBody.getByText("第 1 轮的验证报告").first().waitFor();
  assert.equal(await drawer.count(), 0, "就地展开不弹抽屉");

  // 独立审查那轮有「打开审查任务」的出口。
  await firstBody.getByRole("button", { name: "打开审查任务" }).click();
  assert.deepEqual(await page.evaluate(() => window.__openedTasks), ["rev-1"]);

  // 嫌窄就点正文第一行的图标：左侧推出来，头上写着是哪一轮、什么结论、在哪验。
  const expand = firstBody.getByRole("button", { name: "在左侧铺开看" });
  await expand.click();
  await drawer.waitFor();
  await drawer.getByText("第 1 轮的验证报告").first().waitFor();
  assert.equal(await drawer.locator(".side-drawer__kind").innerText(), "验证报告");
  assert.equal(await drawer.locator("header > b").innerText(), "第 1 轮验证 · 未通过 · 独立审查 · 完成");
  assert.equal(await expand.getAttribute("aria-pressed"), "true", "开着的是它：那颗图标画「按下」");

  // 只盖住主区那一栏，侧边栏不被盖住、照样点得着（等滑入动画落定再量）。
  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const host = await page.locator(".inspector-host").boundingBox();
  const main = await page.locator(".task-detail").boundingBox();
  const box = await drawer.boundingBox();
  assert.ok(box.x >= main.x - 1 && box.x + box.width <= host.x + 1, `抽屉收在主区里，实测 ${box.x}～${box.x + box.width} vs 侧边栏 ${host.x}`);
  assert.ok(Math.abs(box.height - main.height) <= 1, "抽屉和主区一样高");
  // 再点同一颗图标收起来；侧边栏里点别的一轮照样有反应（抽屉开着时也一样）。
  await expand.click();
  await drawer.waitFor({ state: "detached" });
  await expand.click();
  await drawer.waitFor();

  // 证据截图点开的大图 portal 到 body，DOM 上不在抽屉里：它必须登记进浮层那一摞，
  // 否则点大图会被抽屉读成「点了外面」、Esc 也会连抽屉一起关。
  const lightbox = page.locator(".image-preview-lightbox");
  await drawer.locator(".review-screenshot-strip img").first().click();
  await lightbox.waitFor();
  assert.equal(await drawer.count(), 1, "点开证据大图不该把抽屉一起关了");
  await page.keyboard.press("Escape");
  await lightbox.waitFor({ state: "detached" });
  assert.equal(await drawer.count(), 1, "Esc 关大图时抽屉该留着，一次只退一层");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });

  // 第三轮：就地验证没有审查任务可打开；多张截图横向滚动，不占报告的高度。
  await rounds.nth(2).click();
  const thirdBody = page.locator('[data-record="3-inline"] .insp-rec__body');
  await thirdBody.getByText("第 3 轮的验证报告").first().waitFor();
  assert.equal(await thirdBody.getByRole("button", { name: "打开审查任务" }).count(), 0, "就地验证没有审查任务可打开");
  assert.equal(await thirdBody.locator(".review-screenshot-strip img").count(), 8, "多张证据截图都应保留");
  assert.equal(
    await thirdBody.locator(".review-screenshot-strip__rail").evaluate((node) => node.scrollWidth > node.clientWidth),
    true,
    "图片数量增加时只横向滚动，不能持续占用报告高度",
  );
  await thirdBody.getByRole("button", { name: "在左侧铺开看" }).click();
  await drawer.waitFor();
  assert.match(await drawer.locator("header > b").innerText(), /^第 3 轮验证/, "换成了这一轮：同一时刻只有一屉");
  assert.equal(await drawer.count(), 1);
  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const drawerBox = await drawer.boundingBox();
  const footerBox = await drawer.locator(".side-drawer__footer").boundingBox();
  assert.ok(Math.abs(footerBox.y + footerBox.height - (drawerBox.y + drawerBox.height)) <= 1, "图片区应固定贴住抽屉底边");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });

  // 再点同一条收起来：点开是开关。
  await rounds.nth(2).click();
  await thirdBody.waitFor({ state: "detached" });

  await rounds.nth(1).click();
  const secondBody = page.locator('[data-record="2-inline"] .insp-rec__body');
  await secondBody.getByText("验证报告尚未写入。").first().waitFor();
  await secondBody.getByRole("button", { name: "在左侧铺开看" }).click();
  await drawer.waitFor();
  assert.equal(await drawer.locator(".side-drawer__footer:visible").count(), 0, "没有截图的轮次不应留下空白底栏");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });

  // 窄屏：侧边栏盖在主区上，那一屉得盖在侧边栏上面，而且留在视口内、给报告够读的宽度。
  await page.setViewportSize({ width: 390, height: 740 });
  await rounds.nth(2).click();
  await thirdBody.getByRole("button", { name: "在左侧铺开看" }).click();
  await drawer.waitFor();
  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const mobileBox = await drawer.boundingBox();
  assert.ok(mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390, `窄屏抽屉留在视口内，实测 ${mobileBox.x}～${mobileBox.x + mobileBox.width}`);
  assert.ok(mobileBox.width >= 340, `390px 视口下报告应获得可读宽度，实测 ${mobileBox.width}`);
  const onTop = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".side-drawer"), { x: mobileBox.x + mobileBox.width / 2, y: mobileBox.y + mobileBox.height / 2 });
  assert.ok(onTop, "窄屏时那一屉盖在侧边栏上面，不被它挡住");
  assert.equal(await drawer.locator(".review-screenshot-strip img").count(), 8, "底部截图带照样在");
  await drawer.getByRole("button", { name: "关闭验证报告" }).click();
  await drawer.waitFor({ state: "detached" });

  console.log("task review rounds test passed");
} finally {
  await browser?.close();
  await web.close();
}
