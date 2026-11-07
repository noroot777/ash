import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { FileText, Folder } from "@phosphor-icons/react";
import { locateTaskFile, useTaskFileTarget, type TaskFileTarget } from "../lib/taskFileLocate.ts";
import { codeFilePath, linkFilePath } from "./fileLinkTarget.ts";
import { isDocumentRelative, isLocalOpenHref } from "./markdownPolicy.ts";

// 正文里提到的文件点一下就在中间栏摊开——跟「生成物」「文件」两格同一个出口。
//
// 走 context 而不是一路传 props：正文渲染点散在会话、团队调度流、子代理会话、审查报告弹窗
// 里，而「点开文件」只有任务页（单飞 / 团队）知道往哪摊。没有外层 `TaskFileLinks` 的地方
// （随手记、助手、问答卡片）正文照旧是普通代码和链接。

type FileLinks = {
  taskId: string;
  /**
   * 链接里的相对路径按哪个目录解：对话正文是工作区根，查看器里的文档是它自己那一层。
   * `null` = 这份文档的相对路径根本不在工作区里（审查报告的在证据目录，见 reportFileResolver）
   * ——那些链接不归这里管，只认绝对路径。
   */
  baseDir: string | null;
  open: (target: TaskFileTarget) => void;
};

const FileLinksContext = createContext<FileLinks | null>(null);

export function TaskFileLinks({ taskId, onOpenFile, onOpenFolder, children }: {
  taskId: string;
  onOpenFile: (path: string) => void;
  onOpenFolder: (path: string) => void;
  children: ReactNode;
}) {
  // 回调走 ref：调用点传的是每次渲染新建的箭头函数，进了 context 的值就会让整篇会话里
  // 每一处路径跟着重渲染。
  const latest = useRef({ onOpenFile, onOpenFolder });
  latest.current = { onOpenFile, onOpenFolder };
  const value = useMemo((): FileLinks => ({
    taskId,
    baseDir: "",
    open: (target) => (target.kind === "dir" ? latest.current.onOpenFolder : latest.current.onOpenFile)(target.path),
  }), [taskId]);
  return <FileLinksContext.Provider value={value}>{children}</FileLinksContext.Provider>;
}

/** 一份文档里的链接相对它自己所在的目录（查看器里摊开的 Markdown）；`null` 见 `baseDir`。 */
export function TaskFileLinkBase({ dir, children }: { dir: string | null; children: ReactNode }) {
  const outer = useContext(FileLinksContext);
  const value = useMemo(() => (outer ? { ...outer, baseDir: dir } : null), [outer, dir]);
  return <FileLinksContext.Provider value={value}>{children}</FileLinksContext.Provider>;
}

function Glyph({ kind }: { kind: TaskFileTarget["kind"] }) {
  return kind === "dir"
    ? <Folder className="task-file-link__glyph" size={12} aria-hidden="true" />
    : <FileText className="task-file-link__glyph" size={12} aria-hidden="true" />;
}

/** 围栏代码块里的不是「提到一个文件」，是代码本身——里面的 `code` 一律照原样画。 */
const InCodeBlock = createContext(false);

export function CodeBlockScope({ children }: { children: ReactNode }) {
  return <InCodeBlock.Provider value>{children}</InCodeBlock.Provider>;
}

/**
 * 行内代码。写的是工作区里真有的文件或目录，就画成点得开的样子。
 *
 * 用 `role="link"` 的 `<code>` 而不是 `<button>`：路径常常是要拖选复制的，按钮里的字拖不动。
 * 所以点下去先看是不是在选字——选了一段就不打开。
 */
export function MarkdownCode({ className, children }: { className?: string; children: ReactNode }) {
  const links = useContext(FileLinksContext);
  const inBlock = useContext(InCodeBlock);
  const path = links && !inBlock && typeof children === "string" ? codeFilePath(children, links.taskId) : null;
  const target = useTaskFileTarget(path ? links!.taskId : null, path);
  if (!links || !target) return <code className={className}>{children}</code>;
  const open = () => links.open(target);
  return (
    <code
      className={`task-file-link${className ? ` ${className}` : ""}`}
      role="link"
      tabIndex={0}
      onClick={(event: MouseEvent) => {
        if (window.getSelection()?.toString()) return;
        event.preventDefault();
        open();
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        open();
      }}
    >
      <Glyph kind={target.kind} />
      {children}
    </code>
  );
}

/**
 * markdown 链接指着工作区里的文件时：点开摊在中间栏。
 *
 * 返回 null = 这处链接跟工作区无关（网址、`/api/open-local`、没有外层 `TaskFileLinks`），
 * 交回原来那套。`target === null` 是问过了、工作区里没有——同样交回原来那套（本机路径
 * 还能交给本机应用打开）。还没问到时也先接住：点下去当场问一次。
 */
export function useTaskFileHref(href: string | undefined) {
  const links = useContext(FileLinksContext);
  const workspaceHref = !!href && !isLocalOpenHref(href) && (links?.baseDir != null || !isDocumentRelative(href));
  const path = links && workspaceHref ? linkFilePath(href, links.taskId, links.baseDir ?? "") : null;
  const target = useTaskFileTarget(path ? links!.taskId : null, path);
  if (!links || !path || target === null) return null;
  return {
    glyph: target ? <Glyph kind={target.kind} /> : null,
    /** 打开了返回 true；工作区里其实没有时返回 false，调用方退回原来的打开方式。 */
    open: async () => {
      const found = target ?? await locateTaskFile(links.taskId, path);
      if (!found) return false;
      links.open(found);
      return true;
    },
  };
}
