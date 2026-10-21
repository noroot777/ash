import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maxBytesFor } from "@ash/shared";
import { isNetworkDestination, markdownImageRefs, type MarkdownImageRef } from "@ash/shared/markdown-images";
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
 * 一条事件流落图的账本。
 *
 * `copies` 是**内容 hash → uploads 里那份拷贝的路径**:同一份字节只写一个文件(同一张图
 * 被正文用两个名字引用、或者工具结果先交上来、正文随后才提它,都复用它)。
 *
 * `refs` 是**下一处正文引用的身份**:单调递增,不去重、不复位。字节可以按内容去重,
 * **引用关联不能** —— 同一个路径在一轮里被重拍过(红→蓝→红)时,第三处引用的字节跟第一处
 * 一样,但它说的是第三张;按「来源+拷贝」去重会把它整条抹掉,展示端队列短一条,于是正文
 * 写着「恢复红色」、画出来是蓝色(审查第 1 轮 F1)。
 */
export type ImageStore = {
  copies: Map<string, string>;
  refs: number;
};

export const imageStore = (): ImageStore => ({ copies: new Map(), refs: 0 });

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
  const known = seen.copies.get(hash);
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
  seen.copies.set(hash, path);
  return { path, fresh: true };
}

export function persistToolResultImages(
  value: unknown,
  seen: ImageStore = imageStore(),
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
    // 协议 **或 `//` 协议相对网址**都是浏览器去网络取的地址,不是本机文件(审查第 2 轮
    // F3:只问 scheme 时 `//cdn.x/a.png` 会被 `isAbsolute` 当成绝对路径读一遍)。
    if (isNetworkDestination(destination)) return null;
    const path = decodeURIComponent(destination);
    if (isAbsolute(path)) return path;
    return cwd ? resolve(cwd, path) : null;
  } catch {
    return null; /* 坏转义 / 不合法的 file URL */
  }
}

/** 正文里一处引用指到的那张本机图片,**此刻**的字节;不是本机图片 / 读不到就返回 null。 */
function readImageAt(destination: string, cwd?: string): ImageBytes | null {
  const path = localImagePath(destination, cwd);
  if (!path) return null;
  const mime = EXT_MIME[extname(path).toLowerCase()];
  if (!mime) return null;
  try {
    return { mime, bytes: readFileSync(path), name: basename(path) };
  } catch {
    return null; /* 不存在 / 读不了 */
  }
}

/**
 * 正文里**一处**引用的保存结果。
 *
 * `source` 是目的地(规范化后的那个,见 shared 的 markdownImageRefs),`ref` 是这一处引用
 * 在本流里的身份。`path` 在 = 这处引用那一刻的拷贝;`path` 不在 = **这处引用确实没有副本**
 * (文件读不到、格式不认、写盘失败)。两件事必须分得开:展示端据此决定「拿副本画」还是
 * 「现在去工作目录取一次」;混在一起就会把「关联丢了」当成「从来没存过」,绕过仍然存在的
 * 正确副本去画当前文件(审查第 1 轮 F1 实测 B)。
 */
export type PersistedMarkdownImage = { source: string; ref: number; path?: string };

/**
 * 流式阶段拍下的一份字节快照。
 *
 * `destination` 必须跟着记:半截正文的语法结论随时会被后文推翻,同一个位置上的目的地也
 * 会跟着变(`[r]: output/` 再来一片才是 `[r]: output/x.png`)。配不上就当没拍过。
 */
export type ImageSnapshot = { destination: string; path: string };
export type ImageSnapshots = Map<string, ImageSnapshot>;

/** 快照的身份:这一轮攒的正文里**哪个位置**那一处引用(generation 由调用方在裁剪后递增)。 */
function snapshotKey(generation: number, start: number): string {
  return `${generation}:${start}`;
}

type MarkdownImageOptions = {
  directory?: string;
  cwd?: string;
  /** 流式阶段拍下的字节(见 captureMarkdownImages):有就用它,没有才现在去读文件。 */
  snapshots?: ImageSnapshots;
  generation?: number;
};

/**
 * 「先拍下来,待会儿再认」—— 流式阶段把这几处引用**当下**的字节复制进 uploads。
 *
 * 不发事件、不占身份(`seen.refs` 一个都不动):这一刻的语法结论是半截正文给的,随时会被
 * 后文推翻,所以「哪几处是真图」只能等消息收尾那一遍权威扫描说(见 parsers.ts)。可**字节
 * 不能等** —— 一条消息里 agent 边说边重拍同一个路径是常事(红→蓝→红),等收尾再去读文件,
 * 三处引用会一起拿到最后那份字节,于是正文写着「恢复红色」、画出来是蓝色(审查第 1 轮 F1
 * 实测 A)。所以字节按「说到它的那一刻」拍,身份按「消息完整时」认。
 *
 * 代价:拼全了才知道不是图的那种(行内代码的一对反引号被切在两片里),uploads 里会多留一
 * 份没人引用的拷贝。它不进任何 uploads 记录(那是 attachment 事件的事),用户看不见;而且
 * 按内容寻址,跟真图字节一样时连文件都不会多一个。
 */
export function captureMarkdownImages(
  refs: MarkdownImageRef[],
  seen: ImageStore,
  snapshots: ImageSnapshots,
  options: MarkdownImageOptions = {},
): void {
  const directory = options.directory ?? UPLOADS_DIR;
  const generation = options.generation ?? 0;
  for (const ref of refs) {
    const key = snapshotKey(generation, ref.start);
    if (snapshots.get(key)?.destination === ref.destination) continue;
    const bytes = readImageAt(ref.destination, options.cwd);
    if (!bytes) continue;
    const stored = storeImage(bytes, seen, directory, snapshots.size);
    if (stored) snapshots.set(key, { destination: ref.destination, path: stored.path });
  }
}

/** 把已经扫出来的那几处引用逐一落盘 —— 扫描结果复用时走这条(流式那层只扫一遍)。 */
export function persistMarkdownImageRefs(
  refs: MarkdownImageRef[],
  seen: ImageStore,
  options: MarkdownImageOptions = {},
): PersistedMarkdownImage[] {
  const directory = options.directory ?? UPLOADS_DIR;
  const generation = options.generation ?? 0;
  const persisted: PersistedMarkdownImage[] = [];
  for (const ref of refs) {
    // 站外地址、data:、给不出 cwd 的相对路径:本来就不该有「保存结果」,一条都不发
    // —— 发了等于告诉展示端「这处引用我管过」,而它其实只能靠浏览器自己去取。
    if (!localImagePath(ref.destination, options.cwd)) continue;
    const id = seen.refs;
    seen.refs += 1;
    const snapshot = options.snapshots?.get(snapshotKey(generation, ref.start));
    let copy = snapshot?.destination === ref.destination ? snapshot.path : null;
    if (!copy) {
      const bytes = readImageAt(ref.destination, options.cwd);
      copy = bytes ? storeImage(bytes, seen, directory, id)?.path ?? null : null;
    }
    persisted.push(copy ? { source: ref.destination, ref: id, path: copy } : { source: ref.destination, ref: id });
  }
  return persisted;
}

/**
 * 把正文引用到的本机图片复制进 uploads,并标明**是哪一处引用的**。
 *
 * 为什么要逐处标身份:展示端用同一个扫描器(shared 的 markdownImageRefs)重新认一遍正文,
 * 按「第 n 处指向这个目的地的引用 ↔ 第 n 条报这个来源的结果」对账。这个对应关系是
 * **构造出来的**(每一处引用恒发一条、按文档顺序、不去重),不是按文件名或出场顺序猜的
 * —— 猜的那一版在同一个路径被重拍过时恰好画成错的那张,而「结论说修改后、画出来是修改
 * 前」比不画更坏(审查第 1 轮 F1)。
 */
export function persistMarkdownImages(
  text: string,
  seen: ImageStore = imageStore(),
  options: MarkdownImageOptions = {},
): PersistedMarkdownImage[] {
  return persistMarkdownImageRefs(markdownImageRefs(text), seen, options);
}
