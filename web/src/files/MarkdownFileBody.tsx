import { useEffect, useMemo, useRef } from "react";
import { api, type FileContent } from "../lib/api.ts";
import { linkFilePath } from "../components/fileLinkTarget.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import type { MarkdownFileResolver } from "../components/markdownPolicy.ts";
import { TaskFileLinkBase } from "../components/TaskFileLink.tsx";
import { scrollToAnchor } from "../components/markdownAnchors.ts";
import type { FileAnchor } from "./useFileView.ts";

/** 工作区里的 Markdown 文件按渲染后的样子摊开（方案、报告是拿来读的，不是拿来数行号的）。 */
export const MARKDOWN_PATTERN = /\.(?:md|markdown)$/i;

/**
 * 文档里的相对路径相对**这份文档所在的目录**——图片和链接都是（`![](shots/a.png)`、
 * `[返回目录](../README.md)`），跟对话正文那种「没有文档根、一律按工作区根」不是一回事。
 */
export function MarkdownFileBody({ taskId, file, anchor = null }: {
  taskId: string;
  file: FileContent;
  /** 打开时要滚到的那一节（`plan.md#实现方案`）。同一份文件再点一次锚点也会换一个新值。 */
  anchor?: FileAnchor | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  // 正文是同步渲染的，effect 跑的时候标题已经在 DOM 里了。找不到那一节就停在开头。
  useEffect(() => {
    if (anchor && root.current) scrollToAnchor(root.current, anchor.id);
  }, [anchor]);
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const resolveFile = useMemo((): MarkdownFileResolver => (destination) => {
    const path = linkFilePath(destination, taskId, dir);
    return path ? { name: path.split("/").pop() || path, url: api.taskFileRawUrl(taskId, path) } : null;
  }, [taskId, dir]);
  return (
    <div className="file-viewer__doc" ref={root}>
      <TaskFileLinkBase dir={dir}>
        <MarkdownBody text={file.text ?? ""} resolveFile={resolveFile} />
      </TaskFileLinkBase>
    </div>
  );
}
