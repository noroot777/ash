import { useState } from "react";
import type { GitDiff } from "@ash/shared/git-workbench";

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
  select?: { label: string; onApply: (lines: number[]) => void };
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  if (loading)
    return (
      <div className="gwb-empty" role="status">
        正在读取差异…
      </div>
    );
  if (error)
    return (
      <div className="gwb-empty gwb-error" role="alert">
        {error}
      </div>
    );
  if (!value)
    return (
      <div className="gwb-empty">
        <strong>选择一个文件或提交</strong>
        <span>在这里查看完整差异与提交详情</span>
      </div>
    );
  const lines = value.diff.split("\n");
  const eligible = (line: string) =>
    /^[+-]/.test(line) && !/^---|^\+\+\+/.test(line);
  const canSelect =
    select &&
    !value.truncated &&
    !value.binary &&
    !/^(rename|copy|new file mode|deleted file mode|old mode|new mode)/m.test(
      value.diff,
    );
  const toggle = (indices: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const remove = indices.every((index) => next.has(index));
      indices.forEach((index) =>
        remove ? next.delete(index) : next.add(index),
      );
      return next;
    });
  };
  return (
    <div className="gwb-diff-shell">
      {canSelect && (
        <div className="gwb-diff-tools">
          <span>点改动行或块标题选择 · 已选 {selected.size} 行</span>
          <button
            disabled={disabled || !selected.size}
            onClick={() => {
              select.onApply([...selected]);
              setSelected(new Set());
            }}
          >
            {select.label}
          </button>
        </div>
      )}
      {value.truncated && (
        <p className="gwb-banner">
          差异超过 1 MB，仅显示前一部分；部分暂存已停用。
        </p>
      )}
      {value.binary && (
        <p className="gwb-banner">二进制文件，按整个文件操作。</p>
      )}
      {!value.diff && <div className="gwb-empty">没有可显示的文本差异</div>}
      <div className="gwb-diff" aria-label="Git 差异">
        {lines.map((line, index) => {
          const change = eligible(line);
          const hunk = line.startsWith("@@ ");
          const className = `gwb-diff-line ${change ? (line[0] === "+" ? "is-add" : "is-remove") : hunk ? "is-hunk" : ""}${selected.has(index) ? " is-selected" : ""}`;
          if (canSelect && (change || hunk))
            return (
              <button
                type="button"
                key={index}
                className={className}
                aria-pressed={selected.has(index)}
                aria-label={
                  hunk ? `选择改动块 ${line}` : `选择第 ${index + 1} 行 ${line}`
                }
                disabled={disabled}
                onClick={() => {
                  if (!hunk) {
                    toggle([index]);
                    return;
                  }
                  const nextHunk = lines.findIndex(
                    (next, i) => i > index && next.startsWith("@@ "),
                  );
                  toggle(
                    lines
                      .map((_, i) => i)
                      .filter(
                        (i) =>
                          i > index &&
                          (nextHunk < 0 || i < nextHunk) &&
                          eligible(lines[i]),
                      ),
                  );
                }}
              >
                <span className="gwb-diff-number">{index + 1}</span>
                <code>{line || " "}</code>
              </button>
            );
          return (
            <div key={index} className={className}>
              <span className="gwb-diff-number">{index + 1}</span>
              <code>{line || " "}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
