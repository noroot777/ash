import assert from "node:assert/strict";
import type { AcceptanceSteps } from "@ash/shared/accept-message";
import type { AcceptGateState, AcceptGateView } from "@ash/shared/accept-gate";
import { cleanText, confirmView, type ConfirmGate, type ConfirmInput } from "../src/acceptance/confirmPlan.ts";
import { gateLine, type GateLineInput } from "../src/acceptance/gateLine.ts";

// 验收台两份纯推导：确认层「勾成这样 → 发什么参数、确认键叫什么、能不能按」，以及前提列里
// 前置命令那一行此刻怎么说。DOM 那头由 test-accept-gate-* 与 branch-acceptance 盯着画法，
// 这里盯的是**不许漂的那几条**：发给后端的值就是层里看见的值、读不到就不放行、跳过与重跑
// 仍然要经过确认。

const merge: Extract<AcceptanceSteps, { kind: "merge" }> = {
  kind: "merge", scope: "single", merge: "squash", commit: true, target: "main", clean: "all",
  keepsBranch: true, offScript: null, team: false,
};
const gate = (over: Partial<ConfirmGate> = {}): ConfirmGate =>
  ({ command: "npm test", reusable: false, passedAgo: null, lastFailed: false, issue: null, ...over });
const input = (over: Partial<ConfirmInput> = {}): ConfirmInput => ({
  steps: merge, gate: null, runChoice: null, commitChoosable: true, commitChoice: null, commitDefault: true,
  count: 1, verification: "none", ...over,
});

// 1. 「运行」那一勾：没有可沿用的绿时默认勾着（照常跑），取消 = 这次跳过。
{
  const view = confirmView(input({ gate: gate() }));
  assert.equal(view.runs, true);
  assert.equal(view.gateIntent, undefined, "照常：不带额外指令，由服务端判要不要跑");
  assert.equal(view.confirmLabel, "确认验收");
  const skip = confirmView(input({ gate: gate({ lastFailed: true }), runChoice: false }));
  assert.equal(skip.gateIntent, "skip");
  assert.equal(skip.confirmLabel, "跳过并验收", "跳过必须在确认键上说破");
  assert.equal(skip.confirmDisabled, false, "跳过仍然走这一道确认，而不是另一颗直接合并的键");
}

// 2. 有一次还作数的绿：默认不勾（沿用那次），勾上 = 重跑。
{
  const reuse = confirmView(input({ gate: gate({ reusable: true, passedAgo: "8 分钟前" }) }));
  assert.equal(reuse.runs, false);
  assert.equal(reuse.gateIntent, undefined, "沿用那次绿不是跳过");
  assert.equal(reuse.confirmLabel, "确认验收");
  const rerun = confirmView(input({ gate: gate({ reusable: true }), runChoice: true }));
  assert.equal(rerun.gateIntent, "rerun");
}

// 3. 没设命令：不碰前置命令。
assert.equal(confirmView(input()).gateIntent, undefined);

// 4. 「提交」那一勾：发出去的就是层里看见的值。
{
  assert.equal(confirmView(input({ commitDefault: true })).commitParam, true);
  assert.equal(confirmView(input({ commitDefault: false })).commitParam, false, "没动过 = 项目默认，原样发出去");
  const off = confirmView(input({ commitDefault: true, commitChoice: false }));
  assert.equal(off.commitParam, false);
  assert.equal(off.confirmLabel, "验收，不提交");
  assert.equal(confirmView(input({ commitChoosable: false, commitDefault: null })).commitParam, undefined,
    "不会合并的那几档（标签、只标记）不发 commit");
}

// 5. 项目默认没读到之前不许确认：那一刻层里写的「会提交」没有依据。
{
  assert.equal(confirmView(input({ commitDefault: null })).confirmDisabled, true);
  assert.equal(confirmView(input({ commitDefault: null, commitChoice: true })).confirmDisabled, false,
    "用户自己勾过就有依据了");
  assert.equal(confirmView(input({ commitChoosable: false, commitDefault: null })).confirmDisabled, false);
}

// 6. 一次多个任务又不提交：只能合一个，确认键灰着。
{
  const batch = confirmView(input({ count: 2, commitChoice: false }));
  assert.equal(batch.batchNeedsCommit, true);
  assert.equal(batch.confirmDisabled, true);
  assert.equal(confirmView(input({ count: 2 })).confirmDisabled, false);
}

// 7. 独立验证尚未执行：读不到、还在读、没勾「知情」都不许确认。
for (const state of ["loading", "error", "unacknowledged"] as const) {
  assert.equal(confirmView(input({ verification: state })).confirmDisabled, true, state);
}
assert.equal(confirmView(input({ verification: "acknowledged" })).confirmDisabled, false);

// 8. 中途那道关口：只是放行。
assert.equal(confirmView(input({ steps: { kind: "release", next: "自动验证" }, commitChoosable: false })).confirmLabel, "放行");

// 9. 「清理」照实际会发生的写：squash、不提交时分支一律留着。
assert.equal(cleanText({ ...merge, merge: "safe" }, true), "worktree和任务分支");
assert.equal(cleanText({ ...merge, merge: "safe" }, false), "worktree，分支留着");
assert.equal(cleanText(merge, true), "worktree，分支留着");
assert.equal(cleanText({ ...merge, clean: "none" }, true), "worktree和分支都保留");

// —— 前置命令那一行 ——
const NOW = Date.parse("2026-11-14T10:00:00Z");
const run = (over: Partial<AcceptGateView> = {}): AcceptGateView => ({
  id: "run-1", taskId: "t", command: "npm test", cwd: "/w", status: "passed", exitCode: 0, failure: null,
  startedAt: "2026-11-14T09:50:00Z", finishedAt: "2026-11-14T09:52:00Z", sourceCommit: "abc", targetBranch: "main",
  targetCommit: "def", fastForward: true, stale: false, ...over,
} as AcceptGateView);
const state = (over: Partial<AcceptGateState> = {}): AcceptGateState =>
  ({ command: "npm test", prepare: null, baseline: "branch", latest: null, basis: null, ...over } as AcceptGateState);
const line = (over: Partial<GateLineInput> = {}) => gateLine({
  state: state(), error: null, running: null, runningFor: null, latest: null, settled: false, atFinalGate: true, now: NOW, ...over,
});

// 10. 读不出来先说出来（带重试），还在读就不出这一行。
assert.equal(line({ state: null }), null);
{
  const unread = line({ state: null, error: "503" })!;
  assert.equal(unread.tone, "block");
  assert.equal(unread.word, "状态读不出来");
  assert.equal(unread.retry, true);
}

// 11. 在跑：状态词带时长，行尾是停止；进程没退干净时换成强制释放那条路。
{
  const running = run({ status: "running", finishedAt: null });
  const live = line({ running, runningFor: "3 分 2 秒" })!;
  assert.equal(live.tone, "running");
  assert.equal(live.word, "运行中 · 3 分 2 秒");
  assert.equal(live.stop, true);
  const pending = line({ running: run({ status: "canceled", processPending: true } as Partial<AcceptGateView>) })!;
  assert.equal(pending.word, "进程还没退干净");
  assert.equal(pending.forceRelease, true);
}

// 12. 还没跑过、通过还作数、通过但不作数（一句原因）、没过（交没交给任务）、取消。
assert.equal(line()!.word, "验收时运行");
assert.equal(line({ latest: run() })!.word, "通过 · 8 分钟前");
assert.equal(line({ latest: run({ stale: true, command: "npm run old" }) })!.word, "通过，但命令变了");
assert.equal(line({ latest: run({ stale: true }) })!.word, "通过，但代码变了");
{
  const failed = line({ latest: run({ status: "failed", exitCode: 1 }) })!;
  assert.equal(failed.word, "未通过，还没交给任务");
  assert.equal(failed.handOff, true);
  assert.equal(failed.openLog, true, "没通过时日志默认展开");
  const handed = line({ latest: run({ status: "failed", exitCode: 1, handoff: { at: "x", error: null } } as Partial<AcceptGateView>) })!;
  assert.equal(handed.word, "未通过，已交给任务修复");
  assert.equal(handed.handOff, false);
}
assert.equal(line({ latest: run({ status: "canceled" }) })!.tone, "stopped", "取消没有结论，不是红");

// 13. 中途那道关口不预告「验收时运行」；没设命令也不出这一行 —— 但上次读到「没设」、这次读不出来时
//     主按钮照样锁着，这一行必须说出原因并给重试，否则按钮灰着、页面上找不到一个出路。
assert.equal(line({ atFinalGate: false }), null);
assert.equal(line({ state: state({ command: null }) }), null);
{
  const unread = line({ state: state({ command: null }), error: "500" })!;
  assert.equal(unread.word, "状态读不出来");
  assert.equal(unread.retry, true);
}
// 最近一次没过的是另一条命令：它的红说的不是现在这条。
assert.equal(line({ latest: run({ status: "failed", exitCode: 1, command: "npm run old" }) })!.word, "验收时运行");

// 14. 已验收：只认这一按自己的凭据，绝不拿「最近一次」反推。
{
  assert.equal(line({ settled: true, state: state({ basis: { mode: "passed", run: run() } } as Partial<AcceptGateState>) })!.word, "通过");
  assert.equal(line({ settled: true, state: state({ basis: { mode: "skipped" } } as Partial<AcceptGateState>) })!.word, "已跳过");
  const unset = line({ settled: true, latest: run(), state: state({ command: null, basis: { mode: "unset" } } as Partial<AcceptGateState>) })!;
  assert.equal(unset.word, "验收时没设", "那一刻没有门禁，哪怕最近一次是绿的");
  assert.equal(line({ settled: true, state: state({ basis: null }) })!.word, "没留下验收凭据");
}

// 15. 状态有了但这一次刷新失败：照旧说那一行，缀「状态待核对」并给重试，不让它冒充确认过的状态。
{
  const stale = line({ error: "timeout", latest: run() })!;
  assert.match(stale.word, /状态待核对$/);
  assert.equal(stale.retry, true);
  assert.equal(stale.tone, "idle");
}

console.log("acceptance plan: ok");
