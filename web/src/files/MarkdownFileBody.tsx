import { useMemo } from "react";
import { api, type FileContent } from "../lib/api.ts";
import { linkFilePath } from "../components/fileLinkTarget.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import type { MarkdownFileResolver } from "../components/markdownPolicy.ts";
import { TaskFileLinkBase } from "../components/TaskFileLink.tsx";

/** 工作区里的 Markdown 文件按渲染后的样子摊开（方案、报告是拿来读的，不是拿来数行号的）。 */
export const MARKDOWN_PATTERN = /\.(?:md|markdown)$/i;

/**
 * 文档里的相对路径相对**这份文档所在的目录**——图片和链接都是（`![](shots/a.png)`、
 * `[返回目录](../README.md)`），跟对话正文那种「没有文档根、一律按工作区根」不是一回事。
 */
export function MarkdownFileBody({ taskId, file }: { taskId: string; file: FileContent }) {
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const resolveFile = useMemo((): MarkdownFileResolver => (destination) => {
    const path = linkFilePath(destination, taskId, dir);
    return path ? { name: path.split("/").pop() || path, url: api.taskFileRawUrl(taskId, path) } : null;
  }, [taskId, dir]);
  return (
    <div className="file-viewer__doc">
      <TaskFileLinkBase dir={dir}>
        <MarkdownBody text={file.text ?? ""} resolveFile={resolveFile} />
      </TaskFileLinkBase>
    </div>
  );
}
