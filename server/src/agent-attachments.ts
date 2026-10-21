import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maxBytesFor } from "@ash/shared";
import { UPLOADS_DIR } from "./paths.js";
import { id } from "./util.js";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [`.${ext}`, mime]),
);
EXT_MIME[".jpeg"] = "image/jpeg";

// `name` 只有「从磁盘上某个文件读来的」那一类才有：落进 uploads 时原样留着它，
// 对话里那张卡片才写得出「wake-input-desktop.png」而不是「agent-image-1.png」。
type ImageBytes = { bytes: Buffer; mime: string; name?: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function dataUrl(value: string): ImageBytes | null {
  const match = /^data:(image\/[^;,]+);base64,(.+)$/s.exec(value);
  return match ? { mime: match[1]!, bytes: Buffer.from(match[2]!, "base64") } : null;
}

function imageBlock(value: unknown): ImageBytes | null {
  const block = record(value);
  if (!block) return null;
  if (typeof block.image_url === "string") return dataUrl(block.image_url);
  if (block.type !== "image") return null;
  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return { mime: block.mimeType, bytes: Buffer.from(block.data, "base64") };
  }
  const source = record(block.source);
  if (source?.type === "base64" && typeof source.data === "string") {
    const mime = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { mime, bytes: Buffer.from(source.data, "base64") };
  }
  return null;
}

function resultImages(value: unknown, allowBareBase64: boolean): ImageBytes[] {
  const root = record(value);
  const content = Array.isArray(value) ? value : Array.isArray(root?.content) ? root.content : [value];
  const images = content.map(imageBlock).filter((item): item is ImageBytes => item !== null);
  if (images.length || !allowBareBase64 || typeof value !== "string" || value.length < 128) return images;
  const fromDataUrl = dataUrl(value);
  return fromDataUrl ? [fromDataUrl] : [{ mime: "image/png", bytes: Buffer.from(value, "base64") }];
}

/**
 * uploads 里的文件名。前缀恒为 `id()`（nanoid(12)）——展示端按 `^[A-Za-z0-9_-]{12}-`
 * 把它剥掉再显示（web `attachmentView`），所以这一段的长度不能随便改。
 *
 * 后半段优先用源文件自己的名字：卡片上写「wake-input-desktop.png」比「agent-image-1.png」
 * 有用得多。只保留文件名里安全的那部分，并强制用 mime 对应的扩展名 —— uploads 是按
 * 扩展名定 Content-Type 的，名字里写的扩展名不算数。
 */
function uploadFileNameFor(name: string | undefined, ext: string, index: number): string {
  const stem = basename(name ?? "", extname(name ?? ""))
    .replace(/[^\w.\u4e00-\u9fa5-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return `${id()}-${stem || `agent-image-${index + 1}`}.${ext}`;
}

function storeImages(
  images: ImageBytes[],
  seen: Set<string>,
  directory: string,
): string[] {
  const stored: string[] = [];
  images.forEach(({ bytes, mime, name }, index) => {
    const ext = MIME_EXT[mime];
    if (!ext || !bytes.length || bytes.length > maxBytesFor(mime)) return;
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(hash)) return;
    seen.add(hash);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, uploadFileNameFor(name, ext, index));
    writeFileSync(path, bytes);
    stored.push(path);
  });
  return stored;
}

export function persistToolResultImages(
  value: unknown,
  seen = new Set<string>(),
  options: { allowBareBase64?: boolean; directory?: string } = {},
): string[] {
  return storeImages(resultImages(value, !!options.allowBareBase64), seen, options.directory ?? UPLOADS_DIR);
}

// `http:` / `data:` / `blob:` 一类的目标不是磁盘路径，别拿去跟工作目录拼。`file:`
// 例外：它指的就是本机文件，上面单独走 fileURLToPath。
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 正文里 `![](…)` 指到的**本机图片**的绝对路径。
 *
 * 相对路径必须认：`![](output/playwright/x.png)` 是 agent 写路径最自然的写法（它自己
 * 就站在工作目录里），而展示端没有任何「文档根」可供解析——不在这里解成绝对路径并复制
 * 一份进 uploads，那张图在对话里就只是一个裂开的图标。`cwd` 缺省时只认绝对路径（老行为）。
 */
function markdownImagePaths(text: string, cwd?: string): string[] {
  const paths: string[] = [];
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;
    try {
      if (raw.startsWith("file://")) {
        paths.push(fileURLToPath(raw));
        continue;
      }
      if (URL_SCHEME.test(raw)) continue;
      const path = decodeURIComponent(raw);
      if (isAbsolute(path)) paths.push(path);
      else if (cwd) paths.push(resolve(cwd, path));
    } catch {
      /* malformed local URL */
    }
  }
  return [...new Set(paths)];
}

export function persistMarkdownImages(
  text: string,
  seen = new Set<string>(),
  options: { directory?: string; cwd?: string } = {},
): string[] {
  const images: ImageBytes[] = [];
  for (const path of markdownImagePaths(text, options.cwd)) {
    const mime = EXT_MIME[extname(path).toLowerCase()];
    if (!mime || !existsSync(path)) continue;
    try { images.push({ mime, bytes: readFileSync(path), name: basename(path) }); } catch { /* file disappeared */ }
  }
  return storeImages(images, seen, options.directory ?? UPLOADS_DIR);
}
