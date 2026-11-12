import { useRef } from "react";
import type { Task } from "@ash/shared";
import { ArrowDown } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { InspNone } from "../inspector/parts.tsx";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { chatTailKey } from "../lib/chatTailKey.ts";
import { useScrollEdges } from "../lib/useScrollEdges.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { SideChatComposer } from "./SideChatComposer.tsx";
import { SideChatHeadControls } from "./SideChatHeadControls.tsx";
import { SideChatMessage } from "./SideChatMessage.tsx";
import { useSideChat } from "./useSideChat.ts";
import "./side-chat.css";

/**
 * 第一行说清这一场带着的是主会话哪一刻的内容：侧聊是在开场那一刻拍下主会话的快照，
 * 之后主会话再说的，这一场看不到——要带上就新开一场。
 */
function SnapLine({ at }: { at: string }) {
  const tip = useHoverTip();
  return (
    <>
      <p className="side-chat-snap" tabIndex={0} {...tip.anchorProps}>主会话快照 {formatInstant(at)}</p>
      <HoverTip at={tip.at}>它知道的是这一刻之前的主会话；之后的新内容要新开一场才带得上</HoverTip>
    </>
  );
}

export function SideChatPane({ task }: { task: Task }) {
  const chat = useSideChat(task.id);
  const scroll = useRef<HTMLDivElement>(null);
  const { resume } = useStickToBottom(scroll, chat.room?.id ?? task.id, chatTailKey(chat.snapshot?.messages));
  const { atBottom } = useScrollEdges(scroll, chat.room?.id ?? task.id);
  const messages = chat.snapshot?.messages ?? [];
  return <section className="side-chat-pane" aria-label="任务侧聊" data-room-id={chat.room?.id ?? ""}>
    <SideChatHeadControls chat={chat} />
    <div className="side-chat-scroll-wrap">
      <div className="side-chat-scroll" ref={scroll}>
        {!chat.ready && <p className="side-chat-note" role="status">正在读取侧聊…</p>}
        {chat.room && !chat.snapshot && <p className="side-chat-note" role="status">正在读取消息…</p>}
        {chat.room && <SnapLine at={chat.room.createdAt} />}
        {chat.ready && !chat.room && <InspNone>问个问题，不打断主任务。</InspNone>}
        <div className="side-chat-log" role="log" aria-label="侧聊消息" aria-live="polite">
          {messages.length >= 500 && <p className="side-chat-note">显示最近 500 条消息，更早记录仍保留。</p>}
          {messages.map((message) => (
            <SideChatMessage key={message.id} message={message} onForward={(id) => void chat.forward(id)} onRevoke={(id) => void chat.revoke(id)} />
          ))}
        </div>
      </div>
      {!atBottom && <button type="button" className="side-chat-latest" aria-label="跳到侧聊最新消息" onClick={() => { resume(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "auto" }); }}><ArrowDown size={13} aria-hidden="true" />最新消息</button>}
    </div>
    <SideChatComposer task={task} chat={chat} />
  </section>;
}
