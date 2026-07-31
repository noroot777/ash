import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentExecutorProfile, AgentType, DebateConfig, Task, TeamConfig } from "@harness/shared";
import {
  AGENT_TYPES,
  DEBATE_DEFAULTS,
  DEFAULT_APP_SETTINGS,
  TEAM_DEFAULTS,
} from "@harness/shared";
import { CLI_MODEL_PRESETS, REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import {
  GitBranch,
  Scales,
  SpinnerGap,
  TreeStructure,
  UsersThree,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Button, Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import {
  buildTaskDerivationBody,
  defaultDebateTopic,
  derivedWorktreeDefaults,
  type TaskDerivationCommand,
} from "./taskDerivation.ts";

type ExecutorChoice = {
  profile: string;
  model: string;
  effort: string;
};

type WorktreeContext = {
  isRepo: boolean;
  branches: string[];
  current: string | null;
  worktreeDefault: boolean;
};

type DetectedAgent = Awaited<ReturnType<typeof api.detectAgents>>[number];

const emptyChoice = (): ExecutorChoice => ({ profile: "", model: "", effort: "" });

function selectionType(profiles: AgentExecutorProfile[], value: string, fallback: AgentType): AgentType {
  if (value.startsWith("__type:")) return value.slice(7) as AgentType;
  return profiles.find((profile) => profile.id === value)?.type ?? fallback;
}

function selectionExecutorId(value: string): string | null {
  return value && !value.startsWith("__type:") ? value : null;
}

function preferredSelection(
  types: AgentType[],
  profiles: AgentExecutorProfile[],
  preferred: AgentType,
  avoid?: AgentType,
): string {
  const type = types.find((candidate) => candidate === preferred && candidate !== avoid)
    ?? types.find((candidate) => candidate !== avoid)
    ?? types[0];
  if (type) return `__type:${type}`;
  const profile = profiles.find((candidate) => candidate.type === preferred && candidate.type !== avoid && candidate.isDefault)
    ?? profiles.find((candidate) => candidate.type !== avoid && candidate.isDefault)
    ?? profiles.find((candidate) => candidate.type !== avoid)
    ?? profiles.find((candidate) => candidate.isDefault)
    ?? profiles[0];
  return profile?.id ?? `__type:${preferred}`;
}

function selectionAvailable(
  value: string,
  types: AgentType[],
  profiles: AgentExecutorProfile[],
): boolean {
  if (value.startsWith("__type:")) return types.includes(value.slice(7) as AgentType);
  return profiles.some((profile) => profile.id === value);
}

function ExecutorSelect({
  label,
  value,
  types,
  profiles,
  onChange,
}: {
  label: string;
  value: string;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="composer-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {types.map((type) => <option value={`__type:${type}`} key={`type:${type}`}>{type} · 类型默认</option>)}
        {profiles.map((profile) => (
          <option value={profile.id} key={profile.id}>
            {profile.name}{profile.model ? ` · ${profile.model}` : ""}{profile.isDefault ? "（默认）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function TeamExecutorField({
  role,
  label,
  choice,
  types,
  profiles,
  onChange,
}: {
  role: string;
  label: string;
  choice: ExecutorChoice;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  onChange: (choice: ExecutorChoice) => void;
}) {
  const type = selectionType(profiles, choice.profile, TEAM_DEFAULTS.worker);
  const modelsId = `task-derivation-models-${role}-${type}`;
  return (
    <div className="task-derivation-role">
      <ExecutorSelect
        label={label}
        value={choice.profile}
        types={types}
        profiles={profiles}
        onChange={(profile) => onChange({ profile, model: "", effort: "" })}
      />
      <div className="task-derivation-overrides">
        <label className="composer-field">
          <span>模型</span>
          <input
            value={choice.model}
            list={modelsId}
            onChange={(event) => onChange({ ...choice, model: event.target.value })}
            placeholder="跟随执行器"
          />
          <datalist id={modelsId}>
            {CLI_MODEL_PRESETS[type].map((model) => <option value={model} key={model} />)}
          </datalist>
        </label>
        <label className="composer-field">
          <span>思考强度</span>
          <select
            value={choice.effort}
            onChange={(event) => onChange({ ...choice, effort: event.target.value })}
          >
            <option value="">跟随执行器</option>
            {REASONING_EFFORT_VALUES[type].map((effort) => <option value={effort} key={effort}>{effort}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

export function TaskDerivationComposer({
  task,
  command,
  live = false,
  onClose,
  onCreated,
  notify,
}: {
  task: Task;
  command: TaskDerivationCommand;
  live?: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const teamMode = command.kind === "team";
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [detected, setDetected] = useState<DetectedAgent[] | null>(null);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [executorsReady, setExecutorsReady] = useState(false);
  const [lead, setLead] = useState<ExecutorChoice>(emptyChoice);
  const [worker, setWorker] = useState<ExecutorChoice>(emptyChoice);
  const [reviewer, setReviewer] = useState<ExecutorChoice>(emptyChoice);
  const [debaterA, setDebaterA] = useState("");
  const [debaterB, setDebaterB] = useState("");
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [rounds, setRounds] = useState(DEBATE_DEFAULTS.maxRounds === null ? "" : String(DEBATE_DEFAULTS.maxRounds));
  const [gate, setGate] = useState(DEBATE_DEFAULTS.gateG1 === "on");
  const [note, setNote] = useState(command.note);
  const [topic, setTopic] = useState(() => defaultDebateTopic(task, command.note));
  const [worktreeContext, setWorktreeContext] = useState<WorktreeContext | null>(null);
  const noteTouched = useRef(false);
  const topicTouched = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const topicRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    const profilesRequest = api.agents().catch((error) => {
      notify(error instanceof Error ? error.message : "执行器配置读取失败");
      return [] as AgentExecutorProfile[];
    });
    const detectionRequest = api.detectAgents().then(
      (list) => ({ list, failed: false }),
      () => ({ list: [] as DetectedAgent[], failed: true }),
    );
    Promise.all([profilesRequest, detectionRequest]).then(([nextProfiles, detection]) => {
      if (!alive) return;
      const availableTypes = detection.failed
        ? [...AGENT_TYPES]
        : AGENT_TYPES.filter((type) => detection.list.some((item) => item.type === type && item.available));
      const residentTypes = AGENT_TYPES.filter((type) => type === "claude"
        || detection.list.some((item) => item.type === type && item.resident));
      const leadTypes = availableTypes.filter((type) => residentTypes.includes(type));
      const leadProfiles = nextProfiles.filter((profile) => residentTypes.includes(profile.type));
      const leadProfile = preferredSelection(leadTypes, leadProfiles, TEAM_DEFAULTS.lead);
      const leadType = selectionType(leadProfiles, leadProfile, TEAM_DEFAULTS.lead);
      const workerProfile = preferredSelection(availableTypes, nextProfiles, "codex", leadType);
      const debateAProfile = preferredSelection(availableTypes, nextProfiles, DEBATE_DEFAULTS.debaterA);
      const debateAType = selectionType(nextProfiles, debateAProfile, DEBATE_DEFAULTS.debaterA);
      setProfiles(nextProfiles);
      setDetected(detection.list);
      setDetectionFailed(detection.failed);
      setLead({ profile: leadProfile, model: "", effort: "" });
      setWorker({ profile: workerProfile, model: "", effort: "" });
      setReviewer({ profile: workerProfile, model: "", effort: "" });
      setDebaterA(debateAProfile);
      setDebaterB(preferredSelection(availableTypes, nextProfiles, DEBATE_DEFAULTS.debaterB, debateAType));
      setExecutorsReady(true);
    });
    return () => { alive = false; };
  }, [notify]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.projectHealth(task.projectId), api.projectBranches(task.projectId), api.settings()]).then(
      ([health, branches, settings]) => {
        if (alive) setWorktreeContext({ isRepo: health.isRepo, ...branches, worktreeDefault: settings.worktreeDefault });
      },
      (error) => {
        if (!alive) return;
        setWorktreeContext({
          isRepo: false,
          branches: [],
          current: null,
          worktreeDefault: DEFAULT_APP_SETTINGS.worktreeDefault,
        });
        notify(`无法确认 worktree 基点：${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return () => { alive = false; };
  }, [notify, task.projectId]);

  useEffect(() => {
    if (!live) return;
    if (teamMode && !noteTouched.current) setNote(command.note);
    if (!teamMode && !topicTouched.current) setTopic(defaultDebateTopic(task, command.note));
  }, [command.note, live, task, teamMode]);

  useEffect(() => {
    if (live) return;
    (teamMode ? noteRef : topicRef).current?.focus();
  }, [live, teamMode]);

  const availableTypes = useMemo(() => detectionFailed
    ? [...AGENT_TYPES]
    : AGENT_TYPES.filter((type) => detected?.some((item) => item.type === type && item.available)),
  [detected, detectionFailed]);
  const residentTypes = useMemo(() => AGENT_TYPES.filter((type) => type === "claude"
    || detected?.some((item) => item.type === type && item.resident)), [detected]);
  const leadTypes = availableTypes.filter((type) => residentTypes.includes(type));
  const leadProfiles = profiles.filter((profile) => residentTypes.includes(profile.type));
  const worktree = derivedWorktreeDefaults(
    task,
    worktreeContext?.branches ?? [],
    !!worktreeContext?.isRepo,
    worktreeContext?.worktreeDefault ?? DEFAULT_APP_SETTINGS.worktreeDefault,
  );
  const noExecutor = executorsReady && !detectionFailed && availableTypes.length === 0 && profiles.length === 0;
  const unavailableRole = !executorsReady ? null : teamMode
    ? !selectionAvailable(lead.profile, leadTypes, leadProfiles)
      ? "调度者"
      : !selectionAvailable(worker.profile, availableTypes, profiles)
        ? "执行者"
        : reviewEnabled && !selectionAvailable(reviewer.profile, availableTypes, profiles)
          ? "审查者"
          : null
    : !selectionAvailable(debaterA, availableTypes, profiles)
      ? "辩手 A"
      : !selectionAvailable(debaterB, availableTypes, profiles)
        ? "辩手 B"
        : null;
  const canSubmit = !busy && executorsReady && !!worktreeContext && !noExecutor && !unavailableRole
    && (teamMode || !!topic.trim());

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    let created: Task;
    try {
      const sessions = await api.sessions(task.id);
      const body = buildTaskDerivationBody(task, sessions, command.kind, teamMode ? note : topic);
      if (teamMode) {
        const team: TeamConfig = {
          lead: selectionType(profiles, lead.profile, TEAM_DEFAULTS.lead),
          worker: selectionType(profiles, worker.profile, TEAM_DEFAULTS.worker),
          leadExecutorId: selectionExecutorId(lead.profile),
          workerExecutorId: selectionExecutorId(worker.profile),
          leadModel: lead.model || null,
          leadReasoningEffort: lead.effort || null,
          workerModel: worker.model || null,
          workerReasoningEffort: worker.effort || null,
          review: reviewEnabled,
          reviewerAgentType: selectionType(profiles, reviewer.profile, TEAM_DEFAULTS.worker),
          reviewerExecutorId: selectionExecutorId(reviewer.profile),
          reviewerModel: reviewer.model || null,
          reviewerReasoningEffort: reviewer.effort || null,
        };
        created = await api.createTask({
          projectId: task.projectId,
          title: `团队接手：${task.title}`.slice(0, 60),
          body,
          mode: "team",
          originTaskId: task.id,
          agentType: team.lead,
          team,
          autoTitle: false,
          worktreeBase: worktree.worktreeBase,
        });
      } else {
        const debate: DebateConfig = {
          ...DEBATE_DEFAULTS,
          topic: topic.trim(),
          debaterA: selectionType(profiles, debaterA, DEBATE_DEFAULTS.debaterA),
          debaterB: selectionType(profiles, debaterB, DEBATE_DEFAULTS.debaterB),
          debaterAExecutorId: selectionExecutorId(debaterA),
          debaterBExecutorId: selectionExecutorId(debaterB),
          maxRounds: rounds === "" ? null : Math.max(1, Number(rounds) || 3),
          gateG1: gate ? "on" : "off",
        };
        created = await api.createTask({
          projectId: task.projectId,
          title: `任务讨论：${task.title}`.slice(0, 60),
          body,
          mode: "debate",
          originTaskId: task.id,
          debate,
          autoTitle: false,
          worktreeBase: worktree.worktreeBase,
        });
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "派生任务创建失败");
      setBusy(false);
      return;
    }

    onClose();
    onCreated(created);
    try {
      await api.runTask(created.id);
      notify(teamMode ? "已创建团队任务并开干" : "已创建辩论任务并开跑");
    } catch (error) {
      notify(`任务已创建，但启动失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  return (
    <section
      className={`task-derivation-card is-${command.kind}`}
      aria-label={teamMode ? "创建派生团队任务" : "创建派生辩论任务"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onClose();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <header className="task-derivation-header">
        <span>{teamMode ? <UsersThree size={16} weight="fill" /> : <Scales size={16} weight="fill" />}</span>
        <div>
          <b>{teamMode ? "以当前任务为背景创建团队" : "以当前任务为背景发起辩论"}</b>
          <small>命令不会发给当前 agent；新任务不会改变来源任务状态。</small>
        </div>
        <Button variant="icon" onClick={onClose} disabled={busy} aria-label="取消派生"><X size={14} /></Button>
      </header>

      <div className="task-derivation-body">
        {teamMode ? (
          <>
            <div className="task-derivation-role-grid">
              <TeamExecutorField role="lead" label="调度者执行器" choice={lead} types={leadTypes} profiles={leadProfiles} onChange={setLead} />
              <TeamExecutorField role="worker" label="执行者执行器" choice={worker} types={availableTypes} profiles={profiles} onChange={setWorker} />
              {reviewEnabled && <TeamExecutorField role="reviewer" label="审查者执行器" choice={reviewer} types={availableTypes} profiles={profiles} onChange={setReviewer} />}
            </div>
            <div className="task-derivation-review">
              <span>自动审查</span>
              <Toggle checked={reviewEnabled} onChange={setReviewEnabled} label={reviewEnabled ? "已开启" : "已关闭"} />
            </div>
            <label className="task-derivation-note">
              <span>可选附言</span>
              <textarea
                ref={noteRef}
                value={note}
                rows={3}
                onChange={(event) => {
                  noteTouched.current = true;
                  setNote(event.target.value);
                }}
                placeholder="补充执行重点、边界或验收要求…"
              />
            </label>
          </>
        ) : (
          <>
            <label className="task-derivation-note">
              <span>本次辩题</span>
              <textarea
                ref={topicRef}
                value={topic}
                rows={5}
                onChange={(event) => {
                  topicTouched.current = true;
                  setTopic(event.target.value);
                }}
                placeholder="让两个 AI 围绕什么展开对抗…"
              />
            </label>
            <div className="task-derivation-debate-grid">
              <ExecutorSelect label="辩手 A" value={debaterA} types={availableTypes} profiles={profiles} onChange={setDebaterA} />
              <ExecutorSelect label="辩手 B" value={debaterB} types={availableTypes} profiles={profiles} onChange={setDebaterB} />
              <label className="composer-field">
                <span>最多轮数</span>
                <select value={rounds} onChange={(event) => setRounds(event.target.value)}>
                  <option value="">不限</option>
                  {[3, 5, 10].map((value) => <option value={value} key={value}>{value} 轮</option>)}
                </select>
              </label>
              <label className="task-derivation-gate">
                <span>共识闸门</span>
                <Toggle checked={gate} onChange={setGate} label={gate ? "需要确认" : "自动结束"} />
              </label>
            </div>
            <p className="task-derivation-explainer">盲态开局 → 多轮对抗 → 给出结论（不改代码）。共识闸门开启时，收敛后会停下让你定夺。</p>
          </>
        )}
      </div>

      <footer className="task-derivation-footer">
        {(noExecutor || unavailableRole) && (
          <p className="task-derivation-warning">
            <Warning size={13} />
            {noExecutor
              ? "没有检测到可用的智能体 CLI，也没有已注册执行器，暂不能创建。"
              : `${unavailableRole}当前不可用，请更换执行器。`}
          </p>
        )}
        <WorktreeHint context={worktreeContext} worktree={worktree} />
        <div className="task-derivation-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消 Esc</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy && <SpinnerGap size={14} className="is-spinning" />}
            {busy ? "创建中…" : teamMode ? "创建并开干" : "创建并开辩"}
            {!busy && <kbd>⌘↵</kbd>}
          </Button>
        </div>
      </footer>
    </section>
  );
}

function WorktreeHint({
  context,
  worktree,
}: {
  context: WorktreeContext | null;
  worktree: ReturnType<typeof derivedWorktreeDefaults>;
}) {
  if (!context) return <span className="task-derivation-worktree"><TreeStructure size={12} />正在确认 worktree 基点…</span>;
  if (!context.isRepo) return <span className="task-derivation-worktree"><TreeStructure size={12} />项目不是 Git 仓库，将使用项目目录</span>;
  if (!worktree.on) {
    return (
      <span className="task-derivation-worktree">
        <TreeStructure size={12} />全局默认关闭 worktree，将在项目目录工作
      </span>
    );
  }
  if (worktree.inheritsSource && worktree.worktreeBase) {
    return (
      <span className="task-derivation-worktree" title={`从 ${worktree.worktreeBase} 创建新 worktree`}>
        <GitBranch size={12} />基于来源分支 {worktree.worktreeBase}
      </span>
    );
  }
  return (
    <span className="task-derivation-worktree">
      <TreeStructure size={12} />{worktree.sourceBranch ? "来源分支已不存在，将从项目当前 HEAD 创建" : "将从项目当前 HEAD 创建 worktree"}
    </span>
  );
}
