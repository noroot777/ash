import { useState } from "react";
import { ArrowRight, CaretDown, GitBranch, GitCommit } from "@phosphor-icons/react";
import type { TaskCommit } from "../lib/api.ts";
import { CommitStrip } from "./CommitStrip.tsx";

// worktree 全路径又长又共前缀，元信息行里只留最后一段（worktree 目录名）足够认人；要看
// 全路径去任务详情。
export function worktreeLabel(path: string): string {
  const name = path.split("/").filter(Boolean).pop();
  return name ? `worktree · ${name}` : path;
}

// 源分支、合入目标、worktree 原先各占一张卡片，提交再横铺一整块，加起来两行多——可这一
// 屏真正要看的是下面的 diff，这些只是「我在看谁的什么改动」。所以压成一条：分支 → 目标
// 一句话说完，提交收进一颗按钮，要核对某次提交时再展开。
export function ChangeMetaBar({
  source,
  target,
  where,
  commits,
}: {
  source: string;
  target: string;
  where?: string | null;
  commits: TaskCommit[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="review-meta-bar">
      <div className="review-meta-bar__line">
        <span className="review-meta-bar__branch"><GitBranch size={12} /><code>{source}</code></span>
        <ArrowRight size={11} weight="bold" aria-label="合入" />
        <code className="review-meta-bar__target">{target}</code>
        {where && <span className="review-meta-bar__where">{where}</span>}
        <button
          type="button"
          className="review-meta-bar__toggle"
          aria-expanded={open}
          disabled={!commits.length}
          onClick={() => setOpen((value) => !value)}
        >
          <GitCommit size={12} />提交 {commits.length}
          {commits.length > 0 && <CaretDown size={11} weight="bold" />}
        </button>
      </div>
      {open && commits.length > 0 && (
        <div className="review-meta-bar__commits">
          <small>下面的 diff 是这条分支相对基线的整体改动，不按单个提交切分。</small>
          <CommitStrip commits={commits} />
        </div>
      )}
    </section>
  );
}
