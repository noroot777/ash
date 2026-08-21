import { Check, GitBranch } from "@phosphor-icons/react";
import type { ProjectGitBranchRow, ProjectGitState } from "../lib/api.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { checkoutBlocker } from "./projectGitModel.ts";

// 分支清单。侧栏胶囊的浮层和命令面板 `/git` 共用——切分支是这两个入口里最容易点错的
// 操作，行长什么样、灰的时候给什么理由，必须只有一份实现。

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
  const tip = useHoverTip();
  // 上游状态用一句话说完：没有上游、上游没了、领先/落后几个提交。
  const detail = row.gone
    ? "上游已删除"
    : row.upstream
      ? [(row.ahead ?? 0) > 0 ? `↑${row.ahead}` : "", (row.behind ?? 0) > 0 ? `↓${row.behind}` : ""].filter(Boolean).join(" ")
      : "无 upstream";
  return (
    <>
      <button
        type="button"
        className={`project-git-branch ui-selectable${row.current ? " is-current" : ""}`}
        aria-current={row.current || undefined}
        aria-disabled={!!blocked || busy}
        {...(blocked ? tip.anchorProps : {})}
        onClick={() => { if (!blocked && !busy) onCheckout(); }}
      >
        {row.current
          ? <Check size={12} weight="bold" aria-hidden="true" />
          : <GitBranch size={12} aria-hidden="true" />}
        <span>{row.name}</span>
        {row.worktree && <em>占用中</em>}
        {detail && <small>{detail}</small>}
      </button>
      <HoverTip at={tip.at}>{blocked}</HoverTip>
    </>
  );
}

export function ProjectGitBranchList({
  rows,
  state,
  busy,
  loading,
  roomy,
  onCheckout,
}: {
  rows: ProjectGitBranchRow[];
  state: ProjectGitState | null;
  busy: boolean;
  loading: boolean;
  /** 命令面板那种大格子里用宽松一档的行高。 */
  roomy?: boolean;
  onCheckout: (branch: string) => void;
}) {
  return (
    <div className={`project-git-panel__branches${roomy ? " is-roomy" : ""}`}>
      {rows.map((row) => (
        <BranchRow
          key={row.name}
          row={row}
          blocked={checkoutBlocker(row, state)}
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
