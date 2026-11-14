import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 验收台前提列里「N 个文件未提交」那一行（web/src/acceptance/WorkspaceCheck.tsx）。
const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/api/events", route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = `${web.origin}/scripts/fixtures/page-interactions.html`;
  const row = page.locator('[data-check="workspace"]');
  const submit = row.getByRole("button", { name: "提交", exact: true });
  const state = row.locator(".acc-check-state");
  const detail = async () => {
    const toggle = row.locator("button.acc-check-main");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    return row.locator(".acc-check-detail").innerText();
  };
  for (const scenario of ["running", "disabled", "shared"]) {
    await page.goto(`${fixture}?scenario=${scenario}`);
    await submit.waitFor();
    assert.equal(await submit.isDisabled(), true, scenario);
    // 禁用不是正在提交：没有转圈、没有 aria-busy，这一行仍是琥珀提醒（不是红的读失败）。
    assert.equal(await row.locator(".acc-spin").count(), 0, "禁用不是正在提交");
    assert.equal(await submit.getAttribute("aria-busy"), null);
    assert.match(await row.getAttribute("class"), /is-warn/);
    assert.match(await row.locator(".acc-check-text").innerText(), /^2 个文件未提交$/);
    const files = await detail();
    assert.match(files, /src\/app\.tsx/);
    assert.match(files, /notes\.md/);
    if (scenario === "running") {
      assert.match(await state.innerText(), /任务还在跑，结束后再提交/);
      assert.match(files, /运行/, "展开层说清为什么不能提交");
      assert.doesNotMatch(await row.innerText(), /会先提交|预检通过/);
    }
    if (scenario === "shared") {
      assert.match(await state.innerText(), /验收时不会替你提交：此任务共用项目目录/);
      assert.match(files, /共用项目目录/);
      assert.doesNotMatch(await row.innerText(), /设置.*开启|预检通过/);
    }
    if (scenario === "disabled") assert.match(await state.innerText(), /预检通过/, "可提交时照抄服务端预检");
  }

  await page.goto(`${fixture}?scenario=outcome`);
  await page.locator('[data-check="workspace"]').waitFor();
  await page.locator("button.acc-btn.is-primary:enabled:not([aria-busy])").filter({ hasText: "验收通过" }).click();
  await page.getByRole("dialog", { name: "确认验收" }).getByRole("button", { name: "确认验收", exact: true }).click();
  const outcome = page.locator('[data-check="auto-commit"]');
  await outcome.waitFor();
  assert.match(await outcome.innerText(), /已跳过验收前自动提交：此任务共用项目目录/);
  await page.getByTestId("result").filter({ hasText: "已跳过验收前自动提交" }).waitFor();
  assert.match(await page.getByTestId("result").innerText(), /验收通过；已跳过验收前自动提交/);
  await page.locator(".acc-done").filter({ hasText: "已验收" }).waitFor();

  // 读不出来：红行 + 它自己的「重试」，重试成功后回到清单。
  await page.goto(`${fixture}?scenario=unreadable`);
  await row.filter({ hasText: "未提交改动读不出来" }).waitFor();
  assert.match(await row.getAttribute("class"), /is-block/);
  assert.match(await state.innerText(), /磁盘忙/);
  await row.getByRole("button", { name: "重试", exact: true }).click();
  await row.filter({ hasText: "2 个文件未提交" }).waitFor();
  assert.equal(await row.getByRole("button", { name: "重试", exact: true }).count(), 0);

  // 按下「提交」那一刻再读一遍 /scm，提交的是那时的清单（多出来的 late.txt 也在），走验收提交那条路。
  await page.goto(`${fixture}?scenario=fresh`);
  await row.filter({ hasText: "2 个文件未提交" }).waitFor();
  await page.evaluate(() => { window.scmRequests.length = 0; });
  await submit.click();
  await page.getByTestId("result").filter({ hasText: "任务改动已提交" }).waitFor();
  const requests = await page.evaluate(() => window.scmRequests);
  const commitAt = requests.findIndex(request => request.method === "POST");
  assert.ok(commitAt > 0, `提交之前必须先读一遍工作区：${JSON.stringify(requests)}`);
  assert.deepEqual(requests.slice(0, commitAt).map(request => `${request.method} ${request.path}`), ["GET /api/tasks/demo/scm"]);
  assert.equal(requests[commitAt].path, "/api/tasks/demo/scm/acceptance-commit");
  const body = JSON.parse(requests[commitAt].body);
  assert.deepEqual([...body.stagePaths].sort(), ["late.txt", "notes.md", "src/app.tsx"]);
  assert.equal(body.acceptance, true);
  assert.match(body.message, /改进页面交互/);
  await row.waitFor({ state: "hidden" });

  await page.clock.install();
  await page.goto(`${fixture}?scenario=failure`);
  await submit.waitFor();
  await submit.click();
  await row.and(page.locator(".is-block")).waitFor();
  assert.match(await state.innerText(), /配置 Git 用户信息/);
  assert.equal(await submit.isEnabled(), true, "失败后还能再点一次");
  await page.evaluate(() => {
    const original = window.fetch;
    window.scmPolls = 0;
    window.fetch = async (...args) => {
      if (String(args[0]).endsWith("/tasks/demo/scm")) window.scmPolls += 1;
      return original(...args);
    };
  });
  // 15 秒一次的轮询成功了也不能把提交失败的原因冲掉（读两轮）。
  await page.clock.fastForward(15_001);
  await page.waitForFunction(() => window.scmPolls > 0);
  assert.match(await state.innerText(), /配置 Git 用户信息/, "成功轮询不能清除提交失败原因");
  await page.clock.fastForward(15_001);
  await page.waitForFunction(() => window.scmPolls > 1);
  assert.match(await state.innerText(), /配置 Git 用户信息/);
  assert.match(await row.getAttribute("class"), /is-block/);
  await submit.click();
  await page.getByTestId("result").filter({ hasText: "任务改动已提交" }).waitFor();
  await row.waitFor({ state: "hidden" });
  assert.equal(await page.locator('.acc-check.is-block').count(), 0, "成功重试后清除提交错误");
  assert.deepEqual(errors, []);
  console.log("acceptance workspace DOM: shared scope, disabled vs busy, unreadable retry, fresh re-read before commit, persistent failure across polling and successful retry passed");
} finally {
  await browser?.close();
  await web.close();
}
