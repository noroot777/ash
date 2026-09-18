import type { TaskDiffResult } from "../lib/api.ts";

// 统一 diff 文本的解析。原本长在 `ReviewDiffViewer.tsx` 里只服务分支审查，工作区
// SCM 面板要渲染同样的东西（同一份 `git diff` 输出、同样的行号推算），抽出来共用，
// 免得两处各写一份、行号在其中一处悄悄算错。

export type DiffLineKind = "add" | "delete" | "context" | "hunk" | "meta";

/** 拆开的 `@@ -a,b +c,d @@ 上下文` ——界面摆一条分隔条，不印 `@@` 原文。 */
export interface DiffHunkHead {
  oldStart: number;
  newStart: number;
  /** `@@ … @@` 后面 git 附的那段所在函数（`diff.context`），没有就是空串。 */
  context: string;
}

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  /** 只有 `kind === "hunk"` 有。 */
  head?: DiffHunkHead;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/**
 * 文件头那几行（`diff --git` / `index` / `---` / `+++` / mode / rename）是 diff 的
 * **传输格式**，不是文件内容：路径、重命名、增删数在界面上都另有出处（标题栏、文件树、
 * 计数胶囊），原样印出来只是噪声——而且是最显眼的那几行，正好压在第一屏。
 *
 * 判定放在解析层但过滤发生在渲染层：解析出的行序列还要拿去数增删、推行号，丢信息不如
 * 标出来由各视图自己决定摆不摆。
 *
 * 只会命中**文件头区域**的行：`parseDiffLines` 进 hunk 之后不再产出 meta（除了
 * `\ No newline`），所以 hunk 里真实的 `--- old flag` / `+++ new flag` 摸不到这条正则。
 */
const FILE_HEADER_RE =
  /^(diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename (from|to) |copy (from|to) )/;

export function isDiffFileHeader(line: DiffLine): boolean {
  return line.kind === "meta" && FILE_HEADER_RE.test(line.text);
}

/**
 * 摆出来的那些行：格式行摘掉（`isDiffFileHeader`），开在文件第一行的首个 hunk 头也摘掉
 * ——它不指示任何断开，只是 diff 的起点，摆一条分隔条反而像文件上面还藏着东西。
 */
export function displayDiffLines(lines: readonly DiffLine[]): DiffLine[] {
  const rows = lines.filter((line) => !isDiffFileHeader(line));
  const first = rows[0];
  if (first?.kind === "hunk" && (first.head?.oldStart ?? 1) <= 1 && (first.head?.newStart ?? 1) <= 1) rows.shift();
  return rows;
}

/** `@@ -28,10 +28,12 @@ const sumOf = …` → 区间 + 上下文。不是 hunk 头就给 null。 */
export function parseHunkHead(text: string): DiffHunkHead | null {
  const match = HUNK_RE.exec(text);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]), context: match[3].trim() };
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
 * 一行是什么，由**它在哪个区域**决定，不由文本前缀决定：文件头区域（`inHunk === false`）
 * 里的一律是 meta——那儿的 `--- a/x` / `+++ b/x` 也以 -/+ 开头，当成增删行会把整段行号
 * 推错一位；进了 hunk 之后就只看第一个字符（` ` / `+` / `-` / `\`），因为 hunk 里每一行
 * 都带前缀。这两件事不能混着判：`--- old flag` 在 hunk 里是**删掉了一行以 `-- ` 开头的
 * 内容**，按前缀去认文件头会把它吞掉（连带增删计数一起错）。
 *
 * 多文件 diff 整份丢进来时，下一个 `diff --git ` 把区域切回文件头。它顶格出现不会跟内容
 * 行撞车——hunk 里的内容行一定带前缀，顶格的 `diff --git ` / `@@ ` / `index ` 只能是格式行。
 *
 * `git diff` 的 stdout 以换行收尾，`split` 出来的最后那个空字符串是**行分隔符的尾巴，
 * 不是一行内容**——留着它会在 hunk 里多出一条并不存在的空上下文行，还把行号多推一位
 * （并排视图里表现为末尾凭空多一行左右都标着行号的空行）。只丢这一个：diff 里真正的
 * 空上下文行是一个空格（`" "`），不会被误伤。
 */
export function parseDiffLines(text: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((line): DiffLine => {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      return { kind: "meta", oldLine: null, newLine: null, text: line };
    }
    const head = parseHunkHead(line);
    if (head) {
      oldLine = head.oldStart;
      newLine = head.newStart;
      inHunk = true;
      return { kind: "hunk", oldLine: null, newLine: null, text: line, head };
    }
    if (!inHunk) {
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
  | { kind: "hunk" | "meta"; text: string; head?: DiffHunkHead }
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
      rows.push({ kind: line.kind, text: line.text, head: line.head });
    }
  }
  flush();
  return rows;
}
