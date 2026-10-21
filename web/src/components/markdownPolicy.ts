import { api } from "../lib/api.ts";
import { attachmentView, isImagePath } from "../task-detail/utils.ts";

const REVIEW_FILE_PATH = /\/data\/runs\/([\w-]+)\/review\/round-(\d+)\/([^/?#]+)(?:[?#].*)?$/;
const FREE_REVIEW_FILE_PATH = /\/data\/runs\/([\w-]+)\/free-review\/([\w-]+)\/round-(\d+)\/([^/?#]+)(?:[?#].*)?$/;

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
  const review = path.match(REVIEW_FILE_PATH);
  if (review) {
    const [, taskId, round, encodedName] = review;
    const name = decodeSafe(encodedName);
    return { name, url: api.taskReviewFileUrl(taskId, Number(round), name) };
  }
  const freeReview = path.match(FREE_REVIEW_FILE_PATH);
  if (freeReview) {
    const [, taskId, runId, round, encodedName] = freeReview;
    const name = decodeSafe(encodedName);
    return { name, url: api.freeReviewFileUrl(taskId, runId, Number(round), name) };
  }
  const url = sameOriginUrl(path);
  if (!url || !isReviewFileEndpoint(url.pathname)) return null;
  const name = decodeSafe(url.searchParams.get("name") ?? "");
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

const POSIX_DISK_ROOT = /^\/(?:Users|home|root|tmp|private|var|Volumes|opt|workspace|workspaces|mnt|srv)\//;
const WINDOWS_DISK_ROOT = /^[A-Za-z]:[\\/]/;

/** Return the actual filesystem path represented by a Markdown destination. */
export function localDiskPath(href?: string): string | null {
  const raw = href?.trim();
  if (!raw) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const path = decodeSafe(url.pathname);
      if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
      return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
  }
  if (WINDOWS_DISK_ROOT.test(raw) || /^\\\\[^\\]+\\[^\\]+/.test(raw)) return decodeSafe(raw);
  if (!POSIX_DISK_ROOT.test(raw)) return null;
  const boundary = raw.search(/[?#]/);
  return decodeSafe(boundary < 0 ? raw : raw.slice(0, boundary));
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

function sameOriginUrl(href: string): URL | null {
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

/** 站内取得到的那张图：灯箱要的 url，加上给人看的名字。 */
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

// 带协议的目标（http:、data:、blob:、file:）不是「相对某个目录」的写法。
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 「跟这份正文同一个目录里的那个文件」——只认光秃秃的文件名（`shot.png`、`./shot.png`）。
 *
 * 收得这么紧是跟着服务端走的：证据接口只接受 `basename(name) === name` 的名字，
 * 子目录和 `..` 它一概不服务，这里放宽只会拼出一个必 404 的地址。
 */
export function siblingFileName(destination: string): string | null {
  const raw = destination.trim();
  if (!raw || URL_SCHEME.test(raw) || raw.startsWith("/")) return null;
  const name = decodeSafe(raw.replace(/^\.\//, "").split(/[?#]/)[0] ?? "");
  return name && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".." ? name : null;
}

/** 正文跟它引用的文件同住一个目录时的解析器（审查报告：report.md 和截图在一起）。 */
export function siblingFileResolver(urlFor: (name: string) => string): MarkdownFileResolver {
  return (destination) => {
    const name = siblingFileName(destination);
    return name ? { name, url: urlFor(name) } : null;
  };
}

/**
 * 同一个目录的解析器，但直接从「这份正文自己的地址」推出来。
 *
 * 证据接口的两条路径（`…/review/file`、`…/free-workflow/review-file`）都是把文件名放在
 * `?name=`，所以换掉那一个参数就是同目录的另一个文件。打开一份孤立报告（正文里指向
 * report.md 的链接）时手上只有这个 URL，没有 run/round，这是唯一解得出来的办法。
 */
export function siblingResolverForUrl(fileUrl: string): MarkdownFileResolver | undefined {
  const base = sameOriginUrl(fileUrl);
  if (!base || !isReviewFileEndpoint(base.pathname) || !base.searchParams.has("name")) return undefined;
  return siblingFileResolver((name) => {
    const url = new URL(base.toString());
    url.searchParams.set("name", name);
    return url.toString();
  });
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
export function isLocalImageReference(href: string): boolean {
  if (!href) return false;
  if (isLocalDiskImagePath(href)) return true;
  if (URL_SCHEME.test(href) || href.startsWith("/")) return false;
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
  // 站内 URL 的文件名一般就在 pathname 末段；验证证据接口是例外，它把名字放在 ?name=
  // （用户从证据面板「复制图片地址」再贴回对话里，走的就是这一条）。
  const named = isReviewFileEndpoint(url.pathname) ? url.searchParams.get("name") : null;
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
