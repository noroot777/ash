import assert from "node:assert/strict";
import {
  countDiffLines,
  displayDiffLines,
  isDiffFileHeader,
  parseDiffLines,
  parseHunkHead,
  toSideBySideRows,
} from "../src/review/diffModel.ts";

// 统一 diff 的解析。DOM 那头由 test-file-diff-view 盯着摆法，这里盯**归类**：一行是
// 文件头还是内容、行号推到哪、哪些行界面上不摆。归类错一次就是漏展示真实改动（下面第
// 二组），而且它在 DOM 测试里表现为「看不见」，不容易一眼看出是解析的错。

const lines = (rows: readonly string[]) => parseDiffLines(rows.join("\n") + "\n");
const kinds = (rows: readonly string[]) => lines(rows).map((line) => line.kind);

// 1. 文件头区域：`---` / `+++` 以 -/+ 开头，但它们不是增删行，也不该摆出来。
{
  const rows = [
    "diff --git a/one.ts b/one.ts",
    "index 1111111..2222222 100644",
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " tail",
  ];
  assert.deepEqual(kinds(rows), ["meta", "meta", "meta", "meta", "hunk", "delete", "add", "context"]);
  assert.deepEqual(lines(rows).filter(isDiffFileHeader).map((line) => line.text), [
    "diff --git a/one.ts b/one.ts",
    "index 1111111..2222222 100644",
    "--- a/one.ts",
    "+++ b/one.ts",
  ]);
  assert.deepEqual(countDiffLines(lines(rows)), { additions: 1, deletions: 1 });
}

// 2. hunk 里真实的 `--- …` / `+++ …`：文件内容以 `-- ` / `++ ` 开头时，删改它就长这样。
//    按文本前缀去认文件头会把这两行吞掉——连内容带计数一起丢。
{
  const rows = [
    "diff --git a/flags.txt b/flags.txt",
    "index 7777777..8888888 100644",
    "--- a/flags.txt",
    "+++ b/flags.txt",
    "@@ -1,3 +1,3 @@",
    " keep",
    "--- old flag",
    "+++ new flag",
    " tail",
  ];
  const parsed = lines(rows);
  const deleted = parsed.find((line) => line.text === "--- old flag");
  const added = parsed.find((line) => line.text === "+++ new flag");
  assert.equal(deleted?.kind, "delete", "hunk 里的 `--- …` 是删掉的内容行，不是文件头");
  assert.equal(added?.kind, "add", "hunk 里的 `+++ …` 是新增的内容行，不是文件头");
  assert.equal(deleted?.oldLine, 2);
  assert.equal(added?.newLine, 2);
  assert.equal(isDiffFileHeader(deleted!), false, "内容行被当成格式行摘掉了");
  assert.equal(isDiffFileHeader(added!), false, "内容行被当成格式行摘掉了");
  assert.deepEqual(countDiffLines(parsed), { additions: 1, deletions: 1 });
  // 并排里一格只放正文：`-`/`+` 由它在哪一栏表达，剩下的 `-- old flag` 才是文件里的内容。
  const pairs = toSideBySideRows(displayDiffLines(parsed)).filter((row) => row.kind === "pair");
  assert.deepEqual(pairs.map((row) => row.kind === "pair" && [row.left.text, row.right.text]), [
    ["keep", "keep"],
    ["-- old flag", "++ new flag"],
    ["tail", "tail"],
  ]);
}

// 3. 多文件 diff 整份丢进来：下一个 `diff --git ` 把区域切回文件头，它后面的 `---`/`+++`
//    重新是文件头（而不是上一个 hunk 的删除行）。
{
  const rows = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-three",
    "+four",
  ];
  assert.deepEqual(kinds(rows), [
    "meta", "meta", "meta", "hunk", "delete", "add",
    "meta", "meta", "meta", "hunk", "delete", "add",
  ]);
  assert.deepEqual(countDiffLines(lines(rows)), { additions: 2, deletions: 2 });
}

// 4. 段头：拆出区间和 git 附的上下文，界面据此摆分隔条而不是印 `@@` 原文。
{
  assert.deepEqual(parseHunkHead("@@ -28,10 +28,12 @@ const sumOf = (files) =>"), {
    oldStart: 28,
    newStart: 28,
    context: "const sumOf = (files) =>",
  });
  assert.deepEqual(parseHunkHead("@@ -1 +1 @@"), { oldStart: 1, newStart: 1, context: "" });
  assert.equal(parseHunkHead("-@@ not a hunk"), null);
}

// 5. 摆出来的那些行：格式行摘掉；开在第一行的首个段头也摘掉（它不指示任何断开），中间
//    的段头留着。
{
  const parsed = lines([
    "diff --git a/two.ts b/two.ts",
    "index 5555555..6666666 100644",
    "--- a/two.ts",
    "+++ b/two.ts",
    "@@ -1,2 +1,2 @@",
    " head",
    "-first",
    "+second",
    "@@ -20,2 +20,2 @@ function tail() {",
    "-inner",
    "+outer",
  ]);
  const shown = displayDiffLines(parsed);
  assert.deepEqual(shown.map((line) => line.kind), ["context", "delete", "add", "hunk", "delete", "add"]);
  assert.equal(shown.find((line) => line.kind === "hunk")?.head?.context, "function tail() {");
  // 纯重命名：整段只有文件头，摘完一行都不剩（界面据此摆一句说明）。
  assert.deepEqual(
    displayDiffLines(lines([
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ])),
    [],
  );
}

// 6. `\ No newline at end of file` 是上一行的属性，不是文件头：它得留在行序列里，交给
//    并排视图挂到对应那一格上。
{
  const parsed = lines([
    "diff --git a/nonl.ts b/nonl.ts",
    "--- a/nonl.ts",
    "+++ b/nonl.ts",
    "@@ -1 +1 @@",
    "-old value",
    "\\ No newline at end of file",
    "+new value",
    "\\ No newline at end of file",
  ]);
  const marker = parsed.filter((line) => line.text.startsWith("\\ No newline"));
  assert.equal(marker.length, 2);
  assert.deepEqual(marker.map(isDiffFileHeader), [false, false], "无尾换行标记被当成格式行摘掉了");
  const pairs = toSideBySideRows(displayDiffLines(parsed)).filter((row) => row.kind === "pair");
  assert.equal(pairs.length, 1, "无尾换行标记把同一处替换顶成了两行");
  assert.deepEqual(pairs[0].kind === "pair" && [pairs[0].left.noNewline, pairs[0].right.noNewline], [true, true]);
}

console.log("diff model parse test passed");
