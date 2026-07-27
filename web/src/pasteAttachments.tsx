import { useState, useCallback, useRef, type ClipboardEvent } from "react";
import { X, File as FileIcon, Paperclip } from "@phosphor-icons/react";
import { maxBytesFor, type AttachmentKind } from "@harness/shared";
import { api } from "./api";

// One pasted attachment: `url` previews an image thumbnail (image kind only),
// `path` is the absolute file path handed to the agent (it reads it with its Read
// tool). `name`/`size`/`kind` drive the chip shown under the input.
export type Attachment = { url: string; path: string; name: string; size: number; kind: AttachmentKind };

const human = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// Collect File objects from a paste: clipboard `items` (kind === "file") covers
// pasted images AND OS files; fall back to `files` for browsers that only populate
// that list. Empty → it's a plain text paste, leave it alone.
function filesFromPaste(e: ClipboardEvent): File[] {
  const out: File[] = [];
  for (const it of Array.from(e.clipboardData?.items ?? [])) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  if (!out.length) out.push(...Array.from(e.clipboardData?.files ?? []));
  return out;
}

// Shared paste/pick-to-upload behavior for the composer + reply box. Captures
// pasted OR file-picked images/files, enforces the claude/codex-style size caps
// client-side (so an oversize file never hits the wire), uploads the rest, and
// tracks the results. `addFiles` backs an explicit 「附件」 picker button.
export function usePasteAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    for (const file of files) {
      const cap = maxBytesFor(file.type);
      if (file.size > cap) {
        setError(`${file.name || "文件"} 过大（${human(file.size)}），上限 ${Math.round(cap / 1048576)}MB`);
        continue;
      }
      try {
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        const up = await api.uploadFile(dataUrl, file.name);
        setAttachments((xs) => [...xs, { url: up.url, path: up.path, name: up.name, size: file.size, kind: up.kind }]);
      } catch (err) {
        console.warn("attachment upload failed:", err);
        setError(`${file.name || "文件"} 上传失败`);
      }
    }
  }, []);
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = filesFromPaste(e);
      if (!files.length) return; // no files → let normal text paste through
      e.preventDefault();
      void addFiles(files);
    },
    [addFiles],
  );
  const remove = useCallback((path: string) => setAttachments((xs) => xs.filter((x) => x.path !== path)), []);
  const clear = useCallback(() => {
    setAttachments([]);
    setError(null);
  }, []);
  return { attachments, onPaste, addFiles, remove, clear, error };
}

// 「附件」 picker button: opens a hidden file input and feeds the chosen files to
// `addFiles` from usePasteAttachments. `className` styles the trigger so callers
// match their composer's look.
export function AttachButton({
  addFiles,
  className,
  title = "附件",
}: {
  addFiles: (files: File[]) => void | Promise<void>;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className={className}
        title={title}
      >
        <Paperclip size={16} />
      </button>
      <input
        ref={ref}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void addFiles(files);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
    </>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
      title="移除"
    >
      <X size={10} weight="bold" />
    </button>
  );
}

// Row of removable chips shown under an input once attachments are pasted. Images
// show a thumbnail; other files show a labeled file chip. An oversize/failed
// `error` renders as a one-line note beneath.
export function AttachmentChips({
  attachments,
  onRemove,
  error,
}: {
  attachments: Attachment[];
  onRemove: (path: string) => void;
  error?: string | null;
}) {
  if (!attachments.length && !error) return null;
  return (
    <div className="pt-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) =>
            a.kind === "image" ? (
              <div key={a.path} className="group relative h-14 w-14 overflow-hidden rounded-md border border-line2">
                <img src={a.url} alt={a.name} className="h-full w-full object-cover" />
                <RemoveBtn onClick={() => onRemove(a.path)} />
              </div>
            ) : (
              <div
                key={a.path}
                className="group relative flex h-14 max-w-[180px] items-center gap-2 rounded-md border border-line2 bg-raised/50 py-1 pl-2 pr-6"
              >
                <FileIcon size={20} className="shrink-0 text-muted" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[12px] text-ink" title={a.name}>
                    {a.name}
                  </span>
                  <span className="text-[10px] text-faint">{human(a.size)}</span>
                </span>
                <RemoveBtn onClick={() => onRemove(a.path)} />
              </div>
            ),
          )}
        </div>
      )}
      {error && <div className="pt-1.5 text-[11px] text-red-600">{error}</div>}
    </div>
  );
}
