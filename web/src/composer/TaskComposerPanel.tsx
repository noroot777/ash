import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  Group,
  GroupMode,
  ProjectView,
  Task,
  TaskListItem,
} from "@navi/shared";
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
  registeredAgentTypes,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { mergeSlashItems, slashPickAt, slashQuery, type SlashItem } from "../lib/useSkills.ts";
import { useCaret } from "../lib/useCaret.ts";
import { useSkills } from "../lib/useSkills.ts";
import { ComposerObjective } from "./ComposerObjective.tsx";
import { InputMentionMenu } from "../components/MentionMenu.tsx";
import { useMention } from "../components/useMention.ts";
import { AttachmentPicker, UploadAttachmentList, uploadingLabel, useAttachments } from "../task-detail/Attachments.tsx";
import { ComposerFields } from "./ComposerFields.tsx";
import { ComposerCallCapsule, ComposerCallDock, useComposerCall } from "./ComposerCall.tsx";
import { composerOpening } from "./composerOpening.ts";
import { CALL_COPY, discussPeople } from "../task-detail/replyCall.ts";
import { useComposerDraft, type ComposerDraft } from "./composerDraft.ts";
import { settleCreatedTask } from "./settleCreatedTask.ts";
import { composerTaskInput } from "./composerTaskInput.ts";
import { ComposerLaunchControl, type LaunchMode } from "./ComposerLaunchControl.tsx";
import { useQueueAfter } from "./useQueueAfter.tsx";
import { usePrerequisitePicks } from "./usePrerequisitePicks.tsx";
import { CreateGroupDialog } from "../overlays/CreateEntityDialog.tsx";
import { useComposerExecutor } from "./useComposerExecutor.ts";
import { ComposerForkContext } from "./ComposerForkContext.tsx";
import { ComposerExpand } from "./ComposerExpand.tsx";
import { ComposerShortcutHelp } from "./ComposerShortcutHelp.tsx";
import { forkBodyProblem } from "../task-detail/conversationFork.ts";
import { useComposerBranches } from "./useComposerBranches.ts";
export type { ComposerDraft };

/**
 * 首页形态：有项目、没选任务时主区就是这张卡。和新建面板是**同一个组件
 * 实例**——WorkspaceShell 在两处用同一个 key 挂它，点「全部选项」展开成新建面板时，
 * 写到一半的正文、附件、选好的执行器和工作目录都原样带过去。
 */
export type ComposerHome = {
  title: string;
  /** 标题后面那一小段灰字（任务模式下写「新建到哪个项目」）。 */
  detail?: string;
  count?: string;
  /** 「全部选项」：展开成新建面板。 */
  onExpand: () => void;
  /** 卡片下面那一块（等你处理）。 */
  below?: ReactNode;
};

export function TaskComposerPanel({
  project,
  groups,
  tasks = [],
  initialDraft,
  onDraftSeeded,
  onCancel,
  onCreated,
  onTasksSynced,
  onCreateGroup,
  onProjectUpdated,
  notify,
  home,
}: {
  project: ProjectView;
  groups: Group[];
  /** 全量任务列表(「创建并排队」的目标候选,按本项目过滤)。不传按无候选处理。 */
  tasks?: TaskListItem[];
  initialDraft?: ComposerDraft | null;
  // initialDraft 并进草稿之后回调一次，调用方据此把它摘掉（一次性投递，见 composerDraft.ts）。
  onDraftSeeded?: () => void;
  onCancel: () => void;
  /**
   * 创建(含排队)完成的回写。ownsComposer=false 表示发起提交的那份面板已经卸载——
   * 用户等待期间切走、可能又开了新面板:上层此时**不得**收起当前面板(那是别人的),
   * 其余回写(列表插入/守卫判废)照常(第 9 轮审查)。
   */
  onCreated: (task: Task, noteIds: string[], ownsComposer: boolean) => void;
  /** 入队响应波及的全体成员快照(含前驱)整批上交,由上层按 updatedAt 合并进任务列表。 */
  onTasksSynced?: (tasks: Task[]) => void;
  onCreateGroup: (name: string, mode: GroupMode) => Promise<Group>;
  /** 「设为本项目默认」写回之后，把新的项目行交回上层 —— 否则下次打开这块面板还按旧值预填。 */
  onProjectUpdated: (project: ProjectView) => void;
  notify: (message: string) => void;
  home?: ComposerHome;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 提交是异步的,完成时这份面板可能早已卸载(用户点了别的任务/删了刚建的任务再新开
  // 面板)。收尾动作要按挂载状态分流,StrictMode 下 effect 会 mount→cleanup→mount,
  // 所以置 true 必须写在 effect 体里而不是初始值。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // 正文与附件都存在全局草稿库里（见 composerDraft.ts）：这个面板一切走就整个卸载，
  // 存在组件 state 里等于「去看一眼别的任务」就把用户写的东西删了。
  const draft = useComposerDraft(project.id, initialDraft, onDraftSeeded);
  const body = draft.text;
  const setBody = draft.setText;
  const fork = initialDraft?.fork;
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  // 注册表读成功了才算 ready；读失败另记原因（只拦发送，不拿空列表当「谁都没有」去改任何选择或叫的人）。
  const [profilesReady, setProfilesReady] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [ownUseWorktree, setOwnUseWorktree] = useState(project.useWorktreeDefault);
  // 项目那一份单独留着（而不是只拿它当初值）：工作目录弹层要能说出「你这次跟本项目的默认
  // 不一样」，并给一颗把本次选择写回项目的按钮 —— 否则用户只能每建一个任务翻一次开关。
  // 用本地 state 而不是直接读 project.useWorktreeDefault：`project` 由上层持有，写回之后
  // 它什么时候刷新不归这里管，弹层上的提示不能等它。
  const [worktreeDefault, setWorktreeDefault] = useState(project.useWorktreeDefault);
  const [savingWorktreeDefault, setSavingWorktreeDefault] = useState(false);
  const { branches, remoteBranches, refreshRemotes, fetchingRemotes, base, setBase, automaticLabel, switching, isSwitching } = useComposerBranches(project, notify);
  const [busy, setBusy] = useState(false);
  // 「创建并等前置」记在草稿里（已选的前置跟正文同生共死）：草稿里有它，启动方式就是它。
  const [otherLaunchMode, setLaunchMode] = useState<LaunchMode>("run");
  const launchMode: LaunchMode = draft.prerequisites ? "prerequisites" : otherLaunchMode;
  // 「创建并等前置」时工作目录跟已选的前置存在同一份草稿里：前置能不能选要拿它判，恢复时两样一起回来。
  const useWorktree = draft.prerequisites ? draft.prerequisites.useWorktree : ownUseWorktree;
  const setUseWorktree = (value: boolean) => {
    setOwnUseWorktree(value);
    draft.setPrerequisites((current) => current && { ...current, useWorktree: value });
  };
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleCron, setScheduleCron] = useState(DEFAULT_CRON);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // 「创建并排队」(launchMode="queue"):目标选择、分组联动、入队动作都在这个 hook 里。
  const queueAfter = useQueueAfter({ tasks, groups, projectId: project.id, notify, onFollowGroup: setGroupId });
  const prerequisitePicks = usePrerequisitePicks({ draft, projectId: project.id, useWorktree: project.health.isRepo && useWorktree,
    groups, enabled: launchMode === "prerequisites", notify });
  const uploads = useAttachments({
    value: draft.attachments,
    onChange: draft.setAttachments,
    pending: draft.pendingUploads,
    onPendingChange: draft.setPendingUploads,
  });
  const types = useMemo(() => registeredAgentTypes(profiles), [profiles]);

  useEffect(() => {
    let alive = true;
    setProfilesReady(false);
    setProfilesError(null);
    api.agents().then((agents) => {
      if (!alive) return;
      setProfiles(agents);
      setProfilesReady(true);
    }).catch((error) => {
      if (!alive) return;
      const message = error instanceof Error ? error.message : "执行器配置读取失败";
      setProfilesError(message);
      notify(message);
    });
    // worktree 默认值住在项目行上（随 project 一起到手），不必等任何请求；换项目时这个
    // effect 会重跑，于是选择跟着新项目走而不是留着上一个项目的。
    setOwnUseWorktree(project.health.isRepo && project.useWorktreeDefault);
    setWorktreeDefault(project.useWorktreeDefault);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify, project.health.isRepo, project.id]);

  // 首页不抢焦点：J/K、C 这几颗单键在输入框里按不出来，一进首页就把光标塞进框里等于把
  // 键盘导航关掉。展开成新建面板时才把光标放进去；从面板退回首页时把它拿出来。
  const isHome = !!home;
  useEffect(() => {
    if (isHome) textareaRef.current?.blur();
    else textareaRef.current?.focus({ preventScroll: true });
  }, [isHome]);
  useEffect(() => {
    if (isHome) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [isHome, onCancel]);
  const allAttachments = useMemo(
    () => [...new Set([...uploads.attachments.map((item) => item.path), ...(fork?.attachmentPaths ?? [])])],
    [uploads.attachments, fork],
  );
  // 把「这次的工作目录选择」写回**本项目**的默认值。文案里那句「设置 → 项目设置 → 工作
  // 目录」指的是同一颗开关，改到哪儿去后面还找得着。
  const saveWorktreeDefault = async () => {
    if (savingWorktreeDefault || useWorktree === worktreeDefault) return;
    setSavingWorktreeDefault(true);
    try {
      const updated = await api.updateProject(project.id, { useWorktreeDefault: useWorktree });
      setWorktreeDefault(updated.useWorktreeDefault);
      // 上层那份 projects 也得换 —— 这块面板一关就整个卸载，下次打开是拿 project 重新
      // 初始化的。不回传的话，用户刚设成默认、重开新建任务却还预填着旧值（第 1 轮审查 P1）。
      onProjectUpdated(updated);
      notify(`已设为本项目默认：「${project.name}」的新任务默认${updated.useWorktreeDefault ? "用独立 worktree" : "直接使用项目目录"}。以后可在「设置 → 项目设置 → 工作目录」里改。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "默认工作目录保存失败");
    } finally {
      setSavingWorktreeDefault(false);
    }
  };
  // 这条任务由谁跑：存在草稿里，任务建好待重发时以那条任务为准（useComposerExecutor.ts）。
  const executor = useComposerExecutor({ draft, profiles, profilesReady, types });
  const singleRun = executor.run;
  // `@` 叫一个人（问一句 / 讨论，见 ComposerCall.tsx）。任务还是胶囊上那个执行器的。
  const calling = useComposerCall({ host: singleRun.agentType, profiles, draft });
  const call = calling.call;
  // 胶囊换成了叫着的那个人：他现在就是跑这条任务的那个，不再算被叫来的。只在这一下（用户亲手换）拿掉他。
  const changeExecutor = (profile: string, override: { model: string; effort: string }) => {
    executor.change(profile, override);
    calling.drop(parseExecutorValue(profile, profiles, singleRun).agentType);
  };
  // `/` 补的是这条任务执行器的技能：正文是发给它的。
  const skills = useSkills({ agentType: singleRun.agentType, projectId: project.id, enabled: true });
  const caret = useCaret(body);
  const slash = slashDismissed || caret.at === null ? null : slashQuery(body, caret.at);
  const slashCandidates = mergeSlashItems([], skills.skills, slash);
  // `@` 还能引用随手记或项目里的文件。文件：任务还不存在，所以按项目仓库搜，选中的路径原样
  // 写进正文，跑起来之后 agent 在自己的工作目录（worktree 或主仓）里按同一条相对路径找得到；
  // 非 git 项目照样给，服务端那边会退回自己走一遍目录（file-search.ts 的 walk）。随手记：
  // 正文和附件带进草稿，并记进回链 —— 建好任务后它跟「转为新任务」一样显示「已转」。
  const mention = useMention({
    value: body,
    setValue: (next) => { setBody(next); setSlashIndex(0); },
    draft,
    scope: { kind: "project", projectId: project.id },
    projectId: project.id,
    linkNotes: true,
    label: "叫一个智能体，或引用随手记、文件",
    agents: {
      match: (token) => (/^[a-z0-9_-]*$/i.test(token) ? calling.callable.filter((type) => type.startsWith(token.toLowerCase())) : []),
      onPick: (agent) => pickAgent(agent as AgentType),
    },
    onPicked: () => textareaRef.current?.focus(),
  });
  // 选中一个智能体：把 @xxx 从正文里摘掉（它是指令不是内容），叫上他，框顶多出「他来做什么」那一行。讨论时再 @
  // 是再叫一个（同回复框）。
  const pickAgent = (agent: AgentType) => {
    setBody((current) => current.replace(/@[^\s@]*$/, ""));
    mention.reset();
    if (call?.verb === "discuss") {
      if (!discussPeople(call).some((person) => person.agent === agent)) calling.togglePerson(agent);
    } else calling.start(agent, call?.verb ?? null);
    textareaRef.current?.focus();
  };
  const cancelCall = () => {
    calling.cancel();
    textareaRef.current?.focus();
  };
  const slashSelected = Math.min(slashIndex, Math.max(0, slashCandidates.length - 1));
  const pickSlash = (item: SlashItem) => {
    // 技能只是补全:命令留在正文里，server 运行前据此注入 SKILL.md。
    const next = slashPickAt(body, item.command, caret.at ?? body.length);
    setBody(next.text);
    caret.place(textareaRef.current, next.text, next.caret);
    setSlashIndex(0);
  };

  const noExecutor = profilesReady && nothingRunnable(profiles);
  const executorBlocked = profilesReady
    && !isExecutorPickable({ agentType: singleRun.agentType, executorId: singleRun.executorId }, types, profiles);
  // 叫着的人就是跑这条任务的那个（注册表变了、拉回的可选值恰好是他）：不替用户删人，先拦着，让他自己换。
  const callsHost = !!call && [call.target, ...call.others].some((person) => person.agent === singleRun.agentType);
  const availabilityMessage = profilesError
    ? `执行器配置读取失败：${profilesError}。读不到就不知道这条任务交给谁，暂不能发送；关掉新建框再打开会重读，写的字和叫的人都留着。`
    : noExecutor
      ? "还没有已注册执行器，暂不能创建任务；请先到执行器设置注册本地 CLI。"
      : executorBlocked ? "当前任务执行器未注册，请在输入框下方换一个。" : null;
  const availabilityTone = noExecutor ? "empty" as const : availabilityMessage ? "warning" as const : null;
  const scheduleError = launchMode === "once" || launchMode === "cron"
    ? scheduleValidationError(launchMode, scheduleAt, scheduleCron)
    : null;
  // 这一档自己没配好的那一句（排队没选目标、前置没选或有一条不成立）；还在核对前置时只挡发送、不当成错写出来。
  const launchTargetError = launchMode === "queue" && !queueAfter.afterTaskId ? "选择要接在哪个任务之后"
    : prerequisitePicks.blockReason;
  // 有图还在传就先不放行：附件路径是上传成功才有的，这时候创建等于把刚粘的那张图
  // 悄悄扔掉——切走这个面板就没人接住在途的那张了。
  const waitingUploads = uploads.uploading;
  const forkError = forkBodyProblem(fork, body);
  // 此刻为什么发不出去：发送键淡下去时指上去说的就是这一句；提交函数里照样拦。
  // 叫着人时第一句是交给他答（或拿去讨论）的话：光有附件不够。
  const blockReason = !(fork || call ? body.trim() : body.trim() || allAttachments.length > 0)
    ? call ? `先写下${call.verb === "discuss" ? "要讨论什么" : `要问 ${call.target.agent} 什么`}` : "先写点内容"
    : forkError ? forkError
      : waitingUploads ? "附件传完才能创建"
        : switching ? "正在切换项目分支，切完才能创建"
          : !profilesReady ? profilesError ? "执行器配置读取失败，暂不能发送" : "正在读取执行器配置"
            : noExecutor || executorBlocked ? availabilityMessage ?? "执行器不可用"
              : callsHost ? `叫着的 ${singleRun.agentType} 就是跑这条任务的执行器：换一个人叫，或者不叫了`
                : scheduleError || launchTargetError || null;
  const canSubmit = !blockReason && !busy;

  const changeLaunchMode = (next: LaunchMode) => {
    draft.setPrerequisites((current) => next === "prerequisites" ? current ?? { ids: [], useWorktree } : null);
    if (next !== "prerequisites") {
      setLaunchMode(next);
      setOwnUseWorktree(useWorktree);
    }
    if (next !== "queue") queueAfter.clear();
    if (next === "once" && !scheduleAt) setScheduleAt(defaultOnceTime());
  };
  // 叫着人时第一回合就是他答这一句 / 这场讨论，当场起：排队、定时、仅创建、等前置都兑现不了，退回「创建并运行」。
  const callHeld = call ? `叫着 ${call.target.agent} 时只能创建并运行` : null;
  const unavailable = callHeld ? { queue: callHeld, create: callHeld, once: callHeld, cron: callHeld, prerequisites: callHeld } : null;
  useEffect(() => {
    if (callHeld && launchMode !== "run") changeLaunchMode("run");
  }, [callHeld, launchMode]);
  const changeGroup = (value: string, opts?: { silent?: boolean }) => {
    setGroupId(value);
    return queueAfter.onGroupChanged(value, opts);
  };
  // 「清空草稿」：正文、附件、叫的人、待重发的那条都丢掉；这条任务由谁跑是上次的选择，留着。
  const clearDraft = () => {
    const kept = draft.executor;
    draft.clear();
    if (kept) draft.setExecutor(kept);
    textareaRef.current?.focus();
  };
  // 已建好、待重发的那条：工作目录、分组、标签都以它为准（锁着，见 ComposerFields 的 locked），不显示下一条的编辑值。
  const shown = draft.created?.task ?? null;
  const submit = async () => {
    if (!canSubmit || isSwitching()) return;
    setBusy(true);
    // 提交那一刻叫着的那一版：发送途中再动它（换人、换做法）是下一句的设置，不该被这一次清掉（useReplyCall 的 sent）。
    const sentCall = call;
    // 给这份草稿盖上这次提交的戳：结果回来时凭它认草稿还是不是这一份（中途清空、换成别的事就不认）。
    const token = `${Date.now()}:${Math.random()}`;
    const submittedDraft = draft.stampSubmission(token);
    // 上一次任务建好了、第一回合却没送达：这次只对那一条重发，不再建一条。
    let task = draft.created?.task ?? null;
    if (!task) {
      try {
        task = await api.createTask(composerTaskInput({
          project, body, fork, groupId, labels, attachments: allAttachments, useWorktree, base, run: singleRun,
          prerequisites: launchMode === "prerequisites"
            ? { ids: prerequisitePicks.picks, mergeTargetBranch: prerequisitePicks.mergeTargetBranch } : null,
        }));
      } catch (error) {
        notify(error instanceof Error ? error.message : "任务创建失败");
        setBusy(false);
        return;
      }
    }
    // 创建成功后的收尾(草稿归属裁决、排队/启动/定时、onCreated 回写)整块在
    // settleCreatedTask.ts —— 归属判据与为什么要捕获提交那一刻的正文见那边注释。
    const settled = await settleCreatedTask({
      task,
      launchMode,
      scheduleAt,
      scheduleCron,
      opening: sentCall ? composerOpening(sentCall, { body, fork, attachments: allAttachments }) : null,
      submitted: { token, draft: submittedDraft, noteIds: draft.noteIds },
      panelMounted: () => mountedRef.current,
      draft,
      resetLabels: () => setLabels([]),
      enqueue: queueAfter.enqueue,
      onCreated,
      onTasksSynced,
      notify,
      waitingFor: prerequisitePicks.waitingTitles,
    });
    // 办成了、面板也归这次提交时上层会收起它；草稿已经换了（面板留着）或没办成，这里就得把按键放回来。
    if (mountedRef.current) setBusy(false);
    // 发出去了：只记住叫的是谁、用的哪一套。叫着的人不在这里清——草稿还是这一份时，结算已经连它一起清掉；
    // 已经换了（清空另写、并进了随手记），眼前那份安排是新的那件事的，旧结果一点都不动它。
    if (settled && sentCall) calling.remember(sentCall);
  };

  return (
    <main className={`task-composer-panel is-studio${home ? " is-home" : ""}`}>
      {home ? <header className="composer-header">
        <b>{home.title}</b>
        {home.detail && <span>{home.detail}</span>}
        <span className="composer-header-grow" aria-hidden="true" />
        {home.count && <span className="composer-header-count">{home.count}</span>}
      </header> : <header className="composer-header">
        <b>{fork ? "派生新任务" : "新建任务"}</b>
        <span>{project.name}</span>
        <span className="composer-header-grow" aria-hidden="true" />
        {/* 草稿是「关掉也留着」的，所以必须有一个明写的丢弃口 —— 否则上一次没写完的
            东西会一直顶在新建框里，用户只能自己全选删。 */}
        {(!!body || uploads.attachments.length > 0 || uploads.uploading || !!call || !!draft.created) && (
          <Button variant="ghost" onClick={clearDraft}>清空草稿</Button>
        )}
        <Button variant="ghost" onClick={onCancel}>取消 Esc</Button>
      </header>}
      <div className="composer-scroll">
        <div className="composer-inner">
          {fork && <ComposerForkContext fork={fork} />}
          {forkError && <p role="alert" className="task-conversation-error">{forkError}</p>}
          {draft.created && <p role="alert" className="task-conversation-error">
            任务「{draft.created.task.title}」已按刚才的设置建好，第一回合没发出去：{draft.created.error}。再按一次只重发这一下，不会再建一条；不要了就清空草稿。
          </p>}
          <ComposerFields
            profiles={profiles}
            types={types}
            executor={executor.config}
            locked={executor.locked}
            executorType={singleRun.agentType}
            call={call && <ComposerCallCapsule calling={calling} host={singleRun.agentType} profiles={profiles}
              disabled={busy} onCancel={cancelCall} />}
            availabilityMessage={availabilityMessage}
            availabilityTone={availabilityTone}
            onExecutorChange={changeExecutor}
            onEffortChange={executor.changeEffort}
            isRepo={project.health.isRepo}
            useWorktree={shown ? !!shown.useWorktree : useWorktree}
            onUseWorktreeChange={setUseWorktree}
            worktreeDefault={worktreeDefault}
            savingWorktreeDefault={savingWorktreeDefault}
            onSaveWorktreeDefault={saveWorktreeDefault}
            branches={branches}
            remote={{ branches: remoteBranches, refresh: refreshRemotes, fetching: fetchingRemotes }}
            base={shown ? shown.worktreeBase ?? "" : base}
            automaticBaseLabel={automaticLabel}
            switchingBranch={switching}
            onBaseChange={setBase}
            followPrerequisites={launchMode === "prerequisites" ? { mergeTarget: prerequisitePicks.mergeTargetBranch } : null}
            groups={groups}
            groupId={shown ? shown.groupId ?? "" : groupId}
            onGroupChange={changeGroup}
            labels={shown ? shown.labels : labels}
            onLabelsChange={setLabels}
            onCreateGroup={() => setGroupDialogOpen(true)}
            onPickStarter={(text) => {
              setBody(body.trim() ? body + "\n\n" + text : text);
              textareaRef.current?.focus();
            }}
          >
          {({ options, executorTools }) => <>
          <div className="studio-card">
          <ComposerCallDock calling={calling} onCancel={cancelCall} />
          <ComposerObjective body={body} textareaRef={textareaRef} autoFocus={!home}
            placeholder={call ? CALL_COPY[call.verb].placeholder(call.target.agent) : undefined}
            onEscape={home ? () => textareaRef.current?.blur() : undefined}
            onChange={(value) => { setBody(value); setSlashIndex(0); setSlashDismissed(false); mention.onValueChange(); }}
            onPaste={uploads.onPaste} items={slashCandidates} selected={slashSelected} token={slash?.token ?? null}
            caret={caret} onSelect={setSlashIndex} onPick={pickSlash} onDismiss={() => setSlashDismissed(true)} onSubmit={() => void submit()}
            mention={{
              onKeyDown: mention.onKeyDown,
              menu: mention.open && (
                <InputMentionMenu mention={mention} label="叫一个智能体，或引用随手记、文件" className="composer-mention-menu" />
              ),
            }} />
          <ImagePreviewGroup isolated>
            <UploadAttachmentList attachments={uploads.attachments} pending={uploads.pending}
              error={uploads.error} onRemove={uploads.remove} onCancel={uploads.cancel} />
          </ImagePreviewGroup>
          {/* 底排：附件、选项入口在左；谁来做、发送键守在右下角（和回复框一个落点）。
              一行放不下时右边那一组整组换到下一行、仍靠右，不压缩、不叠到左边的入口上。 */}
          <footer className="composer-footer">
            <AttachmentPicker addFiles={uploads.addFiles} disabled={busy} />
            <div className="composer-opts">{home
              ? <>{options.where}<ComposerExpand onExpand={home.onExpand} /></>
              : <>{options.where}{options.org}{options.more}</>}<ComposerShortcutHelp /></div>
            <div className="composer-foot-run">
              {executorTools}
              <ComposerLaunchControl
                mode={launchMode}
                at={scheduleAt}
                cron={scheduleCron}
                busy={busy}
                blocked={blockReason}
                uploading={uploads.uploading ? uploadingLabel(uploads.pending) : null}
                error={scheduleError || (prerequisitePicks.checking ? null : launchTargetError)}
                onModeChange={changeLaunchMode}
                onAtChange={setScheduleAt}
                onCronChange={setScheduleCron}
                onSubmit={() => void submit()}
                queueSlot={queueAfter.slot}
                unavailable={unavailable}
                callText={call ? CALL_COPY[call.verb].send(call.target.agent) : null}
                prerequisiteSlot={prerequisitePicks.slot}
              />
            </div>
          </footer>
          {allAttachments.length > 0 && <div className="studio-input-status" role="status">{allAttachments.length} 个附件</div>}
          </div></>}
          </ComposerFields>
          {home?.below}
        </div>
      </div>
      {groupDialogOpen && <CreateGroupDialog
        onClose={() => setGroupDialogOpen(false)}
        onCreate={async (name, groupMode) => {
          try {
            const created = await onCreateGroup(name, groupMode);
            // 走统一改组入口:新建分组也是一次手动改组,必须触发「清掉不兼容的
            // 排队目标」的联动(第 2 轮审查:直接 setGroupId 绕过了它)。两件事
            // 合成一条提示,免得后一条 toast 把「已清除排队目标」顶掉(第 3 轮)。
            const cleared = changeGroup(created.id, { silent: true });
            setGroupDialogOpen(false);
            notify(cleared ? "分组已创建并选中，已清除排队目标（跨组不能同队）" : "分组已创建并选中");
          } catch (error) {
            notify(error instanceof Error ? error.message : "分组创建失败");
          }
        }}
      />}
    </main>
  );
}
