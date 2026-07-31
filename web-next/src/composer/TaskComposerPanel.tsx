import { useEffect, useMemo, useState } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  Priority,
  ProjectView,
  Task,
  TaskMode,
  TeamPresetConfig,
} from "@harness/shared";
import { DEFAULT_APP_SETTINGS, DEBATE_DEFAULTS } from "@harness/shared";
import { Paperclip, Play, Robot, Scales, UsersThree, X } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import {
  ComposerFields,
  profileType,
  selectedExecutorId,
} from "./ComposerFields.tsx";
import {
  emptyComposerExecutorConfigs,
  patchComposerExecutor,
  setComposerExecutorProfile,
  type ComposerExecutorRole,
} from "./executorOverrides.ts";

export type ComposerDraft = { body: string; attachments: string[]; noteIds?: string[] };

const MODES: { value: TaskMode; label: string; icon: typeof Robot }[] = [
  { value: "single", label: "单任务", icon: Robot },
  { value: "team", label: "团队", icon: UsersThree },
  { value: "debate", label: "辩论", icon: Scales },
];
const SLASHES = [
  { command: "/single", mode: "single" as const, label: "创建单任务" },
  { command: "/team", mode: "team" as const, label: "创建常驻团队" },
  { command: "/debate", mode: "debate" as const, label: "发起双智能体辩论" },
];

function defaultProfile(profiles: AgentExecutorProfile[], type: AgentType) {
  return profiles.find((profile) => profile.type === type && profile.isDefault)
    ?? profiles.find((profile) => profile.type === type);
}

export function TaskComposerPanel({
  project,
  groups,
  initialDraft,
  mode,
  onModeChange,
  onCancel,
  onCreated,
  notify,
}: {
  project: ProjectView;
  groups: Group[];
  initialDraft?: ComposerDraft | null;
  mode: TaskMode;
  onModeChange: (mode: TaskMode) => void;
  onCancel: () => void;
  onCreated: (task: Task, draft?: ComposerDraft | null) => void;
  notify: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [seedAttachments, setSeedAttachments] = useState(initialDraft?.attachments ?? []);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [executors, setExecutors] = useState(emptyComposerExecutorConfigs);
  const [debaterAProfile, setDebaterAProfile] = useState("");
  const [debaterBProfile, setDebaterBProfile] = useState("");
  const [review, setReview] = useState(true);
  const [rounds, setRounds] = useState("3");
  const [gate, setGate] = useState(true);
  const [priority, setPriority] = useState<Priority>("none");
  const [groupId, setGroupId] = useState("");
  const [useWorktree, setUseWorktree] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const uploads = useAttachments();

  useEffect(() => {
    Promise.all([
      api.agents(),
      api.settings(),
      project.health.isRepo
        ? api.projectBranches(project.id)
        : Promise.resolve({ branches: [], current: null }),
    ]).then(([agents, settings, refs]) => {
      setProfiles(agents);
      const claude = defaultProfile(agents, "claude") ?? agents[0];
      const codex = defaultProfile(agents, "codex")
        ?? agents.find((profile) => profile.id !== claude?.id)
        ?? claude;
      setExecutors((current) => ({
        ...current,
        single: { ...current.single, profile: claude?.id ?? "__type:claude" },
        lead: { ...current.lead, profile: claude?.id ?? "__type:claude" },
        worker: { ...current.worker, profile: codex?.id ?? "__type:codex" },
        reviewer: { ...current.reviewer, profile: codex?.id ?? "__type:codex" },
      }));
      setDebaterAProfile(claude?.id ?? "__type:claude");
      setDebaterBProfile(codex?.id ?? "__type:codex");
      setUseWorktree(project.health.isRepo && settings.worktreeDefault);
      setBranches(refs.branches);
      setBase(refs.current ?? "");
    }).catch((error) => notify(error instanceof Error ? error.message : "新建任务配置读取失败"));
  }, [notify, project.health.isRepo, project.id]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);

  const allAttachments = useMemo(
    () => [...new Set([...seedAttachments, ...uploads.attachments.map((item) => item.path)])],
    [seedAttachments, uploads.attachments],
  );
  const slashCandidates = useMemo(() => {
    const match = /^\s*(\/\S*)$/.exec(body);
    return match ? SLASHES.filter((item) => item.command.startsWith(match[1]!.toLowerCase())) : [];
  }, [body]);
  const applySlash = (nextMode: TaskMode, rest = "") => {
    onModeChange(nextMode);
    setBody(rest);
  };
  const changeBody = (value: string) => {
    const parsed = /^\s*\/(single|team|debate)\s+([\s\S]*)$/i.exec(value);
    if (parsed) applySlash(parsed[1]!.toLowerCase() as TaskMode, parsed[2] ?? "");
    else setBody(value);
  };
  const changeExecutor = (role: ComposerExecutorRole, profile: string) => {
    setExecutors((current) => setComposerExecutorProfile(current, role, profile));
  };
  const changeOverride = (role: ComposerExecutorRole, patch: { model?: string; effort?: string }) => {
    setExecutors((current) => patchComposerExecutor(current, role, patch));
  };

  const executorTypes = {
    single: profileType(profiles, executors.single.profile, "claude"),
    lead: profileType(profiles, executors.lead.profile, "claude"),
    worker: profileType(profiles, executors.worker.profile, "codex"),
    reviewer: profileType(
      profiles,
      executors.reviewer.profile,
      profileType(profiles, executors.worker.profile, "codex"),
    ),
  };
  const currentTeamConfig: TeamPresetConfig = {
    lead: executorTypes.lead,
    worker: executorTypes.worker,
    leadExecutorId: selectedExecutorId(executors.lead.profile),
    workerExecutorId: selectedExecutorId(executors.worker.profile),
    leadModel: executors.lead.model || null,
    leadReasoningEffort: executors.lead.effort || null,
    workerModel: executors.worker.model || null,
    workerReasoningEffort: executors.worker.effort || null,
    review,
    reviewerAgentType: executorTypes.reviewer,
    reviewerExecutorId: selectedExecutorId(executors.reviewer.profile),
    reviewerModel: executors.reviewer.model || null,
    reviewerReasoningEffort: executors.reviewer.effort || null,
  };
  const applyTeamPreset = (config: TeamPresetConfig) => {
    const profileValue = (candidate: string | null | undefined, type: AgentType) => {
      const candidateProfile = candidate ? profiles.find((profile) => profile.id === candidate) : null;
      return candidateProfile?.type === type ? candidate! : `__type:${type}`;
    };
    const reviewerType = config.reviewerAgentType ?? config.worker;
    setExecutors((current) => ({
      ...current,
      lead: {
        profile: profileValue(config.leadExecutorId, config.lead),
        model: config.leadModel ?? "",
        effort: config.leadReasoningEffort ?? "",
      },
      worker: {
        profile: profileValue(config.workerExecutorId, config.worker),
        model: config.workerModel ?? "",
        effort: config.workerReasoningEffort ?? "",
      },
      reviewer: {
        profile: profileValue(config.reviewerExecutorId, reviewerType),
        model: config.reviewerModel ?? "",
        effort: config.reviewerReasoningEffort ?? "",
      },
    }));
    setReview(config.review !== false);
  };
  const canSubmit = (mode === "debate" ? !!body.trim() : !!body.trim() || allAttachments.length > 0) && !busy;

  const submit = async (run: boolean) => {
    if (!canSubmit) return;
    setBusy(true);
    let task: Task;
    try {
      const explicitTitle = title.trim();
      const provisionalTitle = body.trim().split(/\r?\n/)[0]!.slice(0, 42)
        || (mode === "debate" ? "新建辩论" : "未命名任务");
      const common = {
        projectId: project.id,
        title: explicitTitle || provisionalTitle,
        autoTitle: !explicitTitle && mode === "single",
        priority,
        groupId: groupId || null,
      };
      if (mode === "debate") {
        task = await api.createTask({ ...common, mode, debate: {
          ...DEBATE_DEFAULTS,
          topic: body.trim(),
          debaterA: profileType(profiles, debaterAProfile, "claude"),
          debaterB: profileType(profiles, debaterBProfile, "codex"),
          debaterAExecutorId: selectedExecutorId(debaterAProfile),
          debaterBExecutorId: selectedExecutorId(debaterBProfile),
          maxRounds: rounds ? Math.max(1, Number(rounds) || 3) : null,
          gateG1: gate ? "on" : "off",
        } });
      } else if (mode === "team") {
        task = await api.createTask({
          ...common,
          body: body.trim(),
          attachments: allAttachments,
          mode,
          agentType: executorTypes.lead,
          useWorktree: project.health.isRepo && useWorktree,
          worktreeBase: useWorktree && base ? base : null,
          team: {
            lead: executorTypes.lead,
            worker: executorTypes.worker,
            leadExecutorId: selectedExecutorId(executors.lead.profile),
            workerExecutorId: selectedExecutorId(executors.worker.profile),
            leadModel: executors.lead.model || null,
            workerModel: executors.worker.model || null,
            leadReasoningEffort: executors.lead.effort || null,
            workerReasoningEffort: executors.worker.effort || null,
            review,
            reviewerAgentType: executorTypes.reviewer,
            reviewerExecutorId: selectedExecutorId(executors.reviewer.profile),
            reviewerModel: executors.reviewer.model || null,
            reviewerReasoningEffort: executors.reviewer.effort || null,
          },
        });
      } else {
        task = await api.createTask({
          ...common,
          body: body.trim(),
          attachments: allAttachments,
          mode,
          agentType: executorTypes.single,
          executorId: selectedExecutorId(executors.single.profile),
          model: executors.single.model || null,
          reasoningEffort: executors.single.effort || null,
          useWorktree: project.health.isRepo && useWorktree,
          worktreeBase: useWorktree && base ? base : null,
        });
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "任务创建失败");
      setBusy(false);
      return;
    }
    onCreated(task, initialDraft);
    if (!run) {
      notify("任务已创建");
      return;
    }
    try {
      await api.runTask(task.id);
      notify("任务已创建并启动");
    } catch (error) {
      notify(`任务已创建，但启动失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  return (
    <main className="task-composer-panel">
      <header className="composer-header">
        <span className="workspace-kind-chip">新建</span>
        <b>新建任务</b>
        <span>{project.name}</span>
        <Button variant="ghost" onClick={onCancel}>取消 Esc</Button>
      </header>
      <div className="composer-scroll">
        <div className="composer-inner">
          <div className="composer-tabs" role="tablist" aria-label="任务模式">
            {MODES.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === item.value}
                  key={item.value}
                  onClick={() => onModeChange(item.value)}
                >
                  <Icon size={15} />{item.label}
                </button>
              );
            })}
            <span>切换模式不清空正文</span>
          </div>
          <input
            className="composer-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="任务名称（可选；留空自动命名）"
          />
          <div className="composer-objective">
            <textarea
              autoFocus
              value={body}
              onChange={(event) => changeBody(event.target.value)}
              onPaste={uploads.onPaste}
              placeholder={mode === "team"
                ? "给调度者的目标…（可输入 /single 或 /debate 切换）"
                : mode === "debate"
                  ? "要讨论并形成结论的议题…"
                  : "描述要做什么…（可输入 /team 或 /debate）"}
              onKeyDown={(event) => {
                if (event.key === "Enter" && slashCandidates.length === 1 && body.trim() === slashCandidates[0]!.command) {
                  event.preventDefault();
                  applySlash(slashCandidates[0]!.mode);
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submit(true);
                }
              }}
            />
            {!!slashCandidates.length && (
              <div className="composer-slash-menu">
                <small>斜杠命令</small>
                {slashCandidates.map((item) => (
                  <button type="button" className="ui-selectable" key={item.command} onClick={() => applySlash(item.mode)}>
                    <b>{item.command}</b><span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {mode !== "debate" && (
            <>
              <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
              {!!seedAttachments.length && (
                <div className="composer-seed-attachments">
                  {seedAttachments.map((path) => {
                    const view = attachmentView(path);
                    return (
                      <span key={path}>
                        <Paperclip size={12} />{view.name}
                        <button type="button" onClick={() => setSeedAttachments((current) => current.filter((item) => item !== path))}>
                          <X size={10} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {mode === "debate" && allAttachments.length > 0 && (
            <p className="composer-warning">辩论配置不接收附件；附件仍保留，切回单任务或团队后会随任务提交。</p>
          )}
          <ComposerFields
            mode={mode}
            profiles={profiles}
            executors={executors}
            executorTypes={executorTypes}
            onExecutorChange={changeExecutor}
            onOverrideChange={changeOverride}
            currentTeamConfig={currentTeamConfig}
            onApplyTeamPreset={applyTeamPreset}
            notify={notify}
            debaterAProfile={debaterAProfile}
            debaterBProfile={debaterBProfile}
            onDebaterAChange={setDebaterAProfile}
            onDebaterBChange={setDebaterBProfile}
            review={review}
            onReviewChange={setReview}
            rounds={rounds}
            onRoundsChange={setRounds}
            gate={gate}
            onGateChange={setGate}
            isRepo={project.health.isRepo}
            useWorktree={useWorktree}
            onUseWorktreeChange={setUseWorktree}
            branches={branches}
            base={base}
            onBaseChange={setBase}
            groups={groups}
            groupId={groupId}
            onGroupChange={setGroupId}
            priority={priority}
            onPriorityChange={setPriority}
          />
        </div>
      </div>
      <footer className="composer-footer">
        <div>
          {mode !== "debate" && <AttachmentPicker addFiles={uploads.addFiles} disabled={busy} />}
          <span>
            <Paperclip size={13} />
            {mode === "debate" ? "辩论沿用执行器 Profile 的模型" : `${allAttachments.length} 个附件`} · ⌘↵ 创建并运行
          </span>
        </div>
        <Button disabled={!canSubmit} onClick={() => void submit(false)}>仅创建</Button>
        <Button variant="primary" disabled={!canSubmit} onClick={() => void submit(true)}>
          <Play size={12} weight="fill" />{busy ? "创建中…" : "创建并运行"}
        </Button>
      </footer>
    </main>
  );
}
