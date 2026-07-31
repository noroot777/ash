import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  GroupMode,
  Priority,
  ProjectView,
  Task,
  TaskMode,
  TeamPresetConfig,
} from "@harness/shared";
import { DEFAULT_APP_SETTINGS, DEBATE_DEFAULTS } from "@harness/shared";
import { Paperclip, Robot, Scales, UsersThree, X } from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import {
  DEFAULT_CRON,
  defaultOnceTime,
  scheduleValidationError,
} from "../components/ScheduleControl.tsx";
import { Button } from "../components/ui.tsx";
import {
  executorValue,
  isExecutorPickable,
  nothingRunnable,
  parseExecutorValue,
  preferredExecutor,
  teamExecutorCandidates,
  useAgentAvailability,
  type ExecutorSelection,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import { ComposerFields } from "./ComposerFields.tsx";
import { ComposerLaunchControl, type LaunchMode } from "./ComposerLaunchControl.tsx";
import { CreateGroupDialog } from "../overlays/CreateEntityDialog.tsx";
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

function SeedAttachmentList({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  if (!paths.length) return null;
  return (
    <div className="composer-seed-attachments">
      {paths.map((path) => {
        const view = attachmentView(path);
        return (
          <div className="composer-seed-attachment" key={path}>
            {view.image && view.url ? <PreviewableImage src={view.url} alt={view.name} /> : <Paperclip size={14} aria-hidden="true" />}
            <span>{view.name}</span>
            <button type="button" onClick={() => onRemove(path)} aria-label={`移除 ${view.name}`}><X size={10} aria-hidden="true" /></button>
          </div>
        );
      })}
    </div>
  );
}

export function TaskComposerPanel({
  project,
  groups,
  initialDraft,
  mode,
  onModeChange,
  onCancel,
  onCreated,
  onCreateGroup,
  notify,
}: {
  project: ProjectView;
  groups: Group[];
  initialDraft?: ComposerDraft | null;
  mode: TaskMode;
  onModeChange: (mode: TaskMode) => void;
  onCancel: () => void;
  onCreated: (task: Task, draft: ComposerDraft | null | undefined, keepOpen: boolean) => void;
  onCreateGroup: (name: string, mode: GroupMode) => Promise<Group>;
  notify: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [seedAttachments, setSeedAttachments] = useState(initialDraft?.attachments ?? []);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [executors, setExecutors] = useState(emptyComposerExecutorConfigs);
  const [debaterAProfile, setDebaterAProfile] = useState("");
  const [debaterBProfile, setDebaterBProfile] = useState("");
  const [review, setReview] = useState(true);
  const [rounds, setRounds] = useState("3");
  const [gate, setGate] = useState(true);
  const [priority, setPriority] = useState<Priority>("none");
  const [groupId, setGroupId] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [useWorktree, setUseWorktree] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [launchMode, setLaunchMode] = useState<LaunchMode>("run");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleCron, setScheduleCron] = useState(DEFAULT_CRON);
  const [keepOpen, setKeepOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const uploads = useAttachments();
  const detection = useAgentAvailability();
  const { workerTypes, leadTypes, leadProfiles } = useMemo(
    () => teamExecutorCandidates(detection, profiles),
    [detection, profiles],
  );

  useEffect(() => {
    let alive = true;
    setProfilesReady(false);
    api.agents().then((agents) => {
      if (!alive) return;
      setProfiles(agents);
      const claude = defaultProfile(agents, "claude") ?? agents[0];
      const codex = defaultProfile(agents, "codex")
        ?? agents.find((profile) => profile.id !== claude?.id)
        ?? claude;
      const claudeValue = executorValue(claude
        ? { agentType: claude.type, executorId: claude.id }
        : { agentType: "claude", executorId: null });
      const codexValue = executorValue(codex
        ? { agentType: codex.type, executorId: codex.id }
        : { agentType: "codex", executorId: null });
      setExecutors((current) => ({
        ...current,
        single: { ...current.single, profile: claudeValue },
        lead: { ...current.lead, profile: claudeValue },
        worker: { ...current.worker, profile: codexValue },
        reviewer: { ...current.reviewer, profile: codexValue },
      }));
      setDebaterAProfile(claudeValue);
      setDebaterBProfile(codexValue);
    }).catch((error) => {
      if (alive) notify(error instanceof Error ? error.message : "执行器配置读取失败");
    }).finally(() => {
      if (alive) setProfilesReady(true);
    });
    Promise.all([
      api.settings(),
      project.health.isRepo
        ? api.projectBranches(project.id)
        : Promise.resolve({ branches: [], current: null }),
    ]).then(([settings, refs]) => {
      if (!alive) return;
      setUseWorktree(project.health.isRepo && settings.worktreeDefault);
      setBranches(refs.branches);
      setBase(refs.current ?? "");
    }).catch((error) => {
      if (alive) notify(error instanceof Error ? error.message : "新建任务配置读取失败");
    });
    return () => { alive = false; };
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

  const singleExecutor = parseExecutorValue(
    executors.single.profile,
    profiles,
    { agentType: "claude", executorId: null },
  );
  const leadExecutor = parseExecutorValue(
    executors.lead.profile,
    profiles,
    { agentType: "claude", executorId: null },
  );
  const workerExecutor = parseExecutorValue(
    executors.worker.profile,
    profiles,
    { agentType: "codex", executorId: null },
  );
  const reviewerExecutor = parseExecutorValue(
    executors.reviewer.profile,
    profiles,
    { agentType: workerExecutor.agentType, executorId: null },
  );
  const debaterAExecutor = parseExecutorValue(
    debaterAProfile,
    profiles,
    { agentType: "claude", executorId: null },
  );
  const debaterBExecutor = parseExecutorValue(
    debaterBProfile,
    profiles,
    { agentType: "codex", executorId: null },
  );
  const executorTypes = {
    single: singleExecutor.agentType,
    lead: leadExecutor.agentType,
    worker: workerExecutor.agentType,
    reviewer: reviewerExecutor.agentType,
  };

  useEffect(() => {
    if (!profilesReady || detection.status === "loading") return;
    const reconcile = (
      value: string,
      types: AgentType[],
      candidates: AgentExecutorProfile[],
      preferred: AgentType,
      avoid?: AgentType,
    ): ExecutorSelection | null => {
      const current = parseExecutorValue(value, profiles, { agentType: preferred, executorId: null });
      return value && isExecutorPickable(current, types, candidates)
        ? current
        : preferredExecutor(types, candidates, preferred, avoid);
    };
    setExecutors((current) => {
      const single = reconcile(current.single.profile, workerTypes, profiles, "claude");
      const lead = reconcile(current.lead.profile, leadTypes, leadProfiles, "claude");
      const worker = reconcile(current.worker.profile, workerTypes, profiles, "codex", lead?.agentType);
      const reviewer = reconcile(
        current.reviewer.profile,
        workerTypes,
        profiles,
        worker?.agentType ?? "codex",
      ) ?? worker;
      let changed = false;
      const next = { ...current };
      for (const [role, selection] of Object.entries({ single, lead, worker, reviewer }) as [ComposerExecutorRole, ExecutorSelection | null][]) {
        if (!selection || current[role].profile === executorValue(selection)) continue;
        next[role] = { profile: executorValue(selection), model: "", effort: "" };
        changed = true;
      }
      return changed ? next : current;
    });
    const nextDebaterA = reconcile(debaterAProfile, workerTypes, profiles, "claude");
    const nextDebaterB = reconcile(
      debaterBProfile,
      workerTypes,
      profiles,
      "codex",
      nextDebaterA?.agentType,
    );
    if (nextDebaterA && debaterAProfile !== executorValue(nextDebaterA)) {
      setDebaterAProfile(executorValue(nextDebaterA));
    }
    if (nextDebaterB && debaterBProfile !== executorValue(nextDebaterB)) {
      setDebaterBProfile(executorValue(nextDebaterB));
    }
  }, [
    debaterAProfile,
    debaterBProfile,
    detection.status,
    leadProfiles,
    leadTypes,
    profiles,
    profilesReady,
    workerTypes,
  ]);

  const currentTeamConfig: TeamPresetConfig = {
    lead: executorTypes.lead,
    worker: executorTypes.worker,
    leadExecutorId: leadExecutor.executorId,
    workerExecutorId: workerExecutor.executorId,
    leadModel: executors.lead.model || null,
    leadReasoningEffort: executors.lead.effort || null,
    workerModel: executors.worker.model || null,
    workerReasoningEffort: executors.worker.effort || null,
    review,
    reviewerAgentType: executorTypes.reviewer,
    reviewerExecutorId: reviewerExecutor.executorId,
    reviewerModel: executors.reviewer.model || null,
    reviewerReasoningEffort: executors.reviewer.effort || null,
  };
  const applyTeamPreset = (config: TeamPresetConfig) => {
    const profileValue = (candidate: string | null | undefined, type: AgentType) => {
      const candidateProfile = candidate ? profiles.find((profile) => profile.id === candidate) : null;
      return executorValue(candidateProfile?.type === type
        ? { agentType: type, executorId: candidate! }
        : { agentType: type, executorId: null });
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
  const noExecutor = profilesReady && nothingRunnable(detection, profiles);
  const unavailableRole = mode === "single"
    ? !isExecutorPickable(singleExecutor, workerTypes, profiles) ? "执行器" : null
    : mode === "debate"
      ? !isExecutorPickable(debaterAExecutor, workerTypes, profiles) ? "辩手 A"
        : !isExecutorPickable(debaterBExecutor, workerTypes, profiles) ? "辩手 B" : null
      : !isExecutorPickable(leadExecutor, leadTypes, leadProfiles) ? "调度者"
        : !isExecutorPickable(workerExecutor, workerTypes, profiles) ? "执行者"
          : review && !isExecutorPickable(reviewerExecutor, workerTypes, profiles) ? "审查者" : null;
  const roleBlocked = !!unavailableRole
    && (detection.status === "ready" || unavailableRole === "调度者");
  const availabilityMessage = detection.status === "loading"
    ? "正在检测本机智能体；检测完成前暂按全量类型显示。"
    : detection.status === "failed" && roleBlocked
      ? "检测失败时仍不能选择不支持常驻会话的团队调度者，请改选 resident 执行器。"
      : detection.status === "failed"
      ? "本地智能体检测失败；本次不拦截提交，请确认所选 CLI 已安装或使用已注册 Profile。"
      : noExecutor
        ? "没有检测到可用的智能体 CLI，也没有已注册执行器，暂不能创建任务。"
        : unavailableRole
          ? `${unavailableRole}当前不可运行，请改选已安装的类型或已注册 Profile。`
          : null;
  const availabilityTone = detection.status === "loading" ? "loading" as const
    : noExecutor ? "empty" as const
      : availabilityMessage ? "warning" as const : null;
  const scheduleError = launchMode === "once" || launchMode === "cron"
    ? scheduleValidationError(launchMode, scheduleAt, scheduleCron)
    : null;
  const canSubmit = (mode === "debate" ? !!body.trim() : !!body.trim() || allAttachments.length > 0)
    && !busy && !noExecutor && !roleBlocked && !scheduleError;

  const changeLaunchMode = (next: LaunchMode) => {
    setLaunchMode(next);
    if (next === "once" && !scheduleAt) setScheduleAt(defaultOnceTime());
  };

  const submit = async () => {
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
        labels,
      };
      if (mode === "debate") {
        task = await api.createTask({ ...common, mode, debate: {
          ...DEBATE_DEFAULTS,
          topic: body.trim(),
          debaterA: debaterAExecutor.agentType,
          debaterB: debaterBExecutor.agentType,
          debaterAExecutorId: debaterAExecutor.executorId,
          debaterBExecutorId: debaterBExecutor.executorId,
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
            leadExecutorId: leadExecutor.executorId,
            workerExecutorId: workerExecutor.executorId,
            leadModel: executors.lead.model || null,
            workerModel: executors.worker.model || null,
            leadReasoningEffort: executors.lead.effort || null,
            workerReasoningEffort: executors.worker.effort || null,
            review,
            reviewerAgentType: executorTypes.reviewer,
            reviewerExecutorId: reviewerExecutor.executorId,
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
          executorId: singleExecutor.executorId,
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
    const finishCreation = () => {
      setLabels([]);
      onCreated(task, initialDraft, keepOpen);
      if (!keepOpen) return;
      setTitle("");
      setBody("");
      setSeedAttachments([]);
      uploads.clear();
      if (launchMode === "once") setScheduleAt(defaultOnceTime());
      setBusy(false);
      window.requestAnimationFrame(() => objectiveRef.current?.focus());
    };
    if (launchMode === "create") {
      finishCreation();
      notify("任务已创建");
      return;
    }
    let launchError: unknown = null;
    try {
      if (launchMode === "run") await api.runTask(task.id);
      else if (launchMode === "once") {
        await api.setSchedule(task.id, { kind: "once", at: new Date(scheduleAt).toISOString(), cron: null });
      } else {
        await api.setSchedule(task.id, { kind: "cron", at: null, cron: scheduleCron.trim() });
      }
    } catch (error) {
      launchError = error;
    }
    finishCreation();
    if (launchError) {
      notify(`任务已创建，但${launchMode === "run" ? "启动" : "定时设置"}失败：${launchError instanceof Error ? launchError.message : "未知错误"}`);
      return;
    }
    notify(launchMode === "run"
      ? "任务已创建并启动"
      : launchMode === "once"
        ? "任务已创建，已设置一次性定时"
        : "任务已创建，已设置 Cron 定时");
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
              ref={objectiveRef}
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
                  void submit();
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
            <ImagePreviewGroup isolated>
              <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
              <SeedAttachmentList
                paths={seedAttachments}
                onRemove={(path) => setSeedAttachments((current) => current.filter((item) => item !== path))}
              />
            </ImagePreviewGroup>
          )}
          {mode === "debate" && allAttachments.length > 0 && (
            <p className="composer-warning">辩论配置不接收附件；附件仍保留，切回单任务或团队后会随任务提交。</p>
          )}
          <ComposerFields
            mode={mode}
            profiles={profiles}
            workerTypes={workerTypes}
            leadTypes={leadTypes}
            leadProfiles={leadProfiles}
            executors={executors}
            executorTypes={executorTypes}
            availabilityMessage={availabilityMessage}
            availabilityTone={availabilityTone}
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
            labels={labels}
            onLabelsChange={setLabels}
            onCreateGroup={() => setGroupDialogOpen(true)}
          />
        </div>
      </div>
      <footer className="composer-footer">
        <div>
          {mode !== "debate" && <AttachmentPicker addFiles={uploads.addFiles} disabled={busy} />}
          <span>
            <Paperclip size={13} />
            {mode === "debate" ? "辩论沿用执行器 Profile 的模型" : `${allAttachments.length} 个附件`} · ⌘↵ 按当前启动方式创建
          </span>
        </div>
        <ComposerLaunchControl
          mode={launchMode}
          at={scheduleAt}
          cron={scheduleCron}
          busy={busy}
          canSubmit={canSubmit}
          keepOpen={keepOpen}
          error={scheduleError}
          onModeChange={changeLaunchMode}
          onAtChange={setScheduleAt}
          onCronChange={setScheduleCron}
          onKeepOpenChange={setKeepOpen}
          onSubmit={() => void submit()}
        />
      </footer>
      {groupDialogOpen && <CreateGroupDialog
        onClose={() => setGroupDialogOpen(false)}
        onCreate={async (name, groupMode) => {
          try {
            const created = await onCreateGroup(name, groupMode);
            setGroupId(created.id);
            setGroupDialogOpen(false);
            notify("分组已创建并选中");
          } catch (error) {
            notify(error instanceof Error ? error.message : "分组创建失败");
          }
        }}
      />}
    </main>
  );
}
