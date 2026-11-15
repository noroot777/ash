// 「派出的任务收在派它的那条下面」的模型层：侧栏收纳（dispatchForest）和右侧那一格的几样字
// （dispatchedRows）。浏览器里那一半（展开记在本机、选中收着的那条要看得见、团队执行者不变）
// 在 test-dispatch-tree-dom.mjs。
// 跑：npm -w web run test:dispatch-tree
import assert from "node:assert/strict";
import {
  buildDispatchForest, forestLatest, forestNeedsYou, forestRoot, keepForestVisible, sortRootsByLatest,
} from "../src/workspace/dispatchForest.ts";
import { dispatchedOf, dispatchSubtree } from "../src/lib/dispatchTree.ts";
import { dispatchedMeta, dispatchedOrder, dispatchedWord } from "../src/task-detail/dispatched/dispatchedRows.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();

function task(id, extra = {}) {
  return {
    id, projectId: "p1", groupId: null, parentId: null, title: id, mode: "single", status: "done", stage: "accepted",
    pinnedAt: null, starredAt: null, question: null, archived: false, queueId: null, dispatchedBy: null,
    createdAt: ago(48), updatedAt: ago(48), ...extra,
  };
}

const ids = (rows) => rows.map((row) => row.id);

// —— 收纳只在画出来的那批行之间：派它的那条在，就收进去；不在（归档、被筛掉、在别的项目），照常平铺。
{
  const lead = task("lead");
  const kidA = task("kid-a", { dispatchedBy: "lead", createdAt: ago(40) });
  const kidB = task("kid-b", { dispatchedBy: "lead", createdAt: ago(30) });
  const orphan = task("orphan", { dispatchedBy: "archived-or-filtered" });
  const forest = buildDispatchForest([kidB, lead, orphan, kidA]);
  assert.deepEqual(ids(forest.children.get("lead")), ["kid-a", "kid-b"], "名下按派出的先后排");
  assert.ok(forest.nested.has("kid-a") && forest.nested.has("kid-b"));
  assert.ok(!forest.nested.has("orphan"), "派它的那条不在列表里时，派出的任务照常平铺，不能跟着消失");
  assert.ok(!forest.nested.has("lead"));

  // 同一批任务，派它的那条被筛掉之后：名下的全回到顶层。
  const filtered = buildDispatchForest([kidA, kidB, orphan]);
  assert.equal(filtered.nested.size, 0, "派它的那条被筛掉 = 名下照常平铺");
}

// —— 置顶的不收进别人底下；团队执行者（parentId）从来不进这一层。
{
  const forest = buildDispatchForest([
    task("lead"),
    task("pinned-kid", { dispatchedBy: "lead", pinnedAt: 10 }),
    task("worker", { dispatchedBy: "lead", parentId: "team-1" }),
    task("plain-kid", { dispatchedBy: "lead" }),
  ]);
  assert.deepEqual(ids(forest.children.get("lead")), ["plain-kid"]);
  assert.ok(!forest.nested.has("pinned-kid"), "置顶是用户手动摁下的，留在置顶区");
  assert.ok(!forest.nested.has("worker"), "团队执行者归它的团队，不归派活人");
}

// —— 多层：派出去的任务自己又派了任务，收在它自己下面；最顶上那一条认得出。
{
  const forest = buildDispatchForest([
    task("root"),
    task("mid", { dispatchedBy: "root" }),
    task("leaf", { dispatchedBy: "mid" }),
  ]);
  assert.deepEqual(ids(forest.children.get("root")), ["mid"]);
  assert.deepEqual(ids(forest.children.get("mid")), ["leaf"]);
  assert.equal(forestRoot(forest, "leaf"), "root", "收在两层底下的那条，藏在年龄闸里的是最顶上那一行");
  assert.equal(forestRoot(forest, "root"), "root");
  assert.deepEqual(ids(dispatchSubtree(forest.children, "root")), ["mid", "leaf"]);
}

// —— 脏数据成环：环上每一条都还得看得见（拆一条回顶层），不能一起收没了。
{
  const forest = buildDispatchForest([
    task("a", { dispatchedBy: "b" }),
    task("b", { dispatchedBy: "a" }),
    task("c", { dispatchedBy: "c" }),
  ]);
  const roots = ["a", "b", "c"].filter((id) => !forest.nested.has(id));
  assert.ok(roots.length >= 1 && roots.includes("c"), "自己派自己的不收");
  const visible = new Set(roots.flatMap((id) => [id, ...ids(dispatchSubtree(forest.children, id))]));
  assert.deepEqual([...visible].sort(), ["a", "b", "c"], "成环的每一条都还画得出来");
}

// —— 名下整棵有在等答复 / 失败的，那个数变色；顺序与年龄闸按整棵算。
{
  const lead = task("lead", { updatedAt: ago(72) });
  const busyKid = task("kid", { dispatchedBy: "lead", updatedAt: ago(1), status: "running", stage: null });
  const grand = task("grand", { dispatchedBy: "kid", status: "paused", stage: null, question: "选哪个？" });
  const other = task("other", { updatedAt: ago(5) });
  const forest = buildDispatchForest([lead, busyKid, grand, other]);
  assert.equal(forestNeedsYou(forest, "lead"), true, "孙辈在等答复，顶上那个数也得变色");
  assert.equal(forestNeedsYou(forest, "grand"), false);
  assert.equal(forestNeedsYou(buildDispatchForest([task("x"), task("y", { dispatchedBy: "x", status: "failed", stage: null })]), "x"), true, "失败也算");
  assert.equal(forestNeedsYou(buildDispatchForest([task("x"), task("y", { dispatchedBy: "x", status: "running", stage: null })]), "x"), false, "在跑的不算要你处理");
  assert.equal(forestLatest(forest, lead), ago(1));
  assert.deepEqual(ids(sortRootsByLatest(forest, [other, lead])), ["lead", "other"], "名下刚动过，这一行就排上来");
  const keep = keepForestVisible(forest, () => false, 24 * HOUR, () => NOW);
  assert.equal(keep(lead), true, "自己旧、名下新：不进年龄闸，名下才看得见");
  assert.equal(keep(task("stale")), false);
}

// —— 右侧那一格：名下有谁（没归档、不是执行者）、状态词、一行小字、一个接一个还是同时。
{
  const all = [
    task("lead"),
    task("k2", { dispatchedBy: "lead", createdAt: ago(10) }),
    task("k1", { dispatchedBy: "lead", createdAt: ago(20) }),
    task("gone", { dispatchedBy: "lead", archived: true }),
    task("worker", { dispatchedBy: "lead", parentId: "team" }),
  ];
  assert.deepEqual(ids(dispatchedOf(all, "lead")), ["k1", "k2"]);

  assert.deepEqual(dispatchedWord(task("q", { status: "paused", stage: null, question: "？" })), { word: "等你答复", tone: "ask" });
  assert.deepEqual(dispatchedWord(task("f", { status: "failed", stage: null })), { word: "失败", tone: "bad" });
  assert.deepEqual(dispatchedWord(task("vf", { status: "done", stage: "verify_failed" })), { word: "未通过验证", tone: "bad" });
  assert.deepEqual(dispatchedWord(task("u", { status: "done", stage: null })), { word: "待验收", tone: null });
  assert.deepEqual(dispatchedWord(task("r", { status: "running", stage: null })), { word: "运行中", tone: null });
  assert.deepEqual(dispatchedWord(task("w", { status: "queued", stage: null })), { word: "排队中", tone: null });
  assert.deepEqual(dispatchedWord(task("ok", { status: "done", stage: "accepted" })), { word: "验收完成", tone: null });

  assert.equal(
    dispatchedMeta(task("m", { executorLabel: "codex@cpa", startedAt: ago(2), endedAt: ago(1) }), NOW),
    "codex@cpa · 用时 1h",
  );
  assert.equal(dispatchedMeta(task("n", { agentType: "claude" }), NOW), "claude");

  assert.equal(dispatchedOrder([task("a", { queueId: "q" }), task("b", { queueId: "q" })]), "一个接一个");
  assert.equal(dispatchedOrder([task("a"), task("b")]), "同时");
  assert.equal(dispatchedOrder([task("a", { queueId: "q" }), task("b")]), null, "混着派的不写");
  assert.equal(dispatchedOrder([task("a", { queueId: "q" })]), null, "一条谈不上先后");
}

console.log("dispatch tree model ok");
