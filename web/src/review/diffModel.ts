import type { TaskDiffResult } from "../lib/api.ts";

// 统一 diff 文本的解析。原本长在 `ReviewDiffViewer.tsx` 里只服务分支审查，工作区
// SCM 面板要渲染同样的东西（同一份 `git diff` 输出、同样的行号推算），抽出来共用，
// 免得两处各写一份、行号在其中一处悄悄算错。

export type DiffLineKind = "add" | "delete" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffSection {
  file: TaskDiffResult["files"][number];
  body: string;
}

/** 把整份多文件 diff 按 `diff --git` 切成每个文件一段。 */
export function splitDiff(result: TaskDiffResult): DiffSection[] {
  const starts = [...result.diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0);
  const bodies = starts.map((start, index) =>
    result.diff.slice(start, starts[index + 1] ?? result.diff.length).trimEnd(),
  );
  if (!result.files.length && bodies.length) {
    return bodies.map((body, index) => ({
      file: { path: `diff-${index + 1}`, additions: null, deletions: null, origPath: null },
      body,
    }));
  }
  return result.files.map((file, index) => ({ file, body: bodies[index] ?? "" }));
}

/**
 * 逐行标注类型与新旧行号。
 *
 * 行号只在 hunk 头之后才有意义（`inHunk`）：文件头的 `--- a/x` / `+++ b/x` 也以 -/+
 * 开头，当成增删行会把整段行号推错一位。
 */
export function parseDiffLines(text: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return text.split("\n").map((line): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: "hunk", oldLine: null, newLine: null, text: line };
    }
    if (!inHunk || line.startsWith("diff --git") || line.startsWith("index ")
      || line.startsWith("---") || line.startsWith("+++")) {
      return { kind: "meta", oldLine: null, newLine: null, text: line };
    }
    if (line.startsWith("+")) {
      const row: DiffLine = { kind: "add", oldLine: null, newLine, text: line };
      newLine += 1;
      return row;
    }
    if (line.startsWith("-")) {
      const row: DiffLine = { kind: "delete", oldLine, newLine: null, text: line };
      oldLine += 1;
      return row;
    }
    if (line.startsWith("\\ No newline")) {
      return { kind: "meta", oldLine: null, newLine: null, text: line };
    }
    const row: DiffLine = { kind: "context", oldLine, newLine, text: line };
    oldLine += 1;
    newLine += 1;
    return row;
  });
}

/** diff 文本里的增删行数——SCM 单文件预览没有 numstat 可用，只能自己数。 */
export function countDiffLines(lines: readonly DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === "add") additions += 1;
    else if (line.kind === "delete") deletions += 1;
  }
  return { additions, deletions };
}

/** 并排视图里的一格：左栏放旧的，右栏放新的，某一侧没有对应行时是 `empty`。 */
export interface DiffCell {
  kind: "add" | "delete" | "context" | "empty";
  line: number | null;
  text: string;
  /** 这一行后面没有换行符（git 的 `\ No newline at end of file`）。 */
  noNewline: boolean;
}

export type DiffRow =
  /** 文件头和 `@@` 段头在并排视图里横跨两栏——它们不属于任何一侧。 */
  | { kind: "hunk" | "meta"; text: string }
  | { kind: "pair"; left: DiffCell; right: DiffCell };

const EMPTY_CELL: DiffCell = { kind: "empty", line: null, text: "", noNewline: false };

/** `\ No newline at end of file` —— 它不是独立的一行内容，而是**上一行的属性**。 */
function isNoNewlineMarker(line: DiffLine): boolean {
  return line.kind === "meta" && line.text.startsWith("\\ No newline");
}

/** 并排视图里每格只放正文，`+`/`-` 由它在哪一栏表达，再留个符号是噪声。 */
function cellOf(line: DiffLine | undefined, noNewline: ReadonlySet<DiffLine>): DiffCell {
  if (!line) return EMPTY_CELL;
  return {
    kind: line.kind === "add" || line.kind === "delete" ? line.kind : "context",
    line: line.kind === "delete" ? line.oldLine : line.kind === "add" ? line.newLine : line.oldLine,
    text: line.text.slice(1),
    noNewline: noNewline.has(line),
  };
}

/**
 * 统一 diff 的行序列折成并排两栏。
 *
 * 一段连续的删除和紧随其后的一段连续新增是**同一处改动的两面**，所以要按位置两两对齐
 * （第 i 条删对第 i 条增），长的一侧多出来的部分对空格。逐行交替配对会把「删 3 行、加 5
 * 行」排成锯齿，正是并排视图要消掉的东西。
 *
 * `\ No newline at end of file` 是唯一一种**不能打断这个收集过程**的 meta：改一个没有
 * 尾换行的文件，git 会输出「-旧行 / \No newline / +新行 / \No newline」，照常 flush
 * 就把同一处替换拆成上下两行（左边一行旧的、右边空，再下一行左边空、右边新的），并排
 * 视图正好在它最该对齐的地方失效。它依附于上一行，所以挂到那一行的格子上。
 */
export function toSideBySideRows(lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const noNewline = new Set<DiffLine>();
  let deletes: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(deletes.length, adds.length); index += 1) {
      rows.push({ kind: "pair", left: cellOf(deletes[index], noNewline), right: cellOf(adds[index], noNewline) });
    }
    deletes = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "delete") {
      deletes.push(line);
      continue;
    }
    if (line.kind === "add") {
      adds.push(line);
      continue;
    }
    if (isNoNewlineMarker(line)) {
      // 正在收集的那一侧的最后一行就是它说的那一行（+ 在 - 之后，所以先看 adds）。
      const pending = adds.at(-1) ?? deletes.at(-1);
      if (pending) {
        noNewline.add(pending);
        continue;
      }
      // 没在收集，说明它跟的是一条上下文行：那一行两侧是同一行，两边都标。
      const last = rows.at(-1);
      if (last?.kind === "pair") {
        last.left = { ...last.left, noNewline: last.left.kind !== "empty" };
        last.right = { ...last.right, noNewline: last.right.kind !== "empty" };
        continue;
      }
      // 前面一行都没有（不该出现的 diff），照旧当跨栏 meta 摆出来，别把它吞掉。
      rows.push({ kind: "meta", text: line.text });
      continue;
    }
    flush();
    if (line.kind === "context") {
      const text = line.text.slice(1);
      rows.push({
        kind: "pair",
        left: { kind: "context", line: line.oldLine, text, noNewline: false },
        right: { kind: "context", line: line.newLine, text, noNewline: false },
      });
    } else {
      rows.push({ kind: line.kind, text: line.text });
    }
  }
  flush();
  return rows;
}
