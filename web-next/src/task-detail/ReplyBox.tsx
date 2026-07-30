import { useState } from "react";
import type { Task } from "@harness/shared";
import { ArrowUp, SpinnerGap } from "@phosphor-icons/react";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "./Attachments.tsx";

export function ReplyBox({
  task,
  hasConversation,
  onSend,
}: {
  task: Task;
  hasConversation: boolean;
  onSend: (text: string, attachments: string[]) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const uploads = useAttachments();
  const disabled = task.mode !== "single" || task.archived || task.status === "running" || task.status === "queued" || !hasConversation;
  const reason = task.mode !== "single"
    ? "团队与辩论的复杂插话暂请用旧版处理"
    : task.archived
      ? "任务已归档，无法继续回复"
      : task.status === "running" || task.status === "queued"
        ? "当前任务进行中，结束后可继续回复"
        : !hasConversation
          ? "先运行任务，再继续回复"
          : "回复并继续（⌘↵ 发送，可粘贴图片或文件）…";

  const send = async () => {
    if (disabled || sending || uploads.uploading || (!value.trim() && !uploads.attachments.length)) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(value.trim(), uploads.attachments.map((attachment) => attachment.path));
      setValue("");
      uploads.clear();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="task-reply-shell">
      <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
      {sendError && <p className="task-reply-error">{sendError}</p>}
      <div className="task-reply-box">
        <textarea
          value={value}
          rows={3}
          disabled={disabled}
          placeholder={reason}
          aria-label="回复任务"
          onChange={(event) => setValue(event.target.value)}
          onPaste={uploads.onPaste}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="task-reply-actions">
          <AttachmentPicker addFiles={uploads.addFiles} disabled={disabled || sending} />
          <span>{uploads.uploading ? "上传中…" : "⌘↵ 发送"}</span>
          <button
            className="task-send-button"
            type="button"
            disabled={disabled || sending || uploads.uploading || (!value.trim() && !uploads.attachments.length)}
            onClick={() => void send()}
            aria-label="发送回复"
          >
            {sending ? <SpinnerGap size={15} className="is-spinning" /> : <ArrowUp size={15} weight="bold" />}
          </button>
        </div>
      </div>
    </div>
  );
}
