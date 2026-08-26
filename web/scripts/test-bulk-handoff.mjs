import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bulkIdentityMismatchWarning,
  bulkIdentityUnavailableWarning,
  bulkPreflightAllowsRun,
  bulkPreflightIssue,
  bulkTargetAddressHintMatches,
  groupBulkHandoffFailures,
  bulkReturnCandidates,
  bulkTaskReturnsToTarget,
  bulkTargetProjectId,
  outboundTasksForTarget,
  partitionBulkHandoffTasks,
} from "../src/workspace/bulkHandoff.ts";
import { handoffTargetsForTask, nextUntriedHandoffTarget } from "../src/task-detail/handoffTargetPolicy.ts";

const task = (id, overrides = {}) => ({
  id,
  projectId: "p1",
  parentId: null,
  archived: false,
  mode: "single",
  queueId: null,
  verifyRound: null,
  handoff: null,
  title: id,
  ...overrides,
});

const sourceFp = "a".repeat(64);
const thirdFp = "b".repeat(64);

assert.match(
  bulkIdentityMismatchWarning([sourceFp, sourceFp], thirdFp),
  /目标机的身份和上次不一样.*AAAA-AAAA-AAAA-AAAA-AAAA.*BBBB-BBBB-BBBB-BBBB-BBBB.*不要向它发送接力申请/,
  "地址换机时应展示记住和当前的短指纹，并阻止误导用户继续配对",
);
assert.match(
  bulkIdentityUnavailableWarning(),
  /未能核对目标机身份.*仅按本机保存的地址推断.*再次校验指纹/,
  "身份端点不可达时不能静默吞掉核对失败",
);

const outbound = outboundTasksForTarget([
  task("older", { updatedAt: "2026-08-20T08:00:00.000Z", handoff: { direction: "out", peerUrl: "http://old-target:4317", peerFp: sourceFp, at: "2026-08-20T08:00:00.000Z" } }),
  task("newer", { updatedAt: "2026-08-20T09:00:00.000Z", handoff: { direction: "out", peerUrl: "http://target:4317/", peerFp: sourceFp, at: "2026-08-20T09:00:00.000Z" } }),
  task("pending", { handoff: { direction: "out", pending: true, peerUrl: "http://target:4317" } }),
  task("other-target", { handoff: { direction: "out", peerUrl: "http://elsewhere:4317" } }),
  task("reused-address", { handoff: { direction: "out", peerUrl: "http://target:4317", peerFp: thirdFp } }),
  task("returned-archive", { handoff: { direction: "out", peerUrl: "http://target:4317", peerFp: sourceFp, originFp: sourceFp } }),
  task("inbound", { handoff: { direction: "in", peerUrl: "http://target:4317" } }),
  task("other-project", { projectId: "p2", handoff: { direction: "out", peerUrl: "http://target:4317" } }),
], "p1", "http://target:4317/", sourceFp);
assert.deepEqual(outbound.map((item) => item.id), ["newer", "older"]);

const result = partitionBulkHandoffTasks([
  task("ready"),
  task("other-project", { projectId: "p2" }),
  task("child", { parentId: "team" }),
  task("team", { mode: "team" }),
  task("queued", { queueId: "q1" }),
  task("verifying", { verifyRound: 2 }),
  task("pending", { handoff: { direction: "out", pending: true } }),
  task("moved", { handoff: { direction: "out" } }),
  task("inbound", { handoff: { direction: "in", peerFp: sourceFp } }),
  task("archived", { archived: true }),
], "p1", thirdFp);

assert.deepEqual(result.eligible.map((item) => item.id), ["ready"]);
assert.deepEqual(result.skipped.map((item) => item.task.id), ["team", "queued", "verifying", "pending", "inbound"]);
assert.match(result.skipped.find((item) => item.task.id === "pending").reason, /单独收口/);
assert.match(result.skipped.find((item) => item.task.id === "inbound").reason, /未能确认任务来源机/);

const statusResult = partitionBulkHandoffTasks([
  task("running", { status: "running" }),
  task("paused", { status: "paused" }),
  task("done", { status: "done" }),
], "p1");
assert.deepEqual(statusResult.eligible.map((item) => item.id), ["running", "paused", "done"]);

const allSkipped = partitionBulkHandoffTasks([
  task("team-only", { mode: "team" }),
  task("inbound-only", { handoff: { direction: "in", peerFp: sourceFp } }),
  task("legacy-inbound", { handoff: { direction: "in" } }),
], "p1", thirdFp);
assert.equal(allSkipped.eligible.length, 0);
assert.equal(allSkipped.skipped.length, 3);

const bulkReturn = partitionBulkHandoffTasks([
  task("local"),
  task("return-home", { handoff: { direction: "in", peerFp: sourceFp } }),
], "p1", sourceFp);
assert.deepEqual(bulkReturn.eligible.map((item) => item.id), ["local", "return-home"]);

const returnCandidate = task("return-candidate", {
  handoff: { direction: "in", peerFp: sourceFp, peerUrl: "http://source:4317/" },
});
assert.equal(
  bulkTaskReturnsToTarget(returnCandidate, sourceFp.toUpperCase()),
  true,
  "解析出目标身份后应按大小写无关的指纹比较认出移回任务",
);
assert.equal(
  bulkTaskReturnsToTarget(returnCandidate, thirdFp),
  false,
  "目标身份不匹配时不能靠地址相同放行",
);
assert.deepEqual(
  bulkReturnCandidates([task("local"), returnCandidate], "p1").map((item) => item.id),
  ["return-candidate"],
  "未配对目标应先找出可做只读任务级身份预检的接入任务",
);
const unpairedMixedReturn = partitionBulkHandoffTasks([
  task("local"),
  returnCandidate,
], "p1", sourceFp, true);
assert.deepEqual(
  unpairedMixedReturn.eligible.map((item) => item.id),
  ["return-candidate"],
  "未获整机审批的混合批次应先移回接入任务，不让本地任务拖回审批流程",
);
assert.match(unpairedMixedReturn.skipped[0].reason, /接入任务移回权限/);
assert.equal(
  bulkTargetAddressHintMatches("http://localhost:4317", "http://127.0.0.1:4317/api"),
  true,
  "来源机离线时 localhost、loopback IP 和 /api 写法应使用同一个安全地址提示",
);
assert.equal(bulkTargetAddressHintMatches("http://localhost:4317", "http://127.0.0.1:4318"), false);
const groupedFailures = groupBulkHandoffFailures([
  { task: task("one"), reason: "same failure" },
  { task: task("two"), reason: "same failure" },
  { task: task("three"), reason: "other failure" },
]);
assert.deepEqual(groupedFailures.map((group) => [group.reason, group.tasks.map((item) => item.id)]), [
  ["same failure", ["one", "two"]],
  ["other failure", ["three"]],
]);

const returnedHome = partitionBulkHandoffTasks([
  task("returned-home", { handoff: { direction: "returned", peerFp: thirdFp } }),
], "p1", sourceFp);
assert.deepEqual(returnedHome.eligible.map((item) => item.id), ["returned-home"]);

const targets = [
  { name: "source", url: "http://source", peerFp: sourceFp },
  { name: "third", url: "http://third", peerFp: thirdFp },
];
assert.deepEqual(handoffTargetsForTask(targets, null), targets);
assert.deepEqual(
  handoffTargetsForTask(targets, { direction: "in", peerFp: sourceFp }).map((target) => target.name),
  ["source"],
);
assert.deepEqual(handoffTargetsForTask(targets, { direction: "in" }), []);
assert.deepEqual(handoffTargetsForTask(targets, { direction: "returned", peerFp: thirdFp }), targets);
assert.deepEqual(
  handoffTargetsForTask(
    [{ name: "登记来源", url: "http://registered", peerFp: sourceFp }],
    { direction: "in", peerFp: sourceFp },
    { name: "自动来源", url: "http://automatic", peerFp: sourceFp },
  ),
  [
    { name: "自动来源", url: "http://automatic", peerFp: sourceFp },
    { name: "登记来源", url: "http://registered", peerFp: sourceFp },
  ],
  "移回目标可由任务历史自动恢复，不要求先写入整机目标设置",
);
const attemptedTargets = new Set(["http://automatic"]);
const fallbackTargets = [
  { name: "自动来源", url: "http://automatic", peerFp: sourceFp },
  { name: "失效登记地址", url: "http://dead", peerFp: sourceFp },
  { name: "可用登记地址", url: "http://live", peerFp: sourceFp },
];
assert.equal(nextUntriedHandoffTarget(fallbackTargets, attemptedTargets)?.url, "http://dead");
attemptedTargets.add("http://dead");
assert.equal(nextUntriedHandoffTarget(fallbackTargets, attemptedTargets)?.url, "http://live", "地址回退应遍历全部同指纹候选");

const pendingProbe = {
  taskScopedReturn: false,
  peer: { peerStatus: "pending" },
  projects: [],
};
assert.match(
  bulkPreflightIssue(pendingProbe, "p1"),
  /目标机尚未批准本机/,
  "普通接力的待审批提示仍应保留",
);
assert.equal(bulkPreflightAllowsRun(1, 1, 2), true, "一条预检失败时应允许跳过并迁移其余任务");
assert.equal(bulkPreflightAllowsRun(0, 2, 2), false, "没有任何可迁移任务时仍应禁止执行");

const scopedOne = {
  taskScopedReturn: true,
  projects: [{ id: "origin-one", name: "one", repoPath: "/one", isRepo: true }],
};
const scopedTwo = {
  taskScopedReturn: true,
  projects: [{ id: "origin-two", name: "two", repoPath: "/two", isRepo: true }],
};
const fromOne = task("from-one", { handoff: { direction: "in", peerFp: sourceFp } });
const fromTwo = task("from-two", { handoff: { direction: "in", peerFp: sourceFp } });
assert.equal(bulkTargetProjectId(fromOne, scopedOne, "batch-project"), "origin-one");
assert.equal(bulkTargetProjectId(fromTwo, scopedTwo, "batch-project"), "origin-two");
assert.equal(bulkPreflightIssue(scopedTwo, bulkTargetProjectId(fromTwo, scopedTwo, "batch-project")), null);

const bulkDialog = readFileSync(new URL("../src/workspace/HandoffMachines.tsx", import.meta.url), "utf8");
assert.doesNotMatch(bulkDialog, /<ConfirmDialog/, "批量接力不应继续使用旧确认框");
assert.match(bulkDialog, /<HandoffDialogHeader/, "批量接力应复用接力弹窗标题结构");
assert.match(bulkDialog, /<HandoffRouteCard/, "批量接力应展示与单任务一致的机器路线");
assert.match(bulkDialog, /handoff-result-panel handoff-bulk-result/, "批量接力结果页应使用同一套完成态视觉");
assert.match(bulkDialog, /api\.handoffReturnTarget\(task\.id\)/, "批量移回应逐任务解析 marker 里的回程目标");
assert.match(bulkDialog, /api\.handoffTargetIdentity\(target\.url\)/, "打开弹窗只能读取目标机公开身份，不能拿其他来源任务做 preflight");
assert.match(bulkDialog, /allowReturnFallback: false/, "批量移回预检不能降级成会落待审批记录的普通 ping");
assert.match(bulkDialog, /identityResolving/, "目标身份探测期间必须先打开可取消的弹窗");
assert.match(bulkDialog, /kind: "mismatch"/, "目标身份不匹配时必须进入显式警告状态");
assert.match(bulkDialog, /identityMismatch \|\| busy/, "身份不匹配时不能继续发送接力申请");
assert.doesNotMatch(bulkDialog, /已降级为普通接力/, "批量移回禁止降级后不应保留不可达的审批引导");
assert.match(bulkDialog, /targetUrl: taskTarget\.url/, "批量正式移回应使用逐任务解析出的地址");
assert.match(bulkDialog, /probeBulkTask/, "任务恢复地址不可达时批量移回应尝试同指纹登记地址");
assert.match(bulkDialog, /preflightFailures/, "批量执行结果应保留被跳过任务的失败原因");
assert.match(bulkDialog, /bulkTargetProjectId/, "批量移回应按任务使用各自预检锁定的原项目");
assert.match(bulkDialog, /handoff-bulk-project-fixed/, "纯移回批次应只读说明按任务自动归位，而不是提供单一项目下拉框");
assert.match(bulkDialog, /原项目待逐项确认/, "逐项检查完成前不能把首个 probe 误报成整批只有一个原项目");

console.log("bulk handoff eligibility tests passed");
