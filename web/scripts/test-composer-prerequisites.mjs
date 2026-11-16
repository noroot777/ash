import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 新建面板「创建并等前置」（composer/usePrerequisitePicks.tsx）：
// - 没选前置时发送键点不动、说得出差什么；候选全部列出，不能选的置灰写原因，能选的写它到哪一步了；
// - 选了第一条，合入分支跟着它走，合入别的分支的那条随即置灰；「从哪开工」「合入分支」如实写跟着前置走；
// - 草稿记得这种启动方式和已选的前置；恢复时失效的那条被去掉；
// - 建任务被服务端拒绝时原样显示原因、面板上写的不丢；按下去 = 一次建任务请求带上两条前置，再要求运行；
//   前置没齐时提示「已建好，等谁站稳后自动开始」，不是启动失败；
// - 框里 `@` 了人时不提供这种启动方式：见 test-composer-call-dom.mjs ④。
const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const created = [];
  const runs = [];
  const candidateQueries = [];
  const archived = new Set();
  let conflictB = false;
  let refuseCreate = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let data = [];
    let status = 200;
    if (path === "/api/agents") data = [{ id: "exec-claude", name: "claude@cpa", type: "claude", model: "claude-opus-4.6", reasoningEffort: "high", providerId: "provider-cpa", isDefault: true }];
    if (path === "/api/llm-providers") data = [{ id: "provider-cpa", name: "CPA 中转", protocol: "anthropic", baseUrl: "https://example.invalid", model: "claude-opus-4.6", protocolConversionEnabled: false, modelListMode: "pinned", pinnedModels: ["claude-opus-4.6"], context1mModels: [], hasKey: true, createdAt: "2026-09-07T00:00:00.000Z" }];
    if (path === "/api/settings") data = { defaultWorkflowId: null };
    if (path.endsWith("/branches")) data = { branches: ["main", "develop"], current: "main" };
    if (path === "/api/projects/p1/prerequisite-candidates") {
      const selected = (url.searchParams.get("selected") ?? "").split(",").filter(Boolean);
      candidateQueries.push({ useWorktree: url.searchParams.get("useWorktree"), selected });
      const picked = selected.length > 0;
      // 照服务端判据：不用 worktree 时，代码还在分支上的甲、乙拿不到（面板按项目默认去问就会被这样判）。
      const worktree = url.searchParams.get("useWorktree") === "1";
      const branchOnly = worktree ? null : "代码在它的分支上，不用 worktree 拿不到";
      const own = (problem, step, round = null) => ({ problem, conflict: false, step: problem ? null : step, round: problem ? null : round });
      data = {
        locked: null, removable: true, mergeTargetBranch: picked && worktree ? "main" : null,
        candidates: [
          { taskId: "t-a", title: "前置甲", groupId: null, ...own(branchOnly, "running") },
          { taskId: "t-b", title: "前置乙", groupId: null, ...(conflictB && worktree && !archived.has("t-b")
            ? { problem: "合入 develop，不是 main", conflict: true, step: null, round: null }
            : own(archived.has("t-b") ? "已归档" : branchOnly, "reviewing", 1)) },
          { taskId: "t-team", title: "常驻团队任务", groupId: null, ...own("团队任务") },
          { taskId: "t-other", title: "别的分支任务", groupId: null, ...(picked && worktree
            ? { problem: "合入 other，不是 main", conflict: true, step: null, round: null } : own(null, "not_started")) },
        ],
      };
    }
    if (path === "/api/tasks" && request.method() === "POST") {
      if (refuseCreate) {
        status = 400;
        data = { error: "「前置甲」已经直接或间接建在「新任务」上面，再反过来就成环了" };
      } else {
        const body = request.postDataJSON();
        created.push(body);
        data = { ...body, id: "task-1", status: "backlog", title: body.body, prerequisites: undefined };
      }
    }
    if (path === "/api/tasks/task-1/run" && request.method() === "POST") {
      runs.push(path);
      status = 202;
      data = { started: false, waiting: true, blocked: false, reason: "在等前置：「前置甲」在跑；「前置乙」在审第 1 轮" };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(`${web.origin}/scripts/fixtures/composer-upload.html?repo`);
  const objective = page.getByRole("textbox", { name: "任务目标" });
  const openLaunch = () => page.getByRole("button", { name: /^启动设置：/ }).click();
  const space = page.getByRole("button", { name: /^工作目录：/ });
  const sendKey = page.getByRole("button", { name: "创建并等前置", exact: true });
  const blockedReason = () => page.locator(".studio-card .send-key-main").evaluate((element) =>
    document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
  const notices = () => page.getByTestId("notices").innerText();
  const picked = page.locator(".composer-prereq-list > li");
  const row = (text) => page.locator(".ui-dropdown-row", { hasText: text });
  const worktreeOn = async () => {
    await space.click();
    const panel = page.getByRole("dialog", { name: "工作目录", exact: true });
    if (await panel.getByRole("switch").getAttribute("aria-checked") !== "true") await panel.locator(".composer-toggle-field > span").click();
    await page.keyboard.press("Escape");
  };

  await objective.fill("建在两条上面");
  await page.getByRole("button", { name: /^智能体：/ }).waitFor();
  await worktreeOn();
  await openLaunch();
  await page.getByRole("radio", { name: "创建并等前置" }).click();
  assert.match(await page.getByRole("radio", { name: "创建并等前置" }).innerText(), /前置审查通过后自动开始，带着它们的代码/);
  assert.match(await page.getByRole("radio", { name: "创建并排队" }).innerText(), /轮到它时自动开始/, "排队那一档照旧");
  assert.equal(await sendKey.getAttribute("aria-disabled"), "true", "一条前置都没选：点不动");
  assert.match(await blockedReason(), /选择要建在哪几条任务上面/, "说得出差什么");
  await page.locator(".composer-prerequisites .ui-select-trigger").click();
  assert.match(await row("常驻团队任务").getAttribute("class"), /is-disabled/, "团队任务置灰");
  assert.match(await row("常驻团队任务").innerText(), /团队任务/, "右边写原因");
  assert.match(await row("前置甲").innerText(), /在跑/, "能选的写它此刻到哪一步了");
  assert.doesNotMatch(await row("别的分支任务").getAttribute("class"), /is-disabled/, "还没选：哪条分支都行");
  await row("前置甲").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".ui-dropdown-row")]
    .some((element) => element.textContent?.includes("别的分支任务") && element.className.includes("is-disabled")));
  assert.match(await row("别的分支任务").innerText(), /合入 other，不是 main/, "合入别的分支的不能跟它选到一起");
  await row("前置乙").click();
  await page.keyboard.press("Escape");
  assert.equal(await picked.count(), 2);
  assert.match(await picked.nth(1).innerText(), /前置乙[\s\S]*在审第 1 轮/);
  assert.ok(candidateQueries.some((query) => query.useWorktree === "1" && query.selected.join() === "t-a,t-b"), "按选的先后、带着工作目录选择去问");
  await page.keyboard.press("Escape");
  assert.equal(await sendKey.count(), 1, "发送键跟着这一种启动方式写字");

  await space.click();
  const directory = page.getByRole("dialog", { name: "工作目录", exact: true });
  const baseButton = directory.getByRole("button", { name: /^base 分支/ });
  assert.equal(await baseButton.isDisabled(), true, "起点按前置定：base 分支不让选");
  assert.match(await baseButton.innerText(), /跟着前置走/);
  assert.match(await directory.getByRole("button", { name: /^合入分支/ }).innerText(), /main/, "合入分支跟着前置走");
  assert.match(await space.getAttribute("aria-label"), /跟着前置走/);
  await page.keyboard.press("Escape");

  // 草稿记得启动方式、已选的前置和这次的工作目录选择（项目默认是项目目录、这次改成了 worktree）：
  // 重开后两条都还在，不会按项目默认去判、把本来能选的当成失效去掉。
  const asked = candidateQueries.length;
  await page.getByTestId("reopen").click();
  await sendKey.waitFor();
  assert.match(await space.getAttribute("aria-label"), /独立 worktree/, "工作目录选择随草稿回来");
  await openLaunch();
  await page.waitForFunction(() => document.querySelectorAll(".composer-prereq-list em:not(:empty)").length === 2);
  assert.equal(await picked.count(), 2, "本来能选的前置一条不丢");
  assert.ok(candidateQueries.slice(asked).every((query) => query.useWorktree === "1"), "恢复后按草稿里的工作目录去问");
  await page.keyboard.press("Escape");
  assert.doesNotMatch(await notices(), /已去掉/);

  // 恢复时只是跟别的已选项合入分支对不上的不去掉：标出原因、发送键挡住，留哪条由用户定。
  conflictB = true;
  await page.getByTestId("reopen").click();
  await sendKey.waitFor();
  await page.waitForFunction(() => document.getElementById(document.querySelector(".studio-card .send-key-main")?.getAttribute("aria-describedby") ?? "")?.textContent?.includes("合入 develop"));
  assert.match(await blockedReason(), /「前置乙」合入 develop，不是 main/);
  assert.doesNotMatch(await notices(), /已去掉/, "对不上的不算失效");
  conflictB = false;

  // 恢复时自己就不能选的那条被去掉。
  archived.add("t-b");
  await page.getByTestId("reopen").click();
  await page.getByText(/草稿里的前置「前置乙」已经不能选了，已去掉/).waitFor();
  assert.equal(await objective.inputValue(), "建在两条上面");
  await sendKey.waitFor();
  await worktreeOn();
  await openLaunch();
  assert.equal(await picked.count(), 1);
  assert.match(await picked.first().innerText(), /前置甲/);
  archived.delete("t-b");
  await page.locator(".composer-prerequisites .ui-select-trigger").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".ui-dropdown-row")]
    .some((element) => element.textContent?.includes("前置乙") && !element.className.includes("is-disabled")));
  await row("前置乙").click();
  await page.keyboard.press("Escape");
  // 单独去掉一条，再加回来。
  await page.getByRole("button", { name: "去掉前置：前置乙" }).click();
  assert.equal(await picked.count(), 1);
  await page.locator(".composer-prerequisites .ui-select-trigger").click();
  await row("前置乙").click();
  await page.keyboard.press("Escape");
  assert.equal(await picked.count(), 2);
  await page.keyboard.press("Escape");

  // 服务端拒绝：原样显示原因，写的东西不丢。
  refuseCreate = true;
  await page.waitForFunction(() => document.querySelector(".studio-card .send-key-main")?.getAttribute("aria-disabled") !== "true");
  await sendKey.click();
  await page.getByText(/成环了/).waitFor();
  assert.equal(await objective.inputValue(), "建在两条上面", "被拒时正文还在");
  assert.equal(created.length, 0);
  assert.equal(await sendKey.count(), 1, "被拒时启动方式和前置还在");
  refuseCreate = false;

  await sendKey.click();
  await page.getByTestId("created").getByRole("listitem").waitFor();
  assert.equal(created.length, 1, "一次建任务请求");
  assert.deepEqual(created[0].prerequisites, ["t-a", "t-b"], "两条前置随建任务一起写进去");
  assert.equal(created[0].worktreeBase, null, "起点不由面板定");
  assert.equal(created[0].mergeTargetBranch, "main");
  assert.equal(created[0].useWorktree, true);
  assert.deepEqual(runs, ["/api/tasks/task-1/run"], "建好之后要求运行");
  await page.getByText(/任务已建好，等「前置甲」「前置乙」站稳后自动开始/).waitFor();
  assert.doesNotMatch(await notices(), /启动失败/, "在等前置不是启动失败");

  // 窄屏：浮层里那几行不横向溢出。
  await page.setViewportSize({ width: 360, height: 800 });
  await openLaunch();
  await page.getByRole("radio", { name: "创建并等前置" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "页面不横向溢出");

  assert.deepEqual(errors, []);
  console.log("composer prerequisites: launch mode, candidates, merge target follow, draft restore, refusal, one-request create and waiting notice passed");
} finally {
  await browser?.close();
  await web.close();
}
