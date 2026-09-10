import type { ChatMember } from "@ash/shared/chat";
import { PencilSimple, Robot } from "@phosphor-icons/react";
import { AssistantIcon } from "./AssistantIcon.tsx";

export function AssistantInfo({ member, busy, disabled, taskCount, onConfigure }: {
  member: ChatMember | undefined; busy: boolean; disabled: boolean; taskCount: number; onConfigure: () => void;
}) {
  return <aside className="chat-info" aria-label="助手信息">
    <div className="chat-info-title"><Robot size={20} /><h2>在这个空间</h2></div><p>直接发送消息，助手就会加入对话。</p>
    <div className="chat-presence"><button type="button" disabled={disabled} onClick={onConfigure}>
      <span className="chat-avatar assistant-avatar"><AssistantIcon size={20} filled /><i className={busy ? "is-busy" : ""} /></span>
      <span><strong>{member?.name ?? "ash 助手"}</strong><small>{busy ? "正在回复" : "待命 · 直接对话"}</small></span><PencilSimple size={14} />
    </button></div>
    <button type="button" className="chat-add-member" disabled={disabled} onClick={onConfigure}><PencilSimple size={14} />更换智能体</button>
    <div className="chat-info-divider" /><h3>从对话到行动</h3><p>找到历史任务，搭好起手式，或把明确委派的工作交给 ash 任务。</p>
    <div className="chat-info-stat"><strong>{taskCount}</strong><span>项关联任务</span></div>
    <small className="chat-context-note">内置 ash 使用指南，按需检索你可见的任务与会话。回复默认言简意赅，完整资料范围可在「知识与回复设置」查看。</small>
  </aside>;
}
