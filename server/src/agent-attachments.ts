import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maxBytesFor } from "@ash/shared";
import {
  destinationFilePath,
  isNetworkDestination,
  markdownImageRefs,
  type MarkdownImageRef,
} from "@ash/shared/markdown-images";
import { UPLOADS_DIR } from "./paths.js";
import { newUploadName, sanitizeUploadStem } from "./upload-names.js";

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
 * 有用得多。字符集与上传接口共用一份（`upload-names.ts`）——两边各写一套的那段日子里，
 * 这里早就放行了汉字，而扫描端按上传接口的 ASCII 集切，agent 图的中文名一律被拦腰截断。
 * 扩展名一律用 mime 对应的那个：uploads 是按扩展名定 Content-Type 的，名字里写的不算数。
 */
function uploadFileNameFor(name: string | undefined, ext: string, index: number): string {
  const stem = sanitizeUploadStem(name);
  return newUploadName(`${stem || `agent-image-${index + 1}`}.${ext}`);
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

/**
 * 一次落盘的结果。**「不该存」和「存不下」必须分得开**:前者(类型不收、空字节、超过上限)
 * 是我们自己决定不留副本,那一刻的画面从来没被我们拿在手里;后者(盘满、权限)是字节已经
 * 读到了、写盘失败了,这一刻的画面**丢了**。两者的出路相反 —— 前者让展示端退一档去工作
 * 目录取当前文件,后者必须显式作废,否则就是把后来的画面当成旧结论(见
 * `PersistedMarkdownImage` 的 `lost`)。混成一个 `null` 的那一版只能靠调用点猜「读到字节
 * 了却没存下 ⇒ 丢了」,于是一张超限的大图也被判成「丢了」。
 */
type StoredImage =
  | { path: string; fresh: boolean; failed?: undefined }
  | { path: null; fresh?: undefined; failed: boolean };

/** 落一张图,返回它在 uploads 里的路径;`fresh=false` = 这份字节本次运行已经存过了。 */
function storeImage(
  { bytes, mime, name }: ImageBytes,
  seen: ImageStore,
  directory: string,
  index = 0,
): StoredImage {
  const ext = MIME_EXT[mime];
  if (!ext || !bytes.length || bytes.length > maxBytesFor(mime)) return { path: null, failed: false };
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
    // 半截文件不留:盘满那种失败往往已经写进去一部分,留着就是一张永远打不开的图,而且
    // 它按内容寻址的名字会让下一次引用误以为「这份字节已经存过了」(审查第 3 轮 N3)。
    try {
      unlinkSync(path);
    } catch {
      /* 压根没写出来过 */
    }
    console.warn(`[ash] failed to persist agent image ${path}:`, error);
    return { path: null, failed: true };
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
    .map((stored) => (stored.path && stored.fresh ? stored.path : null))
    .filter((path): path is string => !!path);
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
    // 查询/片段不是文件名的一部分,解码之前先切掉:口径与展示端共用一份(审查第 4 轮 R4)。
    const path = destinationFilePath(destination);
    if (!path) return null;
    if (isAbsolute(path)) return path;
    return cwd ? resolve(cwd, path) : null;
  } catch {
    // 不合法的 file URL。坏转义不在这里拦:解不开就原样留着,合不合法由读取端判(见
    // destinationFilePath),而 `file:` 的 pathname 本来就不含查询/片段。
    return null;
  }
}

/**
 * 这个目的地**可证明**不需要本地结果(站外/协议相对/data: 一类,浏览器自己取):交代侧
 * 不会为它产生记录。恢复侧按它识别交付序列里的合法间隔 —— 老账没有 skipped 行(第 9 轮
 * 复审 R3),只能按真实解析出的节点自证;相对路径不算(有 cwd 它就是本机文件,该有记录)。
 */
export function externalImageDestination(destination: string): boolean {
  if (/^file:\/\//i.test(destination)) return false;
  return isNetworkDestination(destination) || !destinationFilePath(destination);
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
 * 在本流里的身份。`path` 在 = 这处引用那一刻的拷贝;`path` 不在 = **这处引用确实没有副本**。
 * 两件事必须分得开:展示端据此决定「拿副本画」还是「现在去工作目录取一次」;混在一起就会
 * 把「关联丢了」当成「从来没存过」,绕过仍然存在的正确副本去画当前文件(审查第 1 轮 F1 实测 B)。
 *
 * 没有副本还分两种,`lost` 就是这一位:
 *   · `lost` 不在 —— **压根没有字节可存**(说那句话时文件还不存在、格式不认、是站外地址)。
 *     agent 先写 `![](shot.png)` 再去截图是常事,那张图现在躺在工作目录里就是它说的那张,
 *     展示端退一档去取是对的。
 *   · `lost: true` —— **字节当时读到了、写盘失败了**(盘满、权限)。这一处引用那一刻的画面
 *     我们**丢了**,而文件后来可能已经被重拍过 —— 此时拿「现在的文件」去画就是把后来的画面
 *     当成旧结论(审查第 3 轮 R1 同类位置)。展示端据此显式作废,不猜。
 */
export type PersistedMarkdownImage = { source: string; ref: number; pos?: number; path?: string; lost?: boolean };

/**
 * 流式阶段对**一处引用**的交代 —— 不是「拍到的那份字节」,而是**这处引用的保存状态**。
 *
 * `destination` 必须跟着记:半截正文的语法结论随时会被后文推翻,同一个位置上的目的地也
 * 会跟着变(`[r]: output/` 再来一片才是 `[r]: output/x.png`)。配不上就当没拍过。
 *
 * 状态有三档,而且**单调** —— 一旦落下来就不再被改写(见 captureMarkdownImages):
 *   · `path` 在 —— 这一刻的字节已经存成那份拷贝;
 *   · `lost: true` —— 字节**读到了、写盘失败了**。这一刻的画面丢了,后面任何一遍扫描、
 *     以及收尾那一遍都**不许再去读文件**:文件可能已经被重拍,读到的是后来的画面,端出去
 *     就是把新画面当成旧结论(审查第 3 轮 R1 实测:期望 `[LOST, BLUE]`,实际 `[BLUE, BLUE]`)。
 *     「临时失败下次重试」听着更宽容,但它重试的是**读盘**而不是那一刻的字节,方向正好相反。
 *   · 压根没有这个键 —— 还没扫到它,或者本来就不该存(站外地址、类型不收、超过上限)。
 *     这一档才轮到收尾那一遍去读文件,以及展示端退一档去工作目录取。
 */
export type ImageSnapshot = { destination: string; path?: string; lost?: boolean };
/** key = 这一处引用在**这份文档全文**里的起点(全文一个字不裁,所以这个坐标永不变)。 */
export type ImageSnapshots = Map<number, ImageSnapshot>;

type MarkdownImageOptions = {
  directory?: string;
  cwd?: string;
  /** 流式阶段拍下的字节(见 captureMarkdownImages):有就用它,没有才现在去读文件。 */
  snapshots?: ImageSnapshots;
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
/**
 * 落盘这一侧真正需要的「一处引用」:**只有目的地和它在全文里的起点**。
 *
 * 收窄到这两个字段是故意的:定义后到的那几处引用在解析树里压根不是图片节点(见 shared 的
 * `MarkdownWaitingRef`),拼不出一个完整的 `MarkdownImageRef`,而它们的字节恰恰最需要在
 * 「定义到达那一刻」就冻结。要求整个节点就等于把这一档永久挡在门外。
 */
export type ImageRefSpot = Pick<MarkdownImageRef, "destination" | "start">;

export function captureMarkdownImages(
  refs: readonly ImageRefSpot[],
  seen: ImageStore,
  snapshots: ImageSnapshots,
  options: MarkdownImageOptions = {},
): string[] {
  const directory = options.directory ?? UPLOADS_DIR;
  const stored: string[] = [];
  for (const ref of refs) {
    // 这处引用已经有交代了(存下了、或者字节丢了)就**一个字都不再动** —— 状态是单调的,
    // 见 ImageSnapshot。流式阶段每片都会重扫同一段正文,少了这一道,上一片记下的「丢了」
    // 会被这一片的重新读盘洗掉。
    if (snapshots.get(ref.start)?.destination === ref.destination) continue;
    const bytes = readImageAt(ref.destination, options.cwd);
    if (!bytes) continue;
    const copy = storeImage(bytes, seen, directory, snapshots.size);
    if (copy.path === null) {
      // 不该存的(类型/大小)不留状态:那一档本来就该退到「去工作目录取」。
      if (copy.failed) snapshots.set(ref.start, { destination: ref.destination, lost: true });
      continue;
    }
    snapshots.set(ref.start, { destination: ref.destination, path: copy.path });
    if (copy.fresh) stored.push(copy.path);
  }
  return stored;
}

/**
 * 流式阶段拍下、最后**没有任何一条结果领走**的那几份拷贝:删掉。
 *
 * 为什么会有这种拷贝:拍字节发生在半截正文上(见 captureMarkdownImages),而「哪几处是真图」
 * 由定型之后那一遍扫描说 —— 行内代码的反引号切在两片里时,前半片里那个写法示例看着是真图,
 * 字节已经拍下来了,拼全了它却是代码。那份拷贝不进任何 uploads 记录、谁都引用不到,留着
 * 就是纯粹的磁盘垃圾。
 *
 * 只删**本流新落盘且没被领走**的:按内容寻址复用到的那些(fresh=false)压根不在这个清单里,
 * 被某条结果领走的由 `claimed` 挡住 —— 同一份字节可能在后面的消息里被真的引用到。
 */
export function discardUnclaimedImages(captured: Iterable<string>, claimed: ReadonlySet<string>): void {
  for (const path of captured) {
    if (claimed.has(path)) continue;
    try {
      unlinkSync(path);
    } catch {
      /* 删不掉就留着:一份没人引用的拷贝不值得把事件流掀掉 */
    }
  }
}

/** 把已经扫出来的那几处引用逐一落盘 —— 扫描结果复用时走这条(流式那层只扫一遍)。 */
export function persistMarkdownImageRefs(
  refs: readonly ImageRefSpot[],
  seen: ImageStore,
  options: MarkdownImageOptions = {},
): PersistedMarkdownImage[] {
  const directory = options.directory ?? UPLOADS_DIR;
  const persisted: PersistedMarkdownImage[] = [];
  for (const ref of refs) {
    // 站外地址、data:、给不出 cwd 的相对路径:本来就不该有「保存结果」,一条都不发
    // —— 发了等于告诉展示端「这处引用我管过」,而它其实只能靠浏览器自己去取。
    if (!localImagePath(ref.destination, options.cwd)) continue;
    const id = seen.refs;
    seen.refs += 1;
    const snapshot = options.snapshots?.get(ref.start);
    // 流式阶段对这处引用的交代**就是结论**:存下了用那份拷贝,记着丢了就照实报丢了。
    // 两种都不许再去读文件 —— 现在读到的是「现在的文件」,不是它说的那一张(见 ImageSnapshot)。
    const settled = snapshot?.destination === ref.destination ? snapshot : null;
    let copy = settled?.path ?? null;
    // 字节读到了却存不下来 = 这一刻的画面**丢了**(见 PersistedMarkdownImage 的 lost)。
    let lost = !!settled?.lost;
    if (!copy && !lost) {
      const bytes = readImageAt(ref.destination, options.cwd);
      const stored = bytes ? storeImage(bytes, seen, directory, id) : null;
      copy = stored?.path ?? null;
      lost = !!stored?.failed;
    }
    // `pos` 是这处引用的文档节点身份(事件、持久账、展示端三方对同一处的称呼),见 shared
    // 的 attachment 事件:恢复补回的记录靠它排回文档顺序。
    persisted.push(copy
      ? { source: ref.destination, ref: id, pos: ref.start, path: copy }
      : lost
        ? { source: ref.destination, ref: id, pos: ref.start, lost: true }
        : { source: ref.destination, ref: id, pos: ref.start });
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
