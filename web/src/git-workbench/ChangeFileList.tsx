import type { GitFile, GitStatus } from "@ash/shared/git-workbench";
import { Minus, Plus, Stack, Trash } from "@phosphor-icons/react";
import { FileLayoutToggle, FolderCaret } from "../components/FileLayoutToggle.tsx";
import { indentStyle, useFileListLayout, useFileTreeRows } from "../lib/fileLayout.ts";
import type { Workbench } from "./useWorkbench.ts";

// Git 工作台「更改」页左侧那份工作区清单（冲突 + 已暂存/未暂存/未跟踪三组）。
//
// 从 `Changes.tsx` 拆出来：那个文件同时管着清单、提交框和右侧 diff 面板，加上目录树之后
// 一屏读不完了。这边只管「把文件摆出来、并把点到的动作转交出去」，写操作仍由 `Changes`
// 统一发（确认框、贮藏、门禁都在那边）。
//
// 平铺 / 目录树两种摆法跟任务面板、审查页共用同一份偏好，见 `lib/fileLayout.ts`。

export type ChangeSource = "staged" | "unstaged" | "untracked";

const labels: Record<ChangeSource, string> = {
  staged: "已暂存",
  unstaged: "未暂存",
  untracked: "未跟踪",
};
const hints: Record<ChangeSource, string> = {
  staged: "将进入下一次提交",
  unstaged: "工作树里的改动",
  untracked: "新文件",
};
const KIND_BADGE: Record<string, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", untracked: "U",
};

const filePath = (file: GitFile) => file.path;
/** 嵌套 Git 仓库列得出、下不了手（后端一律摘出去），批量操作的分母里不能算上它。 */
const actionableOf = (files: readonly GitFile[]) => files.filter((file) => !file.nested);

function Stat({ files }: { files: readonly GitFile[] }) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  if (!additions && !deletions) return null;
  return (
    <span className="stat">
      {!!additions && <i className="stat-add">+{additions}</i>}
      {!!deletions && <i className="stat-del">−{deletions}</i>}
    </span>
  );
}

/** 逐条 / 逐目录共用的一组操作。`scope` 只用来把 aria-label 说清楚是在对谁下手。 */
function RowActions({
  files,
  source,
  scope,
  workbench: w,
  onStage,
  onDiscard,
}: {
  files: GitFile[];
  source: ChangeSource;
  scope: string;
  workbench: Workbench;
  onStage: (files: GitFile[], source: ChangeSource) => void;
  onDiscard: (files: GitFile[], source: ChangeSource) => void;
}) {
  if (!files.length) return null;
  return (
    <div className="file-actions">
      <button
        className="icon-btn"
        disabled={w.isBlocked(source === "staged" ? "unstage" : "stage")}
        aria-label={`${source === "staged" ? "取消暂存" : "暂存"} ${scope}`}
        onClick={() => onStage(files, source)}
      >
        {source === "staged" ? <Minus size={13} /> : <Plus size={13} />}
      </button>
      {source !== "staged" && (
        <button
          className="icon-btn tone-danger"
          disabled={w.blocked}
          aria-label={`丢弃 ${scope}`}
          onClick={() => onDiscard(files, source)}
        >
          <Trash size={13} />
        </button>
      )}
    </div>
  );
}

function DirRow({
  label,
  depth,
  collapsed,
  items,
  onToggle,
  children,
}: {
  label: string;
  depth: number;
  collapsed: boolean;
  items: readonly GitFile[];
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="gwb-file-row gwb-dir-row file-row ui-selectable" style={indentStyle(depth, 12)}>
      <button
        className="gwb-file-select"
        aria-expanded={!collapsed}
        aria-label={`${label}（${items.length} 个文件）`}
        onClick={onToggle}
      >
        <FolderCaret collapsed={collapsed} size={11} />
        <span className="file-name">
          {label}
          <i className="file-dir">{items.length} 个文件</i>
        </span>
      </button>
      <Stat files={items} />
      {children}
    </div>
  );
}

function FileRow({
  file,
  source,
  depth,
  showDir,
  active,
  workbench,
  onSelect,
  onStage,
  onDiscard,
}: {
  file: GitFile;
  source: ChangeSource;
  depth: number;
  /** 所在目录那一截。树里由目录行说明，行内再写一遍就是重复。 */
  showDir: boolean;
  active: boolean;
  workbench: Workbench;
  onSelect: () => void;
  onStage: (files: GitFile[], source: ChangeSource) => void;
  onDiscard: (files: GitFile[], source: ChangeSource) => void;
}) {
  const kind = source === "untracked" ? "U" : KIND_BADGE[file.kind] || "M";
  const slash = file.path.lastIndexOf("/");
  return (
    <div
      className={`gwb-file-row file-row ui-selectable${active ? " is-active is-selected" : ""}`}
      style={indentStyle(depth, 12)}
    >
      <button className="gwb-file-select" aria-label={file.path} disabled={file.nested} onClick={onSelect}>
        <span className={`kind-badge kind-${kind}`}>{kind}</span>
        <span className="file-name">
          {file.path.slice(slash + 1)}
          {/* 嵌套仓那句话不跟着树走：它说的是「这一行为什么按不动」，不是它在哪个目录。 */}
          {file.nested
            ? <i className="file-dir">嵌套仓库</i>
            : showDir && slash >= 0 && <i className="file-dir">{file.path.slice(0, slash + 1)}</i>}
        </span>
      </button>
      <Stat files={[file]} />
      {!file.nested && (
        <RowActions
          files={[file]}
          source={source}
          scope={file.path}
          workbench={workbench}
          onStage={onStage}
          onDiscard={onDiscard}
        />
      )}
    </div>
  );
}

function ChangeGroup({
  source,
  files,
  selection,
  workbench: w,
  onSelect,
  onStage,
  onDiscard,
  onStash,
}: {
  source: ChangeSource;
  files: GitFile[];
  selection: { path: string; source: ChangeSource } | null;
  workbench: Workbench;
  onSelect: (selection: { path: string; source: ChangeSource }) => void;
  onStage: (files: GitFile[], source: ChangeSource) => void;
  onDiscard: (files: GitFile[], source: ChangeSource) => void;
  onStash: () => void;
}) {
  const [layout] = useFileListLayout();
  const tree = useFileTreeRows(files, filePath, layout === "tree");
  const actionable = actionableOf(files);
  const row = (file: GitFile, depth: number, showDir: boolean) => (
    <FileRow
      key={`${file.path}-${depth}`}
      file={file}
      source={source}
      depth={depth}
      showDir={showDir}
      active={selection?.path === file.path && selection.source === source}
      workbench={w}
      onSelect={() => onSelect({ path: file.path, source })}
      onStage={onStage}
      onDiscard={onDiscard}
    />
  );
  return (
    <section className="gwb-file-group change-group">
      <header className="group-head">
        <b>{labels[source]}</b>
        <span className="group-count">{files.length}</span>
        <i className="group-hint">{hints[source]}</i>
        <div className="group-actions">
          {!!actionable.length && (
            <button
              className="mini-btn"
              disabled={w.isBlocked(source === "staged" ? "unstage" : "stage")}
              onClick={() => onStage(actionable, source)}
            >
              {source === "staged" ? <Minus size={12} /> : <Plus size={12} />}
              {source === "staged" ? "全部取消暂存" : "全部暂存"}
            </button>
          )}
          {source === "unstaged" && !!actionable.length && (
            <button className="mini-btn" disabled={w.blocked} onClick={onStash}>
              <Stack size={12} />
              贮藏…
            </button>
          )}
        </div>
      </header>
      {!files.length && (
        <p className="empty-line">{source === "staged" ? "暂无已暂存文件" : "没有改动"}</p>
      )}
      {layout === "tree"
        ? tree.rows.map((entry) => (
          entry.kind === "dir" ? (
            <DirRow
              key={entry.key}
              label={entry.label}
              depth={entry.depth}
              collapsed={entry.collapsed}
              items={entry.items}
              onToggle={() => tree.toggle(entry.path)}
            >
              <RowActions
                files={actionableOf(entry.items)}
                source={source}
                scope={`${entry.label} 下的 ${actionableOf(entry.items).length} 个文件`}
                workbench={w}
                onStage={onStage}
                onDiscard={onDiscard}
              />
            </DirRow>
          ) : row(entry.item, entry.depth, false)
        ))
        : files.map((file) => row(file, 0, true))}
    </section>
  );
}

/** 合并冲突。没有暂存/丢弃可给（点一行是去解决它），所以行上只有一个动作。 */
function ConflictGroup({ files, onResolve }: { files: GitFile[]; onResolve: (path: string) => void }) {
  const [layout] = useFileListLayout();
  const tree = useFileTreeRows(files, filePath, layout === "tree");
  const row = (file: GitFile, depth: number, showDir: boolean) => {
    const slash = file.path.lastIndexOf("/");
    return (
      <button
        className="file-row ui-selectable"
        key={`${file.path}-${depth}`}
        style={indentStyle(depth, 12)}
        onClick={() => onResolve(file.path)}
      >
        <span className="kind-badge kind-!">!</span>
        <span className="file-name">
          {showDir ? file.path : file.path.slice(slash + 1)}
        </span>
        <span className="conflict-state">待解决</span>
      </button>
    );
  };
  return (
    <section className="change-group group-conflict">
      <header className="group-head">
        <b>合并冲突</b>
        <span className="group-count">{files.length}</span>
      </header>
      {layout === "tree"
        ? tree.rows.map((entry) => (
          entry.kind === "dir" ? (
            <button
              key={entry.key}
              className="file-row gwb-dir-row ui-selectable"
              style={indentStyle(entry.depth, 12)}
              aria-expanded={!entry.collapsed}
              aria-label={`${entry.label}（${entry.items.length} 个文件）`}
              onClick={() => tree.toggle(entry.path)}
            >
              <FolderCaret collapsed={entry.collapsed} size={11} />
              <span className="file-name">
                {entry.label}
                <i className="file-dir">{entry.items.length} 个文件</i>
              </span>
            </button>
          ) : row(entry.item, entry.depth, false)
        ))
        : files.map((file) => row(file, 0, true))}
    </section>
  );
}

export function ChangeFileList({
  status,
  workbench,
  selection,
  onSelect,
  onStage,
  onDiscard,
  onStash,
  onResolve,
}: {
  status: GitStatus;
  workbench: Workbench;
  selection: { path: string; source: ChangeSource } | null;
  onSelect: (selection: { path: string; source: ChangeSource }) => void;
  onStage: (files: GitFile[], source: ChangeSource) => void;
  onDiscard: (files: GitFile[], source: ChangeSource) => void;
  onStash: () => void;
  onResolve: (path: string) => void;
}) {
  return (
    <>
      {/* 切换摆在清单正上方：这一栏会滚，而三个分组各摆一颗就成了三颗一模一样的按钮。 */}
      <div className="gwb-file-tools">
        <FileLayoutToggle className="icon-btn" />
      </div>
      {!!status.merge.length && <ConflictGroup files={status.merge} onResolve={onResolve} />}
      <div className="gwb-file-groups">
        {(["staged", "unstaged", "untracked"] as const).map((source) => (
          <ChangeGroup
            key={source}
            source={source}
            files={status[source]}
            selection={selection}
            workbench={workbench}
            onSelect={onSelect}
            onStage={onStage}
            onDiscard={onDiscard}
            onStash={onStash}
          />
        ))}
      </div>
    </>
  );
}
