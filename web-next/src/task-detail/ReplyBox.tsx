import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, Task } from "@harness/shared";
import { ArrowUp, CaretDown, Clock, Robot, SpinnerGap, X } from "@phosphor-icons/react";
import {
  ScheduledMessageTray,
  ScheduledSendPanel,
  useScheduledMessages,
} from "../components/ScheduledMessages.tsx";
import { defaultOnceTime } from "../components/ScheduleControl.tsx";
import { executorRunSummary, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api, type ReplyTaskResult } from "../lib/api.ts";
import { useProviders } from "../lib/modelCatalog.ts";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "./Attachments.tsx";
import type { MentionTarget } from "./mentionPicker.ts";

export function ReplyBox({
  task,
  hasConversation,
  onSend,
  command,
  inlinePanel,
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
  inlinePanel?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [target, setTarget] = useState<MentionTarget | null>(null);
  // 第二步（选模型）和「点胶囊改」共用同一个浮层，只是进入的阶段不同。
  const [picker, setPicker] = useState<{ stage: "agent" | "model"; agent: AgentType } | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const scheduleTriggerRef = useRef<HTMLButtonElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [profilesFailed, setProfilesFailed] = useState(false);
  const providers = useProviders();
  const scheduled = useScheduledMessages(task.id);
  const uploads = useAttachments();
  const disabled = task.mode !== "single" || task.archived || task.status === "running" || task.status === "queued" || !hasConversation;
  const inputDisabled = disabled && !command;
  const reason = task.mode !== "single"
    ? "请在对应的团队或辩论页面继续操作"
    : task.archived
      ? command ? "任务已归档；仍可输入 /team 或 /debate 创建派生任务…" : "任务已归档，无法继续回复"
      : task.status === "running" || task.status === "queued"
        ? command ? "当前任务进行中；可输入 /team 或 /debate 创建派生任务…" : "当前任务进行中，结束后可继续回复"
        : !hasConversation
          ? command ? "可输入 /team 创建团队，或输入 /debate 发起辩论…" : "先运行任务，再继续回复"
          : command ? "回复并继续；输入 /team 或 /debate 可派生新任务…" : "回复并继续（⌘↵ 发送，可粘贴图片或文件）…";

  const resetComposer = () => {
    setValue("");
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
    resetComposer();
    setSendError(null);
    uploads.clear();
  }, [task.id, uploads.clear]);

  useEffect(() => { resetComposer(); }, [command?.resetKey]);

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

  const commandCandidates = (text: string) => {
    const token = /^\s*(\/\S*)$/.exec(text)?.[1]?.toLowerCase();
    return token ? command?.items.filter((item) => item.command.startsWith(token)) ?? [] : [];
  };
  const candidates = commandCandidates(value);
  const menuOpen = !menuDismissed && candidates.length > 0;
  const selectedIndex = Math.min(commandIndex, Math.max(0, candidates.length - 1));
  const commandMatch = !!command && command.matches(value);
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

  const pickCommand = (text: string) => {
    command?.onSubmit(text);
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
    setPicker({ stage: "model", agent });
  };

  const commitTarget = (next: MentionTarget) => {
    setTarget(next);
    setPicker(null);
    textareaRef.current?.focus();
  };

  const send = async (scheduledAt?: string) => {
    if (menuOpen) {
      pickCommand(candidates[selectedIndex]!.command);
      return;
    }
    if (commandMatch) {
      pickCommand(value.trim());
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

  return (
    <div className="task-reply-shell">
      {menuOpen && (
        <div className="task-reply-command-menu" role="listbox" aria-label="派生命令">
          <small>派生命令 · ↑↓ 选择，回车确认，Esc 取消</small>
          {candidates.map((item, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              key={item.command}
              onMouseEnter={() => setCommandIndex(index)}
              onClick={() => pickCommand(item.command)}
            >
              <b>{item.command}</b>
              <span>{item.label}</span>
              {item.hint && <em>{item.hint}</em>}
            </button>
          ))}
        </div>
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
          initialStage={picker.stage}
          initialAgent={picker.agent}
          triggerRef={chipRef}
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
        onCancel={(messageId) => void scheduled.cancel(messageId)}
      />
      <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
      {sendError && <p className="task-reply-error">{sendError}</p>}
      <div className="task-reply-box">
        <textarea
          ref={textareaRef}
          value={value}
          rows={3}
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
                pickCommand(candidates[selectedIndex]!.command);
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
          <button
            ref={chipRef}
            type="button"
            className={`task-reply-chip${target ? " is-summoned" : ""}`}
            disabled={disabled || sending || commandActive}
            aria-label={`当前智能体 ${activeAgent}${activeModel ? `，模型 ${activeModel}` : ""}${activeEffort ? `，思考强度 ${activeEffort}` : ""}；点击更改`}
            onClick={() => setPicker((open) => (open ? null : { stage: "agent", agent: activeAgent }))}
          >
            <Robot size={12} aria-hidden="true" />
            <b>{activeAgent}</b>
            <span>{activeModel ?? "跟随执行器"}</span>
            {activeEffort && <em>{activeEffort}</em>}
            <CaretDown size={9} weight="bold" aria-hidden="true" />
          </button>
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
          <span>{uploads.uploading ? "上传中…" : commandActive ? "回车配置" : target ? "本回合按上面这套跑" : "⌘↵ 发送"}</span>
          <button
            className="task-send-button"
            type="button"
            disabled={sending || uploads.uploading || (!commandActive && (disabled || (!value.trim() && !uploads.attachments.length)))}
            onClick={() => void send()}
            aria-label={commandActive ? "打开派生配置" : "发送回复"}
          >
            {sending ? <SpinnerGap size={15} className="is-spinning" /> : <ArrowUp size={15} weight="bold" />}
          </button>
        </div>
      </div>
    </div>
  );
}
