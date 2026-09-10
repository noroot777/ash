import { AssistantIcon } from "../assistant/AssistantIcon.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { DUET_DEFAULTS } from "@ash/shared/duet";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  GroupMode,
  ProjectView,
  Task,
  TaskMode,
  TaskWorkflowMode,
  TeamPresetConfig,
} from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import { ChatCircleDots } from "@phosphor-icons/react";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import {
  DEFAULT_CRON,
  defaultOnceTime,
  scheduleValidationError,
} from "../components/ScheduleControl.tsx";
import { Button } from "../components/ui.tsx";
import {
  isExecutorPickable,
  nothingRunnable,
  parseExecutorValue,
  teamExecutorCandidates,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { mergeSlashItems, slashToken, type SlashItem } from "../lib/useSkills.ts";
import { useSkills } from "../lib/useSkills.ts";
import { ComposerObjective } from "./ComposerObjective.tsx";
import { AttachmentPicker, UploadAttachmentList, uploadingLabel, useAttachments } from "../task-detail/Attachments.tsx";
import { ComposerFields } from "./ComposerFields.tsx";
import { ASH_SLASH_ITEMS, SLASHES } from "./composerParts.tsx";
import { useComposerDraft, type ComposerDraft } from "./composerDraft.ts";
import { useComposerWorkflow } from "./ComposerWorkflow.tsx";
import { ComposerLaunchControl, type LaunchMode } from "./ComposerLaunchControl.tsx";
import { CreateGroupDialog } from "../overlays/CreateEntityDialog.tsx";
import {
  emptyComposerExecutorConfigs,
  initialComposerExecutors,
  patchComposerExecutor,
  reconcileComposerExecutors,
  setComposerExecutorProfile,
  teamPresetExecutors,
  type ComposerExecutorRole,
} from "./executorOverrides.ts";
import { useComposerRunSummary } from "./composerRunSummary.ts";
export type { ComposerDraft };

export function TaskComposerPanel({
  project,
  groups,
  initialDraft,
  onDraftSeeded,
  mode,
  onModeChange,
  onChat,
  onAssistant,
  onCancel,
  onCreated,
  onCreateGroup,
  notify,
}: {
  project: ProjectView;
  groups: Group[];
  initialDraft?: ComposerDraft | null;
  // initialDraft 并进草稿之后回调一次，调用方据此把它摘掉（一次性投递，见 composerDraft.ts）。
  onDraftSeeded?: () => void;
  mode: TaskMode;
  onModeChange: (mode: TaskMode) => void;
  onChat?: () => void;
  onAssistant?: () => void;
  onCancel: () => void;
  onCreated: (task: Task, noteIds: string[]) => void;
  onCreateGroup: (name: string, mode: GroupMode) => Promise<Group>;
  notify: (message: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 正文与附件都存在全局草稿库里（见 composerDraft.ts）：这个面板一切走就整个卸载，
  // 存在组件 state 里等于「去看一眼别的任务」就把用户写的东西删了。
  const draft = useComposerDraft(project.id, initialDraft, onDraftSeeded);
  const body = draft.text;
  const setBody = draft.setText;
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [executors, setExecutors] = useState(emptyComposerExecutorConfigs);
  const [review, setReview] = useState(true);
  const [rounds, setRounds] = useState("3");
  const [gate, setGate] = useState(true);
  const [groupId, setGroupId] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [useWorktree, setUseWorktree] = useState(DEFAULT_APP_SETTINGS.worktreeDefault);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [launchMode, setLaunchMode] = useState<LaunchMode>("run");
  const [workflowMode, setWorkflowMode] = useState<TaskWorkflowMode>("free");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleCron, setScheduleCron] = useState(DEFAULT_CRON);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const workflow = useComposerWorkflow({
    project,
    isRepo: project.health.isRepo,
    notify,
    onWorkspace: setUseWorktree,
  });
  const uploads = useAttachments({
    value: draft.attachments,
    onChange: draft.setAttachments,
    pending: draft.pendingUploads,
    onPendingChange: draft.setPendingUploads,
  });
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
      setExecutors((current) => initialComposerExecutors(current, agents));
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
      workflow.setGlobalDefaultId(settings.defaultWorkflowId ?? "");
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
    () => [...new Set(uploads.attachments.map((item) => item.path))],
    [uploads.attachments],
  );
  const applySlash = (nextMode: TaskMode, rest = "") => {
    onModeChange(nextMode);
    setBody(rest);
  };
  // 只认 single/team/duet:敲 `/team 目标…` 直接切模式并把命令摘掉(它是指令不是内容)。
  // 技能走不到这里,所以 `/brandkit 做张图` 会原样留在正文里 —— 这正是要的。
  const changeBody = (value: string) => {
    const parsed = /^\s*\/(single|team|duet)\s+([\s\S]*)$/i.exec(value);
    if (parsed) applySlash(parsed[1]!.toLowerCase() as TaskMode, parsed[2] ?? "");
    else setBody(value);
  };
  const changeExecutor = (
    role: ComposerExecutorRole,
    profile: string,
    override: { model: string; effort: string },
  ) => {
    setExecutors((current) => setComposerExecutorProfile(current, role, profile, override));
  };
  const changeEffort = (role: ComposerExecutorRole, effort: string) => {
    setExecutors((current) => patchComposerExecutor(current, role, { effort }));
  };

  const singleExecutor = parseExecutorValue(
    executors.single.profile,
    profiles,
    { agentType: "claude", executorId: null },
  );
  const runStep = mode === "single" && workflowMode === "preset"
    ? workflow.def?.steps.find((step) => step.kind === "run") ?? null
    : null;
  const runStepParams = runStep?.p as
    { executorId: string | null; model: string | null; reasoningEffort: string | null } | undefined;
  const runStepProfile = runStepParams?.executorId
    ? profiles.find((profile) => profile.id === runStepParams.executorId) ?? null
    : null;
  const singleRun = runStepProfile
    ? {
      agentType: runStepProfile.type,
      executorId: runStepProfile.id,
      model: runStepParams?.model || null,
      reasoningEffort: runStepParams?.reasoningEffort || null,
    }
    : {
      agentType: singleExecutor.agentType,
      executorId: singleExecutor.executorId,
      model: executors.single.model || null,
      reasoningEffort: executors.single.effort || null,
    };
  const singleRunSummary = useComposerRunSummary(singleRun, profiles);
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
  const voiceAExecutor = parseExecutorValue(
    executors.voiceA.profile,
    profiles,
    { agentType: "claude", executorId: null },
  );
  const voiceBExecutor = parseExecutorValue(
    executors.voiceB.profile,
    profiles,
    { agentType: "codex", executorId: null },
  );
  // 正文最后是发给谁的,`/` 就补谁的技能:单任务给「让 AI 干活」那一站的执行器,
  // 团队给调度者。**讨论刻意不补**:同一段议题会同时发给两个不同的 CLI,只有一边
  // 装了的技能在另一边就是一句没人认的文本,那种「一半生效」比不提供更难查。
  const slashRun = mode === "team" ? leadExecutor : singleRun;
  const skills = useSkills({
    agentType: slashRun.agentType,
    projectId: project.id,
    enabled: mode !== "duet",
  });
  const slashQuery = slashDismissed ? null : slashToken(body);
  const slashCandidates = mergeSlashItems(ASH_SLASH_ITEMS, skills.skills, slashQuery);
  const slashSelected = Math.min(slashIndex, Math.max(0, slashCandidates.length - 1));
  const pickSlash = (item: SlashItem) => {
    const ash = SLASHES.find((entry) => entry.command === item.command);
    if (ash && item.kind === "ash") {
      applySlash(ash.mode);
      return;
    }
    // 技能只是补全:命令留在正文里，server 运行前据此注入 SKILL.md。
    setBody(`${item.command} `);
    setSlashIndex(0);
  };

  const executorTypes: Record<ComposerExecutorRole, AgentType> = {
    single: singleExecutor.agentType,
    lead: leadExecutor.agentType,
    worker: workerExecutor.agentType,
    reviewer: reviewerExecutor.agentType,
    voiceA: voiceAExecutor.agentType,
    voiceB: voiceBExecutor.agentType,
  };

  useEffect(() => {
    if (!profilesReady || detection.status === "loading") return;
    setExecutors((current) => reconcileComposerExecutors(current, {
      profiles,
      workerTypes,
      leadTypes,
      leadProfiles,
    }));
  }, [
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
    setExecutors((current) => teamPresetExecutors(current, config, profiles));
    setReview(config.review !== false);
  };
  const noExecutor = profilesReady && nothingRunnable(profiles);
  const unavailableRole = mode === "single"
    ? !isExecutorPickable(
      { agentType: singleRun.agentType, executorId: singleRun.executorId },
      workerTypes,
      profiles,
    ) ? "执行器" : null
    : mode === "duet"
      ? !isExecutorPickable(voiceAExecutor, workerTypes, profiles) ? "讨论者 A"
        : !isExecutorPickable(voiceBExecutor, workerTypes, profiles) ? "讨论者 B" : null
      : !isExecutorPickable(leadExecutor, leadTypes, leadProfiles) ? "调度者"
        : !isExecutorPickable(workerExecutor, workerTypes, profiles) ? "执行者"
          : review && !isExecutorPickable(reviewerExecutor, workerTypes, profiles) ? "审查者" : null;
  const roleBlocked = !!unavailableRole;
  const availabilityMessage = noExecutor
    ? "还没有已注册执行器，暂不能创建任务；请先到执行器设置注册本地 CLI。"
    : unavailableRole
      ? mode === "single"
        ? workflowMode === "free"
          ? "当前任务执行器未注册，请在输入框下方换一个。"
          : runStepParams?.executorId
            ? "起手式「让 AI 干活」那一站选的执行器未注册，请打开「工作方式」并展开编排换一个。"
            : "默认执行器未注册，请到执行器设置注册，或在起手式「让 AI 干活」那一站指定一个。"
        : `${unavailableRole}当前未注册或不支持该角色，请打开输入框下方的「${mode === "team" ? "团队配置" : "讨论者"}」更换执行器。`
      : mode === "team" && detection.status === "loading"
        ? "正在确认已注册调度者的常驻会话能力…"
        : mode === "team" && detection.status === "failed"
          ? "常驻能力检测失败；调度者候选仅保留系统已知支持的已注册类型。"
          : null;
  const availabilityTone = mode === "team" && detection.status === "loading" ? "loading" as const
    : noExecutor ? "empty" as const
      : availabilityMessage ? "warning" as const : null;
  const scheduleError = launchMode === "once" || launchMode === "cron"
    ? scheduleValidationError(launchMode, scheduleAt, scheduleCron)
    : null;
  // 有图还在传就先不放行：附件路径是上传成功才有的，这时候创建等于把刚粘的那张图
  // 悄悄扔掉。三种模式一视同仁——切走这个面板就没人接住在途的那张了。
  const waitingUploads = uploads.uploading;
  const canSubmit = (!!body.trim() || allAttachments.length > 0)
    && !busy && !noExecutor && !roleBlocked && !scheduleError && !waitingUploads;

  const changeLaunchMode = (next: LaunchMode) => {
    setLaunchMode(next);
    if (next === "once" && !scheduleAt) setScheduleAt(defaultOnceTime());
  };
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    let task: Task;
    try {
      const provisionalTitle = body.trim().split(/\r?\n/)[0]!.slice(0, 42)
        || (mode === "duet" ? "新建讨论" : "未命名任务");
      const common = {
        projectId: project.id,
        title: provisionalTitle,
        autoTitle: mode === "single",
        groupId: groupId || null,
        labels,
      };
      if (mode === "duet") {
        // 议题同时送 body 和 duet.topic：后端会把附件块分别拼在两者末尾（task-routes
        // 的 `row.body` / `scopedDuet`），于是讨论者的开场 prompt 和详情页顶部的「完整
        // 议题」看到的是同一份东西。只送 topic 的话，详情页那句 `task.body || topic`
        // 会拿到一段只剩附件路径、没有正文的 body。
        task = await api.createTask({
          ...common,
          body: body.trim(),
          attachments: allAttachments,
          mode,
          duet: {
            ...DUET_DEFAULTS,
            topic: body.trim(),
            voiceA: voiceAExecutor.agentType,
            voiceB: voiceBExecutor.agentType,
            voiceAExecutorId: voiceAExecutor.executorId,
            voiceBExecutorId: voiceBExecutor.executorId,
            voiceAModel: executors.voiceA.model || null,
            voiceAReasoningEffort: executors.voiceA.effort || null,
            voiceBModel: executors.voiceB.model || null,
            voiceBReasoningEffort: executors.voiceB.effort || null,
            maxRounds: rounds ? Math.max(1, Number(rounds) || 3) : null,
            gateG1: gate ? "on" : "off",
          },
        });
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
          agentType: singleRun.agentType,
          executorId: singleRun.executorId,
          model: singleRun.model,
          reasoningEffort: singleRun.reasoningEffort,
          useWorktree: project.health.isRepo && useWorktree,
          worktreeBase: useWorktree && base ? base : null,
          workflowMode,
          workflowId: workflowMode === "preset" ? workflow.workflowId : null,
          // 送的是**快照**而不是引用：面板上看到的那条线,原样落进这个任务。
          // workspace 以「任务选项」里的 worktree 开关为准 —— 那是同一件事的唯一开关,
          // 起手式里带的那个只负责在挑中它的时候把开关拨过去(见 pickWorkflow)。
          workflow: workflowMode === "preset" && workflow.def
            ? { ...workflow.def, workspace: project.health.isRepo && useWorktree ? "isolated" : "shared" }
            : null,
        });
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "任务创建失败");
      setBusy(false);
      return;
    }
    // 创建成功了草稿才丢：中途任何一步失败都原样留着，用户回到面板还能接着改。
    // 随手记回链的 id 也是这时候才交出去，交完连同正文一起清掉。
    const finishCreation = () => {
      const noteIds = draft.noteIds;
      setLabels([]);
      draft.clear();
      onCreated(task, noteIds);
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
    <main className="task-composer-panel is-studio">
      <header className="composer-header">
        <span className="workspace-kind-chip">新建</span>
        <b>新建任务</b>
        <span>{project.name}</span>
        {/* 草稿是「关掉也留着」的，所以必须有一个明写的丢弃口 —— 否则上一次没写完的
            东西会一直顶在新建框里，用户只能自己全选删。 */}
        {(!!body || allAttachments.length > 0 || uploads.uploading) && (
          <Button variant="ghost" onClick={() => { draft.clear(); textareaRef.current?.focus(); }}>清空草稿</Button>
        )}
        <Button variant="ghost" onClick={onCancel}>取消 Esc</Button>
      </header>
      <div className="composer-scroll">
        <div className="composer-inner">
          <ComposerFields
            mode={mode}
            singleRunSummary={singleRunSummary}
            profiles={profiles}
            workerTypes={workerTypes}
            leadTypes={leadTypes}
            leadProfiles={leadProfiles}
            executors={executors}
            executorTypes={executorTypes}
            availabilityMessage={availabilityMessage}
            availabilityTone={availabilityTone}
            onExecutorChange={changeExecutor}
            onEffortChange={changeEffort}
            currentTeamConfig={currentTeamConfig}
            onApplyTeamPreset={applyTeamPreset}
            notify={notify}
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
            labels={labels}
            onLabelsChange={setLabels}
            onCreateGroup={() => setGroupDialogOpen(true)}
            workflowSlot={mode === "single" && workflow.slot}
            workflowMode={workflowMode}
            onWorkflowModeChange={setWorkflowMode}
            onModeChange={onModeChange}
            extraModeTabs={<>{onChat && <button type="button" role="tab" aria-selected={false} disabled={uploads.uploading}
              onClick={() => onChat()}>
              <ChatCircleDots size={14} /><span>聊天</span>
            </button>}{onAssistant && <button type="button" role="tab" aria-label="ash 助手" aria-selected={false} disabled={uploads.uploading} onClick={onAssistant}>
              <AssistantIcon size={14} /><span>助手</span>
            </button>}</>}
            onPickStarter={(text, nextMode) => {
              changeBody(body.trim() ? body + "\n\n" + text : text);
              onModeChange(nextMode);
              textareaRef.current?.focus();
            }}
          >
          {(executorTools) => <div className="studio-card">
          <ComposerObjective body={body} mode={mode} textareaRef={textareaRef}
            onChange={(value) => { changeBody(value); setSlashIndex(0); setSlashDismissed(false); }}
            onPaste={uploads.onPaste} items={slashCandidates} selected={slashSelected} token={slashQuery}
            onSelect={setSlashIndex} onPick={pickSlash} onDismiss={() => setSlashDismissed(true)} onSubmit={() => void submit()} />
          <ImagePreviewGroup isolated>
            <UploadAttachmentList attachments={uploads.attachments} pending={uploads.pending}
              error={uploads.error} onRemove={uploads.remove} onCancel={uploads.cancel} />
          </ImagePreviewGroup>
          <footer className="composer-footer">
            <ComposerLaunchControl
              mode={launchMode}
              at={scheduleAt}
              cron={scheduleCron}
              busy={busy}
              canSubmit={canSubmit}
              error={scheduleError}
              onModeChange={changeLaunchMode}
              onAtChange={setScheduleAt}
              onCronChange={setScheduleCron}
              onSubmit={() => void submit()}
              attachmentTool={<AttachmentPicker addFiles={uploads.addFiles} disabled={busy} />}
              executorTools={executorTools}
            />
            {(uploads.uploading || allAttachments.length > 0 || scheduleError) && <div className="studio-input-status" role="status">
              {uploads.uploading ? `${uploadingLabel(uploads.pending)} · 传完才能创建`
                : scheduleError || `${allAttachments.length} 个附件`}
            </div>}
          </footer>
          </div>}
          </ComposerFields>
          <div className="studio-footnote"><span>/ 调用技能 · ⌘ / Ctrl + Enter 创建</span>{body.length > 0 && <span>{body.length} 字</span>}</div>
        </div>
      </div>
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
