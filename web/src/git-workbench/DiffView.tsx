import { useState } from "react";
import { Plus, Sparkle, Trash } from "@phosphor-icons/react";
import type { GitDiff } from "@ash/shared/git-workbench";

export const discardLineGuidance =
  "丢弃时，所选＋行会从文件中删除，所选−行会恢复。修改只选＋行时，被替换的原始行不会恢复；只选−行时，新增内容会保留。完整还原修改需同时勾选对应的 − / + 行。";

export function DiffView({
  value,
  loading,
  error,
  select,
  disabled = false,
}: {
  value: GitDiff | null;
  loading?: boolean;
  error?: string | null;
  select?: {
    label: string;
    onApply: (lines: number[]) => void;
    onDiscard?: (lines: number[], scope: "hunk" | "selection") => void;
  };
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  if (loading)
    return (
      <div className="gwb-empty empty-hint" role="status">
        正在读取差异…
      </div>
    );
  if (error)
    return (
      <div className="gwb-empty empty-hint gwb-error" role="alert">
        {error}
      </div>
    );
  if (!value)
    return (
      <div className="gwb-empty empty-hint">
        <strong>选择一个文件或提交</strong>
        <span>在这里查看完整差异与提交详情</span>
      </div>
    );
  const lines = value.diff.split("\n");
  const noFinalNewline = lines.some((line) => line.startsWith("\\"));
  const eligible = (line: string) => /^[+-]/.test(line);
  const canSelect =
    select &&
    !value.truncated &&
    !value.binary &&
    !noFinalNewline &&
    !/^(rename|copy|new file mode|deleted file mode|old mode|new mode)/m.test(
      value.diff,
    );
  const toggle = (indices: number[]) =>
    setSelected((current) => {
      const next = new Set(current);
      const remove = indices.every((index) => next.has(index));
      indices.forEach((index) =>
        remove ? next.delete(index) : next.add(index),
      );
      return next;
    });
  const hunks: {
    header: string;
    index: number;
    path: string;
    rows: {
      index: number;
      text: string;
      old: number | null;
      next: number | null;
    }[];
  }[] = [];
  let path = "",
    old = 0,
    next = 0,
    hunk: (typeof hunks)[number] | undefined;
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) {
      hunk = undefined;
      path = "";
    } else if (!hunk && line.startsWith("+++ "))
      path = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("@@ ")) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      old = Number(range?.[1] || 0);
      next = Number(range?.[2] || 0);
      hunk = { header: line, index, path, rows: [] };
      hunks.push(hunk);
    } else if (hunk && /^[ +\\-]/.test(line)) {
      const sign = line[0];
      hunk.rows.push({
        index,
        text: line,
        old: sign === "+" || sign === "\\" ? null : old++,
        next: sign === "-" || sign === "\\" ? null : next++,
      });
    }
  });
  return (
    <div className="gwb-diff-shell diff-scroll">
      {value.truncated && (
        <p className="gwb-banner">
          差异超过 1 MB，仅显示前一部分；部分暂存已停用。
        </p>
      )}
      {value.binary && (
        <p className="gwb-banner">二进制文件，按整个文件操作。</p>
      )}
      {select && noFinalNewline && (
        <p className="gwb-banner">
          此差异包含无末尾换行的内容，请使用上方的
          {select.onDiscard
            ? "「暂存」或「丢弃改动」"
            : select.label.startsWith("取消")
              ? "「取消暂存」"
              : "「暂存」"}
          按整个文件操作。
        </p>
      )}
      {!value.diff && (
        <div className="gwb-empty empty-hint">没有可显示的文本差异</div>
      )}
      <div className="gwb-diff diff" aria-label="Git 差异">
        {hunks.map((part, index) => {
          const indices = part.rows
            .filter((row) => eligible(row.text))
            .map((row) => row.index);
          return (
            <div key={part.index}>
              {part.path &&
                part.path !== hunks[index - 1]?.path &&
                hunks.some((h) => h.path !== part.path) && (
                  <div className="detail-file-head">
                    <code>{part.path}</code>
                  </div>
                )}
              <section className="diff-hunk">
                <header className="diff-hunk-head">
                  {canSelect ? (
                    <button
                      className="gwb-diff-line is-hunk diff-hunk-header"
                      disabled={disabled}
                      aria-label={`选择改动块 ${part.header}`}
                      aria-pressed={
                        indices.length > 0 &&
                        indices.every((i) => selected.has(i))
                      }
                      onClick={() => toggle(indices)}
                    >
                      {part.header}
                    </button>
                  ) : (
                    <code className="diff-hunk-header">{part.header}</code>
                  )}
                  {canSelect && (
                    <div className="diff-hunk-actions">
                      <button
                        className="mini-btn"
                        disabled={disabled || !indices.length}
                        onClick={() => {
                          select.onApply(indices);
                          setSelected(new Set());
                        }}
                      >
                        <Plus size={12} />
                        {select.label.startsWith("取消")
                          ? "取消暂存此块"
                          : "暂存此块"}
                      </button>
                      {select.onDiscard && (
                        <button
                          className="mini-btn tone-danger"
                          disabled={disabled || !indices.length || selected.size > 0}
                          onClick={() => select.onDiscard?.(indices, "hunk")}
                        >
                          <Trash size={12} />
                          丢弃此块
                        </button>
                      )}
                    </div>
                  )}
                </header>
                <div className="diff-lines">
                  {part.rows.map((row) => {
                    const change = eligible(row.text);
                    const cls = `gwb-diff-line diff-line ${change ? (row.text[0] === "+" ? "is-add t-add" : "is-remove t-del") : ""}${canSelect && change ? " is-pickable" : ""}${selected.has(row.index) ? " is-selected is-picked" : ""}`;
                    const contents = (
                      <>
                        <span className="gwb-diff-number diff-no">
                          {row.old}
                        </span>
                        <span className="diff-no">{row.next}</span>
                        <span className="diff-sign">
                          {change ? row.text[0] : " "}
                        </span>
                        <code className="diff-code">
                          {row.text.slice(1) || " "}
                        </code>
                      </>
                    );
                    return canSelect && change ? (
                      <button
                        type="button"
                        key={row.index}
                        className={cls}
                        aria-pressed={selected.has(row.index)}
                        aria-label={`选择第 ${row.index + 1} 行 ${row.text}`}
                        disabled={disabled}
                        onClick={() => toggle([row.index])}
                      >
                        {contents}
                      </button>
                    ) : (
                      <div key={row.index} className={cls}>
                        {contents}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          );
        })}
        {!hunks.length && value.diff && (
          <pre className="gwb-raw-diff">{value.diff}</pre>
        )}
      </div>
      {canSelect && (
        <div className="gwb-diff-tools diff-tip">
          <Sparkle size={12} />
          <span>
            点选具体改动行可{select.onDiscard ? "暂存或丢弃所选内容" : "只操作那几行"} · 已选 {selected.size} 行
          </span>
          <button
            className="mini-btn tone-accent"
            disabled={disabled || !selected.size}
            onClick={() => {
              select.onApply([...selected]);
              setSelected(new Set());
            }}
          >
            {select.label}
          </button>
          {select.onDiscard && (
            <button
              className="mini-btn tone-danger"
              disabled={disabled || !selected.size}
              onClick={() => select.onDiscard?.([...selected], "selection")}
            >
              <Trash size={12} />
              丢弃所选改动
            </button>
          )}
          {!!selected.size && (
            <button className="mini-btn" disabled={disabled} onClick={() => setSelected(new Set())}>
              清除选择
            </button>
          )}
        </div>
      )}
      {canSelect && select.onDiscard && selected.size > 0 && (
        <p className="gwb-diff-discard-hint" role="note">
          {discardLineGuidance}
        </p>
      )}
    </div>
  );
}
