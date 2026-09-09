import assert from "node:assert/strict";

export async function checkPreviewServiceRegressions(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  try {
    await page.goto(`${base}?mode=services-long`);
    await page.getByRole("button", { name: "关闭预览", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert(await page.getByTestId("preview-log-open").evaluate((el) => el === document.activeElement), "第一行的日志入口应先于第二行的服务链接获得焦点");
    await page.keyboard.press("Tab");
    assert(await page.locator(".preview-service-links a").first().evaluate((el) => el === document.activeElement), "日志入口之后应进入第二行的服务链接");

    await page.setViewportSize({ width: 620, height: 900 });
    assert.equal(await page.locator(".preview-service-links").isVisible(), false, "窄屏应统一收起多服务预览链接");
    await page.goto(`${base}?mode=single-short`);
    const singleLink = page.getByRole("link", { name: "在新窗口打开预览", includeHidden: true });
    await singleLink.waitFor({ state: "attached" });
    assert.equal(await singleLink.isVisible(), false, "窄屏单服务预览链接也应收起");
    await page.getByTestId("preview-log-open").click();
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent === "single-service banner");
    const singleHeight = await page.locator(".preview-log-dialog").evaluate((el) => el.getBoundingClientRect().height);
    assert(singleHeight < 400, "单服务短日志不应被多服务 Tab 的固定高度撑满");

    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(`${base}?mode=services-removed`);
    await page.getByTestId("preview-log-open").click();
    await page.getByRole("tab", { name: /a4sms-icis/ }).click();
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent === "fresh api log");
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent === "remaining services log", null, { timeout: 8000 });
    assert.equal(await page.getByRole("tab", { selected: true }).count(), 1, "选中服务消失后仍应有唯一选中项");
    assert.match(await page.getByRole("tab", { selected: true }).textContent(), /全部/);
    assert.equal(await page.locator('[role="tab"][tabindex="0"]').count(), 1, "服务消失后 Tab 条应仍可通过键盘进入");
    const reference = await page.getByRole("tabpanel").evaluate((el) => {
      const tab = document.getElementById(el.getAttribute("aria-labelledby"));
      return { valid: tab?.getAttribute("aria-selected") === "true", focused: tab === document.activeElement };
    });
    assert.deepEqual(reference, { valid: true, focused: true }, "tabpanel 应引用全部 Tab，被移除 Tab 的焦点也应回到全部");
    await page.getByRole("button", { name: "关闭预览日志" }).focus();
    await page.keyboard.press("Tab");
    assert(await page.getByRole("tab", { selected: true }).evaluate((el) => el === document.activeElement), "关闭按钮之后不能跳过服务 Tab 条");

    await page.goto(`${base}?mode=services-late`);
    await page.getByTestId("preview-log-open").click();
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent?.includes("all service line 220"));
    assert.equal(await page.getByRole("tab").count(), 0);
    await page.getByRole("button", { name: "复制", exact: true }).focus();
    await page.getByRole("tab", { name: /全部/ }).waitFor({ timeout: 15000 });
    assert(await page.getByRole("button", { name: "复制", exact: true }).evaluate((el) => el === document.activeElement), "迟到的服务列表不能抢走复制按钮的焦点");

    const multiHeight = await page.locator(".preview-log-dialog").evaluate((el) => el.getBoundingClientRect().height);
    await page.getByRole("tab", { name: /a4sms-icis/ }).click();
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent === "fresh api log");
    const shortHeight = await page.locator(".preview-log-dialog").evaluate((el) => el.getBoundingClientRect().height);
    assert.equal(shortHeight, multiHeight, "多服务 Tab 切换长短日志时窗口高度应保持稳定");
    await page.keyboard.press("Escape");
    assert(await page.getByTestId("preview-log-open").evaluate((el) => el === document.activeElement), "关闭日志后应恢复入口焦点");

    await page.goto(`${base}?mode=services-many`);
    await page.getByTestId("preview-log-open").click();
    const logBody = page.locator(".preview-log-body");
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent?.includes("all service line 220"));
    assert(await logBody.evaluate((el) => el === document.activeElement), "首开日志应聚焦正文，便于键盘阅读");
    await logBody.evaluate((el) => { el.scrollTop = 0; });
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.scrollTop > 0);
    await page.keyboard.press("Space");
    assert.equal(await page.getByRole("dialog", { name: "预览日志" }).count(), 1, "空格应翻阅日志，不能触发关闭按钮");

    await page.goto(`${base}?mode=services-removed-error`);
    await page.getByTestId("preview-log-open").click();
    await page.getByRole("tab", { name: /a4sms-icis/ }).click();
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent === "temporary log error #1", null, { timeout: 8000 });
    assert.match(await page.getByTestId("preview-log-state").textContent(), /正在运行/, "回退全部期间读取失败，不能把运行中的预览说成历史日志");
    assert.equal(await page.locator(".preview-log-meta").count(), 0, "回退全部后不应保留已移除服务的命令或链接");
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent === "remaining services log", null, { timeout: 12000 });
    assert.match(await page.getByRole("tab", { selected: true }).textContent(), /全部/);
    assert.match(await page.getByTestId("preview-log-state").textContent(), /正在运行/);

    await page.goto(`${base}?mode=services-late-short`);
    await page.getByTestId("preview-log-open").click();
    await page.waitForFunction(() => document.querySelector(".preview-log-body")?.textContent === "startup banner");
    assert.equal(await page.getByRole("tab").count(), 0);
    const geometry = () => page.locator(".preview-log-dialog").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      height: el.getBoundingClientRect().height,
      footerTop: el.querySelector("footer").getBoundingClientRect().top,
    }));
    const beforeServices = await geometry();
    assert(beforeServices.height > 600, "服务数未知的启动预览应在列表到达前预留阅读空间");
    await page.getByRole("button", { name: "复制", exact: true }).focus();
    await page.getByRole("tab", { name: /全部/ }).waitFor({ timeout: 15000 });
    assert.deepEqual(await geometry(), beforeServices, "服务列表到达后窗口和底部按钮不能跳位");
    assert(await page.getByRole("button", { name: "复制", exact: true }).evaluate((el) => el === document.activeElement), "短日志的服务列表迟到也不能抢焦点");
  } finally {
    await page.close();
  }
}
