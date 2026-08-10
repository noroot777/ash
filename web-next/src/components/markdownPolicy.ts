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

// 正文里指向图片的**链接**（不是 `![]()` 内嵌图），点开要落进全站统一的灯箱，而不是
// 甩出一个新标签页——新标签页没有上一张/下一张、没有 Esc 关闭，还把人从对话里带走了。
// 判定顺序就是「这张图住在哪」，每一档都对应一个真能把字节吐出来的接口：
//   ① 验证证据 data/runs/<task>/{review,free-review}/… → 对应证据接口（绝对路径、file:// 都认）
//   ② 用户贴的附件 data/uploads/<file>                → 附件接口
//   ③ 本来就是站内 URL（/api/uploads/… 一类）          → 原样用
// 其余一律返回 null 交回普通链接策略：站外图照常新开，本机磁盘路径则由 localOpenUrl
// 改写到安全打开端点；这里不能拿一个服务端取不到的 URL 硬塞给灯箱。
export function imagePreviewTarget(href?: string): ImagePreviewTarget | null {
  if (!href) return null;
  // 「用系统应用打开本地文件」是另一条路，不抢它的链接。
  if (isLocalOpenHref(href)) return null;
  return servableImage(href);
}

export function isLocalDiskImagePath(href: string): boolean {
  const path = localDiskPath(href);
  return path !== null && isImagePath(path);
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
  const target = localOpenUrl(href);
  if (!target) throw new Error("不是可打开的本地路径");
  const response = await fetch(target);
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
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
