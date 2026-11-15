import { useEffect, useRef, useState } from "react";
import type { AgentType, ScheduledMessage, SkillEntry } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { parseCliCommand } from "@ash/shared/cli-commands";
import { PencilSimple } from "@phosphor-icons/react";
import { IconMenu } from "../components/IconMenu.tsx";
import { ScheduledMessageTray, useScheduledMessages } from "../components/ScheduledMessages.tsx";
import { useLaterSend } from "../components/LaterSend.tsx";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { AgentPlate } from "../components/AgentPlate.tsx";
import {
  ReplyResizeHandle,
  SINGLE_REPLY_PIN,
  useReplyHeight,
} from "./ReplyResizeHandle.tsx";
import { executorRunSummary, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { useReplyLayout } from "./useReplyLayout.ts";
import { isMenuPickKeyEvent, isSendKeyEvent } from "../lib/sendKey.ts";
import { AttachmentPicker, UploadAttachmentList, uploadingLabel, useAttachments } from "./Attachments.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { InputMentionMenu } from "../components/MentionMenu.tsx";
import { useReplyMention } from "./replyMention.ts";
import { applySlashPick, mergeSlashItems, slashQuery, slashSendsAsTyped, slashToken, type SlashItem } from "../lib/useSkills.ts";
import type { AgentModelSelection } from "./mentionPicker.ts";
import { CALL_COPY, DISPATCH_SLASH_ITEM, dispatchBaseOptions, parseDispatchCommand, readCallMemory, type CallVerb, type ReplyCall } from "./replyCall.ts";
import { useDispatchBaseContext, useReplyCall } from "./useReplyCall.ts";
import { CallCancelKey, DispatchBaseSegment, ReplyCallDock } from "./ReplyCallDock.tsx";
import { ReplySendKey } from "./ReplySendKey.tsx";
import type { ReplyBoxProps } from "./replyBoxProps.ts";
import { useStandingExecutor } from "./useStandingExecutor.ts";
import { useExecutorProfiles } from "./useExecutorProfiles.ts";
import { ComposerInput } from "./ComposerInput.tsx";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { overrideKeyDown, overrideTake } from "./replyOverride.ts";
import { ScreenshotAnnotation } from "../page-annotation/ScreenshotAnnotation.tsx";
import { screenshotCandidates, type AnnotationReply } from "../page-annotation/model.ts";
import { QuestionDock, useQuestionTakeover } from "./QuestionSlot.tsx";
import { parseAttachmentText } from "./utils.ts";
import {
  attachmentsFromPaths,
  clearSentDraft,
  dropSentAttachments,
  sentSelections,
  joinDraftText,
  mergeAttachments,
} from "./withdrawDraft.ts";

const EMPTY_SKILLS: SkillEntry[] = [];
// 菜单顶行只给第一组起名:原生命令和排在后面的技能各有 SlashMenu 画的分隔线。
const MENU_HEADING: Record<SlashItem["kind"], string> = { ash: "派生命令 · ", native: "", skill: "技能 · " };

export function ReplyBox({
  task,
  hasConversation,
  onSend,
  onStop,
  stopBlocked = null,
  onStandingExecutorChange,
  command,
  skills = EMPTY_SKILLS,
  inlinePanel,
  topRail,
  actions,
  moreItems = [],
  moreRef,
  conversationItems = [],
  tasks = [],
  override,
  onAnswer,
  onDispatch,
}: ReplyBoxProps) {
  const draft = useTaskReplyDraft(task.id);
  const shellRef = useReplyLayout();
  const ownMoreRef = useRef<HTMLButtonElement>(null);
  const moreButton = moreRef ?? ownMoreRef;
  const [annotating, setAnnotating] = useState(false);
  const value = draft.text;
  const setValue = draft.setText;
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [commandResult, setCommandResult] = useState<{ taskId: string; text: string } | null>(null);
  const currentTaskId = useRef(task.id);
  currentTaskId.current = task.id;
  const [commandIndex, setCommandIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const later = useLaterSend(draft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // null = 没拖过,交给行数自动撑高(useAutoGrowTextarea)
  const replyHeight = useReplyHeight(SINGLE_REPLY_PIN);
  const { profiles, ready: profilesReady, failed: profilesFailed } = useExecutorProfiles();
  // 执行器名只用于提示文案：没钉 profile 时按「该类型的默认执行器」报，与运行侧
  // resolveExecutorFor 的降级口径一致，别让提示说出一个跑起来根本用不上的名字。
  const executorLabelOf = (agentType: AgentType, executorId: string | null) =>
    profiles.find((profile) => profile.id === executorId)?.name
    ?? profiles.find((profile) => profile.type === agentType && profile.isDefault)?.name
    ?? agentType;
  // 任务的常设配置（以后都用谁）。点胶囊改的是它；`target` 是压在它上面的一次性召唤。
  const standing = useStandingExecutor(
    task,
    onStandingExecutorChange
      && ((next) => onStandingExecutorChange(next, executorLabelOf(next.agentType, next.executorId))),
    setSendError,
  );
  // `@` 叫了谁、来做什么（问一句 / 派出去）。叫着人时胶囊上是他、框顶那一行是做法；问一句就是一次性
  // 召唤 —— 只随这一次 reply 发出、发完即清，不落任务（「以后都用谁」是上面的 standing）。
  const dispatchable = !!onDispatch;
  const calling = useReplyCall({ ownAgent: standing.config.agentType, dispatchable, profiles });
  const call = calling.call;
  const target = call?.target ?? null;
  const dispatching = call?.verb === "dispatch";
  // `/派` 时还没叫过人：先开 `@` 菜单让选，选中的那一个直接停在「派出去」。
  const pendingVerb = useRef<CallVerb | null>(null);
  const baseContext = useDispatchBaseContext(task.projectId, dispatching);
  const baseOptions = dispatchBaseOptions(task, baseContext.value);
  const worktreeBase = baseOptions.find((option) => option.id === call?.base)?.worktreeBase ?? baseOptions[0]?.worktreeBase ?? null;
  // 叫着人时框顶是做法那一行，裁定那一行让开（不叫了就换回来）：框顶任何时候只有一行。
  const activeOverride = call && dispatchable ? undefined : override;
  const scheduled = useScheduledMessages(task.id);
  const uploads = useAttachments({
    value: draft.attachments,
    onChange: draft.setAttachments,
    pending: draft.pendingUploads,
    onPendingChange: draft.setPendingUploads,
  });
  // 借用中且选了一档：正文是那一档的话（或整块换成别的），斜杠、@ 这些都不出。
  const { take, takeInput } = overrideTake(activeOverride);
  // 任务正在跑不再是「不能说话」,而是「说了先排队」:发出去的消息落成一条待发送
  // 消息(mode=queued),这一轮一结束由服务端自动送进同一个会话。所以 disabled 只留
  // 真正没得说的情况——不是单任务、已归档、以及从没跑过因而没有会话可续。
  const queueing = task.status === "running" || task.status === "queued";
  const cliCommand = parseCliCommand(target?.agent ?? standing.config.agentType, value);
  const scopeDiscovery = cliCommand?.name === "goal" && cliCommand.args === "--scopes";
  const disabled = task.mode !== "single" || task.archived || (!hasConversation && !queueing && !scopeDiscovery);
  const inputDisabled = disabled && !command;
  // 占位只有「回复…」，水印透出来（reply-1）。快捷键在发送键的提示里，「可以粘贴」在附件键的
  // 提示里，「引导会话」在待发送那一条的键上；发不出去的原因指到发送键上才说。只有整个输入框
  // 都用不了（不是单任务、归档了还没敲派生命令）时，原因才写在占位里——那时没有键可指。
  const reason = task.mode !== "single"
    ? "请在对应的团队或讨论页面继续操作"
    : task.archived
      ? "任务已归档，无法继续回复"
      : !hasConversation && !queueing && !scopeDiscovery
        ? "先运行任务，再继续回复"
        : null;
  const placeholder = inputDisabled && reason ? reason : call ? CALL_COPY[call.verb].placeholder(call.target.agent) : "回复…";

  const resetComposerState = () => {
    setCommandIndex(0);
    setMenuDismissed(false);
    mention.reset();
    calling.cancel();
    pendingVerb.current = null;
  };

  useEffect(() => {
    resetComposerState();
    setSendError(null);
    setCommandResult(null);
  }, [task.id]);

  const commandReset = useRef({ taskId: task.id, key: command?.resetKey });
  useEffect(() => {
    const previous = commandReset.current;
    commandReset.current = { taskId: task.id, key: command?.resetKey };
    if (previous.taskId !== task.id || previous.key === command?.resetKey) return;
    setValue("");
    resetComposerState();
  }, [command?.resetKey, task.id]);

  // 托盘该少一行由服务端的 task.pendingMessages 事件说了算（useScheduledMessages 里
  // 订阅）。这里只留一道兜底：SSE 断过线时，任务从「在跑」变成别的状态也重拉一次。
  const wasQueueing = useRef(queueing);
  useEffect(() => {
    if (wasQueueing.current && !queueing) void scheduled.reload({ quiet: true });
    wasQueueing.current = queueing;
  }, [queueing, scheduled.reload]);

  // 派生命令(ash 自己的)排在技能前面,中间画一条线:前者换的是「谁来干」,
  // 后者只是给这一轮加一句提示词,点错的代价差着量级。
  const ashItems: SlashItem[] = [
    ...(dispatchable ? [DISPATCH_SLASH_ITEM] : []),
    ...command?.items ?? [],
  ].map((item) => ({ ...item, kind: "ash" }));
  const commandCandidates = (text: string) => mergeSlashItems(ashItems, skills, slashQuery(text));
  const candidates = commandCandidates(value);
  // 答题卡展开着（连同它收回去那一下）：平常的框和它的全部浮层都不挂，草稿原样留着（QuestionSlot.tsx）。
  // 框里的工具（选执行器、发送设置、截图批注、更多）跟着框一起卸掉；框外这几层（补全、引用、`@`
  // 之后选模型、派生面板）在下面逐个按 covering 让开。由宿主开着的那两层顺手关上，收起时不再自己弹回来。
  const takeover = useQuestionTakeover(onAnswer ? task : null);
  const covering = takeover.covering;
  useEffect(() => {
    if (covering) setAnnotating(false);
  }, [covering]);
  const menuOpen = !take && !covering && !menuDismissed && candidates.length > 0;
  const selectedIndex = Math.min(commandIndex, Math.max(0, candidates.length - 1));
  const commandMatch = !take && !!command && command.matches(value);
  // 敲全了的 `/派 …`：发送 = 叫上次那个人、停在「派出去」，后面那段留在框里。
  const dispatchTyped = !take && !call && dispatchable && parseDispatchCommand(value) !== null;
  const selected = candidates[selectedIndex];
  // 菜单开着时回车做什么:ash 命令打开派生配置;技能和原生命令补全进正文;
  // 原生命令已经敲全就直接发(它本来就是发给 CLI 的一句话)。
  const menuSends = menuOpen && slashSendsAsTyped(selected, value);
  const menuCompletes = menuOpen && !menuSends && selected?.kind !== "ash";
  const commandActive = commandMatch || menuOpen || dispatchTyped;
  const pickingDispatch = menuOpen ? selected?.command === DISPATCH_SLASH_ITEM.command : dispatchTyped;
  // 选模型那个浮层和底部胶囊的候选都取它；`@` 那张菜单里的智能体候选在 replyMention.ts
  // 里自己算（它还要按 token 过滤）。
  const registeredTypes = registeredAgentTypes(profiles);
  const mention = useReplyMention({
    value,
    setValue,
    draft,
    taskId: task.id,
    projectId: task.projectId,
    profiles,
    profilesReady,
    profilesFailed,
    disabled: disabled || commandActive || !!take,
    onPickAgent: (agent) => pickMention(agent),
    onPicked: () => textareaRef.current?.focus(),
  });

  // 底部胶囊上显示的「这一回合会由谁、用什么模型跑」：@ 召唤过就是那一套（一次性），
  // 没召唤就是任务自己的常设配置（executorId 为空时按类型默认执行器降级，与服务端
  // resolveExecutorFor 同一条口径）。
  const activeAgent = (target?.agent ?? standing.config.agentType) as AgentType;
  const activeExecutorId = (target ? target.executorId : standing.config.executorId)
    ?? profiles.find((profile) => profile.type === activeAgent && profile.isDefault)?.id
    ?? null;
  const summary = executorRunSummary(
    { agentType: activeAgent, executorId: activeExecutorId },
    profiles,
    {
      model: target ? target.model : standing.config.model,
      effort: target ? target.reasoningEffort : standing.config.reasoningEffort,
    },
  );
  const activeModel = summary.model;
  const activeEffort = summary.effort;
  // 胶囊上写着谁,这一回合就该由谁跑——横幅在会话行落库前先照抄这个名字,
  // 免得它去报任务的常设执行器(@grok 干活时报 codex 就是这么来的)。
  const activeExecutorLabel = profiles.find((profile) => profile.id === activeExecutorId)?.name
    ?? activeAgent;
  // 胶囊改的是「以后都用谁」，跟「现在能不能说话」是两件事：从没跑过的任务同样该能
  // 先把执行器挑好（详情页没有第二个入口，TaskInspector 那节是只读的）。所以这里
  // 不跟着 disabled 走，只挡真正改不动的：非单飞、已归档、正在发送、正在配派生命令。
  const configDisabled = task.mode !== "single" || task.archived || sending || commandActive
    || (!target && !onStandingExecutorChange);

  const pickCommand = (item: SlashItem) => {
    // 技能不是派生命令:它只是**补全**。`/名字` 原样留在正文里跟着这一轮发下去,
    // server 会据此注入 SKILL.md，所以这里绝不能把它截走。
    // 原生命令同理:`/compact` 是正文本身,发送时由 server 识别后交给 CLI 执行,
    // 不是派生命令,交给 command.onSubmit 只会被它当成不认识的命令吞掉。
    if (item.kind !== "ash") {
      const next = applySlashPick(value, item.command);
      setValue(next);
      setCommandIndex(0);
      setMenuDismissed(false);
      command?.onChange?.(next);
      textareaRef.current?.focus();
      return;
    }
    if (item.command === DISPATCH_SLASH_ITEM.command) return startDispatch(parseDispatchCommand(value) ?? "");
    command?.onSubmit(item.command);
    setValue("");
    setCommandIndex(0);
    setMenuDismissed(false);
    calling.cancel();
  };

  // `/派`：叫上次叫过的那个人，停在「派出去」；后面写了话就留在框里。从没叫过人（或那个执行器已经
  // 没了）就先开 `@` 菜单让选，选中的直接停在「派出去」。
  const startDispatch = (rest: string) => {
    setCommandIndex(0);
    setMenuDismissed(false);
    const last = readCallMemory().last;
    if (last && registeredTypes.includes(last)) {
      setValue(rest);
      calling.start(last, "dispatch");
    } else {
      pendingVerb.current = "dispatch";
      setValue(rest ? `${rest} @` : "@");
      mention.onValueChange();
    }
    textareaRef.current?.focus();
  };

  const cancelCommand = () => {
    setValue("");
    setCommandIndex(0);
    setMenuDismissed(true);
    command?.onChange?.("");
    command?.onCancel?.();
  };

  // 不叫人了：胶囊回到这条任务自己的执行器，框顶换回裁定那一行（有的话），写的字一个不动。
  const cancelCall = () => {
    calling.cancel();
    textareaRef.current?.focus();
  };

  // 选中一个智能体：把 @xxx 从正文里摘掉（它是指令不是内容），叫上他——胶囊换成他（上次对他用的那一套），
  // 框顶多出「他来做什么」那一行，默认停在「问一句」。叫着人时再 @ 只是换人，做法不变。
  const pickMention = (agent: AgentType) => {
    setValue((current) => current.replace(/@[^\s@]*$/, ""));
    mention.reset();
    calling.start(agent, pendingVerb.current ?? call?.verb ?? null);
    pendingVerb.current = null;
  };

  // 点胶囊改的是**任务以后都用谁**：写回任务本身，之后每一条消息（含排队的、队列
  // 自动续跑的那些）都按新配置跑，不用每发一句重选一次。换执行器照样把模型/智能
  // 水平打回「跟随」，与服务端 inheritExecutorOverrides 同一条口径；比较基准取
  // **当前真正生效的**执行器（activeExecutorId 已把「跟随类型默认」解析过），
  // 否则在没钉 profile 的任务上换个模型会白清一次用户选好的智能水平。
  const commitStanding = (next: AgentModelSelection) => {
    const changed = !sameExecutor(
      { agentType: next.agent, executorId: next.executorId },
      { agentType: activeAgent, executorId: activeExecutorId },
    );
    standing.commit({
      agentType: next.agent,
      executorId: next.executorId,
      model: next.model,
      reasoningEffort: changed ? null : standing.config.reasoningEffort,
    });
    textareaRef.current?.focus();
  };

  const commitStandingEffort = (effort: string) => {
    standing.commit({ ...standing.config, reasoningEffort: effort || null });
  };

  // 正在飞的那一次发送登记在草稿上：撤回、会话里「改了再发」都排在它后面（见 DraftStore
  // 的 afterSend）。清空和合并谁先谁后一旦确定，就不必再去草稿里猜哪一段是刚发出去的。
  const send = (): Promise<void> => {
    const run = runSend().then(() => {});
    draft.trackSend(run);
    return run;
  };

  // 截图批注是另一条入口，照旧立即发；正文这条按回复框当前的发送方式发。
  const runSend = async (annotation?: AnnotationReply): Promise<boolean> => {
    if (!annotation && menuOpen && !menuSends) {
      pickCommand(candidates[selectedIndex]!);
      return false;
    }
    if (!annotation && commandMatch) {
      pickCommand({ command: value.trim(), label: "", kind: "ash" });
      return false;
    }
    if (!annotation && dispatchTyped) {
      startDispatch(parseDispatchCommand(value) ?? "");
      return false;
    }
    if (!annotation && call?.verb === "dispatch") return runDispatch(call);
    // 截图批注是另一条入口：叫着人只在「问一句」时算数，派出去不经过这里。
    const askTarget = call?.verb === "ask" ? call.target : null;
    if (disabled || sending || uploads.uploading || (!annotation && !value.trim() && !uploads.attachments.length)) return false;
    const choice = annotation ? {} : later.resolve();
    // 选了「稍后」却没配好：拦下并说清，绝不悄悄退回立即发送。
    if (!choice) {
      setSendError(`${later.submitLabel}：${later.blockerOf(choice)}`);
      return false;
    }
    setSending(true);
    setSendError(null);
    setCommandResult(null);
    // 发出去的是这一份。成功后只在草稿**还是这一份**（字面和版本都没变）时才清掉；动过就整份留着，
    // 绝不去猜哪一段是刚发出去的（见 withdrawDraft.ts 的 clearSentDraft）。
    const draftAtSend = { text: value, textVersion: draft.value.textVersion };
    const laterAtSend = draft.later;
    const sentText = annotation?.text ?? value.trim();
    const sentPaths = annotation?.attachments ?? uploads.attachments.map((attachment) => attachment.path);
    // 发送结算只摘这一次提交的那几次选择（路径 + 选择记号），途中又放回的同一张图留着。
    const sentSelection = sentSelections(uploads.attachments);
    try {
      // 改完执行器立刻按发送时，PATCH 可能还在飞 —— 回复的 POST 先到，服务端读到的
      // 仍是旧执行器，这一句照旧由旧的跑。先等写回落地，落不下去就别发：静默按旧
      // 配置发出去，等于用户改了个寂寞（第 2 轮审查实测复现）。
      const standingError = await standing.settle();
      if (standingError) {
        setSendError(`执行器没能改过去（${standingError}），这一句先没发出去。重选一次执行器再发。`);
        if (annotation) throw new Error(standingError);
        return false;
      }
      const result = await onSend(
        sentText,
        sentPaths,
        {
          agent: askTarget?.agent,
          executorId: askTarget?.executorId ?? null,
          model: askTarget?.model ?? null,
          reasoningEffort: askTarget?.reasoningEffort ?? null,
          sendAt: choice.sendAt,
          afterTaskId: choice.afterTaskId,
          executorLabel: activeExecutorLabel,
        },
      );
      if (result === null) return false; // 用户主动取消：什么都别清
      if ("scheduled" in result) scheduled.add(result.message);
      if ("command" in result && !result.recorded && currentTaskId.current === task.id) setCommandResult({ taskId: task.id, text: result.text });
      if (!annotation) {
        clearSent(draftAtSend, sentSelection);
        // 发送方式跟正文同口径：发送途中被改过就留着，那是下一条的设置。
        draft.setLater((current) => (current === laterAtSend ? null : current));
      }
      if (askTarget) calling.sent(askTarget);
      return true;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
      if (annotation) throw error;
      return false;
    } finally {
      setSending(false);
    }
  };

  // 发出去的是这一份：草稿还是这一份（字面和版本都没变）才清，动过就整份留着（withdrawDraft.ts）。
  const clearSent = (draftAtSend: Parameters<typeof clearSentDraft>[1], sentSelection: ReturnType<typeof sentSelections>) => {
    draft.update((current) => {
      const text = clearSentDraft(current, draftAtSend);
      return text === current.text ? current : { ...current, text };
    });
    draft.setAttachments((current) => dropSentAttachments(current, sentSelection));
    uploads.clearError();
  };

  // 派出去：开一条新任务交给叫的那个人。这条任务的智能体不被叫醒、不占回合，所以它在跑时也照派不误
  // （不排队）。失败时人、做法、正文和附件全留着，说清楚哪儿没成。
  const runDispatch = async (current: ReplyCall): Promise<boolean> => {
    const text = value.trim();
    if (!onDispatch || disabled || sending || uploads.uploading || !text || !baseContext.ready) return false;
    setSending(true);
    setSendError(null);
    setCommandResult(null);
    const draftAtSend = { text: value, textVersion: draft.value.textVersion };
    const sentSelection = sentSelections(uploads.attachments);
    try {
      await onDispatch({ text, attachments: uploads.attachments.map((attachment) => attachment.path), target: current.target, worktreeBase });
      clearSent(draftAtSend, sentSelection);
      calling.sent(current.target);
      return true;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSending(false);
    }
  };

  // 撤回:先把消息从队列上取下来(失败就什么都不动,免得内容一式两份),成功后正文、
  // 附件、这条消息当初 @ 指派的执行器配置一并放回对话框——发它时是什么样,撤回后就
  // 还是什么样,用户接着改就行。「稍后」的设定也留着(定时的还没到点才留,等任务的原样留)。
  //
  // 有发送正在飞就先等它结算完:发送成功会把它自己那份草稿清掉,清完再并入撤回的内容。
  // 顺序一确定,两边都不必去猜草稿里哪一段是谁的(靠猜会猜错,2026-08-27 审查实测)。
  const withdraw = async (message: ScheduledMessage) => {
    if (!await scheduled.cancel(message.id)) return;
    await draft.afterSend();
    setValue((current) => joinDraftText(message.text, current));
    draft.setAttachments((current) => mergeAttachments(attachmentsFromPaths(message.attachments), current));
    if (message.agent) {
      calling.restore({
        agent: message.agent,
        executorId: message.executorId,
        model: message.model,
        reasoningEffort: message.reasoningEffort,
      });
    }
    later.restore(message);
    textareaRef.current?.focus();
  };

  return (
    <div ref={shellRef} className="task-reply-shell">
      {menuOpen && (
        <SlashMenu
          className="task-reply-command-menu"
          ariaLabel="斜杠命令与技能"
          hint={`${MENU_HEADING[candidates[0]!.kind]}↑↓ 选择，回车${menuSends ? "发送" : menuCompletes ? "补全" : "确认"}，Esc 取消`}
          items={candidates}
          selectedIndex={selectedIndex}
          token={slashToken(value)}
          onHover={setCommandIndex}
          onPick={pickCommand}
        />
      )}
      {mention.open && !menuOpen && !covering && (
        <InputMentionMenu mention={mention} label="召唤智能体或引用随手记、文件" className="task-reply-mention-menu" />
      )}
      <div className="reply-context">
      {inlinePanel && !covering && !menuOpen && !mention.open && <div className="task-reply-inline-panel">{inlinePanel}</div>}
      <ScheduledMessageTray
        key={task.id}
        messages={scheduled.messages}
        loading={scheduled.loading}
        error={scheduled.error}
        cancelingIds={scheduled.cancelingIds}
        steeringIds={scheduled.steeringIds}
        onSteer={(messageId) => void scheduled.steer(messageId)}
        onWithdraw={(message) => void withdraw(message)}
        onCancel={(messageId) => void scheduled.cancel(messageId)}
        tasks={tasks}
        onSendNow={(messageId) => void scheduled.sendNow(messageId)}
      />
      {!covering && <UploadAttachmentList
        attachments={uploads.attachments}
        pending={uploads.pending}
        error={uploads.error}
        onRemove={uploads.remove}
        onCancel={uploads.cancel}
      />}
      {sendError && <p className="task-reply-error">{sendError}</p>}
      {commandResult?.taskId === task.id && <p className="task-reply-command-result" role="status" aria-label="命令结果">{commandResult.text}</p>}
      {topRail}
      </div>
      {onAnswer && <QuestionDock takeover={takeover} onAnswer={onAnswer} />}
      {!covering && <div className="task-reply-box">
        <ReplyResizeHandle targetRef={textareaRef} {...replyHeight} />
        <AgentPlate name={activeAgent} />
        {call && dispatchable
          ? <ReplyCallDock call={call} self={calling.self} onVerb={calling.setVerb} onCancel={cancelCall} />
          : activeOverride?.head}
        {/* 输入几行就撑几行高,撑到上限为止;拖过之后以拖出来的高度为准(拖动条自己的上限更宽)。 */}
        <ComposerInput
          inputRef={textareaRef}
          value={takeInput?.value ?? value}
          pinned={replyHeight.height}
          quoteTarget={task.id}
          rows={3}
          hidden={!!take && !takeInput}
          disabled={inputDisabled && !takeInput}
          readOnly={takeInput?.readOnly}
          placeholder={takeInput?.placeholder ?? placeholder}
          aria-label={takeInput?.label ?? "回复任务"}
          onChange={(event) => {
            const next = event.target.value;
            if (takeInput) return takeInput.onChange(next);
            setValue(next);
            setMenuDismissed(false);
            setCommandIndex(0);
            mention.onValueChange();
            command?.onChange?.(commandCandidates(next).length > 0 ? "" : next);
          }}
          onPaste={take ? undefined : uploads.onPaste}
          onKeyDown={(event) => {
            if (overrideKeyDown(activeOverride, event)) return;
            if (menuOpen) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCommandIndex((selectedIndex + 1) % candidates.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCommandIndex((selectedIndex - 1 + candidates.length) % candidates.length);
                return;
              }
              if (isMenuPickKeyEvent(event)) {
                event.preventDefault();
                if (menuSends) void send();
                else pickCommand(selected!);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                // 斜杠接在已写好的正文后面时只收起菜单:那是在给这句话点技能,
                // 不是在敲命令,整段清空等于把用户写的话扔了。
                if (slashQuery(value)?.leading) cancelCommand();
                else setMenuDismissed(true);
                return;
              }
            }
            if (event.key === "Escape" && commandMatch) {
              event.preventDefault();
              cancelCommand();
              return;
            }
            if (mention.onKeyDown(event)) return;
            // 叫着人：空框里退格、或 Esc，就是不叫了（字一个不动）。Esc 只退这一层，外面的抽屉不跟着关。
            if (call && (event.key === "Escape" || (event.key === "Backspace" && !value && !event.repeat))) {
              event.preventDefault();
              event.stopPropagation();
              cancelCall();
              return;
            }
            if (isSendKeyEvent(event)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {take && "body" in take && take.body}
        <div className="task-reply-actions">
          <AttachmentPicker addFiles={uploads.addFiles} disabled={disabled || sending || commandActive || !!take} />
          {actions}
          {/* 截图批注、预览日志用得少，收进「更多」。 */}
          <IconMenu side="above" buttonRef={moreButton} className="task-reply-more" items={[
            { label: draft.screenshot ? "继续批注" : "截图批注", icon: <PencilSimple size={15} />,
              disabled: disabled || sending || uploads.uploading || commandActive, onPick: () => setAnnotating(true) },
            ...moreItems,
          ]} />
          <ScreenshotAnnotation key={task.id} taskId={task.id} open={annotating} onOpenChange={setAnnotating} returnFocusRef={moreButton}
            candidates={screenshotCandidates(conversationItems, [...parseAttachmentText(task.body).paths, ...uploads.attachments.map((attachment) => attachment.path)])}
            disabled={disabled || sending || uploads.uploading || commandActive} queueing={queueing}
            executorLabel={activeExecutorLabel} onSend={(reply) => runSend(reply)} />
          <span className="task-reply-actions-gap" aria-hidden="true" />
          {/* 一颗三段胶囊：智能体 · 模型 · 智能水平。可单独改任一段，也可选完前一段后向右接着配置；跟新建
              面板、工作流站点用同一组件。没叫人时改它 = 改任务的常设配置，之后每条消息都按新的跑；叫着人时
              它就是被叫的那个人（改的是这一次），派出去时最后多一段「从哪开工」，小叉 = 不叫了。 */}
          <RunTargetPicker
            label={target ? `叫来的智能体：${target.agent}` : "这个任务以后由谁来跑"}
            types={registeredTypes.length ? registeredTypes : [activeAgent]}
            profiles={profiles}
            selection={{ agentType: activeAgent, executorId: activeExecutorId }}
            model={activeModel ?? null}
            effort={activeEffort ?? ""}
            variant="chip"
            highlight={!!target}
            disabled={configDisabled}
            onCommit={target ? calling.commitTarget : commitStanding}
            onEffortChange={target ? calling.commitEffort : commitStandingEffort}
            tail={call && dispatching && baseOptions.length > 1
              ? <DispatchBaseSegment options={baseOptions} value={call.base} disabled={configDisabled} onChange={calling.setBase} />
              : undefined}
          />
          {target && <CallCancelKey agent={target.agent} onCancel={cancelCall} />}
          <ReplySendKey
            overrideSend={take ? activeOverride!.send : null}
            call={call}
            dispatchReady={baseContext.ready}
            later={later}
            text={value}
            attachments={uploads.attachments.length}
            uploading={uploads.uploading ? uploadingLabel(uploads.pending) : null}
            queueing={queueing}
            sending={sending}
            blocked={disabled ? reason ?? "现在发不出去" : null}
            // 敲着命令时这颗键干的是别的事：补全命令、叫人派出去、打开派生配置。归档的任务也能派生，所以不受上面那条拦。
            override={menuCompletes ? { text: "补全", action: "把命令补进正文" }
              : pickingDispatch ? { text: "叫人", action: "叫上次那个人，停在派出去" }
                : commandActive && !menuSends ? { text: "配置", action: "打开派生配置" } : null}
            onSend={() => void send()}
            onStop={onStop ? () => {
              setStopping(true);
              void onStop().finally(() => setStopping(false));
            } : undefined}
            // 停止键出不出、能不能点只看服务端的停止结论（onStop / stopBlocked）；这里只挑提示里那句话。
            stopTip={["queued", "paused", "backlog"].includes(task.status) ? "不排了" : "停止这一轮"}
            stopBlocked={stopBlocked}
            stopping={stopping}
            configDisabled={disabled || sending || uploads.uploading || commandActive || mention.open}
            tasks={tasks}
            projectId={task.projectId}
            taskId={task.id}
          />
        </div>
      </div>}
    </div>
  );
}
