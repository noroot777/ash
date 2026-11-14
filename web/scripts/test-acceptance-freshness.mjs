import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 验收台上的事实**属于哪一版**、读失败时**出路在哪一行**。钉的是第 1 轮审查拦下的几条：
//
// ① 走向与 diff 跟着任务版本走（useVersionedRead）。同一个任务更新了（合入目标换了、新提交），
//    这一版又读不回来：顶行不许还摆着上一版的走向（确认层合的是新目标），diff 区明说「下面是上一版」
//    并给本行重试；重试读到了，顶行换成这一版的目标。
// ② 保留着旧结论的那几行重读失败时（这里是子任务合入时的工作区那一行）：结论照旧摆着，但状态换成
//    「待核对」并给本行重试 —— 删掉常驻刷新之后，这就是唯一的补救。
// ③ 「合并后不提交」那一行自己对账：用户在终端里提交了，窗口回到前台时那一行就收掉；重读失败时
//    旧现场照旧摆着，但说出来并给本行重试。
// ④ 从键下面点出来的那一层在矮窗口里整层收进视口：滚到底，确认键在屏幕里按得到。
// ⑤ 团队验收台打回之后回到能看见那句话的对话：团队回调度台，独立执行者回它自己的会话。
// ⑥ 动作成功之后的读取失败（taskFacts.ts / useRowRead.ts）：改了合入目标而任务读不回来，主按钮锁着、那一行
//    给重试；释放目录之后的核对读失败落在本行「待核对」，不跟着确认框一起消失。
// ⑦ 那一次任务读取一直不回来（第 3、4 轮审查）：主按钮转圈，退出再打开照样在等；宿主收到一份早于这次写入
//    的中间版本（比动作前新、目标还是旧的）不许放行；宿主收到更新的
//    快照时重发一次读取，由那一次的结果放行；再挂住一次，到期限转成「读取超时」并给重试，重试读到了才放开。
// ⑧ 确认层与一致性核对用的是**这一按真正合到的目标**（第 5 轮审查）：上次验收失败冻结了 main、配置目标为空、
//    项目检出换成了 other —— 顶行和 diff 按 other 算，验收会合到 main：拦住，且菜单里选 other 是一次真改动，
//    换完两处对齐才放开；配置为空、由服务端解析出目标时，确认层写的是解析出来的那个分支，不是「未确定」。
const web = await startWebServer();

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
const entry = (taskId, more = {}) => ({
  taskId, projectId: "proj-1", title: taskId, status: "done", stage: "awaiting_acceptance", startCommit: "0123456789abcdef",
  targetBranch: "main", sourceCommit: "1111111111111111", targetCommit: "2222222222222222", strategy: "merge",
  dependency: null, blocker: null, baseUpdatePending: false, fingerprint: `fp-${taskId}`, ...more,
});
const child = entry("child-task", { title: "子任务", targetTaskId: "single-task", targetBranch: "ash/single-task", stage: "awaiting_acceptance" });
const scm = (taskId) => ({
  root: { path: `/repo/.worktrees/${taskId}`, branch: `ash/${taskId}`, source: "worktree", gitRepo: true }, taskRunning: false, readOnly: null,
  acceptanceCommitBlock: null, acceptanceAutoCommit: { action: "skip", reason: "项目未开启验收前自动提交" },
  status: { branch: { head: `ash/${taskId}`, detached: false, oid: "abc", upstream: null, ahead: null, behind: null },
    staged: [], unstaged: [], untracked: [], merge: [], operation: null, truncated: false },
  commits: [],
});
const pendingState = (kind) => ({
  taskId: "pending-task", kind, message: kind === "staged" ? "合并结果还暂存在 main 上" : "已提交", repoPath: "/repo",
  targetBranch: "main", sourceBranch: "ash/pending-task", sourceBranchExists: true, commit: kind === "committed" ? "abcdef12" : null,
  stagedFiles: kind === "staged" ? ["a.ts"] : [], dirtyFiles: [], canCommit: kind === "staged", canRemerge: false,
});

function api(store) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const fail = () => reply({ error: "测试读取失败" }, 503);
    if (url.pathname === "/api/projects") {
      return reply([{ id: "proj-1", name: "harness", repoPath: "/repo", myRole: "admin", acceptGateCommand: null, acceptCommit: true }]);
    }
    if (url.pathname === "/api/tasks/bodies" && request.method() === "POST") {
      return reply(request.postDataJSON().taskIds.map((taskId) => ({ taskId, body: "" })));
    }
    if (url.pathname === "/api/projects/proj-1/branches") return reply({ branches: ["main", "other"], current: "main" });
    const post = /^\/api\/tasks\/([^/]+)\/(merge-target|release-workspace)$/.exec(url.pathname);
    if (post && request.method() === "POST") {
      // 换合入目标会清掉上次验收失败时冻结的目标（task-branch-routes.ts 同样这么做）。
      if (post[2] === "merge-target") { store.target = request.postDataJSON().branch; store.frozen = null; }
      else store.released = true;
      store.updatedAt = new Date().toISOString();
      return reply({ ok: true });
    }
    const reject = /^\/api\/tasks\/([^/]+)\/reply$/.exec(url.pathname);
    if (reject && request.method() === "POST") {
      store.replies.push(reject[1]);
      return reply({ ok: true });
    }
    const hit = /^\/api\/tasks\/([^/]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
    if (hit && request.method() === "GET") {
      const [, taskId, what] = hit;
      if (!what) {
        store.taskFetches[taskId] = (store.taskFetches[taskId] ?? 0) + 1;
        if (store.failTask === "hang") return new Promise(() => {});
        if (store.failTask) return fail();
        return reply({ id: taskId, title: taskId, projectId: "proj-1", status: "done", stage: "awaiting_acceptance", mode: "single",
          useWorktree: true, archived: false, updatedAt: store.updatedAt, ...(taskId === "single-task" ? { mergeTargetBranch: store.target } : {}) });
      }
      // 计划里的目标与验收同口径：上次验收失败冻结的目标（frozen）优先，否则是配置的那一个。
      if (what === "branch-plan") {
        return reply({ task: entry(taskId, taskId === "single-task" ? { targetBranch: store.frozen ?? store.target } : {}),
          descendants: taskId === "single-task" ? [child] : [] });
      }
      if (what === "accept-gate") return reply({ command: null, running: null, latest: null, basis: null });
      if (what === "acceptance-check") return reply({ verification: null });
      if (what === "scm") return reply(scm(taskId));
      if (what === "sessions") return reply([]);
      if (what === "workspace") {
        return store.failWorkspace ? fail() : reply({ path: store.released ? null : `/repo/.worktrees/${taskId}`, branch: `ash/${taskId}` });
      }
      if (what === "pending-merge") return store.failPending ? fail() : reply({ state: pendingState(store.pending) });
      if (what === "commits") {
        return store.failChanges ? fail() : reply({ branch: `ash/${taskId}`, commits: [{ sha: "1111111111111111", subject: "feat", at: "2026-11-02T01:20:00.000Z" }] });
      }
      if (what === "diff") {
        return store.failChanges ? fail() : reply({ available: true, sourceBranch: `ash/${taskId}`, targetBranch: store.target, mergeBase: "0123456789abcdef",
          diff: DIFF, files: [{ path: "a.ts", additions: 1, deletions: 1, origPath: null }], truncated: false, limitBytes: 1048576 });
      }
    }
    store.unexpected.push(`${request.method()} ${url.pathname}`);
    return reply({ error: "验证页面拒绝未声明的请求" }, 404);
  };
}

const freshStore = () => ({ target: "main", frozen: null, updatedAt: "2026-11-02T01:24:00.000Z", failChanges: false, failWorkspace: false, failPending: false, failTask: false, released: false, pending: "staged",
  replies: [], taskFetches: {}, unexpected: [] });

let browser;
try {
  const fixture = `${web.origin}/scripts/fixtures/acceptance-freshness.html`;
  browser = await launchChrome();

  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const store = freshStore();
    await page.route((url) => url.pathname.startsWith("/api/"), api(store));
    await page.goto(fixture);
    const single = page.locator('[data-host="single"]');
    const route = single.locator(".acc-bar .acc-route");
    const release = single.locator('.acc-check[data-check="release"]');
    await route.locator(".acc-target, .acc-dst").filter({ hasText: "main" }).waitFor();
    await release.filter({ hasText: "工作区目录还占着它" }).waitFor();

    // ① 同一个任务换了合入目标、改动这一版读不回来。
    store.failChanges = true;
    store.failWorkspace = true;
    store.target = "other";
    await page.evaluate(() => window.bumpSingle({ mergeTargetBranch: "other" }));
    const lead = single.locator(".acc-bar .acc-lead-note").filter({ hasText: "改动读不出来" });
    await lead.waitFor();
    assert.equal(await route.count(), 0, "这一版读不回来时顶行不许摆上一版的走向");
    const note = single.locator(".acc-changes-note");
    await note.filter({ hasText: "下面是上一版" }).waitFor();
    assert.equal(await single.locator(".single-review-diff-region .acc-stale").count(), 1, "上一版的 diff 压暗摆着，不冒充当前");
    // ② 工作区那一行：旧结论还在，状态换成待核对，行尾有重试。
    await release.filter({ hasText: "待核对" }).waitFor();
    assert.equal(await release.getByRole("button", { name: "重试", exact: true }).count(), 1, "保留旧结论的那一行读失败要有本行重试");
    store.failWorkspace = false;
    await release.getByRole("button", { name: "重试", exact: true }).click();
    await release.filter({ hasText: "工作区目录还占着它" }).waitFor();
    assert.equal(await release.getByRole("button", { name: "重试", exact: true }).count(), 0);
    // ① 重试读到了：顶行换成这一版的目标，diff 不再压暗，那句话收掉。
    store.failChanges = false;
    await lead.getByRole("button", { name: "重试", exact: true }).click();
    await route.locator(".acc-target, .acc-dst").filter({ hasText: "other" }).waitFor();
    assert.equal(await note.count(), 0);
    assert.equal(await single.locator(".single-review-diff-region .acc-stale").count(), 0);

    // ③ 「合并后不提交」：重读失败 → 旧现场照旧 + 待核对 + 重试；终端里提交了 → 窗口回到前台就收掉，并刷新任务。
    const pending = page.locator('[data-host="pending"] .acc-check[data-check="pending-merge"]');
    await pending.filter({ hasText: "合并结果还没提交" }).waitFor();
    store.failPending = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await pending.filter({ hasText: "现场待核对" }).waitFor();
    assert.equal(await pending.filter({ hasText: "合并结果还没提交" }).count(), 1, "读失败时旧现场照旧摆着");
    store.failPending = false;
    await pending.getByRole("button", { name: "重试", exact: true }).click();
    await pending.filter({ hasNotText: "现场待核对" }).waitFor();
    store.pending = "committed";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await pending.waitFor({ state: "detached" });
    assert.ok((store.taskFetches["pending-task"] ?? 0) >= 1, "在页面之外收的尾，任务要跟着刷新（摘掉「待提交」）");

    // ⑥ 动作成功、紧接着的读取失败（第 2 轮审查）：
    //    改合入目标 → 任务读不回来：走向与 diff 照新版本重读（指向 other），主按钮锁着、那一行说清楚并给重试，
    //    重试读到了才放开 —— 确认层里的目标是从任务推出来的，旧任务不许拿去确认。
    const main = single.locator(".acc-bar button.acc-btn.is-primary");
    await page.waitForFunction(() => !document.querySelector('[data-host="single"] .acc-bar button.acc-btn.is-primary')?.disabled);
    store.failTask = true;
    await single.locator(".acc-target").click();
    await page.getByRole("menuitemradio", { name: "main" }).waitFor();
    store.target = "main";
    await page.getByRole("menuitemradio", { name: "main" }).click();
    await page.getByRole("menuitemradio", { name: "main" }).waitFor({ state: "detached" });
    const factsRow = single.locator('.acc-check[data-check="task-facts"]');
    await factsRow.filter({ hasText: "改动之后的任务状态没读到" }).waitFor();
    assert.equal(await main.isDisabled(), true, "任务没追平之前不许确认");
    await route.locator(".acc-target, .acc-dst").filter({ hasText: "main" }).waitFor();
    store.failTask = false;
    await factsRow.getByRole("button", { name: "重试", exact: true }).click();
    await factsRow.waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.querySelector('[data-host="single"] .acc-bar button.acc-btn.is-primary')?.disabled);

    //    释放目录成功 → 紧接着的核对读失败：确认框收掉，那一行说「待核对」并给重试，不再假装「还占着」。
    await release.getByRole("button", { name: "释放目录", exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: "释放工作区目录？" });
    await dialog.waitFor();
    store.failWorkspace = true;
    await dialog.getByRole("button", { name: "释放目录，保留分支", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await release.filter({ hasText: "待核对" }).waitFor();
    assert.equal(await release.getByRole("button", { name: "重试", exact: true }).count(), 1, "动作之后的核对失败要落在本行");
    store.failWorkspace = false;
    await release.getByRole("button", { name: "重试", exact: true }).click();
    await release.filter({ hasText: "工作区目录已释放" }).waitFor();

    // ⑤ 团队：打回调度台 → 回到调度台；打回独立执行者 → 回到它自己的会话。
    const team = page.locator('[data-host="team"]');
    for (const [bar, id] of [[team.locator(".acc-desk > .acc-bar"), "team-lead"], [team.locator(".acc-record > .acc-bar"), "indie-worker"]]) {
      await bar.getByRole("button", { name: "打回", exact: true }).click();
      const layer = page.getByRole("dialog", { name: "打回", exact: true });
      await layer.getByRole("textbox", { name: "打回意见" }).fill("再改一下");
      await layer.getByRole("button", { name: "发给任务", exact: true }).click();
      await page.waitForFunction((target) => window.returned.includes(target), id);
      assert.ok(store.replies.includes(id), `${id}：意见发给了它自己`);
    }
    assert.deepEqual(store.unexpected, [], "页面发了未声明的请求");
    assert.deepEqual(errors, [], "渲染报错");
    await page.close();
  }

  // ④ 矮窗口：确认层上下都放不下，整层收进视口；滚到底，确认键整颗在屏幕里。
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 150 } });
    const store = freshStore();
    await page.route((url) => url.pathname.startsWith("/api/"), api(store));
    await page.goto(fixture);
    const main = page.locator('[data-host="single"] .acc-bar button.acc-btn.is-primary');
    await page.locator('[data-host="single"] .acc-bar .acc-route').waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-host="single"] .acc-bar button.acc-btn.is-primary');
      return button && !button.disabled;
    });
    await main.click();
    const layer = page.getByRole("dialog", { name: "确认验收" });
    await layer.waitFor();
    await page.waitForTimeout(50);
    const box = await layer.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      const rect = node.getBoundingClientRect();
      const confirm = [...node.querySelectorAll("footer button")].find((button) => button.textContent.includes("确认验收"));
      const key = confirm.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight, scrollable: node.scrollHeight > node.clientHeight,
        key: { top: key.top, bottom: key.bottom } };
    });
    assert.ok(box.scrollable, `这个窗口高度下确认层本该放不下、要在层里滚（${JSON.stringify(box)}）`);
    assert.ok(box.top >= 0 && box.bottom <= box.viewport, `确认层越出了视口：${JSON.stringify(box)}`);
    assert.ok(box.key.top >= 0 && box.key.bottom <= box.viewport, `滚到底确认键仍在屏幕外：${JSON.stringify(box)}`);
    await page.close();
  }
  // ⑦ 挂住的任务读取。
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install();
    const store = freshStore();
    await page.route((url) => url.pathname.startsWith("/api/"), api(store));
    await page.goto(fixture);
    const single = page.locator('[data-host="single"]');
    const route = single.locator(".acc-bar .acc-route");
    const factsRow = single.locator('.acc-check[data-check="task-facts"]');
    const mainFree = () => page.waitForFunction(() => {
      const button = document.querySelector('[data-host="single"] .acc-bar button.acc-btn.is-primary');
      return button && !button.disabled;
    });
    const mainDisabled = () => single.locator(".acc-bar button.acc-btn.is-primary").isDisabled();
    const changeTarget = async (branch) => {
      store.target = branch;
      await single.locator(".acc-target").click();
      await page.getByRole("menuitemradio", { name: branch }).click();
      await page.getByRole("menuitemradio", { name: branch }).waitFor({ state: "detached" });
    };
    await route.locator(".acc-target, .acc-dst").filter({ hasText: "main" }).waitFor();
    await mainFree();

    store.failTask = "hang";
    await changeTarget("other");
    await route.locator(".acc-target, .acc-dst").filter({ hasText: "other" }).waitFor();
    assert.equal(await mainDisabled(), true, "任务没追平之前不许确认");
    await page.evaluate(() => window.remountSingle());
    await route.waitFor();
    await page.waitForTimeout(100);
    assert.equal(await mainDisabled(), true, "退出再打开，宿主手上还是旧任务：仍在等");
    // 一份早于这次写入的中间版本到了（比动作前新，目标还是 main）：它不覆盖这次写入，不许放行。
    const fetched = store.taskFetches["single-task"] ?? 0;
    await page.evaluate(() => window.bumpSingle({ mergeTargetBranch: "main", updatedAt: "2026-11-10T00:00:00.000Z" }));
    const mismatch = single.locator('.acc-check[data-check="target-mismatch"]');
    for (let i = 0; i < 100 && (store.taskFetches["single-task"] ?? 0) <= fetched; i += 1) await page.waitForTimeout(50);
    assert.ok((store.taskFetches["single-task"] ?? 0) > fetched, "宿主快照变新时要重发一次读取，由那一次结算");
    await page.waitForTimeout(200);
    assert.equal(await mainDisabled(), true, "中间版本不许放开确认");
    // 网络恢复，宿主又收到一份更新的快照：重发的那一次读到了，才放开。
    store.failTask = false;
    await page.evaluate(() => window.bumpSingle({ mergeTargetBranch: "other" }));
    await mainFree();
    assert.equal(await factsRow.count(), 0);
    assert.equal(await mismatch.count(), 0);
    store.failTask = "hang";

    // 再挂住一次：到期限转成读失败，那一行给重试；重试读到了才放开。
    await changeTarget("main");
    await route.locator(".acc-target, .acc-dst").filter({ hasText: "main" }).waitFor();
    assert.equal(await mainDisabled(), true);
    await page.clock.fastForward(15_001);
    await factsRow.filter({ hasText: "读取超时" }).waitFor();
    assert.equal(await mainDisabled(), true, "读失败时主按钮仍锁着");
    store.failTask = false;
    await factsRow.getByRole("button", { name: "重试", exact: true }).click();
    await factsRow.waitFor({ state: "detached" });
    await mainFree();
    assert.deepEqual(store.unexpected, [], "页面发了未声明的请求");
    assert.deepEqual(errors, [], "渲染报错");
    await page.close();
  }

  // ⑧ 冻结目标 + 空配置目标。
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const store = freshStore();
    store.frozen = "main";
    store.target = "other";
    await page.route((url) => url.pathname.startsWith("/api/"), api(store));
    await page.goto(fixture);
    const single = page.locator('[data-host="single"]');
    const route = single.locator(".acc-bar .acc-route");
    const main = single.locator(".acc-bar button.acc-btn.is-primary");
    const mismatch = single.locator('.acc-check[data-check="target-mismatch"]');
    await page.evaluate(() => window.bumpSingle({ mergeTargetBranch: null, worktreeBase: null, acceptedTargetBranch: "main" }));
    await route.locator(".acc-target, .acc-dst").filter({ hasText: "other" }).waitFor();
    await mismatch.filter({ hasText: "改动按 other 算，验收会合到 main" }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(await main.isDisabled(), true, "顶行与实际验收目标对不上时不许确认");
    // 菜单里勾着的是真正要合到的 main；选 other 是一次真改动，服务端清掉冻结的目标。
    await single.locator(".acc-target").click();
    assert.equal(await page.getByRole("menuitemradio", { name: "main" }).getAttribute("aria-checked"), "true");
    await page.getByRole("menuitemradio", { name: "other" }).click();
    await page.getByRole("menuitemradio", { name: "other" }).waitFor({ state: "detached" });
    assert.equal(store.frozen, null, "选 other 要真发出去");
    await mismatch.waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.querySelector('[data-host="single"] .acc-bar button.acc-btn.is-primary')?.disabled);
    // 配置目标为空、由服务端解析：确认层写解析出来的分支。
    await page.evaluate(() => window.bumpSingle({ mergeTargetBranch: null, worktreeBase: null, acceptedTargetBranch: null }));
    await page.waitForFunction(() => !document.querySelector('[data-host="single"] .acc-bar button.acc-btn.is-primary')?.disabled);
    await main.click();
    const layer = page.getByRole("dialog", { name: "确认验收" });
    await layer.waitFor();
    assert.match(await layer.innerText(), /→\s*other/, "确认层写的是这一按真正合到的分支");
    assert.doesNotMatch(await layer.innerText(), /未确定/);
    assert.deepEqual(store.unexpected, [], "页面发了未声明的请求");
    assert.deepEqual(errors, [], "渲染报错");
    await page.close();
  }

  console.log("acceptance freshness: versioned route/diff with stale marking and retry, stale rows keep a retry, pending merge reconciles on focus, short-window layers stay in view, team rejections return to the conversation, a hung task read is only released by a read issued after the write (an intermediate snapshot keeps it locked) or times out into a retry, the confirm layer and the route check use the target this acceptance really merges into");
} finally {
  await browser?.close();
  await web.close();
}
