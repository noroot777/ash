import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 「信息」格加减前置（task-detail/info/InfoPrerequisites.tsx）：
// - 还没开工的任务：「前置」那一组下面一颗「建在某任务上面…」，候选照服务端置灰写原因；选一条加一条；
// - 每一行指到时出一颗叉，键盘也够得着，读屏念「去掉前置：某某」；去掉一条；
// - 加、减之后这几行、会话里「在等谁」、侧栏的画法不用刷新就跟着变；被拒时原样显示服务端那句；
// - 起点已定的任务：没有加的下拉，也没有叉；
// - 头一次读候选失败时不当成「不能改」：写明读不到、给一颗重试，重试成功后入口回来。
const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const link = (taskId, title, step) => ({ taskId, title, step, round: null, movedOn: false });
  const snapshot = (revision, prerequisites) => ({
    id: "t-sub", title: "下游任务", body: "下游任务", projectId: "p1", parentId: null, archived: false, mode: "single", groupId: null,
    queueId: null, queuePosition: null, status: "backlog", agentType: "claude", labels: [], createdAt: "2026-11-15T06:00:00.000Z",
    updatedAt: "2026-11-15T06:00:00.000Z", backgroundRevision: revision,
    prerequisites: { prerequisites, dependents: [], waiting: true, blocked: null, launched: false },
  });
  let candidatesDown = true;
  const adds = [];
  const removes = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let data = [];
    let status = 200;
    if (path.endsWith("/commits")) data = { branch: null, commits: [] };
    if (path.endsWith("/diff")) data = { available: false, files: [], sourceBranch: null };
    if (path === "/api/projects/p1/prerequisite-candidates" && candidatesDown) {
      status = 503;
      data = { error: "服务暂时不可用" };
    } else if (path === "/api/projects/p1/prerequisite-candidates") {
      data = url.searchParams.get("taskId") === "t-started"
        ? { locked: "「已开工的任务」已经开工，起点定下来之后不能再改前置", removable: false, mergeTargetBranch: null, candidates: [] }
        : { locked: null, removable: true, mergeTargetBranch: "main", candidates: [
          { taskId: "t-a", title: "前置甲", groupId: null, problem: removes.length ? null : "已经是前置", step: removes.length ? "running" : null, round: null },
          { taskId: "t-b", title: "前置乙", groupId: null, problem: adds.includes("t-b") ? "已经是前置" : null, step: adds.includes("t-b") ? null : "running", round: null },
          { taskId: "t-c", title: "前置丙", groupId: null, problem: null, step: "not_started", round: null },
          { taskId: "t-team", title: "常驻团队任务", groupId: null, problem: "团队任务", step: null, round: null },
        ] };
    }
    if (path === "/api/tasks/t-sub/prerequisites" && request.method() === "POST") {
      const { prerequisiteId } = request.postDataJSON();
      if (prerequisiteId === "t-c") {
        status = 400;
        data = { error: "「前置丙」已经直接或间接建在「下游任务」上面，再反过来就成环了" };
      } else {
        adds.push(prerequisiteId);
        data = snapshot(2, [link("t-a", "前置甲", "running"), link("t-b", "前置乙", "running")]);
      }
    }
    if (path === "/api/tasks/t-sub/prerequisites/t-a" && request.method() === "DELETE") {
      removes.push("t-a");
      data = snapshot(3, [link("t-b", "前置乙", "running")]);
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  });

  await page.goto(`${web.origin}/scripts/fixtures/inspector-prerequisites.html`);
  const add = page.locator(".task-inspector-prerequisite-add");
  const wait = page.getByTestId("wait");
  const row = (text) => page.locator(".ui-dropdown-row", { hasText: text });
  const removeA = page.getByRole("button", { name: "去掉前置：前置甲" });
  // 头一次读候选失败：不是「不能改」，写明读不到、给一颗重试；重试成功后加减入口回来。
  const retry = page.getByRole("button", { name: "重试", exact: true });
  await retry.waitFor();
  assert.match(await page.locator(".task-inspector").innerText(), /读不到能不能改前置/);
  assert.equal(await add.count(), 0);
  candidatesDown = false;
  await retry.click();
  await add.waitFor();
  assert.equal(await retry.count(), 0, "读到之后失败那一行撤掉");
  assert.match(await wait.innerText(), /在等\s*「前置甲」/);
  assert.equal(await page.getByTestId("look").innerText(), "waiting");

  // 叉平时不占眼：指到这一行才出。
  assert.equal(await removeA.evaluate((element) => getComputedStyle(element).opacity), "0", "叉指到才出");
  await removeA.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="去掉前置：前置甲"]')).opacity === "1");

  // 加一条：候选照服务端置灰写原因，能选的写它到哪一步了。
  await add.locator(".ui-select-trigger").click();
  assert.match(await row("前置甲").getAttribute("class"), /is-disabled/);
  assert.match(await row("前置甲").innerText(), /已经是前置/);
  assert.match(await row("常驻团队任务").innerText(), /团队任务/);
  assert.match(await row("前置乙").innerText(), /在跑/);
  await row("前置乙").click();
  await page.getByText(/已建在「前置乙」上面/).waitFor();
  assert.deepEqual(adds, ["t-b"]);
  await page.getByRole("button", { name: "打开「前置乙」" }).waitFor();
  assert.match(await wait.innerText(), /前置甲[\s\S]*前置乙/, "会话里「在等谁」跟着变");
  await page.keyboard.press("Escape");

  // 被拒：原样显示服务端那句，几行不变。
  await add.locator(".ui-select-trigger").click();
  await row("前置丙").click();
  await page.getByText(/成环了/).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: /^打开「前置/ }).count(), 2);

  // 减一条：键盘走到那颗叉，回车。
  await removeA.focus();
  // 键盘走到也出（等淡入放完）。
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="去掉前置：前置甲"]')).opacity === "1");
  await page.keyboard.press("Enter");
  await page.getByText(/已去掉前置「前置甲」/).waitFor();
  assert.deepEqual(removes, ["t-a"]);
  await page.getByRole("button", { name: "打开「前置甲」" }).waitFor({ state: "detached" });
  assert.doesNotMatch(await wait.innerText(), /前置甲/, "会话里那一行不再等它");
  assert.match(await wait.innerText(), /前置乙/);

  // 起点已定的：没有加减入口。
  await page.getByTestId("pick-started").click();
  await page.getByRole("button", { name: "打开「前置甲」" }).waitFor();
  await page.waitForTimeout(200);
  assert.equal(await add.count(), 0, "开工后不出「建在某任务上面」");
  assert.equal(await page.getByRole("button", { name: /^去掉前置：/ }).count(), 0, "开工后不出叉");

  assert.deepEqual(errors, []);
  console.log("inspector prerequisites: add, remove, refusal, live sync and locked task passed");
} finally {
  await browser?.close();
  await web.close();
}
