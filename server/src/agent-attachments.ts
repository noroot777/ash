import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maxBytesFor } from "@ash/shared";
import { hasUrlScheme, markdownImageRefs } from "@ash/shared/markdown-images";
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

/**
 * 本次运行已经落盘过的图片:**内容 hash → uploads 里那份拷贝的路径**。
 *
 * 曾经是个 `Set<string>`,只记「见过」。改成记路径是 F1 要的:同一份字节被正文用另一个
 * 名字再引用一次(或者工具结果先把它交上来、正文随后才提它)时,得能把**已经存在的那份**
 * 认回来并标上新的来源,而不是「见过了」就一声不响地跳过 —— 跳过的结果是正文那一句配不
 * 上任何附件,于是一个字都不画(审查第 1 轮 F1 实例 3、4)。
 */
export type ImageStore = Map<string, string>;

/** 落一张图,返回它在 uploads 里的路径;`fresh=false` = 这份字节本次运行已经存过了。 */
function storeImage(
  { bytes, mime, name }: ImageBytes,
  seen: ImageStore,
  directory: string,
  index = 0,
): { path: string; fresh: boolean } | null {
  const ext = MIME_EXT[mime];
  if (!ext || !bytes.length || bytes.length > maxBytesFor(mime)) return null;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const known = seen.get(hash);
  if (known) return { path: known, fresh: false };
  const path = join(directory, uploadFileNameFor(name, ext, index));
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, bytes);
  } catch (error) {
    // 写不进去就当这张图不存在:**不记进 seen**,下一次引用还能再试。写失败抛出去会变成
    // 没有监听者的 uncaughtException,把整条事件流(连带这一回合)带走 —— 一张图不值这个。
    console.warn(`[ash] failed to persist agent image ${path}:`, error);
    return null;
  }
  seen.set(hash, path);
  return { path, fresh: true };
}

export function persistToolResultImages(
  value: unknown,
  seen: ImageStore = new Map(),
  options: { allowBareBase64?: boolean; directory?: string } = {},
): string[] {
  const directory = options.directory ?? UPLOADS_DIR;
  return resultImages(value, !!options.allowBareBase64)
    .map((image, index) => storeImage(image, seen, directory, index))
    // 只报**新落盘**的那几份:工具把同一张图交两次时,卡片不该铺两张。
    .filter((stored) => stored?.fresh)
    .map((stored) => stored!.path);
}

/**
 * 正文里一处 `![](…)` 指到的**本机图片的绝对路径**;不是本机图片就返回 null。
 *
 * 相对路径必须认：`![](output/playwright/x.png)` 是 agent 写路径最自然的写法(它自己就
 * 站在工作目录里),而展示端没有任何「文档根」可供解析 —— 不在这里解成绝对路径并复制一
 * 份进 uploads,那张图在对话里就只是一个裂开的图标。`cwd` 缺省时只认绝对路径(老行为)。
 */
function localImagePath(destination: string, cwd?: string): string | null {
  try {
    // `file:` 指的就是本机文件,它要在协议判据之前单独认掉。
    if (/^file:\/\//i.test(destination)) return fileURLToPath(destination);
    if (hasUrlScheme(destination)) return null;
    const path = decodeURIComponent(destination);
    if (isAbsolute(path)) return path;
    return cwd ? resolve(cwd, path) : null;
  } catch {
    return null; /* 坏转义 / 不合法的 file URL */
  }
}

/** 正文那一句引用 → uploads 里的那份拷贝。`source` 恒为**目的地原文**。 */
export type PersistedMarkdownImage = { path: string; source: string };

/**
 * 把正文引用到的本机图片复制进 uploads,并标明**是哪一句引用的**。
 *
 * `source` 是整条链路的身份依据:展示端用同一个扫描器(shared 的 markdownImageRefs)重新
 * 认一遍正文,按 `source` 把每一处引用对上它自己那份拷贝。这件事**不能靠文件名或出场顺序
 * 去猜** —— 同一个路径在一轮里被重拍过(先「修改前」后「修改后」)时,猜出来的那张恰好是
 * 错的那张,而「结论说修改后、画的是修改前」比不画更坏(审查第 1 轮 F1)。
 *
 * 逐处引用各返回一条:同一处目的地被引用两次就两条(字节没变时指向同一份拷贝),同一份
 * 字节挂着两个名字也两条(path 相同、source 不同)。
 */
export function persistMarkdownImages(
  text: string,
  seen: ImageStore = new Map(),
  options: { directory?: string; cwd?: string } = {},
): PersistedMarkdownImage[] {
  const directory = options.directory ?? UPLOADS_DIR;
  const persisted: PersistedMarkdownImage[] = [];
  for (const [index, ref] of markdownImageRefs(text).entries()) {
    const path = localImagePath(ref.destination, options.cwd);
    const mime = path ? EXT_MIME[extname(path).toLowerCase()] : undefined;
    if (!path || !mime) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue; /* 不存在 / 读不了:这一句就当没提图 */
    }
    const stored = storeImage({ mime, bytes, name: basename(path) }, seen, directory, index);
    if (stored) persisted.push({ path: stored.path, source: ref.destination });
  }
  return persisted;
}
