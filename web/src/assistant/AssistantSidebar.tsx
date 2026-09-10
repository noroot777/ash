import { useState } from "react";
import type { ChatRoom } from "@ash/shared/chat";
import { ArrowLeft, BookOpen, ChatCircle, CheckCircle, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { AssistantIcon } from "./AssistantIcon.tsx";
import { AssistantKnowledgeContent } from "./AssistantKnowledge.tsx";
import "./assistant-sidebar.css";

export function AssistantSidebar({ rooms, selectedId, ready, sending, projectName, onSelect, onNew, onExit }: {
  rooms: ChatRoom[]; selectedId?: string; ready: boolean; sending: boolean;
  onSelect: (id: string) => void; onNew: () => void;
  projectName?: string; onExit: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const matches = [...rooms].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((room) => room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <aside className={`chat-rail assistant-sidebar${searching ? " is-searching" : ""}`} aria-label="助手侧栏">
    <header><span className="chat-brand"><AssistantIcon size={25} filled />助手</span><button type="button" aria-label="关闭助手" onClick={onExit}><ArrowLeft size={17} /></button></header>
    <div className="chat-project">{projectName ?? "全部可见项目"}<small>直接对话 · 简洁回复</small></div>
    <div className="chat-channel-label"><span>你的对话</span><div className="assistant-history-actions">
      <button type="button" aria-label="搜索对话" aria-expanded={searching} onClick={() => { setSearching((value) => !value); setQuery(""); }}><MagnifyingGlass size={17} /></button>
      <button type="button" aria-label="新对话" disabled={!selectedId || sending} onClick={() => { setQuery(""); setSearching(false); onNew(); }}><Plus size={17} /></button>
    </div></div>
    {searching && <label className="assistant-history-search"><MagnifyingGlass size={15} /><input type="search" autoFocus aria-label="搜索助手对话" placeholder="搜索对话名称" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除对话搜索" onClick={() => setQuery("")}><X size={13} /></button>}</label>}
    <nav className="chat-channels assistant-conversations" aria-label="助手对话记录">
      {matches.map((room) => <button type="button" key={room.id} className={room.id === selectedId ? "is-selected" : ""} aria-current={room.id === selectedId ? "page" : undefined} disabled={sending} onClick={() => onSelect(room.id)}>
        <ChatCircle size={17} /><span>{room.name}</span><small>{room.members.length}</small>
      </button>)}
      {!matches.length && <p role="status">{!ready ? "正在读取对话…" : query.trim() ? "没有匹配的对话，换个名称试试。" : "接入智能体后，在这里保留每次对话。"}</p>}
    </nav>
    <div className="chat-rail-note assistant-sidebar-settings">
      <CheckCircle size={22} /><strong>简洁回复已启用</strong><p>先说结论，只讲重点。<br />问用法、找任务、搭起手式。</p>
      <details className="assistant-knowledge"><summary><BookOpen size={16} />知识与回复设置</summary>
        <AssistantKnowledgeContent />
      </details>
    </div>
  </aside>;
}
