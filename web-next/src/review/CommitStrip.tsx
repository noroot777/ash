import { useState } from "react";
import { GitCommit } from "@phosphor-icons/react";
import type { TaskCommit } from "../lib/api.ts";
import { formatInstant } from "../task-detail/utils.ts";

const COLLAPSED_COUNT = 6;

// 提交列表**不与 diff 并排**：diff 读的是分支相对基线的整体改动（`GET /tasks/:id/diff`
// 没有按提交切分的口径），点某一个提交不会让右边的文件列表变，所以把它摆在 diff 旁边
// 只会白占宽度——横向被吃掉三分之一，真正要看的改动内容反而挤到没法读。
// 这里改成横铺一条：宽度全留给下面的「改动文件 + diff」，并在标题上把这件事说明白，
// 免得用户继续对着提交找不到能点的地方。
export function CommitStrip({ commits, branch }: { commits: TaskCommit[]; branch?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, commits.length - COLLAPSED_COUNT);
  const visible = expanded ? commits : commits.slice(0, COLLAPSED_COUNT);
  return (
    <section className="review-commit-strip">
      <header>
        <span><GitCommit size={13} />提交 · {commits.length}</span>
        {branch && <code title={branch}>{branch}</code>}
        <small>下面的改动是这条分支相对基线的整体 diff，不按单个提交切分</small>
      </header>
      {commits.length ? (
        <ul>
          {visible.map((commit) => (
            <li key={commit.sha}>
              <code>{commit.sha.slice(0, 8)}</code>
              <b>{commit.subject}</b>
              <time>{formatInstant(commit.at)}</time>
            </li>
          ))}
        </ul>
      ) : (
        <p>没有可归属到该任务分支的提交。</p>
      )}
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起提交" : `展开其余 ${hidden} 个提交`}
        </button>
      )}
    </section>
  );
}
