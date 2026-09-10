import { useRef, type ReactNode } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useScrollEdges } from "../lib/useScrollEdges.ts";

function MessageScroll({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const { resume } = useStickToBottom(scroll, conversationId);
  const { atBottom } = useScrollEdges(scroll, conversationId);
  return <div className="chat-feed-wrap">
    <div className="chat-feed assistant-scroll" ref={scroll}>{children}</div>
    {!atBottom && <button className="chat-jump" type="button" onClick={() => { resume(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }}><ArrowDown size={13} />最新消息</button>}
  </div>;
}

export function AssistantScroll({ conversationId, followMessages, children }: {
  conversationId: string; followMessages: boolean; children: ReactNode;
}) {
  return followMessages ? <MessageScroll conversationId={conversationId}>{children}</MessageScroll>
    : <div className="chat-feed-wrap"><div className="chat-feed assistant-scroll">{children}</div></div>;
}
