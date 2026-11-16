// 会话里那几句旁注点过去去哪儿（noticeLinks）：「等你裁定」那一句去审议格那一场那一轮，哨兵那几句去
// 哨兵格那一张卡（用户 2026-11-16：这两样原来在会话里都没有入口）。这份回归盯：
//   ① 新记录自带那一场的 id，直接用；
//   ② 老记录只有轮号：在审查记录里认那一轮写过驳回、时刻最近的那一场，不拿别的场顶；认不出就不给路；
//   ③ 审议格不装派审记录（非自由工作流）、或没有那块面板的视图：不给路，原处照旧摊开原文；
//   ④ 哨兵那几句各认出是哪一个（交付那一句从送回来的事件里认）；确认被拦下那一句只打开那一格；
//   ⑤ 别的旁注一律不给路。
// 跑：npm -w web run test:notice-links
import assert from "node:assert/strict";
import type { FreeReviewRun } from "@ash/shared";
import type { TimelineNotice } from "@ash/shared/timeline-notice";
import type { ConversationEventItem } from "../src/task-detail/conversationModel.ts";
import type { ReviewTarget } from "../src/review/reviewTarget.ts";
import { disputeReviewTarget, noticeLink, noticeMonitorId, type NoticeLinkTargets } from "../src/task-detail/noticeLinks.ts";

const event = (notice: TimelineNotice, at = "2026-11-16T03:08:00.000Z") =>
  ({ kind: "event", id: `e-${notice.kind}`, text: "原文", at, notice }) as unknown as ConversationEventItem;

const run = (id: string, round: number, disputedAt: string | null, kind?: string) => ({
  id,
  status: "stopped",
  target: kind ? { kind } : null,
  rounds: [{ round, dispute: disputedAt ? { at: disputedAt } : null }],
}) as unknown as FreeReviewRun;

// ① 新记录
assert.deepEqual(disputeReviewTarget(event({ kind: "review.dispute", round: 2, runId: "run-b" }), []),
  { source: "free", runId: "run-b", round: 2 });

// ② 老记录：同一轮号两场（重新派审从第 1 轮数起），认驳回时刻最近的那一场；合并结果审查不算
const reviews = [
  run("run-old", 1, "2026-11-10T01:00:00.000Z"),
  run("run-new", 1, "2026-11-16T03:07:58.000Z"),
  run("run-merge", 1, "2026-11-16T03:08:00.000Z", "accepted_merge"),
  run("run-quiet", 1, null),
];
assert.deepEqual(disputeReviewTarget(event({ kind: "review.dispute", round: 1 }), reviews),
  { source: "free", runId: "run-new", round: 1 }, "认时刻最近、真写过驳回的那一场");
assert.equal(disputeReviewTarget(event({ kind: "review.dispute", round: 3 }), reviews), null, "认不出就不给路");
assert.equal(disputeReviewTarget(event({ kind: "review.dispute", round: 1 }), null), null, "没有审查记录就认不出");

// ③ 去不去得了
const opened: { review: ReviewTarget[]; monitor: (string | null)[] } = { review: [], monitor: [] };
const free: NoticeLinkTargets = {
  workflowMode: "free",
  reviews,
  onOpenReviewPanel: (target) => opened.review.push(target),
  onOpenMonitorPanel: (monitorId) => opened.monitor.push(monitorId),
};
const dispute = event({ kind: "review.dispute", round: 1 });
const link = noticeLink(dispute, free);
assert.ok(link, "自由工作流里驳回那一句点得过去");
assert.match(link.label, /审议格/);
link.open();
assert.deepEqual(opened.review, [{ source: "free", runId: "run-new", round: 1 }]);
assert.equal(noticeLink(dispute, { ...free, workflowMode: null }), null, "审议格不装派审记录时不给路");
assert.equal(noticeLink(dispute, { ...free, onOpenReviewPanel: undefined }), null, "没有那块面板的视图不给路");
assert.equal(noticeLink(event({ kind: "review.dispute", round: 9 }), free), null, "认不出是哪一场就不给路");

// ④ 哨兵那几句
assert.equal(noticeMonitorId(event({ kind: "monitor.started", description: "等回归", monitorId: "mon-1" })), "mon-1");
assert.equal(noticeMonitorId(event({ kind: "monitor.finished", description: "等回归" })), null, "老记录没带 id：是哨兵，认不出哪一个");
assert.equal(noticeMonitorId(event({ kind: "monitor.released", description: "等回归", finished: true, monitorId: "mon-2" })), "mon-2");
assert.equal(noticeMonitorId(event({
  kind: "monitor.handed", via: "pause",
  monitorWake: { version: 1, omittedEvents: 0, events: [
    { kind: "line", source: "a", monitorId: "mon-a", body: "x" },
    { kind: "ended", source: "b", monitorId: "mon-b", body: "y" },
  ] },
} as unknown as TimelineNotice)), "mon-b", "交付那一句认最后送回来的那一个");
assert.equal(noticeMonitorId(event({ kind: "complete.held", after: "pending" })), null);
noticeLink(event({ kind: "monitor.started", description: "等回归", monitorId: "mon-1" }), free)!.open();
noticeLink(event({ kind: "complete.held", after: "new-monitor" }), free)!.open();
assert.deepEqual(opened.monitor, ["mon-1", null]);
assert.equal(noticeLink(event({ kind: "monitor.started", description: "等回归" }), { ...free, onOpenMonitorPanel: undefined }), null,
  "没有哨兵格的视图不给路");

// ⑤ 别的旁注
assert.equal(noticeMonitorId(event({ kind: "review.launch" })), undefined);
assert.equal(noticeLink(event({ kind: "review.launch" }), free), null);
assert.equal(noticeLink(event({ kind: "alert" }), free), null);
assert.equal(noticeLink(undefined, free), null);

console.log("✓ 驳回那一句去审议格那一场那一轮（新记录带 id、老记录按轮号和时刻认）、哨兵那几句去哨兵格那一张卡、认不出或没有面板时不给路");
