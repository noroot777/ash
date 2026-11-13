import { useEffect, useRef } from "react";
import type { Task } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { type ChatMember } from "@ash/shared/chat";
import { ArrowUp, Quotes, Stop, X } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { InspButton, InspNote, InspTool } from "../inspector/parts.tsx";
import { ChatContextNotice } from "../chat/ChatContextNotice.tsx";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { executorRunSummary, isExecutorPickable, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { useSendKeyLabels } from "../lib/useComposerSendKey.ts";
import { useSideChatMember } from "./useSideChatMember.ts";
import type { useSideChat } from "./useSideChat.ts";
import { AutoTextarea } from "../components/AutoTextarea.tsx";

type SideChatState = ReturnType<typeof useSideChat>;

export function SideChatComposer({ task, chat }: { task: Task; chat: SideChatState }) {
  const connection = useSideChatMember(task);
  const input = useRef<HTMLTextAreaElement>(null);
  // 附件跟主会话回复框同一套（上传、在途卡片、取消、上限）；草稿归 useSideChat 管，
  // 所以这里只把状态接过去，切侧聊/刷新页面时粘好的图还在。
  const uploads = useAttachments({ value: chat.attachments, onChange: chat.setAttachments, pending: chat.pending, onPendingChange: chat.setPending });
  const types = registeredAgentTypes(connection.profiles);
  const member = chat.room?.members[0] ?? connection.member;
  const valid = !!member && connection.ready && !connection.error && isExecutorPickable(member, types, connection.profiles);
  const run = member ? executorRunSummary(member, connection.profiles, { model: member.model, effort: member.reasoningEffort }) : null;
  const changeMember = (next: ChatMember) => {
    if (chat.room) void chat.saveMember(next);
    else connection.choose(next);
  };
  const send = () => { if (valid && chat.canSend) void chat.send(member); };
  useEffect(() => {
    if (!chat.ready || !input.current) return;
    input.current.focus({ preventScroll: true });
    // 「改了再发」放回来的那句接在草稿前面，光标送到末尾，接着改。
    if (chat.reused) input.current.setSelectionRange(input.current.value.length, input.current.value.length);
  }, [chat.ready, chat.room?.id, chat.quote?.id, chat.reused]);
  const error = chat.error || chat.memberError || connection.error;
  const sendKeys = useSendKeyLabels();
  const quoteTip = useHoverTip();
  return <div className="side-chat-compose">
    {error && (
      <div className="side-chat-error" role="alert">
        <InspNote tone="bad" action={<InspButton size="sm" onClick={() => { void chat.reload(); if (connection.error) connection.reload(); }}>重新连接</InspButton>}>{error}</InspNote>
      </div>
    )}
    {/* 只剩还没连上这一种「机制」值得说一句：在回答、在发送、在存模型都由发送键自己的样子说。 */}
    {chat.room && !chat.connected && !error && <p className="insp-hint side-chat-status" role="status">连接中，状态可能延迟</p>}
    <ChatContextNotice context={chat.snapshot?.context} />
    {/* 从主会话带一段过来问：那一段是输入框上面的一行引用，全文指上去看。 */}
    {chat.quote && (
      <section className="side-chat-quote" aria-label="主会话引用">
        <Quotes size={12} aria-hidden="true" />
        <blockquote tabIndex={0} {...quoteTip.anchorProps}>{chat.quote.text}</blockquote>
        <HoverTip at={quoteTip.at}>{chat.quote.text.length > 280 ? `${chat.quote.text.slice(0, 280)}…` : chat.quote.text}</HoverTip>
        <InspTool label="移除主会话引用" tip="不带这一段" onClick={chat.removeQuote}><X aria-hidden="true" /></InspTool>
      </section>
    )}
    <UploadAttachmentList attachments={uploads.attachments} pending={uploads.pending} error={uploads.error} onRemove={uploads.remove} onCancel={uploads.cancel} />
    <div className="side-chat-input">
      <AutoTextarea ref={input} aria-label="侧聊消息输入" placeholder={chat.quote ? "想问这一段什么？" : "问个问题，不打断主任务…"} disabled={!chat.ready} value={chat.draft} onChange={(event) => chat.setDraft(event.target.value)} onPaste={uploads.onPaste} onKeyDown={(event) => {
        if (isSendKeyEvent(event)) { event.preventDefault(); send(); }
      }} />
      <footer>
        <AttachmentPicker addFiles={uploads.addFiles} disabled={!chat.ready || chat.sending} />
        {/* 「谁来答」那颗三段胶囊就放在输入框里：它是每次发送前都可能要看一眼的东西，
            单开一条横栏在侧栏这点宽度里太贵。 */}
        <RunTargetPicker label="侧聊执行器" variant="chip" types={types} profiles={connection.profiles} knownProfiles={connection.profiles} selection={member ?? null}
          fallbackType={task.agentType} model={run?.model ?? null} effort={member?.reasoningEffort ?? ""}
          disabled={!connection.ready || !chat.loaded || chat.busy || chat.sending || (!!chat.room && !chat.snapshot)} emptyText={connection.ready ? "暂无可用执行器" : "正在读取执行器…"}
          onCommit={(next) => {
            if (!member) return;
            changeMember({ ...member, agentType: next.agent, executorId: next.executorId ?? null, model: next.model || null,
              reasoningEffort: sameExecutor(member, { agentType: next.agent, executorId: next.executorId ?? null }) ? member.reasoningEffort : null });
          }} onEffortChange={(effort) => { if (member) changeMember({ ...member, reasoningEffort: effort || null }); }} />
        {/* 在回答的时候，发送键就是停止键（同一个位置、同一种按法）。 */}
        {chat.busy
          ? (
            <InspTool label="停止侧聊" tip="停止这一条回答" className="side-chat-primary is-stop" disabled={chat.sending} onClick={() => void chat.stop()}>
              <Stop weight="fill" aria-hidden="true" />
            </InspTool>
          )
          : (
            <InspTool
              label="发送侧聊消息"
              tip={chat.savingMember ? "正在保存模型选择…" : chat.sending ? "正在发送…" : `${sendKeys.send} 发送，${sendKeys.newline} 换行；截图和文件可直接粘贴`}
              className="side-chat-primary"
              disabled={!chat.canSend || !valid}
              onClick={send}
            >
              <ArrowUp weight="bold" aria-hidden="true" />
            </InspTool>
          )}
      </footer>
    </div>
    {connection.ready && !connection.error && !valid && <p className="insp-hint side-chat-note">{connection.profiles.length ? "当前执行器不可用，请重新选择。" : "请先在设置中添加执行器。"}</p>}
  </div>;
}
