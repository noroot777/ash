// 团队调度台的回复框。跟普通任务的 `task-detail/ReplyBox.tsx` 是**两套**（团队走自己
// 这条主会话 + 回复框，不经过 TaskDetail），但拖动条几何、草稿清空口径、稍后发送与撤回
// 都刻意与它同构 —— 两边长得不一样会被当成 bug 报上来。
//
// 从 TeamView.tsx 搬出来独立成文件（那份已经顶到 700 行上限），搬的是整块、一字未改。
import { useEffect, useRef, useState } from "react";
import type { ScheduledMessage, Task, TaskListItem } from "@ash/shared";
import { cliCommandsForMode } from "@ash/shared/cli-commands";
import { PaperPlaneTilt, SpinnerGap } from "@phosphor-icons/react";
import { ScheduledMessageTray, useScheduledMessages } from "../components/ScheduledMessages.tsx";
import { LaterSendPanel, SendSplit, useLaterSend, type LaterChoice } from "../components/LaterSend.tsx";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { FileMentionMenu } from "../components/MentionMenu.tsx";
import type { ReplyTaskResult } from "../lib/api.ts";
import { useSkills } from "../lib/useSkills.ts";
import { useSlashCompletion } from "../lib/useSlashCompletion.ts";
import { useFileMention } from "../lib/useFileMention.ts";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { isSendKeyEvent } from "../lib/sendKey.ts";
import { useSendKeyLabels } from "../lib/useComposerSendKey.ts";
import { useTaskReplyDraft } from "../lib/DraftStore.tsx";
import { useReplyLayout } from "../task-detail/useReplyLayout.ts";
import { AttachmentPicker, UploadAttachmentList, uploadingLabel, useAttachments } from "../task-detail/Attachments.tsx";
import {
  ReplyResizeHandle,
  TEAM_REPLY_PIN,
  useReplyHeight,
} from "../task-detail/ReplyResizeHandle.tsx";
import {
  attachmentsFromPaths,
  clearSentDraft,
  dropSentAttachments,
  joinDraftText,
  mergeAttachments,
} from "../task-detail/withdrawDraft.ts";

export function TeamReplyBox({
  task,
  tasks,
  onSend,
}: {
  task: Task;
  /** 「等某任务完成后发送」的候选,以及托盘里报出在等谁。 */
  tasks: TaskListItem[];
  // 返回 null = 用户在确认闸上取消了:草稿和附件一个都别清(与 task-detail/ReplyBox 同口径)。
  onSend: (text: string, attachments: string[], options: LaterChoice) => Promise<ReplyTaskResult | null>;
}) {
  const draft = useTaskReplyDraft(task.id);
  const shellRef = useReplyLayout();
  const value = draft.text;
  const setValue = draft.setText;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const later = useLaterSend();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendKeys = useSendKeyLabels();
  // 跟着输入行数长高;顶边那条拖动条拖过之后以拖出来的高度为准——跟普通任务回复框
  // 同一套(task-detail/ReplyResizeHandle.tsx),高度只有 useAutoGrowTextarea 一个写者,
  // 所以 CSS 那边把原生右下角把手关掉了。
  const replyHeight = useReplyHeight(TEAM_REPLY_PIN);
  useAutoGrowTextarea(inputRef, { value, pinned: replyHeight.height });
  const scheduled = useScheduledMessages(task.id);
  const uploads = useAttachments({
    value: draft.attachments,
    onChange: draft.setAttachments,
    pending: draft.pendingUploads,
    onPendingChange: draft.setPendingUploads,
  });
  const disabled = !!task.archived;
  // 技能按**调度者自己的执行器**算：这句话是发给调度台那个会话的，执行者手上装的
  // 技能跟它不是一回事（派活时该带什么由调度者自己在 dispatch 里写）。
  const skills = useSkills({
    agentType: task.agentType,
    projectId: task.projectId,
    enabled: !disabled,
  });
  const slash = useSlashCompletion({ value, setValue, skills: cliCommandsForMode(skills.skills, task.agentType ?? "claude", "team"), disabled });
  // `@` 引用团队工作区里的文件：团队共享一个工作目录，执行者拿到的相对路径和这里一致。
  const mention = useFileMention({
    value,
    setValue,
    scope: { kind: "task", taskId: task.id },
    disabled: disabled || slash.open,
    onPicked: () => inputRef.current?.focus(),
  });
  useEffect(() => {
    setError(null);
    later.reset();
  }, [task.id]);
  // 正在飞的那一次发送；撤回排在它后面，见下面的 withdraw。
  const inFlightSend = useRef<Promise<void> | null>(null);
  const send = (choice?: LaterChoice): Promise<void> => {
    const run = runSend(choice);
    inFlightSend.current = run;
    void run.finally(() => {
      if (inFlightSend.current === run) inFlightSend.current = null;
    });
    return run;
  };
  const runSend = async (choice?: LaterChoice) => {
    if (disabled || sending || uploads.uploading || (!value.trim() && !uploads.attachments.length)) return;
    setSending(true);
    setError(null);
    // 发出去的是这一份；成功后只在草稿逐字还是这一份时才清掉，动过就整份留着
    // （见 task-detail/withdrawDraft.ts 的 clearSentDraft）。
    const draftAtSend = value;
    const sentText = value.trim();
    const sentPaths = uploads.attachments.map((attachment) => attachment.path);
    try {
      const result = await onSend(sentText, sentPaths, choice ?? {});
      // 执行器门禁弹了对话框、用户点了取消:草稿和附件一个字都不能清。
      if (result === null) return;
      if ("scheduled" in result) scheduled.add(result.message);
      setValue((current) => clearSentDraft(current, draftAtSend));
      draft.setAttachments((current) => dropSentAttachments(current, sentPaths));
      uploads.clearError();
      later.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  // 撤回:取消成功才回填,正文与附件并回当前草稿(见 task-detail/withdrawDraft.ts);
  // 「稍后」的设定也留着(定时的还没到点才留,等任务的原样留)。有发送正在飞就先等它结算完,清空排在
  // 合并前面,免得两边互相猜草稿里哪一段是谁的。
  const withdraw = async (message: ScheduledMessage) => {
    if (!await scheduled.cancel(message.id)) return;
    await inFlightSend.current;
    setValue((current) => joinDraftText(message.text, current));
    draft.setAttachments((current) => mergeAttachments(attachmentsFromPaths(message.attachments), current));
    later.restore(message);
  };
  return (
    <div ref={shellRef} className="team-reply-shell">
      {slash.open && (
        <SlashMenu
          className="team-reply-command-menu"
          ariaLabel="技能补全"
          hint="已装技能 · 回车补全，原样发给调度者的 CLI"
          items={slash.items}
          selectedIndex={slash.selectedIndex}
          token={slash.token}
          onHover={slash.setIndex}
          onPick={slash.pick}
        />
      )}
      {mention.open && !slash.open && (
        <FileMentionMenu mention={mention} label="引用工作区文件" className="team-reply-mention-menu" />
      )}
      {later.open && (
        <LaterSendPanel
          later={later}
          tasks={tasks}
          projectId={task.projectId}
          taskId={task.id}
          busy={sending}
          hasContent={!!value.trim() || uploads.attachments.length > 0}
          onSubmit={(choice) => void send(choice)}
        />
      )}
      <div className="reply-context">
      <ScheduledMessageTray
        key={task.id}
        messages={scheduled.messages}
        loading={scheduled.loading}
        error={scheduled.error}
        cancelingIds={scheduled.cancelingIds}
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
      {error && <p>{error}</p>}
      </div>
      <div className="team-reply-box">
        <ReplyResizeHandle targetRef={inputRef} {...replyHeight} />
        <textarea
          ref={inputRef}
          rows={2}
          value={value}
          disabled={disabled}
          placeholder={disabled ? "团队已归档（只读）" : task.status === "idle" ? "调度者待命中，说句话就接回同一会话…" : "插一句话（改方向、加要求、直接替它拍板）…"}
          onChange={(event) => { setValue(event.target.value); later.close(); slash.onValueChange(); mention.onValueChange(); }}
          onPaste={uploads.onPaste}
          onKeyDown={(event) => {
            if (slash.onKeyDown(event)) return;
            if (mention.onKeyDown(event)) return;
            if (isSendKeyEvent(event)) { event.preventDefault(); void send(); }
          }}
        />
        <footer>
          <AttachmentPicker addFiles={uploads.addFiles} disabled={disabled || sending} />
          <span>{uploads.uploading ? uploadingLabel(uploads.pending) : `调度台 · ${sendKeys.sendShort} 发送`}</span>
          <SendSplit later={later} disabled={disabled || sending || uploads.uploading}>
            <button type="button" className="team-send-button" disabled={disabled || sending || uploads.uploading || (!value.trim() && !uploads.attachments.length)} onClick={() => void send()} aria-label="发送给调度者">
              {sending ? <SpinnerGap size={14} className="is-spinning" /> : <PaperPlaneTilt size={14} weight="fill" />}
            </button>
          </SendSplit>
        </footer>
      </div>
    </div>
  );
}
