// 一轮审查还没出结论时，右边那颗审查者气泡此刻说什么（ReviewBubble 的进行中那一态）。
//
// 一轮审查不是一个回合（见 conversationReviewer 开头）：审查者提问要等答复、到检查点要等续跑、
// 挂了哨兵要等结果，这几段任务都停着，这一轮却还没完。所以「还没结论」分成下面几种，点只在它
// 真的在往前走（running）时才动；在等的那几种，气泡里的字说现在等的是谁、等什么，不再报审查者
// 最后那一句——那一句是它停下之前说的，摆在那儿读起来像它还在说。
//
// 判据全是前端已有的事实：任务的状态与问题、哨兵与上游停滞两个后台位，以及这一轮是不是会话里
// 最后那一件事（`current`：它后面有人接了话，这一轮就不是「此刻」了）。
import type { TaskListItem } from "@ash/shared";
import { isVisibleExecutionEvent } from "../lib/executionTrace.ts";
import { liveLabel } from "../lib/executionWords.ts";
import type { ConversationItem } from "./conversationModel.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";

export type ReviewProgressPhase =
  /** 审查者正在说、正在跑命令，或者刚起跑还没开口。 */
  | "running"
  /** 看着在跑，其实在干等模型上游回话（turn-stall 看门狗）。 */
  | "stalled"
  /** 排着队，还没轮到。 */
  | "queued"
  /** 审查者提了问，等你答复（问题和答复入口在会话下方那张提问卡里）。 */
  | "question"
  /** 审查者挂了哨兵、暂停等结果。 */
  | "monitor"
  /** 审查者停在检查点，等续跑。 */
  | "checkpoint"
  /** 停了、没人接着跑，也没给结论（中断、被你的话打断、任务落了终态）。 */
  | "stopped";

export type ReviewProgress = {
  phase: ReviewProgressPhase;
  /** 气泡里那一句。 */
  text: string;
  /** 那一句是审查者自己说的（最多两行），不是替它说的现状。 */
  said: boolean;
  /** 此刻在跑的那一步（「正在跑 npm test」），只在 running 时有。 */
  step: string | null;
};

export type ReviewTaskFacts = Pick<TaskListItem, "status" | "question" | "monitorRunning" | "upstreamStalled">;

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;

/** 「第 2 轮审查」「第 3 轮验证」「合并结果审查」：不带分母（分母在指到才出的那一行里）。 */
export function reviewRoundLabel(lane: Pick<ConversationReviewLane, "source" | "round">): string {
  if (lane.source === "merge" || lane.round === null) return "合并结果审查";
  return `第 ${lane.round} 轮${lane.source === "inline" ? "验证" : "审查"}`;
}

function phaseOf(task: ReviewTaskFacts, current: boolean): ReviewProgressPhase {
  if (!current) return "stopped";
  if (task.question) return "question";
  if (task.status === "running") return task.upstreamStalled ? "stalled" : "running";
  if (task.status === "queued") return "queued";
  if (task.monitorRunning) return "monitor";
  if (task.status === "paused") return "checkpoint";
  return "stopped";
}

const WAITING: Partial<Record<ReviewProgressPhase, string>> = {
  stalled: "在等模型上游回话",
  question: "在等你答复它的提问",
  monitor: "在等哨兵的结果",
  checkpoint: "停在检查点，等续跑",
};

function reviewerItems(lane: ConversationReviewLane): AgentItem[] {
  return lane.items.filter((item): item is AgentItem => item.kind === "agent" && item.reviewer?.round === lane.round);
}

export function reviewProgress(lane: ConversationReviewLane, task: ReviewTaskFacts, current: boolean): ReviewProgress {
  const phase = phaseOf(task, current);
  const label = reviewRoundLabel(lane);
  const waiting = WAITING[phase];
  if (waiting) return { phase, text: waiting, said: false, step: null };
  if (phase === "stopped") return { phase, text: `${label}停了，没有给出结论`, said: false, step: null };
  const active = phase === "running";
  const own = reviewerItems(lane);
  const latest = latestSaid(own, active);
  return {
    phase,
    text: latest ?? `${label}中`,
    said: !!latest,
    step: active ? currentStep(own.at(-1)) : null,
  };
}

/**
 * 审查者最新说完的那一句。还在说的那一回合只认**说完了的**句子：句末之后那半截是正在往外冒的字，
 * 拿它来显示就是逐字抖；等它说完这一句，气泡才换字。最近一回合一句完整的话都还没有（只跑了命令），
 * 就往前一回合找。
 */
function latestSaid(own: readonly AgentItem[], active: boolean): string | null {
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const item = own[index]!;
    const sentence = lastSentence(item.markdown, active && !item.endedAt);
    if (sentence) return sentence;
  }
  return null;
}

// 句末：中文句读、换行，以及后面跟着空白的英文句点（`file.ts` 里的点不算）。
const BOUNDARY = /[。！？；!?\n]|\.(?=\s)/g;
const SENTENCE = /(?<=[。！？；!?])\s*|(?<=\.)\s+/;

export function lastSentence(markdown: string, streaming: boolean): string | null {
  // 代码块整段不算话（还没闭合的那一段也不算：它正在往外冒）。
  let text = markdown.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  if (streaming) {
    let end = 0;
    for (const match of text.matchAll(BOUNDARY)) end = match.index + match[0].length;
    text = text.slice(0, end);
  }
  const lines = text.split("\n").map(plainLine).filter((line): line is string => !!line);
  const last = lines.at(-1);
  if (!last) return null;
  return last.split(SENTENCE).map((part) => part.trim()).filter(Boolean).at(-1) ?? null;
}

/** 一行 markdown 剥成读得出的字；标题、表格、分隔线不是一句话，返回 null。 */
function plainLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith("|") || /^([-*_])\1{2,}$/.test(trimmed)) return null;
  const text = trimmed
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .trim();
  return text || null;
}

/**
 * 此刻在跑的那一步：还在说的那一回合，最后一段只有动作、动作之后还没出字。段落的排法是「先动作、
 * 后正文」（turnDocument 把每段的动作摆在那段正文前面），所以最后一段的正文一出来，那一步就做完了。
 */
function currentStep(item: AgentItem | undefined): string | null {
  if (!item || item.endedAt) return null;
  const segment = item.segments.at(-1);
  if (!segment || segment.markdown.trim() || !segment.events.some(isVisibleExecutionEvent)) return null;
  return liveLabel(segment.events, !!segment.awaiting);
}
