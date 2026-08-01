import { useEffect, useMemo, useState } from "react";
import { TEAM_DEFAULTS, taskDisplayStatus, type AgentExecutorProfile, type AgentType, type Task } from "@harness/shared";
import { ArrowRight, Crown, Robot, Scales, UsersThree, Warning } from "@phosphor-icons/react";
import {
  executorOptions,
  executorValue,
  isExecutorPickable,
  nothingRunnable,
  parseExecutorValue,
  preferredExecutor,
  teamExecutorCandidates,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { teamDebateIterationState } from "./handoffPolicy.ts";

export type HandoffChoice = {
  note: string;
  lead: { agentType: AgentType; executorId: string | null };
  worker: { agentType: AgentType; executorId: string | null };
};

function ExecutorSelect({
  icon,
  label,
  value,
  types,
  profiles,
  knownProfiles,
  fallbackType,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles: AgentExecutorProfile[];
  fallbackType: AgentType;
  onChange: (value: string) => void;
}) {
  const selection = parseExecutorValue(value, knownProfiles, { agentType: fallbackType, executorId: null });
  const options = executorOptions({ types, profiles, knownProfiles, selection });
  const pickableCount = types.length + profiles.length;
  return (
    <label className="debate-handoff-field">
      <span>{icon}{label}</span>
      <select
        value={pickableCount || options.length ? executorValue(selection) : ""}
        disabled={pickableCount === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.length === 0 && <option value="">暂无可用执行器</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
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
  const [profilesReady, setProfilesReady] = useState(false);
  const [lead, setLead] = useState(executorValue({ agentType: TEAM_DEFAULTS.lead, executorId: null }));
  const [worker, setWorker] = useState(executorValue({ agentType: TEAM_DEFAULTS.worker, executorId: null }));
  const [note, setNote] = useState("");
  const detection = useAgentAvailability();
  const { workerTypes, leadTypes, leadProfiles } = useMemo(
    () => teamExecutorCandidates(detection, profiles),
    [detection, profiles],
  );
  useEffect(() => {
    let alive = true;
    api.agents().then((nextProfiles) => { if (alive) setProfiles(nextProfiles); })
      .catch(() => { if (alive) setProfiles([]); })
      .finally(() => { if (alive) setProfilesReady(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!profilesReady || detection.status === "loading") return;
    const reconcile = (
      value: string,
      types: AgentType[],
      candidates: AgentExecutorProfile[],
      preferred: AgentType,
      avoid?: AgentType,
    ) => {
      const current = parseExecutorValue(value, profiles, { agentType: preferred, executorId: null });
      if (value === executorValue(current) && isExecutorPickable(current, types, candidates)) return value;
      const fallback = preferredExecutor(types, candidates, preferred, avoid);
      return fallback ? executorValue(fallback) : value;
    };
    const nextLead = reconcile(lead, leadTypes, leadProfiles, TEAM_DEFAULTS.lead);
    const leadType = parseExecutorValue(
      nextLead,
      profiles,
      { agentType: TEAM_DEFAULTS.lead, executorId: null },
    ).agentType;
    const nextWorker = reconcile(worker, workerTypes, profiles, TEAM_DEFAULTS.worker, leadType);
    if (nextLead !== lead) setLead(nextLead);
    if (nextWorker !== worker) setWorker(nextWorker);
  }, [detection.status, lead, leadProfiles, leadTypes, profiles, profilesReady, worker, workerTypes]);
  const choice = useMemo(() => ({
    note,
    lead: parseExecutorValue(lead, profiles, { agentType: TEAM_DEFAULTS.lead, executorId: null }),
    worker: parseExecutorValue(worker, profiles, { agentType: TEAM_DEFAULTS.worker, executorId: null }),
  }), [lead, note, profiles, worker]);
  const noExecutor = profilesReady && nothingRunnable(profiles);
  const unavailableRole = !isExecutorPickable(choice.lead, leadTypes, leadProfiles) ? "调度者"
    : !isExecutorPickable(choice.worker, workerTypes, profiles) ? "执行者" : null;
  const roleBlocked = !!unavailableRole;
  const availabilityMessage = noExecutor
    ? "还没有已注册执行器，暂不能创建团队。"
    : unavailableRole
      ? `${unavailableRole}当前未注册或不支持该角色，请更换执行器。`
      : detection.status === "loading"
        ? "正在确认已注册调度者的常驻会话能力…"
        : detection.status === "failed"
          ? "常驻能力检测失败；调度者候选仅保留系统已知支持的已注册类型。"
          : null;
  const canConfirm = !busy && !noExecutor && !roleBlocked;
  const confirm = async () => { if (canConfirm && await onConfirm(choice)) onClose(); };
  return (
    <div className="debate-handoff-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="debate-handoff-modal" role="dialog" aria-modal="true" aria-labelledby="debate-handoff-title">
        <header><span><UsersThree size={17} weight="fill" /></span><div><h2 id="debate-handoff-title">接力成团</h2><p>辩题、结论和完整转写路径会一并交给新团队。</p></div></header>
        <div className="debate-handoff-grid">
          <ExecutorSelect icon={<Crown size={13} />} label="调度者" value={lead} types={leadTypes} profiles={leadProfiles} knownProfiles={profiles} fallbackType={TEAM_DEFAULTS.lead} onChange={setLead} />
          <ExecutorSelect icon={<Robot size={13} />} label="默认执行者" value={worker} types={workerTypes} profiles={profiles} knownProfiles={profiles} fallbackType={TEAM_DEFAULTS.worker} onChange={setWorker} />
        </div>
        {availabilityMessage && <p className="debate-handoff-warning"><Warning size={13} />{availabilityMessage}</p>}
        <label className="debate-handoff-note"><span>可选附言</span><textarea rows={4} value={note} placeholder="补充执行重点、边界或验收要求…" onChange={(event) => setNote(event.target.value)} /></label>
        <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="is-primary" disabled={!canConfirm} onClick={() => void confirm()}>{busy ? "创建中…" : "创建并开干"}</button></footer>
      </section>
    </div>
  );
}

export function DebateHandoffBar({
  linkedTeams,
  allTasks,
  busy,
  iterationBusyId,
  onOpenTeam,
  onOpenTask,
  onIterateTeam,
}: {
  linkedTeams: Task[];
  allTasks: Task[];
  busy: boolean;
  iterationBusyId?: string | null;
  onOpenTeam: () => void;
  onOpenTask: (task: Task) => void;
  onIterateTeam: (team: Task) => void;
}) {
  if (linkedTeams.length > 0) {
    return (
      <div className="debate-handoff-stack">
        <div className="debate-linked-team-list" aria-label="关联团队">
          {linkedTeams.map((team) => {
            const iteration = teamDebateIterationState(team, allTasks);
            const status = taskDisplayStatus(team.status, team.stage, !!team.question).label;
            const iterationBusy = iterationBusyId === team.id;
            return (
              <div className="debate-linked-team" key={team.id}>
                <button type="button" className="debate-linked-team-main" onClick={() => onOpenTask(team)}>
                  <span><UsersThree size={15} weight="fill" /></span>
                  <div><small>已接力成团</small><b>{team.title}</b></div>
                  <em>{team.archived ? "已归档" : status}</em><ArrowRight size={13} />
                </button>
                {iteration.eligible && (
                  <button
                    type="button"
                    className="debate-iterate-team"
                    disabled={busy}
                    onClick={() => onIterateTeam(team)}
                    title={iteration.existing ? "打开这个团队已经创建的下一轮辩论" : "读取团队执行记录，沿用来源辩论配置创建下一轮"}
                  >
                    <Scales size={12} weight="fill" />
                    {iterationBusy ? "创建中…" : iteration.existing ? "打开下一轮" : "再辩一轮"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button type="button" className="debate-new-team" disabled={busy} onClick={onOpenTeam}>
          <UsersThree size={13} weight="fill" />{busy ? "创建中…" : "再开一组"}
        </button>
      </div>
    );
  }
  return (
    <div className="debate-handoff-bar">
      <div><b>把结论交给团队落实</b><small>创建团队前可选择调度者和默认执行者。</small></div>
      <button type="button" disabled={busy} onClick={onOpenTeam}><UsersThree size={13} weight="fill" />{busy ? "创建中…" : "接力成团"}</button>
    </div>
  );
}
