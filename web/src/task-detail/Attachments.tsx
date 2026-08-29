import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { File as FileIcon, Paperclip, SpinnerGap, X } from "@phosphor-icons/react";
import { maxBytesFor, type AttachmentKind } from "@ash/shared";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import { attachmentView } from "./utils.ts";

// 刚上传的附件四样俱全；撤回待发送消息时只有一个路径可以还原（见 withdrawDraft.ts），
// 所以字节数可缺省、URL 允许为空(路径不在 data/uploads 下时本来就没法直接访问)。
export type UploadAttachment = {
  url: string | null;
  path: string;
  name: string;
  size?: number;
  kind: AttachmentKind;
};

// 在途的那几个：远程访问时一张图能传十几秒，这段时间界面上必须有东西代表它，
// 否则「粘完什么都没发生」和「粘失败了」长得一模一样。percent 是 0~1 的已传比例。
export type UploadingFile = {
  id: string;
  name: string;
  size: number;
  percent: number;
  abort: () => void;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// 输入框边上那句「上传中」要带百分比：远程访问时它会挂十几秒，光一句「上传中…」
// 跟卡死长得一样。多个文件时按字节加权，进度条才不会因为先传完一张小图就跳到 90%。
export function uploadingLabel(pending: UploadingFile[]): string {
  const total = pending.reduce((sum, item) => sum + item.size, 0);
  const sent = pending.reduce((sum, item) => sum + item.size * item.percent, 0);
  const percent = total > 0 ? Math.round((sent / total) * 100) : 0;
  return pending.length > 1 ? `上传 ${pending.length} 个 ${percent}%` : `上传中 ${percent}%`;
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
  pending,
  onPendingChange,
}: {
  value?: UploadAttachment[];
  onChange?: Dispatch<SetStateAction<UploadAttachment[]>>;
  pending?: UploadingFile[];
  onPendingChange?: Dispatch<SetStateAction<UploadingFile[]>>;
} = {}) {
  const [storedAttachments, setStoredAttachments] = useState<UploadAttachment[]>([]);
  const [storedPending, setStoredPending] = useState<UploadingFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const controlled = value !== undefined;
  const pendingControlled = pending !== undefined;
  const attachments = value ?? storedAttachments;
  const pendingFiles = pending ?? storedPending;
  const uploading = pendingFiles.length > 0;

  const setAttachments = useCallback((update: SetStateAction<UploadAttachment[]>) => {
    if (controlled) onChange?.(update);
    else setStoredAttachments(update);
  }, [controlled, onChange]);

  const setPending = useCallback((update: SetStateAction<UploadingFile[]>) => {
    if (pendingControlled) onPendingChange?.(update);
    else setStoredPending(update);
  }, [onPendingChange, pendingControlled]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    // 先把整批都挂进「在途」再逐个传：多选/多图粘贴时用户当场看得到排了几个，
    // 而不是只看到正在传的那一个。
    const queued: { file: File; entry: UploadingFile; controller: AbortController }[] = [];
    for (const file of files) {
      const limit = maxBytesFor(file.type);
      if (file.size > limit) {
        setError(`${file.name || "文件"} 过大，上限 ${Math.round(limit / 1048576)}MB`);
        continue;
      }
      const controller = new AbortController();
      queued.push({
        file,
        controller,
        entry: {
          id: createClientId(),
          name: file.name || "粘贴的文件",
          size: file.size,
          percent: 0,
          abort: () => controller.abort(),
        },
      });
    }
    if (!queued.length) return;
    setPending((current) => [...current, ...queued.map((item) => item.entry)]);
    for (const { file, entry, controller } of queued) {
      try {
        if (controller.signal.aborted) continue;
        const encoded = await dataUrl(file);
        const uploaded = await api.uploadFile(encoded, file.name || "attachment", {
          signal: controller.signal,
          // 请求体发完之后还要等服务端落盘并回话，所以封顶 99%：写 100% 却迟迟不消失，
          // 看着又是一种卡住。真正到头的信号是这张在途卡片被换成正式附件。
          onProgress: (fraction) => setPending((current) => current.map((item) => (
            item.id === entry.id ? { ...item, percent: Math.min(fraction, 0.99) } : item
          ))),
        });
        setAttachments((current) => [...current, { ...uploaded, size: file.size }]);
      } catch (reason) {
        // 用户自己按的取消不是失败，别报错。
        if (!controller.signal.aborted) {
          const detail = reason instanceof Error && reason.message ? `：${reason.message}` : "";
          setError(`${file.name || "文件"} 上传失败${detail}`);
        }
      } finally {
        setPending((current) => current.filter((item) => item.id !== entry.id));
      }
    }
  }, [setAttachments, setPending]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(event);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }, [addFiles]);

  // 取消只掐这一个在途的：pending 项自己带着 abort，所以切走任务再切回来
  // （组件重新挂载、在途状态留在草稿里）按钮依然有效。
  //
  // 摘掉这一项由取消这一下**当场**做完，不等下面那个循环走到它：整批是串行传的，
  // 排在后面还没轮到的那个，abort 不会立刻让它落地，等第一张传完才消失 —— 那段时间
  // 「取消」看着就是坏的，而且还继续挡着创建/发送（第 1 轮审查 P2）。
  const cancel = useCallback((id: string) => {
    const target = pendingFiles.find((item) => item.id === id);
    if (!target) return;
    target.abort();
    setPending((current) => current.filter((item) => item.id !== id));
  }, [pendingFiles, setPending]);

  const remove = useCallback((path: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path));
  }, [setAttachments]);
  const clear = useCallback(() => {
    setAttachments([]);
    setError(null);
  }, [setAttachments]);
  // 发送成功后附件是**按已发出的路径**逐个摘掉的（见 withdrawDraft.ts 的 dropSentAttachments，
  // 请求在途期间新加进来的要留着），所以清空提示单独有个入口，不能顺手调 clear()。
  const clearError = useCallback(() => setError(null), []);

  return { attachments, pending: pendingFiles, uploading, error, addFiles, onPaste, cancel, remove, clear, clearError };
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
  pending = [],
  error,
  onRemove,
  onCancel,
}: {
  attachments: UploadAttachment[];
  pending?: UploadingFile[];
  error: string | null;
  onRemove: (path: string) => void;
  onCancel?: (id: string) => void;
}) {
  if (!attachments.length && !pending.length && !error) return null;
  return (
    <ImagePreviewGroup>
      <div className="task-upload-list">
        {attachments.map((attachment) => (
          <div className="task-upload-chip" key={attachment.path}>
            {attachment.kind === "image" && attachment.url ? (
              <PreviewableImage src={attachment.url} alt={attachment.name} />
            ) : (
              <FileIcon size={18} aria-hidden="true" />
            )}
            <span>
              <b>{attachment.name}</b>
              {typeof attachment.size === "number" && <small>{humanSize(attachment.size)}</small>}
            </span>
            <button type="button" onClick={() => onRemove(attachment.path)} aria-label={`移除 ${attachment.name}`}>
              <X size={11} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ))}
        {/* 在途的排在已传好的后面：粘贴的那一刻它就在了，传完原地换成正式的那一张。 */}
        {pending.map((item) => (
          <div className="task-upload-chip is-uploading" key={item.id}>
            <SpinnerGap size={18} className="is-spinning" aria-hidden="true" />
            <span>
              <b>{item.name}</b>
              <small>{`上传中 ${Math.round(item.percent * 100)}% · ${humanSize(item.size)}`}</small>
            </span>
            {onCancel && (
              <button type="button" onClick={() => onCancel(item.id)} aria-label={`取消上传 ${item.name}`}>
                <X size={11} weight="bold" aria-hidden="true" />
              </button>
            )}
            <i className="task-upload-progress" style={{ transform: `scaleX(${item.percent})` }} />
          </div>
        ))}
        {!!pending.length && (
          // 百分比每几十毫秒变一次,读屏不该跟着念;只在「传几个」变化时播报一次。
          <p className="task-visually-hidden" role="status">{`正在上传 ${pending.length} 个附件`}</p>
        )}
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
