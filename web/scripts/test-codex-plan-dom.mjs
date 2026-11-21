import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS } from "./wait-until.mjs";

async function assertImplementLayout(button, minimumHeight) {
  const layout = await button.evaluate((element) => {
    const [key, label, arrow] = [...element.children].map((child) => child.getBoundingClientRect().toJSON());
    return {
      display: getComputedStyle(element).display,
      button: element.getBoundingClientRect().toJSON(),
      row: element.parentElement.getBoundingClientRect().toJSON(),
      key, label, arrow,
    };
  });
  assert.equal(layout.display, "flex", "实施按钮必须沿用选项行的横向布局");
  assert.ok(Math.abs(layout.button.width - layout.row.width) < 1, "整行都应可点击");
  assert.ok(layout.button.height >= minimumHeight, "选项行保留足够的点击高度");
  assert.equal(layout.key.width, 20, "快捷键不能撑满按钮");
  assert.equal(layout.key.height, 20);
  assert.ok(layout.key.x > layout.button.x, "内容与卡片左边缘保留间距");
  assert.ok(layout.label.x >= layout.key.right + 9, "文字排在快捷键右侧");
  assert.ok(layout.arrow.x >= layout.label.right + 9, "箭头排在文字右侧");
  assert.ok(layout.arrow.right < layout.button.right, "箭头不能贴边或溢出");
  for (const content of [layout.label, layout.arrow]) {
    assert.ok(Math.abs(content.y + content.height / 2 - layout.key.y - layout.key.height / 2) < 1,
      "快捷键、文字与箭头应垂直居中对齐");
  }
}

const web = await startWebServer();
let browser;
const errors = [];
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  page.setDefaultTimeout(WAIT_TIMEOUT_MS);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body:
    route.request().url().endsWith("/agents") ? JSON.stringify([
      { id: "codex-main", name: "codex@主执行器", type: "codex", isDefault: true },
      { id: "codex-plan", name: "codex@规划", type: "codex" },
    ]) : "[]",
  }));
  await page.goto(`${web.origin}/scripts/fixtures/codex-plan.html`);
  await page.getByRole("button", { name: "开始拟定", exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.reload();
  errors.length = 0;
  await page.getByRole("button", { name: "重置计划" }).click();
  await page.getByRole("button", { name: "开始拟定", exact: true }).click();
  const plan = page.getByRole("region", { name: "计划书" });
  await plan.waitFor();
  assert.match(await plan.innerText(), /正在拟定计划/);
  assert.equal(await page.getByRole("button", { name: "实施此计划", exact: true }).count(), 0);
  await page.getByRole("button", { name: "追加草稿" }).click();
  await plan.getByRole("heading", { name: "草稿标题" }).waitFor();
  assert.equal(await plan.count(), 1);
  assert.equal(await plan.locator("pre").count(), 0);
  await page.screenshot({ path: "/tmp/navi-codex-plan-streaming.png", fullPage: true });
  await page.reload();
  await plan.getByRole("heading", { name: "草稿标题" }).waitFor();
  await page.getByRole("button", { name: "完成计划", exact: true }).click();
  await plan.getByRole("heading", { name: "周额度管理台 HTML Demo" }).waitFor();
  assert.equal(await plan.count(), 1);
  assert.doesNotMatch(await plan.innerText(), /草稿标题|尚未定稿/);
  assert.equal(await plan.locator("table").count(), 1);
  assert.equal(await plan.locator("pre").count(), 1);
  const implement = page.getByRole("button", { name: "实施此计划", exact: true });
  await implement.waitFor();
  assert.equal(await implement.isEnabled(), true);
  await assertImplementLayout(implement, 38);
  const exported = await page.getByLabel("导出计划").textContent();
  assert.match(exported, /周额度管理台/);
  assert.doesNotMatch(exported, /尚未定稿/);
  await page.getByRole("region", { name: "计划已就绪" }).screenshot({ path: "/tmp/navi-codex-plan-ready.png", animations: "disabled" });
  await page.reload();
  await implement.waitFor();
  await page.getByRole("button", { name: "展开计划" }).click();
  const dialog = page.getByRole("dialog", { name: "计划全文" });
  await dialog.waitFor();
  await dialog.getByRole("heading", { name: "交付目标" }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "展开计划" }).evaluate((element) => element === document.activeElement), true);
  await page.getByRole("button", { name: "下载计划" }).click();
  // 「实施此计划？」占着回复框：平常的框不在；收起后缩成一行，框回到它下面，点那一行再展开。
  const reply = page.getByRole("textbox", { name: "回复任务" });
  assert.equal(await reply.count(), 0);
  await page.getByRole("button", { name: "收起，先看计划", exact: true }).click();
  await implement.waitFor({ state: "hidden" });
  await reply.waitFor();
  await page.getByRole("button", { name: "实施此计划？", exact: true }).click();
  await implement.waitFor();
  assert.equal(await reply.count(), 0);
  await page.getByRole("button", { name: "收起，先看计划", exact: true }).focus();
  await page.keyboard.press("1");
  assert.equal(await implement.evaluate((element) => element === document.activeElement), true);
  await page.reload();
  await implement.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertImplementLayout(implement, 44);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole("region", { name: "计划已就绪" }).screenshot({ path: "/tmp/navi-codex-plan-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1200, height: 1100 });
  await page.getByRole("checkbox", { name: "模拟发送失败" }).check();
  await implement.click();
  await page.getByText("网络暂不可用，计划仍然保留", { exact: true }).waitFor();
  assert.equal(await implement.isEnabled(), true);
  assert.equal(await plan.count(), 1);
  await page.getByRole("checkbox", { name: "模拟发送失败" }).uncheck();
  await implement.click();
  const sent = JSON.parse(await page.getByLabel("实施请求").innerText());
  assert.equal(sent.text, "/plan implement proposal-1");
  assert.equal(sent.agent, "codex");
  assert.equal(sent.executorId, "codex-plan");
  assert.equal(await implement.count(), 0);
  // 第二条路：在卡里直接写要怎么改，交回出计划的同一个执行器（不是开工）。
  await page.reload();
  await implement.waitFor();
  const revise = page.getByRole("button", { name: "发送修改", exact: true });
  assert.equal(await revise.isEnabled(), false);
  await page.getByRole("textbox", { name: "要怎么改这份计划", exact: true }).fill("验证一节再补上手机布局");
  await revise.click();
  const revised = JSON.parse(await page.getByLabel("实施请求").innerText());
  assert.equal(revised.text, "验证一节再补上手机布局");
  assert.equal(revised.executorId, "codex-plan");
  await page.screenshot({ path: "/tmp/navi-codex-plan-revised.png", fullPage: true });
  await page.getByRole("button", { name: "重置计划" }).click();
  await page.getByRole("button", { name: "开始拟定", exact: true }).click();
  await page.getByRole("button", { name: "追加草稿" }).click();
  await page.getByRole("button", { name: "中止拟定" }).click();
  assert.match(await plan.innerText(), /计划草稿/);
  assert.equal(await implement.count(), 0);
  await page.getByRole("button", { name: "完成计划", exact: true }).click();
  await implement.waitFor();
  await page.getByRole("button", { name: "规划异常结束", exact: true }).click();
  assert.equal(await implement.count(), 0);
  assert.deepEqual(errors, []);
  console.log("Codex plan live Markdown, final replacement, reload, full view, draft safety, scoped implementation and narrow layout: passed");
} finally {
  await browser?.close();
  await web.close();
}
