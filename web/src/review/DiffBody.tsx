import { useMemo } from "react";
import { Columns, Rows } from "@phosphor-icons/react";
import { toSideBySideRows, type DiffCell, type DiffLine } from "./diffModel.ts";
import { DIFF_LAYOUT_LABEL, DIFF_LAYOUT_TITLE, type DiffLayout } from "./diffLayout.ts";

// diff 正文的唯一渲染处。工作区 SCM 的单文件 diff 和分支审查的多文件 diff 都走这里，
// 两种摆法（单栏 / 并排）也只有这一份实现——否则「并排」这种事很容易在两边各长一套，
// 行号和空行补位的细节再各错各的。

export function DiffLayoutToggle({
  layout,
  onChange,
}: {
  layout: DiffLayout;
  onChange: (next: DiffLayout) => void;
}) {
  return (
    <div className="diff-layout-toggle" role="group" aria-label="对比方式">
      {(["unified", "split"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={layout === value}
          aria-label={DIFF_LAYOUT_TITLE[value]}
          onClick={() => onChange(value)}
        >
          {value === "unified" ? <Rows size={12} aria-hidden="true" /> : <Columns size={12} aria-hidden="true" />}
          {DIFF_LAYOUT_LABEL[value]}
        </button>
      ))}
    </div>
  );
}

function Cell({ cell, side }: { cell: DiffCell; side: "old" | "new" }) {
  return (
    <>
      <span className={`single-review-${side}`} role="cell">{cell.line ?? ""}</span>
      <code role="cell">
        {cell.text || " "}
        {/* 单栏里这是独立的一行 `\ No newline at end of file`；并排里它属于这一格，
            跟着正文走才不会把同一处替换顶开。 */}
        {cell.noNewline && <i className="single-review-nonl">无尾换行</i>}
      </code>
    </>
  );
}

/**
 * `visible` 按**当前摆法下的行数**算：并排把连续的删除和新增对到了一行上，行数比单栏少，
 * 沿用单栏的计数会让「展开后续 N 行」报一个对不上的数。
 */
export function DiffBody({
  lines,
  layout,
  visible,
  step,
  onMore,
  label,
}: {
  lines: readonly DiffLine[];
  layout: DiffLayout;
  visible: number;
  /** 「展开后续」一次放出来多少行。 */
  step: number;
  onMore: () => void;
  label: string;
}) {
  const rows = useMemo(() => layout === "split" ? toSideBySideRows(lines) : [], [layout, lines]);
  const total = layout === "split" ? rows.length : lines.length;
  const rest = Math.max(0, total - visible);

  return (
    <div className={`single-review-code${layout === "split" ? " is-split" : ""}`} role="table" aria-label={label}>
      {layout === "split"
        ? (
          // 并排的列宽要由**整块 diff 一起**定，不能每行各算各的：行宽按内容撑开时，一行
          // 里最长的那条会把同一行的两栏一起顶宽（两栏是等分的 fr），于是长行那一行的中缝
          // 和行号都比别的行靠右——整块看着像错位。这层 grid 持有四列（两侧各「行号 + 正
          // 文」），每行再 subgrid 接过去，所有行就共用同一组列。
          <div className="single-review-split-grid" role="rowgroup">
            {rows.slice(0, visible).map((row, index) => (
              row.kind === "pair" ? (
                <div className="single-review-line is-pair" role="row" key={index}>
                  <div className={`single-review-side is-${row.left.kind}`}><Cell cell={row.left} side="old" /></div>
                  <div className={`single-review-side is-${row.right.kind}`}><Cell cell={row.right} side="new" /></div>
                </div>
              ) : (
                <div className={`single-review-line is-span is-${row.kind}`} role="row" key={index}>
                  <code role="cell">{row.text || " "}</code>
                </div>
              )
            ))}
          </div>
        )
        : lines.slice(0, visible).map((line, index) => (
          <div className={`single-review-line is-${line.kind}`} role="row" key={index}>
            <span className="single-review-old" role="cell">{line.oldLine ?? ""}</span>
            <span className="single-review-new" role="cell">{line.newLine ?? ""}</span>
            <code role="cell">{line.text || " "}</code>
          </div>
        ))}
      {rest > 0 && (
        <button type="button" className="single-review-more-lines" onClick={onMore}>
          展开后续 {Math.min(step, rest)} 行
        </button>
      )}
    </div>
  );
}
