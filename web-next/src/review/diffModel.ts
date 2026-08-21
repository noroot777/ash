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
