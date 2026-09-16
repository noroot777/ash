import { useEffect, useRef, useState } from "react";
import type { Task } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { type ChatMember } from "@ash/shared/chat";
import { ArrowUp, Quotes, Stop, X } from "@phosphor-icons/react";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { ChatContextNotice } from "../chat/ChatContextNotice.tsx";
import { executorRunSummary, isExecutorPickable, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { useSideChatMember } from "./useSideChatMember.ts";
import type { useSideChat } from "./useSideChat.ts";
import { SIDE_CHAT_MESSAGE_LIMIT } from "./sideChatQuote.ts";

type SideChatState = ReturnType<typeof useSideChat>;

export function SideChatComposer({ task, chat }: { task: Task; chat: SideChatState }) {
  const connection = useSideChatMember(task);
  const input = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const types = registeredAgentTypes(connection.profiles);
  const member = chat.room?.members[0] ?? connection.member;
  const valid = !!member && connection.ready && !connection.error && isExecutorPickable(member, types, connection.profiles);
  const run = member ? executorRunSummary(member, connection.profiles, { model: member.model, effort: member.reasoningEffort }) : null;
  const changeMember = (next: ChatMember) => {
    if (chat.room) void chat.saveMember(next);
    else connection.choose(next);
  };
  const send = () => { if (valid) void chat.send(member); };
  useEffect(() => {
    if (chat.ready) input.current?.focus({ preventScroll: true });
  }, [chat.ready, chat.room?.id, chat.quote?.id]);
  useEffect(() => setExpanded(false), [chat.quote?.id]);
  const error = chat.error || chat.memberError || connection.error;
  return <div className="side-chat-compose">
    {error && <div className="side-chat-error" role="alert">{error}<button type="button" onClick={() => { void chat.reload(); if (connection.error) connection.reload(); }}>重新连接</button></div>}
    {chat.quote && <section className={`side-chat-quote${expanded ? " is-expanded" : ""}`} aria-label="主会话引用">
      <header><Quotes size={14} /><span>来自主会话</span><button type="button" aria-label="移除主会话引用" onClick={chat.removeQuote}><X size={14} /></button></header>
      <blockquote>{chat.quote.text}</blockquote>
      {(chat.quote.text.length > 80 || chat.quote.text.split("\n").length > 3) && <button type="button" className="side-chat-quote-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起引用" : "展开引用"}</button>}
    </section>}
    {(chat.busy || chat.sending || chat.savingMember || (chat.room && !chat.connected)) && <div className="side-chat-status" role="status">
      <span>{chat.savingMember ? "正在保存模型选择…" : chat.sending ? "正在发送…" : chat.busy ? "侧聊正在回复" : "连接中，状态可能延迟"}</span>
      {chat.busy && <button type="button" disabled={chat.sending} onClick={() => void chat.stop()}><Stop size={12} weight="fill" />停止侧聊</button>}
    </div>}
    <ChatContextNotice context={chat.snapshot?.context} />
    <div className="side-chat-input">
      <textarea ref={input} aria-label="侧聊消息输入" placeholder={chat.quote ? "想问这段内容什么？" : "围绕主会话问个问题…"} disabled={!chat.ready} maxLength={SIDE_CHAT_MESSAGE_LIMIT} value={chat.draft} onChange={(event) => chat.setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
      }} />
      <footer>
        {/* 「选谁干活」那颗三段胶囊就放在输入框里：它是每次发送前都可能要看一眼的东西，
            单开一条横栏在侧栏这点宽度里太贵。Enter/Shift Enter 的提示挪进头带的 ⓘ。 */}
        <RunTargetPicker label="侧聊执行器" variant="chip" types={types} profiles={connection.profiles} knownProfiles={connection.profiles} selection={member ?? null}
          fallbackType={task.agentType} model={run?.model ?? null} effort={member?.reasoningEffort ?? ""}
          disabled={!connection.ready || !chat.loaded || chat.busy || chat.sending || (!!chat.room && !chat.snapshot)} emptyText={connection.ready ? "暂无可用执行器" : "正在读取执行器…"}
          onCommit={(next) => {
            if (!member) return;
            changeMember({ ...member, agentType: next.agent, executorId: next.executorId ?? null, model: next.model || null,
              reasoningEffort: sameExecutor(member, { agentType: next.agent, executorId: next.executorId ?? null }) ? member.reasoningEffort : null });
          }} onEffortChange={(effort) => { if (member) changeMember({ ...member, reasoningEffort: effort || null }); }} />
        <button type="button" className="side-chat-primary" aria-label="发送侧聊消息" disabled={!chat.canSend || !valid} onClick={send}><ArrowUp size={17} weight="bold" /></button>
      </footer>
    </div>
    {chat.overLimit && <p className="side-chat-limit" role="alert">引用与问题合计 {chat.messageLength} 字，超过 {SIDE_CHAT_MESSAGE_LIMIT} 字上限。请缩短问题，或移除引用后重新选择较短的内容。</p>}
    {connection.ready && !connection.error && !valid && <p className="side-chat-note">{connection.profiles.length ? "当前执行器不可用，请重新选择。" : "请先在设置中添加执行器。"}</p>}
  </div>;
}
