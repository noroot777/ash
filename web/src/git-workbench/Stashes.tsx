import { useEffect, useState } from "react";
import { CaretDown, CaretRight, Stack } from "@phosphor-icons/react";
import type { GitDiff } from "@ash/shared/git-workbench";
import type { Workbench } from "./useWorkbench.ts";
import type { AskAction } from "./ActionDialog.tsx";
import { DiffView } from "./DiffView.tsx";
import { workbenchApi } from "./api.ts";

export function Stashes({
  projectId,
  workbench: w,
  ask,
}: {
  projectId: string;
  workbench: Workbench;
  ask: AskAction;
}) {
  const data = w.data!;
  const [stash, setStash] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    if (stash)
      workbenchApi
        .diff(projectId, data.root, { stash })
        .then((value) => {
          if (alive) setDiff(value);
        })
        .catch((reason: Error) => {
          if (alive) setError(reason.message);
        });
    return () => {
      alive = false;
    };
  }, [projectId, data.root, stash]);
  return (
    <div className="gwb-ref-section">
      {data.stashes.map((row) => (
        <article className="gwb-ref-row stash-item" key={row.sha}>
          <div className="stash-row gwb-stash-row">
            <button
              className="gwb-stash-toggle"
              aria-label={`查看差异 ${row.ref}`}
              aria-expanded={stash === row.sha}
              onClick={() => setStash(stash === row.sha ? null : row.sha)}
            >
              {stash === row.sha ? (
                <CaretDown size={12} />
              ) : (
                <CaretRight size={12} />
              )}
              <Stack size={14} />
              <code className="stash-index">{row.ref}</code>
              <span className="stash-msg">
                {row.subject.replace(/\[ash:[^\]]+\]\s*/, "")}
              </span>
              <span className={`session-chip${row.owned ? " is-mine" : ""}`}>
                {row.owned ? "我的贮藏" : "共享 · 仅应用"}
              </span>
            </button>
            <time className="branch-time">
              {new Date(row.at).toLocaleDateString()}
            </time>
            <div className="gwb-row-actions">
              <button
                className="mini-btn"
                disabled={w.blocked}
                onClick={() =>
                  ask({
                    title: "应用贮藏",
                    message: `将 ${row.ref} 的改动应用到 ${data.status.branch.head || "HEAD"}，保留原记录。工作区需要干净。若有冲突，可在工作台解决。`,
                    action: () => ({ kind: "stash-apply", sha: row.sha }),
                  })
                }
              >
                应用
              </button>
              {row.owned && (
                <>
                  <button
                    className="mini-btn"
                    disabled={w.blocked}
                    onClick={() =>
                      ask({
                        title: "弹出贮藏",
                        message:
                          "应用成功后删除这份贮藏；发生冲突时 Git 会保留原记录。",
                        action: () => ({ kind: "stash-pop", sha: row.sha }),
                      })
                    }
                  >
                    弹出
                  </button>
                  <button
                    className="mini-btn tone-danger"
                    disabled={w.blocked}
                    onClick={() =>
                      ask({
                        title: "删除贮藏",
                        message:
                          "删除这份保存的未提交改动。此操作不能从工作台直接撤销。",
                        danger: true,
                        typed: row.sha.slice(0, 8),
                        action: () => ({ kind: "stash-drop", sha: row.sha }),
                      })
                    }
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          </div>
          {stash === row.sha && (
            <div className="gwb-stash-diff stash-detail">
              <DiffView value={diff} loading={!diff && !error} error={error} />
            </div>
          )}
        </article>
      ))}
      {!data.stashes.length && (
        <div className="gwb-empty empty-hint">
          还没有贮藏记录 · 可先把当前改动保存起来
        </div>
      )}
    </div>
  );
}
