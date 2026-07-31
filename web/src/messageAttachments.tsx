import { File as FileIcon, X } from "@phosphor-icons/react";
import { ImagePreviewGroup, PreviewableImage } from "./ImagePreview";

export type ParsedAttachmentText = {
  body: string;
  paths: string[];
};

const ATTACHMENT_HEADER = /^\s*\[用户附带的文件[^\]]*\]\s*$/;
const ATTACHMENT_PATH = /^\s*-\s+(.+?)\s*$/;
const IMAGE_EXT = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

// Split the server's agent-facing attachment prompt back into user-authored text
// and file paths. Only a recognized header followed by at least one list item is
// consumed, so ordinary prose containing similar words remains untouched.
export function parseAttachmentText(text: string): ParsedAttachmentText {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const body: string[] = [];
  const paths: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!ATTACHMENT_HEADER.test(lines[i] ?? "")) {
      body.push(lines[i] ?? "");
      continue;
    }

    let cursor = i + 1;
    while (cursor < lines.length && !(lines[cursor] ?? "").trim()) cursor += 1;
    const block: string[] = [];
    while (cursor < lines.length) {
      const match = ATTACHMENT_PATH.exec(lines[cursor] ?? "");
      if (!match) break;
      block.push(match[1]);
      cursor += 1;
    }
    if (!block.length) {
      body.push(lines[i] ?? "");
      continue;
    }
    paths.push(...block);
    i = cursor - 1;
  }

  return { body: body.join("\n").trim(), paths };
}

// 编辑用户写下的需求时，只替换正文，保留服务端附加的本地文件清单。附件块本来
// 就是 append 到 prompt 尾部的 agent-facing 提示；统一重建能避免把那段内部说明
// 暴露进编辑框，也不会因为用户改正文而丢失附件。
export function replaceAttachmentTextBody(text: string, nextBody: string): string {
  const { paths } = parseAttachmentText(text);
  const attachmentBlock = paths.length
    ? `[用户附带的文件，请用 Read 工具查看以下本地文件]\n${paths.map((path) => `- ${path}`).join("\n")}`
    : "";
  return [nextBody.trim(), attachmentBlock].filter(Boolean).join("\n\n");
}

function uploadFile(path: string): string | null {
  const normalized = path.trim().replaceAll("\\", "/");
  const match = /(?:^|\/)data\/uploads\/([^/]+)$/.exec(normalized);
  const file = match?.[1];
  if (!file || file === "." || file === "..") return null;
  return file;
}

function basename(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function displayName(path: string): string {
  const file = basename(path);
  // Uploads are `${nanoid(12)}-${original}`. Keep legacy/unrecognized names as-is.
  return file.replace(/^[A-Za-z0-9_-]{12}-/, "") || file;
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="absolute right-0 top-0 grid h-4 w-4 place-items-center rounded-bl bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
      title="移除"
      aria-label="移除附件"
    >
      <X size={10} weight="bold" />
    </button>
  );
}

// Read-only attachment renderer shared by task bodies, conversation bubbles,
// and debate interventions. A local path becomes a URL
// only when it ends in data/uploads/<single filename>; every other path stays a
// non-clickable filename chip so arbitrary local paths can never be exposed.
export function AttachmentDisplay({
  paths,
  className = "",
  onRemove,
}: {
  paths: string[];
  className?: string;
  onRemove?: (path: string) => void;
}) {
  const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  if (!uniquePaths.length) return null;

  return (
    <ImagePreviewGroup>
      <div className={`flex flex-wrap gap-2 ${className}`}>
        {uniquePaths.map((path) => {
          const file = uploadFile(path);
          const name = displayName(path);
          const url = file ? `/api/uploads/${encodeURIComponent(file)}` : null;
          const image = !!url && IMAGE_EXT.test(file ?? "");
          return (
            <div key={path} className="group relative">
              {image ? (
                <div className="h-14 w-14 overflow-hidden rounded-md border border-line2 bg-raised transition-colors group-hover:border-accent">
                  <PreviewableImage
                    src={url}
                    alt={name}
                    className="h-full w-full object-cover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  />
                </div>
              ) : url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-14 max-w-[220px] items-center gap-2 rounded-md border border-line2 bg-raised/50 py-1 pl-2 pr-3 transition-colors hover:border-accent focus-visible:border-accent focus-visible:outline-none"
                  title={name}
                >
                  <FileIcon size={20} className="shrink-0 text-muted" />
                  <span className="truncate text-[12px] text-ink">{name}</span>
                </a>
              ) : (
                <div
                  className="flex h-14 max-w-[220px] items-center gap-2 rounded-md border border-line2 bg-raised/50 py-1 pl-2 pr-3"
                  title={name}
                >
                  <FileIcon size={20} className="shrink-0 text-muted" />
                  <span className="truncate text-[12px] text-ink">{name}</span>
                </div>
              )}
              {onRemove && <RemoveButton onClick={() => onRemove(path)} />}
            </div>
          );
        })}
      </div>
    </ImagePreviewGroup>
  );
}
