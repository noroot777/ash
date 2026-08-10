import { useCallback, useRef, useState, type ClipboardEvent, type SetStateAction } from "react";
import { File as FileIcon, Paperclip, X } from "@phosphor-icons/react";
import { maxBytesFor, type AttachmentKind } from "@harness/shared";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { api } from "../lib/api.ts";
import { attachmentView } from "./utils.ts";

export type UploadAttachment = {
  url: string;
  path: string;
  name: string;
  size: number;
  kind: AttachmentKind;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function pastedFiles(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  const files: File[] = [];
  for (const item of Array.from(event.clipboardData.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length) files.push(...Array.from(event.clipboardData.files ?? []));
  return files;
}

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useAttachments({
  value,
  onChange,
}: {
  value?: UploadAttachment[];
  onChange?: (attachments: UploadAttachment[]) => void;
} = {}) {
  const [storedAttachments, setStoredAttachments] = useState<UploadAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controlled = value !== undefined;
  const attachments = value ?? storedAttachments;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const setAttachments = useCallback((update: SetStateAction<UploadAttachment[]>) => {
    const current = attachmentsRef.current;
    const next = typeof update === "function" ? update(current) : update;
    attachmentsRef.current = next;
    if (!controlled) setStoredAttachments(next);
    onChange?.(next);
  }, [controlled, onChange]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const limit = maxBytesFor(file.type);
        if (file.size > limit) {
          setError(`${file.name || "文件"} 过大，上限 ${Math.round(limit / 1048576)}MB`);
          continue;
        }
        try {
          const uploaded = await api.uploadFile(await dataUrl(file), file.name || "attachment");
          setAttachments((current) => [...current, { ...uploaded, size: file.size }]);
        } catch {
          setError(`${file.name || "文件"} 上传失败`);
        }
      }
    } finally {
      setUploading(false);
    }
  }, [setAttachments]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(event);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }, [addFiles]);

  const remove = useCallback((path: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path));
  }, [setAttachments]);
  const clear = useCallback(() => {
    setAttachments([]);
    setError(null);
  }, [setAttachments]);

  return { attachments, uploading, error, addFiles, onPaste, remove, clear };
}

export function AttachmentPicker({
  addFiles,
  disabled,
}: {
  addFiles: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className="task-reply-icon"
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-label="上传附件"
      >
        <Paperclip size={16} aria-hidden="true" />
      </button>
      <input
        ref={input}
        className="task-visually-hidden"
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) void addFiles(files);
          event.target.value = "";
        }}
      />
    </>
  );
}

export function UploadAttachmentList({
  attachments,
  error,
  onRemove,
}: {
  attachments: UploadAttachment[];
  error: string | null;
  onRemove: (path: string) => void;
}) {
  if (!attachments.length && !error) return null;
  return (
    <ImagePreviewGroup>
      <div className="task-upload-list">
        {attachments.map((attachment) => (
          <div className="task-upload-chip" key={attachment.path}>
            {attachment.kind === "image" ? (
              <PreviewableImage src={attachment.url} alt={attachment.name} />
            ) : (
              <FileIcon size={18} aria-hidden="true" />
            )}
            <span>
              <b>{attachment.name}</b>
              <small>{humanSize(attachment.size)}</small>
            </span>
            <button type="button" onClick={() => onRemove(attachment.path)} aria-label={`移除 ${attachment.name}`}>
              <X size={11} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ))}
        {error && <p className="task-upload-error">{error}</p>}
      </div>
    </ImagePreviewGroup>
  );
}

export function MessageAttachments({
  paths,
}: {
  paths: string[];
}) {
  const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  if (!unique.length) return null;
  return (
    <ImagePreviewGroup>
      <div className="task-message-attachments">
        {unique.map((path) => {
          const view = attachmentView(path);
          if (view.image && view.url) {
            return (
              <div className="task-message-image" key={path}>
                <PreviewableImage src={view.url} alt={view.name} />
              </div>
            );
          }
          if (view.url) {
            return (
              <a key={path} href={view.url} target="_blank" rel="noreferrer" aria-label={`打开附件 ${view.name}`}>
                <FileIcon size={18} aria-hidden="true" />
                <span>{view.name}</span>
              </a>
            );
          }
          return (
            <span className="task-message-file" key={path}>
              <FileIcon size={18} aria-hidden="true" />
              <span>{view.name}</span>
            </span>
          );
        })}
      </div>
    </ImagePreviewGroup>
  );
}
