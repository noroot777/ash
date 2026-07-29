import { useRef, useState } from "react";
import type { ProjectView } from "@harness/shared";
import { api } from "./api";
import { Modal, primaryCls } from "./Modal";
import { AttachButton, AttachmentChips, usePasteAttachments } from "./pasteAttachments";
import { toast } from "./toast";
import { Kbd, submitShortcutTitle } from "./ui";
import { ModalFullscreenButton, useMovableModal } from "./useMovableModal";

export function NewNoteModal({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(onClose);
  const movable = useMovableModal();
  const { attachments, onPaste, addFiles, remove, error } = usePasteAttachments();

  const save = async (close: () => void) => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await api.createNote({ projectId: project.id, body, attachments: attachments.map((item) => item.path) });
      toast("随手记已保存");
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`新建随手记 · ${project.name}`}
      onClose={onClose}
      width={620}
      overlayClassName="z-[70]"
      cardRef={movable.cardRef}
      cardStyle={movable.cardStyle}
      headerProps={movable.headerProps}
      headerActions={(
        <ModalFullscreenButton isFullscreen={movable.isFullscreen} onToggle={movable.toggleFullscreen} />
      )}
      contentClassName="flex min-h-0 flex-col overflow-y-auto p-4"
      footer={(close) => {
        closeRef.current = close;
        return <>
          <AttachButton
            addFiles={addFiles}
            className="mr-auto grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
            title="添加图片或文件"
          />
          <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button
            disabled={!body.trim() || busy}
            onClick={() => void save(close)}
            title={submitShortcutTitle("保存随手记")}
            className={`${primaryCls} inline-flex items-center gap-1.5`}
          >
            {busy ? "保存中…" : "保存"} <Kbd />
          </button>
        </>;
      }}
    >
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void save(closeRef.current);
        }}
        placeholder="记下临时想法…"
        className="min-h-[220px] w-full flex-1 resize-y bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint"
      />
      <AttachmentChips attachments={attachments} onRemove={remove} error={error} />
    </Modal>
  );
}
