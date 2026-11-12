import type { ContextUsage, Session, TokenUsage } from "@ash/shared";
import type { ConversationItem } from "../conversationModel.ts";

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

// 服务端（server/src/executors/claude-stream.ts）把 claude 的 `status:"compacting"` 心跳抬成
// 一行正文「> 正在压缩上下文…」，压完补一行「> 上下文已压缩。」；失败走 error 事件，回合
// 照常收口。所以「此刻在压」= 回合还开着，且最后一次开压之后还没有收口那一行。
const COMPACT_START = "正在压缩上下文…";
const COMPACT_DONE = "上下文已压缩。";

function compactingNow(item: Extract<ConversationItem, { kind: "agent" }>): boolean {
  if (item.endedAt) return false;
  const started = item.markdown.lastIndexOf(COMPACT_START);
  return started >= 0 && item.markdown.lastIndexOf(COMPACT_DONE) < started;
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
