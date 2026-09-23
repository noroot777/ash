import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  Copy,
  File,
  Folder,
  FolderOpen,
  SpinnerGap,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { api, type FileEntryOverview } from "../lib/api.ts";
import { useZoomLayer, ZoomToggle } from "../lib/zoomLayer.tsx";
import { formatSize } from "./fileModel.ts";
import { useDeleteEntry } from "./useDeleteEntry.tsx";

/**
 * 会话区里的文件夹详情，和 `FileViewer` 占中间栏同一个位置。
 *
 * 它存在的第一理由不是「给删除按钮找个地方放」，而是**点开一个文件夹本来就想知道里面是
 * 什么**：多少个文件、多大、其中几个改过没提交、几个压根没进过 git。这几个数字同时也
 * 正是删除确认框要说的话——所以两边读同一个接口（`/file/overview`），不会出现详情页说
 * 12 个、确认框说 9 个那种事。
 *
 * 文件树里点文件夹仍然只是展开/折叠（不改用户已有的手感），这一页由行尾那颗按钮打开。
 */
export function FolderViewer({
  taskId,
  path,
  zoomed = false,
  onToggleZoom,
  onExitZoom,
  onOpenFile,
  onOpenFolder,
  onClose,
  notify,
}: {
  taskId: string;
  path: string;
  zoomed?: boolean;
  onToggleZoom?: () => void;
  onExitZoom?: () => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [overview, setOverview] = useState<FileEntryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const zoom = useZoomLayer({
    zoomed,
    onExit: () => onExitZoom?.(),
    label: `放大查看文件夹：${path}`,
    className: "zoom-layer--file",
  });
  const deletion = useDeleteEntry({ taskId, notify, onDeleted: () => onClose() });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.taskFileOverview(taskId, path)
      .then((result) => { if (alive) setOverview(result); })
      .catch((reason) => {
        if (!alive) return;
        setOverview(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, taskId, reloadToken]);

  const stats = overview?.stats;
  const git = overview?.git;
  const entries = overview?.entries ?? [];

  return zoom.render(
    <div className="file-viewer folder-viewer" aria-label="文件夹详情">
      <header className="file-viewer__bar">
        <div className="file-viewer__title">
          <b>{overview?.target.name ?? path.split("/").pop()}</b>
          <small>
            {path}/
            {stats ? ` · ${stats.files.toLocaleString()} 个文件 · ${formatSize(stats.bytes)}${stats.truncated ? "（还没数完）" : ""}` : ""}
          </small>
        </div>
        <button
          type="button"
          className="file-viewer__action"
          aria-label="重新统计这个文件夹"
          disabled={loading}
          onClick={() => setReloadToken((token) => token + 1)}
        >
          <ArrowClockwise size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="file-viewer__action"
          onClick={async () => {
            try {
              await api.revealTaskFile(taskId, path);
              notify("已在文件管理器中定位");
            } catch (reason) {
              notify(reason instanceof Error ? reason.message : String(reason));
            }
          }}
        >
          <FolderOpen size={13} aria-hidden="true" />
          在文件夹中查看
        </button>
        <button
          type="button"
          className="file-viewer__action"
          aria-label="复制文件夹的完整路径"
          disabled={!overview}
          onClick={async () => {
            if (!overview) return;
            try {
              await navigator.clipboard.writeText(overview.target.absPath);
              notify("已复制文件夹路径");
            } catch {
              notify("浏览器不允许写剪贴板");
            }
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </button>
        {/* 删除单独成组：跟「关闭」之间隔一道竖线，避免顺手点到。 */}
        <span className="file-viewer__danger-group">
          <button
            type="button"
            className="file-viewer__action is-danger"
            aria-label={`删除文件夹 ${path}`}
            disabled={!overview || !!deletion.preparing || !!overview.readOnly}
            onClick={() => void deletion.ask(path)}
          >
            <Trash size={13} aria-hidden="true" />
            {deletion.preparing ? "准备中…" : "删除"}
          </button>
          {onToggleZoom && <ZoomToggle zoomed={zoomed} onToggle={onToggleZoom} className="file-viewer__action" />}
          <button type="button" className="file-viewer__action" aria-label="关闭文件夹，回到会话" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </header>

      {overview?.readOnly && (
        <p className="file-viewer__notice">
          <Warning size={12} aria-hidden="true" />
          {overview.readOnly}
        </p>
      )}

      <div className="file-viewer__body">
        {loading && <p className="file-viewer__state"><SpinnerGap size={14} aria-hidden="true" />正在统计…</p>}
        {error && <p className="file-viewer__state is-error"><Warning size={14} aria-hidden="true" />{error}</p>}
        {!loading && !error && overview && (
          <div className="folder-viewer__body">
            <div className="folder-viewer__stats">
              <div className="folder-viewer__stat">
                <b>{stats?.files.toLocaleString() ?? "—"}</b>
                <span>个文件（含子目录）</span>
              </div>
              <div className="folder-viewer__stat">
                <b>{stats?.dirs.toLocaleString() ?? "—"}</b>
                <span>个子文件夹</span>
              </div>
              <div className="folder-viewer__stat">
                <b>{stats ? formatSize(stats.bytes) : "—"}</b>
                <span>合计大小{stats?.truncated ? "（至少）" : ""}</span>
              </div>
              <div className="folder-viewer__stat" data-tone="dirty">
                <b>{git?.dirty.toLocaleString() ?? "—"}</b>
                <span>个有未提交改动</span>
              </div>
              <div className="folder-viewer__stat" data-tone="untracked">
                <b>{git?.untracked.toLocaleString() ?? "—"}</b>
                <span>个未跟踪（git 里没有备份）</span>
              </div>
            </div>

            <section className="folder-viewer__section">
              <h3>
                这一层里有什么
                <em>{entries.length} 项</em>
              </h3>
              <div className="folder-viewer__list">
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`folder-viewer__item${entry.ignored ? " is-ignored" : ""}`}
                    onClick={() => (entry.kind === "dir" ? onOpenFolder(entry.path) : onOpenFile(entry.path))}
                  >
                    {entry.kind === "dir"
                      ? <Folder size={13} aria-hidden="true" />
                      : <File size={13} aria-hidden="true" />}
                    <b>{entry.name}</b>
                    {entry.symlink && <em className="file-tree__tag">软链</em>}
                    <small>{entry.kind === "dir" ? "文件夹" : formatSize(entry.size)}</small>
                  </button>
                ))}
                {!entries.length && <p className="file-tree__hint" style={{ padding: "8px 12px" }}>空目录</p>}
              </div>
            </section>

            <p className="folder-viewer__note">
              <Warning size={13} aria-hidden="true" />
              <span>
                删除这个文件夹＝连同里面 {stats?.files.toLocaleString() ?? "所有"} 个文件一起删。
                {git && git.untracked > 0
                  ? `其中 ${git.untracked.toLocaleString()} 个未跟踪，git 里没有任何备份。`
                  : git?.tracked
                    ? "里面的文件都被 git 跟踪着，删完可以在「源代码管理」里丢弃那条 deleted 改动找回来。"
                    : ""}
              </span>
            </p>
          </div>
        )}
      </div>
      {deletion.dialog}
    </div>,
  );
}
