import { useState } from "react";
import type { TaskCommit } from "../lib/api.ts";
import { openGitWorkbench } from "../git-workbench/navigation.ts";
import { formatInstant } from "../task-detail/utils.ts";

const COLLAPSED_COUNT = 6;

/** 点某一条提交时跳去哪儿。拿不到项目/任务归属就退回纯展示。 */
export type CommitLink = { projectId: string; taskId: string };

// 提交列表**不与 diff 并排**：diff 读的是分支相对基线的整体改动（`GET /tasks/:id/diff`
// 没有按提交切分的口径），点某一个提交不会让右边的文件列表变，所以把它摆在 diff 旁边
// 只会白占宽度。它现在收在 `ChangeMetaBar` 的「提交 N」按钮后面，标题、分支、以及「不按
// 单个提交切分」那句说明都由那条元信息行统一承担，这里只管把提交本身铺成一格一条。
//
// 「这一屏给不出单条提交的 diff」不等于用户不该看得到它：点一条就跳 Git 工作台的历史
// 视图，那边选中它、右边就是它自己的 diff。否则这份清单是个死胡同——看见了想看内容，
// 得自己去工作台从头找一遍。
export function CommitStrip({ commits, link }: { commits: TaskCommit[]; link?: CommitLink }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, commits.length - COLLAPSED_COUNT);
  const visible = expanded ? commits : commits.slice(0, COLLAPSED_COUNT);
  const body = (commit: TaskCommit) => (
    <>
      <code>{commit.sha.slice(0, 8)}</code>
      <b>{commit.subject}</b>
      <time>{formatInstant(commit.at)}</time>
    </>
  );
  return (
    <section className="review-commit-strip">
      {commits.length ? (
        <ul>
          {visible.map((commit) => (
            <li key={commit.sha} className={link ? "is-linked" : undefined}>
              {link ? (
                <button
                  type="button"
                  aria-label={`在 Git 工作台打开提交 ${commit.sha.slice(0, 8)} ${commit.subject}`}
                  onClick={() => openGitWorkbench({ ...link, view: "history", commit: commit.sha })}
                >
                  {body(commit)}
                </button>
              ) : (
                body(commit)
              )}
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
