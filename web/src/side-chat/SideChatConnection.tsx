import { useEffect, useState } from "react";
import type { AgentExecutorProfile, Task } from "@ash/shared";
import { SIDE_CHAT_HISTORY_MAX_BYTES } from "@ash/shared/chat";
import type { ChatMember } from "@ash/shared/chat";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import { executorValue, isExecutorPickable, parseExecutorValue, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";

export function SideChatConnection({ task, initial, onSave, onCancel }: {
  task: Task; initial?: ChatMember; onSave: (member: ChatMember) => Promise<void>; onCancel?: () => void;
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
      const match = rows.find((row) => row.id === task.executorId) ?? rows.find((row) => row.type === task.agentType && row.isDefault);
      const first = match ?? rows.find((row) => row.isDefault) ?? rows[0];
      if (first) setMember((current) => current ?? { id: createClientId(), name: "侧聊助手", agentType: first.type, executorId: first.id, model: match ? task.model ?? null : null, reasoningEffort: match ? task.reasoningEffort ?? null : null });
    }).catch((reason) => { if (alive) setError(String(reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [task.id, task.executorId, task.agentType, task.model, task.reasoningEffort]);
  const types = registeredAgentTypes(profiles);
  const valid = member && isExecutorPickable(member, types, profiles);
  const save = async () => {
    if (!member || !valid || saving) return;
    setSaving(true); setError("");
    try { await onSave(member); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <section className="side-chat-connection" aria-label="侧聊执行器配置">
    <h3>{initial ? "侧聊执行器" : "先聊清楚，再交给主任务"}</h3>
    <p>{initial ? "只影响之后的侧聊回复。" : "带入此刻的主会话，独立讨论方案；主任务可以继续工作。"}</p>
    {!initial && <p>主会话快照最多 {SIDE_CHAT_HISTORY_MAX_BYTES / 1024} KiB；较长的历史需先整理，可能增加首次回复的等待时间和用量。超限时不会创建或调用模型。</p>}
    {loading ? <p role="status">正在读取执行器…</p> : member && profiles.length ? <ExecutorPickerField label="侧聊执行器" value={executorValue(member)} types={types} profiles={profiles} knownProfiles={profiles} fallbackType={member.agentType}
      override={{ model: member.model, effort: member.reasoningEffort }} onChange={(value, override) => setMember({ ...member, ...parseExecutorValue(value, profiles, member), model: override.model || null, reasoningEffort: override.effort || null })}
      onEffortChange={(effort) => setMember({ ...member, reasoningEffort: effort || null })} /> : <p>请先在设置中添加执行器。</p>}
    {error && <p role="alert" className="side-chat-error">{error}</p>}
    <footer>{onCancel && <button type="button" disabled={saving} onClick={onCancel}>取消</button>}<button type="button" className="side-chat-primary" disabled={saving || !valid || loading} onClick={() => void save()}>{saving ? "保存中…" : initial ? "保存选择" : "开始侧聊"}</button></footer>
  </section>;
}
