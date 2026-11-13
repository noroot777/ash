import type { ContextUsage, Session } from "@ash/shared";
import type { ConversationItem } from "../conversationModel.ts";
import { COMPACTING, isCompactionEvent } from "../../lib/compaction.ts";

/**
 * 右侧「信息」格要的那几样「最近这一轮」的事实：上下文水位、它是哪条会话、此刻是不是正在
 * 压缩上下文。这些以前挂在会话最后一条回复的尾栏上（总量 / 上下文 / 会话号 / resume 几颗药丸），
 * 数据源仍是同一份：会话流里 agent 气泡上的 sessionContext（直播里刚报的那份比会话行上的新，
 * conversationModel 已经取好了）。每一回合各自烧了多少不在这里，在那一回合尾「更多」菜单里。
 */
export interface InfoRunFacts {
  /** 任务自己最近一轮所在的会话（审查者另开的不算）：上下文那一行的「压缩设置」要它定位执行器 profile。 */
  session: Session | null;
  context: ContextUsage | null;
  /** 正在自动 / 手动压缩上下文（见 compactingNow）。 */
  compacting: boolean;
}

export const EMPTY_RUN_FACTS: InfoRunFacts = { session: null, context: null, compacting: false };

// 「此刻在压」= 回合还开着，执行过程里最后一次压缩那一步还停在「在压缩上下文」。压没压成，
// 服务端都会接着报一条（压完并成「压缩了上下文」，没压成是一条异常）——异常也算收口。
// 只看结构化的那一步，不看正文：正文里引一句「正在压缩上下文…」不等于正在压。
function compactingNow(item: Extract<ConversationItem, { kind: "agent" }>): boolean {
  if (item.endedAt) return false;
  let compacting = false;
  for (const event of item.segments.flatMap((segment) => segment.events)) {
    if (isCompactionEvent(event)) compacting = event.detail === COMPACTING;
    else if (event.kind === "error") compacting = false;
  }
  return compacting;
}

// 审查者另开的那条会话不是这个任务的会话：它是另一个执行器（常常是另一家 CLI）、另一个窗口、
// 另一份压缩设置。审完它就成了会话流里最后一条，照「最后一条」取，信息格的上下文和「压缩设置」
// 就整个换成审查者的，看着像任务换了执行器。按会话角色认，不按审查徽标认：徽标上的轮次会被
// 审查区间补写，就地验证轮也带徽标，而它搭在任务自己的会话上，那份上下文就是任务的。
function ownsTaskContext(item: Extract<ConversationItem, { kind: "agent" }>): boolean {
  return item.sessionRole !== "reviewer";
}

export function latestRunFacts(items: readonly ConversationItem[]): InfoRunFacts {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "agent" || !ownsTaskContext(item)) continue;
    return {
      session: item.session ?? null,
      context: item.sessionContext ?? item.session?.context ?? null,
      compacting: compactingNow(item),
    };
  }
  return EMPTY_RUN_FACTS;
}
