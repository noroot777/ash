import { useState } from "react";
import type { ChatRoom } from "@ash/shared/chat";
import { BookOpen, ChatCircle, CheckCircle, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { AssistantIcon } from "./AssistantIcon.tsx";
import "./assistant-sidebar.css";

export function AssistantSidebar({ rooms, selectedId, ready, sending, onSelect, onNew }: {
  rooms: ChatRoom[]; selectedId?: string; ready: boolean; sending: boolean;
  onSelect: (id: string) => void; onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = [...rooms].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((room) => room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <aside className="assistant-sidebar" id="assistant-history" aria-label="助手侧栏">
    <div className="assistant-sidebar-brand"><AssistantIcon size={25} filled /><span>ash 助手<small>问用法 · 找任务 · 搭起手式</small></span></div>
    <button className="assistant-new" type="button" disabled={!selectedId || sending} onClick={() => { setQuery(""); onNew(); }}><Plus size={17} weight="bold" />新对话</button>
    <label className="assistant-history-search"><MagnifyingGlass size={15} /><input type="search" aria-label="搜索助手对话" placeholder="搜索对话名称" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除对话搜索" onClick={() => setQuery("")}><X size={13} /></button>}</label>
    <div className="assistant-history-label"><span>对话记录</span><span>{rooms.length}</span></div>
    <nav className="assistant-conversations" aria-label="助手对话记录">
      {matches.map((room) => <button type="button" key={room.id} aria-current={room.id === selectedId ? "page" : undefined} disabled={sending} onClick={() => onSelect(room.id)}>
        <ChatCircle size={17} weight={room.id === selectedId ? "fill" : "regular"} />
        <span><strong>{room.name}</strong><small><time dateTime={room.createdAt}>{new Date(room.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</time><span> · {room.members[0]?.agentType ?? "助手"}</span></small></span>
      </button>)}
      {!matches.length && <p role="status">{!ready ? "正在读取对话…" : query.trim() ? "没有匹配的对话，换个名称试试。" : "接入智能体后，在这里保留每次对话。"}</p>}
    </nav>
    <div className="assistant-sidebar-settings">
      <div className="assistant-reply-style"><CheckCircle size={16} weight="fill" /><span>简洁回复<small>先说结论，只讲重点</small></span><small>已启用</small></div>
      <details className="assistant-knowledge"><summary><BookOpen size={16} />知识与回复设置</summary>
        <dl><dt>ash 使用说明</dt><dd>内置功能指南：任务、团队、执行器、起手式与验收。</dd>
          <dt>任务与会话</dt><dd>按需检索你可见项目的本机任务及会话，包括归档任务。</dd>
          <dt>当前资源</dt><dd>可见项目、执行器、起手式示例和本对话草案的保存状态。</dd>
          <dt>回复风格 · 已启用</dt><dd>默认 1–3 句或最多 3 个要点，通常不超过 200 字；需要时再展开。</dd></dl>
        <p>暂未接入 Obsidian 等外部知识库，也不做联网检索。</p>
      </details>
    </div>
  </aside>;
}
