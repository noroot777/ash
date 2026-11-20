import { useEffect, useRef, useState } from "react";
import type { AgentType, ScheduledMessage, SkillEntry } from "@navi/shared";
import { sameExecutor } from "@navi/shared/executors";
import { parseCliCommand } from "@navi/shared/cli-commands";
import { concreteReviewChoice } from "@navi/shared/review-on-create";
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
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { AttachmentPicker, UploadAttachmentList, uploadingLabel, useAttachments } from "./Attachments.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { InputMentionMenu } from "../components/MentionMenu.tsx";
import { useReplyMention } from "./replyMention.ts";
import type { SlashItem } from "../lib/useSkills.ts";
import { useReplySlash } from "./useReplySlash.ts";
import { useSuggestionDock } from "./suggestions/useSuggestionDock.tsx";
import type { AgentModelSelection } from "./mentionPicker.ts";
import {
  CALL_COPY, DISCUSS_SLASH_ITEM, DISPATCH_SLASH_ITEM, callCommandVerb, discussPeople, dispatchBaseChoices, parseCallCommand,
  readCallMemory, type CallVerb, type ReplyCall,
} from "./replyCall.ts";
import { useDispatchBaseContext, useReplyCall } from "./useReplyCall.ts";
import { CallCancelKey, CallReviewerChip, DispatchBaseSegment, ReplyCallDock } from "./ReplyCallDock.tsx";
import { reviewHold, useReviewerList } from "../free-workflow/useReviewerList.ts";
import { ReplySendKey } from "./ReplySendKey.tsx";
import { DispatchDefaultRow, DispatchDefaultSegment, useDispatchDefault } from "./ReplyDispatchDefault.tsx";
import { DiscussCapsule } from "./ReplyDiscussSegments.tsx";
import type { ReplyBoxProps } from "./replyBoxProps.ts";
import { PlanReadyCard, readyPlanFor, usePlanTakeover, type ReadyPlan } from "./PlanReadyCard.tsx";
import { useStandingExecutor } from "./useStandingExecutor.ts";
import { useExecutorProfiles } from "./useExecutorProfiles.ts";
import { ComposerInput } from "./ComposerInput.tsx";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { overrideKeyDown, overrideTake } from "./replyOverride.ts";
import { ScreenshotAnnotation } from "../page-annotation/ScreenshotAnnotation.tsx";
import { screenshotCandidates, type AnnotationReply } from "../page-annotation/model.ts";
import { QuestionDock, useQuestionTakeover } from "./QuestionSlot.tsx";
import { parseAttachmentText } from "./utils.ts";
import { clearSentDraft, dropSentAttachments, sentSelections, withdrawIntoBox } from "./withdrawDraft.ts";
import { replyGate, sessionlessSkills } from "./replyGate.ts";

const EMPTY_SKILLS: SkillEntry[] = [];
/** 还没跑过时那颗键的发送方式：永远是立即发，改不动（真正的发送方式留在草稿里不碰）。 */
const NOW_ONLY = { later: null, setLater: () => {} };
// 菜单顶行只给第一组起名:原生命令和排在后面的技能各有 SlashMenu 画的分隔线。
const MENU_HEADING: Record<SlashItem["kind"], string> = { navi: "叫人 · ", native: "", skill: "技能 · " };

export function ReplyBox({
  task,
  hasConversation,
  onSend,
  onStop,
  stopBlocked = null,
  onStandingExecutorChange,
  skills = EMPTY_SKILLS,
  topRail,
  monitors,
  actions,
  moreItems = [],
  moreRef,
  conversationItems = [],
  tasks = [],
  override,
  onAnswer,
  onOpenTask,
  onDispatch,
  onLaunchPlan,
  onDispatchTargetChange,
  onDiscuss,
  discussHeld = null,
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
  // 实施、改计划都交回出这份计划的那个执行器：换了人，计划模式的作用域就对不上了。
  const sendToPlanner = async (ready: ReadyPlan, text: string, attachments: string[]) => {
    await onSend(text, attachments, { agent: "codex", executorId: ready.executorId, model: ready.model, reasoningEffort: ready.reasoningEffort });
  };
  const currentTaskId = useRef(task.id);
  currentTaskId.current = task.id;
  const later = useLaterSend(draft);
  const nowOnly = useLaterSend(NOW_ONLY);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // null = 没拖过;拖过的高度只当下限,照样跟着行数长高(useAutoGrowTextarea)
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
  const dispatchDefault = useDispatchDefault(task, onDispatchTargetChange, setSendError);
  // `@` 叫了谁、来做什么（问一句 / 讨论 / 派出去）。叫着人时胶囊上是他、框顶那一行是做法；问一句就是一次性
  // 召唤 —— 只随这一次 reply 发出、发完即清，不落任务（「以后都用谁」是上面的 standing）。
  const dispatchable = !!onDispatch;
  const ability = { dispatchable, discussable: !!onDiscuss };
  const calling = useReplyCall({ ownAgent: standing.config.agentType, ability, profiles });
  const call = calling.call;
  const target = call?.target ?? null;
  const dispatching = call?.verb === "dispatch";
  const baseContext = useDispatchBaseContext(task.projectId, dispatching);
  const baseOptions = dispatchBaseChoices(task, baseContext.value);
  const worktreeBase = baseOptions.find((option) => option.id === call?.base)?.worktreeBase ?? baseOptions[0]?.worktreeBase ?? null;
  // 谁来审：照胶囊此刻画着的那一位派（按下那一刻就定，不等派出途中缓存再变）；清单没读到时只有「不审查」派得出去。
  const reviewerList = useReviewerList(dispatching);
  const dispatchReview = concreteReviewChoice(call?.review ?? "default", reviewerList.reviewers);
  const dispatchReviewHold = dispatching ? reviewHold(call?.review ?? "default", reviewerList) : null;
  const scheduled = useScheduledMessages(task.id);
  const uploads = useAttachments({
    value: draft.attachments,
    onChange: draft.setAttachments,
    pending: draft.pendingUploads,
    onPendingChange: draft.setPendingUploads,
  });
  // 发出去的是这一份：记下此刻的字和图，成了再清（框里途中又写了的照留，withdrawDraft.ts）。
  const snapshotSent = () => {
    const draftAtSend = { text: value, textVersion: draft.value.textVersion };
    const sentSelection = sentSelections(uploads.attachments);
    return () => clearSent(draftAtSend, sentSelection);
  };
  // 可以派出去的活（suggestions/useSuggestionDock.tsx）：框顶那一行，选中一件时这个框就是「补一句」。
  const suggestion = useSuggestionDock({
    task, enabled: dispatchable && !task.archived, value, setValue,
    attachments: uploads.attachments.map((attachment) => attachment.path), uploading: uploads.uploading,
    snapshotSent, dispatchTarget: dispatchDefault.value, focus: () => textareaRef.current?.focus(),
  });
  // 框顶任何时候只有一行：叫着人时是做法那一行，否则有驳回在等裁定是裁定那一行，都没有才是可以派出去的活
  // （让开不是丢掉，前面的事了了它再回来）。
  const callDock = !!call && (ability.dispatchable || ability.discussable);
  const activeOverride = callDock ? undefined : override ?? suggestion;
  // 借用中且选了一档：正文是那一档的话（或整块换成别的），斜杠、@ 这些都不出。
  const { take, takeInput } = overrideTake(activeOverride);
  // 任务正在跑不再是「不能说话」,而是「说了先排队」:发出去的消息落成一条待发送
  // 消息(mode=queued),这一轮一结束由服务端自动送进同一个会话。真正没得说的情况——不是单任务、
  // 已归档、从没跑过因而没有会话可续——归 replyGate.ts 判。
  const queueing = task.status === "running" || task.status === "queued";
  // 讨论开不开得了：任务在跑时不开（这一轮说的话和讨论的几段会搅在一起），其余由宿主说（已经在讨论了…）。
  const discussHold = queueing ? "任务正在跑，这一轮结束后再开讨论" : discussHeld;
  const gate = replyGate(task, hasConversation, parseCliCommand(target?.agent ?? standing.config.agentType, value));
  // 占位只有「回复…」，水印透出来（reply-1）。快捷键在发送键的提示里，「可以粘贴」在附件键的
  // 提示里，「引导会话」在待发送那一条的键上；发不出去的原因指到发送键上才说。只有没有会话可说话
  // （不是单任务、已归档、还没跑过）时，原因才写在占位里——空框那时没有别处可说。
  const placeholder = gate.notice ?? (call ? CALL_COPY[call.verb].placeholder(call.target.agent) : "回复…");

  const resetComposerState = () => {
    slash.reset();
    mention.reset();
    calling.cancel();
  };

  useEffect(() => {
    resetComposerState();
    setSendError(null);
    setCommandResult(null);
  }, [task.id]);

  // 托盘该少一行由服务端的 task.pendingMessages 事件说了算（useScheduledMessages 里
  // 订阅）。这里只留一道兜底：SSE 断过线时，任务从「在跑」变成别的状态也重拉一次。
  const wasQueueing = useRef(queueing);
  useEffect(() => {
    if (wasQueueing.current && !queueing) void scheduled.reload({ quiet: true });
    wasQueueing.current = queueing;
  }, [queueing, scheduled.reload]);

  // 选模型那个浮层和底部胶囊的候选都取它。讨论要叫另一个执行器：`/讨论` 打开的选人菜单、讨论里再 @ 一个，
  // 都不列这条任务自己的执行器——列着它（还常排第一个），回车一按就成了「只能派出去」。一个别人都没注册，
  // `/讨论` 也就不出。
  const registeredTypes = registeredAgentTypes(profiles);
  const discussTypes = registeredTypes.filter((type) => type !== standing.config.agentType);
  // 叫人的命令（`/讨论`、`/派`）排在技能前面,中间画一条线:前者换的是「谁来干」,
  // 后者只是给这一轮加一句提示词,点错的代价差着量级。
  const naviItems: SlashItem[] = gate.mute ? [] : [
    ...(ability.discussable && discussTypes.length ? [DISCUSS_SLASH_ITEM] : []),
    ...(dispatchable ? [DISPATCH_SLASH_ITEM] : []),
  ].map((item) => ({ ...item, kind: "navi" }));
  // 答题卡展开着（连同它收回去那一下）：平常的框和它的全部浮层都不挂，草稿原样留着（QuestionSlot.tsx）。
  // 框里的工具（选执行器、发送设置、截图批注、更多）跟着框一起卸掉；框外这几层（补全、引用、`@`
  // 之后选模型）在下面逐个按 covering 让开。由宿主开着的那两层顺手关上，收起时不再自己弹回来。
  const takeover = useQuestionTakeover(onAnswer ? task : null);
  // 计划定稿后的「实施此计划？」也照这套占住回复框（PlanReadyCard.tsx）；有题在问、框被别的事接管时让开。
  const planTakeover = usePlanTakeover(task.id, takeover.card || take ? null : readyPlanFor(task, conversationItems ?? []));
  const covering = takeover.covering || planTakeover.covering;
  useEffect(() => {
    if (covering) setAnnotating(false);
  }, [covering]);
  const slash = useReplySlash({
    value, setValue, navi: naviItems, skills: gate.unstarted ? sessionlessSkills(skills) : skills,
    blocked: !!take || covering, sendable: !gate.held, inputRef: textareaRef,
    onCall: (verb, text, caret) => startCallCommand(verb, text, caret),
  });
  const menuOpen = slash.open;
  const candidates = slash.candidates;
  // 正文**开头**敲全了的 `/派 …`、`/讨论 …`：发送 = 叫上次那个人、停在那一种，后面那段留在框里。写在句中的
  // 不算（那是在话里提到这个命令），原样当普通消息发。
  const typedCall = take || call || gate.mute ? null : parseCallCommand(value);
  const callTyped = !!typedCall && (typedCall.verb === "dispatch" ? dispatchable : ability.discussable);
  const menuSends = slash.sends;
  const menuCompletes = slash.completes;
  const commandActive = menuOpen || callTyped;
  const pickingCall = menuOpen ? callCommandVerb(slash.selected?.command) : callTyped ? typedCall!.verb : null;
  const mention = useReplyMention({
    value,
    setValue,
    draft,
    taskId: task.id,
    projectId: task.projectId,
    callable: calling.pickingVerb() === "discuss" ? discussTypes : registeredTypes,
    profilesReady,
    profilesFailed,
    disabled: gate.mute || commandActive || !!take,
    onPickAgent: (agent) => pickMention(agent),
    onPicked: () => textareaRef.current?.focus(),
  });
  // `/派` 先开菜单选人时那份「停在派出去」只活到这张菜单收起（useReplyCall 的 pend）。
  useEffect(() => calling.picking(mention.open), [mention.open]);

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
  // 不跟着「能不能说话」走，只挡真正改不动的：非单飞、已归档、正在发送、正在敲命令。
  const configDisabled = task.mode !== "single" || task.archived || sending || commandActive
    || (!target && !onStandingExecutorChange);

  // `/派`、`/讨论`：叫上次叫过的那个人，停在那一种；框里其余的话原样留着、光标留在原处。从没叫过人（或那个
  // 执行器已经没了，讨论时上次叫的就是这条任务自己的执行器）就在末尾开 `@` 菜单让选，选中的直接停在那一种。
  const startCallCommand = (verb: CallVerb, text: string, caret = text.length) => {
    slash.reset();
    const last = readCallMemory().last;
    if (last && (verb === "discuss" ? discussTypes : registeredTypes).includes(last)) {
      setValue(text);
      calling.start(last, verb);
      slash.caret.place(textareaRef.current, text, caret);
    } else {
      calling.pend(verb);
      const next = !text ? "@" : /\s$/.test(text) ? `${text}@` : `${text} @`;
      setValue(next);
      mention.onValueChange();
      slash.caret.place(textareaRef.current, next, next.length);
    }
  };

  // 不叫人了：胶囊回到这条任务自己的执行器，框顶换回裁定那一行（有的话），写的字一个不动。
  const cancelCall = () => {
    calling.cancel();
    textareaRef.current?.focus();
  };

  // 选中一个智能体：把 @xxx 从正文里摘掉（它是指令不是内容），叫上他——胶囊换成他（上次对他用的那一套），
  // 框顶多出「他来做什么」那一行，默认停在「问一句」。叫着人时再 @ 只是换人，做法不变；讨论时再 @ 是再叫一个
  // （三方，见 toggleDiscussPerson），已经在里面的、这条任务自己的执行器不动。
  const pickMention = (agent: AgentType) => {
    setValue((current) => current.replace(/@[^\s@]*$/, ""));
    mention.reset();
    if (call?.verb === "discuss") {
      if (!discussPeople(call).some((person) => person.agent === agent)) calling.togglePerson(agent);
      return;
    }
    calling.start(agent, call?.verb ?? null);
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
      slash.pick(slash.selected!);
      return false;
    }
    if (!annotation && callTyped) {
      startCallCommand(typedCall!.verb, typedCall!.rest);
      return false;
    }
    if (!annotation && call?.verb === "dispatch") return runDispatch(call);
    if (!annotation && call?.verb === "discuss") return runDiscuss(call);
    // 截图批注是另一条入口：叫着人只在「问一句」时算数，派出去不经过这里。
    const askCall = call?.verb === "ask" ? call : null;
    const askTarget = askCall?.target ?? null;
    if ((annotation ? gate.mute : gate.held) || sending || uploads.uploading || (!annotation && !value.trim() && !uploads.attachments.length)) return false;
    // 还没跑过时发得出去的只有查目标那一句：只带字、立即发，草稿里原有的附件和发送方式不动（服务端不收这两样）。
    const choice = annotation || gate.unstarted ? {} : later.resolve();
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
    const sentPaths = annotation?.attachments ?? (gate.unstarted ? [] : uploads.attachments.map((attachment) => attachment.path));
    // 发送结算只摘这一次提交的那几次选择（路径 + 选择记号），途中又放回的同一张图留着。
    const sentSelection = sentSelections(gate.unstarted ? [] : uploads.attachments);
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
      const dispatchError = await dispatchDefault.settle();
      if (dispatchError) {
        setSendError(dispatchDefault.failedText(dispatchError));
        if (annotation) throw new Error(dispatchError);
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
        if (!gate.unstarted) draft.setLater((current) => (current === laterAtSend ? null : current));
      }
      if (askCall) calling.sent(askCall);
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
  // （不排队）。讨论：各方来回几段，开不开得了看 `discussHold`。失败时人、做法、正文和附件全留着，说清楚哪儿没成。
  const runDispatch = (current: ReplyCall) => !onDispatch || baseContext.status !== "ready" || !dispatchReview ? Promise.resolve(false)
    : runCall(current, (text, attachments) => onDispatch({ text, attachments, target: current.target, worktreeBase, review: dispatchReview }));
  // 讨论里这条任务的执行器按发起那一刻的常设配置说话（服务端记进参与者）：刚改完执行器就开，先等写回落地。
  const runDiscuss = (current: ReplyCall) => !onDiscuss || discussHold ? Promise.resolve(false)
    : runCall(current, async (topic, attachments) => {
      const standingError = await standing.settle();
      if (standingError) throw new Error(`执行器没能改过去（${standingError}），讨论先没开。重选一次执行器再开。`);
      await onDiscuss({ topic, attachments, rounds: current.rounds, people: discussPeople(current) });
    });
  const runCall = async (current: ReplyCall, act: (text: string, attachments: string[]) => Promise<void>): Promise<boolean> => {
    const text = value.trim();
    if (gate.mute || sending || uploads.uploading || !text) return false;
    setSending(true);
    setSendError(null);
    setCommandResult(null);
    const draftAtSend = { text: value, textVersion: draft.value.textVersion };
    const sentSelection = sentSelections(uploads.attachments);
    try {
      await act(text, uploads.attachments.map((attachment) => attachment.path));
      clearSent(draftAtSend, sentSelection);
      calling.sent(current);
      return true;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSending(false);
    }
  };

  // 撤回：取下排着的那条，正文、附件、当初叫的人、「稍后」的设定一并放回框里（withdrawDraft.ts）。
  const withdraw = (message: ScheduledMessage) => withdrawIntoBox(message, {
    cancel: scheduled.cancel, draft, restoreCall: calling.restore, restoreLater: later.restore,
    focus: () => textareaRef.current?.focus(),
  });

  return (
    <div ref={shellRef} className="task-reply-shell">
      {menuOpen && (
        <SlashMenu
          className="task-reply-command-menu"
          ariaLabel="斜杠命令与技能"
          hint={`${MENU_HEADING[candidates[0]!.kind]}↑↓ 选择，回车${menuSends ? "发送" : menuCompletes ? "补全" : "确认"}，Esc 取消`}
          items={candidates}
          selectedIndex={slash.selectedIndex}
          token={slash.token}
          onHover={slash.setIndex}
          onPick={slash.pick}
        />
      )}
      {mention.open && !menuOpen && !covering && (
        <InputMentionMenu mention={mention} label="召唤智能体或引用随手记、文件" className="task-reply-mention-menu" />
      )}
      <div className="reply-context">
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
        onOpenTask={onOpenTask}
        monitors={monitors}
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
      {onAnswer && <QuestionDock takeover={takeover} onAnswer={onAnswer} attachable onLaunchPlan={dispatchDefault.gateLaunch(onLaunchPlan)}
        dispatchTarget={dispatchDefault.value} />}
      {planTakeover.ready && <div className="question-dock">
        <PlanReadyCard key={planTakeover.ready.plan.id} takeover={planTakeover}
          onImplement={(ready) => sendToPlanner(ready, `/plan implement ${ready.plan.id}`, [])}
          onRevise={sendToPlanner} />
      </div>}
      {!covering && <div className="task-reply-box">
        <ReplyResizeHandle targetRef={textareaRef} {...replyHeight} />
        <AgentPlate name={activeAgent} />
        {call && callDock
          ? <ReplyCallDock call={call} self={calling.self} ability={ability} onVerb={calling.setVerb} onCancel={cancelCall}
            baseError={baseContext.error} onRetryBase={baseContext.retry} />
          : activeOverride?.head}
        {/* 输入几行就撑几行高,撑到上限为止;拖过之后至少是拖出来的高度(拖动条自己的上限更宽)。 */}
        <ComposerInput
          inputRef={textareaRef}
          value={takeInput?.value ?? value}
          floor={replyHeight.height}
          quoteTarget={task.id}
          rows={3}
          hidden={!!take && !takeInput}
          disabled={!!gate.closed && !takeInput}
          readOnly={takeInput?.readOnly}
          placeholder={takeInput?.placeholder ?? placeholder}
          aria-label={takeInput?.label ?? "回复任务"}
          onChange={(event) => {
            const next = event.target.value;
            slash.caret.read(event.target);
            if (takeInput) return takeInput.onChange(next);
            setValue(next);
            slash.reset();
            mention.onValueChange();
          }}
          {...slash.caret.inputProps}
          onPaste={(take ? !activeOverride?.attachable : gate.mute) ? undefined : uploads.onPaste}
          onKeyDown={(event) => {
            if (overrideKeyDown(activeOverride, event)) return;
            if (slash.onKeyDown(event, () => void send(), () => setValue(""))) return;
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
          <AttachmentPicker addFiles={uploads.addFiles} disabled={gate.mute || sending || commandActive || (!!take && !activeOverride?.attachable)} />
          {actions}
          {/* 截图批注、预览日志用得少，收进「更多」。 */}
          <IconMenu side="above" buttonRef={moreButton} className="task-reply-more" items={[
            { label: draft.screenshot ? "继续批注" : "截图批注", icon: <PencilSimple size={15} />,
              disabled: gate.mute || sending || uploads.uploading || commandActive, onPick: () => setAnnotating(true) },
            ...moreItems,
          ]} />
          <ScreenshotAnnotation key={task.id} taskId={task.id} open={annotating} onOpenChange={setAnnotating} returnFocusRef={moreButton}
            candidates={screenshotCandidates(conversationItems, [...parseAttachmentText(task.body).paths, ...uploads.attachments.map((attachment) => attachment.path)])}
            disabled={gate.mute || sending || uploads.uploading || commandActive} queueing={queueing}
            executorLabel={activeExecutorLabel} onSend={(reply) => runSend(reply)} />
          <span className="task-reply-actions-gap" aria-hidden="true" />
          {/* 一颗三段胶囊：智能体 · 模型 · 智能水平。可单独改任一段，也可选完前一段后向右接着配置；跟新建
              面板、工作流站点用同一组件。没叫人时改它 = 改任务的常设配置，之后每条消息都按新的跑；叫着人时
              它就是被叫的那个人（改的是这一次），派出去时最后多一段「从哪开工」，小叉 = 不叫了。 */}
          {take && activeOverride?.bare ? null : call?.verb === "discuss" ? (
            <DiscussCapsule call={call} types={registeredTypes.length ? registeredTypes : [activeAgent]} profiles={profiles}
              ownAgent={standing.config.agentType} disabled={configDisabled} model={activeModel ?? null} effort={activeEffort ?? ""}
              onToggle={calling.togglePerson} onRounds={calling.setRounds} onCommit={calling.commitTarget} onEffortChange={calling.commitEffort} />
          ) : <RunTargetPicker
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
              : !target && dispatchDefault.value ? <DispatchDefaultSegment value={dispatchDefault.value} profiles={profiles} /> : undefined}
            // 没叫人时点开智能体那一段，列表下面一行「派出去的活交给谁」。
            agentExtra={!target && onDispatchTargetChange ? <DispatchDefaultRow value={dispatchDefault.value}
              here={standing.config} types={registeredTypes.length ? registeredTypes : [activeAgent]} profiles={profiles}
              disabled={configDisabled} onChange={dispatchDefault.commit} /> : undefined}
          />}
          {target && <CallCancelKey agent={target.agent} onCancel={cancelCall} />}
          {call && dispatching && !(take && activeOverride?.bare) && <CallReviewerChip call={call} list={reviewerList} disabled={configDisabled} onChange={calling.setReview} />}
          <ReplySendKey
            overrideSend={take ? activeOverride!.send : null}
            call={call}
            callHeld={call?.verb === "discuss" ? discussHold : baseContext.status === "loading" ? "正在确认新任务从哪开工"
              : baseContext.status === "failed" ? "确认不了新任务从哪开工，先重试" : dispatchReviewHold}
            later={gate.unstarted ? nowOnly : later}
            text={value}
            attachments={gate.unstarted ? 0 : uploads.attachments.length}
            uploading={uploads.uploading ? uploadingLabel(uploads.pending) : null}
            queueing={queueing}
            sending={sending}
            // 还没跑过时把命令补进正文不算发送，照点；补全之后发不发得出去再按正文说。
            blocked={menuCompletes ? null : gate.held}
            // 敲着命令时这颗键干的是别的事：补全命令、叫人派出去或讨论。
            override={menuCompletes ? { text: "补全", action: "把命令补进正文" }
              : pickingCall ? { text: "叫人", action: `叫上次那个人，停在${CALL_COPY[pickingCall].label}` } : null}
            onSend={() => void send()}
            onStop={onStop ? () => {
              setStopping(true);
              void onStop().finally(() => setStopping(false));
            } : undefined}
            // 停止键出不出、能不能点只看服务端的停止结论（onStop / stopBlocked）；这里只挑提示里那句话。
            stopTip={["queued", "paused", "backlog"].includes(task.status) ? "不排了" : "停止这一轮"}
            stopBlocked={stopBlocked}
            stopping={stopping}
            configDisabled={gate.mute || sending || uploads.uploading || commandActive || mention.open}
            tasks={tasks}
            projectId={task.projectId}
            taskId={task.id}
          />
        </div>
      </div>}
    </div>
  );
}
