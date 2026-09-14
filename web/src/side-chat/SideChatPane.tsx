import { useRef } from "react";
import type { Task } from "@ash/shared";
import type { ChatMessage } from "@ash/shared/chat";
import { ArrowDown, ArrowBendUpLeft, Plus } from "@phosphor-icons/react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useScrollEdges } from "../lib/useScrollEdges.ts";
import { SideChatComposer } from "./SideChatComposer.tsx";
import { useSideChat } from "./useSideChat.ts";
import "./side-chat.css";

const receiptLabels = { queued: "已排队 · 主任务空闲后发送", delivering: "正在投递", sent: "已送达主任务", canceled: "未送达 · 已取消", unavailable: "回执不可用" };

function SideMessage({ message }: { message: ChatMessage }) {
  const busy = message.status === "queued" || message.status === "running";
  return <article className={`side-chat-message is-${message.role} is-${message.status}`}>
    <header><strong>{message.role === "user" ? "你" : message.role === "system" ? "ash" : "侧聊助手"}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
    {busy ? <p className="side-chat-thinking" role="status">{message.status === "queued" ? "等待回复…" : "正在思考…"}</p> : <MarkdownBody text={message.body} />}
    {message.forwardError && <p className="side-chat-error" role="status">未发送到主任务：{message.forwardError}</p>}
    {message.forward && <details className={`side-chat-receipt is-${message.forward.status}`}>
      <summary><ArrowBendUpLeft size={14} /><span>{receiptLabels[message.forward.status]}</span></summary>
      <p>{message.forward.text}</p>
      {message.forward.status === "queued" && <small>可在主任务的待发送消息中查看或取消。</small>}
    </details>}
  </article>;
}

export function SideChatPane({ task }: { task: Task }) {
  const chat = useSideChat(task.id);
  const scroll = useRef<HTMLDivElement>(null);
  const { resume } = useStickToBottom(scroll, chat.room?.id ?? task.id);
  const { atBottom } = useScrollEdges(scroll, chat.room?.id ?? task.id);
  return <section className="side-chat-pane" aria-label="任务侧聊">
    {!!chat.rooms.length && <header className="side-chat-toolbar">
      <select aria-label="切换侧聊" value={chat.room?.id ?? ""} disabled={chat.sending || chat.savingMember} onChange={(event) => chat.select(event.target.value || null)}>
        <option value="">新侧聊</option>
        {chat.rooms.map((room, index, rooms) => <option key={room.id} value={room.id}>侧聊 {rooms.length - index} · {new Date(room.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</option>)}
      </select>
      <button type="button" aria-label="新建侧聊" disabled={chat.sending || chat.savingMember || !chat.room} onClick={() => chat.select(null)}><Plus size={16} /></button>
    </header>}
    <div className="side-chat-scroll-wrap">
      <div className="side-chat-scroll" ref={scroll}>
        {!chat.ready && <p className="side-chat-note" role="status">正在读取侧聊…</p>}
        {chat.room && !chat.snapshot && <p className="side-chat-note" role="status">正在读取消息…</p>}
        <div role="log" aria-label="侧聊消息" aria-live="polite">
          {(chat.snapshot?.messages.length ?? 0) >= 500 && <p className="side-chat-note">显示最近 500 条消息，更早记录仍保留。</p>}
          {chat.snapshot?.messages.map((message) => <SideMessage key={message.id} message={message} />)}
        </div>
      </div>
      {!atBottom && <button type="button" className="side-chat-latest" aria-label="跳到侧聊最新消息" onClick={() => { resume(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "auto" }); }}><ArrowDown size={13} />最新消息</button>}
    </div>
    <SideChatComposer task={task} chat={chat} />
  </section>;
}
