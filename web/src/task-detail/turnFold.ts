import type { AgentContentSegment } from "./conversationModel.ts";
import { isBookkeepingEvent } from "../lib/executionTrace.ts";

/**
 * 把一个回合切成「过程」和「结论」两段。切点是**最后一次真正动手的工具/分析事件**：
 * 在它之前的一切（含夹在两次工具调用之间的正文）折起来，在它之后吐出的正文原样露在外面。
 *
 * 判据是位置而不是内容类型 —— 同一段边干边说的正文，落在最后一次动手之前就是过程，
 * 之后就是结论。这样一条长回合收起来只剩它最后要讲的那件事。
 *
 * **记账调用不算动手**（isBookkeepingEvent）。complete_task、把待办划掉这类动作几乎总在
 * 正文写完之后才发生，拿它当切点会把整篇回答折进过程，外面只剩收尾那一句。
 *
 * 切点还常常落在**一段之内**：contentSegments 把「若干工具事件 + 紧随其后的正文」攒成同
 * 一段（见 conversationModel.ts 的 pushCurrent），所以这里要把那一段拆开——事件归过程，
 * 正文和附件归结论。按段切会把结论也一并折没。
 */
export function splitTurnSegments(segments: AgentContentSegment[]): {
  process: AgentContentSegment[];
  conclusion: AgentContentSegment[];
} {
  const flat = { process: [] as AgentContentSegment[], conclusion: segments };
  let pivot = -1;
  for (let index = segments.length - 1; index >= 0 && pivot < 0; index -= 1) {
    if (segments[index]!.events.some((event) => !isBookkeepingEvent(event))) pivot = index;
  }
  if (pivot < 0) return flat;

  const split = segments[pivot]!;
  const trailing = segments.slice(pivot + 1);
  const conclusion = [
    { ...split, id: `${split.id}:said`, events: [] },
    ...trailing.map((segment) => ({ ...segment, events: [] })),
  ];
  // 折完一个字都不剩就不折：跑完工具没再说话的回合、以及 trace 不完整退回的单段气泡，
  // 折起来用户只能对着一片空白猜发生了什么。这种回合维持原样（逐段折事件）。
  if (!conclusion.some((segment) => segment.markdown.trim() || segment.attachments.length)) return flat;

  const process = [
    ...segments.slice(0, pivot),
    { ...split, id: `${split.id}:did`, markdown: "", attachments: [] },
  ];
  // 结论区里剩下的必然全是记账事件（切点定义使然）。把它们并进过程块末尾，而不是留在
  // 原位——留着就会在报告和收尾句之间夹一条「执行过程 · 1 工具」，看着像又干了点什么。
  // 代价是这几步在折叠里的位置比实际发生得早一点；折叠讲的是「做过哪些步」，不是流水账。
  const bookkeeping = trailing.flatMap((segment) => segment.events);
  if (bookkeeping.length) {
    process.push({ id: `${split.id}:bookkeeping`, markdown: "", attachments: [], events: bookkeeping });
  }
  return { process, conclusion };
}
