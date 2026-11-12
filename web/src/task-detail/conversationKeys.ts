// 会话里每一条的 React 身份（docs/ui-ux-audit 08 的两条工程前提之二：一条消息从发出到这一回合
// 收口是同一个身份）。
//
// 条目的 id 有好几套来源：直播里的回合按它在列表里的位置起名（`live:<会话>:<位置>`），你刚发的
// 话是客户端起的号，回合收口、会话重读回来以后又换成落盘那一套（`persisted:…`）。拿 id 当 key，
// 收口那一刻整条回复会被卸掉重建——折叠的开合、复制的反馈、正在播的动画全丢，看起来就是「整颗
// 重建」。这里按**它是什么**起 key：一回合 = 哪条会话、从哪一刻开始、谁在说；你的一句话 = 说了
// 什么。同样的东西出现第二次时带上序号。id 照旧用于删除、派生、定位，不受影响。
import type { ConversationItem } from "./conversationModel.ts";

export function conversationKeys(items: readonly ConversationItem[]): Map<string, string> {
  const seen = new Map<string, number>();
  const keys = new Map<string, string>();
  for (const item of items) {
    const base = item.kind === "agent"
      ? `agent:${item.sessionId ?? ""}:${item.at ?? ""}:${item.reviewer ? `r${item.reviewer.round}` : ""}`
      : item.kind === "user"
        ? `user:${item.text.length}:${item.text.slice(0, 80)}`
        : `event:${item.id}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    keys.set(item.id, count ? `${base}#${count}` : base);
  }
  return keys;
}
