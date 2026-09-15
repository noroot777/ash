import type { AskAction } from "./ActionDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";

export function Backups({
  workbench: w,
  ask,
}: {
  workbench: Workbench;
  ask: AskAction;
}) {
  const data = w.data!;
  const disabled = w.blocked;
  return (
    <section aria-label="历史备份" className="gwb-ref-section gwb-backups">
      <div className="gwb-section-head">
        <div>
          <h2>历史备份 · {data.backups.length}</h2>
          <p>全部工作树共享，不受 200 条日志上限影响。备份保留到你主动删除。</p>
        </div>
        <button
          disabled={disabled}
          onClick={() =>
            ask({
              title: "清理变基辅助文件",
              message:
                "清理已结束变基留下的临时脚本和提交信息。任一工作树仍在变基或无法检查时会保留文件；历史备份不会被删除。",
              action: () => ({ kind: "rebase-cleanup" }),
            })
          }
        >
          清理变基辅助文件
        </button>
      </div>
      {data.backups.map((backup) => (
        <article className="gwb-ref-row" key={backup.ref}>
          <div className="gwb-ref-info">
            <strong>{backup.subject || "历史备份"}</strong>
            <code>{backup.ref}</code>
            <small>{backup.sha}</small>
          </div>
          <div className="gwb-inline-actions">
            <button
              disabled={disabled}
              onClick={() =>
                ask({
                  title: "从备份找回分支",
                  message: `从 ${backup.sha.slice(0, 8)} 建立新分支，不修改当前工作区。`,
                  fields: [
                    {
                      key: "name",
                      label: "恢复分支名",
                      initial: `recovery/${backup.ref.split("/").at(-1)!.slice(0, 8)}`,
                      required: true,
                    },
                  ],
                  action: (v) => ({
                    kind: "branch-create",
                    name: v.name,
                    target: backup.sha,
                    checkout: false,
                  }),
                })
              }
            >
              恢复为新分支
            </button>
            <button
              className="gwb-danger"
              disabled={disabled}
              onClick={() =>
                ask({
                  title: "删除备份",
                  danger: true,
                  typed: backup.ref,
                  message: `删除 ${backup.sha.slice(0, 8)} 的这条备份引用。仅由此备份保留的历史之后可能被 Git 回收，届时无法恢复；需要保留请先恢复为新分支。`,
                  action: () => ({
                    kind: "backup-delete",
                    ref: backup.ref,
                    sha: backup.sha,
                  }),
                })
              }
            >
              删除备份
            </button>
          </div>
        </article>
      ))}
      {!data.backups.length && (
        <div className="gwb-empty">没有保留的历史备份</div>
      )}
    </section>
  );
}
