import { useMemo, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Eye,
  EyeSlash,
  File,
  FileImage,
  FilePdf,
  Folder,
  FolderOpen,
  GitBranch,
  Warning,
} from "@phosphor-icons/react";
import type { FileEntry } from "../lib/api.ts";
import { formatSize, ROOT_SOURCE_LABEL, useFileTree } from "./fileModel.ts";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "tif", "tiff"]);

function FileGlyph({ name }: { name: string }) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "pdf") return <FilePdf size={13} aria-hidden="true" />;
  if (IMAGE_EXTENSIONS.has(ext)) return <FileImage size={13} aria-hidden="true" />;
  return <File size={13} aria-hidden="true" />;
}

function Level({
  path,
  depth,
  tree,
  showIgnored,
  activePath,
  onOpenFile,
}: {
  path: string;
  depth: number;
  tree: ReturnType<typeof useFileTree>;
  showIgnored: boolean;
  activePath: string | null;
  onOpenFile: (entry: FileEntry) => void;
}) {
  const entries = tree.children[path];
  if (tree.busy.has(path) && !entries) {
    return <p className="file-tree__hint" style={{ paddingLeft: 10 + depth * 12 }}>正在读取…</p>;
  }
  if (!entries) return null;
  const visible = showIgnored ? entries : entries.filter((entry) => !entry.ignored);
  if (!visible.length) {
    return (
      <p className="file-tree__hint" style={{ paddingLeft: 10 + depth * 12 }}>
        {entries.length ? "这一层只有被忽略的文件" : "空目录"}
      </p>
    );
  }

  return (
    <>
      {visible.map((entry) => {
        const open = tree.expanded.has(entry.path);
        const active = entry.path === activePath;
        return (
          <div key={entry.path} className="file-tree__node">
            <button
              type="button"
              className={`file-tree__row${active ? " is-active" : ""}${entry.ignored ? " is-ignored" : ""}`}
              style={{ paddingLeft: 6 + depth * 12 }}
              aria-expanded={entry.kind === "dir" ? open : undefined}
              onClick={() => entry.kind === "dir" ? tree.toggle(entry.path) : onOpenFile(entry)}
            >
              <span className="file-tree__caret" aria-hidden="true">
                {entry.kind === "dir"
                  ? (open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />)
                  : null}
              </span>
              <span className="file-tree__glyph">
                {entry.kind === "dir"
                  ? (open ? <FolderOpen size={13} aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />)
                  : <FileGlyph name={entry.name} />}
              </span>
              <span className="file-tree__name">{entry.name}</span>
              {entry.symlink && <em className="file-tree__tag">软链</em>}
              {entry.kind === "file" && <small>{formatSize(entry.size)}</small>}
            </button>
            {entry.kind === "dir" && open && (
              <Level
                path={entry.path}
                depth={depth + 1}
                tree={tree}
                showIgnored={showIgnored}
                activePath={activePath}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
      {tree.truncated.has(path) && (
        <p className="file-tree__hint" style={{ paddingLeft: 10 + depth * 12 }}>
          这一层文件太多，只列出了前 4000 个
        </p>
      )}
    </>
  );
}

/**
 * 任务工作目录的文件树。
 *
 * 「当前所在分支的文件」在实现上就是**任务实际干活的那个目录**：worktree 任务看到
 * 的自然是它那条分支的检出，共享目录的任务看到的是项目仓库本身 —— 所以头部要把
 * 「你看的是哪儿、它在哪条分支上」明说，否则用户分不清面前这份文件属于谁。
 */
export function FileTreeInspector({
  taskId,
  activePath,
  onOpenFile,
}: {
  taskId: string;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const tree = useFileTree(taskId);
  const [showIgnored, setShowIgnored] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const rootLabel = useMemo(() => tree.root ? ROOT_SOURCE_LABEL[tree.root.source] : null, [tree.root]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await tree.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="file-tree" aria-label="工作目录文件">
      <header className="file-tree__head">
        <div className="file-tree__where">
          <b>
            <GitBranch size={11} aria-hidden="true" />
            {tree.root?.branch || (tree.root?.gitRepo ? "游离 HEAD" : "非 git 目录")}
          </b>
          <small>{tree.root ? `${rootLabel} · ${tree.root.path}` : "正在解析工作目录…"}</small>
        </div>
        <button
          type="button"
          className="file-tree__action"
          aria-label={showIgnored ? "隐藏被 .gitignore 忽略的文件" : "显示被 .gitignore 忽略的文件"}
          aria-pressed={showIgnored}
          onClick={() => setShowIgnored((current) => !current)}
        >
          {showIgnored ? <Eye size={13} aria-hidden="true" /> : <EyeSlash size={13} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="file-tree__action"
          aria-label="重新读取文件列表"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <ArrowClockwise size={13} aria-hidden="true" />
        </button>
      </header>

      {tree.error && (
        <p className="file-tree__error">
          <Warning size={13} aria-hidden="true" />
          {tree.error}
        </p>
      )}

      <div className="file-tree__body">
        <Level
          path=""
          depth={0}
          tree={tree}
          showIgnored={showIgnored}
          activePath={activePath}
          onOpenFile={(entry) => onOpenFile(entry.path)}
        />
      </div>
    </div>
  );
}
