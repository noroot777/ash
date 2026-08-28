import assert from "node:assert/strict";
import { readSource } from "../../scripts/read-source.mjs";
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
  isLiveBulkTask,
  outboundTasksForTarget,
  partitionBulkHandoffTasks,
  resolveBulkTargetIdentity,
} from "../src/workspace/bulkHandoff.ts";
import { handoffTargetsForTask, nextUntriedHandoffTarget } from "../src/task-detail/handoffTargetPolicy.ts";

// 批量接力的候选池就是「此刻在跑的任务」，所以夹具默认 running，
// 各用例只需要显式声明自己关心的那个落选原因。
const task = (id, overrides = {}) => ({
  id,
  projectId: "p1",
  parentId: null,
  archived: false,
  mode: "single",
  queueId: null,
  verifyRound: null,
  handoff: null,
  status: "running",
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

// 「其他机器」那一节列谁，判据跟任务模式点开出站行同源（shared 的 outboundHolder）。
// 这里传的是 target 本身 + 全量 targets：outboundHolder 是在候选集里挑，只递当前这条的话
// 另一台同名机器的行会被算到它头上。
const TARGET = { name: "目标机", url: "http://target:4317/", peerFp: sourceFp };
const outbound = outboundTasksForTarget([
  task("older", { updatedAt: "2026-08-20T08:00:00.000Z", handoff: { direction: "out", peerUrl: "http://old-target:4317", peerFp: sourceFp, peerName: "目标机", at: "2026-08-20T08:00:00.000Z" } }),
  task("newer", { updatedAt: "2026-08-20T09:00:00.000Z", handoff: { direction: "out", peerUrl: "http://target:4317/", peerFp: sourceFp, at: "2026-08-20T09:00:00.000Z" } }),
  task("pending", { handoff: { direction: "out", pending: true, peerUrl: "http://target:4317" } }),
  task("other-target", { handoff: { direction: "out", peerUrl: "http://elsewhere:4317" } }),
  task("reused-address", { handoff: { direction: "out", peerUrl: "http://target:4317", peerFp: thirdFp } }),
  task("returned-archive", { handoff: { direction: "out", peerUrl: "http://target:4317", peerFp: sourceFp, originFp: sourceFp } }),
  task("inbound", { handoff: { direction: "in", peerUrl: "http://target:4317" } }),
  task("other-project", { projectId: "p2", handoff: { direction: "out", peerUrl: "http://target:4317" } }),
], "p1", TARGET, [TARGET]);
assert.deepEqual(outbound.map((item) => item.id), ["newer", "older"]);

// 机器换了地址：用户在设置里把 url 改新，界面会把记住的指纹一并清掉（那串指纹是对
// **上一个地址**背后那台机器的承诺）。这一节必须跟着认回同一台 —— 不认的话，任务模式里
// 点得开的那些行，在「其他机器」下整批消失，同一件事两个表面两种答案。
const MOVED = { name: "目标机", url: "http://new-target:4317", peerFp: null };
const movedRows = outboundTasksForTarget([
  task("moved", { handoff: { direction: "out", peerUrl: "http://old-target:4317", peerFp: sourceFp, peerName: "目标机", at: "2026-08-20T08:00:00.000Z" } }),
], "p1", MOVED, [MOVED]);
assert.deepEqual(movedRows.map((item) => item.id), ["moved"], "改完地址后历史出站行仍归这台机器");

// 反过来：同一个地址上换了人（marker 记着 A，设置里这条写着 B）—— 一行都不该归它。
const RECLAIMED = { name: "目标机", url: "http://old-target:4317", peerFp: thirdFp };
assert.deepEqual(
  outboundTasksForTarget([
    task("stale", { handoff: { direction: "out", peerUrl: "http://old-target:4317", peerFp: sourceFp, peerName: "目标机", at: "2026-08-20T08:00:00.000Z" } }),
  ], "p1", RECLAIMED, [RECLAIMED]).map((item) => item.id),
  [],
  "地址被别的机器占了，历史行不能算在它头上",
);

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

// 接力是把「正在跑的活」挪到另一台机器接着跑，不是搬项目历史：收工的任务一律落选。
const statusResult = partitionBulkHandoffTasks([
  task("running", { status: "running" }),
  task("queued-status", { status: "queued" }),
  task("paused", { status: "paused" }),
  task("done", { status: "done" }),
  task("failed", { status: "failed" }),
  task("awaiting-review", { status: "awaiting_review" }),
  task("live-team", { mode: "team", status: "running" }),
], "p1");
assert.deepEqual(
  statusResult.eligible.map((item) => item.id),
  ["running", "queued-status"],
  "只有占着执行槽的任务才进批量接力清单",
);
assert.deepEqual(
  statusResult.skipped.map((item) => item.task.id),
  ["paused", "done", "failed", "awaiting-review", "live-team"],
  "落选的任务都留在 skipped 里（弹窗只报个数，不铺开讲原因）",
);
assert.match(statusResult.skipped[0].reason, /没有在运行/, "落选原因要说人话");
assert.equal(isLiveBulkTask(task("q", { status: "queued" })), true, "排队中同样占执行槽");
assert.equal(isLiveBulkTask(task("r", { status: "awaiting_review" })), false);

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
  resolveBulkTargetIdentity([returnCandidate], "http://fresh-target:4317", thirdFp),
  { returnFingerprint: null, mismatchExpectedFingerprints: [] },
  "全新出站目标没有声称是接入任务来源机，不能被误报为地址换机",
);
assert.deepEqual(
  resolveBulkTargetIdentity([returnCandidate], "http://source:4317/api", thirdFp),
  { returnFingerprint: null, mismatchExpectedFingerprints: [sourceFp] },
  "只有目标地址等价于接入任务保存的来源地址时，指纹变化才属于真换机",
);
assert.deepEqual(
  resolveBulkTargetIdentity([returnCandidate], "http://source-lan-ip:4317", sourceFp),
  { returnFingerprint: sourceFp, mismatchExpectedFingerprints: [] },
  "地址写法不同但在线身份相同，应继续认出原来源机",
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

const bulkDialog = readSource(new URL("../src/workspace/BulkHandoffDialog.tsx", import.meta.url));
const machines = readSource(new URL("../src/workspace/HandoffMachines.tsx", import.meta.url));
assert.match(machines, /<BulkHandoffDialog/, "侧栏「其他机器」仍应是批量接力弹窗的唯一入口");
assert.doesNotMatch(machines, /handoff-bulk-body/, "弹窗实现拆出去后不应留在侧栏文件里");
assert.doesNotMatch(bulkDialog, /<ConfirmDialog/, "批量接力不应继续使用旧确认框");
assert.match(bulkDialog, /<HandoffDialogHeader/, "批量接力应复用接力弹窗标题结构");
assert.match(bulkDialog, /<HandoffRouteCard/, "批量接力应展示与单任务一致的机器路线");
assert.match(bulkDialog, /handoff-result-panel handoff-bulk-result/, "批量接力结果页应使用同一套完成态视觉");
assert.match(bulkDialog, /api\.handoffReturnTarget\(task\.id\)/, "批量移回应逐任务解析 marker 里的回程目标");
assert.match(bulkDialog, /api\.handoffTargetIdentity\(target\.url\)/, "打开弹窗只能读取目标机公开身份，不能拿其他来源任务做 preflight");
assert.match(bulkDialog, /allowReturnFallback: false/, "批量移回预检不能降级成会落待审批记录的普通 ping");
assert.match(bulkDialog, /identityResolving/, "目标身份探测期间必须先打开可取消的弹窗");
assert.match(bulkDialog, /resolveBulkTargetIdentity/, "身份不匹配必须先区分新目标与同址换机");
assert.match(bulkDialog, /kind: "mismatch"/, "目标身份不匹配时必须进入显式警告状态");
assert.match(bulkDialog, /identityMismatch \|\| busy/, "身份不匹配时不能继续发送接力申请");
assert.doesNotMatch(bulkDialog, /已降级为普通接力/, "批量移回禁止降级后不应保留不可达的审批引导");
assert.match(bulkDialog, /targetUrl: taskTarget\.url/, "批量正式移回应使用逐任务解析出的地址");
assert.match(bulkDialog, /probeBulkTask/, "任务恢复地址不可达时批量移回应尝试同指纹登记地址");
assert.match(bulkDialog, /preflightFailures/, "批量执行结果应保留被跳过任务的失败原因");
assert.match(bulkDialog, /bulkTargetProjectId/, "批量移回应按任务使用各自预检锁定的原项目");
assert.match(bulkDialog, /handoff-bulk-project-fixed/, "纯移回批次应只读说明按任务自动归位，而不是提供单一项目下拉框");
assert.match(bulkDialog, /原项目待逐项确认/, "逐项检查完成前不能把首个 probe 误报成整批只有一个原项目");
assert.doesNotMatch(bulkDialog, /全部可|BulkHandoffScope/, "批量接力没有「整项目搬家」这一档，不该再出现范围选择");
assert.match(bulkDialog, /skipped\.length > 0 && ` 项目里另外/, "搬不走的任务只报个数，不逐条讲原因");
assert.doesNotMatch(bulkDialog, /idleSkipped|blockedSkipped/, "落选任务不再分档展示");

console.log("bulk handoff eligibility tests passed");
