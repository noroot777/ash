import assert from "node:assert/strict";
import { advanceHiddenReveal, buildTaskTree, groupTasksByProject, keepVisibleInPreview, orderedTopLevelTasks, previewTasksByAge } from "../src/workspace/taskTreeModel.ts";

function task(id, mode, {
  pinnedAt = null,
  starredAt = null,
  status = "done",
  stage = null,
  question = null,
  createdAt = "2026-08-01T00:00:00.000Z",
  updatedAt = createdAt,
} = {}) {
  return {
    id,
    mode,
    pinnedAt,
    starredAt,
    status,
    stage,
    question,
    createdAt,
    updatedAt,
    parentId: null,
    archived: false,
    projectId: "p1",
  };
}

// —— 第一原则：更新时间倒序。类型（团队 / 讨论 / 普通）不再把列表切开。
const mixed = [
  task("collab-pinned", "team", { pinnedAt: 100, updatedAt: "2026-08-01T00:00:00.000Z" }),
  task("single-pinned", "single", { pinnedAt: 200, updatedAt: "2026-08-02T00:00:00.000Z" }),
  task("collab-normal", "duet", { updatedAt: "2026-08-05T00:00:00.000Z" }),
  task("single-normal", "single", { updatedAt: "2026-08-06T00:00:00.000Z" }),
];

const unified = buildTaskTree(mixed, { unifiedPinned: true });
assert.deepEqual(unified.map((section) => section.key), ["pinned", "rest"]);
assert.deepEqual(unified[0].tasks.map((row) => row.id), ["single-pinned", "collab-pinned"]);
assert.deepEqual(unified[1].tasks.map((row) => row.id), ["single-normal", "collab-normal"]);
assert.equal(new Set(unified.flatMap((section) => section.tasks.map((row) => row.id))).size, mixed.length);
assert.deepEqual(orderedTopLevelTasks(mixed, { unifiedPinned: true }).map((row) => row.id), [
  "single-pinned",
  "collab-pinned",
  "single-normal",
  "collab-normal",
]);

// 不分节时（其他项目的折叠列表）只出一节，顺序仍是 置顶 → 更新时间。
const flat = buildTaskTree(mixed);
assert.deepEqual(flat.map((section) => section.key), ["rest"]);
assert.deepEqual(flat[0].tasks.map((row) => row.id), [
  "single-pinned",
  "collab-pinned",
  "single-normal",
  "collab-normal",
]);

const withoutPinned = buildTaskTree([
  task("collab-normal", "team"),
  task("single-normal", "single"),
], { unifiedPinned: true });
assert.deepEqual(withoutPinned.map((section) => section.key), ["rest"]);

const ownership = buildTaskTree([
  task("local", "single"),
  { ...task("out", "single"), handoff: { direction: "out", pending: false } },
  { ...task("pending", "single"), handoff: { direction: "out", pending: true } },
  { ...task("in", "single"), handoff: { direction: "in" } },
], { unifiedPinned: true });
assert.deepEqual(ownership[0].tasks.map((row) => row.id), ["local", "pending", "in"]);

// —— 状态不再把列表切开，也不再提升任何一档：失败、待验收、在跑的全按更新时间混排。
const withFailures = buildTaskTree([
  task("fresh-running", "single", { status: "running", updatedAt: "2026-08-20T10:00:00.000Z" }),
  task("failed-old", "single", { status: "failed", updatedAt: "2026-08-11T09:00:00.000Z" }),
  task("failed-new", "single", { status: "failed", updatedAt: "2026-08-19T09:00:00.000Z" }),
  task("asking", "single", { status: "paused", question: "选哪个？", updatedAt: "2026-08-12T09:00:00.000Z" }),
  task("verify-failed", "single", { status: "done", stage: "verify_failed", updatedAt: "2026-08-13T09:00:00.000Z" }),
  task("await-accept", "team", { status: "idle", stage: "awaiting_acceptance", updatedAt: "2026-08-17T09:00:00.000Z" }),
  task("done-old", "single", { updatedAt: "2026-08-18T09:00:00.000Z" }),
], { unifiedPinned: true });
assert.deepEqual(withFailures.map((section) => section.key), ["rest"]);
assert.deepEqual(withFailures[0].tasks.map((row) => row.id), [
  "fresh-running",
  "failed-new",
  "done-old",
  "await-accept",
  "verify-failed",
  "asking",
  "failed-old",
]);

// 置顶是唯一压得住时间序的记号 —— 那是用户手动摁的。
const pinnedOverRest = orderedTopLevelTasks([
  task("failed", "single", { status: "failed", updatedAt: "2026-08-20T09:00:00.000Z" }),
  task("pinned-old", "single", { pinnedAt: 5, updatedAt: "2026-08-01T09:00:00.000Z" }),
], { unifiedPinned: true }).map((row) => row.id);
assert.deepEqual(pinnedOverRest, ["pinned-old", "failed"]);

const byLastUpdate = buildTaskTree([
  task("created-later", "single", {
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
  }),
  task("updated-later", "single", {
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-11T11:00:00.000Z",
  }),
]);
assert.deepEqual(byLastUpdate[0].tasks.map((row) => row.id), ["updated-later", "created-later"]);

const onlyPinned = buildTaskTree([
  task("only-collab", "team", { pinnedAt: 300 }),
], { unifiedPinned: true });
assert.deepEqual(onlyPinned.map((section) => section.key), ["pinned"]);

const now = Date.parse("2026-08-11T12:00:00.000Z");
const byAge = previewTasksByAge([
  task("old", "single", { updatedAt: "2026-08-10T11:59:59.999Z" }),
  task("recent", "single", { updatedAt: "2026-08-11T11:00:00.000Z" }),
  task("boundary", "single", { updatedAt: "2026-08-10T12:00:00.000Z" }),
], now);
assert.deepEqual(byAge.visible.map((row) => row.id), ["recent", "boundary"]);
assert.deepEqual(byAge.hidden.map((row) => row.id), ["old"]);

const allOld = previewTasksByAge([
  task("older", "single", { updatedAt: "2026-08-08T12:00:00.000Z" }),
  task("latest", "single", { updatedAt: "2026-08-10T11:00:00.000Z" }),
  task("oldest", "single", { updatedAt: "2026-08-07T12:00:00.000Z" }),
], now);
assert.deepEqual(allOld.visible.map((row) => row.id), ["latest"]);
assert.deepEqual(allOld.hidden.map((row) => row.id), ["older", "oldest"]);

// —— keepVisible 命中的行永不因为旧被折叠（星标、等你验收的），且不打乱原有顺序。
const keepVisible = (row) => row.starredAt != null || row.id === "unaccepted-old";
const withKeeps = previewTasksByAge([
  task("recent", "single", { updatedAt: "2026-08-11T11:00:00.000Z" }),
  task("starred-old", "single", { starredAt: 7, updatedAt: "2026-08-01T00:00:00.000Z" }),
  task("unaccepted-old", "single", { updatedAt: "2026-08-02T00:00:00.000Z" }),
  task("plain-old", "single", { updatedAt: "2026-08-03T00:00:00.000Z" }),
], now, keepVisible);
assert.deepEqual(withKeeps.visible.map((row) => row.id), ["recent", "starred-old", "unaccepted-old"]);
assert.deepEqual(withKeeps.hidden.map((row) => row.id), ["plain-old"]);

// 全是旧行时，被 keepVisible 留下的就够了，不该再额外顶出一条「最新的」。
const onlyKeeps = previewTasksByAge([
  task("starred-old", "single", { starredAt: 7, updatedAt: "2026-08-01T00:00:00.000Z" }),
  task("plain-old", "single", { updatedAt: "2026-08-03T00:00:00.000Z" }),
], now, keepVisible);
assert.deepEqual(onlyKeeps.visible.map((row) => row.id), ["starred-old"]);
assert.deepEqual(onlyKeeps.hidden.map((row) => row.id), ["plain-old"]);

// —— 豁免名单的判据本体（TaskTree 的 keepVisible 就是它，别再各写一份）。
// 摔了的那两条尤其要紧：failed 的行首点走 "error"，而 error 只在未读时才亮，看过一眼
// 就熄。要是跟着点走，失败的任务只在头 24 小时露个面，之后缩进「显示更多」——
// 那等于任务模式把它们收进来了、列表里却找不到。
assert.ok(keepVisibleInPreview(task("x", "single", { starredAt: 7 }), null), "星标");
assert.ok(keepVisibleInPreview(task("x", "single", { pinnedAt: 7 }), null), "置顶");
assert.ok(keepVisibleInPreview(task("x", "single"), "unaccepted"), "没盖的章");
assert.ok(keepVisibleInPreview({ ...task("x", "single"), status: "failed" }, null), "跑挂了，且不靠未读点");
assert.ok(keepVisibleInPreview({ ...task("x", "single"), stage: "verify_failed" }, null), "验证没过");
assert.ok(!keepVisibleInPreview(task("x", "single"), null), "普通的旧行照旧可以被折叠");
assert.ok(!keepVisibleInPreview({ ...task("x", "single"), status: "done" }, "success"), "干完并盖过章的不赖着不走");

// 选中藏起来的旧任务只自动展开一次；同一条上点收起后不能再被顶开。
assert.deepEqual(advanceHiddenReveal(null, "single:old"), { lastKey: "single:old", reveal: true });
assert.deepEqual(advanceHiddenReveal("single:old", "single:old"), { lastKey: "single:old", reveal: false });
assert.deepEqual(advanceHiddenReveal("single:old", null), { lastKey: null, reveal: false });
assert.deepEqual(advanceHiddenReveal(null, "single:old"), { lastKey: "single:old", reveal: true });
assert.deepEqual(advanceHiddenReveal("single:old", "single:older"), { lastKey: "single:older", reveal: true });

// —— 任务模式里「任务」那一节再按项目分一层：项目的先后**跟着行走**（喂进来的是更新
// 时间倒序，谁的最新一条更近谁排前），不按名字也不按创建时间 —— 否则最活跃的那家会
// 沉到底下，而这个列表就是拿来看「现在谁在动」的。同项目的行保持原有相对顺序。
const byProject = groupTasksByProject([
  { ...task("b-new", "single"), projectId: "beta" },
  { ...task("a-1", "single"), projectId: "alpha" },
  { ...task("b-old", "single"), projectId: "beta" },
  { ...task("a-2", "single"), projectId: "alpha" },
]);
assert.deepEqual(byProject.map((group) => group.projectId), ["beta", "alpha"]);
assert.deepEqual(byProject.map((group) => group.tasks.map((row) => row.id)), [["b-new", "b-old"], ["a-1", "a-2"]]);
// 一条不落：分组只是把同一批行换个排法，不许顺手筛掉谁。
assert.equal(byProject.reduce((sum, group) => sum + group.tasks.length, 0), 4);
assert.deepEqual(groupTasksByProject([]), []);

console.log("task tree grouping tests passed");
