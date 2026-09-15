import { useEffect, useState } from "react";
import type {
  GitHistoryCommit,
  RebaseAction,
  RebaseStep,
} from "@ash/shared/git-workbench";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";
import { workbenchApi } from "./api.ts";

export function RebaseDialog({
  projectId,
  target,
  workbench: w,
  close,
}: {
  projectId: string;
  target: GitHistoryCommit;
  workbench: Workbench;
  close: () => void;
}) {
  const [steps, setSteps] = useState<RebaseStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [snapshot] = useState(() => ({
    root: w.data!.root,
    version: w.data!.version,
  }));
  useEffect(() => {
    let alive = true;
    workbenchApi
      .history(projectId, snapshot.root, { ref: "HEAD" })
      .then(({ commits }) => {
        if (!alive) return;
        const base = commits.findIndex((commit) => commit.sha === target.sha);
        if (base < 0)
          throw new Error(
            "基点不在当前分支最近 100 个提交中，请选择更近的基点",
          );
        const range = commits.slice(0, base).reverse();
        if (!range.length) throw new Error("基点之后没有可编辑的提交");
        if (range.some((commit) => commit.parents.length > 1))
          throw new Error("这段历史包含合并提交，请选择线性历史或使用普通变基");
        setSteps(
          range.map((commit) => ({
            sha: commit.sha,
            action: "pick",
            message: commit.subject,
          })),
        );
      })
      .catch((reason: Error) => {
        if (alive) setError(reason.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, snapshot.root, target.sha]);
  const change = (index: number, patch: Partial<RebaseStep>) =>
    setSteps((current) =>
      current.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  const move = (from: number, to: number) =>
    setSteps((current) => {
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  const first = steps.find((step) => step.action !== "drop");
  const invalid = first && ["squash", "fixup"].includes(first.action);
  return (
    <ConfirmDialog
      title="交互式变基"
      eyebrow="REWRITE HISTORY"
      message={`基点 ${target.sha.slice(0, 8)} · 从上到下重放提交。可以排序、改写信息、合并或丢弃。执行前保存原 HEAD；发生冲突时可继续或中止。已发布历史改写后需要保护强推。`}
      confirmLabel="执行变基计划"
      danger
      busy={busy}
      confirmDisabled={
        loading ||
        !!error ||
        !!invalid ||
        !steps.length ||
        steps.some((s) => s.action === "reword" && !s.message.trim()) ||
        w.blocked
      }
      onClose={close}
      className="gwb-rebase-dialog"
      onConfirm={() => {
        if (invalid || busy || error) return;
        setBusy(true);
        void w
          .run(
            { kind: "rebase-plan", target: target.sha, steps },
            undefined,
            snapshot,
          )
          .then((ok) => {
            setBusy(false);
            if (ok) close();
            else
              setError(
                "变基已暂停或未完成。请关闭窗口，查看操作日志与冲突面板。",
              );
          });
      }}
    >
      {loading && <p role="status">正在读取当前分支历史…</p>}
      {error && (
        <p className="gwb-error" role="alert">
          {error}
        </p>
      )}
      {invalid && (
        <p className="gwb-error">第一条保留提交不能 squash 或 fixup。</p>
      )}
      <div className="gwb-rebase-steps">
        {steps.map((step, index) => (
          <div
            className={`gwb-rebase-step${step.action === "drop" ? " is-dropped" : ""}`}
            key={step.sha}
          >
            <div className="gwb-inline-actions">
              <button
                disabled={index === 0 || busy}
                aria-label={`上移 ${step.sha.slice(0, 8)}`}
                onClick={() => move(index, index - 1)}
              >
                <ArrowUp size={12} />
              </button>
              <button
                disabled={index === steps.length - 1 || busy}
                aria-label={`下移 ${step.sha.slice(0, 8)}`}
                onClick={() => move(index, index + 1)}
              >
                <ArrowDown size={12} />
              </button>
            </div>
            <code>{step.sha.slice(0, 8)}</code>
            <select
              aria-label={`提交 ${index + 1} 的动作`}
              value={step.action}
              disabled={busy}
              onChange={(event) =>
                change(index, { action: event.target.value as RebaseAction })
              }
            >
              <option value="pick">pick · 保留</option>
              <option value="reword">reword · 改信息</option>
              <option value="squash">squash · 合并</option>
              <option value="fixup">fixup · 并入前条</option>
              <option value="drop">drop · 丢弃</option>
            </select>
            {step.action === "reword" ? (
              <input
                aria-label={`提交 ${index + 1} 的信息`}
                value={step.message}
                disabled={busy}
                onChange={(event) =>
                  change(index, { message: event.target.value })
                }
              />
            ) : (
              <span>{step.message}</span>
            )}
          </div>
        ))}
      </div>
      {!!steps.length && (
        <p className="gwb-hint">
          结果预计{" "}
          {
            steps.filter((s) => s.action === "pick" || s.action === "reword")
              .length
          }{" "}
          个提交 · squash 合并提交信息，fixup 使用前一条的信息
        </p>
      )}
    </ConfirmDialog>
  );
}
