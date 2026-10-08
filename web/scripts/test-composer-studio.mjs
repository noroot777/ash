import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { chromeLaunchOptions } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  let teamPresetRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  const created = [];
  const queueCreates = [];
  let taskRefetches = 0;
  let failQueueCreate = false;
  const projectPatches = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = [];
    if (path === "/api/agents") data = [{ id: "exec-claude", name: "claude@cpa", type: "claude", model: "claude-opus-4.6", reasoningEffort: "high", providerId: "provider-cpa", isDefault: true }];
    if (path === "/api/llm-providers") data = [{ id: "provider-cpa", name: "CPA 中转", protocol: "anthropic", baseUrl: "https://example.invalid", model: "claude-opus-4.6", protocolConversionEnabled: false, modelListMode: "pinned", pinnedModels: ["claude-opus-4.6"], context1mModels: [], hasKey: true, createdAt: "2026-09-07T00:00:00.000Z" }];
    if (path === "/api/settings") data = { defaultWorkflowId: null };
    if (path === "/api/team-presets") teamPresetRequests += 1;
    if (path === "/api/workflows") data = [{ id: "standard", name: "验证起手式", builtin: true, disabled: false,
      def: { workspace: "isolated", steps: [{ id: "run", kind: "run", p: { executorId: "exec-claude", model: "test-model", reasoningEffort: null, instruction: null }, fail: null }] } }];
    if (path.endsWith("/branches")) data = { branches: ["main", "develop"], current: "main" };
    // 「设为本项目默认」写的是项目行本身，不是一份全局设置。
    if (path === "/api/projects/p1" && request.method() === "PATCH") {
      const patch = request.postDataJSON();
      projectPatches.push(patch);
      data = { id: "p1", name: "ash", repoPath: "/tmp/ash", workflowId: null, createdAt: "2026-08-28T00:00:00.000Z",
        health: { exists: true, isRepo: true }, ...patch };
    }
    if (path === "/api/tasks" && request.method() === "POST") {
      const body = request.postDataJSON();
      created.push(body);
      data = { ...body, id: "task-1", status: "backlog", title: body.body };
    }
    if (path === "/api/queues" && request.method() === "POST") {
      if (failQueueCreate) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
        return;
      }
      const body = request.postDataJSON();
      queueCreates.push(body);
      // 真实服务端在响应里带各成员入队后的 enriched 快照(updatedAt 已 bump)。
      data = { queueId: "q1", taskIds: body.taskIds,
        tasks: body.taskIds.map((tid, i) => ({ id: tid, title: tid === "task-1" ? "排队新任务" : "存量待办任务",
          status: "backlog", projectId: "p1", queueId: "q1", queuePosition: i, updatedAt: "2026-10-08T05:00:01.000Z" })) };
    }
    // 入队快照随插入/建队响应返回,面板不再「成功后补一次 GET」。
    if (path === "/api/tasks/task-1" && request.method() === "GET") taskRefetches += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/composer-upload.html?repo`);
  const objective = page.getByRole("textbox", { name: "任务目标" });
  const switchMode = (name) => page.getByRole("tab", { name, exact: true }).click();
  const openLaunch = () => page.getByRole("button", { name: /^启动设置：/ }).click();
  const clickOutside = () => page.locator(".composer-scroll").click({ position: { x: 5, y: 5 } });
  const people = page.getByRole("button", { name: /^谁来做：/ });
  const space = page.getByRole("button", { name: /^工作目录：/ });
  const flow = page.getByRole("button", { name: /^如何交付：/ });
  await objective.fill("保留我写好的目标");
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".studio-submit")?.disabled);
  assert.equal(await page.locator(".studio-popover:visible").count(), 0);
  assert.equal(await page.locator(".studio-card .run-target-picker:visible").count(), 1);
  assert.equal(await page.locator(".studio-card .composer-config").count(), 0);
  assert.equal(await page.locator(".studio-starters:visible").count(), 0);
  assert.equal(await page.getByLabel("启动方式").isVisible(), false);
  assert.equal(await page.getByRole("tablist", { name: "任务模式" }).getByRole("tab").count(), 3);

  await page.getByRole("button", { name: /^智能体：/ }).click();
  await page.keyboard.press("Escape");
  await space.click();
  const directoryPanel = page.getByRole("dialog", { name: "工作目录", exact: true });
  const worktreeSwitch = directoryPanel.getByRole("switch");
  const before = await worktreeSwitch.getAttribute("aria-checked");
  await directoryPanel.locator(".composer-toggle-field > span").click();
  assert.notEqual(await worktreeSwitch.getAttribute("aria-checked"), before);
  await directoryPanel.getByRole("button", { name: /^base 分支/ }).click();
  await page.getByRole("option", { name: "develop", exact: true }).click();
  assert.equal(await directoryPanel.isVisible(), true, "子菜单选择不能关闭父浮层");
  assert.match(await space.getAttribute("aria-label"), /独立 worktree.*develop/);
  await page.keyboard.press("Escape");
  assert.equal(await directoryPanel.isVisible(), false);
  assert.equal(await space.evaluate((element) => element === document.activeElement), true);

  await switchMode("团队");
  assert.equal(await objective.inputValue(), "保留我写好的目标");
  await people.click();
  const peoplePanel = page.getByRole("dialog", { name: "谁来做", exact: true });
  assert.equal(await peoplePanel.locator(".run-target-picker").count(), 3);
  await page.getByText("正在加载预设…", { exact: true }).waitFor({ state: "hidden" });
  assert.match(await peoplePanel.innerText(), /调度.*CPA 中转.*claude-opus-4\.6.*high/);
  assert.match(await peoplePanel.innerText(), /执行.*CPA 中转.*claude-opus-4\.6.*high/);
  await peoplePanel.getByRole("button", { name: /^智能体：/ }).first().click();
  await page.keyboard.press("Escape");
  assert.equal(await peoplePanel.isVisible(), true, "Escape 先关执行器子浮层");
  await page.keyboard.press("Escape");
  assert.equal(await peoplePanel.isVisible(), false);
  const loadedPresetRequests = teamPresetRequests;
  await people.click();
  assert.equal(teamPresetRequests, loadedPresetRequests, "重新展开不应重复拉取组合预设");
  await openLaunch();
  assert.equal(await peoplePanel.isVisible(), false, "打开另一辅助按钮时收起前一浮层");
  await flow.click();
  await page.getByRole("dialog", { name: "如何交付", exact: true }).locator(".composer-toggle-field > span").click();
  assert.match(await flow.getAttribute("aria-label"), /按需审查/);
  await switchMode("讨论");
  assert.equal(await space.count(), 0);
  await people.click();
  assert.match(await peoplePanel.innerText(), /A.*CPA 中转.*claude-opus-4\.6.*high/);
  assert.match(await peoplePanel.innerText(), /B.*CPA 中转.*claude-opus-4\.6.*high/);
  await page.keyboard.press("Escape");
  await flow.click();
  await page.getByRole("dialog", { name: "如何交付", exact: true }).locator(".composer-toggle-field > span").click();
  assert.match(await flow.getAttribute("aria-label"), /自动结束/);
  await page.getByRole("button", { name: "任务示例", exact: true }).click();
  await page.getByRole("button", { name: /解决一个问题/ }).click();
  assert.match(await objective.inputValue(), /^保留我写好的目标\n\n请帮我/);
  assert.equal(await page.getByRole("tab", { name: "单任务", exact: true }).getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name: "任务示例", exact: true }).click();
  await page.getByRole("button", { name: /讨论一个方案/ }).click();
  assert.equal(await page.getByRole("tab", { name: "讨论", exact: true }).getAttribute("aria-selected"), "true");
  await switchMode("单任务");
  assert.equal(await objective.evaluate((element) => element.value.startsWith("保留我写好的目标")), true);
  await page.getByRole("button", { name: /^组织与标签：/ }).click();
  await page.getByRole("textbox", { name: "添加标签" }).fill("界面优化");
  await page.getByRole("textbox", { name: "添加标签" }).press("Enter");
  await clickOutside();
  assert.equal(await page.locator(".studio-popover:visible").count(), 0);
  assert.match(await page.getByRole("button", { name: /^组织与标签：/ }).innerText(), /1 个标签/);

  await openLaunch();
  await page.getByLabel("启动方式").selectOption("once");
  await page.getByLabel("一次性运行时间").fill("");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "创建并定时" }).isDisabled(), true);
  assert.match(await page.locator(".studio-input-status").innerText(), /请选择一次性运行时间/);
  await objective.press("Control+Enter");
  assert.equal(created.length, 0, "隐藏定时面板后快捷键也不能绕过门禁");
  for (const width of [320, 390, 700, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("button", { name: /^组织与标签：/ }).click();
    const panel = page.getByRole("dialog", { name: "组织与标签", exact: true });
    assert.equal(await panel.getByRole("textbox", { name: "添加标签" }).isVisible(), true);
    assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth), true, "panel overflow at " + width);
    const bounds = await panel.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width, "panel outside viewport at " + width);
    await clickOutside();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "page overflow at " + width);
  }
  await openLaunch();
  await page.getByLabel("启动方式").selectOption("create");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await page.getByTestId("created").getByRole("listitem").waitFor();
  assert.equal(created.length, 1);
  assert.equal(created[0].useWorktree, true);
  assert.equal(created[0].worktreeBase, "develop");
  assert.deepEqual(created[0].labels, ["界面优化"]);
  assert.match(created[0].body, /^保留我写好的目标/);

  // 「创建并排队」：无目标禁提交；团队候选置灰；提交 = 建任务 + 建队列 + 重取入队后快照。
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  await objective.fill("排队新任务");
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  await openLaunch();
  await page.getByLabel("启动方式").selectOption("queue");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "创建并排队", exact: true }).isDisabled(), true, "没选目标不能创建");
  assert.match(await page.locator(".studio-input-status").innerText(), /选择要接在哪个任务之后/);
  await openLaunch();
  await page.locator(".composer-queue-after .ui-select-trigger").click();
  const teamRow = page.locator(".ui-dropdown-row", { hasText: "常驻团队任务" });
  assert.match(await teamRow.getAttribute("class"), /is-disabled/, "团队候选必须置灰");
  assert.match(await teamRow.innerText(), /队列不会等它完成/);
  await teamRow.click({ force: true }); // 置灰行按钮不可用,强制点一下验证不会选中
  await page.locator(".ui-dropdown-row", { hasText: "存量待办任务" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "创建并排队", exact: true }).click();
  await page.getByTestId("created").getByRole("listitem").waitFor();
  assert.equal(queueCreates.length, 1, "点了置灰的团队候选不能选中");
  assert.deepEqual(queueCreates[0].taskIds, ["t-backlog", "task-1"]);
  assert.equal(taskRefetches, 0, "入队快照来自插入/建队响应，不应再补一次 GET");
  // 第 5 轮回归:响应里的全体成员快照(前驱 + 新任务)整批上交 onTasksSynced——
  // 只同步新任务的话前驱在列表里保持入队前状态(无徽标、计数错位、重复建队)。
  assert.match(await page.getByTestId("synced").innerText(), /同步：t-backlog@q1#0 task-1@q1#1/, "前驱与新任务的入队快照都要上交");
  // 团队任务不被普通队列调度:团队模式下「创建并排队」置灰。
  await switchMode("团队");
  await openLaunch();
  assert.notEqual(await page.getByLabel("启动方式").locator('option[value="queue"]').getAttribute("disabled"), null, "团队模式不提供排队");
  await page.keyboard.press("Escape");

  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  await objective.fill("验证起手式配置");
  await page.getByRole("button", { name: /^工作方式：/ }).click();
  await page.getByRole("tab", { name: "起手式", exact: true }).click();
  await page.getByRole("button", { name: "展开编排" }).waitFor();
  assert.match(await page.locator(".studio-effective-run").innerText(), /test-model.*high/);
  assert.equal(await page.locator(".studio-inline-executor").count(), 0);
  assert.equal(await page.locator(".studio-workflow .is-workflow").count(), 1);
  await page.getByRole("button", { name: "展开编排" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^工作方式：/ }).click();
  assert.equal(await page.getByRole("button", { name: "收起", exact: true }).isVisible(), true, "折叠浮层保留编排展开状态");
  await page.getByRole("tab", { name: "自由工作流", exact: true }).click();
  assert.match(await page.locator(".studio-inline-executor").innerText(), /claude-opus-4\.6/);
  await page.getByRole("tab", { name: "起手式", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "展开编排" }).count(), 1);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    const panel = page.getByRole("dialog", { name: "工作方式", exact: true });
    assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth), true, "workflow overflow at " + width);
  }
  await openLaunch();
  await page.getByLabel("启动方式").selectOption("create");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await page.getByTestId("created").getByRole("listitem").waitFor();
  assert.equal(created[2].executorId, "exec-claude");
  assert.equal(created[2].model, "test-model");
  assert.equal(created[2].workflowMode, "preset");
  // 「设为本项目默认」：写的是项目行，而且要**把新的项目行交回上层** —— 这块面板一关就
  // 整个卸载，下次打开是按 project 重新初始化的。只更新面板内部那份的话，用户刚设完默认、
  // 重开新建任务却还预填着旧值（第 1 轮审查 P1）。
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  assert.match(await space.getAttribute("aria-label"), /项目目录/, "项目默认是「关」，面板该预填项目目录");
  await space.click();
  const workspacePanel = page.getByRole("dialog", { name: "工作目录", exact: true });
  await workspacePanel.locator(".composer-toggle-field > span").click();
  await workspacePanel.getByRole("button", { name: "设为本项目默认" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-worktree-default"]')?.textContent === "开");
  assert.deepEqual(projectPatches, [{ useWorktreeDefault: true }], "只写这一位，别捎带别的字段");
  await page.keyboard.press("Escape");
  await page.getByTestId("reopen").click();
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  assert.match(await space.getAttribute("aria-label"), /独立 worktree/, "重开面板必须按刚设成的项目默认预填");

  // 第 2 轮回归 A:新建分组也走统一改组联动——旧排队目标被清掉、提交被挡。
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  await objective.fill("新建分组联动");
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  await openLaunch();
  await page.getByLabel("启动方式").selectOption("queue");
  await page.locator(".composer-queue-after .ui-select-trigger").click();
  await page.locator(".ui-dropdown-row", { hasText: "存量待办任务" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".studio-submit")?.disabled);
  await page.getByRole("button", { name: /^组织与标签：/ }).click();
  await page.getByRole("button", { name: /^分组/ }).click();
  await page.locator(".ui-dropdown-row", { hasText: "新建分组" }).click();
  await page.getByRole("textbox", { name: "分组名称" }).fill("刚建的新组");
  await page.getByRole("button", { name: "创建分组", exact: true }).click();
  await page.getByRole("textbox", { name: "分组名称" }).waitFor({ state: "hidden" });
  await clickOutside();
  assert.equal(await page.getByRole("button", { name: "创建并排队", exact: true }).isDisabled(), true, "新建分组后旧排队目标必须被清掉");
  assert.match(await page.locator(".studio-input-status").innerText(), /选择要接在哪个任务之后/);
  assert.match(await page.getByTestId("notices").innerText(), /已清除排队目标/);

  // 排队请求本身失败时如实分开报两段:任务已创建、排队失败,不冒充成功。
  failQueueCreate = true;
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  await objective.fill("排队失败如实提示");
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  await openLaunch();
  await page.getByLabel("启动方式").selectOption("queue");
  await page.locator(".composer-queue-after .ui-select-trigger").click();
  await page.locator(".ui-dropdown-row", { hasText: "存量待办任务" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "创建并排队", exact: true }).click();
  await page.getByTestId("created").getByRole("listitem").waitFor();
  assert.match(await page.getByTestId("notices").innerText(), /任务已创建，但排队失败/);
  assert.equal(await page.getByTestId("synced").getByRole("listitem").count(), 0, "排队失败没有可同步的成员快照");
  failQueueCreate = false;

  assert.deepEqual(errors, []);
  console.log("composer studio: auxiliary popovers, nested dismissal, persistent config, templates, responsive layout, payload and project worktree default passed");
} finally {
  await browser?.close();
  await server.close();
}
