// 「派出的任务收在派它的那条下面」的模型层：侧栏收纳（dispatchForest）和右侧那一格的几样字
// （dispatchedRows）。浏览器里那一半（展开记在本机、选中收着的那条要看得见、团队执行者不变）
// 在 test-dispatch-tree-dom.mjs。
// 跑：npm -w web run test:dispatch-tree
import assert from "node:assert/strict";
import {
  buildDispatchForest, forestLatest, forestRoot, keepForestVisible, sortRootsByLatest,
} from "../src/workspace/dispatchForest.ts";
import { dispatchedOf, dispatchFacts, dispatchSubtree, dispatchTally, dispatchTallySaid } from "../src/lib/dispatchTree.ts";
import { taskParentLink, taskParentRelation } from "../src/lib/taskParent.ts";
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
  const facts = dispatchFacts([lead, busyKid, grand, other]);
  assert.equal(facts.needsYou("lead"), true, "孙辈在等答复，顶上那个数也得变色");
  assert.equal(facts.needsYou("grand"), false);
  assert.equal(dispatchFacts([task("x"), task("y", { dispatchedBy: "x", status: "failed", stage: null })]).needsYou("x"), true, "失败也算");
  assert.equal(dispatchFacts([task("x"), task("y", { dispatchedBy: "x", status: "running", stage: null })]).needsYou("x"), false, "在跑的不算要你处理");
  assert.equal(forestLatest(forest, lead), ago(1));
  assert.deepEqual(ids(sortRootsByLatest(forest, [other, lead])), ["lead", "other"], "名下刚动过，这一行就排上来");
  const keep = keepForestVisible(forest, () => false, 24 * HOUR, () => NOW);
  assert.equal(keep(lead), true, "自己旧、名下新：不进年龄闸，名下才看得见");
  assert.equal(keep(task("stale")), false);
}

// —— 那个数和颜色是关系事实，从全量算：筛选（星标、状态）、置顶把名下几条从画出来的行里拿掉了，
//    数照旧、该变色照旧变色。归档的、团队执行者不算。
{
  const lead = task("lead", { starredAt: 1 });
  const failed = task("failed-kid", { dispatchedBy: "lead", status: "failed", stage: null });
  const pinned = task("pinned-kid", { dispatchedBy: "lead", pinnedAt: 5 });
  const all = [
    lead, failed, pinned,
    task("archived-kid", { dispatchedBy: "lead", archived: true, status: "failed", stage: null }),
    task("worker", { dispatchedBy: "lead", parentId: "team", status: "failed", stage: null }),
  ];
  const starredOnly = buildDispatchForest(all.filter((row) => row.starredAt != null));
  assert.equal(starredOnly.children.get("lead"), undefined, "星标筛选下名下几条都不在画出来的行里");
  const facts = dispatchFacts(all);
  assert.equal(facts.count("lead"), 2, "数不随筛选、置顶变（归档的、团队执行者不算）");
  assert.equal(facts.needsYou("lead"), true, "名下失败的那条被筛掉了，也还得变色");
  assert.equal(facts.count("lead"), dispatchedOf(all, "lead").length, "跟右侧那一格同一个口径");
  assert.equal(facts.count("nobody"), 0);
  const cyclic = dispatchFacts([task("a", { dispatchedBy: "b" }), task("b", { dispatchedBy: "a", status: "failed", stage: null })]);
  assert.equal(cyclic.needsYou("a"), true, "成环也走得完");
}

// —— 中间那条归档了：顺着关系往下走照样走得过去（归档不等于名下那几条跟上面断了），只是归档的
//    那条自己不算数、不算要你处理。
{
  const bridged = [
    task("a"),
    task("b", { dispatchedBy: "a", archived: true }),
    task("c", { dispatchedBy: "b", status: "failed", stage: null }),
    task("d", { dispatchedBy: "a" }),
  ];
  const facts = dispatchFacts(bridged);
  assert.equal(facts.count("a"), 1, "数只算没归档的直接那几条（跟右侧那一格一样）");
  assert.equal(facts.needsYou("a"), true, "中间那条归档了，底下失败着的那条照样让最上面变色");
  assert.equal(facts.count("b"), 1);
  assert.equal(dispatchedOf(bridged, "a").length, 1);

  const allArchived = dispatchFacts([
    task("a"),
    task("b", { dispatchedBy: "a", archived: true }),
    task("c", { dispatchedBy: "b", status: "paused", stage: null, question: "？" }),
  ]);
  assert.equal(allArchived.count("a"), 0, "直接那几条全归档了，数是 0");
  assert.equal(allArchived.needsYou("a"), true, "……底下还有一条在等你，照样变色");

  const archivedFailure = dispatchFacts([task("a"), task("x", { dispatchedBy: "a", archived: true, status: "failed", stage: null })]);
  assert.equal(archivedFailure.needsYou("a"), false, "归档了的失败是用户收起来的，不再算要你处理");
  assert.equal(archivedFailure.hasBelow("a"), false, "名下全归档、底下也没别的：不算父任务");

  // 中间那条归档了、底下那条只是在跑（不算要你处理、数也是 0）：上面那条照样是父任务，行尾要说它在跑。
  const archivedMiddle = dispatchFacts([
    task("a"),
    task("b", { dispatchedBy: "a", archived: true }),
    task("c", { dispatchedBy: "b", status: "running", stage: null }),
  ]);
  assert.deepEqual([archivedMiddle.count("a"), archivedMiddle.needsYou("a"), archivedMiddle.hasBelow("a")], [0, false, true]);
  assert.equal(dispatchFacts([task("a"), task("b", { dispatchedBy: "a", stage: null, disputeOpen: true })]).needsYou("a"), true, "等你裁定也算要你处理");
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

// —— 从一条任务里切出来的（裁定「转成独立任务」、合并结果审查的修复任务）：收在来源下面，和派出去的
//    是同一棵树。转出的再转出一条，一层一层往下收；最上面那条的变色判据算得到最底下那条。
{
  const top = task("top");
  const src = task("src", { dispatchedBy: "top" });
  const cut = task("cut", { dispatchedBy: "src", originTaskId: "src", status: "backlog", stage: null });
  const deeper = task("deeper", { dispatchedBy: "cut", originTaskId: "cut", status: "failed", stage: null });
  const all = [deeper, cut, src, top];
  const forest = buildDispatchForest(all);
  assert.deepEqual(ids(forest.children.get("top")), ["src"]);
  assert.deepEqual(ids(forest.children.get("src")), ["cut"], "切出来的收在来源那一行下面");
  assert.deepEqual(ids(forest.children.get("cut")), ["deeper"], "转出的再转出：收在转出的那条下面");
  assert.equal(forestRoot(forest, "deeper"), "top");
  const facts = dispatchFacts(all);
  assert.deepEqual(["top", "src", "cut"].map((id) => facts.count(id)), [1, 1, 1], "每一层的数只数直接名下的");
  assert.deepEqual(["top", "src", "cut", "deeper"].map((id) => facts.needsYou(id)), [true, true, true, false],
    "最底下那条失败了：来源和更上面各层都变色");
  const calm = dispatchFacts([top, src, cut, { ...deeper, status: "running" }]);
  assert.equal(calm.needsYou("top"), false, "底下在跑不算要你处理");
}

// —— 右侧「派出的任务」格里的一行带不带数：自己名下还有任务才带，跟侧栏那一行同一个数、同一个
//    变色判据；名下没有任务的行不带。
{
  const all = [
    task("top"),
    task("src", { dispatchedBy: "top" }),
    task("plain", { dispatchedBy: "top" }),
    task("cut", { dispatchedBy: "src", originTaskId: "src", status: "running", stage: null }),
  ];
  const facts = dispatchFacts(all);
  assert.deepEqual(dispatchTally(facts, "src"), { count: 1, warn: false }, "名下还有任务的那一行带数");
  assert.equal(dispatchTally(facts, "plain"), null, "名下没有任务的行不带数");
  assert.equal(dispatchTally(facts, "cut"), null);
  const failing = dispatchFacts(all.map((row) => (row.id === "cut" ? { ...row, status: "failed" } : row)));
  assert.deepEqual(dispatchTally(failing, "src"), { count: 1, warn: true }, "底下有要你处理的：数变色");
  assert.deepEqual(dispatchTally(failing, "top"), { count: 2, warn: true });
  assert.equal(dispatchTallySaid({ count: 1, warn: true }), "1 个派出的任务，有要你处理的");
  assert.equal(dispatchTallySaid({ count: 2, warn: false }), "2 个派出的任务");
  const buried = dispatchFacts([
    task("a"), task("b", { dispatchedBy: "a", archived: true }),
    task("c", { dispatchedBy: "b", status: "paused", stage: null, question: "？" }),
  ]);
  assert.deepEqual(dispatchTally(buried, "a"), { count: 0, warn: true }, "直接那几条全归档了、底下还在等你：变色的 0（同侧栏）");
  const quiet = dispatchFacts([
    task("a"), task("b", { dispatchedBy: "a", archived: true }),
    task("c", { dispatchedBy: "b", status: "running", stage: null }),
    task("d"), task("e", { dispatchedBy: "d", archived: true }),
  ]);
  assert.deepEqual(dispatchTally(quiet, "a"), { count: 0, warn: false }, "更底下还有没归档的：照样带数（同侧栏认父任务的口径）");
  assert.equal(dispatchTally(quiet, "d"), null, "名下全归档了、底下也没有：不带数");
}

// —— 任务头那句来源：切出来的那条仍写「来自任务」（它不是谁派的），派出去的写「派它的任务」。
{
  const all = [
    task("src", { title: "来源那条" }),
    task("cut", { dispatchedBy: "src", originTaskId: "src", creationOrigin: { kind: "system" } }),
    task("sent", { dispatchedBy: "src", creationOrigin: { kind: "agent", taskId: "src" } }),
    task("by-hand", { dispatchedBy: "src", creationOrigin: { kind: "user" } }),
    // 派出去的活同时回链到派它的那条：不是系统切出来的，照旧是「派它的任务」。
    task("sent-linked", { dispatchedBy: "src", originTaskId: "src", creationOrigin: { kind: "agent", taskId: "src" } }),
    task("by-hand-linked", { dispatchedBy: "src", originTaskId: "src", creationOrigin: { kind: "user" } }),
    task("unrecorded-linked", { dispatchedBy: "src", originTaskId: "src", creationOrigin: null }),
    task("system-elsewhere", { dispatchedBy: "src", originTaskId: "talk", creationOrigin: { kind: "system" } }),
    task("fork", { originTaskId: "src", creationOrigin: { kind: "user" } }),
    task("talk", { mode: "duet" }),
    task("landed", { originTaskId: "talk" }),
    task("team", { mode: "team" }),
    task("worker", { parentId: "team", dispatchedBy: "src", originTaskId: "src" }),
  ];
  const said = (id) => {
    const link = taskParentLink(all.find((row) => row.id === id), all);
    return link && `${taskParentRelation(link)}·${link.taskId}`;
  };
  assert.equal(said("cut"), "来自任务·src", "裁定转出 / 合并结果修复建的任务：收在来源下面，任务头照旧说来自任务");
  assert.equal(said("sent"), "派它的任务·src", "智能体派出去的照旧");
  assert.equal(said("by-hand"), "派它的任务·src", "回复框、派活单派出去的照旧");
  assert.equal(said("sent-linked"), "派它的任务·src", "智能体派的、同时回链到派它的那条：不是切出来的");
  assert.equal(said("by-hand-linked"), "派它的任务·src", "你派的、同时回链到派它的那条：不是切出来的");
  assert.equal(said("unrecorded-linked"), "派它的任务·src", "创建来源没记的不当成系统切出来的");
  assert.equal(said("system-elsewhere"), "派它的任务·src", "收在别处名下、不是自己的来源：不算从那条里切出来");
  assert.equal(said("fork"), "来自任务·src", "手动派生的（不在树里）照旧");
  assert.equal(said("landed"), "来自讨论·talk");
  assert.equal(said("worker"), "所属团队·team", "团队执行者照旧以团队为准");
  assert.equal(said("src"), null);
}

console.log("dispatch tree model ok");
