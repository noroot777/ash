import { useRef } from "react";
import { Check, GitBranch } from "@phosphor-icons/react";
import type { ProjectGitBranchRow, ProjectGitState } from "../lib/api.ts";
import { checkoutBlocker } from "./projectGitModel.ts";

// 项目 Git 浮层里的分支清单。切分支是这里最容易点错的操作，所以行长什么样、灰的时候
// 给什么理由，都在这一处说清楚。

const SELECT_DRAG_THRESHOLD = 5;

function BranchRow({
  row,
  blocked,
  busy,
  onCheckout,
}: {
  row: ProjectGitBranchRow;
  blocked: string | null;
  busy: boolean;
  onCheckout: () => void;
}) {
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const selectedByDrag = useRef(false);
  // 上游状态用一句话说完：没有上游、上游没了、领先/落后几个提交。
  const detail = row.gone
    ? "上游已删除"
    : row.upstream
      ? [(row.ahead ?? 0) > 0 ? `↑${row.ahead}` : "", (row.behind ?? 0) > 0 ? `↓${row.behind}` : ""].filter(Boolean).join(" ")
      : "无 upstream";
  return (
    <button
      type="button"
      className={`project-git-branch ui-selectable${row.current ? " is-current" : ""}`}
      aria-current={row.current || undefined}
      aria-disabled={!!blocked || busy}
      aria-label={blocked ? `${row.name}，${blocked}` : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        pointerStart.current = { x: event.clientX, y: event.clientY };
        selectedByDrag.current = false;
      }}
      onPointerUp={(event) => {
        const start = pointerStart.current;
        pointerStart.current = null;
        if (!start || event.button !== 0) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < SELECT_DRAG_THRESHOLD) return;

        const selection = window.getSelection();
        const branchName = event.currentTarget.querySelector("span");
        if (!selection || selection.isCollapsed || !branchName || !selection.containsNode(branchName, true)) return;

        // 省略号只裁视觉；一旦确认是拖选，就把完整分支名纳入选区，复制不会丢尾巴。
        const range = document.createRange();
        range.selectNodeContents(branchName);
        selection.removeAllRanges();
        selection.addRange(range);
        selectedByDrag.current = true;
      }}
      onPointerCancel={() => {
        pointerStart.current = null;
        selectedByDrag.current = false;
      }}
      onClick={() => {
        if (selectedByDrag.current) {
          selectedByDrag.current = false;
          return;
        }
        if (!blocked && !busy) onCheckout();
      }}
    >
      {row.current
        ? <Check size={12} weight="bold" aria-hidden="true" />
        : <GitBranch size={12} aria-hidden="true" />}
      <span>{row.name}</span>
      {row.worktree && <em>占用中</em>}
      {detail && <small>{detail}</small>}
    </button>
  );
}

export function ProjectGitBranchList({
  rows,
  state,
  busy,
  loading,
  canManage,
  onCheckout,
}: {
  rows: ProjectGitBranchRow[];
  state: ProjectGitState | null;
  busy: boolean;
  loading: boolean;
  canManage: boolean;
  onCheckout: (branch: string) => void;
}) {
  return (
    <div className="project-git-panel__branches">
      {rows.map((row) => (
        <BranchRow
          key={row.name}
          row={row}
          blocked={checkoutBlocker(row, state, canManage)}
          busy={busy}
          onCheckout={() => onCheckout(row.name)}
        />
      ))}
      {!rows.length && (
        <p className="project-git-panel__empty">
          {loading ? "正在读取…" : state?.isRepo ? "没有匹配的分支" : "这个项目的路径不是 Git 仓库"}
        </p>
      )}
    </div>
  );
}
