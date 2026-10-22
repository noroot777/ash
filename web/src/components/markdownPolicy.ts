import { destinationFilePath, hasUrlScheme, isNetworkDestination } from "@ash/shared/markdown-images";
import { api } from "../lib/api.ts";
import { attachmentView, isImagePath } from "../task-detail/utils.ts";

// 名字那一段允许带子目录（`shots/a.png`）：证据接口服务得了它（evidence-path.ts）。`..`
// 由 reviewFileTarget 里的 PARENT_SEGMENT 挡，不塞进正则 —— 正则里表达它既难读又易漏。
const REVIEW_FILE_PATH = /\/data\/runs\/([\w-]+)\/review\/round-(\d+)\/([^?#]+)(?:[?#].*)?$/;
const FREE_REVIEW_FILE_PATH = /\/data\/runs\/([\w-]+)\/free-review\/([\w-]+)\/round-(\d+)\/([^?#]+)(?:[?#].*)?$/;

export type ReviewFileTarget = {
  name: string;
  url: string;
};

// 坏转义原样留着：允许哪些文件名、路径安不安全，权威在服务端，不在这里。
function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function reviewFileTarget(path?: string): ReviewFileTarget | null {
  if (!path) return null;
  // 下面两条正则认的是**磁盘路径形状**(`/Users/…/data/runs/…`、`file://…`)。站外网址里
  // 碰巧有同样的路径形状时不许按它改写:那张图住在别人站上,改写过来只会 404,还顺手把
  // 「这是谁家的资源」判错(审查第 3 轮 R3 第 5 条)。`file:` 例外 —— 它指的就是本机文件。
  const offSite = isNetworkDestination(path) && !/^file:\/\//i.test(path.trim());
  const review = offSite ? null : path.match(REVIEW_FILE_PATH);
  if (review) {
    const [, taskId, round, encodedName] = review;
    const name = decodeSafe(encodedName);
    if (!PARENT_SEGMENT.test(name)) return { name, url: api.taskReviewFileUrl(taskId, Number(round), name) };
  }
  const freeReview = offSite ? null : path.match(FREE_REVIEW_FILE_PATH);
  if (freeReview) {
    const [, taskId, runId, round, encodedName] = freeReview;
    const name = decodeSafe(encodedName);
    if (!PARENT_SEGMENT.test(name)) return { name, url: api.freeReviewFileUrl(taskId, runId, Number(round), name) };
  }
  const url = sameOriginUrl(path);
  if (!url || !isReviewFileEndpoint(url.pathname)) return null;
  // query 参数已经被 `URLSearchParams` 解过码,不再解第二遍(理由见 siblingResolverForUrl)。
  // 上面两条分支的输入是**磁盘路径或 file URL**混在一起的形状,那一层确实要自己解。
  const name = url.searchParams.get("name") ?? "";
  return name ? { name, url: url.toString() } : null;
}

export function isLocalOpenHref(href?: string): href is string {
  if (!href) return false;
  try {
    return new URL(href, window.location.origin).pathname === "/api/open-local";
  } catch {
    return false;
  }
}

/**
 * 「`/` 开头的这一串是磁盘路径吗」只在**打开本地文件**那条路上用这张白名单。
 *
 * 它天生不全(合法的 POSIX 根可以叫 `/data`、`/app`、`/code`、`/System`…),但那条路的
 * 后果是「少一个右键打开入口」,而放宽的后果是把站内地址送进 `/api/open-local`。图片
 * 那条路不能用它:判据见 `taskFilePath`(审查第 1 轮 F3)。
 */
const POSIX_DISK_ROOT = /^\/(?:Users|home|root|tmp|private|var|Volumes|opt|workspace|workspaces|mnt|srv)\//;
const WINDOWS_DISK_ROOT = /^[A-Za-z]:[\\/]/;
const UNC_ROOT = /^\\\\[^\\]+\\[^\\]+/;

/** `file://` → 本机路径(含 UNC 与 Windows 盘符两种形状)。 */
function fileUrlPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    const path = decodeSafe(url.pathname);
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** Return the actual filesystem path represented by a Markdown destination. */
export function localDiskPath(href?: string): string | null {
  const raw = href?.trim();
  if (!raw) return null;
  if (/^file:\/\//i.test(raw)) return fileUrlPath(raw);
  // 形状(哪种根)各档自己判,**路径成分**一律交给共享契约:去查询/片段、解码一次,两边
  // 一个字不差(审查第 4 轮 R4;盘符/UNC 分支原先连查询都没去,是这里自己的不一致)。
  if (WINDOWS_DISK_ROOT.test(raw) || UNC_ROOT.test(raw)) return destinationFilePath(raw);
  if (!POSIX_DISK_ROOT.test(raw)) return null;
  return destinationFilePath(raw);
}

/** Raw disk paths and explicit open-local URLs converge on one visible, clickable endpoint. */
export function localOpenUrl(href?: string): string | null {
  if (!href) return null;
  if (isLocalOpenHref(href)) return currentOriginOpenLocalUrl(href);
  const path = localDiskPath(href);
  if (!path) return null;
  const target = new URL("/api/open-local", window.location.origin);
  target.searchParams.set("path", path);
  return target.toString();
}

export type TaskFileOpenTarget = {
  taskId: string;
  path: string;
};

/** A managed worktree path can be reopened through the task API even after that worktree is cleaned. */
export function taskFileOpenTarget(href?: string): TaskFileOpenTarget | null {
  const diskPath = localDiskPath(href);
  if (!diskPath) return null;
  const normalized = diskPath.replace(/\\/g, "/");
  const match = /(?:^|\/)\.worktrees\/([^/]+)\/(.+)$/.exec(normalized);
  return match ? { taskId: match[1], path: match[2] } : null;
}

/** 这个地址是不是**这个站自己**服务的（取不到就是「文件真没了」，而不是网络问题）。 */
export function sameOriginUrl(href: string): URL | null {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin ? url : null;
  } catch {
    return null;
  }
}

function isReviewFileEndpoint(pathname: string): boolean {
  return pathname.endsWith("/review/file") || pathname.endsWith("/free-workflow/review-file");
}

/**
 * 站内取得到的那张图：灯箱要的 url，加上给人看的名字。
 *
 * 曾经还带一个 `fallback`「取不到再试另一个根」——那条路已经删掉:**加载失败只能证明那个
 * 文件此刻取不到,证明不了这处引用说的是另一个根**。证据文件被删掉之后它恰好会去工作目录
 * 里取同名的另一张图端上来(审查第 3 轮 R3 第 1 条实测:naturalWidth=400 的另一张蓝图)。
 * 现在的归属判据见 reportFileResolver:相对路径恒属于这份文档自己那个目录。
 */
export type ImagePreviewTarget = ReviewFileTarget;

/**
 * 「这段 Markdown 的相对路径该按哪儿解」。
 *
 * 必要性：对话正文和审查报告都是**没有文档根**的 Markdown —— 浏览器把 `![](shot.png)`
 * 当成相对当前页面的地址，于是 `http://…/shot.png` 必然 404，正文里就是一个裂开的
 * 图标。而 agent 写相对路径恰恰是最自然的：审查者的截图跟 report.md 同在证据目录，
 * 实现者的截图就在它自己的工作目录里。所以每个渲染点都得自己说清「我这份正文的相对
 * 路径指向哪」，没有默认值可猜。
 *
 * 返回 null = 这个目标我解释不了，交回后面的策略（站外链接照常，本机路径由
 * `isLocalImageReference` 收掉，不留裂图标）。
 */
export type MarkdownFileResolver = (destination: string) => ImagePreviewTarget | null;

/**
 * 「跟这份正文同一个目录里的那个文件」——文件名（`shot.png`、`./shot.png`）**或它下面的
 * 子路径**（`shots/deep.png`）。
 *
 * 口径跟着服务端走：证据接口接受证据目录内的相对路径（`server/src/evidence-path.ts` 的
 * `evidenceSegments`），所以这里认同样的形状 —— 绝对路径、协议、`..` 段一律不认，拼出来
 * 也是个必 404 的地址。曾经两边都只认 basename，于是审查者把截图归进 `shots/` 就等于没
 * 放（审查第 1 轮非阻塞项 2）。
 */
export function siblingFileName(destination: string): string | null {
  if (!isDocumentRelative(destination)) return null;
  const raw = destinationFilePath(destination);
  if (!raw || PARENT_SEGMENT.test(raw)) return null;
  // `.` 段**消去而不是拒掉**:`shots/./shot.png` 在 Markdown/HTML 里跟 `shots/shot.png`
  // 是同一个文件,证据接口只认后者(server 的 evidenceSegments 把 `.` 段一律拒了)。拒掉
  // 它的那一版不是「少画一张图」—— 下一档会把这处引用判成工作目录的,于是工作目录里同名
  // 的另一张图被端上来冒充证据(审查第 3 轮 R4 第 1 条)。`..` 仍然显式拒:规范化之后它
  // 指的是证据根之外,拼出来也是个必 400 的地址。
  const parts = raw.split(/[/\\]/).filter((part) => part !== ".");
  return parts.length && parts.every(Boolean) ? parts.join("/") : null;
}

/**
 * 这处引用是**相对这份文档**的吗 —— 归属判定的第一问,而且只问形状,不问「解不解释得通」。
 *
 * 四类不是:带协议的(`http:`、`data:`、`file:`)、`/` 或 `\` 开头的绝对路径与 UNC、
 * 盘符开头的 Windows 绝对路径。剩下的一律是相对引用,**哪怕它最终解不出一个合法名字**
 * (`..` 爬出去、空段)—— 解释失败绝不改变它属于哪个根(见 reportFileResolver)。
 */
export function isDocumentRelative(destination?: string): boolean {
  const raw = destination?.trim();
  if (!raw || hasUrlScheme(raw) || /^[a-zA-Z]:/.test(raw)) return false;
  return !raw.startsWith("/") && !raw.startsWith("\\");
}

/** `..` 爬出去的那一段——服务端一律 400,这里就别拼这个必败的地址。 */
const PARENT_SEGMENT = /(^|[/\\])\.\.([/\\]|$)/;

/**
 * 这个站**自己服务**的那几条路径。`/` 开头的地址里只有它们是网址,其余都是磁盘路径。
 *
 * 为什么是「站内路由白名单」而不是「磁盘根白名单」:前者是我们自己的路由表,知道得全;
 * 后者是整个文件系统的顶层目录,`/System`、`/data`、`/app`、`/code`、`/projects` 都合法,
 * 列不全(审查第 1 轮 F3 —— 上一版照搬了 `localDiskPath` 的磁盘根白名单,于是容器里
 * `/app/output/x.png` 这类合法绝对路径在到达文件接口之前就被当成站内地址拒掉了)。
 * 猜错的代价也不对称:把站内地址当成磁盘路径,顶多多问一次服务端然后 404 收起;把磁盘
 * 路径当成站内地址,那张图就永远画不出来。
 */
const SITE_ROUTE = /^\/(?:api|assets|review|mobile)(?:\/|$)/;

/**
 * 这个 `![]()` 指的是**任务工作目录里**的哪个文件(相对路径原样留着,绝对路径按真路径)。
 *
 * 用处是「读的时候再取一次」那一档:服务端从 2026-10-21 起会在收到正文的那一刻把被引用
 * 的图复制进 `data/uploads/`,但**那之前的消息一份拷贝都没有**,而文件往往还好好躺在工作
 * 目录里(用户 2026-10-21 的截图就是这一幕:正文里是裂图标,「生成物」面板里那几个文件
 * 明明在)。只要那个目录还在,`/api/tasks/:id/file/raw` 就取得到它。
 *
 * 判据只有两条:**带协议的是网址**(`http:`/`data:`/`blob:`…,`file:` 例外,它指的就是本机
 * 文件),**站内路由是网址**(见 SITE_ROUTE)。剩下的一律当路径交给服务端 —— 它在哪个根
 * 下、有没有爬出去、符号链接指到哪儿,权威是 `resolveInRoot` 加 realpath 那道门禁,不是
 * 这里的字符串形状。解得出路径不等于取得到字节:目录被清掉、文件被删都会 404,所以调用
 * 点必须保证「取不到就什么都不画」(见 MarkdownBody 的 MarkdownImage)。
 */
export function taskFilePath(destination?: string): string | null {
  const raw = destination?.trim();
  if (!raw) return null;
  const path = /^file:\/\//i.test(raw)
    ? fileUrlPath(raw)
    : WINDOWS_DISK_ROOT.test(raw) || UNC_ROOT.test(raw)
      ? destinationFilePath(raw)
      // isNetworkDestination 而不是 hasUrlScheme:`//cdn.example.com/a.png` 是协议相对网址,
      // 没有协议却绝不是本机路径。只问 scheme 的那一版把它改写成「去工作目录取」,于是这
      // 张站外图永远画不出来(审查第 2 轮 F3)。UNC 的 `\\server\share` 上一档已经认掉。
      : isNetworkDestination(raw) || SITE_ROUTE.test(raw)
        ? null
        : destinationFilePath(raw.replace(/^(?:\.\/)+/, ""));
  if (!path || PARENT_SEGMENT.test(path)) return null;
  return path;
}

/**
 * 「这份正文的相对路径按任务工作目录解」——对话正文那一档。
 *
 * 跟 `siblingFileResolver`（审查报告 → 证据目录）是并列的两档，不是替代：审查报告里
 * 的截图跟 report.md 同住证据目录，而 agent 在对话里写的是它自己工作目录里的路径。
 */
export function taskFileResolver(taskId: string): MarkdownFileResolver {
  return (destination) => {
    const path = taskFilePath(destination);
    if (!path) return null;
    return {
      name: path.split(/[/\\]/).pop() || path,
      // 只认任务自己那个工作目录：退到项目主仓会解到同名的**另一个**文件上（见 fileApi）。
      url: api.taskFileRawUrl(taskId, path, { workspaceOnly: true }),
    };
  };
}

/** 正文跟它引用的文件同住一个目录时的解析器（审查报告：report.md 和截图在一起）。 */
export function siblingFileResolver(urlFor: (name: string) => string): MarkdownFileResolver {
  return (destination) => {
    const name = siblingFileName(destination);
    return name ? { name, url: urlFor(name) } : null;
  };
}

/**
 * 审查报告这份正文的**文档根归属**，一处定清楚（三个入口共用：团队证据、自由工作流
 * 检视、单独打开的报告弹窗）。
 *
 * 判据只有一条,而且是 Markdown/HTML 的通用口径:**相对路径相对的就是这份文档自己那个
 * 目录**（证据目录,子目录里的报告则是它自己那一层,见 siblingResolverForUrl）。解不成
 * 相对路径的那些（绝对路径、`file:`、UNC、盘符）才有第二身份 = 被审任务的工作目录 ——
 * 那是**显式**的归属,不是猜的。
 *
 * 曾经试过两版「消歧」,都被证伪:
 *   · 「先按证据目录解,加载失败再换工作目录」—— 加载失败只能证明此刻取不到,证明不了
 *     这处引用说的是另一个根(审查第 2 轮 F1 同类位置);
 *   · 「问服务端要这一轮的文件清单,不在清单里就算工作目录的」—— 清单只能回答「现在有
 *     没有」。证据文件被删掉之后那一处就被判成工作目录的,于是把同名的另一张图端上来
 *     (审查第 3 轮 R3 第 1 条实测);清单取不到、还在路上时又只能退回上一版那条路。
 * 所以不再猜:相对路径一律落在文档目录上,取不到就如实报「图取不到」加上那个路径 ——
 * 宁可让人自己去证据目录找,也不许把另一个根下同名的文件冒充成它。
 */
export function reportFileResolver(
  urlFor: (name: string) => string,
  taskId?: string,
): MarkdownFileResolver {
  const sibling = siblingFileResolver(urlFor);
  const workspace = taskId ? taskFileResolver(taskId) : undefined;
  // **先定种类,再谈解析**。`sibling(x) ?? workspace(x)` 那一版是「谁解释得通就归谁」:
  // 两档的形状判据宽严不同(`shots/./shot.png` 前者拒、后者收),于是一处合法的相对引用
  // 会掉到工作目录那一档上,把同名的另一张图端上来(审查第 3 轮 R4 第 1 条)。所以相对
  // 引用**恒属于这份文档**:解不出合法名字就如实报「图取不到」,一个字都不换根。
  return (destination) => (
    isDocumentRelative(destination) ? sibling(destination) : workspace?.(destination) ?? null
  );
}

/**
 * 同一个目录的解析器，但直接从「这份正文自己的地址」推出来。
 *
 * 证据接口的两条路径（`…/review/file`、`…/free-workflow/review-file`）都是把文件名放在
 * `?name=`，所以换掉那一个参数就是同目录的另一个文件。打开一份孤立报告（正文里指向
 * report.md 的链接）时手上只有这个 URL，没有 run/round，这是唯一解得出来的办法。
 *
 * **子目录里的报告按它自己那一层解**:`name=notes/supplement.md` 里的 `shot.png` 指的是
 * `notes/shot.png`,不是证据根下那一张。丢掉这一层的那一版会把根目录下同名的另一张图端
 * 上来(审查第 3 轮 R3 第 4 条实测)。
 */
export function siblingResolverForUrl(fileUrl: string): MarkdownFileResolver | undefined {
  const base = sameOriginUrl(fileUrl);
  if (!base || !isReviewFileEndpoint(base.pathname) || !base.searchParams.has("name")) return undefined;
  // 文档根归属见 reportFileResolver。这个弹窗手上只有报告自己的地址，而任务 id 就在
  // 那个地址里（报告里也会提到工作目录里的文件）。
  const taskId = /\/tasks\/([^/]+)\//.exec(base.pathname)?.[1];
  // `URLSearchParams.get` **已经解过一次码**,这里不许再解:名字字面含 `%20` 的目录
  // (`notes%20raw/`)会被解成 `notes raw/`,于是同一份报告里的 `shot.png` 被请求到另一个
  // 目录下(审查第 3 轮 R4 第 2 条)。磁盘路径、原始 Markdown URL 里的转义、以及已经取出
  // 来的 query 参数是三层不同的编码,不能机械地都解一遍 —— 下面的 taskId 取自 pathname,
  // 那一层没人替我们解,所以它仍然要 decodeSafe。
  const document = (base.searchParams.get("name") ?? "").replace(/\\/g, "/");
  const directory = document.includes("/") ? document.slice(0, document.lastIndexOf("/") + 1) : "";
  return reportFileResolver((name) => {
    const url = new URL(base.toString());
    url.searchParams.set("name", `${directory}${name}`);
    return url.toString();
  }, taskId ? decodeSafe(taskId) : undefined);
}

// 正文里指向图片的**链接**（不是 `![]()` 内嵌图），点开要落进全站统一的灯箱，而不是
// 甩出一个新标签页——新标签页没有上一张/下一张、没有 Esc 关闭，还把人从对话里带走了。
// 判定顺序就是「这张图住在哪」，每一档都对应一个真能把字节吐出来的接口：
//   ① 验证证据 data/runs/<task>/{review,free-review}/… → 对应证据接口（绝对路径、file:// 都认）
//   ② 用户贴的附件 data/uploads/<file>                → 附件接口
//   ③ 本来就是站内 URL（/api/uploads/… 一类）          → 原样用
// 其余一律返回 null 交回普通链接策略：站外图照常新开，本机磁盘路径则由 localOpenUrl
// 改写到安全打开端点；这里不能拿一个服务端取不到的 URL 硬塞给灯箱。
export function imagePreviewTarget(href?: string, resolve?: MarkdownFileResolver): ImagePreviewTarget | null {
  if (!href) return null;
  // 「用系统应用打开本地文件」是另一条路，不抢它的链接。
  if (isLocalOpenHref(href)) return null;
  const servable = servableImage(href);
  if (servable) return servable;
  // ④ 这份正文自己说得出来的相对路径（审查报告 → 证据目录）。放在最后：上面三档都是
  // 自带完整地址的写法，认得出来就不该再按目录猜。
  const resolved = resolve?.(href) ?? null;
  return resolved && isImagePath(resolved.name) ? resolved : null;
}

export function isLocalDiskImagePath(href: string): boolean {
  const path = localDiskPath(href);
  return path !== null && isImagePath(path);
}

/**
 * 这个 `![]()` 指的是**本机上的一个文件**，而不是浏览器取得到的地址。
 *
 * 用途只有一个：解析不出来时**什么都不画**，而不是留一个裂开的图标。agent 说的是
 * 「我机器上的这张图」，浏览器取不到它不是网络故障，是这句话在网页上没有意义 ——
 * 画个裂图标只会让人以为功能坏了（用户 2026-10-21 报的就是这一幕）。
 *
 * 两类：`file://` 与磁盘根开头的绝对路径（`localDiskPath` 那张白名单），以及**没有协议
 * 的相对路径**。后者在这里只可能是磁盘路径：这个应用的 Markdown 没有文档根，相对地址
 * 会被解释成「相对当前页面」，必然取不到。
 *
 * 斜杠开头的站内地址**不算**：`/whatever.png` 是这个站自己服务得了的东西，照常交给
 * 浏览器，不归这条收。
 */
/**
 * 「图取不到」那行小字里报哪个地址。
 *
 * 正文里的引用可能已经被 `turnImages` 原地改写成站内接口地址（`…/file/raw?path=…`、证据
 * 接口的 `?name=…`、`/api/uploads/<12位id>-原名`）。直接报它等于把我们自己的实现细节糊到
 * 用户脸上 —— 他要核实的是 **agent 原文写的那个路径**，所以站内地址一律还原成它携带的
 * 那一个。
 */
/**
 * 「这一处引用的归属不可信,一个字都不许画」的**显式**标记。
 *
 * 为什么要有它:作废原先靠「保持原样」表达 —— 正文里仍然是 `output/shot.png`,于是下一个
 * resolver(讨论区的 taskFileResolver)照样把它解成「去工作目录取」,被作废的那处引用又被
 * 救活成当前文件(审查第 2 轮 F1:拒绝配对的结果被另一个解析入口绕过)。作废必须是一个
 * **没有任何 resolver 认得**的目的地,同时把 agent 原文写的那个地址带着,好让提示报得出。
 *
 * 形状选 `#` 开头的片段:react-markdown 不会把它清空(它是相对地址),浏览器也不会为它发
 * 请求 —— 不像一个假的站内路径那样白跑一趟 404。
 */
const UNAVAILABLE = "#ash-image-unavailable:";

export function unavailableImage(destination: string): string {
  return `${UNAVAILABLE}${encodeURIComponent(destination)}`;
}

/** 这个 src 是作废标记吗 —— 是就返回 agent 原文写的那个地址(渲染点据此报一行小字)。 */
export function unavailableImageOrigin(href: string): string | null {
  return href.startsWith(UNAVAILABLE) ? decodeSafe(href.slice(UNAVAILABLE.length)) : null;
}

export function imageOriginLabel(href: string): string {
  const url = sameOriginUrl(href);
  if (!url) return href;
  const carried = url.searchParams.get("path") ?? url.searchParams.get("name");
  if (carried) return carried;
  const uploaded = /^\/api\/uploads\/([^/]+)$/.exec(url.pathname)?.[1];
  return uploaded ? attachmentView(`data/uploads/${decodeSafe(uploaded)}`).name : href;
}

export function isLocalImageReference(href: string): boolean {
  if (!href) return false;
  if (isLocalDiskImagePath(href)) return true;
  if (hasUrlScheme(href) || href.startsWith("/")) return false;
  return isImagePath(href);
}

function servableImage(href: string): ImagePreviewTarget | null {
  const review = reviewFileTarget(href);
  if (review) return isImagePath(review.name) ? review : null;

  const url = sameOriginUrl(href);
  const external = /^https?:/i.test(href) && !url;
  if (!external) {
    const attachment = attachmentView(href.replace(/^file:\/\//i, ""));
    if (attachment.image && attachment.url) return { name: attachment.name, url: attachment.url };
  }

  if (!url) return null;
  // 站内 URL 的文件名一般就在 pathname 末段；两个例外把它放在查询串里：验证证据接口用
  // `?name=`（用户从证据面板「复制图片地址」再贴回对话里，走的就是这一条），任务工作
  // 目录的原始字节接口用 `?path=`（末段是固定的 `raw`，拿它当名字灯箱上就只剩「raw」）。
  const named = isReviewFileEndpoint(url.pathname)
    ? url.searchParams.get("name")
    : url.pathname.endsWith("/file/raw")
      ? url.searchParams.get("path")?.split(/[/\\]/).pop() ?? null
      : null;
  const name = decodeSafe(named ?? url.pathname.split("/").pop() ?? "");
  if (!isImagePath(name)) return null;
  if (!/^https?:/i.test(href) && !url.pathname.startsWith("/api/")) return null;
  return { name: name || "图片", url: url.toString() };
}

export function currentOriginOpenLocalUrl(href: string): string {
  const source = new URL(href, window.location.origin);
  const target = new URL("/api/open-local", window.location.origin);
  target.search = source.search;
  return target.toString();
}

export async function openLocalPath(href: string): Promise<void> {
  const taskFile = taskFileOpenTarget(href);
  let taskFileError: unknown = null;
  if (taskFile) {
    try {
      await api.openTaskFile(taskFile.taskId, taskFile.path, null);
      return;
    } catch (reason) {
      taskFileError = reason;
    }
  }
  const target = localOpenUrl(href);
  if (!target) throw new Error("不是可打开的本地路径");
  const response = await fetch(target);
  if (!response.ok) {
    if (taskFileError instanceof Error) throw taskFileError;
    throw new Error(await response.text() || `HTTP ${response.status}`);
  }
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

function hardenSoftBreaks(node: MarkdownNode): void {
  if (!node.children) return;
  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("\n")) {
      child.value.split("\n").forEach((part, index) => {
        if (index) children.push({ type: "break" });
        if (part) children.push({ type: "text", value: part });
      });
      continue;
    }
    hardenSoftBreaks(child);
    children.push(child);
  }
  node.children = children;
}

// Conversation-like Markdown treats a single authored newline as visible.
// Code and inlineCode nodes have no children, so their content stays untouched.
export const remarkSoftBreaks = () => hardenSoftBreaks;
