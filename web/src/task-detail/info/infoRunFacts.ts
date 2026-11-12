import type { ContextUsage, Session, TokenUsage } from "@ash/shared";
import type { ConversationItem } from "../conversationModel.ts";
import { COMPACTING, isCompactionEvent } from "../../lib/compaction.ts";

/**
 * 右侧「信息」格要的那几样「最近这一轮」的事实：本轮用量、上下文水位、它是哪条会话、此刻
 * 是不是正在压缩上下文。这些以前挂在会话最后一条回复的尾栏上（本轮 / 总量 / 上下文 / 会话号 /
 * resume 几颗药丸），数据源仍是同一份：会话流里每条 agent 气泡上的 usage / sessionContext
 * （直播里刚报的那份比会话行上的新，conversationModel 已经取好了）。
 */
export interface InfoRunFacts {
  /** 最近一轮烧了多少；null = 那家 CLI 不报账。 */
  turnUsage: TokenUsage | null;
  /** 最近一轮是哪个执行器跑的（多个执行器时「本轮」后面跟它的名字）。 */
  turnLabel: string | null;
  /** 最近一轮所在的会话：上下文那一行的「压缩设置」要它定位执行器 profile。 */
  session: Session | null;
  context: ContextUsage | null;
  /** 正在自动 / 手动压缩上下文（见 compactingNow）。 */
  compacting: boolean;
}

export const EMPTY_RUN_FACTS: InfoRunFacts = { turnUsage: null, turnLabel: null, session: null, context: null, compacting: false };

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

export function latestRunFacts(items: readonly ConversationItem[]): InfoRunFacts {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "agent") continue;
    return {
      turnUsage: item.usage ?? null,
      turnLabel: item.label || null,
      session: item.session ?? null,
      context: item.sessionContext ?? item.session?.context ?? null,
      compacting: compactingNow(item),
    };
  }
  return EMPTY_RUN_FACTS;
}
