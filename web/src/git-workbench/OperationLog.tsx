import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { AskAction } from "./ActionDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";

const states = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  conflict: "需要处理",
  failed: "未完成",
  interrupted: "服务曾中断",
};
export const actionLabels: Record<string, string> = {
  "remote-add": "添加远端",
  "remote-url": "修改远端地址",
  "remote-remove": "移除远端",
  "remote-delete-ref": "删除远端引用",
  stage: "暂存",
  unstage: "取消暂存",
  discard: "丢弃改动",
  patch: "部分暂存",
  commit: "提交",
  checkout: "切换分支",
  "branch-create": "新建分支",
  "branch-delete": "删除分支",
  "branch-rename": "重命名分支",
  upstream: "设置上游",
  merge: "合并",
  "cherry-pick": "拣选",
  revert: "反做",
  reset: "重置",
  rebase: "变基",
  "rebase-plan": "交互式变基",
  continue: "继续操作",
  abort: "中止操作",
  skip: "跳过提交",
  resolve: "解决冲突",
  "stash-save": "贮藏改动",
  "stash-apply": "应用贮藏",
  "stash-pop": "弹出贮藏",
  "stash-drop": "删除贮藏",
  "tag-create": "新建标签",
  "tag-delete": "删除标签",
  "tag-push": "推送标签",
  fetch: "获取远端",
  pull: "拉取",
  push: "推送",
  "worktree-add": "创建工作树",
  "worktree-remove": "移除工作树",
  "worktree-lock": "锁定工作树",
  "worktree-unlock": "解锁工作树",
  undo: "恢复历史",
};
export function OperationLog({
  workbench: w,
  ask,
}: {
  workbench: Workbench;
  ask: AskAction;
}) {
  const data = w.data!;
  return (
    <section className="gwb-page">
      <div className="gwb-section-head">
        <div>
          <h2>操作日志</h2>
          <p>最近 200 次工作台操作 · 排队、失败、中止和历史备份都会保留。</p>
        </div>
      </div>
      <div className="gwb-journal">
        {data.journal.map((entry) => {
          const undoable =
            !!entry.backup &&
            entry.recovery === "head" &&
            entry.state === "succeeded" &&
            entry.root === data.root &&
            entry.after === data.status.branch.oid &&
            entry.branch === data.status.branch.head;
          return (
            <article
              className={`gwb-journal-entry is-${entry.state}`}
              key={entry.id}
            >
              <div className="gwb-journal-dot">
                <ClockCounterClockwise size={17} />
              </div>
              <div className="gwb-journal-body">
                <header>
                  <strong>{actionLabels[entry.action] || entry.action}</strong>
                  <em>{states[entry.state]}</em>
                  <time>{new Date(entry.at).toLocaleString()}</time>
                </header>
                <p>{entry.message}</p>
                {entry.command && (
                  <small>
                    <code>{entry.command}</code>
                  </small>
                )}
                <small>
                  {entry.actor} · {entry.branch || "HEAD"} ·{" "}
                  <code>{entry.root}</code>
                </small>
                {entry.before && (
                  <small>
                    <code>
                      {entry.before.slice(0, 8)} →{" "}
                      {entry.after?.slice(0, 8) || "待核对"}
                    </code>
                  </small>
                )}
                {entry.backup && (
                  <div className="gwb-backup">
                    <span>
                      历史备份 <code>{entry.backup}</code>
                    </span>
                    <div className="gwb-inline-actions">
                      <button
                        disabled={w.blocked}
                        onClick={() =>
                          ask({
                            title: "从备份找回分支",
                            message: `从保留的${entry.targetName ? `「${entry.targetName}」引用` : "原 HEAD"}建立新分支，不修改当前工作区。`,
                            fields: [
                              {
                                key: "name",
                                label: "恢复分支名",
                                initial: `recovery/${entry.id.slice(0, 8)}`,
                                required: true,
                              },
                            ],
                            action: (v) => ({
                              kind: "branch-create",
                              name: v.name,
                              target: entry.backup!,
                              checkout: false,
                            }),
                          })
                        }
                      >
                        恢复为新分支
                      </button>
                      {undoable && (
                        <button
                          disabled={w.blocked}
                          onClick={() =>
                            ask({
                              title: "撤销这次历史操作",
                              danger: true,
                              message: `将当前分支恢复到 ${entry.before?.slice(0, 8)}。要求工作区干净，且 HEAD 与这次操作的结果一致。当前 HEAD 也会再次备份。`,
                              action: () => ({ kind: "undo", id: entry.id }),
                            })
                          }
                        >
                          撤销
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </article>
          );
        })}
        {!data.journal.length && (
          <div className="gwb-empty">还没有通过工作台执行过 Git 操作</div>
        )}
      </div>
    </section>
  );
}
