// 任务时间线上每一条「ash 自己说的话」是**哪一类事**，连同那件事的几个参数。
//
// 服务端写时间线（server/src/task-timeline.ts 的 appendTaskTimeline）时一并给出，跟原文一起
// 落进会话 .md 的 sentinel、也跟着直播事件走。展示端据它决定这一条怎么摆、用什么图标、挂不挂
// 按钮、写成哪句话（文案只在 web/src/task-detail/timelineNoticeCopy.ts 那一张表里写）——而不是
// 回头去认原文里的字。原文照旧落盘：它是点开以后看的细节，也是移动端、MCP 读转录、以及这份
// 类型出现之前那些老记录唯一的依据。
//
// 摆法由 kind 决定（表在展示端）：
//   里程碑 —— 会话里常显一行：审查出了结论、验收了。
//   回答   —— 你那条斜杠命令的结果：常显一行，点开是全文。
//   回执   —— 记在它所属的那一回合上，平时不画（审查已预约、开始盯、不再等了、意见已交给执行者……）。
//   明面   —— 出了岔子、或者要你拍板的：留在会话里一行，不收进回执。
//
// 没有专门 kind 的那一大片用两个通用档：`receipt`（回执，原文就是它的话）和 `alert`（明面，
// 原文就是它的话）。专门的 kind 只给展示端确实要据参数换说法、或者要据它搭结构（审查段的
// 起止）的那几类。

/** 审查是哪一种：自由派审 / 就地验证 / 合并结果审查。 */
export type TimelineReviewSource = "free" | "inline" | "merge";
export type TimelineReviewVerdict = "passed" | "failed" | "inconclusive" | "aborted";

export type TimelineNotice =
  // ── 里程碑 ──
  /**
   * 一轮审查到头了。`round` 合并结果审查没有轮号。
   * verdict：passed 通过 / failed 未通过 / inconclusive 跑完了却没给出结论（或结论没被采用）/
   * aborted 压根没启动起来。
   */
  | {
    kind: "review.verdict";
    source: TimelineReviewSource;
    round: number | null;
    verdict: TimelineReviewVerdict;
    reviewer?: string | null;
    /** 未通过时报告里抽得出几条意见。抽不出来就不给。 */
    findings?: number;
  }
  /** 验收做完了。`target` = 合进了哪条分支；`noCommit` = 只合进了工作区、等用户自己提交；`tag` = 只打了标签没合并。 */
  | { kind: "accept.done"; target: string | null; noCommit?: boolean; tag?: string | null }
  // ── 要用户拍板（明面）──
  /** 执行者驳回了这一轮审查意见，等用户裁定。 */
  | { kind: "review.dispute"; round: number }
  // ── 审查段的结构（本身是回执，审查泳道靠它们定起止）──
  /**
   * 一轮审查开始了。`rerun` = 同一轮重跑上一回合 / 从中断处继续，不算新开一轮。`runId` = 这是
   * 哪一场派审 / 合并结果审查（就地验证没有）：轮号会重复（重新派审从第 1 轮数起），点这一轮
   * 去审查格时靠它认出是哪一场。老记录没有。
   */
  | { kind: "review.start"; source: TimelineReviewSource; round: number | null; rerun?: boolean; reviewer?: string | null; runId?: string }
  /** 按某一轮的审查意见发起了修复（意见已交给执行者）。 */
  | { kind: "review.repair"; source: TimelineReviewSource; round: number }
  /** 验收阶段翻了一档（stage 原值：verified / verify_failed / merged / accepted …）。就地验证的结论靠它。 */
  | { kind: "stage"; stage: string }
  // ── 有专门说法的回执 ──
  /** 预约了 / 更新了完成后审查。 */
  | { kind: "review.reserved"; reviewer: string; updated: boolean }
  /** 取消了审查预约。 */
  | { kind: "review.unreserved" }
  /** 执行回合跑完，预约的审查开始派发。 */
  | { kind: "review.launch" }
  /** 挂上了一个哨兵。 */
  | { kind: "monitor.started"; description: string }
  /** 哨兵自己结束了。 */
  | { kind: "monitor.finished"; description: string }
  /** 不再等某个哨兵的结果了。`finished` = 它那时已经跑完。 */
  | { kind: "monitor.released"; description: string; finished: boolean }
  // ── 你那条命令的回答（常显：是你要看的东西）──
  /** 斜杠命令（/goal --scopes、/rename …）就地执行的结果。原文里带着命令本身和全部输出。 */
  | { kind: "command.output"; command: string }
  // ── 通用两档：原文就是它的话 ──
  | { kind: "receipt" }
  | { kind: "alert" };

export type TimelineNoticeKind = TimelineNotice["kind"];

const KINDS: ReadonlySet<string> = new Set<TimelineNoticeKind>([
  "review.verdict", "accept.done", "review.dispute", "review.start", "review.repair", "stage",
  "review.reserved", "review.unreserved", "review.launch",
  "monitor.started", "monitor.finished", "monitor.released", "command.output", "receipt", "alert",
]);

/**
 * 从盘上 / 线上读回来的那一份核一道形状：认得的 kind 才算数。读不出来的（更新的服务端写的、
 * 或者被手改坏了的）当没有，展示端就退回按原文读的老路子，不会因为一个字段把整条会话读挂。
 */
export function timelineNoticeOf(value: unknown): TimelineNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && KINDS.has(kind) ? value as TimelineNotice : undefined;
}
