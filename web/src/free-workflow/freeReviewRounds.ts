// 自由审查各轮的叫法：右侧「审查」「工作流」两格和它们点开的正文共用这一份，免得同一轮
// 在两处各说各的。
import type { FreeReviewRound, FreeReviewRun } from "@ash/shared";

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function timeText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TIME_FORMAT.format(date);
}

export function durationText(startedAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
}

/** 「8/9 14:22 · 9 分钟」：开始时间加用时，还没结束就只有开始时间。 */
export function timing(startedAt: string, endedAt: string | null): string {
  const duration = durationText(startedAt, endedAt);
  return `${timeText(startedAt)}${duration ? ` · ${duration}` : ""}`;
}

/** 「8/9 14:22 → 14:35」：点开一轮时那一行的起止。 */
export function timeRange(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return `${timeText(startedAt)} 开始`;
  const end = new Date(endedAt);
  return `${timeText(startedAt)} → ${Number.isNaN(end.getTime()) ? endedAt : CLOCK_FORMAT.format(end)}`;
}

export function checkModeText(run: FreeReviewRun): string {
  return run.checkMode === "logic" ? "逻辑检查" : "语法检查";
}

export function reviewKey(runId: string, round: number): string {
  return `${runId}:${round}`;
}

// 「只提了转出、一条都没驳」要单独说：执行者那时说的恰恰是**报告是对的**，只是不该
// 在这个任务里修。一律写「已驳回」会让用户以为双方在争这条意见成不成立，从而把
// 「转为独立任务」当成「采纳执行者」的同义词按下去（卡片标题同判据）。
export function deferOnly(round: FreeReviewRound): boolean {
  return !!round.dispute?.deferReason && !round.dispute.reason;
}

// 驳回过的轮次不能只显示「未通过」：那一轮到底是照改了、还是被用户判作废了，是两件
// 完全不同的事，列表和正文都得带着说。
function disputeSuffix(round: FreeReviewRound): string {
  const dispute = round.dispute;
  if (!dispute) return "";
  if (dispute.resolution === "withdrawn") return " · 意见已作废";
  if (dispute.resolution === "deferred") return " · 已转独立任务";
  if (dispute.resolution === "upheld") return " · 驳回未获支持";
  if (dispute.supersededAt) return " · 已被新一轮取代";
  if (dispute.debates.at(-1)?.status === "running") return " · 辩论中";
  return deferOnly(round) ? " · 执行者提出越界" : " · 执行者已驳回";
}

/**
 * 这一轮没给出结论是哪一类（服务端判的，见 `FreeReviewRound.noVerdict`）：回合中途断了 / 收尾了
 * 没上报。老记录没有这一项，照旧叫「异常」。
 */
function noVerdictHead(round: FreeReviewRound): string {
  if (!round.noVerdict) return "异常";
  return round.noVerdict.kind === "interrupted" ? "中断" : "没上报结论";
}

/** 结论行那一句里轮号后面的半句：「中断 · 模型上游连不上（503）」。老记录给「异常」。 */
export function noVerdictText(round: FreeReviewRound): string {
  return round.noVerdict ? `${noVerdictHead(round)} · ${round.noVerdict.reason}` : noVerdictHead(round);
}

/** 点开那一轮、报告还没有时那一句：「这一轮中断：模型上游连不上（503），报告尚未生成。」 */
export function missingReportText(round: FreeReviewRound): string {
  if (round.status === "reviewing") return "还在审，报告写完会出现在这里。";
  return round.noVerdict ? `这一轮${noVerdictHead(round)}：${round.noVerdict.reason}，报告尚未生成。` : "报告尚未生成。";
}

/** 一轮的结论，记录行右边那一段。 */
export function reviewRoundLabel(round: FreeReviewRound): string {
  if (round.status === "reviewing") return "审查中";
  if (round.conclusion === "verified") return "已通过";
  if (round.conclusion === "verify_failed") return `未通过${disputeSuffix(round)}`;
  return noVerdictHead(round);
}

export function reviewRoundTone(round: FreeReviewRound): "plain" | "bad" | "live" {
  if (round.status === "reviewing") return "live";
  return round.conclusion === "verified" ? "plain" : "bad";
}

// 同一类问题连着几轮没收口、这一轮的修复已经换成「改全或交给你选」（服务端熔断，见
// server/src/review-recurrence.ts）。措辞与时间线那一条同源，刷新后照样在。
export function recurrenceText(round: FreeReviewRound): string | null {
  return round.recurrence ? `同类问题第 ${round.recurrence} 轮未收口，已熔断` : null;
}

export function disputeStateText(round: FreeReviewRound): string {
  const dispute = round.dispute;
  if (!dispute) return "执行者驳回";
  // 这一行是**历史记录**里的状态条，措辞跟着裁定屏走（用户 2026-10-20 要的是人话）：
  // 说「谁不认什么、你当时怎么判的」，不说状态枚举的名字。
  const who = deferOnly(round) ? "执行者说这几条该另开任务改" : "执行者不认这一轮意见";
  if (dispute.resolution === "withdrawn") return `${who} · 你判了这一轮不用改`;
  if (dispute.resolution === "deferred") return `${who} · 你把它转成了独立任务`;
  if (dispute.resolution === "upheld") return `${who} · 你让它接着改了`;
  if (dispute.supersededAt) return `${who} · 你没裁定，另派了一轮审查`;
  return dispute.debates.at(-1)?.status === "running" ? `${who} · 双方辩论中` : `${who} · 等你拍板`;
}
