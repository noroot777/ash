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
import { resolveScopeKind, scopeHasTarget, scopeTasks } from "../src/workspace/taskScope.ts";
import { inTaskMode } from "../src/lib/taskAttention.ts";

const P1 = { kind: "project", projectId: "p1" };
const P3 = { kind: "project", projectId: "p3" };
const TASKS = { kind: "tasks" };

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
    updatedAt: "2026-08-01T00:00:00.000Z",
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
  task("run-running", { status: "running" }),
  task("run-accepted-review", { status: "awaiting_review", stage: "accepted" }),
  task("wait-backlog", { status: "backlog", starredAt: 1754900001000 }),
  task("done-done", { status: "done" }),
  task("accepted-merged", { status: "done", stage: "merged" }),
  // 下面三条都不该进计数：执行者不是顶层行、归档的不在树里、别的项目也不在。
  // 执行者/归档行就算带着星也不算——它们根本不在树里。
  task("worker", { status: "running", parentId: "run-running", starredAt: 1754900002000 }),
  task("archived", { status: "done", archived: true, starredAt: 1754900003000 }),
  task("other-project", { status: "running", projectId: "p2" }),
  task("handed-out", { status: "done", handoff: { direction: "out", pending: false }, starredAt: 1754900004000 }),
];

const counts = spreadCounts(tasks, P1);
assert.equal(counts.all, 8);
assert.equal(counts.starred, 2);
assert.equal(counts.todo, 3);
assert.equal(counts.run, 2);
assert.equal(counts.wait, 1);
assert.equal(counts.done, 1);
assert.equal(counts.accepted, 1);

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

// 「任务模式」作用域：跨项目，但只收「在跑」和「待验收」两类顶层行 —— 它回答的是
// 「此刻还没落地的活有哪些」，而不是「所有项目的任务摊开」。执行者与归档行照旧排除。
const taskMode = spreadCounts(tasks, TASKS);
const taskModeRows = spreadVisibleTasks(tasks, TASKS, "all").map((row) => row.id);
assert.deepEqual(taskModeRows.sort(), [
  "other-project",   // 别的项目，在跑 —— 单项目口径下看不见，任务模式里要看见
  "run-accepted-review", // awaiting_review：机器确实在动
  "run-running",
  "todo-await",      // stage=awaiting_acceptance，就是「待验收」
  "todo-question",   // status=running，在跑（被问住也还挂在 running 上）
  "done-done",       // done 且没盖过章 = 等我验收
].sort());
// 排着的、失败的、已验收的、归档的、执行者、接力走了的，一个都不进。
for (const id of ["wait-backlog", "todo-failed", "accepted-merged", "archived", "worker", "handed-out"]) {
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

// 团队要连执行者一起判：调度台派完活自己落回 idle，只盯它会把正在干活的团队判成静止，
// 也会把还没收工的团队判成等验收。
const teamTasks = [
  task("team-live", { mode: "team", status: "idle" }),
  task("team-live-w", { status: "running", parentId: "team-live" }),
  task("team-settled", { mode: "team", status: "idle" }),
  task("team-settled-w", { status: "done", parentId: "team-settled" }),
  task("team-accepted", { mode: "team", status: "idle", stage: "accepted" }),
  task("team-accepted-w", { status: "done", parentId: "team-accepted" }),
  task("team-never", { mode: "team", status: "backlog" }),
];
const teamRows = scopeTasks(teamTasks, TASKS).map((row) => row.id);
assert.ok(teamRows.includes("team-live"), "执行者在跑 = 团队在跑");
assert.ok(teamRows.includes("team-settled"), "团队收工没盖章 = 待验收");
assert.ok(!teamRows.includes("team-accepted"), "盖过章的团队不再出现");
assert.ok(!teamRows.includes("team-never"), "从没开过台的团队不算收工");
// 留下的团队要把自己的执行者一起带上，否则团队行的展开箭头是灰的、执行者摘要空一片。
assert.ok(teamRows.includes("team-live-w"));
assert.ok(teamRows.includes("team-settled-w"));
assert.ok(!teamRows.includes("team-accepted-w"));

// **入选判据和状态桶必须是同一套。** 团队调度台自己常年停在 idle，只读它那一行的话
// 满负荷的团队和早就干完的团队都会落进 wait，于是任务模式的筛选条上冒出一档
// 「排着 / 暂停 · 1」—— 点开是一条「已完成，等你验收」。桶也得问执行者。
const teamIndex = indexWorkers(teamTasks);
const bucketOf = (id) => spreadBucket(teamTasks.find((row) => row.id === id), workersFrom(teamIndex, id));
assert.equal(bucketOf("team-live"), "run", "执行者在跑的团队要读作「在跑」");
assert.equal(bucketOf("team-settled"), "done", "收了工的团队跟单飞 done 同义，不是「排着 / 暂停」");
assert.equal(bucketOf("team-accepted"), "accepted", "盖过章的团队仍归「验收完成」，别被 done 抢走");
assert.equal(bucketOf("team-never"), "wait", "从没开过台的团队才是真的「排着」");

// 任务模式的口径承诺（只收在跑 / 待验收）落在筛选条上就是这一条：**wait 恒为 0**。
// 一旦它非零，用户就会在一个自称「只有在跑和待验收」的模式里读到「排着 / 暂停」。
const teamCounts = spreadCounts(teamTasks, TASKS);
assert.equal(teamCounts.wait, 0, "任务模式里不该出现「排着 / 暂停」");
assert.equal(spreadVisibleTasks(teamTasks, TASKS, "wait").length, 0);
assert.equal(taskMode.wait, 0, "任务模式里不该出现「排着 / 暂停」");
assert.equal(spreadVisibleTasks(tasks, TASKS, "wait").length, 0);
assert.equal(teamCounts.run, 1);
assert.equal(teamCounts.done, 1);

// 穷举一遍把上面那条不变式钉死：**进得了任务模式的行，绝不会落进 wait 桶**。
// 两处判据（inTaskMode / spreadBucket）以后各自演化时，谁先漂了这里就红。
const STATUSES = ["backlog", "queued", "running", "idle", "awaiting_review", "paused", "done", "failed", "canceled"];
const STAGES = [null, "implemented", "verifying", "verified", "verify_failed", "awaiting_acceptance", "merged", "accepted"];
const WORKER_SETS = [[], ["running"], ["queued"], ["paused"], ["done"], ["done", "failed"], ["running", "done"]];
let checked = 0;
for (const mode of ["single", "team"]) {
  for (const status of STATUSES) {
    for (const stage of STAGES) {
      for (const question of [null, "选哪个？"]) {
        for (const workerStatuses of WORKER_SETS) {
          const lead = task("lead", { mode, status, stage, question });
          const workers = workerStatuses.map((workerStatus, at) =>
            task(`w${at}`, { parentId: "lead", status: workerStatus }));
          if (!inTaskMode(lead, workers)) continue;
          checked += 1;
          assert.notEqual(
            spreadBucket(lead, workers),
            "wait",
            `任务模式收了 ${mode}/${status}/${stage}/${question ? "问" : "不问"}/[${workerStatuses}]，桶却是 wait`,
          );
        }
      }
    }
  }
}
assert.ok(checked > 100, `穷举样本太少（${checked}），这条不变式等于没钉`);

// 还没选项目时，单项目态没有可显示的树；任务模式永远有目标（筛选条因此照常画出来）。
assert.equal(scopeHasTarget({ kind: "project", projectId: null }), false);
assert.equal(scopeHasTarget(TASKS), true);

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
