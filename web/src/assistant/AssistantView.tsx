import { AssistantIcon } from "./AssistantIcon.tsx";
import { useRef, useState } from "react";
import type { ProjectView, TaskListItem, TaskMode } from "@ash/shared";
import { taskDisplayStatus } from "@ash/shared";
import type { ChatMessage, ChatSnapshot } from "@ash/shared/chat";
import { STEP_LABELS, WORKSPACE_LABELS } from "@ash/shared/workflow";
import { ArrowLeft, ArrowUp, ArrowUpRight, BookOpen, FlowArrow, MagnifyingGlass, SidebarSimple, Robot, Stop } from "@phosphor-icons/react";
import { AssistantConnection } from "./AssistantConnection.tsx";
import { AssistantArchive } from "./AssistantArchive.tsx";
import { AssistantSidebar } from "./AssistantSidebar.tsx";
import { AssistantConversationTitle } from "./AssistantConversationTitle.tsx";
import { AssistantScroll } from "./AssistantScroll.tsx";
import { useAssistantChat } from "./useAssistantChat.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { ChatContextNotice } from "../chat/ChatContextNotice.tsx";
import { ConversationModeBar } from "../chat/ConversationModeBar.tsx";
import { WorkflowRail } from "../workflow/WorkflowRail.tsx";
import type { SettingsSection } from "../settings/SettingsPage.tsx";
import "./assistant.css";

const STARTERS = [
  { icon: BookOpen, label: "问用法", text: "任务显示失败，但智能体说已经做完了，该怎么排查？" },
  { icon: MagnifyingGlass, label: "找任务", text: "帮我找之前做登录或认证的任务，记不清在哪个项目了。" },
  { icon: FlowArrow, label: "搭起手式", text: "帮我搭一个起手式：写完代码后跑构建和测试，等我确认再合并。" },
];

function AssistantMessage({ message, snapshot, projects, onTask, onSave, saving, onWorkflows }: {
  message: ChatMessage; snapshot: ChatSnapshot; projects: ProjectView[]; onTask: (task: TaskListItem) => void;
  onSave: () => void; saving: boolean; onWorkflows: () => void;
}) {
  const busy = message.status === "running" || message.status === "queued";
  const result = message.assistant;
  const saved = !!result?.workflowId && result.workflowAvailable !== false;
  const linked = [...(result?.matches ?? []), ...(message.taskId ? [{ taskId: message.taskId, reason: "已创建的工作任务" }] : [])];
  return <article className={`assistant-message is-${message.role} is-${message.status}`}>
    <header><span>{message.role === "user" ? "你" : message.role === "system" ? "会话记录" : "ash 助手"}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
    {busy ? <p role="status" className="assistant-thinking">{message.status === "queued" ? "已收到，等待回复…" : "正在理解问题、查询资料…"}</p> : <MarkdownBody text={message.body} />}
    {!!result?.queries.length && <p className="assistant-search-note"><MagnifyingGlass size={13} />已检索：{result.queries.join(" · ")}</p>}
    {!!linked.length && <div className="assistant-results" aria-label="相关任务">{linked.map((match) => {
      const task = snapshot.tasks.find((item) => item.id === match.taskId);
      if (!task) return <p key={match.taskId}>关联任务已删除或不可访问。</p>;
      return <button className="assistant-task" type="button" key={task.id} onClick={() => onTask(task)}>
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const configure = editing || (chat.ready && !chat.room && !chat.error);
  const pickStarter = (text: string) => { chat.setDraft(text); input.current?.focus(); };
  const openTask = (task: TaskListItem) => { if (task.archived) setArchiveId(task.id); else onTask(task); };
  return <section className={`assistant-shell${historyOpen ? " is-history-open" : ""}`} aria-label="ash 助手">
    <AssistantSidebar rooms={chat.rooms} selectedId={chat.room?.id} ready={chat.ready} sending={chat.sending} onSelect={(id) => { chat.select(id); setEditing(false); setArchiveId(null); setHistoryOpen(false); }} onNew={() => { setEditing(false); setArchiveId(null); setHistoryOpen(false); void chat.newConversation(); }} />
    <div className="assistant-main">
    <ConversationModeBar active="assistant" onMode={onMode} onChat={onChat} />
    <header className="assistant-header"><button type="button" className="assistant-history-toggle" aria-label="助手对话记录" aria-controls="assistant-history" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}><SidebarSimple size={19} /></button><div className="assistant-identity"><AssistantIcon size={23} filled /><div>{chat.room ? <AssistantConversationTitle key={chat.room.id} name={chat.room.name} onRename={chat.renameConversation} /> : <h1>ash 助手</h1>}<span>{project ? `当前项目 · ${project.name}` : "你的 ash 使用助手"}</span></div></div>
      <div className="assistant-header-actions">
        <button type="button" aria-label="关闭助手" onClick={onExit}><ArrowLeft size={17} /></button></div>
    </header>
    {archiveId ? <AssistantArchive key={archiveId} taskId={archiveId} onClose={() => setArchiveId(null)} /> : <>
      <AssistantScroll conversationId={chat.room?.id ?? "assistant"} followMessages={!!chat.snapshot?.messages.length && !configure}>
        {(!chat.snapshot?.messages.length || configure) && <div className="assistant-welcome"><span className="assistant-eyebrow">从你记得的那一点开始</span><h2>不必记住入口。<br />把问题说出来。</h2><p>问 ash 怎么用，找回一个任务，或搭好下一次工作的起手式。</p>
          <div className="assistant-starters">{STARTERS.map(({ icon: Icon, label, text }) => <button type="button" key={label} onClick={() => pickStarter(text)}><Icon size={23} weight="duotone" /><strong>{label}</strong><span>{text}</span><ArrowUpRight size={15} /></button>)}</div>
        </div>}
        {!chat.ready && <p className="assistant-loading" role="status">正在读取助手对话…</p>}
        {configure && <AssistantConnection key={chat.room?.id ?? "new"} initial={chat.room?.members[0]} onSave={async (member) => { await chat.saveMember(member); setEditing(false); }} onCancel={() => setEditing(false)} onSettings={() => onSettings("executors")} />}
        {!configure && chat.snapshot && <div className="assistant-feed" role="log" aria-label="助手对话" aria-live="polite">{chat.snapshot.messages.length >= 500 && <p>显示最近 500 条消息，更早内容仍保存在对话中。</p>}{chat.snapshot.messages.map((message) => <AssistantMessage key={message.id} message={message} snapshot={chat.snapshot!} projects={projects} onTask={openTask} onSave={() => void chat.saveWorkflow(message.id)} saving={chat.savingWorkflows.includes(message.id)} onWorkflows={() => onSettings("workflows")} />)}</div>}
      </AssistantScroll>
      {chat.error && <p role="alert" className="assistant-error">{chat.error}</p>}
      {chat.room && !configure && <div className="assistant-composer-area">
        <div className="assistant-composer-meta"><button type="button" disabled={chat.busy || chat.sending} onClick={() => setEditing(true)}><Robot size={14} />{chat.room.members[0]?.agentType} · 更换智能体</button><span role="status">{chat.busy ? "正在回复" : chat.connected ? "已连接" : "连接中，状态可能延迟"}</span></div>
        <ChatContextNotice context={chat.snapshot?.context} />
        <div className="assistant-composer"><textarea ref={input} aria-label="给 ash 助手发消息" rows={3} maxLength={8000} value={chat.draft} onChange={(event) => chat.setDraft(event.target.value)} placeholder="描述你遇到的问题，或记得的任务内容…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void chat.send(); } }} />
          <footer><span>直接发送，无需 @</span>{chat.busy ? <button type="button" className="assistant-stop" onClick={() => void chat.stop()}><Stop size={14} weight="fill" />停止回复</button> : <button type="button" className="assistant-send" aria-label="发送给助手" disabled={chat.sending || !chat.draft.trim() || !chat.snapshot} onClick={() => void chat.send()}><ArrowUp size={19} weight="bold" /></button>}</footer>
        </div><p className="assistant-composer-hint">搜索覆盖你可见的项目 · Enter 发送，Shift Enter 换行 · /clear 重置上下文</p>
      </div>}
    </>}
    </div>
  </section>;
}
