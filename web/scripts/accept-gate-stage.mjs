// 验收前置命令这一组 DOM 回归共用的舞台：假服务端（`openGatePage`）、门禁运行记录的样板
// （`run` / `basis`），以及验收台上几样常用的定位（主按钮、前置命令那一行、确认层）。
//
// 从 test-accept-gate-dom.mjs 拆出来：那份按表面拆成了好几个文件（回执、确认层、动作、读取、
// 恢复、等待条），它们要的是同一个假服务端，抄一份就会有一份漏掉某条路由。
import assert from "node:assert/strict";
import { fetchesSettled, trackFetches, waitUntil } from "./wait-until.mjs";

/**
 * 页面上要记结算的读取：门禁状态（不含 /log、/cancel 这些子路径）、任务列表、项目（角色），
 * 以及验收台自己那两份前提（依赖、自由工作流审查状态）—— 主按钮放不放要等这几份都读到。
 */
export const TRACKED_READS = "/api/(tasks(/[^/]+/(accept-gate|branch-plan|free-workflow))?|projects)$";

export const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export const run = (over = {}) => ({
  id: "run-1",
  taskId: "gate-task",
  command: "./kb.sh test full",
  cwd: "/repo/.worktrees/gate-task",
  status: "passed",
  exitCode: 0,
  failure: null,
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  finishedAt: new Date().toISOString(),
  sourceCommit: "abc12345",
  targetBranch: "main",
  targetCommit: "def67890",
  fastForward: true,
  stale: false,
  logPath: "/runs/gate-task/accept-gate-run-1.log",
  logTail: "640 passed\n",
  handoff: null,
  ...over,
});

/** 已验收那张回执的凭据。`passed` 要指着真的跑绿的那一次，不是「最近一次」。 */
export const basis = (mode, runRow = null) => ({ mode, run: runRow });

/** 验收台假服务端里那个任务（`api.task` 刷新时回它，stage 跟着 store.stage）。 */
export const taskRow = (over = {}) => ({
  id: "gate-task", projectId: "proj-1", title: "门禁卡", body: "", mode: "single", status: "done", stage: "verified",
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude", useWorktree: true, workflowMode: "free",
  mergeTargetBranch: "main", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z", ...over,
});

/** 依赖那一份：不挡路、没有派生任务。 */
export const branchPlan = () => ({
  task: { taskId: "gate-task", title: "门禁卡", projectId: "proj-1", stage: "verified", blocker: null, dependency: null,
    strategy: "safe", sourceBranch: "ash/gate-task", targetBranch: "main", fingerprint: "fp-1" },
  descendants: [],
});

/** 自由工作流的审查状态：一轮审查都没有（不拦也不提醒）。 */
export const freeWorkflow = () => ({ stateVersion: 1, reviews: [], reviewReservation: null });

/** 验收台的主按钮（「验收通过」）。读取中它 aria-busy、文字不变。 */
export const mainButton = (page) => page.locator(".acc-bar button.acc-btn.is-primary");
/** 前提列里前置命令那一行。 */
export const gateRow = (page) => page.locator('.acc-checks .acc-check[data-check="gate"]');
/** 前提列里任意一行。 */
export const checkRow = (page, key) => page.locator(`.acc-checks .acc-check[data-check="${key}"]`);
export const confirmLayer = (page) => page.getByRole("dialog", { name: "确认验收", exact: true });

/** 主按钮读完（不转圈）。被挡时它照样不转圈，只是 disabled。 */
export async function deskSettled(page) {
  await page.locator(".acc-bar button.acc-btn.is-primary:not([aria-busy])").waitFor();
}

/** 点主按钮、等确认层出来。 */
export async function openConfirm(page) {
  await mainButton(page).click();
  const layer = confirmLayer(page);
  await layer.waitFor();
  return layer;
}

/** 某一行里写着的状态词。 */
export const stateOf = (row) => row.locator(".acc-check-state").innerText();

/** 断言某一行的调子（is-<tone>）。 */
export async function assertTone(row, tone, message) {
  const classes = await row.getAttribute("class");
  assert.ok(classes.split(/\s+/).includes(`is-${tone}`), `${message ?? "这一行的调子"}：要 is-${tone}，实际 ${classes}`);
}

/**
 * 开一页挂好假服务端。
 *
 * `states` 给的是**按请求次序**排好的几份门禁响应（用来排并发/乱序那一类场面）：每份可以
 * 带 status（直接给个 500）、after（扣住这一份，等第 after 次读取的响应**送出去**之后
 * 才回 —— 乱序靠这个排，不靠「迟到多少毫秒」：满载时后一发可能比任何固定延迟都晚才到）
 * 或 hold（扣到测试放行这个 promise 才回）。
 * 不给就一直回 store.gate。`store.served(i)` 在第 i 次读取的响应送出（或因页面已 abort
 * 而送不出）之后兑现；页面那一侧有没有消费完看 fetchesSettled（只记 TRACKED_READS）。
 *
 * 发给 /accept 的请求体按顺序记在 `store.accepts`，回什么由 `store.acceptReply(body)` 定
 * （缺省回一个 409 target_unresolved「模拟验收响应」：什么都没动）。
 *
 * 其余开关：`status` 门禁读取一开始就回这个错误码；`hold` 一开始就扣住每一发门禁读取（见
 * store.hold）；`init(page)` 在打开页面之前往页面里塞东西；`clock` 打开之前装假时钟；
 * `ready: false` 不等挂载那几发读取落地（要看「还在读」那一刻时用）。
 */
export function gateStage({ browser, base }) {
  return async ({ gate, role = "admin", query = "", command, states, tasks = [], events = false, cancelOutcome = "canceled",
    projectDown = false, acceptCommit, acceptReply, status = 0, hold = null, init = null, clock = false, ready = true } = {}) => {
    const page = await browser.newPage({ viewport: { width: 980, height: 820 } });
    if (clock) await page.clock.install();
    if (init) await init(page);
    if (events) await page.addInitScript(() => {
      const streams = new Set();
      window.EventSource = class {
        constructor() { streams.add(this); queueMicrotask(() => this.onopen?.()); }
        close() { streams.delete(this); }
      };
      window.emitGateEvent = event => {
        for (const stream of streams) stream.onmessage?.({ data: JSON.stringify(event) });
      };
      // 断线与重连分两步给：连在一起发，React 会把 false→true 批成一次渲染，「断线作废」就不发生。
      window.dropGateStream = () => { for (const stream of streams) stream.onerror?.(); };
      window.reopenGateStream = () => { for (const stream of streams) stream.onopen?.(); };
    });
    await trackFetches(page, TRACKED_READS);
    const served = [];
    const servedAt = (index) => (served[index] ??= Promise.withResolvers());
    const store = { patches: [], canceled: 0, handoffs: 0, conflictHandoffs: 0, reads: 0, tasks, taskReads: 0, taskPlan: null,
      served: (index) => servedAt(index).promise,
      requestIds: [], status, hold, logText: "checking 42 / 640", command: command === undefined ? gate?.command ?? null : command, gate,
      projectReads: 0, projectDown, accepts: [], acceptReply, stage: new URLSearchParams(query).get("stage") ?? "verified",
      taskFetches: 0, unexpected: [] };
    // 优先级最低的兜底：没桩的请求一律 404 并记下来，免得落到 vite 上回一页 HTML。
    await page.route("**/api/**", (route) => {
      store.unexpected.push(new URL(route.request().url()).pathname);
      return json(route, { error: `Unexpected request: ${route.request().url()}` }, 404);
    });
    await page.route("**/api/tasks", async route => {
      const snapshot = store.tasks;
      const plan = store.taskPlan;
      store.taskPlan = null;
      store.taskReads += 1;
      // hold：这一发的快照在发出那一刻就定了，扣到测试放行才回 —— 用来造「旧快照迟到」。
      if (plan?.hold) await plan.hold;
      return json(route, snapshot);
    });
    await page.route("**/api/tasks/gate-task", (route) => {
      store.taskFetches += 1;
      return json(route, taskRow({ stage: store.stage }));
    });
    await page.route("**/api/tasks/*/branch-plan", (route) => json(route, branchPlan()));
    await page.route("**/api/tasks/*/free-workflow", (route) => json(route, freeWorkflow()));
    // 不是 git 仓库：「未提交改动」那一行不出（它有自己的回归）。
    await page.route("**/api/tasks/*/scm", (route) => json(route, { error: "不是 Git 仓库" }, 400));
    await page.route("**/api/tasks/gate-task/accept", (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      store.accepts.push(body);
      const reply = store.acceptReply?.(body)
        ?? { status: 409, body: { accepted: false, taskId: "gate-task", reason: "target_unresolved", error: "模拟验收响应" } };
      return json(route, reply.body, reply.status ?? 200);
    });
    await page.route("**/api/tasks/gate-task/accept-gate/log?*", route => route.fulfill({
      status: 200, contentType: "text/plain", body: store.logText,
    }));
    // SSE 在这一屏里只负责「有变化就重读」，测试里不发事件，挂一条空流免得它反复重连。
    await page.route("**/api/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }));
    await page.route("**/api/projects", (route) => {
      store.projectReads += 1;
      if (store.projectDown) return json(route, { error: "数据库忙" }, 503);
      return json(route, [{ id: "proj-1", name: "kb", repoPath: "/repo", myRole: role, acceptGateCommand: store.command,
        ...(acceptCommit === undefined ? {} : { acceptCommit }) }]);
    });
    await page.route("**/api/projects/proj-1", async (route) => {
      store.patches.push(JSON.parse(route.request().postData() ?? "{}"));
      if ("acceptGateCommand" in store.patches.at(-1)) store.command = store.patches.at(-1).acceptGateCommand;
      store.gate = { ...store.gate, command: store.command };
      return json(route, { id: "proj-1", name: "kb", repoPath: "/repo", myRole: role, acceptGateCommand: store.command });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/cancel", (route) => {
      store.canceled += 1;
      assert.equal(JSON.parse(route.request().postData()).runId, store.gate.running.id);
      if (cancelOutcome === "settlement_failed") return json(route, {
        outcome: cancelOutcome, runId: store.gate.running.id, gate: store.gate.running,
      });
      if (cancelOutcome !== "canceled") {
        const latest = run({ ...store.gate.running, status: "passed", exitCode: 0 });
        store.gate = { ...store.gate, running: null, latest, basis: basis("passed", latest) };
        return json(route, { outcome: cancelOutcome, runId: latest.id, gate: latest });
      }
      store.gate = { ...store.gate, running: null, latest: { ...store.gate.running, status: "canceled", failure: "canceled" } };
      return json(route, { outcome: "canceled", runId: store.gate.latest.id, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/handoff", (route) => {
      store.handoffs += 1;
      store.gate = { ...store.gate, latest: { ...store.gate.latest, handoff: { at: new Date().toISOString(), error: null } } };
      return json(route, { handedOff: true, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/conflict-handoff", (route) => {
      store.conflictHandoffs += 1;
      store.gate = { ...store.gate, baselineIssue: { ...store.gate.baselineIssue, handedOffAt: new Date().toISOString() } };
      return json(route, { ok: true, message: "已把合并冲突交给任务" });
    });
    await page.route("**/api/tasks/gate-task/accept-gate/force-release", route => {
      const body = JSON.parse(route.request().postData());
      assert.equal(body.runId, store.gate.running.id);
      assert.equal(body.confirmation, "release-without-exit-proof");
      store.released = (store.released ?? 0) + 1;
      store.gate = { ...store.gate, running: null, latest: { ...store.gate.running,
        status: "interrupted", failure: "ownership_waived", processPending: false } };
      return json(route, { ok: true, gate: store.gate.latest });
    });
    await page.route("**/api/tasks/*/accept-gate", async (route) => {
      const index = store.reads;
      const plan = states?.[index] ?? null;
      // store.hold：此刻起发来的每一发都扣着（发出那一刻定下扣不扣，之后改 store.hold 不影响它）。
      const held = store.hold;
      store.reads += 1;
      store.requestIds.push(route.request().url().split("/").at(-2));
      if (plan?.after !== undefined) await servedAt(plan.after).promise;
      if (plan?.hold) await plan.hold;
      if (held) await held;
      const status = plan?.status || store.status;
      // 被扣住的那一份送出去时，页面可能早已把这一发 abort 了（这正是被验的行为之一）。
      await (status ? json(route, { error: "数据库忙" }, status) : json(route, plan?.body ?? store.gate)).catch(() => {});
      servedAt(index).resolve();
    });
    await page.goto(`${base}${query}`);
    if (ready && !query.includes("wait=1") && !query.includes("dots=1")) {
      // 验收台：门禁、角色、依赖、审查状态那几发都落完（成败都算），此刻页面上的就是读到的样子。
      await page.locator(".acc").waitFor();
      await fetchesSettled(page, 2, "验收台挂载那几发读取都已落地");
    }
    return { page, store };
  };
}

/**
 * 让「重试」那一下可以被确定地验：读取失败之后追平层会按 1→2→4→8→10 秒自己退避重试，测试要是
 * 先恢复服务端再去点「重试」，自动重试可能抢先落地、那颗按钮在点之前就没了。所以先扣住下一发
 * 自动重试（单飞：它在途时不会再排第二发），再恢复服务端 —— 此刻能落地的只有点出来的那一发。
 */
export async function freezeAutoRetry(store) {
  store.hold = new Promise(() => {});
  const before = store.reads;
  await waitUntil(() => store.reads > before, "下一发自动重试到达桩（被扣住）");
  store.hold = null;
}
