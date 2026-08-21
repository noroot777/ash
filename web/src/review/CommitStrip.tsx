import { useState } from "react";
import type { TaskCommit } from "../lib/api.ts";
import { formatInstant } from "../task-detail/utils.ts";

const COLLAPSED_COUNT = 6;

// 提交列表**不与 diff 并排**：diff 读的是分支相对基线的整体改动（`GET /tasks/:id/diff`
// 没有按提交切分的口径），点某一个提交不会让右边的文件列表变，所以把它摆在 diff 旁边
// 只会白占宽度。它现在收在 `ChangeMetaBar` 的「提交 N」按钮后面，标题、分支、以及「不按
// 单个提交切分」那句说明都由那条元信息行统一承担，这里只管把提交本身铺成一格一条。
export function CommitStrip({ commits }: { commits: TaskCommit[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, commits.length - COLLAPSED_COUNT);
  const visible = expanded ? commits : commits.slice(0, COLLAPSED_COUNT);
  return (
    <section className="review-commit-strip">
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
