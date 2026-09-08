import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectView, TaskListItem, TaskMode } from "@ash/shared";
import type { ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { ALL_MENTION_ALIASES, isChatClearCommand, mentionedMembers } from "@ash/shared/chat";
import { ArrowLeft, ArrowUp, At, ChatCircleDots, Hash, PencilSimple, Plus, Stop, UsersThree } from "@phosphor-icons/react";
import { chatApi } from "./chatApi.ts";
import { ChatMembers } from "./ChatMembers.tsx";
import { ChatMessages } from "./ChatMessages.tsx";
import { ChatContextNotice } from "./ChatContextNotice.tsx";
import { createClientId } from "../lib/clientId.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { MODES } from "../composer/composerParts.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import "./chat.css";

export function ChatView({ project, onTask, onExit, onMode }: {
  project: ProjectView; onTask: (task: TaskListItem) => void; onExit: () => void; onMode: (mode: TaskMode) => void;
}) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [editor, setEditor] = useState<"create" | "members" | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const mentionMenu = useRef<HTMLDivElement>(null);
  const connectionTip = useHoverTip();
  useDismissable({ enabled: mentionOpen, containerRef: mentionMenu, restoreFocusRef: input, onClose: () => setMentionOpen(false) });
  const request = useRef<{ body: string; id: string } | null>(null);
  const selected = useRef(roomId);
  selected.current = roomId;
  const selectRoom = useCallback((nextId: string) => {
    window.localStorage.setItem(`ash:chat:${project.id}`, nextId);
    setEditor(null);
    setError("");
    setMentionOpen(false);
    // 点已经选中的群只是「回到这个群」：不能清快照——快照订阅的依赖是 roomId，同一个 id 不会重订阅，
    // 而已连接的 SSE 只在数据变化时才推 snapshot，清掉就再也补不回来，右侧会一直停在空态。
    if (selected.current === nextId) return;
    request.current = null;
    setRoomId(nextId);
    setSnapshot(null);
    setDraft(window.sessionStorage.getItem(`ash:chat-draft:${nextId}`) ?? "");
  }, [project.id]);
  useEffect(() => {
    let alive = true;
    chatApi.rooms(project.id).then((rows) => {
      if (!alive) return;
      setRooms(rows);
      const saved = window.localStorage.getItem(`ash:chat:${project.id}`);
      const first = rows.find((room) => room.id === saved) ?? rows[0];
      if (first) selectRoom(first.id);
      else setEditor("create");
      setReady(true);
    }).catch((reason) => { if (alive) { setError(String(reason)); setReady(true); } });
    return () => { alive = false; };
  }, [project.id, selectRoom]);
  useEffect(() => {
    if (!roomId) return;
    window.sessionStorage.setItem(`ash:chat-draft:${roomId}`, draft);
  }, [draft, roomId]);
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    let streamed = false;
    setConnected(false);
    const apply = (value: ChatSnapshot) => {
      if (!alive) return;
      setSnapshot(value);
      setRooms((current) => current.map((room) => room.id === value.room.id ? value.room : room));
    };
    chatApi.snapshot(roomId).then((value) => { if (!streamed) apply(value); }).catch((reason) => { if (alive && !streamed) setError(String(reason)); });
    const source = new EventSource(`/api/chats/${roomId}/events`);
    source.addEventListener("snapshot", (event) => { streamed = true; apply(JSON.parse((event as MessageEvent).data) as ChatSnapshot); if (alive) setConnected(true); });
    source.addEventListener("ping", () => { if (alive) setConnected(true); });
    source.addEventListener("revoked", () => { source.close(); setSnapshot(null); setError("群聊已不可访问，请返回项目重新选择。"); });
    source.onopen = () => { if (alive) setConnected(true); };
    source.onerror = () => { if (alive) setConnected(false); };
    return () => { alive = false; source.close(); };
  }, [roomId]);
  const mention = (name: string) => {
    setDraft((value) => /(?:^|\s)@[^\s@]*$/u.test(value) ? value.replace(/@[^\s@]*$/u, `@${name} `) : `${value}${value && !/\s$/u.test(value) ? " " : ""}@${name} `);
    setMentionOpen(false);
    input.current?.focus();
  };
  const send = async () => {
    const body = draft.trim();
    if (!roomId || sending || !body || body.length > 8000) return;
    if (request.current?.body !== body) request.current = { body, id: createClientId() };
    setSending(true);
    setError("");
    try {
      const result = await chatApi.send(roomId, body, request.current.id);
      if (selected.current !== roomId) return;
      setSnapshot(result);
      setDraft("");
      request.current = null;
      setMentionOpen(false);
      input.current?.focus();
    } catch (reason) { if (selected.current === roomId) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSending(false); }
  };
  // 快照还没到时先用频道列表里的群兜底，标题、成员和输入框不必空等，只有消息流显示载入中。
  const room = snapshot?.room ?? rooms.find((item) => item.id === roomId);
  const mentioned = room ? mentionedMembers(draft, room.members) : [];
  const everyone = !!room && room.members.length > 1 && mentioned.length === room.members.length;
  const active = snapshot?.messages.filter((message) => message.status === "queued" || message.status === "running") ?? [];
  const token = draft.match(/(?:^|\s)@([^\s@]*)$/u)?.[1] ?? "";
  const matches = room?.members.filter((member) => member.name.toLowerCase().includes(token.toLowerCase())) ?? [];
  const showAll = !!room && room.members.length > 1 && ALL_MENTION_ALIASES.some((alias) => alias.includes(token.toLowerCase()));
  const candidates: { id: string; name: string; hint: string }[] = [
    ...(showAll ? [{ id: "chat-mention-all", name: ALL_MENTION_ALIASES[0], hint: `全体成员 · ${room!.members.length} 位` }] : []),
    ...matches.map((member) => ({ id: member.id, name: member.name, hint: member.agentType })),
  ];
  return <section className="chat-shell" aria-label="聊天模式">
    <nav className="chat-rail" aria-label="聊天频道"><header><span className="chat-brand"><ChatCircleDots size={25} weight="fill" />聊天</span><button type="button" aria-label="返回工作区" onClick={onExit}><ArrowLeft size={17} /></button></header><div className="chat-project">{project.name}<small>点名协作 · 安静待命</small></div>
      <div className="chat-channel-label">你的群聊<button type="button" onClick={() => setEditor("create")} aria-label="新建群聊"><Plus size={17} /></button></div>
      <div className="chat-channels">{rooms.map((item) => <button type="button" key={item.id} className={item.id === roomId && editor !== "create" ? "is-selected" : ""} onClick={() => selectRoom(item.id)}><Hash size={17} /><span>{item.name}</span><small>{item.members.length}</small></button>)}</div>
      <div className="chat-rail-note"><At size={22} /><strong>有需要，再叫上它。</strong><p>没有 @ 的普通消息只保存在群里。@all 唤醒全部成员；单独发送 /clear 重新开始上下文。</p></div>
    </nav>
    <div className="chat-main"><div className="chat-mode-bar" aria-label="工作模式">{MODES.map((mode) => <button type="button" key={mode.value} onClick={() => onMode(mode.value)}>{mode.label}</button>)}<button type="button" aria-current="page" className="is-active"><ChatCircleDots size={14} />聊天</button></div>
      {editor ? <ChatMembers key={`${editor}-${roomId}`} creating={editor === "create"} initial={editor === "members" ? room?.members ?? [] : []} initialName={editor === "members" ? room?.name : undefined} onCancel={() => setEditor(null)} onSave={async (members, name) => {
        if (editor === "create") { const created = await chatApi.create(project.id, name, members); setRooms((current) => [...current, created]); selectRoom(created.id); }
        else if (roomId) {
          const updated = await chatApi.update(roomId, { name, members });
          setSnapshot((current) => current ? { ...current, room: updated } : current);
          setRooms((current) => current.map((item) => item.id === updated.id ? updated : item));
          setEditor(null);
        }
      }} /> : <>
        <header className="chat-header"><h1>{room
          ? <button type="button" className="chat-room-name" aria-label={`群聊设置：${room.name}`} onClick={() => setEditor("members")}><Hash size={23} />{room.name}<PencilSimple size={14} /></button>
          : <><Hash size={23} />聊天空间</>}{roomId && <span className={`chat-connection ${connected ? "is-connected" : ""}`} tabIndex={0} role="status" aria-label={connected ? "实时连接" : "连接中，状态可能延迟"} {...connectionTip.anchorProps} />}</h1>{room && <button type="button" className="chat-member-count" onClick={() => setEditor("members")}><UsersThree size={19} />{room.members.length} 位成员</button>}<HoverTip at={connectionTip.at}>{connected ? "实时连接" : "连接中，状态可能延迟"}</HoverTip></header>
        {snapshot ? <ChatMessages snapshot={snapshot} onTask={onTask} onMention={mention} />
          : <div className="chat-empty"><ChatCircleDots size={48} weight="duotone" /><h2>{roomId ? `正在载入 #${room?.name ?? "群聊"}…` : ready ? "把想法变成对话" : "正在载入聊天…"}</h2><p>{roomId ? "消息马上就到，这个群的历史只属于这里。" : "建立一个空间，和你的智能体一起聊。"}</p>{ready && !roomId && <button type="button" className="chat-primary" onClick={() => setEditor("create")}>新建群聊</button>}</div>}
        {room && <div className="chat-composer-area"><div className="chat-live-line">{active.length || snapshot?.context?.status === "compacting" ? <><span className="chat-live-dot" />{active.length ? `${active.map((message) => message.author).filter((name, index, all) => all.indexOf(name) === index).join("、")} 正在回复` : "正在整理群聊历史"}<button type="button" onClick={() => void chatApi.stop(room.id).then((result) => { if (selected.current === room.id) setSnapshot(result); }).catch((reason) => setError(String(reason)))}><Stop size={12} weight="fill" />停止回复</button></> : <span>所有成员安静待命</span>}</div>
          <ChatContextNotice context={snapshot?.context} />
          <div className="chat-composer">{mentionOpen && candidates.length > 0 && <div ref={mentionMenu} className="chat-mention-menu" role="listbox" aria-label="点名成员">{candidates.map((option, index) => <button role="option" aria-selected={index === mentionIndex % candidates.length} className={index === mentionIndex % candidates.length ? "is-selected" : ""} type="button" key={option.id} onClick={() => mention(option.name)}><span className={`chat-avatar tone-${index % 4}`}>{option.name.slice(0, 1).toUpperCase()}</span><strong>@{option.name}</strong><small>{option.hint}</small></button>)}</div>}
            <textarea ref={input} aria-label="群聊消息输入" value={draft} maxLength={8000} disabled={sending} placeholder={`发消息到 #${room.name}，@ 选择成员、@all 唤醒全部…`} onChange={(event) => { setDraft(event.target.value); setMentionOpen(/(?:^|\s)@[^\s@]*$/u.test(event.target.value)); setMentionIndex(0); }} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") { setMentionOpen(false); return; }
              if (mentionOpen && candidates.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
                event.preventDefault();
                if (event.key === "ArrowDown") setMentionIndex((current) => (current + 1) % candidates.length);
                else if (event.key === "ArrowUp") setMentionIndex((current) => (current + candidates.length - 1) % candidates.length);
                else mention(candidates[mentionIndex % candidates.length]!.name);
              } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }} />
            <footer><button type="button" aria-label="选择点名成员" onClick={() => { setMentionOpen((current) => !current); input.current?.focus(); }}><At size={20} /></button><span>{isChatClearCommand(draft) ? "将清空后续上下文，并停止当前回复" : mentioned.length ? everyone ? `将唤醒全部 ${mentioned.length} 位成员` : `将唤醒 ${mentioned.map((member) => `@${member.name}`).join("、")}` : "不 @，只记录；不唤醒"}</span><button type="button" className="chat-send" aria-label="发送消息" disabled={sending || !draft.trim()} onClick={() => void send()}><ArrowUp size={20} weight="bold" /></button></footer>
          </div><div className="chat-composer-hint">Enter 发送 · Shift Enter 换行 · /clear 清空上下文<span>短回复，长任务。</span></div>
        </div>}
      </>}
      {error && <div className="chat-error" role="alert">{error}<button type="button" onClick={() => setError("")}>关闭</button></div>}
    </div>
    {room && !editor && <aside className="chat-info"><div className="chat-info-title"><UsersThree size={20} /><h2>在这个空间</h2></div><p>只有你点名时，才会加入对话。</p><div className="chat-presence">{room.members.length > 1 && <button type="button" onClick={() => mention(ALL_MENTION_ALIASES[0])}><span className="chat-avatar tone-3"><UsersThree size={17} /></span><span><strong>@all</strong><small>一次唤醒全部 {room.members.length} 位</small></span><At size={14} /></button>}{room.members.map((member, index) => <button type="button" key={member.id} onClick={() => mention(member.name)}><span className={`chat-avatar tone-${index % 4}`}>{member.name.slice(0, 1).toUpperCase()}<i className={active.some((message) => message.memberId === member.id) ? "is-busy" : ""} /></span><span><strong>{member.name}</strong><small>{active.some((message) => message.memberId === member.id) ? "正在回复" : "待命 · @ 唤醒"}</small></span><At size={14} /></button>)}</div><button type="button" className="chat-add-member" onClick={() => setEditor("members")}><Plus size={14} />管理成员</button><div className="chat-info-divider" /><h3>从对话到行动</h3><p>明确委派的工作会创建 ash 任务，进度留在对话里，详细过程放在任务页。</p><div className="chat-info-stat"><strong>{snapshot?.tasks.length ?? 0}</strong><span>项关联任务</span></div><small className="chat-context-note">被点名时读取本群共享摘要和近期完整消息。接近预算上限时整理较早历史，原文保留，不读取其他群。</small></aside>}
  </section>;
}
