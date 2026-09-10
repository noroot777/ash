import "../chat/chat.css";
import { AssistantIcon } from "./AssistantIcon.tsx";
import { useRef, useState } from "react";
import type { ProjectView, TaskListItem, TaskMode } from "@ash/shared";
import { taskDisplayStatus } from "@ash/shared";
import type { ChatMessage, ChatSnapshot } from "@ash/shared/chat";
import { STEP_LABELS, WORKSPACE_LABELS } from "@ash/shared/workflow";
import { ArrowUp, ArrowUpRight, FlowArrow, MagnifyingGlass, Robot, Stop } from "@phosphor-icons/react";
import { AssistantConnection } from "./AssistantConnection.tsx";
import { AssistantArchive } from "./AssistantArchive.tsx";
import { AssistantSidebar } from "./AssistantSidebar.tsx";
import { AssistantConversationTitle } from "./AssistantConversationTitle.tsx";
import { AssistantScroll } from "./AssistantScroll.tsx";
import { AssistantKnowledge } from "./AssistantKnowledge.tsx";
import { AssistantInfo } from "./AssistantInfo.tsx";
import { useAssistantChat } from "./useAssistantChat.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { ChatContextNotice } from "../chat/ChatContextNotice.tsx";
import { ConversationModeBar } from "../chat/ConversationModeBar.tsx";
import { WorkflowRail } from "../workflow/WorkflowRail.tsx";
import type { SettingsSection } from "../settings/SettingsPage.tsx";
import "./assistant.css";

const STARTERS = [
  { label: "问用法", text: "任务显示失败，但智能体说已经做完了，该怎么排查？" },
  { label: "找任务", text: "帮我找之前做登录或认证的任务，记不清在哪个项目了。" },
  { label: "搭起手式", text: "帮我搭一个起手式：写完代码后跑构建和测试，等我确认再合并。" },
];

function AssistantMessage({ message, snapshot, projects, onTask, onSave, saving, onWorkflows }: {
  message: ChatMessage; snapshot: ChatSnapshot; projects: ProjectView[]; onTask: (task: TaskListItem) => void;
  onSave: () => void; saving: boolean; onWorkflows: () => void;
}) {
  const busy = message.status === "running" || message.status === "queued";
  const result = message.assistant;
  const saved = !!result?.workflowId && result.workflowAvailable !== false;
  const linked = [...(result?.matches ?? []), ...(message.taskId ? [{ taskId: message.taskId, reason: "已创建的工作任务" }] : [])];
  if (message.role === "system") return <p className="chat-history-note">{message.body}</p>;
  return <article className={`chat-message assistant-message is-${message.role} is-${message.status}`}>
    <span className={`chat-avatar ${message.role === "user" ? "tone-user" : "assistant-avatar"}`}>{message.role === "user" ? "你" : <AssistantIcon size={20} filled />}</span>
    <div className="chat-message-content"><header><strong>{message.role === "user" ? "你" : "ash 助手"}</strong>{message.role === "agent" && <span className="chat-bot-label">智能体</span>}<time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
    {busy ? <p role="status" className="chat-typing"><span><i /><i /><i /></span>{message.status === "queued" ? "已收到，等待回复…" : "正在理解问题、查询资料…"}</p> : <div className="assistant-message-body"><MarkdownBody text={message.body} /></div>}
    {!!result?.queries.length && <p className="assistant-search-note"><MagnifyingGlass size={13} />已检索：{result.queries.join(" · ")}</p>}
    {!!linked.length && <div className="assistant-results" aria-label="相关任务">{linked.map((match) => {
      const task = snapshot.tasks.find((item) => item.id === match.taskId);
      if (!task) return <p key={match.taskId}>关联任务已删除或不可访问。</p>;
      return <button className="chat-task-card assistant-task" type="button" key={task.id} onClick={() => onTask(task)}>
        <span><small>{projects.find((project) => project.id === task.projectId)?.name ?? "项目"} · {task.archived ? "已归档" : taskDisplayStatus(task.status, task.stage, !!task.question).label}</small><strong>{task.title}</strong><span>{match.reason}</span><code>{task.id}</code></span><ArrowUpRight size={19} />
      </button>;
    })}</div>}
    {result?.workflow && <section className="assistant-workflow" aria-label="起手式草案">
      <header><FlowArrow size={20} /><span><small>{saved ? "已保存到起手式库" : result.workflowId ? "起手式已删除，可重新保存" : "起手式草案"}</small><h3>{result.workflow.name}</h3></span></header>
      <p>{result.workflow.description}</p><small>{WORKSPACE_LABELS[result.workflow.def.workspace]}</small>
      <ol>{result.workflow.def.steps.map((step) => <li key={step.id}>{STEP_LABELS[step.kind]}</li>)}</ol>
      <details><summary>查看每站配置</summary><div className="assistant-workflow-rail"><WorkflowRail def={result.workflow.def} /></div></details>
      <footer><span>{saved ? "新建任务时即可选用" : "保存后可在设置中继续编辑"}</span><button type="button" className="assistant-primary" disabled={saving} onClick={saved ? onWorkflows : onSave}>{saved ? "查看起手式库" : saving ? "保存中…" : "保存起手式"}</button></footer>
    </section>}
    </div>
  </article>;
}

export function AssistantView({ project, projects, onTask, onSettings, onExit, onMode, onChat }: {
  project: ProjectView | null; projects: ProjectView[]; onTask: (task: TaskListItem) => void;
  onSettings: (section: SettingsSection) => void; onExit: () => void;
  onMode: (mode: TaskMode) => void; onChat: () => void;
}) {
  const chat = useAssistantChat(project?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const connectionTip = useHoverTip();
  const input = useRef<HTMLTextAreaElement>(null);
  const configure = editing || (chat.ready && !chat.room && !chat.error);
  const pickStarter = (text: string) => { chat.setDraft(text); input.current?.focus(); };
  const openTask = (task: TaskListItem) => { if (task.archived) setArchiveId(task.id); else onTask(task); };
  return <section className="chat-shell assistant-shell" aria-label="ash 助手">
    <AssistantSidebar rooms={chat.rooms} selectedId={chat.room?.id} ready={chat.ready} sending={chat.sending} projectName={project?.name} onExit={onExit} onSelect={(id) => { chat.select(id); setEditing(false); setArchiveId(null); }} onNew={() => { setEditing(false); setArchiveId(null); void chat.newConversation(); }} />
    <div className="chat-main assistant-main">
    <ConversationModeBar active="assistant" onMode={onMode} onChat={onChat} />
    {!configure && <header className="chat-header assistant-header"><div className="assistant-heading">{chat.room ? <AssistantConversationTitle key={chat.room.id} name={chat.room.name} onRename={chat.renameConversation}><span className={`chat-connection${chat.connected ? " is-connected" : ""}`} tabIndex={0} role="status" aria-label={chat.connected ? "实时连接" : "连接中，状态可能延迟"} {...connectionTip.anchorProps} /></AssistantConversationTitle> : <h1><AssistantIcon size={23} />ash 助手</h1>}</div>
      {chat.room && <button type="button" className="chat-member-count" aria-label="更换助手智能体" disabled={chat.busy || chat.sending} onClick={() => setEditing(true)}><Robot size={19} /><span>{chat.room.members[0]?.agentType}</span></button>}
      <HoverTip at={connectionTip.at}>{chat.connected ? "实时连接" : "连接中，状态可能延迟"}</HoverTip>
    </header>}
    {archiveId ? <AssistantArchive key={archiveId} taskId={archiveId} onClose={() => setArchiveId(null)} /> : <>
      <AssistantScroll conversationId={chat.room?.id ?? "assistant"} followMessages={!!chat.snapshot?.messages.length && !configure}>
        {!configure && <div className="chat-welcome"><span className="chat-welcome-icon"><AssistantIcon size={32} filled /></span><h2>ash 助手，从一句话开始。</h2><p>问 ash 怎么用，找回一个任务，或搭好起手式。<br />直接发送，先说结论，只讲重点。</p>
          <div>{STARTERS.map(({ label, text }) => <button type="button" key={label} onClick={() => pickStarter(text)}>{label}</button>)}</div>
        </div>}
        {!chat.ready && <p className="assistant-loading" role="status">正在读取助手对话…</p>}
        {configure && <AssistantConnection key={chat.room?.id ?? "new"} initial={chat.room?.members[0]} onSave={async (member) => { await chat.saveMember(member); setEditing(false); }} onCancel={() => setEditing(false)} onSettings={() => onSettings("executors")} />}
        {!configure && chat.snapshot && <div role="log" aria-label="助手对话" aria-live="polite">{chat.snapshot.messages.length >= 500 && <p className="chat-history-note">显示最近 500 条消息，更早内容仍保存在对话中。</p>}{chat.snapshot.messages.map((message, index, messages) => <div key={message.id}>
          {message.role !== "system" && (!index || new Date(messages[index - 1]!.createdAt).toDateString() !== new Date(message.createdAt).toDateString()) && <div className="chat-date"><span>{new Date(message.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })}</span></div>}
          <AssistantMessage message={message} snapshot={chat.snapshot!} projects={projects} onTask={openTask} onSave={() => void chat.saveWorkflow(message.id)} saving={chat.savingWorkflows.includes(message.id)} onWorkflows={() => onSettings("workflows")} />
        </div>)}</div>}
      </AssistantScroll>
      {chat.error && <p role="alert" className="chat-error">{chat.error}</p>}
      {chat.room && !configure && <div className="chat-composer-area">
        <div className="chat-live-line" role="status">{chat.busy ? <><span className="chat-live-dot" />正在回复<button type="button" onClick={() => void chat.stop()}><Stop size={12} weight="fill" />停止回复</button></> : <span>随时可以开始对话</span>}</div>
        <ChatContextNotice context={chat.snapshot?.context} />
        <div className="chat-composer"><textarea ref={input} aria-label="给 ash 助手发消息" maxLength={8000} value={chat.draft} onChange={(event) => chat.setDraft(event.target.value)} placeholder="描述你遇到的问题，或记得的任务内容…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void chat.send(); } }} />
          <footer><AssistantKnowledge /><span>直接发送，无需 @</span><button type="button" className="chat-send" aria-label="发送给助手" disabled={chat.busy || chat.sending || !chat.draft.trim() || !chat.snapshot} onClick={() => void chat.send()}><ArrowUp size={20} weight="bold" /></button></footer>
        </div><div className="chat-composer-hint">Enter 发送 · Shift Enter 换行 · /clear 清空上下文<span>简洁回复已启用</span></div>
      </div>}
    </>}
    </div>
    {chat.room && !configure && <AssistantInfo member={chat.room.members[0]} busy={chat.busy} disabled={chat.busy || chat.sending} taskCount={chat.snapshot?.tasks.length ?? 0} onConfigure={() => setEditing(true)} />}
  </section>;
}
