import { useMemo } from "react";
import { File, Folder, GitDiff } from "@phosphor-icons/react";
import type { InspectorDescriptor, InspectorReveal } from "../inspector/index.ts";
import type { Notify } from "../lib/notify.ts";
import { ScmDiffViewer } from "../scm/ScmDiffViewer.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { FolderViewer } from "./FolderViewer.tsx";
import type { FileView } from "./useFileView.ts";

// 右侧面板里「查看」那一格：正文里的路径、文件树、生成物、改动列表点开的文件 / 文件夹 / diff
// 都摊在这里。摆在右边而不是替换中间那一栏：看文件时通常要对着 agent 说话，会话和回复框得
// 一直留着。它是宽格（跟会话大约五五开、可拖），只在有东西摊着时存在——没打开过就不在竖轨
// 上，也不进「+」菜单；关掉内容这一格就跟着收起，回到点开之前看的那一格。
//
// 单飞任务和团队调度台共用：两边的 Inspector 上下文里都带着 `fileView`，这一格只认那几样。

export const FILE_VIEW_TAB = "file-view";

interface FileViewContext {
  task: { id: string };
  fileView: FileView;
  notify: Notify;
}

function FileViewPane({ taskId, view, notify }: { taskId: string; view: FileView; notify: Notify }) {
  if (view.filePath) {
    return (
      <FileViewer
        taskId={taskId}
        path={view.filePath}
        reel={view.reel}
        onStep={view.stepFile}
        zoomed={view.zoomed}
        onToggleZoom={view.toggleZoom}
        onExitZoom={view.exitZoom}
        onOpenDiff={view.canShowDiff ? view.showDiff : undefined}
        onClose={view.close}
        notify={notify}
      />
    );
  }
  if (view.folderPath) {
    return (
      <FolderViewer
        taskId={taskId}
        path={view.folderPath}
        zoomed={view.zoomed}
        onToggleZoom={view.toggleZoom}
        onExitZoom={view.exitZoom}
        onOpenFile={view.openFile}
        onOpenFolder={view.openFolder}
        onClose={view.close}
        notify={notify}
      />
    );
  }
  if (view.diff) {
    return (
      <ScmDiffViewer
        taskId={taskId}
        path={view.diff.path}
        source={view.diff.source}
        origPath={view.diff.origPath}
        kind={view.diff.kind}
        zoomed={view.zoomed}
        onToggleZoom={view.toggleZoom}
        onExitZoom={view.exitZoom}
        onOpenFile={view.showFile}
        onClose={view.close}
      />
    );
  }
  return null;
}

/**
 * 往面板表里插上「查看」那一格（有东西摊着时）。插在 `after` 里最后一个在表上的格子后面，
 * 跟它同一簇——文件、生成物、改动那几格就在旁边，点开的东西从哪来一眼对得上。
 */
export function useFileViewTab<Context extends FileViewContext>(
  descriptors: readonly InspectorDescriptor<Context>[],
  view: FileView,
  after: readonly string[],
): { inspectors: readonly InspectorDescriptor<Context>[]; reveal: InspectorReveal } {
  const kind = view.filePath ? "file" : view.folderPath ? "folder" : view.diff ? "diff" : null;
  const name = view.activePath?.split("/").filter(Boolean).pop() ?? view.activePath ?? "";
  const inspectors = useMemo(() => {
    if (!kind) return descriptors;
    const at = descriptors.reduce((found, descriptor, index) => (after.includes(descriptor.id) ? index : found), -1);
    const tab: InspectorDescriptor<Context> = {
      id: FILE_VIEW_TAB,
      // 竖轨上指到才报名字：报的就是摊着的那一份，比一个泛泛的「查看」有用。
      title: name || "工作区",
      icon: kind === "diff" ? <GitDiff size={14} /> : kind === "folder" ? <Folder size={14} /> : <File size={14} />,
      cluster: at >= 0 ? descriptors[at]?.cluster : undefined,
      wide: true,
      bare: true,
      render: (context) => <FileViewPane taskId={context.task.id} view={context.fileView} notify={context.notify} />,
    };
    const position = at >= 0 ? at + 1 : descriptors.length;
    return [...descriptors.slice(0, position), tab, ...descriptors.slice(position)];
  }, [after, descriptors, kind, name]);
  return { inspectors, reveal: { tabId: FILE_VIEW_TAB, key: view.seq } };
}
