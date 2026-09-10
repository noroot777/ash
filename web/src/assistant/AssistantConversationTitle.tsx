import { useRef, useState, type ReactNode } from "react";
import { Check, PencilSimple, X } from "@phosphor-icons/react";
import { AssistantIcon } from "./AssistantIcon.tsx";

export function AssistantConversationTitle({ name, onRename, children }: { name: string; onRename: (name: string) => Promise<void>; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setEditing(false); setError(""); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!editing) return <h1><button ref={trigger} type="button" className="chat-room-name assistant-conversation-title" aria-label={`重命名对话：${name}`} onClick={() => { setDraft(name); setEditing(true); }}><AssistantIcon size={23} /><span>{name}</span><PencilSimple size={14} /></button>{children}</h1>;
  return <form className="assistant-rename" onSubmit={async (event) => {
    event.preventDefault();
    if (saving || !draft.trim()) return;
    setSaving(true); setError("");
    try { await onRename(draft.trim()); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }}>
    <div><input aria-label="对话名称" autoFocus maxLength={80} value={draft} disabled={saving} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !saving) { event.preventDefault(); close(); } }} />
      <button type="submit" aria-label="保存对话名称" disabled={saving || !draft.trim()}><Check size={16} /></button><button type="button" aria-label="取消重命名" disabled={saving} onClick={close}><X size={16} /></button></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}
