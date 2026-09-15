import { useEffect, useState } from "react";
import type { GitConflict } from "@ash/shared/git-workbench";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { workbenchApi } from "./api.ts";
import type { Workbench } from "./useWorkbench.ts";

function conflictBlocks(content: string) {
  const pattern =
    /^<<<<<<<[^\n]*\n([\s\S]*?)^=======[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  return [...content.matchAll(pattern)].map((match) => ({
    start: match.index,
    text: match[0],
    ours: match[1].split(/^\|{7}[^\n]*\n/m)[0],
    theirs: match[2],
  }));
}
export function ConflictDialog({
  projectId,
  path,
  workbench: w,
  close,
}: {
  projectId: string;
  path: string;
  workbench: Workbench;
  close: () => void;
}) {
  const [conflict, setConflict] = useState<GitConflict | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"blocks" | "versions">("blocks");
  useEffect(() => {
    let alive = true;
    workbenchApi
      .conflict(projectId, w.data!.root, path)
      .then((value) => {
        if (alive) {
          setConflict(value);
          setDraft(value.content || "");
        }
      })
      .catch((reason: Error) => {
        if (alive) setError(reason.message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, w.data!.root, path]);
  const blocks = conflictBlocks(draft);
  const applyBlock = (block: (typeof blocks)[number], content: string) =>
    setDraft(
      draft.slice(0, block.start) +
        content +
        draft.slice(block.start + block.text.length),
    );
  const save = async (choice: "ours" | "theirs" | "content" | "delete") => {
    if (!conflict || busy || w.isBlocked("resolve")) return;
    setBusy(true);
    setError(null);
    const ok = await w.run({
      kind: "resolve",
      path,
      version: conflict.version,
      choice,
      ...(choice === "content" ? { content: draft } : {}),
    });
    setBusy(false);
    if (ok) close();
    else setError("保存没有完成。请关闭窗口，查看操作日志与最新冲突后重试。");
  };
  return (
    <ConfirmDialog
      title={`解决冲突 · ${path}`}
      eyebrow="RESOLVE CONFLICT"
      message={
        w.data!.status.operation === "rebase"
          ? "变基期间，“我方”是目标基线，“对方”是正在重放的提交。保存后暂存此文件，全部解决后回到工作台继续。"
          : "选择冲突块的内容，或直接编辑最终结果。保存会标记该文件已解决；所有文件解决后可继续原操作。"
      }
      confirmLabel="保存结果并暂存"
      busy={busy}
      confirmDisabled={
        !conflict ||
        conflict.binary ||
        !!blocks.length ||
        !!error ||
        w.isBlocked("resolve")
      }
      onClose={close}
      onConfirm={() => void save("content")}
      className="gwb-conflict-dialog"
    >
      {!conflict && !error && <p role="status">正在读取冲突的三个版本…</p>}
      {error && (
        <p className="gwb-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <>
          <div className="gwb-conflict-toolbar">
            <div className="gwb-inline-actions">
              <button
                onClick={() => setTab("blocks")}
                aria-pressed={tab === "blocks"}
              >
                逐块解决 · {blocks.length}
              </button>
              <button
                onClick={() => setTab("versions")}
                aria-pressed={tab === "versions"}
              >
                对照三个版本
              </button>
            </div>
            <div className="gwb-inline-actions">
              <button
                disabled={
                  busy || w.isBlocked("resolve") || !conflict.available.ours
                }
                onClick={() => {
                  if (conflict.binary) void save("ours");
                  else setDraft(conflict.ours || "");
                }}
              >
                整份采用我方
              </button>
              <button
                disabled={
                  busy || w.isBlocked("resolve") || !conflict.available.theirs
                }
                onClick={() => {
                  if (conflict.binary) void save("theirs");
                  else setDraft(conflict.theirs || "");
                }}
              >
                整份采用对方
              </button>
              {(!conflict.available.ours || !conflict.available.theirs) && (
                <button
                  className="gwb-danger"
                  disabled={busy || w.isBlocked("resolve")}
                  onClick={() => void save("delete")}
                >
                  删除文件并解决
                </button>
              )}
            </div>
          </div>
          {conflict.binary ? (
            <p className="gwb-banner">
              二进制文件或文件超过 1
              MB，不能在文本编辑器里修改。请选择可用的一侧版本。
            </p>
          ) : (
            <div className="gwb-conflict-layout">
              <div className="gwb-conflict-context">
                {tab === "versions" ? (
                  (["base", "ours", "theirs"] as const).map((side) => (
                    <section key={side}>
                      <h3>
                        {side === "base"
                          ? "共同基线"
                          : side === "ours"
                            ? "我方"
                            : "对方"}
                      </h3>
                      <pre>{conflict[side] ?? "此版本不存在（删除）"}</pre>
                    </section>
                  ))
                ) : blocks.length ? (
                  blocks.map((block, index) => (
                    <section className="gwb-conflict-block" key={index}>
                      <header>
                        <strong>冲突块 {index + 1}</strong>
                        <div className="gwb-inline-actions">
                          <button
                            disabled={busy}
                            onClick={() => applyBlock(block, block.ours)}
                          >
                            采用我方
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => applyBlock(block, block.theirs)}
                          >
                            采用对方
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              applyBlock(block, block.ours + block.theirs)
                            }
                          >
                            两者都要
                          </button>
                        </div>
                      </header>
                      <pre className="is-ours">{block.ours}</pre>
                      <pre className="is-theirs">{block.theirs}</pre>
                    </section>
                  ))
                ) : (
                  <div className="gwb-empty">
                    冲突标记已清除，请检查右侧最终结果
                  </div>
                )}
              </div>
              <label className="gwb-conflict-editor">
                <span>最终结果 · 可直接编辑</span>
                <textarea
                  aria-label="冲突解决结果"
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                />
              </label>
            </div>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}
