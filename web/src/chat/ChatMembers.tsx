import { useEffect, useState } from "react";
import type { AgentExecutorProfile } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";
import { Plus, X } from "@phosphor-icons/react";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import { executorValue, parseExecutorValue, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";

export function ChatMembers({ initial, initialName, onSave, onCancel, creating = false }: {
  initial: ChatMember[]; initialName?: string; onSave: (members: ChatMember[], name: string) => Promise<void>; onCancel: () => void; creating?: boolean;
}) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [members, setMembers] = useState(initial);
  const [name, setName] = useState(initialName ?? "协作空间");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    api.agents().then((value) => { if (alive) setProfiles(value); }).catch((reason) => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, []);
  const change = (memberId: string, patch: Partial<ChatMember>) => setMembers((current) => current.map((member) => member.id === memberId ? { ...member, ...patch } : member));
  const add = () => {
    const profile = profiles[members.length % profiles.length];
    if (!profile) return;
    const base = profile.type;
    let label: string = base;
    let suffix = 2;
    while (members.some((member) => member.name === label)) label = `${base}-${suffix++}`;
    setMembers((current) => [...current, { id: createClientId(), name: label, agentType: profile.type, executorId: profile.id, model: null, reasoningEffort: null }]);
  };
  const save = async () => {
    if (saving || !members.length || !name.trim()) return;
    setSaving(true);
    setError("");
    try { await onSave(members, name.trim()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <section className="chat-member-editor" aria-label={creating ? "创建群聊" : "群聊设置"}>
    <div className="chat-editor-heading"><div><small>让合适的人参与</small><h2>{creating ? "创建一个聊天空间" : "群聊设置"}</h2></div><button type="button" aria-label="关闭成员配置" onClick={onCancel}><X size={20} /></button></div>
    <p>选择智能体、模型与智能水平。只有你明确 @ 的成员才会收到会话并回复；<strong>@all（或 @所有人）一次唤醒全部成员</strong>，所以成员名不能叫 all 或所有人。</p>
    <p>所有已注册智能体均可参与。被你 @ 后可查看当前项目、使用工具辅助回答；修改代码等执行工作需你明确委派，再创建任务。</p>
    <p>写入或无法确认只读的工具调用会中止咨询并保留警告；咨询期间项目目录的并发变化不会中止回复，只随回复附注展示。已发生的改动都不会自动撤销。</p>
    <label className="chat-name-field">群聊名称<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <div className="chat-member-fields">{members.map((member, index) => <div className="chat-member-field" key={member.id}>
      <span className={`chat-avatar tone-${index % 4}`}>{member.name.slice(0, 1).toUpperCase()}</span>
      <label>点名名称<input value={member.name} maxLength={32} onChange={(event) => change(member.id, { name: event.target.value })} /></label>
      <ExecutorPickerField label="执行器" value={executorValue(member)} types={registeredAgentTypes(profiles)} profiles={profiles} knownProfiles={profiles} fallbackType={member.agentType}
        override={{ model: member.model, effort: member.reasoningEffort }}
        onChange={(value, override) => change(member.id, { ...parseExecutorValue(value, profiles, member), model: override.model || null, reasoningEffort: override.effort || null })}
        onEffortChange={(reasoningEffort) => change(member.id, { reasoningEffort: reasoningEffort || null })} />
      <button type="button" aria-label={`移除 ${member.name}`} onClick={() => setMembers((current) => current.filter((candidate) => candidate.id !== member.id))}><X size={16} /></button>
    </div>)}</div>
    <button className="chat-add-member" type="button" onClick={add} disabled={!profiles.length || members.length >= 24}><Plus size={16} />添加成员</button>
    {!profiles.length && <p>暂无可选执行器。请先在 ash「执行器」设置中注册。</p>}
    {error && <p className="chat-error" role="alert">{error}</p>}
    <footer><span>智能体之间的 @ 只展示，不会触发执行。</span><button className="chat-primary" type="button" disabled={saving || !members.length || !name.trim()} onClick={() => void save()}>{saving ? "保存中…" : creating ? "创建群聊" : "保存设置"}</button></footer>
  </section>;
}
