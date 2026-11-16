import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 验收台（AcceptanceControls）的几何：一行决定、一列前提，其余全是 diff。钉的是一条契约，
// 不是某一张卡的特例：
//
// ① **宿主同一副形状**。单任务验收台、团队顶栏、团队里每个独立执行者的记录头、讨论结论那一条、
//    工作流侧栏那道「等我点头」，都是一行 `.acc-bar`（左 lead、右动作）加一列 `.acc-checks`。
//    修一处漏三处是这类毛病反复回来的原因，所以五处一起量。
// ② **主按钮上永远只写动作名**。挡住它的原因各自一行，摆在前提列里；按钮宽度在读取中（转圈）
//    和受阻之后一样宽，也和没受阻的那颗一样宽。2026-11-02（任务 9tdMZpxobLQT）现场就是整句
//    受阻理由被填进主按钮，把标题挤成逐字竖排、整条顶栏撑到几百像素高。
// ③ **标题永远读得出来，长文案只换行不撑宽**。lead 有地板宽、自己只占一行；前提列里很长的
//    blocker / 依赖消息（含一串没有空格的路径）在窄容器里折行，任何一层都不出横向滚动。
//    浅色、深色各量一遍（深色只换变量，但别让哪条规则只写在一边）。
// ④ **diff 紧跟在决定下面**。合并预览撞冲突时前提列里是「前置命令」「与 main 冲突」两行，
//    diff 区离验收台顶端不超过 150px（宽屏下连 diff 的第一个可见元素也在 150px 以内）。
// ⑤ 旧验收台那一摞（「改动与提交」标题、分支条、「派生与验收」卡、验收快照卡、门禁卡和它的
//    「这次跳过它，直接合并」「重跑一次」「刷新依赖」「重新核对」）确实不在了。
const web = await startWebServer();

const LONG_BLOCKER = "父任务「重写验收台」的分支还没合入 main，本任务基于它开工：web/src/acceptance/AcceptanceControls.tsx/web/src/acceptance/DependencyChecks.tsx/web/src/acceptance/CheckRow.tsx 这几处改动都还没进目标分支，请先验收父任务，或把开工起点改到 main 之后重新跑一遍再来验收。";
const LONG_DEP = "等父任务「验收台精简样机」先验收：它的成果还没合进 main，这一按会把它的提交一起带进去；ash/l7nJ0-ITgdY9-acceptance-page-redesign-mockup-with-a-very-long-branch-name 合入后这一行会自己变绿。";
const GATE_COMMAND = "npm -w web run build && node scripts/test-acceptance-host-layout.mjs && node scripts/test-free-workflow-inspector.mjs --reporter=verbose";
const GONE_TEXT = ["改动与提交", "派生与验收", "验收快照", "这次跳过它，直接合并", "重跑一次", "刷新依赖", "重新核对"];
const GONE_SELECTORS = [".review-meta-bar", ".accepted-snapshot-card", ".branch-acceptance-panel", ".accept-gate-card", ".acceptance-host", ".team-accept-actions"];
const ACTION = "验收通过";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n export { a, b };\n";
const entry = (taskId, more = {}) => ({
  taskId, projectId: "proj-1", title: taskId, status: "done", stage: "awaiting_acceptance", startCommit: "0123456789abcdef",
  targetBranch: "main", sourceCommit: "1111111111111111", targetCommit: "2222222222222222", strategy: "merge",
  dependency: null, blocker: null, baseUpdatePending: false, fingerprint: `fp-${taskId}`, ...more,
});
const waiting = { taskId: "parent-1", title: "验收台精简样机", state: "waiting", message: LONG_DEP };
const PLANS = {
  "single-task": entry("single-task", { blocker: LONG_BLOCKER, dependency: waiting }),
  "conflict-task": entry("conflict-task"),
  "team-lead": entry("team-lead", { dependency: waiting }),
  "indie-worker": entry("indie-worker", { blocker: LONG_BLOCKER }),
  "duet-task": entry("duet-task", { blocker: LONG_BLOCKER }),
  "wf-task": entry("wf-task", { dependency: waiting }),
};
const gateOf = (taskId) => ({
  command: taskId === "single-task" ? GATE_COMMAND : taskId === "conflict-task" ? "npm test" : null,
  running: null, latest: null, basis: null,
  ...(taskId === "conflict-task" ? { baselineIssue: { reason: "merge_conflict", targetBranch: "main", conflictFiles: ["a.ts"], handoff: null } } : {}),
});
const change = (path) => ({ path, status: "M" });
const scmOf = (taskId) => ({
  root: { path: `/repo/.worktrees/${taskId}`, branch: `ash/${taskId}`, source: "worktree", gitRepo: true }, taskRunning: false, readOnly: null,
  acceptanceCommitBlock: null,
  acceptanceAutoCommit: { action: "skip", reason: "工作目录里有不归这个任务管的文件（嵌套仓库 vendor/very-long-nested-repository-name），验收时不会替你提交" },
  status: {
    branch: { head: `ash/${taskId}`, detached: false, oid: "abc", upstream: null, ahead: null, behind: null },
    staged: [], untracked: [], merge: [], operation: null, truncated: false,
    // 只有单任务那张台子工作区是脏的：多出一行琥珀的「N 个文件未提交」，状态那半句是一长串预检理由。
    unstaged: taskId === "single-task" ? [change("web/src/a.ts"), change("web/src/b.ts"), change("web/src/c.ts")] : [],
  },
  commits: [],
});

/** 一次页面装载的全部 /api 应答。`hold` 兑现之前单任务台子的依赖读不回来（主按钮转圈）。 */
function api(hold, unexpected) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/projects") {
      return reply([{ id: "proj-1", name: "harness", repoPath: "/repo", myRole: "admin", acceptGateCommand: null }]);
    }
    if (url.pathname === "/api/tasks/bodies" && request.method() === "POST") {
      const { taskIds } = request.postDataJSON();
      return reply(taskIds.map((taskId) => ({ taskId, body: "把记录头的布局契约从白名单改成默认，并补上回归；长目标也只占两行，多出来的收进省略号里，不把第一行撑高。" })));
    }
    const hit = /^\/api\/tasks\/([^/]+)\/(branch-plan|accept-gate|acceptance-check|scm|commits|diff|sessions)$/.exec(url.pathname);
    if (hit && request.method() === "GET") {
      const [, taskId, what] = hit;
      if (what === "branch-plan" && PLANS[taskId]) {
        if (taskId === "single-task") await hold;
        return reply({ task: PLANS[taskId], descendants: [] });
      }
      if (what === "accept-gate") return reply(gateOf(taskId));
      if (what === "scm") return reply(scmOf(taskId));
      if (what === "commits") return reply({ branch: `ash/${taskId}`, commits: [{ sha: "1111111111111111", subject: "feat: 一行决定", at: "2026-11-02T01:20:00.000Z" }] });
      if (what === "diff") {
        return reply({ available: true, sourceBranch: `ash/${taskId}`, targetBranch: "main", mergeBase: "0123456789abcdef", diff: DIFF,
          files: [{ path: "a.ts", additions: 1, deletions: 1, origPath: null }], truncated: false, limitBytes: 1048576 });
      }
      if (what === "sessions") return reply([]);
      // 团队这一按之前要不要先勾「知情」：这里没有没跑过的独立验证。
      if (what === "acceptance-check") return reply({ verification: null });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return reply({ error: "验证页面拒绝未声明的请求" }, 404);
  };
}

/** 每处宿主的几何：形状、主按钮、红行、lead、溢出。 */
const probe = () => [...document.querySelectorAll(".acc")].map((acc) => {
  const host = acc.closest("[data-host]");
  const name = `${host.dataset.host}${acc.classList.contains("acc-record") ? "/record" : ""}`;
  const rect = (node) => node.getBoundingClientRect();
  const bar = acc.querySelector(":scope > .acc-bar");
  const checks = acc.querySelector(":scope > .acc-checks");
  const checksStyle = checks && getComputedStyle(checks);
  const checksInner = checks ? checks.clientWidth - parseFloat(checksStyle.paddingLeft) - parseFloat(checksStyle.paddingRight) : 0;
  const primary = bar?.querySelector(".acc-actions > button.acc-btn.is-primary");
  const lead = bar?.querySelector(":scope > .acc-lead");
  const heading = lead?.querySelector(".acc-route, .acc-title, .team-review-record-title b");
  const barStyle = bar && getComputedStyle(bar);
  const overflow = (node) => (node ? node.scrollWidth - node.clientWidth : 0);
  return {
    name,
    bars: acc.querySelectorAll(":scope > .acc-bar").length,
    lists: acc.querySelectorAll(':scope > .acc-checks[role="list"][aria-label="验收前提"]').length,
    checksBelowBar: checks && bar ? rect(checks).top >= rect(bar).bottom - 1 : false,
    barHeight: bar ? rect(bar).height : 0,
    barInner: bar ? bar.clientWidth - parseFloat(barStyle.paddingLeft) - parseFloat(barStyle.paddingRight) : 0,
    leadWidth: lead ? rect(lead).width : 0,
    headingHeight: heading ? rect(heading).height : null,
    headingText: heading?.textContent ?? "",
    primary: primary ? { text: primary.textContent.trim(), width: rect(primary).width, disabled: primary.disabled, busy: primary.getAttribute("aria-busy") } : null,
    rows: [...(checks?.querySelectorAll(":scope > .acc-check") ?? [])].map((row) => {
      const text = row.querySelector(".acc-check-text");
      const line = row.querySelector(".acc-check-line");
      return {
        check: row.dataset.check, tone: [...row.classList].find((c) => c.startsWith("is-")),
        text: text?.textContent ?? "", width: rect(row).width,
        textHeight: text ? rect(text).height : 0, lineHeight: text ? parseFloat(getComputedStyle(text).lineHeight) : 0,
        textBleed: text && line ? rect(text).right - rect(line).right : 0,
        lineOverflow: overflow(line),
      };
    }),
    checksInner,
    overflow: { host: overflow(host), acc: overflow(acc), bar: overflow(bar), checks: overflow(checks) },
    accBackground: getComputedStyle(acc).backgroundColor,
  };
});

const geometry = () => ({
  page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  text: document.body.innerText,
  diff: (() => {
    const root = document.querySelector('[data-host="conflict"] .single-review-workspace');
    const region = root?.querySelector(".single-review-diff-region");
    const first = region && [...region.querySelectorAll("*")].find((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden";
    });
    if (!root || !region || !first) return null;
    const top = root.getBoundingClientRect().top;
    return { region: region.getBoundingClientRect().top - top, first: first.getBoundingClientRect().top - top, firstClass: first.className };
  })(),
});

const report = [];
let browser;
try {
  const fixture = `${web.origin}/scripts/fixtures/acceptance-host-layout.html`;
  browser = await launchChrome();

  // 1280 / 360 是两头；880 是现场那一屏的中栏宽，760、560 是验收台与讨论条各自改排的那两档。
  for (const width of [1280, 880, 760, 560, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    const unexpected = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    await page.route((url) => url.pathname.startsWith("/api/"), api(hold, unexpected));
    await page.goto(fixture);

    // ② 读取中：主按钮转圈、灰着，字还是动作名；量下它的宽度，放行之后再量一次。
    const singlePrimary = page.locator('[data-host="single"] .acc-desk .acc-actions > button.acc-btn.is-primary');
    await page.locator('[data-host="single"] .acc-desk .acc-actions > button.acc-btn.is-primary[aria-busy="true"]').waitFor();
    const loadingBox = await singlePrimary.evaluate((node) => ({ text: node.textContent.trim(), width: node.getBoundingClientRect().width, disabled: node.disabled }));
    assert.equal(loadingBox.text, ACTION, `${width}px：读取中主按钮也只写动作名`);
    assert.equal(loadingBox.disabled, true, `${width}px：读取中主按钮不放行`);
    release();

    // 每处宿主都等到它的红行落地再量；否则量到的是一个还没受阻的空壳。
    for (const [host, check] of [["single", "blocker"], ["team", "host"], ["team", "parent"], ["duet", "blocker"], ["stacked", "parent"]]) {
      await page.locator(`[data-host="${host}"] .acc-checks > .acc-check[data-check="${check}"]`).first().waitFor();
    }
    await page.locator('[data-host="team"] .acc-record .acc-check[data-check="blocker"]').waitFor();
    await page.locator('[data-host="conflict"] .acc-check[data-check="baseline"]').waitFor();
    await page.locator('[data-host="conflict"] .single-review-diff-layout').waitFor();
    await page.waitForFunction(() => !document.querySelector('.acc-btn.is-primary[aria-busy="true"]'));

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      const rows = await page.evaluate(probe);
      const where = (row) => `${row.name}@${width}px/${theme}`;
      assert.deepEqual(rows.map((row) => row.name), ["single", "team", "team/record", "duet", "stacked", "conflict"], `${width}px：五处宿主（加冲突那张）都该在`);

      for (const row of rows) {
        // ① 同一副形状：一行决定、一列前提，前提列在第一行下面。
        assert.equal(row.bars, 1, `${where(row)}：应有且只有一行 .acc-bar`);
        assert.equal(row.lists, 1, `${where(row)}：应有且只有一列「验收前提」`);
        assert.ok(row.rows.length > 0, `${where(row)}：这一处的前提列不该是空的`);
        assert.ok(row.checksBelowBar, `${where(row)}：前提列应在第一行下面`);
        // ② 主按钮写动作名；红行在列里、不在按钮上。
        assert.ok(row.primary, `${where(row)}：第一行没有主按钮`);
        assert.equal(row.primary.text, ACTION, `${where(row)}：主按钮写成了「${row.primary.text}」`);
        assert.equal(row.primary.busy, null, `${where(row)}：读取早该结束了`);
        const red = row.rows.filter((check) => check.tone === "is-block");
        if (row.name !== "conflict") {
          assert.ok(red.length > 0, `${where(row)}：受阻的原因该是前提列里的红行`);
          assert.equal(row.primary.disabled, true, `${where(row)}：有红行拦着，主按钮该灰着`);
        }
        for (const check of red) assert.ok(!row.primary.text.includes(check.text.slice(0, 8)), `${where(row)}：红行「${check.text.slice(0, 12)}」进了主按钮`);
        // ③ 标题读得出来：lead 有地板宽，标题本身只占一行。
        const floor = Math.min(row.barInner, 240);
        assert.ok(row.leadWidth >= floor - 1 || row.name === "stacked", `${where(row)}：lead 被压到 ${Math.round(row.leadWidth)}px，低于地板 ${Math.round(floor)}px`);
        if (row.headingHeight !== null) assert.ok(row.headingHeight <= 30, `${where(row)}：标题「${row.headingText.slice(0, 16)}」占了 ${Math.round(row.headingHeight)}px，已经折成多行`);
        // ③ 前提列里每一行自己占满一整行，长文案只折行不越界，没有哪一层能横着滚。
        for (const check of row.rows) {
          assert.ok(check.width >= row.checksInner - 1, `${where(row)} · ${check.check}：只占 ${Math.round(check.width)}px / ${Math.round(row.checksInner)}px`);
          assert.ok(check.textBleed <= 1, `${where(row)} · ${check.check}：文案越过行尾 ${Math.round(check.textBleed)}px`);
          assert.ok(check.lineOverflow <= 0, `${where(row)} · ${check.check}：这一行横向溢出 ${check.lineOverflow}px`);
          if (width <= 560 && check.text.length > 60) {
            assert.ok(check.textHeight > check.lineHeight * 1.5, `${where(row)} · ${check.check}：长文案没有折行（高 ${Math.round(check.textHeight)}px）`);
          }
        }
        for (const [layer, value] of Object.entries(row.overflow)) {
          assert.ok(value <= 0, `${where(row)}：${layer} 横向溢出 ${value}px（scrollWidth > clientWidth）`);
        }
        report.push(`${where(row)} bar=${Math.round(row.barHeight)}px primary=${Math.round(row.primary.width)}px rows=${row.rows.map((check) => check.check).join(",")}`);
      }

      // ② 宽度不跳：读取中、受阻后、没受阻（冲突那张主按钮是亮的）三颗一样宽。
      const blockedWidth = rows.find((row) => row.name === "single").primary.width;
      const freeRow = rows.find((row) => row.name === "conflict");
      assert.equal(freeRow.primary.disabled, false, `${width}px/${theme}：基准冲突不禁用主按钮（确认层里可以这次不跑）`);
      assert.ok(Math.abs(blockedWidth - loadingBox.width) < 0.5, `${width}px/${theme}：主按钮读取中 ${loadingBox.width}px、受阻后 ${blockedWidth}px，宽度跳了`);
      assert.ok(Math.abs(blockedWidth - freeRow.primary.width) < 0.5, `${width}px/${theme}：受阻 ${blockedWidth}px、放行 ${freeRow.primary.width}px，宽度跳了`);

      const view = await page.evaluate(geometry);
      assert.ok(view.page <= 0, `${width}px/${theme}：整页横向溢出 ${view.page}px`);
      // ④ diff 紧跟在决定下面。
      assert.ok(view.diff, `${width}px/${theme}：冲突那张台子没有 diff`);
      report.push(`diff@${width}px/${theme}: region=${Math.round(view.diff.region)}px first=${Math.round(view.diff.first)}px (.${view.diff.firstClass})`);
      assert.ok(view.diff.region <= 150, `${width}px/${theme}：diff 区离验收台顶端 ${Math.round(view.diff.region)}px，超过 150px`);
      // 宽屏下第一行只占一行，连 diff 区自己的内边距算上也在 150px 以内；760px 及以下第一行折成两行
      // （lead 独占一行、动作在下），diff 区本身仍贴着 150px，第一个可见元素再往下让 10px 内边距。
      if (width > 760) assert.ok(view.diff.first <= 150, `${width}px/${theme}：diff 第一个可见元素离验收台顶端 ${Math.round(view.diff.first)}px，超过 150px`);
      // ⑤ 旧验收台那一摞不在了。
      for (const text of GONE_TEXT) assert.ok(!view.text.includes(text), `${width}px/${theme}：页面上还有「${text}」`);
      assert.equal(await page.locator(GONE_SELECTORS.join(",")).count(), 0, `${width}px/${theme}：旧验收台的元素还在`);
    }
    // 深色确实换上了（变量只在 :root[data-theme="dark"] 下改）。
    const [lightBg, darkBg] = await page.evaluate(() => {
      const acc = document.querySelector(".acc-desk");
      const dark = getComputedStyle(acc).backgroundColor;
      delete document.documentElement.dataset.theme;
      return [getComputedStyle(acc).backgroundColor, dark];
    });
    assert.notEqual(lightBg, darkBg, `${width}px：深色主题没有生效`);

    assert.deepEqual(unexpected, [], `${width}px：页面发了未声明的请求`);
    assert.deepEqual(errors, [], `${width}px 渲染报错`);
    await page.close();
  }
  if (process.env.ACC_LAYOUT_REPORT) console.log(report.join("\n"));
  console.log(report.filter((line) => line.startsWith("diff@")).join("\n"));
  console.log("acceptance host layout: one bar + one checklist across five hosts, action-only primary of fixed width, long copy wraps without horizontal overflow (1280/880/760/560/360px, light+dark), diff within 150px under a merge-preview conflict, retired surfaces gone");
} finally {
  await browser?.close();
  await web.close();
}
