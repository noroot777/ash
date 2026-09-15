import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, GitMerge, Sparkle, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import type { AskAction } from "./ActionDialog.tsx";
import type { GitConflict } from "@ash/shared/git-workbench";
import { emptyCommitGuidance } from "@ash/shared/git-workbench";
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
  path: initialPath,
  ask,
  assist,
  workbench: w,
  close,
}: {
  projectId: string;
  path: string;
  ask: AskAction;
  assist?: () => void;
  workbench: Workbench;
  close: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [files] = useState(() => w.data!.status.merge.map((file) => file.path));
  const [saved, setSaved] = useState<string[]>([]);
  const drafts = useRef<Record<string, { draft: string; version: string }>>({});
  const container = useRef<HTMLElement>(null);
  const initialOperation = useRef(w.data!.status.operation);
  const [conflict, setConflict] = useState<GitConflict | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"blocks" | "versions">("blocks");
  useDismissable({ enabled: !busy, containerRef: container, onClose: close });
  useEffect(() => {
    container.current?.focus();
  }, []);
  useEffect(() => {
    if (!busy && !w.busy && !w.data!.status.merge.length &&
      ((initialOperation.current && !w.data!.status.operation) || !saved.length)) close();
  }, [busy, w.busy, w.data!.status.merge.length, w.data!.status.operation, saved.length, close]);
  useEffect(() => {
    let alive = true;
    setConflict(null);
    setError(null);
    setDraft("");
    workbenchApi
      .conflict(projectId, w.data!.root, path)
      .then((value) => {
        if (alive) {
          setConflict(value);
          setDraft(
            drafts.current[path]?.version === value.version
              ? drafts.current[path].draft
              : value.content || "",
          );
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
    if (ok) {
      setSaved((current) => [...current, path]);
      delete drafts.current[path];
      const next = w.data!.status.merge.find(
        (file) => file.path !== path && !saved.includes(file.path),
      );
      if (next) setPath(next.path);
      else setConflict(null);
    } else setError("保存没有完成。请关闭窗口，查看操作日志与最新冲突后重试。");
  };
  const switchFile = (next: string) => {
    if (conflict) drafts.current[path] = { draft, version: conflict.version };
    setPath(next);
  };
  const remaining = w.data!.status.merge.length;
  const emptyGuidance = emptyCommitGuidance(w.data!.status);
  const done = !remaining && saved.length > 0;
  return createPortal(
    <div className="gwb-design gwb-conflict-portal">
      <section
        ref={container}
        tabIndex={-1}
        className="gwb-conflict-dialog conflict-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={`解决冲突 · ${path}`}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const items = [...container.current!.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), [tabindex='0']")];
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) {
            event.preventDefault(); last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first?.focus();
          }
        }}
      >
        <header className="cf-head">
          <div className="cf-title">
            <GitMerge size={18} />
            <b>冲突解决器</b>
            <code>{w.data!.status.operation || "工作区冲突"}</code>
          </div>
          <span className="cf-progress">
            {remaining ? `${remaining} 个文件待解决` : "所有冲突文件已解决"}
          </span>
          <span className="flex-1" />
          {assist && (
            <button className="ui-btn" disabled={busy} onClick={assist}>
              <Sparkle size={13} />
              交给 AI 协助
            </button>
          )}
          {w.data!.status.operation && (
            <button
              className="ui-btn"
              disabled={busy || w.isBlocked("abort")}
              onClick={() =>
                ask({
                  title: "中止当前 Git 操作",
                  message: "撤回本次操作，已编辑的冲突结果也会撤回。",
                  danger: true,
                  action: () => ({ kind: "abort" }),
                })
              }
            >
              中止
            </button>
          )}
          {done && w.data!.status.operation ? (
            <button
              className="ui-btn primary"
              disabled={
                busy || w.isBlocked(emptyGuidance ? "skip" : "continue")
              }
              onClick={() =>
                void w
                  .run({ kind: emptyGuidance ? "skip" : "continue" })
                  .then(close)
              }
            >
              {emptyGuidance ? "跳过空提交" : `继续${w.data!.status.operation}`}
            </button>
          ) : (
            <button
              className="ui-btn primary"
              disabled={
                !conflict ||
                conflict.binary ||
                !!blocks.length ||
                !!error ||
                busy ||
                w.isBlocked("resolve")
              }
              onClick={() => void save("content")}
            >
              <Check size={13} />
              保存结果并暂存
            </button>
          )}
          <button
            className="icon-btn"
            aria-label="关闭冲突解决器"
            disabled={busy}
            onClick={close}
          >
            <X size={17} />
          </button>
        </header>
        <div className="cf-body">
          <nav className="cf-files" aria-label="冲突文件">
            {files.map((file) => (
              <button
                className={`cf-file ui-selectable${file === path ? " is-selected" : ""}`}
                key={file}
                disabled={busy || saved.includes(file)}
                onClick={() => switchFile(file)}
              >
                <span
                  className={`kind-badge ${saved.includes(file) ? "kind-A" : "kind-!"}`}
                >
                  {saved.includes(file) ? <Check size={12} /> : "!"}
                </span>
                <span className="file-name">{file}</span>
                <span
                  className={`conflict-state${saved.includes(file) ? " is-done" : ""}`}
                >
                  {saved.includes(file) ? "已解决" : "待解决"}
                </span>
              </button>
            ))}
          </nav>
          <div className="cf-main">
            <h3 className="cf-file-title">{path}</h3>
            <p className="gwb-hint">
              {w.data!.status.operation === "rebase"
                ? "变基期间，“我方”是目标基线，“对方”是正在重放的提交。"
                : "逐块选择要保留的内容，检查最终结果后保存并暂存。"}
            </p>
            {error && (
              <p className="gwb-error" role="alert">
                {error}
              </p>
            )}
            {!conflict && !error && !done && (
              <p role="status">正在读取冲突的三个版本…</p>
            )}
            {done && (
              <div className="gwb-empty empty-hint">
                <Check size={26} />
                <strong>所有冲突文件已解决</strong>
                <span>
                  {w.data!.status.operation
                    ? emptyGuidance || "可以继续原操作，或返回工作台检查结果。"
                    : "返回变更视图提交解决结果。"}
                </span>
                <button className="ui-btn" onClick={close}>
                  返回工作台
                </button>
              </div>
            )}
            {conflict && (
              <>
                <div className="gwb-conflict-toolbar">
                  <div className="gwb-inline-actions">
                    <button
                      className="mini-btn"
                      onClick={() => setTab("blocks")}
                      aria-pressed={tab === "blocks"}
                    >
                      逐块解决 · {blocks.length}
                    </button>
                    <button
                      className="mini-btn"
                      onClick={() => setTab("versions")}
                      aria-pressed={tab === "versions"}
                    >
                      对照三个版本
                    </button>
                  </div>
                  <div className="gwb-inline-actions">
                    <button
                      className="mini-btn"
                      disabled={
                        busy ||
                        w.isBlocked("resolve") ||
                        !conflict.available.ours
                      }
                      onClick={() => {
                        if (conflict.binary) void save("ours");
                        else setDraft(conflict.ours || "");
                      }}
                    >
                      整份采用我方
                    </button>
                    <button
                      className="mini-btn"
                      disabled={
                        busy ||
                        w.isBlocked("resolve") ||
                        !conflict.available.theirs
                      }
                      onClick={() => {
                        if (conflict.binary) void save("theirs");
                        else setDraft(conflict.theirs || "");
                      }}
                    >
                      整份采用对方
                    </button>
                    {(!conflict.available.ours ||
                      !conflict.available.theirs) && (
                      <button
                        className="mini-btn tone-danger"
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
                  <>
                    <div className="gwb-conflict-context">
                      {tab === "versions" ? (
                        <div className="gwb-conflict-versions">
                          {(["base", "ours", "theirs"] as const).map((side) => (
                            <section className="cf-block" key={side}>
                              <header className="cf-block-head">
                                <b>
                                  {side === "base"
                                    ? "共同基线"
                                    : side === "ours"
                                      ? "我方"
                                      : "对方"}
                                </b>
                              </header>
                              <pre className="cf-code">
                                {conflict[side] ?? "此版本不存在（删除）"}
                              </pre>
                            </section>
                          ))}
                        </div>
                      ) : (
                        blocks.map((block, index) => (
                          <section
                            className="gwb-conflict-block cf-block"
                            key={index}
                          >
                            <header className="cf-block-head">
                              <b>冲突块 {index + 1}</b>
                              <span className="cf-context">{path}</span>
                            </header>
                            <div className="cf-sides">
                              <section className="cf-side is-ours">
                                <div className="cf-side-head">
                                  <b>我方</b>
                                  <i>当前版本</i>
                                </div>
                                <pre className="cf-code is-ours">
                                  {block.ours}
                                </pre>
                              </section>
                              <section className="cf-side is-theirs">
                                <div className="cf-side-head">
                                  <b>对方</b>
                                  <i>传入版本</i>
                                </div>
                                <pre className="cf-code is-theirs">
                                  {block.theirs}
                                </pre>
                              </section>
                            </div>
                            <div className="cf-actions">
                              <button
                                className="mini-btn"
                                disabled={busy}
                                onClick={() => applyBlock(block, block.ours)}
                              >
                                采用我方
                              </button>
                              <button
                                className="mini-btn"
                                disabled={busy}
                                onClick={() => applyBlock(block, block.theirs)}
                              >
                                采用对方
                              </button>
                              <button
                                className="mini-btn"
                                disabled={busy}
                                onClick={() =>
                                  applyBlock(block, block.ours + block.theirs)
                                }
                              >
                                两者都要
                              </button>
                              {assist && (
                                <button
                                  className="mini-btn tone-accent"
                                  disabled={busy}
                                  onClick={assist}
                                >
                                  <Sparkle size={12} />
                                  AI 建议
                                </button>
                              )}
                              <button
                                className="mini-btn"
                                onClick={() =>
                                  container.current
                                    ?.querySelector<HTMLTextAreaElement>(
                                      "textarea",
                                    )
                                    ?.focus()
                                }
                              >
                                手工编辑
                              </button>
                            </div>
                          </section>
                        ))
                      )}
                    </div>
                    <label className="gwb-conflict-editor cf-editor">
                      <b>
                        {blocks.length
                          ? "最终结果 · 可直接编辑"
                          : "冲突标记已清除 · 请检查最终结果"}
                      </b>
                      <textarea
                        className="cf-textarea"
                        aria-label="冲突解决结果"
                        value={draft}
                        disabled={busy}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={false}
                        rows={12}
                      />
                    </label>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
