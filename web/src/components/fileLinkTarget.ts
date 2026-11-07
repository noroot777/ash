import { destinationFilePath, hasUrlScheme, isNetworkDestination } from "@ash/shared/markdown-images";

// 正文里一处「像路径的东西」指的是工作区里哪条路径——只管把字符串摆正，**不判有没有**：
// 那一问只有服务端答得了（lib/taskFileLocate.ts）。这里返回 null 只表示「它连路径都不像，
// 不必去问」，用来挡掉命令、标识符、网址，省下请求。
//
// 两种来源的相对路径基准不同，是 Markdown 自己的口径：
//   • 链接 `[名字](目的地)` 相对**这份文档所在的目录**（方案文档里的 `[返回目录](../README.md)`）；
//   • 行内代码 `server/src/a.ts:12` 是人写给人看的「仓库里的位置」，一律相对工作区根。
// 对话正文没有文档目录，两者都落在根上。

/** 末尾的行列号：`a.ts:12`、`a.ts:12:5`、`a.ts:12-20`、`a.ts#L12-L20`。打开的是整份文件。 */
const LINE_SUFFIX = /(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/;
/** 扩展名得字母开头：`v1.2`、`1.0.3` 不是文件。 */
const EXTENSION = /\.[A-Za-z][\w-]{0,9}$/;
/**
 * 文件名里几乎不会出现、代码和 glob 里常见的字符。空格、括号都**不在**这里：
 * `docs/release notes.md`、`docs/plan(final).md` 是真文件名，有没有这个文件由服务端答，
 * 这里挡掉就是漏报；命令 `npm run build`、调用 `fileView.openFile()` 照样被下面的形状判据挡住。
 */
const NOT_PATH = /[\n`'"<>|*?{}$;,=]/;
const DRIVE = /^[A-Za-z]:[\\/]/;
/** ash 自己建的任务工作区：`<仓库>/.worktrees/<任务>/<相对路径>`。 */
const WORKTREE = /(?:^|[/\\])\.worktrees[/\\]([^/\\]+)[/\\](.+)$/;

/** 相对路径按 `baseDir` 摆正；`..` 爬出工作区根的不要。 */
function joinRelative(baseDir: string, rel: string): string | null {
  const parts = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const segment of rel.split(/[/\\]/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}

function placed(taskId: string, path: string, baseDir: string): string | null {
  // 写的是这个任务自己 worktree 的绝对路径：换成相对路径。worktree 验收后被清掉时，同一个
  // 相对路径还能在主仓里找到它；别的任务的 worktree 原样交给服务端判。
  const worktree = WORKTREE.exec(path);
  if (worktree) return worktree[1] === taskId ? joinRelative("", worktree[2]!) : path;
  if (path.startsWith("/") || path.startsWith("\\") || DRIVE.test(path)) return path;
  // `~` 要展开成谁的家目录只有 agent 那台机器知道。
  if (path.startsWith("~")) return null;
  return joinRelative(baseDir, path);
}

function fileUrlPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hostname && url.hostname !== "localhost") return null;
    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/**
 * 这个链接目的地是本机文件（`file://…`、`C:\…`）——Markdown 的地址清理（react-markdown 的
 * `defaultUrlTransform`）不认这两种协议，会把它们清成空串，于是 `linkFilePath` 收到的是空的，
 * 认 `file://` 的那一支永远到不了（审查第 1 轮 F2）。它们放过去也执行不了任何东西：真正的
 * 入口（`javascript:` 那一类）仍由默认清理挡着，放过去的地址还要经工作区 / 本机打开那道门禁。
 */
export function isLocalFileHref(url: string): boolean {
  return /^file:\/\//i.test(url) || DRIVE.test(url);
}

/** markdown 链接的目的地指着工作区里哪条路径（相对的按 `baseDir` 解）。 */
export function linkFilePath(href: string | undefined, taskId: string, baseDir = ""): string | null {
  const raw = href?.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("?")) return null;
  let path: string | null;
  if (/^file:\/\//i.test(raw)) path = fileUrlPath(raw);
  else if (DRIVE.test(raw) || raw.startsWith("\\\\")) path = destinationFilePath(raw);
  else if (isNetworkDestination(raw)) return null;
  else path = destinationFilePath(raw);
  path = path?.replace(LINE_SUFFIX, "") ?? null;
  return path ? placed(taskId, path, baseDir) : null;
}

/** 行内代码里的那串字指着工作区里哪条路径（一律相对工作区根）。 */
export function codeFilePath(text: string, taskId: string): string | null {
  const raw = text.trim();
  if (!raw || raw.length > 400) return null;
  if (/^file:\/\//i.test(raw)) return linkFilePath(raw, taskId);
  const path = raw.replace(LINE_SUFFIX, "");
  if (!path || NOT_PATH.test(path) || /^[-~]/.test(path)) return null;
  if (hasUrlScheme(path) && !DRIVE.test(path)) return null;
  // 形状：带目录分隔符，或者末尾是个扩展名（`package.json`、`AGENTS.md`）。
  if (!/[/\\]/.test(path) && !EXTENSION.test(path)) return null;
  return placed(taskId, path, "");
}
