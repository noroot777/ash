import { useRef, useState } from "react";
import type { Task } from "@ash/shared";
import { SIDE_CHAT_HISTORY_MAX_BYTES } from "@ash/shared/chat";
import type { ChatMessage } from "@ash/shared/chat";
import { ArrowDown, ArrowUp, ArrowBendUpLeft, ChatCircleDots, GearSix, Plus, Stop } from "@phosphor-icons/react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { ChatContextNotice } from "../chat/ChatContextNotice.tsx";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useScrollEdges } from "../lib/useScrollEdges.ts";
import { SideChatConnection } from "./SideChatConnection.tsx";
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
  const [editing, setEditing] = useState(false);
  const [creatingError, setCreatingError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const { resume } = useStickToBottom(scroll, chat.room?.id ?? task.id);
  const { atBottom } = useScrollEdges(scroll, chat.room?.id ?? task.id);
  const configure = editing || (chat.ready && !chat.room && !chat.error);
  const newChat = async () => {
    if (!chat.room?.members[0]) return;
    setCreatingError("");
    try { await chat.create(chat.room.members[0]); setEditing(false); }
    catch (reason) { setCreatingError(String(reason)); }
  };
  return <section className="side-chat-pane" aria-label="任务侧聊">
    {chat.room && <header className="side-chat-toolbar">
      <select aria-label="切换侧聊" value={chat.room.id} disabled={chat.sending} onChange={(event) => { chat.select(event.target.value); setEditing(false); setCreatingError(""); }}>
        {chat.rooms.map((room, index, rooms) => <option key={room.id} value={room.id}>侧聊 {rooms.length - index} · {new Date(room.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</option>)}
      </select>
      <button type="button" aria-label="新建侧聊" disabled={chat.sending} onClick={() => void newChat()}><Plus size={16} /></button>
      <button type="button" aria-label="更换侧聊执行器" disabled={chat.busy || chat.sending} onClick={() => setEditing((value) => !value)}><GearSix size={16} /></button>
    </header>}
    <div className="side-chat-scroll-wrap">
      <div className="side-chat-scroll" ref={scroll}>
        {!chat.ready && <p className="side-chat-note" role="status">正在读取侧聊…</p>}
        {configure ? <SideChatConnection key={chat.room?.id ?? "new"} task={task} initial={chat.room?.members[0]} onSave={async (member) => { await chat.saveMember(member); setEditing(false); }} onCancel={chat.room ? () => setEditing(false) : undefined} /> : chat.room && <>
          <div className="side-chat-intro"><ChatCircleDots size={22} weight="duotone" /><strong>这里聊，不打断思路</strong><p>已带入创建时的主会话。需要回传时，直接说：<code>把结论告诉主任务</code>。</p><small>关闭面板后仍会保留，停止侧聊不影响主任务。新侧聊快照上限 {SIDE_CHAT_HISTORY_MAX_BYTES / 1024} KiB，历史整理会增加等待时间和用量。</small></div>
          {!chat.snapshot && <p className="side-chat-note" role="status">正在读取消息…</p>}
          <div role="log" aria-label="侧聊消息" aria-live="polite">
            {(chat.snapshot?.messages.length ?? 0) >= 500 && <p className="side-chat-note">显示最近 500 条消息，更早记录仍保留。</p>}
            {chat.snapshot?.messages.map((message) => <SideMessage key={message.id} message={message} />)}
          </div>
        </>}
      </div>
      {!atBottom && <button type="button" className="side-chat-latest" aria-label="跳到侧聊最新消息" onClick={() => { resume(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "auto" }); }}><ArrowDown size={13} />最新消息</button>}
    </div>
    {(chat.error || creatingError) && <div className="side-chat-error" role="alert">{chat.error || creatingError}<button type="button" onClick={() => { void chat.reload(); setCreatingError(""); }}>重新连接</button></div>}
    {chat.room && !configure && <div className="side-chat-compose">
      <div className="side-chat-status" role="status"><span>{chat.connected ? chat.busy ? "侧聊正在回复" : `${chat.room.members[0]?.agentType} · 独立会话` : "连接中，状态可能延迟"}</span>{chat.busy && <button type="button" disabled={chat.sending} onClick={() => void chat.stop()}><Stop size={12} weight="fill" />停止侧聊</button>}</div>
      <ChatContextNotice context={chat.snapshot?.context} />
      <div className="side-chat-input"><textarea ref={input} aria-label="侧聊消息输入" placeholder="问个问题，或把结论交给主任务…" maxLength={8000} value={chat.draft} onChange={(event) => chat.setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void chat.send(); }
      }} /><footer><span>Enter 发送 · Shift Enter 换行</span><button type="button" className="side-chat-primary" aria-label="发送侧聊消息" disabled={!chat.snapshot || !chat.draft.trim() || chat.busy || chat.sending} onClick={() => void chat.send()}><ArrowUp size={17} weight="bold" /></button></footer></div>
    </div>}
  </section>;
}
