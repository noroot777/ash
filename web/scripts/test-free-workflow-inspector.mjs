import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeExecutablePath } from "./chrome-path.mjs";
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

  browser = await chromium.launch({ executablePath: await chromeExecutablePath(), headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/free-workflow-inspector.html`);

  const reviewOnly = page.locator(".review-only-fixture");
  const reviewRounds = reviewOnly.locator(".review-inspector__targets button");
  await reviewRounds.first().waitFor();

  const repairFixture = page.locator(".repair-fixture");
  const repairToolbar = page.locator(".toolbar-repair-fixture");
  const repairButton = repairToolbar.getByRole("button", { name: "按意见修复" });
  await repairButton.waitFor();
  assert.match(await repairFixture.locator(".review-inspector__overview small").innerText(), /自动复审已停止/);
  await repairButton.click();
  await page.waitForFunction(() => window.__repairRequests === 1);
  assert.equal(await page.evaluate(() => window.__repairRequests), 1, "一键修复只应发送一次请求");
  assert.equal(await repairToolbar.getByRole("button", { name: "按意见修复" }).count(), 1, "修复只代发消息不翻状态，按钮保留（重复保护在服务端）");
  assert.equal(await repairToolbar.getByRole("button", { name: "打开预览" }).isEnabled(), true, "任务空闲时预览应可用，未通过结论不再锁预览");
  assert.equal(await repairToolbar.getByRole("button", { name: "直接再审" }).count(), 1, "空闲且未通过时主按钮是立即再审");

  // 预约模式属于「任务在跑」的场景：修复/修改开跑后从这里预约完成后的复审。
  const chatToolbar = page.locator(".toolbar-chat-rework-fixture");
  await chatToolbar.getByRole("status").filter({ hasText: "任务修改中" }).waitFor();
  assert.equal(await chatToolbar.getByRole("button", { name: "按意见修复" }).count(), 0, "任务运行中不显示修复入口（修改中由任务状态推导）");
  const reserveButton = chatToolbar.getByRole("button", { name: "预约复审" });
  await reserveButton.waitFor();
  assert.equal(await reserveButton.isEnabled(), true, "任务修改中应允许预约复审");
  await reserveButton.click();
  const reviewDialog = page.locator(".free-review-dialog");
  await reviewDialog.getByRole("heading", { name: "预约审查" }).waitFor();
  await reviewDialog.getByRole("button", { name: /Codex 审查/ }).waitFor();
  const dialogBox = await reviewDialog.boundingBox();
  assert.ok(dialogBox && dialogBox.width <= 642, "派审弹窗应收窄到 640px 左右");
  assert.equal(await reviewDialog.evaluate((node) => node === document.activeElement), true, "弹窗打开后应接管焦点，让 Enter 可直接提交");
  await page.keyboard.press("Enter");
  await chatToolbar.getByRole("button", { name: "已预约复审" }).waitFor();
  assert.equal(await page.evaluate(() => window.__reservationRequests), 1, "弹窗打开后直接按 Enter 应提交一次");

  await chatToolbar.getByRole("button", { name: "已预约复审" }).click();
  await reviewDialog.getByRole("heading", { name: "调整预约审查" }).waitFor();
  const note = reviewDialog.getByLabel("附言（可选）");
  await note.fill("重点检查窄屏布局");
  await note.press("Shift+Enter");
  await note.type("与键盘交互");
  assert.equal(await page.evaluate(() => window.__reservationRequests ?? 0), 1, "Shift+Enter 只能换行，不能提交");
  await note.press("Enter");
  await chatToolbar.getByRole("button", { name: "已预约复审" }).waitFor();
  assert.equal(await page.evaluate(() => window.__reservationRequests), 2, "Enter 更新预约时应只新增一次请求");
  assert.equal(await page.evaluate(() => window.__reservationNote), "重点检查窄屏布局\n与键盘交互", "Enter 提交时必须携带附言");
  assert.deepEqual(await reviewRounds.locator("b").allInnerTexts(), ["第 1 轮", "第 1 轮"], "自由审查 inspector 应和普通任务一样按轮列出记录");
  assert.equal(await page.locator(".review-evidence-drawer").count(), 0, "审查正文默认不弹出");
  await reviewRounds.first().click();

  const drawer = page.locator(".review-evidence-drawer");
  await drawer.waitFor();
  assert.equal(await drawer.getByRole("heading", { name: "审查结论" }).count(), 1, "报告应在左侧抽屉按 Markdown 正文渲染");
  assert.equal(await drawer.locator("pre").count(), 0, "报告不再退化成原始 pre 文本");

  const shots = drawer.locator(".review-screenshot-strip");
  assert.equal(await shots.locator("a").count(), 0, "自由审查截图不应再是新页面链接");
  assert.equal(await shots.locator("img[role=button]").count(), 6, "自由审查截图应接入统一图片预览");
  const railOverflow = await shots.locator(".review-screenshot-strip__rail").evaluate((node) => node.scrollWidth > node.clientWidth);
  assert.equal(railOverflow, true, "多图应限制为底部单行横向滚动，不能纵向铺满抽屉");

  await drawer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const drawerBox = await drawer.boundingBox();
  const footerBox = await drawer.locator(".review-evidence-drawer__footer").boundingBox();
  assert.ok(Math.abs(footerBox.y + footerBox.height - (drawerBox.y + drawerBox.height)) <= 1, "图片区应固定贴住抽屉底边");

  const pageCount = page.context().pages().length;
  await shots.locator("img[role=button]").first().click();
  const lightbox = page.getByRole("dialog", { name: /图片预览/ });
  await lightbox.waitFor();
  assert.equal(page.context().pages().length, pageCount, "点截图必须留在当前页面");
  assert.equal(await page.getByText("1 / 6", { exact: true }).count(), 1);
  assert.match(await lightbox.locator("img").getAttribute("src"), /free-workflow\/review-file\?run=run-abc&round=1&name=shot-one\.png$/);
  await page.keyboard.press("Escape");
  await lightbox.waitFor({ state: "detached" });
  assert.equal(await drawer.count(), 1, "关闭大图时审查抽屉应保留");
  await reviewRounds.first().click();
  await drawer.waitFor({ state: "detached" });

  const workflow = page.locator(".workflow-inspector-fixture");
  const activities = workflow.locator(".free-workflow-generated li");
  assert.deepEqual(await activities.locator("b").allInnerTexts(), [
    "任务执行", "Codex 审查 · 逻辑检查", "任务执行", "Codex 审查 · 逻辑检查",
  ], "任务执行和审查必须按真实时间交替排列，不能合并同名审查");
  assert.match(await activities.nth(0).locator("small").innerText(), /8\/9.*9 分钟/);
  assert.equal(await activities.last().locator("svg.is-spinning").count(), 1, "进行中的审查应显示旋转图标");

  assert.equal(await drawer.count(), 0, "工作流中的审查正文默认也不弹出");
  await activities.nth(1).getByRole("button").click();
  await drawer.waitFor();
  assert.equal(await drawer.locator("header b").innerText(), "第 1 轮审查", "点时间线审查节点应复用左侧抽屉");
  assert.equal(await drawer.getByRole("heading", { name: "审查结论" }).count(), 1);

  await activities.nth(3).getByRole("button").click();
  assert.equal(await drawer.locator(".review-round-body p").first().innerText(), "报告尚未生成。", "点第二次审查应在同一抽屉切换记录");
  assert.equal(await drawer.locator(".review-evidence-drawer__footer").count(), 0, "没有截图的轮次不应留下空白底栏");
  await activities.nth(3).getByRole("button").click();
  await drawer.waitFor({ state: "detached" });

  const acceptance = page.locator(".acceptance-fixture");
  const toolbar = acceptance.locator('[aria-label="自由工作流快捷操作"]');
  await toolbar.waitFor();
  assert.deepEqual(await toolbar.getByRole("button").allInnerTexts(), ["派审查", "打开预览"], "会话上方只保留派审与预览");
  assert.equal(await acceptance.getByText("合并&清理", { exact: true }).count(), 0, "自由工作流快捷栏不再显示合并按钮");
  const acceptButton = acceptance.getByRole("button", { name: "验收", exact: true });
  await acceptButton.click();
  const acceptanceWorkspace = acceptance.locator(".single-review-workspace");
  await acceptanceWorkspace.waitFor();
  const workspaceAcceptButton = acceptanceWorkspace.getByRole("button", { name: "验收通过", exact: true });
  await workspaceAcceptButton.waitFor();
  assert.equal(await workspaceAcceptButton.count(), 1, "自由任务应进入统一验收页");
  assert.equal(await acceptanceWorkspace.getByText("用会话上方“合并&清理”操作", { exact: true }).count(), 0);

  const blockedAcceptance = page.locator(".acceptance-blocked-fixture");
  await blockedAcceptance.getByRole("button", { name: "验收", exact: true }).click();
  const blockedWorkspace = blockedAcceptance.locator(".single-review-workspace");
  await blockedWorkspace.waitFor();
  const blockedButton = blockedWorkspace.getByRole("button", { name: "审查进行中", exact: true });
  await blockedButton.waitFor();
  assert.equal(await blockedButton.isDisabled(), true, "自由审查进行中应在验收页禁用验收按钮");
  assert.equal(await blockedWorkspace.getByRole("button", { name: "验收通过", exact: true }).count(), 0);

  const postMergeFixture = page.locator(".post-merge-fixture");
  const postMergeHeader = postMergeFixture.locator(".task-detail-header");
  assert.equal(await postMergeHeader.getByRole("button", { name: "已验收", exact: true }).count(), 1, "合并结果审查不能抢占已验收主按钮");
  assert.equal(await postMergeHeader.getByRole("button", { name: "审查合并结果", exact: true }).count(), 0, "合并审查默认只藏在更多菜单里");
  await postMergeHeader.getByRole("button", { name: "更多任务操作" }).click();
  const menuReview = postMergeHeader.getByRole("menuitem", { name: "审查合并结果" });
  await menuReview.waitFor();
  await menuReview.click();
  await reviewDialog.getByRole("heading", { name: "审查合并结果" }).waitFor();
  await reviewDialog.getByRole("button", { name: /Codex 审查/ }).waitFor();
  assert.match(await reviewDialog.innerText(), /main/);
  assert.match(await reviewDialog.innerText(), /11111111.*22222222/);
  assert.equal(await reviewDialog.getByText("失败后自动复审", { exact: true }).count(), 0, "合并后审查固定单轮，不显示自动复审设置");
  await reviewDialog.getByRole("button", { name: "关闭审查合并结果" }).click();

  await postMergeHeader.getByRole("button", { name: "更多任务操作" }).click();
  await postMergeHeader.getByRole("menuitem", { name: "查看改动与审查" }).click();
  const postMergeWorkspace = postMergeFixture.locator(".single-review-workspace");
  await postMergeWorkspace.getByRole("region", { name: "验收合并快照" }).waitFor();
  const snapshotLink = postMergeWorkspace.getByRole("button", { name: /审查本次合并/ });
  assert.equal(await snapshotLink.count(), 1, "统一验收快照卡应提供低调文字入口");
  await snapshotLink.click();
  await reviewDialog.getByRole("heading", { name: "审查合并结果" }).waitFor();
  await reviewDialog.getByRole("button", { name: /Codex 审查/ }).waitFor();
  await reviewDialog.getByRole("button", { name: "开始审查", exact: true }).click();
  await page.waitForFunction(() => window.__postMergeRequests === 1);
  assert.equal(await page.evaluate(() => window.__postMergeRequests), 1, "快照入口应发起一次合并结果审查");

  const postMergeInspector = page.locator(".post-merge-inspector-fixture");
  await postMergeInspector.getByRole("region", { name: "合并结果审查", exact: true }).waitFor();
  await postMergeInspector.getByRole("button", { name: "查看审查进度" }).waitFor({ timeout: 5000 });
  assert.equal(await postMergeInspector.getByText("可选", { exact: true }).count(), 1, "Inspector 应明确标注合并结果审查是可选操作");
  assert.match(await postMergeInspector.getByRole("region", { name: "合并结果审查", exact: true }).innerText(), /原任务仍保持已验收/);

  console.log("free workflow inspector preview test passed");
} finally {
  await browser?.close();
  await server.close();
}
