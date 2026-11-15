// 写一条 / 改一条备忘的那个框：正文 + 贴进来的图。新建（composer）与卡片的编辑态共用它。
//
// 草稿、在途上传和传失败的那几张都受控于 taskMemoDrafts.ts（理由见那份文件开头）：
// `useAttachments` 的状态在这里全接到 store 上，所以截图传到一半面板被切走，传完照样落回
// 这份草稿；传失败了，切回来也还看得见、能重试或移除。
import { useEffect, useRef, type SetStateAction } from "react";
import { Paperclip } from "@phosphor-icons/react";
import { TASK_MEMO_MAX_LEN } from "@ash/shared/task-memo";
import { InspButton, InspTool } from "../inspector/parts.tsx";
import { isModEnterEvent } from "../lib/sendKey.ts";
import { AutoTextarea } from "../components/AutoTextarea.tsx";
import { UploadAttachmentList, useAttachments, type UploadAttachment } from "../task-detail/Attachments.tsx";
import { attachmentView } from "../task-detail/utils.ts";
import {
  addMemoUploadFailure,
  dropMemoUploadFailure,
  setMemoDraft,
  setMemoUploads,
  updateMemoAttachments,
  useTaskMemoDrafts,
  type MemoDraft,
  type MemoSlot,
} from "./taskMemoDrafts.ts";

const asUpload = (path: string): UploadAttachment => {
  const view = attachmentView(path);
  return { path, url: view.url, name: view.name, kind: view.image ? "image" : "file" };
};

export function MemoEditor({ taskId, slot, draft, disabled, rows, placeholder, onSave, onCancel }: {
  taskId: string;
  slot: MemoSlot;
  draft: MemoDraft;
  /** 这一格（或整个面板）有写在飞。 */
  disabled: boolean;
  rows: number;
  placeholder?: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const { uploadsOn, failuresOn } = useTaskMemoDrafts(taskId);
  const failures = failuresOn(slot);
  const uploads = useAttachments({
    value: draft.attachments.map(asUpload),
    onChange: (update: SetStateAction<UploadAttachment[]>) => updateMemoAttachments(taskId, slot, (paths) => {
      const next = typeof update === "function" ? update(paths.map(asUpload)) : update;
      return next.map((attachment) => attachment.path);
    }),
    pending: [...uploadsOn(slot)],
    onPendingChange: (update) => setMemoUploads(taskId, slot, update),
    onFailed: (file, message) => addMemoUploadFailure(taskId, slot, file, message),
  });

  // 光标落到末尾：改备忘九成是往后补一句，不是重写。重新挂载时也做（面板被自动切走又
  // 切回来，草稿还在框里，焦点该跟着回去）。只在挂载时跑：打字途中重设选区会把光标踢到末尾。
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  // 图还在传、或者有传失败还没处理的，就不让存：存下去的那一版里没有它，悄悄存成一条
  // 缺图的备忘，用户会以为图在里面。
  const empty = !draft.text.trim() && !draft.attachments.length;
  const blocked = disabled || uploads.uploading || failures.length > 0;

  return (
    <div
      className="task-memo-editor"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => {
        const dropped = Array.from(event.dataTransfer.files ?? []);
        if (!dropped.length || disabled) return;
        event.preventDefault();
        void uploads.addFiles(dropped);
      }}
    >
      <AutoTextarea
        ref={input}
        value={draft.text}
        rows={rows}
        maxLength={TASK_MEMO_MAX_LEN}
        placeholder={placeholder}
        aria-label="备忘内容"
        disabled={disabled}
        onChange={(event) => setMemoDraft(taskId, slot, { text: event.target.value, attachments: draft.attachments })}
        onPaste={uploads.onPaste}
        // Esc 撤销，⌘/Ctrl+回车保存。裸回车留给换行 —— 备忘天生是多行的东西。
        onKeyDown={(event) => {
          if (isModEnterEvent(event)) { event.preventDefault(); if (!blocked && !empty) onSave(); return; }
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (!disabled) onCancel();
        }}
      />
      <UploadAttachmentList
        attachments={uploads.attachments}
        pending={uploads.pending}
        error={uploads.error}
        onRemove={uploads.remove}
        onCancel={uploads.cancel}
      />
      {failures.map((failure) => (
        <p key={failure.id} className="task-memo-editor__failed" role="alert">
          <span>{`${failure.file.name || "粘贴的文件"} ${failure.message}`}</span>
          <button type="button" disabled={disabled} onClick={() => {
            dropMemoUploadFailure(taskId, slot, failure.id);
            void uploads.addFiles([failure.file]);
          }}>重试</button>
          <button type="button" disabled={disabled} onClick={() => dropMemoUploadFailure(taskId, slot, failure.id)}>移除</button>
        </p>
      ))}
      <div className="task-memo-editor__actions">
        <InspTool
          label="附上图片或文件"
          tip="附上图片或文件 · 也可以直接粘贴、拖进来"
          disabled={disabled}
          onClick={() => files.current?.click()}
        >
          <Paperclip aria-hidden="true" />
        </InspTool>
        <input
          ref={files}
          className="task-visually-hidden"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            if (picked.length) void uploads.addFiles(picked);
            event.target.value = "";
          }}
        />
        <InspButton variant="quiet" size="sm" disabled={disabled} onClick={onCancel}>取消</InspButton>
        <InspButton
          variant="pri"
          size="sm"
          disabled={blocked || empty}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onClick={onSave}
        >
          保存
        </InspButton>
      </div>
    </div>
  );
}
