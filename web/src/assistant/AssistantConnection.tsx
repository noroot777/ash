import { useEffect, useState } from "react";
import type { AgentExecutorProfile } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import { executorValue, isExecutorPickable, parseExecutorValue, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";

export function AssistantConnection({ initial, onSave, onCancel, onSettings }: {
  initial?: ChatMember; onSave: (member: ChatMember) => Promise<void>; onCancel: () => void; onSettings: () => void;
}) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [member, setMember] = useState<ChatMember | undefined>(initial);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api.agents().then((rows) => {
      if (!alive) return;
      setProfiles(rows);
      const first = rows.find((profile) => profile.isDefault) ?? rows[0];
      if (first) setMember((current) => current ?? { id: createClientId(), name: "ash助手", agentType: first.type, executorId: first.id, model: null, reasoningEffort: null });
    }).catch((reason) => { if (alive) setError(String(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const types = registeredAgentTypes(profiles);
  const valid = member && isExecutorPickable(member, types, profiles);
  const save = async () => {
    if (!member || !valid || saving) return;
    setSaving(true); setError("");
    try { await onSave(member); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <section className="assistant-connection" aria-label="助手智能体配置">
    <h2>{initial ? "更换助手的智能体" : "接入你的智能体"}</h2>
    <p>选择 ash 中已配置的执行器，随后就可以直接对话。</p>
    {loading ? <p role="status">正在读取执行器…</p> : member && profiles.length ? <ExecutorPickerField label="助手执行器" value={executorValue(member)} types={types} profiles={profiles} knownProfiles={profiles} fallbackType={member.agentType}
      override={{ model: member.model, effort: member.reasoningEffort }}
      onChange={(value, override) => setMember({ ...member, ...parseExecutorValue(value, profiles, member), model: override.model || null, reasoningEffort: override.effort || null })}
      onEffortChange={(effort) => setMember({ ...member, reasoningEffort: effort || null })} />
      : <p>还没有执行器。先接入一个智能体，再回来开始对话。</p>}
    {error && <p role="alert" className="assistant-error">{error}</p>}
    <footer><button type="button" onClick={onSettings}>打开执行器设置</button><span />{initial && <button type="button" disabled={saving} onClick={onCancel}>取消</button>}
      <button type="button" className="assistant-primary" disabled={saving || !valid || loading} onClick={() => void save()}>{saving ? "保存中…" : initial ? "保存选择" : "开始对话"}</button></footer>
  </section>;
}
