import type { AgentContentSegment } from "./conversationModel.ts";
import { isBookkeepingEvent, type ExecutionEvent } from "../lib/executionTrace.ts";

/**
 * 这一步算不算「动手」—— 只有动手过的事件才配当切点。
 *
 * 排除两类：
 * - **记账调用**（isBookkeepingEvent）：complete_task、把待办划掉这类，现场什么都没发生。
 * - **异常**：它是回合的旁白，不是这一轮干的活。结算那条尤其毒 —— 退出码非 0 时，server
 *   在正文写完之后才补一条 error（single-run.ts 的 settled.note），拿它当切点，整篇回答就
 *   被折进过程，外面只剩那句失败提示。未确认完成那一支现在改走会话旁注（level:"notice"），
 *   不再进 trace，但 2026-08-31 之前的老会话里它仍是一条 error，这道排除照旧要管住。
 */
function isHandsOn(event: ExecutionEvent): boolean {
  return event.kind !== "error" && !isBookkeepingEvent(event);
}

/**
 * 过程折叠块此刻该不该自动开合。`null` = 什么都别做，维持现在的样子。
 *
 * 只有两个自动动作，其余一概不动：
 * - **摊开**：这一回合正在飞（不然用户盯着一行摘要不知道在干嘛）。
 * - **收起**：整个任务都不跑了，也就是「最后一步确认执行完了」那一下。
 *
 * 中间态（回合收口了、任务还在跑）刻意什么都不做。回合边界在一次运行里能出现好几次
 * ——换下一轮、就地验证、会话行 endedAt 落下来的那一瞬 —— 拿它当收起信号，用户会在
 * 跑的过程中被反复折叠，正读着的那段过程说没就没了。
 */
export function nextProcessFoldOpen(
  { running, taskLive, touched }: { running: boolean; taskLive: boolean; touched: boolean },
): boolean | null {
  // 用户自己动过折角就以他的选择为准，不再自动开合。
  if (touched) return null;
  if (running) return true;
  return taskLive ? null : false;
}

/**
 * 一条回合此刻该怎么排：**跑的时候一律平铺，链路停下来那一下才折**。
 *
 * 折叠本身是个**重组**动作（见 splitTurnSegments）：它把最后一次动手之前的一切 —— 连同
 * 已经说出口、已经露在外面的正文 —— 收进「执行过程」块，外面只留最后那段话。跑的过程中
 * 干这件事，用户眼睁睁看着刚读到一半的内容被吸走：agent 一说话就收编（外面只剩最后一
 * 句），下一个工具调用又把它们吐回来（切点后移、折不出结论），来回闪。
 *
 * 所以运行期不做这个判断，原样按段铺开；等整条执行链路停了（`live` 为假 —— 在跑、卡在
 * 审查门、停在检查点等人答话、团队没收工都算没停，见 taskAttention 的
 * isExecutionChainLive）再折一次，位置从此不再变。
 */
export function turnLayout(
  segments: AgentContentSegment[],
  { live }: { live: boolean },
): { process: AgentContentSegment[]; conclusion: AgentContentSegment[] } {
  if (live) return { process: [], conclusion: segments };
  return splitTurnSegments(segments);
}

/**
 * 把一个回合切成「过程」和「结论」两段。切点是**最后一次真正动手的工具/分析事件**：
 * 在它之前的一切（含夹在两次工具调用之间的正文）折起来，在它之后吐出的正文原样露在外面。
 *
 * 判据是位置而不是内容类型 —— 同一段边干边说的正文，落在最后一次动手之前就是过程，
 * 之后就是结论。这样一条长回合收起来只剩它最后要讲的那件事。
 *
 * 什么才算动手见 isHandsOn。
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
    if (segments[index]!.events.some(isHandsOn)) pivot = index;
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
  // 结论区里剩下的必然全是没动手的事件（切点定义使然）：记账调用，以及结算补的那条
  // 异常。把它们并进过程块末尾，而不是留在原位——留着就会在报告和收尾句之间夹一条
  // 「执行过程 · 1 工具」，看着像又干了点什么；异常留在原位则是在报告和它自己的失败
  // 说明之间再插一行同样的红字。异常并进来后折叠条照旧标红（hasExecutionError）。
  // 代价是这几步在折叠里的位置比实际发生得早一点；折叠讲的是「做过哪些步」，不是流水账。
  const trailingEvents = trailing.flatMap((segment) => segment.events);
  if (trailingEvents.length) {
    process.push({ id: `${split.id}:bookkeeping`, markdown: "", attachments: [], events: trailingEvents });
  }
  return { process, conclusion };
}
