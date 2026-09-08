import { LEGACY_SYS_MARKER } from "@ash/shared";
import type { FreeReviewRun } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import { verifyNoteOf, type VerifyNoteMark } from "./conversationNotes.ts";

export type ReviewLaneConclusion = "verified" | "verify_failed" | "inconclusive" | null;
export type ReviewLaneSource = VerifyNoteMark["kind"];

/** 这张卡的报告在哪：两种审查落盘目录不同，free 的 URL 还多一个 runId。 */
export type ReviewLaneReport =
  | { kind: "inline"; round: number }
  | { kind: "free"; runId: string; round: number };

export type ConversationReviewLane = {
  kind: "review-lane";
  id: string;
  source: ReviewLaneSource;
  /** 合并结果审查没有轮号（它跑在验收后的只读快照上，一次就是一次）。 */
  round: number | null;
  /**
   * 这条审查链最多跑几轮（= `FreeReviewRun.retryLimit + 1`），标题里显示成「第 3/5 轮」。
   * 只有自由派审配得上 run 才知道；就地验证、合并结果审查以及拿不到 `reviews` 的只读
   * 视图一律为 null，标题退回不带分母的「第 N 轮」。
   */
  totalRounds: number | null;
  title: string;
  items: ConversationItem[];
  reviewerLabel: string | null;
  reviewerModel: string | null;
  /** 卡内第一条气泡的头已经被卡头顶替，模型旁边的智能水平也得跟着搬上来，不然会丢。 */
  reviewerEffort: string | null;
  /**
   * 派审时写的附言。它是这一轮审查的**输入**（每轮 prompt 都会带上），卡里摆出来才能
   * 拿它对着结论核对。只有自由派审 / 合并结果审查配得上 run 才知道；就地验证没有附言。
   */
  note: string | null;
  startedAt: string | null;
  endedAt: string | null;
  conclusion: ReviewLaneConclusion;
  complete: boolean;
  reportAvailable: boolean;
  report: ReviewLaneReport | null;
  defaultCollapsed: boolean;
};

export type ConversationFeedRow =
  | { kind: "item"; item: ConversationItem }
  | ConversationReviewLane;

/**
 * 卡内气泡跟卡头的关系：
 * - `lead`  ——「这一轮审查的第一条发言」。谁在审、什么模型档位、什么时候开始跑了多久，
 *   卡头已经原样写了一遍，气泡再顶一行只是复读，整条头部省掉。
 * - `member` —— 同一个审查者的后续发言。身份仍然是复读，但时间和用时各不相同，留着。
 * - `null`  —— 卡里混进来的别人（inline 卡在审查者开口前会先收着主任务的气泡），照常显示。
 */
export type ReviewLaneMessageRole = "lead" | "member";

function laneOwnMessage(lane: ConversationReviewLane, item: ConversationItem): boolean {
  if (item.kind !== "agent" || !item.reviewer || item.reviewer.round !== lane.round) return false;
  if (lane.reviewerLabel && item.label !== lane.reviewerLabel) return false;
  // 中途换了模型或智能水平的那条不算「卡头说过了」——真换了就得让它自己说。
  const model = item.run?.model ?? null;
  const effort = item.run?.reasoningEffort ?? null;
  return (!model || model === lane.reviewerModel) && (!effort || effort === lane.reviewerEffort);
}

export function reviewLaneMessageRoles(lane: ConversationReviewLane): Map<string, ReviewLaneMessageRole> {
  const roles = new Map<string, ReviewLaneMessageRole>();
  for (const item of lane.items) {
    if (!laneOwnMessage(lane, item)) continue;
    roles.set(item.id, roles.size === 0 ? "lead" : "member");
  }
  return roles;
}

type ActiveLane = ConversationReviewLane & { reviewerSpoke: boolean };

const STAGE_CONCLUSION = /验收阶段更新：.*（(verified|verify_failed)）/;
const FREE_REVIEW_REPAIR_HANDOFF = /^【自由工作流审查未通过(?:\s*·[^】]+)?】/;
const INLINE_REVIEW_REPAIR_HANDOFF = /^【自动(?:验证|审查)未通过(?:\s*·[^】]+)?】/;

type RepairHandoffKind = "free" | "inline";

function repairHandoffKind(item: ConversationItem): RepairHandoffKind | null {
  if (item.kind !== "user" || !item.bySystem) return null;
  const text = item.text.trimStart();
  if (FREE_REVIEW_REPAIR_HANDOFF.test(text)) return "free";
  if (INLINE_REVIEW_REPAIR_HANDOFF.test(text)) return "inline";
  return null;
}

function visibleLaneItem(item: ConversationItem): boolean {
  // 轮次、审查者与开始时间已经在卡头；正文再重复一遍「第 N 轮开始」只会制造双标题。
  // checkpoint 标记只在审查卡内部降噪；普通任务仍靠它留下「曾经暂停并续跑」的持久痕迹。
  if (laneStart(item) !== null) return false;
  if (item.kind === "event" && item.text.includes(LEGACY_SYS_MARKER)) return false;
  return repairHandoffKind(item) === null;
}

function itemEnd(item: ConversationItem): string | null {
  if (item.kind === "agent") return item.markerEndedAt ?? item.endedAt ?? item.at ?? null;
  return item.at ?? null;
}

function conclusionOf(item: ConversationItem): ReviewLaneConclusion {
  if (item.kind !== "event") return null;
  const stage = STAGE_CONCLUSION.exec(item.text)?.[1];
  if (stage === "verified" || stage === "verify_failed") return stage;
  const mark = verifyNoteOf(item.text);
  if (!mark || mark.phase !== "end") return null;
  if (mark.kind === "inline") {
    if (item.tone === "error") return "verify_failed";
    return /第\s*\d+\s*轮验证通过(?:$|[。，；：\s])/.test(item.text) ? "verified" : "inconclusive";
  }
  // 自由派审 / 合并结果审查的收尾旁注。tone 在这里不能当判据：「未通过」本身就命中
  // noteTone 的失败词表，跟「启动失败」是同一个红，可结论完全不同。
  if (/审查通过/.test(item.text)) return "verified";
  if (/审查(仍)?未通过/.test(item.text)) return "verify_failed";
  return "inconclusive";
}

function laneStart(item: ConversationItem): VerifyNoteMark | null {
  if (item.kind !== "event") return null;
  const mark = verifyNoteOf(item.text);
  return mark?.phase === "start" ? mark : null;
}

function matchingEnd(item: ConversationItem, lane: ActiveLane): boolean {
  if (item.kind !== "event") return false;
  const mark = verifyNoteOf(item.text);
  if (mark?.phase !== "end" || mark.kind !== lane.source) return false;
  // 「自由工作流审查仍未通过，自动复审次数已用完」这类收尾不带轮号，但它收的就是
  // 当前这一轮 —— 不认的话最后一轮永远等不到收口。
  return mark.round === lane.round || (lane.source === "free" && mark.round === null);
}

function closeBefore(lane: ActiveLane, item: ConversationItem): boolean {
  if (item.kind === "user") return !item.bySystem && !item.isAnswer;
  if (item.kind === "agent") {
    // 就地验证搭在被验任务自己的会话上，区间内说话的就是审查者；轮次徽标要等 run 事件
    // 或旁注区间补上，所以在审查者开口前先放行（reviewerSpoke 门禁）。
    // 自由派审反过来 —— 它另开一条 reviewer 会话，主任务完全可能同时在说话，那些发言
    // 一旦折进审查卡就会被默认收起、彻底藏掉，所以不是本轮审查者就立刻收口。
    if (lane.source === "inline") return lane.reviewerSpoke && item.reviewer?.round !== lane.round;
    return item.reviewer?.round !== lane.round;
  }
  // 自由派审段落里的旁注全归这张卡，收口交给服务端一定会写的那条结束旁注（matchingEnd）
  // 以及上面两条兜底；就地验证没有这样一条必到的收尾信号，只能推。
  if (lane.source !== "inline") return false;
  return !!lane.conclusion && lane.reviewerSpoke
    && (
      item.variant === "boundary"
      || item.text.includes(LEGACY_SYS_MARKER)
      // verified 阶段通告之后，审查者还会继续写最终结论；真正跟在它后面的第一条普通
      // 生命周期旁注（开始验收 / 合并 / 清理 / 唤醒）才是 D 卡的稳定收口。历史落盘稿
      // 没有直播 turnEnd，这条判据同时覆盖刷新后的存量会话。
      || conclusionOf(item) === null
    );
}

function addToLane(lane: ActiveLane, item: ConversationItem): void {
  lane.items.push(item);
  lane.endedAt = itemEnd(item) ?? lane.endedAt;
  const conclusion = conclusionOf(item);
  if (conclusion) lane.conclusion = conclusion;
  if (item.kind !== "agent" || item.reviewer?.round !== lane.round) return;
  lane.reviewerSpoke = true;
  lane.reviewerLabel ??= item.label;
  lane.reviewerModel ??= item.run?.model ?? null;
  lane.reviewerEffort ??= item.run?.reasoningEffort ?? null;
}

function finishLane(
  lane: ActiveLane,
  { complete = false, superseded = false }: { complete?: boolean; superseded?: boolean } = {},
): ConversationReviewLane {
  if (superseded && lane.conclusion === null) lane.conclusion = "inconclusive";
  lane.complete = complete || superseded || lane.conclusion !== null;
  // 就地验证的报告只能推：跑完且审查者确实说过话，就当那一轮有 report.md。
  // 自由派审不用推，下面 attachReports 拿得到落盘状态里的 reportMarkdown。
  if (lane.source === "inline") {
    lane.reportAvailable = lane.complete && lane.reviewerSpoke;
    if (lane.reportAvailable && lane.round !== null) lane.report = { kind: "inline", round: lane.round };
  }
  const { reviewerSpoke: _reviewerSpoke, ...finished } = lane;
  return { ...finished, items: finished.items.filter(visibleLaneItem) };
}

function titleOf(source: ReviewLaneSource, round: number | null, totalRounds: number | null): string {
  if (source === "merge") return "合并结果审查";
  // 知道这条链一共几轮时写成「第 3/5 轮」——否则用户看着「第 3 轮」不知道还剩几轮。
  const scale = round !== null && totalRounds !== null ? `${round}/${totalRounds}` : `${round}`;
  return `第 ${scale} 轮${source === "inline" ? "验证" : "审查"}`;
}

/**
 * 给自由派审 / 合并结果审查的卡补上报告入口**和总轮数**。
 *
 * 报告落在 `data/runs/<taskId>/free-review/<runId>/round-<N>/report.md`，URL 少了 runId
 * 就打不开；而时间线旁注里**只有轮号**（服务端从不把 runId 写进去，总轮数更是从来没写过）。
 * 所以只能拿 `FreeWorkflowState.reviews` 反查：同一类 target 下按起始时间升序、轮号对得上
 * 就依次配对，配过的不再复用 —— 同一个轮号在重开的审查里会重复出现，一一对应比「找到就用」稳。
 */
function attachReports(lanes: ConversationReviewLane[], reviews: readonly FreeReviewRun[]): void {
  const candidates = reviews
    .flatMap((run) => (run.rounds ?? []).map((round) => ({
      runId: run.id,
      round: round.round,
      source: run.target?.kind === "accepted_merge" ? "merge" as const : "free" as const,
      // 「最多几轮」= 首轮 + 允许的自动复审次数。接力导入 / 旧快照可能没有这个字段，
      // 那就退回不带分母的标题，绝不能拿 NaN 去拼「第 1/NaN 轮」。
      totalRounds: Number.isInteger(run.retryLimit) ? run.retryLimit + 1 : null,
      startedAt: round.startedAt ?? "",
      hasReport: (round.reportMarkdown ?? "").trim().length > 0,
      reviewerName: run.reviewerName,
      model: run.model,
      effort: run.reasoningEffort,
      note: run.note ?? null,
    })))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const assigned = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    // 重跑异常回合沿用同一个 runId + round，数据库也只保留这一条 round；时间线上却有
    // 「启动失败旧卡 + 重跑结果卡」两张。候选应落到本次 run 的时间窗口内最后一次尝试，
    // 下一条同类 round 的 startedAt 就是窗口右边界。否则旧卡会抢走后来生成的报告。
    const nextAt = candidates.slice(index + 1)
      .find((next) => next.source === candidate.source)?.startedAt ?? null;
    const started = Date.parse(candidate.startedAt);
    const ended = nextAt ? Date.parse(nextAt) : Number.NaN;
    const matching = lanes.filter((lane) => {
      if (assigned.has(lane.id) || lane.source !== candidate.source) return false;
      if (candidate.source === "free" && lane.round !== candidate.round) return false;
      const at = lane.startedAt ? Date.parse(lane.startedAt) : Number.NaN;
      if (Number.isFinite(started) && Number.isFinite(at) && at < started) return false;
      if (Number.isFinite(ended) && Number.isFinite(at) && at >= ended) return false;
      return true;
    });
    // 总轮数是这条 run 的属性，同一轮的每张卡都成立 —— 只补给拿到报告的那张，会让
    // 「启动失败旧卡」显示成「第 3 轮」、紧挨着的重跑卡显示成「第 3/5 轮」。
    // 附言同理：它属于整条 run，配到这一轮的每张卡都该带上。
    for (const lane of matching) {
      if (candidate.note && lane.note === null) lane.note = candidate.note;
      if (candidate.source !== "free" || candidate.totalRounds === null || lane.totalRounds !== null) continue;
      lane.totalRounds = candidate.totalRounds;
      lane.title = titleOf(lane.source, lane.round, candidate.totalRounds);
    }
    const lane = matching.at(-1);
    if (!lane) continue;
    assigned.add(lane.id);
    // 审查者会话还没落盘时卡上没有气泡可推名字，用配到的这一 run 补齐。
    lane.reviewerLabel ??= candidate.reviewerName || null;
    lane.reviewerModel ??= candidate.model;
    lane.reviewerEffort ??= candidate.effort;
    if (!candidate.hasReport) continue;
    lane.reportAvailable = true;
    lane.report = { kind: "free", runId: candidate.runId, round: candidate.round };
  }
  // 刚开的那一轮可能还没有对应的 round 行（服务端先写旁注、后插行，快照也可能差一拍），
  // 上面按轮号配对就配不到它。分母是整条 run 的属性，同一条链不能这张带、下一张不带 ——
  // 用时间上最近、且轮号更小的那条候选兜底（轮号更小 = 确实是同一条链在往下走，不会把
  // 上一条已结束的审查的上限套到新开的一条上）。
  const freeCandidates = candidates.filter((candidate) => candidate.source === "free");
  for (const lane of lanes) {
    if (lane.source !== "free" || lane.round === null) continue;
    const at = lane.startedAt ? Date.parse(lane.startedAt) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    const owner = freeCandidates.findLast((candidate) => {
      const started = Date.parse(candidate.startedAt);
      return Number.isFinite(started) && started <= at && candidate.round < lane.round!;
    });
    if (!owner) continue;
    // 附言同样是整条链的属性：新开那一轮还没有自己的 round 行，也该带着上一轮的附言。
    if (owner.note && lane.note === null) lane.note = owner.note;
    if (lane.totalRounds !== null || !owner.totalRounds) continue;
    lane.totalRounds = owner.totalRounds;
    lane.title = titleOf(lane.source, lane.round, owner.totalRounds);
  }
}

// D 方案的结构推导：把「第 N 轮验证开始」「自由工作流第 N 轮审查开始」「合并结果审查开始」
// 各自圈出的那一段折成一张结论卡，历史轮默认收起、只留结论和报告入口。
export function conversationFeedRows(
  items: ConversationItem[],
  options?: { reviews?: readonly FreeReviewRun[] | null },
): ConversationFeedRow[] {
  const rows: ConversationFeedRow[] = [];
  let active: ActiveLane | null = null;
  const pushActive = (opts?: { complete?: boolean; superseded?: boolean }) => {
    if (!active) return;
    rows.push(finishLane(active, opts));
    active = null;
  };

  for (const item of items) {
    const start = laneStart(item);
    // 同一轮的「重跑上一回合」接着原来那张卡跑，不另开一张只有半截的历史卡。
    const rerun = !!active && !!start && start.kind === active.source && start.round === active.round;
    if (active && start && !rerun) pushActive({ superseded: true });
    else if (active && closeBefore(active, item)) pushActive();
    if (!active && start) {
      active = {
        kind: "review-lane",
        id: `review-lane:${start.kind}:${start.round ?? "once"}:${item.id}`,
        source: start.kind,
        round: start.round,
        totalRounds: null,
        title: titleOf(start.kind, start.round, null),
        items: [],
        reviewerLabel: null,
        reviewerModel: null,
        reviewerEffort: null,
        note: null,
        startedAt: item.at ?? null,
        endedAt: item.at ?? null,
        conclusion: null,
        complete: false,
        reportAvailable: false,
        report: null,
        defaultCollapsed: false,
        reviewerSpoke: false,
      };
    }
    if (!active) {
      rows.push({ kind: "item", item });
      continue;
    }
    addToLane(active, item);
    if (matchingEnd(item, active)) pushActive({ complete: true });
  }
  pushActive();

  const lanes = rows.filter((row): row is ConversationReviewLane => row.kind === "review-lane");
  attachReports(lanes, options?.reviews ?? []);
  for (const lane of lanes) {
    // 出了结论的轮次一律折起来（最新那轮也一样，用户 2026-09-02 要求）：结论、审查者和
    // 报告入口在卡头上已经看得见，正文只在想细看时展开。还在跑的轮次保持展开，让用户
    // 能跟着看进度。
    lane.defaultCollapsed = lane.conclusion !== null;
  }
  // 修复交接紧跟在被打回的卡后面。就地验证的整份内嵌报告一律由卡片入口替代；自由派审
  // 只有在 report.md 确实可打开时才隐藏原 prompt，没有报告就保留它作为证据目录兜底。
  let previousLane: ConversationReviewLane | null = null;
  return rows.filter((row) => {
    if (row.kind === "review-lane") {
      previousLane = row;
      return true;
    }
    const handoff = repairHandoffKind(row.item);
    if (handoff === "inline") return false;
    if (handoff === "free") return !(previousLane?.source === "free" && previousLane.reportAvailable);
    return true;
  });
}
