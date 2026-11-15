// 讨论每一段、以及说完之后那段合稿交给各方的话（server/src/discussion.ts 里起回合时用）。
//
// 做法搬自原讨论模式（duet/prompts.ts），那边已经想清楚的三样照搬：
//   · 第一轮各写各的——两份真正独立的看法才是后面讨论的原料，所以这一段不给别人的发言，还明说别去翻实时记录；
//     讨论之前的背景改读发起时截下的那几份副本（discussion-background.ts），各方拿到的是同一份；
//   · 之后每一段先吸收、再补强、最后给出此刻的完整看法：目标是合出更好的方案，不是驳倒对方；
//   · 谈拢不是举手了事：只有「我此刻的看法和各方最新的一致」才算，真实分歧要保留，合稿如实写。
// 不同的只有交卷方式：表态不再写成三行暗号让程序去解析，而是交卷时的一格 `agreed`（审查辩论那一套，
// 发言只认 debate_reply 那次调用）。
import { join } from "node:path";
import type { DiscussionParticipant, DiscussionRounds } from "@ash/shared";
import { discussionRoundsLabel, isBlindSeq } from "@ash/shared/discussion";
import type { BackgroundFile } from "./discussion-background.js";
import { RUNS_DIR } from "./paths.js";

export type SpokenSegment = { seq: number; speaker: string; statement: string };

const names = (people: readonly Pick<DiscussionParticipant, "agentType">[]) => people.map((item) => item.agentType).join("、");

function framing(input: { taskId: string; topic: string; order: readonly DiscussionParticipant[]; rounds: DiscussionRounds }): string {
  const host = input.order.find((item) => item.host)!;
  const guests = input.order.filter((item) => !item.host);
  return `【讨论】用户在这条任务里叫了 ${names(guests)}，和这条任务的执行器 ${host.agentType} 一起讨论一件事（${discussionRoundsLabel(input.rounds)}，各方轮流说，最后由 ${host.agentType} 写一份合稿给用户）。\n` +
    `任务：${input.taskId}\n\n` +
    `=== 用户要讨论的 ===\n${input.topic.trim()}\n\n`;
}

/** 讨论之前的背景：发起那一刻截下的对话记录（不含它自己那份，那在它自己的上下文里）。 */
function backgroundText(files: readonly BackgroundFile[], self: string): string {
  const list = files.filter((item) => !(item.agentType === self && item.role === "single"));
  if (!list.length) return "";
  const lines = list.map((item) => `- ${item.agentType}${item.role === "single" ? "" : `（${item.role}）`}：${item.path}`);
  return "=== 讨论之前的背景 ===\n" +
    "发起这场讨论那一刻，本任务里的对话记录截成了下面这几份只读副本（之后不会再变，各方拿到的是同一份），" +
    `包含用户说过的话。要了解之前聊过什么、用户补过哪些约束，就读它们：\n${lines.join("\n")}\n\n`;
}

const SPEAK_ONLY =
  "这一段只说话：可以读代码、跑只读的命令来核实，但不要改动任何文件、不要提交、不要跑会改变状态的命令——" +
  "一边说一边改，下一位看到的就是另一版代码了。";

function others(previous: readonly SpokenSegment[]): string {
  return previous.map((item) => `=== ${item.speaker} · 第 ${item.seq} 段 ===\n${item.statement}`).join("\n\n");
}

/** 第 seq 段交给那一方的话。`previous` = 它上一段之后别人说的（第一轮恒为空）。 */
export function discussionSegmentPrompt(input: {
  taskId: string;
  topic: string;
  order: readonly DiscussionParticipant[];
  rounds: DiscussionRounds;
  seq: number;
  total: number;
  speaker: DiscussionParticipant;
  previous: readonly SpokenSegment[];
  background: readonly BackgroundFile[];
}): string {
  const people = input.order.length;
  const blind = isBlindSeq(input.seq, people);
  const head = framing(input) + backgroundText(input.background, input.speaker.agentType) +
    `现在轮到你（${input.speaker.agentType}）说第 ${input.seq} 段（这一场最多 ${input.total} 段）。\n\n`;
  const body = blind
    ? "这是第一轮，各写各的：独立给出你自己的看法和依据（读了哪些代码、发现了什么、为什么这么判断），" +
      "主动写明它的风险、代价和不确定的假设。讨论之前的背景只读上面那几份副本；" +
      `本任务的实时对话记录（直接放在 ${join(RUNS_DIR, input.taskId)} 下的那几份 .md）这一轮不要去读，那里会有本场别人刚写的第一段，` +
      "也不要用别的办法打听别人这一场说了什么——两份真正独立的看法，才是后面讨论的原料。\n\n"
    : `下面是你上一段之后其他各方的发言：\n\n${others(input.previous)}\n\n` +
      "目标是合出比任何一方独自想出的都更好的方案，不是说服别人。先吸收：别人哪些点比你的好，直接采纳并说明；" +
      "再补强：别人的风险、遗漏或误判，指出来并给出补法；最后给出你此刻的完整看法（不只写差异）。" +
      "不要无原则附和，也不要为不同而不同，真实的分歧留着并写清取舍。\n\n" +
      "如果你确认自己此刻的看法和各方最新的说法已经一致、再谈只是重复，交卷时传 agreed=true——" +
      "每一方各自最新那一段都这么表态，讨论才提前结束；" +
      "还有实质分歧就别传。\n\n";
  return head + body + SPEAK_ONLY + "\n\n" +
    `说完调用 debate_reply(taskId="${input.taskId}", summary="<一句人话>", statement="<你这一段的完整发言>"${blind ? "" : "[, agreed=true]"}) 交卷，然后结束回合。` +
    "发言只认这次调用，写在输出里的不算；没交卷这场讨论会按「没说话」中止。本回合不要调用 complete_task / report_stage / accept_task。";
}

/** 说完之后交给这条任务的执行器的话：在主会话里照常回一段，就是合稿。 */
export function discussionSynthesisPrompt(input: {
  taskId: string;
  topic: string;
  order: readonly DiscussionParticipant[];
  rounds: DiscussionRounds;
  agreed: boolean;
  segments: number;
  previous: readonly SpokenSegment[];
}): string {
  const head = input.agreed
    ? `【讨论说完了 · 写合稿】${names(input.order)} 谈了 ${input.segments} 段，各方表态谈拢了。`
    : `【讨论说完了 · 写合稿】${names(input.order)} 谈了 ${input.segments} 段，说满了轮数，**还没有谈拢**。`;
  const latest = input.previous.length
    ? `\n\n你上一段之后其他各方又说了这些，先读完再写：\n\n${others(input.previous)}`
    : "";
  return `${head}\n任务：${input.taskId}\n用户要讨论的：${input.topic.trim()}${latest}\n\n` +
    "现在照常回复用户一段，这段回复就是这场讨论的合稿，用户只读它：\n" +
    "1. 结论：融合各方之后的方案（不是你单方的最后一版），关键取舍和理由一并写；\n" +
    "2. 还留着的分歧：各方立场如实列出，没有就写「无」。没谈拢的绝不写成谈拢了。\n" +
    "只写合稿本身，不要开场白和客套。这一段同样只说话：不改文件、不提交；不用调 debate_reply，" +
    "本回合也不要调用 complete_task / report_stage / accept_task。";
}
