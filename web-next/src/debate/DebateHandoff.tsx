import { useEffect, useMemo, useState } from "react";
import { AGENT_TYPES, TEAM_DEFAULTS, type AgentExecutorProfile, type AgentType, type Task } from "@harness/shared";
import { ArrowRight, Crown, Robot, UsersThree } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";

export type HandoffChoice = {
  note: string;
  lead: { agentType: AgentType; executorId: string | null };
  worker: { agentType: AgentType; executorId: string | null };
};

function optionValue(type: AgentType, executorId: string | null): string {
  return executorId ? `profile:${executorId}` : `type:${type}`;
}

function resolveChoice(value: string, profiles: AgentExecutorProfile[]): HandoffChoice["lead"] {
  if (value.startsWith("profile:")) {
    const profile = profiles.find((item) => item.id === value.slice(8));
    if (profile) return { agentType: profile.type, executorId: profile.id };
  }
  const type = value.slice(5) as AgentType;
  return { agentType: AGENT_TYPES.includes(type) ? type : "claude", executorId: null };
}

function ExecutorSelect({
  icon,
  label,
  value,
  profiles,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  profiles: AgentExecutorProfile[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="debate-handoff-field">
      <span>{icon}{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {AGENT_TYPES.map((type) => <option key={type} value={optionValue(type, null)}>默认 {type}</option>)}
        {profiles.map((profile) => <option key={profile.id} value={optionValue(profile.type, profile.id)}>{profile.name}</option>)}
      </select>
    </label>
  );
}

export function DebateHandoffModal({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: (choice: HandoffChoice) => Promise<boolean>;
}) {
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [lead, setLead] = useState(optionValue(TEAM_DEFAULTS.lead, null));
  const [worker, setWorker] = useState(optionValue(TEAM_DEFAULTS.worker, null));
  const [note, setNote] = useState("");
  useEffect(() => { void api.agents().then(setProfiles).catch(() => setProfiles([])); }, []);
  const choice = useMemo(() => ({
    note,
    lead: resolveChoice(lead, profiles),
    worker: resolveChoice(worker, profiles),
  }), [lead, note, profiles, worker]);
  const confirm = async () => { if (!busy && await onConfirm(choice)) onClose(); };
  return (
    <div className="debate-handoff-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="debate-handoff-modal" role="dialog" aria-modal="true" aria-labelledby="debate-handoff-title">
        <header><span><UsersThree size={17} weight="fill" /></span><div><h2 id="debate-handoff-title">接力成团</h2><p>辩题、结论和完整转写路径会一并交给新团队。</p></div></header>
        <div className="debate-handoff-grid">
          <ExecutorSelect icon={<Crown size={13} />} label="调度者" value={lead} profiles={profiles} onChange={setLead} />
          <ExecutorSelect icon={<Robot size={13} />} label="默认执行者" value={worker} profiles={profiles} onChange={setWorker} />
        </div>
        <label className="debate-handoff-note"><span>可选附言</span><textarea rows={4} value={note} placeholder="补充执行重点、边界或验收要求…" onChange={(event) => setNote(event.target.value)} /></label>
        <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="is-primary" disabled={busy} onClick={() => void confirm()}>{busy ? "创建中…" : "创建并开干"}</button></footer>
      </section>
    </div>
  );
}

export function DebateHandoffBar({
  linkedTeam,
  busy,
  onOpenTeam,
  onOpenTask,
}: {
  linkedTeam?: Task;
  busy: boolean;
  onOpenTeam: () => void;
  onOpenTask: (task: Task) => void;
}) {
  if (linkedTeam) {
    return (
      <button type="button" className="debate-linked-team" onClick={() => onOpenTask(linkedTeam)}>
        <span><UsersThree size={15} weight="fill" /></span>
        <div><small>已接力成团</small><b>{linkedTeam.title}</b></div>
        <em>{linkedTeam.archived ? "已归档" : linkedTeam.status}</em><ArrowRight size={13} />
      </button>
    );
  }
  return (
    <div className="debate-handoff-bar">
      <div><b>把结论交给团队落实</b><small>创建团队前可选择调度者和默认执行者。</small></div>
      <button type="button" disabled={busy} onClick={onOpenTeam}><UsersThree size={13} weight="fill" />{busy ? "创建中…" : "接力成团"}</button>
    </div>
  );
}
