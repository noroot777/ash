import assert from "node:assert/strict";

const settle = page => page.waitForTimeout(320);

export async function checkAssistantEntry(page, fixtureUrl) {
  await page.setViewportSize({ width: 1200, height: 820 });
  const fixtureBase = new URL("/", fixtureUrl);
  const configureProjects = data => page.request.post(new URL("api/fixture/project-list", fixtureBase).href, { data });
  const footerAssistantEntry = () => page.locator(".workspace-assistant-entry");

  try {
  await configureProjects({ empty: false, delayMs: 1_200 });
  await page.goto(fixtureUrl);
  await footerAssistantEntry().waitFor();
  assert.equal(await footerAssistantEntry().isEnabled(), true, "project-independent assistant is available while projects load");
  await footerAssistantEntry().click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u, "footer entry opens assistant directly while projects load");

  await configureProjects({ empty: false, fail: true });
  const failedProjects = page.waitForResponse(response => response.url().endsWith("/api/projects") && response.status() === 503);
  await page.goto(fixtureUrl);
  await failedProjects;
  await page.locator(".workspace-load-error").waitFor();
  await footerAssistantEntry().waitFor();
  assert.equal(await footerAssistantEntry().isEnabled(), true, "assistant remains available when projects fail to load");
  await footerAssistantEntry().click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u, "project error falls back to the project-independent assistant");

  await configureProjects({ empty: true, delayMs: 800 });
  const emptyProjects = page.waitForResponse(response => response.url().endsWith("/api/projects") && response.status() === 200);
  await page.goto(fixtureBase.href);
  await footerAssistantEntry().waitFor();
  assert.equal(await footerAssistantEntry().isEnabled(), true);
  await emptyProjects;
  await page.getByRole("heading", { name: "还没有可用项目" }).waitFor();
  await footerAssistantEntry().click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u, "confirmed empty project list opens assistant directly");

  await configureProjects({ empty: false });
  await page.goto(fixtureUrl);
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();

  await page.getByRole("button", { name: "聊天", exact: true }).first().click();
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  await page.getByRole("button", { name: "ash 助手" }).last().click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  await page.getByRole("button", { name: "登录认证流程重构" }).click();
  const taskTitle = page.getByRole("textbox", { name: "任务标题" });
  await taskTitle.waitFor();
  assert.equal(await taskTitle.inputValue(), "登录认证流程重构");
  await page.goBack();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  await page.getByRole("button", { name: "关闭助手" }).click();
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();
  assert.doesNotMatch(page.url(), /[?&]view=chat(?:&|$)/u, "popstate clears a stale chat origin before assistant closes");

  await page.getByRole("button", { name: "聊天", exact: true }).first().click();
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  await page.getByRole("button", { name: "ash 助手" }).last().click();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u);
  assert.match(page.url(), /[?&]from=chat(?:&|$)/u, "assistant URL records its chat origin");
  await configureProjects({ empty: false, delayMs: 1_200 });
  await page.reload();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  await page.getByRole("button", { name: "关闭助手" }).click();
  await page.waitForURL(/[?&]view=chat(?:&|$)/u);
  assert.equal(await footerAssistantEntry().isEnabled(), true, "assistant remains available before the delayed project list returns");
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  assert.match(page.url(), /[?&]view=chat(?:&|$)/u, "assistant reload preserves the chat return path");
  await configureProjects({ empty: false });
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();

  await configureProjects({ empty: true });
  const confirmedEmptyProjects = page.waitForResponse(response => response.url().endsWith("/api/projects") && response.status() === 200);
  await page.goto(new URL("?view=assistant&from=chat", fixtureBase).href);
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  await confirmedEmptyProjects;
  await page.getByRole("button", { name: "关闭助手" }).click();
  await page.getByRole("heading", { name: "还没有可用项目" }).waitFor();
  assert.doesNotMatch(page.url(), /[?&]view=chat(?:&|$)/u, "confirmed no-project state cannot leave a chat URL behind");

  await configureProjects({ empty: true, delayMs: 1_200 });
  await page.goto(new URL("?view=assistant&from=chat", fixtureBase).href);
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.equal(await footerAssistantEntry().isEnabled(), true, "assistant entry stays enabled during an eventually empty project load");
  await page.getByRole("button", { name: "关闭助手" }).click();
  await page.waitForURL(/[?&]view=chat(?:&|$)/u);
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get("view") !== "chat");
  await page.getByRole("heading", { name: "还没有可用项目" }).waitFor();
  assert.doesNotMatch(page.url(), /[?&]view=chat(?:&|$)/u, "eventually empty project list keeps URL and workspace consistent");
  await configureProjects({ empty: false });
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
    assert.equal(assistant?.text, "助手", `${width}px assistant label remains visible`);
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
  const connection = page.getByRole("status", { name: "实时已连接" });
  assert.equal((await connection.innerText()).trim(), "", "expanded connection status only renders its dot");
  await connection.hover();
  const connectionTip = page.getByRole("tooltip").filter({ hasText: "实时已连接" });
  await connectionTip.waitFor();
  const expandedAnchor = await connection.boundingBox();
  const expandedTip = await connectionTip.boundingBox();
  assert.ok(expandedAnchor && expandedTip
    && expandedTip.x <= expandedAnchor.x + expandedAnchor.width / 2
    && expandedTip.x + expandedTip.width >= expandedAnchor.x + expandedAnchor.width / 2,
  `expanded connection tooltip stays attached to its dot: ${JSON.stringify({ expandedAnchor, expandedTip })}`);
  await footerAssistant.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await connection.evaluate(node => document.activeElement === node), true,
    "Shift+Tab from assistant reaches the connection status");
  await connectionTip.waitFor();
  const focusGeometry = await connection.evaluate(node => {
    const footer = node.closest(".workspace-sidebar-bottom");
    const rect = node.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const style = getComputedStyle(node);
    const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
    const outlineOffset = Number.parseFloat(style.outlineOffset) || 0;
    return { footerLeft: footerRect.left, focusLeft: rect.left - Math.max(0, outlineWidth + outlineOffset),
      outlineWidth, outlineOffset, overflowX: getComputedStyle(footer).overflowX };
  });
  assert.ok(focusGeometry.outlineWidth > 0, `keyboard focus renders a visible connection outline: ${JSON.stringify(focusGeometry)}`);
  assert.ok(focusGeometry.overflowX === "visible" || focusGeometry.focusLeft >= focusGeometry.footerLeft - 0.1,
    `connection focus ring is not clipped: ${JSON.stringify(focusGeometry)}`);

  const assistantAppearance = await footerAssistant.evaluate(node => {
    const style = getComputedStyle(node);
    const sample = document.createElement("span");
    sample.style.background = "var(--panel)";
    document.body.append(sample);
    const panelBackground = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return { background: style.backgroundColor, panelBackground, height: node.getBoundingClientRect().height };
  });
  assert.equal(assistantAppearance.background, assistantAppearance.panelBackground, "assistant entry uses the white panel background");
  assert.ok(assistantAppearance.height <= baselineHeight, `assistant button does not increase footer height: ${JSON.stringify(assistantAppearance)}`);
  await footerAssistant.hover();
  await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).waitFor();
  assert.equal(await page.getByRole("tooltip").count(), 1, "hovering assistant dismisses the focused connection tooltip");
  let tip = await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).boundingBox();
  assert.ok(tip && tip.x >= 0 && tip.y >= 0 && tip.x + tip.width <= 1200 && tip.y + tip.height <= 820, "hover tooltip stays in viewport");
  await page.locator(".workspace-main").hover();
  await connectionTip.waitFor();
  assert.equal(await page.getByRole("tooltip").count(), 1, "connection focus tooltip returns after leaving assistant");
  await page.locator(".workspace-main").click();
  await page.getByRole("tooltip").waitFor({ state: "detached" });
  await footerAssistant.focus();
  await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).waitFor();
  tip = await page.getByRole("tooltip").filter({ hasText: "ash 助手" }).boundingBox();
  assert.ok(tip && tip.y >= 0, "focus tooltip stays above the footer without clipping");

  const objective = page.getByRole("textbox", { name: "任务目标" });
  const convertNewNote = async body => {
    await page.getByRole("button", { name: "随手记", exact: true }).click();
    const notes = page.getByRole("dialog", { name: "随手记" });
    await notes.waitFor();
    await notes.getByRole("button", { name: "新建随手记" }).click();
    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/notes")
      && response.request().method() === "POST" && response.status() === 201);
    const editor = notes.getByPlaceholder("记下临时想法、路径、验证清单…");
    await editor.fill(body);
    await notes.getByRole("button", { name: "转为新任务", exact: true }).click();
    const saved = await (await savedResponse).json();
    await objective.waitFor();
    return saved.id;
  };
  const createAndCheckNoteLink = async noteId => {
    await page.getByRole("button", { name: /启动设置/u }).click();
    await page.getByLabel("启动方式").selectOption("create");
    const linkedResponse = page.waitForResponse(response => response.url().endsWith(`/api/notes/${noteId}`)
      && response.request().method() === "PATCH" && response.status() === 200);
    await page.getByRole("button", { name: "创建任务", exact: true }).click();
    const linkedRequest = (await linkedResponse).request();
    assert.equal(typeof linkedRequest.postDataJSON().taskId, "string", "converted note keeps its task link id");
  };

  await footerAssistant.click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u);
  assert.equal(await footerAssistant.getAttribute("aria-pressed"), "true", "footer entry reflects assistant view");
  await page.getByRole("button", { name: "关闭助手" }).click();
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();
  assert.doesNotMatch(page.url(), /[?&]view=chat(?:&|$)/u, "footer assistant exit returns to workspace");

  await page.getByRole("button", { name: "聊天", exact: true }).first().click();
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  await page.getByRole("button", { name: "ash 助手" }).last().click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]from=chat(?:&|$)/u);
  await page.getByRole("button", { name: "关闭助手" }).click();
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  assert.match(page.url(), /[?&]view=chat(?:&|$)/u, "assistant exit returns to chat source");

  await page.getByRole("button", { name: "返回工作区" }).click();
  await footerAssistant.click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  const workspaceNoteId = await convertNewNote("从工作区助手转来的随手记");
  assert.match(page.url(), /[?&]view=create(?:&|$)/u, "workspace assistant note conversion opens composer immediately");
  assert.equal(await objective.inputValue(), "从工作区助手转来的随手记");
  await page.getByRole("tab", { name: "ash 助手" }).click();
  await page.getByRole("button", { name: "关闭助手" }).click();
  await objective.waitFor();
  assert.equal(await objective.inputValue(), "从工作区助手转来的随手记", "workspace note seed is applied once");
  await createAndCheckNoteLink(workspaceNoteId);

  await page.goto(fixtureUrl);
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();
  await page.getByRole("button", { name: "新建任务" }).click();
  await objective.waitFor();
  await page.getByRole("tab", { name: "团队", exact: true }).click();
  await objective.fill("保留这份团队任务草稿");
  await page.getByRole("tab", { name: "ash 助手" }).click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]from=composer(?:&|$)/u, "assistant URL records its composer origin");
  assert.match(page.url(), /[?&]mode=team(?:&|$)/u, "assistant URL records the composer mode");
  await page.getByRole("button", { name: "关闭助手" }).click();
  await objective.waitFor();
  assert.equal(await objective.inputValue(), "保留这份团队任务草稿", "composer draft survives an assistant round trip");
  assert.equal(await page.getByRole("tab", { name: "团队", exact: true }).getAttribute("aria-selected"), "true",
    "composer mode survives an assistant round trip");
  await page.getByRole("tab", { name: "ash 助手" }).click();
  await page.reload();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  await page.getByRole("button", { name: "关闭助手" }).click();
  await objective.waitFor();
  assert.equal(await page.getByRole("tab", { name: "团队", exact: true }).getAttribute("aria-selected"), "true",
    "composer mode survives an assistant page reload");
  await page.getByRole("tab", { name: "团队", exact: true }).click();
  await objective.fill("原有的团队草稿");
  await page.getByRole("tab", { name: "ash 助手" }).click();
  const composerNoteId = await convertNewNote("从原新建任务来源的助手转来的随手记");
  assert.match(page.url(), /[?&]view=create(?:&|$)/u);
  assert.match(page.url(), /[?&]mode=single(?:&|$)/u, "note conversion switches directly to single-task composer");
  const mergedNoteDraft = "从原新建任务来源的助手转来的随手记\n\n原有的团队草稿";
  assert.equal(await objective.inputValue(), mergedNoteDraft, "converted note seed and existing composer draft are both retained");
  await page.getByRole("tab", { name: "ash 助手" }).click();
  await page.getByRole("button", { name: "关闭助手" }).click();
  await objective.waitFor();
  assert.equal(await objective.inputValue(), mergedNoteDraft, "assistant round trip does not apply the note seed twice");
  await createAndCheckNoteLink(composerNoteId);

  await page.goto(fixtureUrl);
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();
  await page.getByRole("button", { name: "聊天", exact: true }).first().click();
  await page.getByRole("region", { name: "聊天模式" }).waitFor();
  const chatNoteId = await convertNewNote("从聊天来源转来的随手记");
  assert.match(page.url(), /[?&]view=create(?:&|$)/u, "chat note conversion opens composer immediately");
  assert.doesNotMatch(page.url(), /[?&]view=chat(?:&|$)/u);
  assert.equal(await objective.inputValue(), "从聊天来源转来的随手记");
  await createAndCheckNoteLink(chatNoteId);

  await page.goto(fixtureUrl);
  await page.getByRole("heading", { name: "从任务树选择一项" }).waitFor();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  const collapsed = page.getByRole("complementary", { name: "已收起的侧边栏" });
  assert.equal(await collapsed.getByRole("button", { name: "聊天" }).count(), 0, "collapsed sidebar has no chat-shaped duplicate");
  assert.equal(await collapsed.getByRole("button", { name: "ash 助手" }).count(), 1, "collapsed sidebar keeps one assistant entry");
  const collapsedConnection = collapsed.getByRole("status", { name: "实时已连接" });
  await collapsedConnection.hover();
  await connectionTip.waitFor();
  const collapsedAnchor = await collapsedConnection.boundingBox();
  const collapsedTip = await connectionTip.boundingBox();
  assert.ok(collapsedAnchor && collapsedTip
    && collapsedTip.x <= collapsedAnchor.x + collapsedAnchor.width / 2
    && collapsedTip.x + collapsedTip.width >= collapsedAnchor.x + collapsedAnchor.width / 2,
  `collapsed connection tooltip stays attached to its dot: ${JSON.stringify({ collapsedAnchor, collapsedTip })}`);
  const collapsedAssistant = collapsed.getByRole("button", { name: "ash 助手" });
  await collapsedAssistant.click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u, "collapsed assistant entry opens AssistantView directly");
  assert.doesNotMatch(page.url(), /[?&]from=chat(?:&|$)/u, "collapsed footer entry uses the workspace return path");

  await configureProjects({ empty: true });
  await page.goto(fixtureBase.href);
  await page.getByRole("heading", { name: "还没有可用项目" }).waitFor();
  const emptyCollapsed = page.getByRole("complementary", { name: "已收起的侧边栏" });
  assert.equal(await emptyCollapsed.getByRole("button", { name: "聊天" }).count(), 0);
  assert.equal(await emptyCollapsed.getByRole("button", { name: "ash 助手" }).count(), 1);
  await emptyCollapsed.getByRole("button", { name: "ash 助手" }).click();
  await page.getByRole("region", { name: "ash 助手" }).waitFor();
  assert.match(page.url(), /[?&]view=assistant(?:&|$)/u, "no-project assistant fallback opens directly");
  } finally {
    await configureProjects({ empty: false }).catch(() => {});
  }
}
