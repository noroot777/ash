import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentExecutorProfile, AgentType, DebateConfig, Task, TeamConfig } from "@harness/shared";
import {
  DEBATE_DEFAULTS,
  DEFAULT_APP_SETTINGS,
  TEAM_DEFAULTS,
} from "@harness/shared";
import {
  GitBranch,
  Scales,
  SpinnerGap,
  TreeStructure,
  UsersThree,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { Button, Toggle } from "../components/ui.tsx";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import {
  executorValue,
  isExecutorPickable,
  nothingRunnable,
  parseExecutorValue,
  preferredExecutor,
  teamExecutorCandidates,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { useSkills } from "../lib/useSkills.ts";
import { useSlashCompletion } from "../lib/useSlashCompletion.ts";
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

const emptyChoice = (): ExecutorChoice => ({ profile: "", model: "", effort: "" });

function preferredSelection(
  types: AgentType[],
  profiles: AgentExecutorProfile[],
  preferred: AgentType,
  avoid?: AgentType,
): string {
  return executorValue(preferredExecutor(types, profiles, preferred, avoid)
    ?? { agentType: preferred, executorId: null });
}

function ExecutorField({
  label,
  choice,
  types,
  profiles,
  knownProfiles,
  fallbackType,
  onChange,
}: {
  label: string;
  choice: ExecutorChoice;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  knownProfiles: AgentExecutorProfile[];
  fallbackType: AgentType;
  /** 必须是 setState 本人：选执行器与写覆盖是同一轮里的两次更新，函数式更新才不会互相盖掉。 */
  onChange: Dispatch<SetStateAction<ExecutorChoice>>;
}) {
  return (
    <div className="task-derivation-role">
      <ExecutorPickerField
        label={label}
        value={choice.profile}
        types={types}
        profiles={profiles}
        knownProfiles={knownProfiles}
        fallbackType={fallbackType}
        override={choice}
        onChange={(profile) => onChange({ profile, model: "", effort: "" })}
        onOverrideChange={(patch) => onChange((current) => ({ ...current, ...patch }))}
      />
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
  const [profilesReady, setProfilesReady] = useState(false);
  const [executorsReady, setExecutorsReady] = useState(false);
  const [lead, setLead] = useState<ExecutorChoice>(emptyChoice);
  const [worker, setWorker] = useState<ExecutorChoice>(emptyChoice);
  const [reviewer, setReviewer] = useState<ExecutorChoice>(emptyChoice);
  const [debaterA, setDebaterA] = useState<ExecutorChoice>(emptyChoice);
  const [debaterB, setDebaterB] = useState<ExecutorChoice>(emptyChoice);
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
  const detection = useAgentAvailability();
  const {
    workerTypes: availableTypes,
    leadTypes,
    leadProfiles,
  } = useMemo(() => teamExecutorCandidates(detection, profiles), [detection, profiles]);

  useEffect(() => {
    let alive = true;
    setProfilesReady(false);
    api.agents().then((nextProfiles) => {
      if (alive) setProfiles(nextProfiles);
    }).catch((error) => {
      if (alive) notify(error instanceof Error ? error.message : "执行器配置读取失败");
    }).finally(() => {
      if (alive) setProfilesReady(true);
    });
    return () => { alive = false; };
  }, [notify]);

  useEffect(() => {
    if (!profilesReady || detection.status === "loading") return;
    if (!executorsReady) {
      const leadProfile = preferredSelection(leadTypes, leadProfiles, TEAM_DEFAULTS.lead);
      const leadType = parseExecutorValue(
        leadProfile,
        profiles,
        { agentType: TEAM_DEFAULTS.lead, executorId: null },
      ).agentType;
      const workerProfile = preferredSelection(availableTypes, profiles, "codex", leadType);
      const debateAProfile = preferredSelection(availableTypes, profiles, DEBATE_DEFAULTS.debaterA);
      const debateAType = parseExecutorValue(
        debateAProfile,
        profiles,
        { agentType: DEBATE_DEFAULTS.debaterA, executorId: null },
      ).agentType;
      setLead({ profile: leadProfile, model: "", effort: "" });
      setWorker({ profile: workerProfile, model: "", effort: "" });
      setReviewer({ profile: workerProfile, model: "", effort: "" });
      setDebaterA({ profile: debateAProfile, model: "", effort: "" });
      setDebaterB({
        profile: preferredSelection(availableTypes, profiles, DEBATE_DEFAULTS.debaterB, debateAType),
        model: "",
        effort: "",
      });
      setExecutorsReady(true);
      return;
    }
    const reconcileChoice = (
      current: ExecutorChoice,
      types: AgentType[],
      candidates: AgentExecutorProfile[],
      preferred: AgentType,
      avoid?: AgentType,
    ) => {
      const selection = parseExecutorValue(current.profile, profiles, { agentType: preferred, executorId: null });
      if (current.profile === executorValue(selection) && isExecutorPickable(selection, types, candidates)) {
        return current;
      }
      const fallback = preferredExecutor(types, candidates, preferred, avoid);
      return fallback ? { profile: executorValue(fallback), model: "", effort: "" } : current;
    };
    setLead((current) => reconcileChoice(current, leadTypes, leadProfiles, TEAM_DEFAULTS.lead));
    setWorker((current) => reconcileChoice(current, availableTypes, profiles, TEAM_DEFAULTS.worker));
    setReviewer((current) => reconcileChoice(current, availableTypes, profiles, TEAM_DEFAULTS.worker));
    setDebaterA((current) => reconcileChoice(current, availableTypes, profiles, DEBATE_DEFAULTS.debaterA));
    setDebaterB((current) => reconcileChoice(current, availableTypes, profiles, DEBATE_DEFAULTS.debaterB));
  }, [
    availableTypes,
    detection.status,
    executorsReady,
    leadProfiles,
    leadTypes,
    profiles,
    profilesReady,
  ]);

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

  // 附言最终进的是**调度者**的 prompt，所以技能按调度者那台执行器算。
  const leadSelection = parseExecutorValue(lead.profile, profiles, { agentType: TEAM_DEFAULTS.lead, executorId: null });
  const leadSkills = useSkills({
    agentType: leadSelection.agentType,
    projectId: task.projectId,
    executorId: leadSelection.executorId,
    enabled: teamMode,
  });
  const noteSlash = useSlashCompletion({
    value: note,
    setValue: (next) => { noteTouched.current = true; setNote(next); },
    skills: leadSkills.skills,
    remote: leadSkills.remote,
    disabled: !teamMode,
  });

  const worktree = derivedWorktreeDefaults(
    task,
    worktreeContext?.branches ?? [],
    !!worktreeContext?.isRepo,
    worktreeContext?.worktreeDefault ?? DEFAULT_APP_SETTINGS.worktreeDefault,
  );
  const noExecutor = executorsReady && nothingRunnable(profiles);
  const unavailableRole = !executorsReady ? null : teamMode
    ? !isExecutorPickable(
      parseExecutorValue(lead.profile, profiles, { agentType: TEAM_DEFAULTS.lead, executorId: null }),
      leadTypes,
      leadProfiles,
    )
      ? "调度者"
      : !isExecutorPickable(
        parseExecutorValue(worker.profile, profiles, { agentType: TEAM_DEFAULTS.worker, executorId: null }),
        availableTypes,
        profiles,
      )
        ? "执行者"
        : reviewEnabled && !isExecutorPickable(
          parseExecutorValue(reviewer.profile, profiles, { agentType: TEAM_DEFAULTS.worker, executorId: null }),
          availableTypes,
          profiles,
        )
          ? "审查者"
          : null
    : !isExecutorPickable(
      parseExecutorValue(debaterA.profile, profiles, { agentType: DEBATE_DEFAULTS.debaterA, executorId: null }),
      availableTypes,
      profiles,
    )
      ? "辩手 A"
      : !isExecutorPickable(
        parseExecutorValue(debaterB.profile, profiles, { agentType: DEBATE_DEFAULTS.debaterB, executorId: null }),
        availableTypes,
        profiles,
      )
        ? "辩手 B"
        : null;
  const roleBlocked = !!unavailableRole;
  const canSubmit = !busy && executorsReady && !!worktreeContext && !noExecutor && !roleBlocked
    && (teamMode || !!topic.trim());
  const availabilityMessage = noExecutor
    ? "还没有已注册执行器，暂不能创建。"
    : unavailableRole
      ? `${unavailableRole}当前未注册或不支持该角色，请更换执行器。`
      : teamMode && detection.status === "loading"
        ? "正在确认已注册调度者的常驻会话能力…"
        : teamMode && detection.status === "failed"
          ? "常驻能力检测失败；调度者候选仅保留系统已知支持的已注册类型。"
          : null;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    let created: Task;
    try {
      const sessions = await api.sessions(task.id);
      const body = buildTaskDerivationBody(task, sessions, command.kind, teamMode ? note : topic);
      if (teamMode) {
        const leadSelection = parseExecutorValue(
          lead.profile,
          profiles,
          { agentType: TEAM_DEFAULTS.lead, executorId: null },
        );
        const workerSelection = parseExecutorValue(
          worker.profile,
          profiles,
          { agentType: TEAM_DEFAULTS.worker, executorId: null },
        );
        const reviewerSelection = parseExecutorValue(
          reviewer.profile,
          profiles,
          { agentType: TEAM_DEFAULTS.worker, executorId: null },
        );
        const team: TeamConfig = {
          lead: leadSelection.agentType,
          worker: workerSelection.agentType,
          leadExecutorId: leadSelection.executorId,
          workerExecutorId: workerSelection.executorId,
          leadModel: lead.model || null,
          leadReasoningEffort: lead.effort || null,
          workerModel: worker.model || null,
          workerReasoningEffort: worker.effort || null,
          review: reviewEnabled,
          reviewerAgentType: reviewerSelection.agentType,
          reviewerExecutorId: reviewerSelection.executorId,
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
        const debaterASelection = parseExecutorValue(
          debaterA.profile,
          profiles,
          { agentType: DEBATE_DEFAULTS.debaterA, executorId: null },
        );
        const debaterBSelection = parseExecutorValue(
          debaterB.profile,
          profiles,
          { agentType: DEBATE_DEFAULTS.debaterB, executorId: null },
        );
        const debate: DebateConfig = {
          ...DEBATE_DEFAULTS,
          topic: topic.trim(),
          debaterA: debaterASelection.agentType,
          debaterB: debaterBSelection.agentType,
          debaterAExecutorId: debaterASelection.executorId,
          debaterBExecutorId: debaterBSelection.executorId,
          debaterAModel: debaterA.model || null,
          debaterAReasoningEffort: debaterA.effort || null,
          debaterBModel: debaterB.model || null,
          debaterBReasoningEffort: debaterB.effort || null,
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
              <ExecutorField label="调度者执行器" choice={lead} types={leadTypes} profiles={leadProfiles} knownProfiles={profiles} fallbackType={TEAM_DEFAULTS.lead} onChange={setLead} />
              <ExecutorField label="执行者执行器" choice={worker} types={availableTypes} profiles={profiles} knownProfiles={profiles} fallbackType={TEAM_DEFAULTS.worker} onChange={setWorker} />
              {reviewEnabled && <ExecutorField label="审查者执行器" choice={reviewer} types={availableTypes} profiles={profiles} knownProfiles={profiles} fallbackType={TEAM_DEFAULTS.worker} onChange={setReviewer} />}
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
                  noteSlash.onValueChange();
                }}
                onKeyDown={(event) => { noteSlash.onKeyDown(event); }}
                placeholder="补充执行重点、边界或验收要求…"
              />
              {noteSlash.open && (
                <SlashMenu
                  className="task-derivation-slash-menu"
                  ariaLabel="技能补全"
                  hint={leadSkills.remote
                    ? "远端(ssh)调度者的技能装在那头，本机列不出来"
                    : "已装技能 · 回车补全，原样写进调度者的 prompt"}
                  items={noteSlash.items}
                  selectedIndex={noteSlash.selectedIndex}
                  emptyText="这台调度者跑在 ssh 远端，技能清单只有它自己看得见——照常写 /名字，它认得。"
                  onHover={noteSlash.setIndex}
                  onPick={noteSlash.pick}
                />
              )}
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
              <ExecutorField label="辩手 A" choice={debaterA} types={availableTypes} profiles={profiles} knownProfiles={profiles} fallbackType={DEBATE_DEFAULTS.debaterA} onChange={setDebaterA} />
              <ExecutorField label="辩手 B" choice={debaterB} types={availableTypes} profiles={profiles} knownProfiles={profiles} fallbackType={DEBATE_DEFAULTS.debaterB} onChange={setDebaterB} />
              <div className="composer-field">
                <span>最多轮数</span>
                <Dropdown
                  label="最多轮数"
                  value={rounds}
                  options={[
                    { value: "", label: "不限" },
                    ...[3, 5, 10].map((value) => ({ value: String(value), label: `${value} 轮` })),
                  ]}
                  filterable={false}
                  placeholder="不限"
                  onChange={setRounds}
                />
              </div>
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
        {availabilityMessage && (
          <p className="task-derivation-warning">
            <Warning size={13} />
            {availabilityMessage}
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
