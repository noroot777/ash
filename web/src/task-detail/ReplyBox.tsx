import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, ScheduledMessage, SkillEntry, Task, TaskListItem } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { parseCliCommand } from "@ash/shared/cli-commands";
import { X } from "@phosphor-icons/react";
import { ScheduledMessageTray, useScheduledMessages } from "../components/ScheduledMessages.tsx";
import { LaterSendKey, useLaterSend } from "../components/LaterSend.tsx";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { AgentPlate } from "../components/AgentPlate.tsx";
import {
  ReplyResizeHandle,
  SINGLE_REPLY_PIN,
  useReplyHeight,
} from "./ReplyResizeHandle.tsx";
import { executorRunSummary, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { useReplyLayout } from "./useReplyLayout.ts";
import { isMenuPickKeyEvent, isSendKeyEvent } from "../lib/sendKey.ts";
import { api, type ReplyTaskResult } from "../lib/api.ts";
import { useProviders } from "../lib/modelCatalog.ts";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import { AttachmentPicker, UploadAttachmentList, uploadingLabel, useAttachments } from "./Attachments.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { MentionMenu } from "../components/MentionMenu.tsx";
import { useReplyMention } from "./replyMention.ts";
import { applySlashPick, mergeSlashItems, slashQuery, slashSendsAsTyped, slashToken, type SlashItem } from "../lib/useSkills.ts";
import type { AgentModelSelection, MentionTarget } from "./mentionPicker.ts";
import { useStandingExecutor, type StandingExecutor } from "./useStandingExecutor.ts";
import { registerReplyInput } from "./replyQuote.ts";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { ScreenshotAnnotation } from "../page-annotation/ScreenshotAnnotation.tsx";
import { screenshotCandidates, type AnnotationReply } from "../page-annotation/model.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { parseAttachmentText } from "./utils.ts";
import {
  attachmentsFromPaths,
  clearSentDraft,
  dropSentAttachments,
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
  onStandingExecutorChange,
  command,
  skills = EMPTY_SKILLS,
  inlinePanel,
  topRail,
  conversationItems = [],
  tasks = [],
}: {
  task: Task;
  hasConversation: boolean;
  onSend: (
    text: string,
    attachments: string[],
    options: {
      agent?: AgentType;
      executorId?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
      sendAt?: string;
      afterTaskId?: string;
      // 只用于显示:这一回合会由谁跑。服务端不认这个字段(调用方要摘掉再发),
      // 它补的是「消息已发出、会话行还没落库」那一两秒里横幅没名字可报的空窗。
      executorLabel?: string | null;
    },
    // 返回 null = **这一句没送出去,而且不是错误**(典型:换执行器的确认框被取消)。
    // 输入框里的字、附件、@选中的执行器全部原样留着，用户点一下就能重来。
  ) => Promise<ReplyTaskResult | null>;
  /**
   * 停掉这一轮（在跑）或不排了（排着队）。给了才有停止键：任务头上不再有停止，它就是发送键的
   * 另一面（docs/ui-ux-audit reply-4）。
   */
  onStop?: () => Promise<void>;
  /**
   * 点胶囊改执行器/模型/智能水平 = 改**这个任务以后都用谁**，由调用方写回任务
   * （PATCH /tasks/:id）。不传就只剩 `@` 那条一次性召唤，胶囊变成只读。
   * `label` 只是提示文案用的执行器名，别当业务字段使。
   */
  onStandingExecutorChange?: (next: StandingExecutor, label: string) => Promise<void>;
  command?: {
    matches: (text: string) => boolean;
    onSubmit: (text: string) => void;
    onChange?: (text: string) => void;
    onCancel?: () => void;
    resetKey?: number;
    items: { command: string; label: string; hint?: string }[];
  };
  // 当前执行器已装的技能。选中只把 `/名字` 补进正文，不把它当派生命令截走；
  // server 会在运行这一回合前注入对应 SKILL.md。
  skills?: SkillEntry[];
  inlinePanel?: ReactNode;
  topRail?: ReactNode;
  conversationItems?: ConversationItem[];
  /** 「等某任务完成后发送」的候选,以及托盘里报出在等谁。 */
  tasks?: TaskListItem[];
}) {
  const draft = useTaskReplyDraft(task.id);
  const shellRef = useReplyLayout();
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
  // 一次性召唤：正文里 `@某个智能体` 选出来的「就这一句由谁跑」。只随这一次 reply
  // 发出、发完即清，不落任务 —— 「以后都用谁」是另一件事，见下面的 standing。
  const [target, setTarget] = useState<MentionTarget | null>(null);
  // 只剩 `@` 那条路会开这个浮层：正文里选中智能体之后紧接着选模型。点胶囊改配置由
  // 胶囊自己管（三段各开各的浮层，见 components/RunTargetPicker.tsx）。
  const [picker, setPicker] = useState<{ agent: AgentType } | null>(null);
  const later = useLaterSend(draft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // null = 没拖过,交给行数自动撑高(useAutoGrowTextarea)
  const replyHeight = useReplyHeight(SINGLE_REPLY_PIN);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [profilesFailed, setProfilesFailed] = useState(false);
  const providers = useProviders();
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
  const scheduled = useScheduledMessages(task.id);
  const uploads = useAttachments({
    value: draft.attachments,
    onChange: draft.setAttachments,
    pending: draft.pendingUploads,
    onPendingChange: draft.setPendingUploads,
  });
  // 输入几行就撑几行高,撑到上限为止;拖过之后以拖出来的高度为准(拖动条自己的上限更宽)。
  useAutoGrowTextarea(textareaRef, { value, pinned: replyHeight.height });
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
  const placeholder = inputDisabled && reason ? reason : "回复…";

  const resetComposerState = () => {
    setCommandIndex(0);
    setMenuDismissed(false);
    mention.reset();
    setTarget(null);
    setPicker(null);
  };

  useEffect(() => {
    resetComposerState();
    setSendError(null);
    setCommandResult(null);
  }, [task.id]);

  // 会话里选中一段话点「添加到对话」时，浮条要把光标送回这个输入框（见 replyQuote.ts）。
  useEffect(() => registerReplyInput(task.id, textareaRef.current), [task.id]);

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

  useEffect(() => {
    let alive = true;
    setProfilesReady(false);
    setProfilesFailed(false);
    api.agents().then(
      (nextProfiles) => { if (alive) setProfiles(nextProfiles); },
      () => {
        if (!alive) return;
        setProfiles([]);
        setProfilesFailed(true);
      },
    ).finally(() => { if (alive) setProfilesReady(true); });
    return () => { alive = false; };
  }, []);

  // 派生命令(ash 自己的)排在技能前面,中间画一条线:前者换的是「谁来干」,
  // 后者只是给这一轮加一句提示词,点错的代价差着量级。
  const ashItems: SlashItem[] = (command?.items ?? []).map((item) => ({ ...item, kind: "ash" }));
  const commandCandidates = (text: string) => mergeSlashItems(ashItems, skills, slashQuery(text));
  const candidates = commandCandidates(value);
  const menuOpen = !menuDismissed && candidates.length > 0;
  const selectedIndex = Math.min(commandIndex, Math.max(0, candidates.length - 1));
  const commandMatch = !!command && command.matches(value);
  const selected = candidates[selectedIndex];
  // 菜单开着时回车做什么:ash 命令打开派生配置;技能和原生命令补全进正文;
  // 原生命令已经敲全就直接发(它本来就是发给 CLI 的一句话)。
  const menuSends = menuOpen && slashSendsAsTyped(selected, value);
  const menuCompletes = menuOpen && !menuSends && selected?.kind !== "ash";
  const commandActive = commandMatch || menuOpen;
  // 选模型那个浮层和底部胶囊的候选都取它；`@` 那张菜单里的智能体候选在 replyMention.ts
  // 里自己算（它还要按 token 过滤）。
  const registeredTypes = registeredAgentTypes(profiles);
  const mention = useReplyMention({
    value,
    setValue,
    taskId: task.id,
    profiles,
    profilesReady,
    profilesFailed,
    disabled: disabled || commandActive || !!picker,
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
    command?.onSubmit(item.command);
    setValue("");
    setCommandIndex(0);
    setMenuDismissed(false);
    setTarget(null);
  };

  const cancelCommand = () => {
    setValue("");
    setCommandIndex(0);
    setMenuDismissed(true);
    command?.onChange?.("");
    command?.onCancel?.();
  };

  // 第一步选中智能体：把 @xxx 从正文里摘掉（它是指令不是内容），紧接着弹第二步选模型。
  const pickMention = (agent: AgentType) => {
    setValue((current) => current.replace(/@[^\s@]*$/, ""));
    mention.reset();
    setPicker({ agent });
  };

  // 选完智能体和模型：执行器没换就把已选的智能水平留着（用户只是换了个模型），
  // 换了执行器才清成「跟随」——旧档位在新 CLI 上多半根本不存在。
  const commitTarget = (next: AgentModelSelection) => {
    setTarget((current) => {
      const previous = {
        agentType: current?.agent ?? activeAgent,
        executorId: current ? current.executorId : standing.config.executorId,
      };
      const kept = current ? current.reasoningEffort : standing.config.reasoningEffort;
      return {
        ...next,
        reasoningEffort: sameExecutor({ agentType: next.agent, executorId: next.executorId }, previous)
          ? kept
          : null,
      };
    });
    setPicker(null);
    textareaRef.current?.focus();
  };

  // 只改智能水平也算「本回合这么跑」：没召唤过就以任务当前配置为底稿建一份覆盖，
  // 免得用户点了档位却什么都没发生。
  const commitEffort = (effort: string) => {
    setTarget((current) => ({
      agent: current?.agent ?? activeAgent,
      executorId: current ? current.executorId : standing.config.executorId,
      model: current ? current.model : standing.config.model,
      reasoningEffort: effort || null,
    }));
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

  // 正在飞的那一次发送。撤回要排在它后面（见下面的 withdraw）：清空和合并谁先谁后
  // 一旦确定，就不必再去草稿里猜哪一段是刚发出去的。
  const inFlightSend = useRef<Promise<void> | null>(null);

  const send = (): Promise<void> => {
    const run = runSend().then(() => {});
    inFlightSend.current = run;
    void run.finally(() => {
      if (inFlightSend.current === run) inFlightSend.current = null;
    });
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
    // 发出去的是这一份。成功后只在草稿**逐字还是这一份**时才清掉；动过就整份留着，
    // 绝不去猜哪一段是刚发出去的（见 withdrawDraft.ts 的 clearSentDraft）。
    const draftAtSend = value;
    const laterAtSend = draft.later;
    const sentText = annotation?.text ?? value.trim();
    const sentPaths = annotation?.attachments ?? uploads.attachments.map((attachment) => attachment.path);
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
          agent: target?.agent,
          executorId: target?.executorId ?? null,
          model: target?.model ?? null,
          reasoningEffort: target?.reasoningEffort ?? null,
          sendAt: choice.sendAt,
          afterTaskId: choice.afterTaskId,
          executorLabel: activeExecutorLabel,
        },
      );
      if (result === null) return false; // 用户主动取消：什么都别清
      if ("scheduled" in result) scheduled.add(result.message);
      if ("command" in result && !result.recorded && currentTaskId.current === task.id) setCommandResult({ taskId: task.id, text: result.text });
      if (!annotation) {
        setValue((current) => clearSentDraft(current, draftAtSend));
        draft.setAttachments((current) => dropSentAttachments(current, sentPaths));
        uploads.clearError();
        // 发送方式跟正文同口径：发送途中被改过就留着，那是下一条的设置。
        draft.setLater((current) => (current === laterAtSend ? null : current));
      }
      setTarget(null);
      return true;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
      if (annotation) throw error;
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
    await inFlightSend.current;
    setValue((current) => joinDraftText(message.text, current));
    draft.setAttachments((current) => mergeAttachments(attachmentsFromPaths(message.attachments), current));
    if (message.agent) {
      setTarget({
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
    <div ref={shellRef} className={`task-reply-shell${topRail ? " has-top-rail" : ""}`}>
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
      {mention.open && !menuOpen && (
        <MentionMenu
          className="task-reply-mention-menu"
          ariaLabel="召唤智能体或引用文件"
          hint={mention.hint}
          rows={mention.rows}
          token={mention.token}
          status={mention.status}
          selectedIndex={mention.index}
          onHover={mention.setIndex}
          onPick={mention.pick}
        />
      )}
      {picker && (
        <AgentModelPicker
          types={registeredTypes.length ? registeredTypes : [activeAgent]}
          profiles={profiles}
          providers={providers}
          initialStage="model"
          initialAgent={picker.agent}
          currentExecutorId={activeExecutorId}
          triggerRef={textareaRef}
          onCommit={commitTarget}
          onCancel={() => {
            setPicker(null);
            textareaRef.current?.focus();
          }}
        />
      )}
      <div className="reply-context">
      {inlinePanel && !menuOpen && !mention.open && !picker && <div className="task-reply-inline-panel">{inlinePanel}</div>}
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
      <UploadAttachmentList
        attachments={uploads.attachments}
        pending={uploads.pending}
        error={uploads.error}
        onRemove={uploads.remove}
        onCancel={uploads.cancel}
      />
      {sendError && <p className="task-reply-error">{sendError}</p>}
      {commandResult?.taskId === task.id && <p className="task-reply-command-result" role="status" aria-label="命令结果">{commandResult.text}</p>}
      {topRail}
      </div>
      <div className="task-reply-box">
        <ReplyResizeHandle targetRef={textareaRef} {...replyHeight} />
        <AgentPlate name={activeAgent} />
        <textarea
          ref={textareaRef}
          value={value}
          rows={3}
          disabled={inputDisabled}
          placeholder={placeholder}
          aria-label="回复任务"
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            setMenuDismissed(false);
            setCommandIndex(0);
            mention.onValueChange();
            command?.onChange?.(commandCandidates(next).length > 0 ? "" : next);
          }}
          onPaste={uploads.onPaste}
          onKeyDown={(event) => {
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
            if (isSendKeyEvent(event)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="task-reply-actions">
          <AttachmentPicker addFiles={uploads.addFiles} disabled={disabled || sending || commandActive} />
          <ScreenshotAnnotation key={task.id} taskId={task.id}
            candidates={screenshotCandidates(conversationItems, [...parseAttachmentText(task.body).paths, ...uploads.attachments.map((attachment) => attachment.path)])}
            disabled={disabled || sending || uploads.uploading || commandActive} queueing={queueing}
            executorLabel={activeExecutorLabel} onSend={(reply) => runSend(reply)} />
          {/* 一颗三段胶囊：智能体 · 模型 · 智能水平。可单独改任一段，也可选完前一段后
              向右接着配置；跟新建面板、工作流站点用同一组件。
              没在 @ 召唤时改它 = 改任务的常设配置，之后每条消息都按新的跑；正在召唤
              （target 非空）时改的是这一次召唤本身，点 × 取消就回到常设配置。 */}
          <RunTargetPicker
            label={target ? "本回合由谁来跑" : "这个任务以后由谁来跑"}
            types={registeredTypes.length ? registeredTypes : [activeAgent]}
            profiles={profiles}
            selection={{ agentType: activeAgent, executorId: activeExecutorId }}
            model={activeModel ?? null}
            effort={activeEffort ?? ""}
            variant="chip"
            highlight={!!target}
            disabled={configDisabled}
            onCommit={target ? commitTarget : commitStanding}
            onEffortChange={target ? commitEffort : commitStandingEffort}
          />
          {target && (
            <button
              type="button"
              className="task-reply-chip-reset"
              aria-label={`取消召唤 ${target.agent}，恢复任务默认`}
              onClick={() => setTarget(null)}
            >
              <X size={10} weight="bold" />
            </button>
          )}
          <LaterSendKey
            later={later}
            action="发送回复"
            empty={!value.trim() && !uploads.attachments.length && !uploads.uploading}
            running={queueing}
            uploading={uploads.uploading ? uploadingLabel(uploads.pending) : null}
            // 敲着命令时这颗键干的是别的事：补全命令、打开派生配置。归档的任务也能派生，所以不受下面那条拦。
            override={menuCompletes ? { text: "补全", action: "把命令补进正文" }
              : commandActive && !menuSends ? { text: "配置", action: "打开派生配置" } : null}
            blocked={disabled ? reason ?? "现在发不出去" : null}
            busy={sending}
            onSend={() => void send()}
            onStop={onStop ? () => {
              setStopping(true);
              void onStop().finally(() => setStopping(false));
            } : undefined}
            stopTip={task.status === "queued" ? "不排了" : "停止这一轮"}
            stopBusy={stopping}
            configDisabled={disabled || sending || uploads.uploading || commandActive || mention.open}
            tasks={tasks}
            projectId={task.projectId}
            taskId={task.id}
          />
        </div>
      </div>
    </div>
  );
}
