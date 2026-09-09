import assert from "node:assert/strict";

const settle = page => page.waitForTimeout(320);

export async function checkAssistantEntry(page, fixtureUrl) {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto(fixtureUrl);
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();

  const separator = () => page.getByRole("separator", { name: "调整任务树宽度" });
  const setSidebarWidth = async width => {
    await separator().press("Home");
    for (let current = 220; current < width; current += 10) await separator().press("ArrowRight");
    await settle(page);
    assert.equal(Number(await separator().getAttribute("aria-valuenow")), width);
  };
  const footerGeometry = () => page.locator(".workspace-sidebar-bottom").evaluate(node => {
    const sidebar = node.closest(".workspace-sidebar").getBoundingClientRect();
    const footer = node.getBoundingClientRect();
    const children = [...node.children].map(child => {
      const rect = child.getBoundingClientRect();
      return { label: child.getAttribute("aria-label"), text: child.innerText.replace(/\s+/gu, ""), left: rect.left, right: rect.right };
    });
    return { sidebarWidth: sidebar.width, footerHeight: footer.height, clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth, left: footer.left, right: footer.right, children };
  });

  let baselineHeight = null;
  for (const width of [220, 240, 260, 320]) {
    await setSidebarWidth(width);
    const geometry = await footerGeometry();
    baselineHeight ??= geometry.footerHeight;
    assert.ok(Math.abs(geometry.sidebarWidth - width) < 0.2, `${width}px sidebar changed width: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.footerHeight - baselineHeight) < 0.2, `${width}px footer changed height: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.scrollWidth <= geometry.clientWidth, `${width}px footer scroll overflow: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.children.every(child => child.left >= geometry.left - 0.2 && child.right <= geometry.right + 0.2),
      `${width}px footer child overflow: ${JSON.stringify(geometry)}`);
    const shortcut = geometry.children.find(child => child.label === "按 F 打开任务列表");
    const collapse = geometry.children.find(child => child.label === "收起侧边栏");
    const assistant = geometry.children.find(child => child.label === "ash 助手");
    assert.equal(shortcut?.text, width < 240 ? "F打开" : "F打开任务列表", `${width}px keeps the original F label breakpoint`);
    assert.equal(collapse?.text, "收起", `${width}px keeps the collapse label`);
    assert.equal(assistant?.text, width >= 320 ? "助手" : "", `${width}px assistant label follows available footer width`);
  }

  await setSidebarWidth(220);
  await page.keyboard.press("f");
  await page.locator(".workspace-sidebar.is-spread-open").waitFor();
  await settle(page);
  const framesPromise = page.evaluate(() => new Promise(resolve => {
    const frames = [];
    const sample = () => {
      const sidebar = document.querySelector(".workspace-sidebar").getBoundingClientRect();
      const footer = document.querySelector(".workspace-sidebar-bottom");
      const children = [...footer.children].map(child => child.getBoundingClientRect().right);
      frames.push({ sidebarRight: sidebar.right, footerRight: footer.getBoundingClientRect().right,
        scrollWidth: footer.scrollWidth, clientWidth: footer.clientWidth, childRight: Math.max(...children) });
      if (frames.length < 48) requestAnimationFrame(sample); else resolve(frames);
    };
    requestAnimationFrame(sample);
  }));
  await page.keyboard.press("Escape");
  const frames = await framesPromise;
  assert.ok(frames.length >= 40, "spread close must be sampled across animation frames");
  for (const [index, frame] of frames.entries()) {
    assert.ok(frame.scrollWidth <= frame.clientWidth, `spread close frame ${index} scroll overflow: ${JSON.stringify(frame)}`);
    assert.ok(frame.childRight <= frame.footerRight + 0.5 && frame.footerRight <= frame.sidebarRight + 0.5,
      `spread close frame ${index} visible overflow: ${JSON.stringify(frame)}`);
  }
  await page.locator(".workspace-sidebar.is-spread").waitFor({ state: "detached" });

  const footerAssistant = page.locator(".workspace-assistant-entry");
  await footerAssistant.hover();
  await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).waitFor();
  let tip = await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).boundingBox();
  assert.ok(tip && tip.x >= 0 && tip.y >= 0 && tip.x + tip.width <= 1200 && tip.y + tip.height <= 820, "hover tooltip stays in viewport");
  await footerAssistant.focus();
  await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).waitFor();
  tip = await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).boundingBox();
  assert.ok(tip && tip.y >= 0, "focus tooltip stays above the footer without clipping");

  await footerAssistant.click();
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  assert.match(page.url(), /[?&]view=chat(?:&|$)/u);
  assert.notEqual(await footerAssistant.getAttribute("aria-pressed"), "true", "chat does not select the assistant entry");
  assert.equal(await page.getByRole("button", { name: "聊天", exact: true }).first().getAttribute("aria-pressed"), "true", "chat entry reflects chat view");
  await page.getByRole("button", { name: "ash 助手" }).last().click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u);
  await page.getByRole("button", { name: "关闭助手" }).click();
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  assert.match(page.url(), /[?&]view=chat(?:&|$)/u, "assistant exit returns to chat source");

  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  const collapsed = page.getByRole("complementary", { name: "已收起的侧边栏" });
  assert.equal(await collapsed.getByRole("button", { name: "聊天" }).count(), 1, "project collapsed sidebar has one chat entry");
  assert.equal(await collapsed.getByRole("button", { name: "ash 助手" }).count(), 0, "project collapsed sidebar has no duplicate assistant/chat entry");
  const collapsedChat = collapsed.getByRole("button", { name: "聊天" });
  assert.notEqual(await collapsedChat.getAttribute("aria-pressed"), "true");
  await collapsedChat.click();
  assert.equal(await collapsedChat.getAttribute("aria-pressed"), "true", "collapsed chat entry reflects the current view");

  await page.request.post(new URL("api/fixture/project-list", fixtureUrl).href, { data: { empty: true } });
  await page.goto(new URL("/", fixtureUrl).href);
  await page.getByRole("heading", { name: "还没有可用项目" }).waitFor();
  const emptyCollapsed = page.getByRole("complementary", { name: "已收起的侧边栏" });
  assert.equal(await emptyCollapsed.getByRole("button", { name: "聊天" }).count(), 0);
  assert.equal(await emptyCollapsed.getByRole("button", { name: "ash 助手" }).count(), 1);
  await emptyCollapsed.getByRole("button", { name: "ash 助手" }).click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u, "no-project assistant fallback opens directly");
}
