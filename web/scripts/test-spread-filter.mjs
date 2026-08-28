import assert from "node:assert/strict";
import {
  SPREAD_DOT_FILTERS,
  SPREAD_FILTERS,
  indexWorkers,
  matchesSpreadFilter,
  spreadBucket,
  spreadCounts,
  spreadVisibleTasks,
  workersFrom,
} from "../src/workspace/useSidebarSpread.ts";
import { orderedTopLevelTasks } from "../src/workspace/taskTreeModel.ts";
import { resolveScopeKind, scopeHasFilters, scopeTasks } from "../src/workspace/taskScope.ts";
import { awaitsYourWord, inTaskMode, isTaskAwaitingAcceptance } from "../src/lib/taskAttention.ts";

const P1 = { kind: "project", projectId: "p1" };
const P3 = { kind: "project", projectId: "p3" };
const TASKS = { kind: "tasks" };

// 「待验收」不看年龄（见 taskAttention 的 isTaskAwaitingAcceptance），所以 fixture 里
// 特意准备了两种年龄：STALE 是两个月前收的老账,FRESH 是刚收的。两者必须落在同一档 ——
// 这一档曾经带过 7 天时限,那是拿口径去补 daily-report 的数据,数据清干净后就撤了。
const FRESH = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const STALE = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

function task(id, extra = {}) {
  return {
    id,
    projectId: "p1",
    mode: "single",
    status: "backlog",
    stage: null,
    question: null,
    pinnedAt: null,
    starredAt: null,
    parentId: null,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: STALE,
    ...extra,
  };
}

// 窄态那排点必须画满每一档：少一档就等于那档的任务从筛选里消失了，而且没人会发现。
assert.deepEqual(
  SPREAD_DOT_FILTERS.map((item) => item.key),
  SPREAD_FILTERS.filter((item) => item.key !== "all").map((item) => item.key),
);
assert.ok(!SPREAD_DOT_FILTERS.some((item) => item.key === "all"));

// 星标是手动记号，与状态桶正交：点位列表里有它，但它不是 spreadBucket 的产出。
const BUCKET_FILTERS = SPREAD_DOT_FILTERS.filter((item) => item.key !== "starred");

const tasks = [
  task("todo-question", { status: "running", question: "选哪个？", starredAt: 1754900000000 }),
  task("todo-failed", { status: "failed" }),
  task("todo-await", { status: "done", stage: "awaiting_acceptance" }),
  // 干完了没盖章的两种年龄。stage 是 null 才是常态 —— 自由工作流只调 complete_task。
  task("todo-fresh-done", { status: "done", updatedAt: FRESH }),
  task("todo-stale-done", { status: "done" }),
  task("run-running", { status: "running" }),
  task("run-accepted-review", { status: "awaiting_review", stage: "accepted" }),
  task("wait-backlog", { status: "backlog", starredAt: 1754900001000 }),
  task("wait-paused", { status: "paused" }),
  // 「已收尾」这一档现在只剩取消掉的：干完的要么盖了章（验收完成）、要么还等着我（需要你处理）。
  task("done-canceled", { status: "canceled" }),
  task("accepted-merged", { status: "done", stage: "merged" }),
  // 下面三条都不该进计数：执行者不是顶层行、归档的不在树里、别的项目也不在。
  // 执行者/归档行就算带着星也不算——它们根本不在树里。
  task("worker", { status: "running", parentId: "run-running", starredAt: 1754900002000 }),
  task("archived", { status: "done", archived: true, starredAt: 1754900003000 }),
  task("other-project", { status: "running", projectId: "p2" }),
  // 接力出去、此刻在持有机上跑着（status 是 useOutboundState 从对端问回来合并进去的）。
  task("handed-out", { status: "running", handoff: { direction: "out", pending: false }, starredAt: 1754900004000 }),
];

const counts = spreadCounts(tasks, P1);
assert.equal(counts.all, 11);
assert.equal(counts.starred, 2);
assert.equal(counts.todo, 5);
assert.equal(counts.run, 2);
assert.equal(counts.wait, 2);
assert.equal(counts.done, 1);
assert.equal(counts.accepted, 1);

// 「等我盖章」只问一件事：盖没盖章。年龄不参与 —— 老账和刚收尾的必须同档,否则又会变成
// 「界面写着完成待验收、列表里却找不到」。
assert.ok(isTaskAwaitingAcceptance(task("x", { status: "done" })), "两个月前干完没盖章的照样是等我盖章");
assert.ok(isTaskAwaitingAcceptance(task("x", { status: "done", updatedAt: FRESH })));
assert.equal(spreadBucket(task("x", { status: "done" })), "todo");
assert.equal(spreadBucket(task("x", { status: "done", updatedAt: FRESH })), "todo");
assert.ok(isTaskAwaitingAcceptance(task("x", { status: "done", stage: "awaiting_acceptance" })));
// 盖过章的一律不算。
assert.ok(!isTaskAwaitingAcceptance(task("x", { status: "done", stage: "accepted", updatedAt: FRESH })));
assert.ok(!isTaskAwaitingAcceptance(task("x", { status: "done", stage: "merged" })));
assert.ok(!isTaskAwaitingAcceptance(task("x", { status: "canceled", updatedAt: FRESH })), "取消掉的不是等我盖章");
assert.ok(!isTaskAwaitingAcceptance(task("x", { status: "running" })), "还在跑的不是等我盖章");

// 五个桶互斥且铺满：加起来必须正好是「全部」，否则筛选条上的数字自己就打架了。
// 星标不进这笔账 —— 它跟桶正交，进来就会重复计。
assert.equal(
  BUCKET_FILTERS.reduce((sum, item) => sum + counts[item.key], 0),
  counts.all,
);

// 计数和列表是两处代码：这里钉住它们同一个口径 —— 按钮上写 3 条，点开只剩 1 条是最难查的那种 bug。
const rows = orderedTopLevelTasks(
  scopeTasks(tasks.filter((row) => !row.archived), P1),
  { unifiedPinned: true },
);
assert.equal(rows.length, counts.all);
for (const item of SPREAD_DOT_FILTERS) {
  assert.equal(
    rows.filter((row) => matchesSpreadFilter(row, item.key, workersFrom(indexWorkers(tasks), row.id))).length,
    counts[item.key],
    item.key,
  );
}

// matchesSpreadFilter 与 spreadBucket 对桶档同口径；星标档只认 starredAt。
const workerIndex = indexWorkers(tasks);
for (const row of rows) {
  const rowWorkers = workersFrom(workerIndex, row.id);
  for (const item of BUCKET_FILTERS) {
    assert.equal(
      matchesSpreadFilter(row, item.key, rowWorkers),
      spreadBucket(row, rowWorkers) === item.key,
      `${row.id}:${item.key}`,
    );
  }
  assert.equal(matchesSpreadFilter(row, "starred", rowWorkers), row.starredAt != null, `${row.id}:starred`);
  assert.equal(matchesSpreadFilter(row, "all", rowWorkers), true);
}

// J/K 快捷键遍历的可见列表（spreadVisibleTasks）必须与树同口径。它曾在调用点自己拼
// `spreadBucket === filter`：starred 不是桶，星标筛选下快捷键拿到空数组、按键被吞。
for (const item of SPREAD_FILTERS) {
  assert.deepEqual(
    spreadVisibleTasks(tasks, P1, item.key).map((row) => row.id),
    rows.filter((row) => matchesSpreadFilter(row, item.key, workersFrom(indexWorkers(tasks), row.id))).map((row) => row.id),
    `visible:${item.key}`,
  );
}
assert.equal(spreadVisibleTasks(tasks, P1, "starred").length, counts.starred);

// 空项目：每一档都是 0，点还是画满一排（画不出来就没地方取消筛选了）。
const empty = spreadCounts(tasks, P3);
assert.equal(empty.all, 0);
assert.equal(SPREAD_DOT_FILTERS.reduce((sum, item) => sum + empty[item.key], 0), 0);

// 「任务模式」作用域：跨项目，但只收三类顶层行 —— 在跑、等我说句话（提问 / 停在检查点）、
// 等我盖章（干完了没点头，不看年龄）。它回答的是「此刻还没落地的活有哪些」，
// 而不是「所有项目的任务摊开」。执行者与归档行照旧排除。
const taskMode = spreadCounts(tasks, TASKS);
const taskModeRows = spreadVisibleTasks(tasks, TASKS, "all").map((row) => row.id);
assert.deepEqual(taskModeRows.sort(), [
  "other-project",   // 别的项目，在跑 —— 单项目口径下看不见，任务模式里要看见
  "run-accepted-review", // awaiting_review：机器确实在动
  "run-running",
  "todo-await",      // stage=awaiting_acceptance，明着停在验收关口上
  "todo-fresh-done", // 刚干完、没盖章 —— 这才是「完成待验收」的常态形状（stage 是 null）
  "todo-stale-done", // 两个月前干完、也没盖章 —— 同样没落地，年龄不是判据
  "todo-question",   // status=running，在跑（被问住也还挂在 running 上）
  "wait-paused",     // 停在检查点，等我说句话才走得下去
  "handed-out",      // 接力出去了，但它在持有机上跑着 —— 一样是「还没落地的活」
].sort());
// 排着的、失败的、已验收的、归档的、执行者、接力走了的、取消掉的，一个都不进。
for (const id of ["wait-backlog", "todo-failed", "accepted-merged", "archived", "worker", "done-canceled"]) {
  assert.ok(!taskModeRows.includes(id), `任务模式不该收 ${id}`);
}
assert.equal(taskMode.all, taskModeRows.length);
assert.equal(
  BUCKET_FILTERS.reduce((sum, item) => sum + taskMode[item.key], 0),
  taskMode.all,
);
// 计数与列表同口径（跟单项目态一样的钉子，换个作用域再钉一次）。
for (const item of SPREAD_DOT_FILTERS) {
  assert.equal(
    spreadVisibleTasks(tasks, TASKS, item.key).length,
    taskMode[item.key],
    `taskMode:${item.key}`,
  );
}

// 接力出去的行：单项目态里不进主列表（它们归下方「其他机器」那一节，两处都画就是同一条
// 任务在侧栏出现两次），任务模式里照收 —— 那一档问的是「还没落地的活」，活在哪台机器上
// 不是它关心的维度。这是同一个判据的两面，谁漂了另一面就自相矛盾。
assert.ok(!rows.some((row) => row.id === "handed-out"), "单项目态的主列表不收接力出去的行");
assert.equal(counts.run, 2, "单项目态的计数也不该把它算进来");

// 团队要连执行者一起判：调度台派完活自己落回 idle，只盯它会把正在干活的团队判成静止，
// 也会把「执行者卡在提问上」的团队判成没事发生。
const teamTasks = [
  task("team-live", { mode: "team", status: "idle" }),
  task("team-live-w", { status: "running", parentId: "team-live" }),
  task("team-settled", { mode: "team", status: "idle" }),
  task("team-settled-w", { status: "done", parentId: "team-settled" }),
  // 刚收工、还没盖章的团队：调度台自己没有 done 终态，「干完了」只写在执行者身上，
  // 所以这一档也得连执行者一起判，否则团队永远进不了「待验收」。
  task("team-fresh", { mode: "team", status: "idle", updatedAt: FRESH }),
  task("team-fresh-w", { status: "done", parentId: "team-fresh", updatedAt: FRESH }),  task("team-accepted", { mode: "team", status: "idle", stage: "accepted" }),
  task("team-accepted-w", { status: "done", parentId: "team-accepted" }),
  task("team-asking", { mode: "team", status: "idle" }),
  task("team-asking-w", { status: "paused", question: "选哪个？", parentId: "team-asking" }),
  task("team-never", { mode: "team", status: "backlog" }),
];
const teamRows = scopeTasks(teamTasks, TASKS).map((row) => row.id);
assert.ok(teamRows.includes("team-live"), "执行者在跑 = 团队在跑");
assert.ok(teamRows.includes("team-asking"), "执行者卡在提问上 = 这个团队等我说句话");
assert.ok(teamRows.includes("team-fresh"), "刚收工没盖章的团队 = 等我盖章");
assert.ok(teamRows.includes("team-settled"), "收工很久也没盖章的团队一样 = 等我盖章");
assert.ok(!teamRows.includes("team-accepted"), "盖过章的团队不再出现");
assert.ok(!teamRows.includes("team-never"), "从没开过台的团队不算还没落地的活");
// 留下的团队要把自己的执行者一起带上，否则团队行的展开箭头是灰的、执行者摘要空一片。
assert.ok(teamRows.includes("team-live-w"));
assert.ok(teamRows.includes("team-asking-w"));
assert.ok(teamRows.includes("team-fresh-w"));
assert.ok(teamRows.includes("team-settled-w"));
assert.ok(!teamRows.includes("team-accepted-w"));

// **入选判据和状态桶必须是同一套。** 团队调度台自己常年停在 idle，只读它那一行的话
// 满负荷的团队和早就干完的团队都会落进 wait，于是任务模式的筛选条上冒出一档
// 「排着 / 暂停 · 1」—— 点开是一条「已完成，等你验收」。桶也得问执行者。
const teamIndex = indexWorkers(teamTasks);
const bucketOf = (id) => spreadBucket(teamTasks.find((row) => row.id === id), workersFrom(teamIndex, id));
assert.equal(bucketOf("team-live"), "run", "执行者在跑的团队要读作「在跑」");
assert.equal(bucketOf("team-settled"), "todo", "收了工没盖章 = 需要你处理，跟单飞 done 一个待遇");
assert.equal(bucketOf("team-fresh"), "todo", "刚收工没盖章同理，年龄不是判据");
assert.equal(bucketOf("team-accepted"), "accepted", "盖过章的团队仍归「验收完成」，别被 done 抢走");
assert.equal(bucketOf("team-asking"), "todo", "执行者的问题最后要你来答 = 需要你处理");
assert.equal(bucketOf("team-never"), "wait", "从没开过台的团队才是真的「排着」");

const teamCounts = spreadCounts(teamTasks, TASKS);
assert.equal(teamCounts.run, 1);
assert.equal(teamCounts.todo, 3, "卡在提问上的 + 两个收了工等盖章的");
assert.equal(teamCounts.done, 0, "干完的团队要么等我盖章、要么已验收，落不到「已收尾」");
assert.equal(teamCounts.accepted, 0);

// 任务模式的口径承诺落在筛选条上就是这一条：**进得来的行只会落在 在跑 / 需要你处理 /
// 排着·暂停 三档里**，而且落进「排着 · 暂停」的必须真的有人停着或在等答复。
// 一旦漂了，用户就会在一个自称「只收还没落地的活」的模式里读到「已收尾」「验收完成」。
const MODE_BUCKETS = new Set(["run", "todo", "wait"]);
const STATUSES = ["backlog", "queued", "running", "idle", "awaiting_review", "paused", "done", "failed", "canceled"];
const STAGES = [null, "implemented", "verifying", "verified", "verify_failed", "awaiting_acceptance", "merged", "accepted"];
// 执行者集合里带上「停着」和「卡在提问上」两种：团队的这两种态只写在执行者身上。
const WORKER_SETS = [
  [],
  [{ status: "running" }],
  [{ status: "queued" }],
  [{ status: "paused" }],
  [{ status: "paused", question: "选哪个？" }],
  [{ status: "done" }],
  [{ status: "done" }, { status: "failed" }],
  [{ status: "running" }, { status: "done" }],
];
let checked = 0;
for (const mode of ["single", "team"]) {
  for (const status of STATUSES) {
    for (const stage of STAGES) {
      for (const question of [null, "选哪个？"]) {
        // 年龄也进穷举：「待验收」带时限，只跑一种年龄等于半条不变式没钉。
        for (const [age, updatedAt] of [["旧", STALE], ["新", FRESH]]) {
          for (const workerSpecs of WORKER_SETS) {
            const lead = task("lead", { mode, status, stage, question, updatedAt });
            const workers = workerSpecs.map((spec, at) => task(`w${at}`, { parentId: "lead", updatedAt, ...spec }));
            if (!inTaskMode(lead, workers)) continue;
            checked += 1;
            const where = `${mode}/${status}/${stage}/${question ? "问" : "不问"}/${age}/[${workerSpecs.map((spec) => spec.status).join(",")}]`;
            const bucket = spreadBucket(lead, workers);
            assert.ok(MODE_BUCKETS.has(bucket), `任务模式收了 ${where}，桶却是 ${bucket}`);
            if (bucket === "wait") {
              assert.ok(awaitsYourWord(lead, workers), `${where} 落进「排着 · 暂停」，却没人在等我说话`);
            }
          }
        }
      }
    }
  }
}
assert.ok(checked > 100, `穷举样本太少（${checked}），这条不变式等于没钉`);

// 筛选控件画在哪一档：只有「选中了某个项目的单项目态」有。任务模式没有 —— 它自己就是
// 一次筛选，那排点里两颗永远是 0、剩下三颗在二三十行上再切一刀（见 taskScope 的判据）。
// useSidebarSpread 读同一条判据把生效值归一到「全部」，所以这里漂了，任务模式就会出现
// 一份被悄悄筛过、却没有开关的列表。
assert.equal(scopeHasFilters(P1), true);
assert.equal(scopeHasFilters({ kind: "project", projectId: null }), false, "还没选项目时没有可筛的树");
assert.equal(scopeHasFilters(TASKS), false, "任务模式不带状态筛选");

// URL 是权威：带 scope=tasks 就读任务模式，带深链（project/task）而没写 scope 的按单项目读，
// 两者都没有才回落到上次的选择。顺序反了会出现「后退回到任务模式却缩成一家」。
assert.equal(resolveScopeKind("?scope=tasks", "project"), "tasks");
assert.equal(resolveScopeKind("?scope=project", "tasks"), "project");
assert.equal(resolveScopeKind("?project=p1&task=t1", "tasks"), "project");
assert.equal(resolveScopeKind("", "tasks"), "tasks");
assert.equal(resolveScopeKind("", null), "project");
assert.equal(resolveScopeKind("?scope=bogus", "tasks"), "tasks");
// 这一档从前叫「全部项目」，写进 URL / localStorage 的是 scope=all。旧链接和旧落盘
// 还在外面跑着，读的时候一律归到 tasks，别让它们悄悄退回单项目态。
assert.equal(resolveScopeKind("?scope=all", "project"), "tasks");
assert.equal(resolveScopeKind("", "all"), "tasks");

console.log("spread filter counting tests passed");
