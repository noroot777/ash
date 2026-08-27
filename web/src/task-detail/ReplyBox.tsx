import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, ScheduledMessage, SkillEntry, Task } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { ArrowUp, Clock, Robot, SpinnerGap, X } from "@phosphor-icons/react";
import {
  ScheduledMessageTray,
  ScheduledSendPanel,
  useScheduledMessages,
} from "../components/ScheduledMessages.tsx";
import { defaultOnceTime, toLocalDateTime } from "../components/ScheduleControl.tsx";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { AgentPlate } from "../components/AgentPlate.tsx";
import {
  ReplyResizeHandle,
  readStoredReplyHeight,
  storeReplyHeight,
} from "./ReplyResizeHandle.tsx";
import { executorRunSummary, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api, type ReplyTaskResult } from "../lib/api.ts";
import { useProviders } from "../lib/modelCatalog.ts";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "./Attachments.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { mergeSlashItems, slashToken, type SlashItem } from "../lib/useSkills.ts";
import type { AgentModelSelection, MentionTarget } from "./mentionPicker.ts";
import { useTaskReplyDraft } from "./TaskReplyDrafts.tsx";
import { attachmentsFromPaths, joinDraftText, mergeAttachments } from "./withdrawDraft.ts";

const EMPTY_SKILLS: SkillEntry[] = [];

export function ReplyBox({
  task,
  hasConversation,
  onSend,
  command,
  skills = EMPTY_SKILLS,
  inlinePanel,
  topRail,
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
      // 只用于显示:这一回合会由谁跑。服务端不认这个字段(调用方要摘掉再发),
      // 它补的是「消息已发出、会话行还没落库」那一两秒里横幅没名字可报的空窗。
      executorLabel?: string | null;
    },
  ) => Promise<ReplyTaskResult>;
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
}) {
  const draft = useTaskReplyDraft(task.id);
  const value = draft.text;
  const setValue = draft.setText;
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [target, setTarget] = useState<MentionTarget | null>(null);
  // 只剩 `@` 那条路会开这个浮层：正文里选中智能体之后紧接着选模型。点胶囊改配置由
  // 胶囊自己管（三段各开各的浮层，见 components/RunTargetPicker.tsx）。
  const [picker, setPicker] = useState<{ agent: AgentType } | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const scheduleTriggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // null = 没拖过,交给 rows 撑出自然高度
  const [replyHeight, setReplyHeight] = useState<number | null>(readStoredReplyHeight);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [profilesFailed, setProfilesFailed] = useState(false);
  const providers = useProviders();
  const scheduled = useScheduledMessages(task.id);
  const uploads = useAttachments({
    value: draft.attachments,
    onChange: draft.setAttachments,
    pending: draft.pendingUploads,
    onPendingChange: draft.setPendingUploads,
  });
  // 任务正在跑不再是「不能说话」,而是「说了先排队」:发出去的消息落成一条待发送
  // 消息(mode=queued),这一轮一结束由服务端自动送进同一个会话。所以 disabled 只留
  // 真正没得说的情况——不是单任务、已归档、以及从没跑过因而没有会话可续。
  const queueing = task.status === "running" || task.status === "queued";
  const disabled = task.mode !== "single" || task.archived || (!hasConversation && !queueing);
  const inputDisabled = disabled && !command;
  const reason = task.mode !== "single"
    ? "请在对应的团队或讨论页面继续操作"
    : task.archived
      ? command ? "任务已归档；仍可输入 /team 或 /duet 创建派生任务…" : "任务已归档，无法继续回复"
      : queueing
        ? command ? "任务进行中；发送即排队，队尾可点“引导会话”；也可输入 /team 或 /duet…" : "任务进行中，发送即排队；需要立即接入当前对话可在队尾点“引导会话”（⌘↵）…"
        : !hasConversation
          ? command ? "可输入 /team 创建团队，或输入 /duet 发起讨论…" : "先运行任务，再继续回复"
          : command ? "回复并继续；输入 /team 或 /duet 可派生新任务…" : "回复并继续（⌘↵ 发送，可粘贴图片或文件）…";

  const resetComposerState = () => {
    setCommandIndex(0);
    setMenuDismissed(false);
    setMentionIndex(0);
    setMentionDismissed(false);
    setTarget(null);
    setPicker(null);
    setScheduleOpen(false);
    setSendAt("");
  };

  useEffect(() => {
    resetComposerState();
    setSendError(null);
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
  const commandCandidates = (text: string) => mergeSlashItems(ashItems, skills, slashToken(text));
  const candidates = commandCandidates(value);
  const firstSkillIndex = candidates.findIndex((item) => item.kind === "skill");
  const menuOpen = !menuDismissed && candidates.length > 0;
  const selectedIndex = Math.min(commandIndex, Math.max(0, candidates.length - 1));
  const commandMatch = !!command && command.matches(value);
  const selectedIsSkill = candidates[selectedIndex]?.kind === "skill";
  const commandActive = commandMatch || menuOpen;
  const mentionMatch = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(value);
  const registeredTypes = registeredAgentTypes(profiles);
  const mentionCandidates = mentionMatch
    ? registeredTypes.filter((type) => type.startsWith((mentionMatch[1] ?? "").toLowerCase()))
    : [];
  const mentionOpen = !disabled && !commandActive && !picker && !mentionDismissed && !!mentionMatch;
  const selectedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1));

  // 底部胶囊上显示的「这一回合会由谁、用什么模型跑」：@ 选过就是那一套，
  // 没选就是任务自己的常设配置（executorId 为空时按类型默认执行器降级，与服务端
  // resolveExecutorFor 同一条口径）。
  const activeAgent = (target?.agent ?? task.agentType ?? "claude") as AgentType;
  const activeExecutorId = (target ? target.executorId : task.executorId)
    ?? profiles.find((profile) => profile.type === activeAgent && profile.isDefault)?.id
    ?? null;
  const summary = executorRunSummary(
    { agentType: activeAgent, executorId: activeExecutorId },
    profiles,
    {
      model: target ? target.model : task.model,
      effort: target ? target.reasoningEffort : task.reasoningEffort,
    },
  );
  const activeModel = summary.model;
  const activeEffort = summary.effort;
  // 胶囊上写着谁,这一回合就该由谁跑——横幅在会话行落库前先照抄这个名字,
  // 免得它去报任务的常设执行器(@grok 干活时报 codex 就是这么来的)。
  const activeExecutorLabel = profiles.find((profile) => profile.id === activeExecutorId)?.name
    ?? activeAgent;

  const pickCommand = (item: SlashItem) => {
    // 技能不是派生命令:它只是**补全**。`/名字` 原样留在正文里跟着这一轮发下去,
    // server 会据此注入 SKILL.md，所以这里绝不能把它截走。
    if (item.kind === "skill") {
      const next = `${item.command} `;
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
    setScheduleOpen(false);
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
    setValue((current) => current.replace(/@[a-z0-9_-]*$/i, ""));
    setMentionIndex(0);
    setMentionDismissed(false);
    setPicker({ agent });
  };

  // 选完智能体和模型：执行器没换就把已选的智能水平留着（用户只是换了个模型），
  // 换了执行器才清成「跟随」——旧档位在新 CLI 上多半根本不存在。
  const commitTarget = (next: AgentModelSelection) => {
    setTarget((current) => {
      const previous = {
        agentType: current?.agent ?? activeAgent,
        executorId: current ? current.executorId : task.executorId ?? null,
      };
      const kept = current ? current.reasoningEffort : task.reasoningEffort ?? null;
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
      executorId: current ? current.executorId : task.executorId ?? null,
      model: current ? current.model : task.model ?? null,
      reasoningEffort: effort || null,
    }));
  };

  const send = async (scheduledAt?: string) => {
    if (menuOpen) {
      pickCommand(candidates[selectedIndex]!);
      return;
    }
    if (commandMatch) {
      pickCommand({ command: value.trim(), label: "", kind: "ash" });
      return;
    }
    if (disabled || sending || uploads.uploading || (!value.trim() && !uploads.attachments.length)) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await onSend(
        value.trim(),
        uploads.attachments.map((attachment) => attachment.path),
        {
          agent: target?.agent,
          executorId: target?.executorId ?? null,
          model: target?.model ?? null,
          reasoningEffort: target?.reasoningEffort ?? null,
          sendAt: scheduledAt,
          executorLabel: activeExecutorLabel,
        },
      );
      if ("scheduled" in result) scheduled.add(result.message);
      setValue("");
      uploads.clear();
      setTarget(null);
      setScheduleOpen(false);
      setSendAt("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const scheduledTime = new Date(sendAt).getTime();
  const canSchedule = Number.isFinite(scheduledTime)
    && scheduledTime > Date.now()
    && (!!value.trim() || uploads.attachments.length > 0);

  // 撤回:先把消息从队列上取下来(失败就什么都不动,免得内容一式两份),成功后正文、
  // 附件、这条消息当初 @ 指派的执行器配置一并放回对话框——发它时是什么样,撤回后就
  // 还是什么样,用户接着改就行。定时消息连原定时间也留着(还没到点才留)。
  const withdraw = async (message: ScheduledMessage) => {
    if (!await scheduled.cancel(message.id)) return;
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
    if (message.mode === "timed" && new Date(message.sendAt).getTime() > Date.now()) {
      setSendAt(toLocalDateTime(new Date(message.sendAt)));
    }
    textareaRef.current?.focus();
  };

  return (
    <div className={`task-reply-shell${topRail ? " has-top-rail" : ""}`}>
      {menuOpen && (
        <SlashMenu
          className="task-reply-command-menu"
          ariaLabel="斜杠命令与技能"
          hint={`${firstSkillIndex === 0 ? "技能" : "派生命令与技能"} · ↑↓ 选择，回车${selectedIsSkill ? "补全" : "确认"}，Esc 取消`}
          items={candidates}
          selectedIndex={selectedIndex}
          token={slashToken(value)}
          onHover={setCommandIndex}
          onPick={pickCommand}
        />
      )}
      {mentionOpen && !menuOpen && (
        <div className="task-reply-mention-menu" role="listbox" aria-label="召唤智能体">
          <small>召唤智能体加入 · ↑↓ 选择，回车后继续选模型</small>
          {!profilesReady && <p>正在读取已注册智能体…</p>}
          {profilesFailed && <p>执行器列表读取失败，暂不提供候选</p>}
          {profilesReady && !profilesFailed && mentionCandidates.length === 0 && <p>没有匹配的已注册智能体</p>}
          {mentionCandidates.map((agent, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedMentionIndex}
              key={agent}
              onMouseEnter={() => setMentionIndex(index)}
              onClick={() => pickMention(agent)}
            >
              <Robot size={14} aria-hidden="true" />
              <b>@{agent}</b>
            </button>
          ))}
        </div>
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
      {scheduleOpen && !menuOpen && !mentionOpen && !picker && (
        <ScheduledSendPanel
          value={sendAt}
          busy={sending}
          canSubmit={canSchedule}
          triggerRef={scheduleTriggerRef}
          onChange={setSendAt}
          onCancel={() => setScheduleOpen(false)}
          onSubmit={() => void send(new Date(sendAt).toISOString())}
        />
      )}
      {inlinePanel && !menuOpen && !mentionOpen && !picker && !scheduleOpen && <div className="task-reply-inline-panel">{inlinePanel}</div>}
      <ScheduledMessageTray
        messages={scheduled.messages}
        loading={scheduled.loading}
        error={scheduled.error}
        cancelingIds={scheduled.cancelingIds}
        steeringIds={scheduled.steeringIds}
        onSteer={(messageId) => void scheduled.steer(messageId)}
        onWithdraw={(message) => void withdraw(message)}
      />
      <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
      {sendError && <p className="task-reply-error">{sendError}</p>}
      {topRail}
      <div className="task-reply-box">
        <ReplyResizeHandle
          targetRef={textareaRef}
          height={replyHeight}
          onChange={(next) => {
            setReplyHeight(next);
            storeReplyHeight(next);
          }}
        />
        <AgentPlate name={activeAgent} />
        <textarea
          ref={textareaRef}
          value={value}
          rows={3}
          style={replyHeight === null ? undefined : { height: replyHeight }}
          disabled={inputDisabled}
          placeholder={reason}
          aria-label="回复任务"
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            setMenuDismissed(false);
            setMentionDismissed(false);
            setCommandIndex(0);
            setMentionIndex(0);
            setScheduleOpen(false);
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
              if (event.key === "Enter") {
                event.preventDefault();
                pickCommand(candidates[selectedIndex]!);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancelCommand();
                return;
              }
            }
            if (event.key === "Escape" && commandMatch) {
              event.preventDefault();
              cancelCommand();
              return;
            }
            if (mentionOpen) {
              if (event.key === "ArrowDown" && mentionCandidates.length) {
                event.preventDefault();
                setMentionIndex((selectedMentionIndex + 1) % mentionCandidates.length);
                return;
              }
              if (event.key === "ArrowUp" && mentionCandidates.length) {
                event.preventDefault();
                setMentionIndex((selectedMentionIndex - 1 + mentionCandidates.length) % mentionCandidates.length);
                return;
              }
              if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && mentionCandidates.length) {
                event.preventDefault();
                pickMention(mentionCandidates[selectedMentionIndex]!);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionDismissed(true);
                return;
              }
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="task-reply-actions">
          <AttachmentPicker addFiles={uploads.addFiles} disabled={disabled || sending || commandActive} />
          <button
            ref={scheduleTriggerRef}
            className="reply-schedule-button"
            type="button"
            disabled={disabled || sending || uploads.uploading || commandActive || mentionOpen}
            aria-label="选择定时发送时间"
            onClick={() => {
              if (!sendAt) setSendAt(defaultOnceTime());
              setScheduleOpen((open) => !open);
            }}
          >
            <Clock size={14} />
          </button>
          {/* 一颗三段胶囊：智能体 · 模型 · 智能水平。可单独改任一段，也可选完前一段后
              向右接着配置；跟新建面板、工作流站点用同一组件。 */}
          <RunTargetPicker
            label="本回合由谁来跑"
            types={registeredTypes.length ? registeredTypes : [activeAgent]}
            profiles={profiles}
            selection={{ agentType: activeAgent, executorId: activeExecutorId }}
            model={activeModel ?? null}
            effort={activeEffort ?? ""}
            variant="chip"
            highlight={!!target}
            disabled={disabled || sending || commandActive}
            onCommit={commitTarget}
            onEffortChange={commitEffort}
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
          <span>
            {uploads.uploading ? "上传中…"
              : selectedIsSkill ? "回车补全"
                : commandActive ? "回车配置"
                : queueing ? (target ? "排队：跑完按上面这套发出" : "⌘↵ 排队，跑完自动发出")
                  : target ? "本回合按上面这套跑" : "⌘↵ 发送"}
          </span>
          <button
            className="task-send-button"
            type="button"
            disabled={sending || uploads.uploading || (!commandActive && (disabled || (!value.trim() && !uploads.attachments.length)))}
            onClick={() => void send()}
            aria-label={selectedIsSkill ? "把技能补进正文" : commandActive ? "打开派生配置" : queueing ? "排队发送，任务跑完自动发出" : "发送回复"}
          >
            {sending ? <SpinnerGap size={15} className="is-spinning" /> : <ArrowUp size={15} weight="bold" />}
          </button>
        </div>
      </div>
    </div>
  );
}
