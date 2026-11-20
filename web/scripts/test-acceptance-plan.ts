import assert from "node:assert/strict";
import type { AcceptanceSteps } from "@navi/shared/accept-message";
import type { AcceptGateState, AcceptGateView } from "@navi/shared/accept-gate";
import { cleanText, confirmView, type ConfirmGate, type ConfirmInput } from "../src/acceptance/confirmPlan.ts";
import { gateLine, type GateLineInput } from "../src/acceptance/gateLine.ts";

// 验收台两份纯推导：确认层「勾成这样 → 发什么参数、确认键叫什么、能不能按」，以及前提列里
// 前置命令那一行此刻怎么说。DOM 那头由 test-accept-gate-* 与 branch-acceptance 盯着画法，
// 这里盯的是**不许漂的那几条**：发给后端的值就是层里看见的值、读不到就不放行、跳过与重跑
// 仍然要经过确认、默认跟上一次确认时的样子而前提列那一行跟它同一个口径。

const merge: Extract<AcceptanceSteps, { kind: "merge" }> = {
  kind: "merge", scope: "single", merge: "squash", commit: true, target: "main", clean: "all",
  keepsBranch: true, offScript: null, team: false,
};
const gate = (over: Partial<ConfirmGate> = {}): ConfirmGate =>
  ({ command: "npm test", reusable: false, passedAgo: null, lastFailed: false, issue: null, skipRemembered: false, ...over });
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

// 2b. 两勾的默认是上一次确认时的样子（用户 2026-11-15）：上次跳过，这次默认就不勾、确认键照样说破；
//     点确认记下的就是层里看见的样子 —— 跟默认一样也记（第 4 轮审查：每一次确认都要让服务端排上号）。
//     有一次还作数的绿时，沿用和重跑都不改记住的「跳没跳过」。
{
  const remembered = confirmView(input({ gate: gate({ skipRemembered: true }) }));
  assert.equal(remembered.runs, false, "上次跳过：这次默认不勾");
  assert.equal(remembered.gateIntent, "skip");
  assert.equal(remembered.confirmLabel, "跳过并验收");
  assert.equal(remembered.confirmDisabled, false, "照样要在层里按一下确认，不是自动跳过");
  assert.deepEqual(remembered.memory, { skipGate: true, commit: true });
  const back = confirmView(input({ gate: gate({ skipRemembered: true }), runChoice: true }));
  assert.equal(back.gateIntent, undefined, "重新勾上：照常跑");
  assert.deepEqual(back.memory, { skipGate: false, commit: true }, "确认之后记成新的");
  assert.deepEqual(confirmView(input({ gate: gate() })).memory, { skipGate: false, commit: true });
  for (const runChoice of [null, true]) {
    const reuse = confirmView(input({ gate: gate({ reusable: true, skipRemembered: true }), runChoice }));
    assert.equal(reuse.runs, runChoice === true, "有作数的绿：默认沿用，记住的跳过不起作用");
    assert.deepEqual(reuse.memory, { commit: true }, `沿用 / 重跑都不改记住的值（runChoice=${runChoice}）`);
  }
  assert.deepEqual(confirmView(input({ commitDefault: false })).memory, { commit: false }, "提交那一勾照层里看见的记");
  assert.deepEqual(confirmView(input({ commitDefault: true, commitChoice: false })).memory, { commit: false });
  assert.equal(confirmView(input({ commitChoosable: false, commitDefault: null })).memory, null, "不合并、没命令：没什么可记");
  assert.equal(confirmView(input({ steps: { kind: "release", next: "自动验证" }, gate: gate(), commitChoosable: false })).memory, null,
    "只是放行：不记");
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
  assert.equal(confirmView(input({ commitDefault: null, commitChoice: true })).confirmDisabled, true,
    "用户勾过也不算：项目默认读到之前一律不许确认（第 2 轮审查 F2）");
  assert.equal(confirmView(input({ commitChoosable: false, commitDefault: null })).confirmDisabled, false);
}

// 5b. 项目默认正在重读（别处刚改过、断线重连）或读失败：不论手动改没改过「提交」，读到之前都不放行；
//     读到之后手动改过的照它走。
{
  const refreshing = confirmView(input({ commitDefault: true, commitDefaultPending: true }));
  assert.equal(refreshing.confirmDisabled, true, "拿旧默认去确认，会把旧值发出去还写回项目设置（第 1 轮审查 F1）");
  const edited = confirmView(input({ commitDefault: true, commitDefaultPending: true, commitChoice: false }));
  assert.equal(edited.confirmDisabled, true, "手动改过不是豁免：读失败时它会把看不见的值发出去（第 2 轮审查 F2）");
  const settled = confirmView(input({ commitDefault: true, commitChoice: false }));
  assert.equal(settled.confirmDisabled, false);
  assert.equal(settled.commitParam, false, "读到之后照手动选的发");
}

// 5c. 前置命令那份状态（带着记住的「跳没跳过」）在重读或读失败：手上那份只管画，确认锁着（第 3、4 轮审查，
//     用户 2026-11-15 选的）。动过这一勾也不是豁免。
{
  const gate = { command: "./t.sh", reusable: false, passedAgo: null, lastFailed: false, issue: null, skipRemembered: true };
  const stale = confirmView(input({ gate, gatePending: true }));
  assert.equal(stale.runs, false, "画的还是手上那份");
  assert.equal(stale.confirmDisabled, true, "拿旧的「跳过」确认会照旧跳过、还把它写回去");
  assert.equal(confirmView(input({ gate, gatePending: true, runChoice: true })).confirmDisabled, true);
  assert.equal(confirmView(input({ gate })).confirmDisabled, false);
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

// 13b. 上次跳过：不打开确认层也看得出这一按不会跑 —— 跟确认层「运行」那一勾的默认同一个口径。
{
  const skipped = (over: Partial<GateLineInput> = {}) => line({ skipping: true, ...over })!;
  assert.equal(line({ state: state({ skipRemembered: true }) })!.word, "验收时运行",
    "只认调用方按确认层推出来的那一份：统一验收不走「运行」那一勾，记着跳过也不预告（第 1 轮审查 F3）");
  assert.equal(skipped().word, "验收时跳过");
  assert.equal(skipped().tone, "skipped");
  assert.equal(skipped({ latest: run({ stale: true }) }).word, "通过，但代码变了，验收时跳过");
  assert.equal(skipped({ latest: run({ status: "failed", exitCode: 1 }) }).word, "未通过，还没交给任务，验收时跳过");
  assert.equal(skipped({ latest: run({ status: "failed", exitCode: 1 }) }).tone, "failed", "红还是红");
  assert.equal(skipped({ latest: run({ status: "canceled" }) }).word, "已取消，验收时跳过");
  assert.equal(skipped({ latest: run() }).word, "通过 · 8 分钟前", "有作数的绿：这一按沿用它，不提跳过");
  assert.equal(skipped({ atFinalGate: false }), null, "只是放行那一站：不预告");
  assert.equal(line({ skipping: true, settled: true, state: state({ basis: { mode: "passed", run: run() } } as Partial<AcceptGateState>) })!.word,
    "通过", "已验收：只认凭据");
}

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

// 16. 「推送」那一勾（2026-11-20）：只在会落提交、推得了时出现，默认跟上一次；发给后端的就是层里看见的那个值；
//     推送那份事实读不到时不许确认（上一次勾了推送，读失败就静悄悄不推是最坏的那种）；取消「提交」它就收起来。
{
  const off = confirmView(input());
  assert.equal(off.pushChoosable, false, "推不了（没读到推到哪）就不画");
  assert.equal(off.pushParam, undefined, "不画就不发");
  assert.equal(off.memory?.push, undefined, "不画就不记");
  const remembered = confirmView(input({ push: { remembered: true } }));
  assert.equal(remembered.push, true, "上一次勾了推送：这次默认勾着");
  assert.equal(remembered.pushParam, true);
  assert.equal(remembered.confirmLabel, "验收并推送", "推送要在确认键上说破");
  assert.equal(remembered.memory?.push, true);
  const unchecked = confirmView(input({ push: { remembered: true }, pushChoice: false }));
  assert.equal(unchecked.pushParam, false);
  assert.equal(unchecked.confirmLabel, "确认验收");
  assert.equal(unchecked.memory?.push, false, "这次取消了，下次就默认不勾");
  const noCommit = confirmView(input({ push: { remembered: true }, commitChoice: false }));
  assert.equal(noCommit.pushChoosable, false, "不提交就没有可推的");
  assert.equal(noCommit.pushParam, undefined);
  assert.equal(noCommit.memory?.push, undefined, "收起来时不改记住的值");
  assert.equal(confirmView(input({ pushPending: true })).confirmDisabled, true, "推送那份事实没读到：等它");
  assert.equal(confirmView(input({ pushPending: true, commitChoice: false })).confirmDisabled, false, "不提交时推送无关，不等它");
  assert.equal(confirmView(input({ push: { remembered: true }, gate: gate(), runChoice: false })).confirmLabel, "跳过并验收",
    "跳过门禁比推送更要紧，确认键先说跳过");
}

console.log("acceptance plan: ok");
