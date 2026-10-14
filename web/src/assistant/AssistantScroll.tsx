import { useRef, type ReactNode } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useScrollEdges } from "../lib/useScrollEdges.ts";

function MessageScroll({ conversationId, tailKey, children }: { conversationId: string; tailKey: string; children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const { resume } = useStickToBottom(scroll, conversationId, tailKey);
  const { atBottom } = useScrollEdges(scroll, conversationId);
  return <div className="chat-feed-wrap">
    <div className="chat-feed assistant-scroll" ref={scroll}>{children}</div>
    {!atBottom && <button className="chat-jump" type="button" onClick={() => { resume(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }}><ArrowDown size={13} />最新消息</button>}
  </div>;
}

export function AssistantScroll({ conversationId, tailKey, followMessages, children }: {
  conversationId: string;
  /** 会话尾部指纹(`chatTailKey`):这个组件只拿得到 children,认不出哪条是新消息。 */
  tailKey: string;
  followMessages: boolean;
  children: ReactNode;
}) {
  return followMessages ? <MessageScroll conversationId={conversationId} tailKey={tailKey}>{children}</MessageScroll>
    : <div className="chat-feed-wrap"><div className="chat-feed assistant-scroll">{children}</div></div>;
}
