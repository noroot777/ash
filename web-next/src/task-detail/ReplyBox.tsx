import { useEffect, useState, type ReactNode } from "react";
import type { Task } from "@harness/shared";
import { ArrowUp, SpinnerGap } from "@phosphor-icons/react";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "./Attachments.tsx";

export function ReplyBox({
  task,
  hasConversation,
  onSend,
  command,
  inlinePanel,
}: {
  task: Task;
  hasConversation: boolean;
  onSend: (text: string, attachments: string[]) => Promise<void>;
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
  const uploads = useAttachments();
  const disabled = task.mode !== "single" || task.archived || task.status === "running" || task.status === "queued" || !hasConversation;
  const inputDisabled = disabled && !command;
  const reason = task.mode !== "single"
    ? "团队与辩论的复杂插话暂请用旧版处理"
    : task.archived
      ? command ? "任务已归档；仍可输入 /team 或 /debate 创建派生任务…" : "任务已归档，无法继续回复"
      : task.status === "running" || task.status === "queued"
        ? command ? "当前任务进行中；可输入 /team 或 /debate 创建派生任务…" : "当前任务进行中，结束后可继续回复"
        : !hasConversation
          ? command ? "可输入 /team 创建团队，或输入 /debate 发起辩论…" : "先运行任务，再继续回复"
          : command ? "回复并继续；输入 /team 或 /debate 可派生新任务…" : "回复并继续（⌘↵ 发送，可粘贴图片或文件）…";

  useEffect(() => {
    setValue("");
    setSendError(null);
    setCommandIndex(0);
    setMenuDismissed(false);
  }, [task.id]);

  useEffect(() => {
    setValue("");
    setCommandIndex(0);
    setMenuDismissed(false);
  }, [command?.resetKey]);

  const commandCandidates = (text: string) => {
    const token = /^\s*(\/\S*)$/.exec(text)?.[1]?.toLowerCase();
    return token ? command?.items.filter((item) => item.command.startsWith(token)) ?? [] : [];
  };
  const candidates = commandCandidates(value);
  const menuOpen = !menuDismissed && candidates.length > 0;
  const selectedIndex = Math.min(commandIndex, Math.max(0, candidates.length - 1));
  const commandMatch = !!command && command.matches(value);
  const commandActive = commandMatch || menuOpen;

  const pickCommand = (text: string) => {
    command?.onSubmit(text);
    setValue("");
    setCommandIndex(0);
    setMenuDismissed(false);
  };

  const cancelCommand = () => {
    setValue("");
    setCommandIndex(0);
    setMenuDismissed(true);
    command?.onChange?.("");
    command?.onCancel?.();
  };

  const send = async () => {
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
      {inlinePanel && !menuOpen && <div className="task-reply-inline-panel">{inlinePanel}</div>}
      <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
      {sendError && <p className="task-reply-error">{sendError}</p>}
      <div className="task-reply-box">
        <textarea
          value={value}
          rows={3}
          disabled={inputDisabled}
          placeholder={reason}
          aria-label="回复任务"
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            setMenuDismissed(false);
            setCommandIndex(0);
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
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="task-reply-actions">
          <AttachmentPicker addFiles={uploads.addFiles} disabled={disabled || sending || commandActive} />
          <span>{uploads.uploading ? "上传中…" : commandActive ? "回车配置" : "⌘↵ 发送"}</span>
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
