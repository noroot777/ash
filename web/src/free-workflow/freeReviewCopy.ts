import type { FreeReviewDebate, FreeReviewRound, FreeReviewRun, FreeWorkflowState, Task } from "@ash/shared";
import { reviewAnchorMatches } from "@ash/shared/free-workflow";

// 审查链只有四个持久状态；「修复中 / 等待复审 / 结论过期」全部在这里**推导**出来：
// - 修复中 = 任务本身 running/queued 且最近一轮停在未通过（或挂着预约）
// - 等待自动复审 = 预约槽 armed 且挂着 runId
// - 结论新鲜度 = 三态：fresh（工作区对得上这一轮的锚点）/ stale（对不上）/ unknown（缺锚点
//   或读不到工作区）。判据与服务端放行修复共用 shared 的 `reviewAnchorMatches`。unknown 绝不能
//   显示成新鲜——失败要向着「不确定」开，不能向着「没问题」开。
export const FREE_REVIEW_RUN_LABELS: Record<FreeReviewRun["status"], string> = {
  reviewing: "审查中",
  passed: "已通过",
  stopped: "未通过，等待处理",
  failed: "审查链异常停止",
};

/**
 * 删审查者的确认文案。两处表面（设置页、派审对话框）共用一份，免得一边说「历史记录保留」、
 * 另一边只说「确定吗」。后果按服务端 `reviewer-profiles.ts` 的 DELETE 实际做的事写，三句
 * 话对应它做的三件事：配置是全局的（所有任务的清单里都没了）、**还没开跑**的手动预约按
 * 它的配置跑不起来所以被 disarm、**已经在跑**的自动复审读的是 run 行里的冻结快照 —— 删了
 * 照样一轮轮跑完。最后这句不能省：少了它，用户会把「删掉配置」当成「停掉正在跑的复审链」，
 * 那是两件事（真要停，走审查链自己的停止入口）。
 */
export function reviewerDeleteMessage(name: string, options: { breaksReservation?: boolean } = {}): string {
  return `确定删除“${name}”？这份配置会从所有任务的审查者列表里消失；历史审查记录仍保留当时的配置快照。`
    + (options.breaksReservation ? "本任务已排上、还没开跑的审查预约会一并取消；" : "任何任务上已排好、还没开跑的审查预约会被取消；")
    + "已经在跑的自动复审用的是开跑那一刻的配置快照，删掉配置也会继续跑完。";
}

export function freeReviewBlockingLabel(run: FreeReviewRun): string | null {
  return run.status === "reviewing" ? "审查进行中" : null;
}

function checkModeLabel(run: FreeReviewRun): string {
  return run.checkMode === "logic" ? "逻辑检查" : "语法检查";
}

export function freeReviewActivityTitle(run: FreeReviewRun): string {
  return `${run.reviewerName} · ${checkModeLabel(run)}`;
}

export function freeReviewActivityDetail(run: FreeReviewRun): string {
  return `${FREE_REVIEW_RUN_LABELS[run.status]} · 已到第 ${run.currentRound} 轮 / 最多 ${run.retryLimit + 1} 轮`;
}

export type FreeReviewFreshness = "fresh" | "stale" | "unknown";

/**
 * 最近一轮**有结论**的审查相对当前工作区的新鲜度。只看最新结论轮自己的锚点，
 * 不回退借用更早轮次（借用会把「最新一轮没锚点」洗成旧轮的结论）。
 */
export function freeConclusionFreshness(
  run: FreeReviewRun | undefined,
  workspaceHead: string | null | undefined,
  workspaceDirty: boolean | null | undefined,
  workspaceFingerprint?: string | null,
): FreeReviewFreshness | null {
  if (!run || (run.status !== "passed" && run.status !== "stopped")) return null;
  const concluded = [...run.rounds].reverse().find((round) => round.conclusion);
  const anchored = concluded
    ? reviewAnchorMatches(concluded, { head: workspaceHead, dirty: workspaceDirty, fingerprint: workspaceFingerprint })
    : null;
  return anchored == null ? "unknown" : anchored ? "fresh" : "stale";
}

export type FreeReviewView = {
  latestRun: FreeReviewRun | undefined;
  /** 审查旁路回合正在跑（派审/预约/验收都要等它） */
  reviewing: FreeReviewRun | undefined;
  /** 最近一轮停在未通过（修复按钮、警示的锚点） */
  stoppedRun: FreeReviewRun | null;
  /** 最近一条链异常停止（验收页要警示，不能静默当成没审过） */
  failedRun: FreeReviewRun | null;
  taskBusy: boolean;
  /**
   * 此刻在跑的是**审查/验证旁路回合**（服务端的运行时事实，不是从 reviews 里猜的）。
   *
   * 预览类动作按它放行：那种回合只读工作区、不产出新一版代码，`taskBusy` 那条「代码改到
   * 一半，预览没有意义」的理由对它不成立。判据必须与后端完全一致（server 的
   * review-turn.ts），否则就是「后端允许、按钮却灰着」或者「按钮能点、请求吃 409」。
   */
  reviewTurn: boolean;
  /** 任务挂着待答复的提问或待续跑的检查点指令 —— 「立即派审/修复/开预览」后端必拒（409）。 */
  waiting: boolean;
  reservationArmed: boolean;
  /** 派审按钮此刻的语义是「预约一轮跑完就审」而不是「立刻开审」。
   *  判据是**这个任务后面还会再动**:正在跑(taskBusy)、停在检查点或等答复(waiting)、
   *  或者已经挂着一条预约(armed,点进去是改预约)。后端 reserveFreeReview 对这三种
   *  一律放行,所以这里必须一起认——只认 taskBusy 会把「暂停在检查点的任务」判成
   *  「立刻开审」,再被 waiting 一票否决,入口就死了(第 1 轮审查实测)。 */
  reservationMode: boolean;
  /** armed 且挂着 runId = 自动复审链的续轮预约 */
  autoRereview: boolean;
  /** 任务在改（running/queued）且有未通过意见在身或挂着自动续轮——「修复中」的叙事。
   *  用户手动预约（runId 空）不算：首次审查还没发生过，没有什么可「修复」的。 */
  repairing: boolean;
  /** 最近结论的新鲜度；最近一轮没有结论（reviewing/failed/无审查）时为 null */
  freshness: FreeReviewFreshness | null;
  /** 结论确定过期（freshness === "stale" 的便捷判断） */
  stale: boolean;
  /** 执行者驳回了、用户还没裁定的那一轮（任务级，见 openDisputeEntryIn）；null = 没有待裁定的驳回。 */
  disputedRound: FreeReviewRound | null;
  /** `disputedRound` 所在的审查链（不一定是最近那条：更新的链遮不住它）。 */
  disputedRun: FreeReviewRun | null;
  /** 最近一轮未通过意见已被用户裁定为「不在本任务里修」（作废或转独立任务）；修复入口必须跟着消失。 */
  waivedRound: FreeReviewRound | null;
  /** 待裁定驳回上最近那条辩论（含已结束/已中止的）；没开过为 null。 */
  debate: FreeReviewDebate | null;
  /** 辩论正在进行（双方轮流发言的旁路回合还没走完）。 */
  debateRunning: boolean;
};

/** 最新有结论的那一轮（驳回、裁定都挂在它身上）。 */
function concludedRound(run: FreeReviewRun | null | undefined): FreeReviewRound | null {
  if (run?.status !== "stopped") return null;
  return [...run.rounds].reverse().find((round) => round.conclusion) ?? null;
}

/**
 * 「执行者驳回了、等用户裁定」——整个任务上驳回已写下、没裁定、也没被用户新派的审查
 * 取代的那一轮（有多条时取最近驳回的那条），连同它所在的审查链。
 *
 * 口径与服务端 `openDisputeOf` 一致，是**任务级**的：只看最近一条链的话，一条更新的审查
 * 链就能把旧驳回遮住——服务端的裁定闸照样挡着预约，界面上却找不到那张该点的卡。
 * 合并结果审查是验收后的独立只读链，不参与验收前的裁定语义（同 freeReviewView）。
 */
export function openDisputeEntryIn(
  runs: readonly FreeReviewRun[] | null | undefined,
): { run: FreeReviewRun; round: FreeReviewRound } | null {
  const open = (runs ?? []).filter((run) => run.target?.kind !== "accepted_merge")
    .flatMap((run) => run.rounds.map((round) => ({ run, round })))
    .filter(({ round }) => round.dispute && !round.dispute.resolution && !round.dispute.supersededAt);
  return open.sort((a, b) => b.round.dispute!.at.localeCompare(a.round.dispute!.at))[0] ?? null;
}

/**
 * 同上只取那一轮（会话那一侧只拿得到 `reviews`）。会话里那颗「去裁定」按钮和审查面板上
 * 那张卡必须同生共死，所以两边都从这一处取，各算各的就会出现「按钮还在、卡片没了」。
 */
export function openDisputeIn(runs: readonly FreeReviewRun[] | null | undefined): FreeReviewRound | null {
  return openDisputeEntryIn(runs)?.round ?? null;
}

/**
 * 「用户已经裁定这一轮不在本任务里修」——采纳执行者（`withdrawn`）或转成了独立任务
 * （`deferred`）。两档都必须关掉修复入口：前者那条意见作废了，后者已经有别的任务在
 * 承接，在本任务里再修一遍就是两处各改一版。
 */
export function waivedDisputeRound(run: FreeReviewRun | null | undefined): FreeReviewRound | null {
  const round = concludedRound(run);
  const resolution = round?.dispute?.resolution;
  return resolution === "withdrawn" || resolution === "deferred" ? round : null;
}

/**
 * 整个任务上**已经裁定成「不在本任务里修」**的那几轮（转独立任务 / 采纳执行者说法）。
 *
 * 派审面上只用它显示一句话：这几条服务端会自动讲给下一位审查者听，附言里不必再复述
 * 一遍。不说的话用户无从知道这件事已经自动化了，只会照旧每轮手打「有异议的已经转为
 * 新任务，只审查本次改动内容」（用户 2026-09-30 反馈）。真正把它拼进 prompt 的是服务端
 * free-review-settled.ts —— 这里只负责**告诉用户有这回事**，措辞不必两边对齐。
 */
export function settledDisputeRounds(
  runs: readonly FreeReviewRun[] | null | undefined,
): { round: number; resolution: "withdrawn" | "deferred" }[] {
  return (runs ?? []).flatMap((run) => run.rounds).flatMap((round) => {
    const resolution = round.dispute?.resolution;
    return resolution === "withdrawn" || resolution === "deferred"
      ? [{ round: round.round, resolution }]
      : [];
  });
}

export function freeReviewView(state: FreeWorkflowState | null | undefined, task: Task): FreeReviewView {
  // 合并结果审查是验收后的独立只读链，不参与验收前的修复、新鲜度和预约语义。
  const reviews = (state?.reviews ?? []).filter((run) => run.target?.kind !== "accepted_merge");
  const latestRun = reviews[0];
  const reviewing = reviews.find((run) => run.status === "reviewing");
  const stoppedRun = latestRun?.status === "stopped" ? latestRun : null;
  const failedRun = latestRun?.status === "failed" ? latestRun : null;
  const taskBusy = task.status === "running" || task.status === "queued";
  const waiting = !!task.question || !!task.resumePrompt;
  const reservationArmed = !!state?.reviewReservation?.armed;
  const autoRereview = reservationArmed && !!state?.reviewReservation?.runId;
  const freshness = freeConclusionFreshness(
    latestRun, state?.workspaceHead, state?.workspaceDirty, state?.workspaceFingerprint,
  );
  const disputed = openDisputeEntryIn(state?.reviews);
  const disputedRound = disputed?.round ?? null;
  const debate = disputedRound?.dispute?.debates.at(-1) ?? null;
  return {
    latestRun,
    reviewing,
    stoppedRun,
    failedRun,
    taskBusy,
    reviewTurn: !!state?.reviewTurn,
    waiting,
    reservationArmed,
    reservationMode: taskBusy || waiting || reservationArmed,
    autoRereview,
    repairing: taskBusy && (!!stoppedRun || autoRereview),
    freshness,
    stale: freshness === "stale",
    disputedRound,
    disputedRun: disputed?.run ?? null,
    waivedRound: waivedDisputeRound(stoppedRun),
    debate,
    debateRunning: debate?.status === "running",
  };
}
