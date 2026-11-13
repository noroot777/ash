// 正文里「像路径的东西」怎么摆成工作区里的路径（components/fileLinkTarget.ts）。
// 跑:npm -w web run test:file-link-target
//
// 这一层只管形状，「有没有这个文件」由服务端答（lib/taskFileLocate.ts）。所以这里要钉住的是
// 两头：真写着文件的那几种写法都能摆出同一条相对路径；命令、标识符、网址一条都不送去问。
import assert from "node:assert/strict";
import { codeFilePath, isLocalFileHref, linkFilePath } from "../src/components/fileLinkTarget.ts";

const TASK = "HFqtMKPd0e8Y";

// ── 行内代码：一律相对工作区根，行列号不算路径 ─────────────────────────────────────
for (const [text, expected] of [
  ["docs/款式管理/标准款式定稿后维护方案.md", "docs/款式管理/标准款式定稿后维护方案.md"],
  ["./docs/plan.md", "docs/plan.md"],
  ["server/src/file-routes.ts:42", "server/src/file-routes.ts"],
  ["server/src/file-routes.ts:42:7", "server/src/file-routes.ts"],
  ["server/src/file-routes.ts:42-60", "server/src/file-routes.ts"],
  ["web/src/a.tsx#L12-L20", "web/src/a.tsx"],
  ["AGENTS.md", "AGENTS.md"],
  ["package.json", "package.json"],
  ["server/src/", "server/src"],
  [`/Users/fjh/code/harness/.worktrees/${TASK}/docs/plan.md`, "docs/plan.md"],
  ["/Users/fjh/code/harness/.worktrees/OtherTask123/docs/plan.md", "/Users/fjh/code/harness/.worktrees/OtherTask123/docs/plan.md"],
  ["/tmp/out/report.html", "/tmp/out/report.html"],
  ["C:\\work\\out\\report.md", "C:\\work\\out\\report.md"],
  // 空格、括号是合法的文件名字符：有没有这个文件交给服务端答，这里不许先挡掉（审查第 1 轮 N1）。
  ["docs/release notes.md", "docs/release notes.md"],
  ["docs/plan(final).md", "docs/plan(final).md"],
  // 家目录原样交给服务端展开：成片常落在 `~/Movies`，在工作区外，由 locate 判本机打不打得开。
  ["~/Movies/ash-promo.mp4", "~/Movies/ash-promo.mp4"],
]) {
  assert.equal(codeFilePath(text, TASK), expected, `行内代码 ${text}`);
}

// 不像路径的：命令、调用、版本号、网址、别人的家目录、glob——一条都不去问。
for (const text of [
  "npm run build",
  "useWorktree=false",
  "fileView.openFile()",
  "v1.2",
  "1.0.3",
  "https://example.com/a.md",
  "~bob/notes/a.md",
  "src/**/*.ts",
  "--flag/x",
  "complete_task",
  "",
  "../outside.md",
]) {
  assert.equal(codeFilePath(text, TASK), null, `不该当成路径：${JSON.stringify(text)}`);
}

// ── 链接：相对路径按文档所在目录解，`..` 能往上爬但不能爬出工作区 ──────────────────────
assert.equal(linkFilePath("docs/plan.md", TASK), "docs/plan.md");
assert.equal(linkFilePath("plan.md", TASK, "docs/款式管理"), "docs/款式管理/plan.md");
assert.equal(linkFilePath("../README.md", TASK, "docs/款式管理"), "docs/README.md");
assert.equal(linkFilePath("../../../x.md", TASK, "docs/a"), null, "爬出工作区根的不要");
assert.equal(linkFilePath("shots/a%20b.png", TASK, "docs"), "docs/shots/a b.png", "目的地是 URL 编码的，解一次");
assert.equal(linkFilePath("docs/%E6%96%B9%E6%A1%88.md", TASK), "docs/方案.md");
assert.equal(linkFilePath("server/src/a.ts#L12", TASK), "server/src/a.ts");
assert.equal(linkFilePath("server/src/a.ts:12", TASK), "server/src/a.ts");
assert.equal(linkFilePath(`file:///Users/fjh/code/harness/.worktrees/${TASK}/docs/plan.md`, TASK), "docs/plan.md");
assert.equal(linkFilePath("file:///tmp/a.md", TASK), "/tmp/a.md");
for (const href of ["https://example.com/a.md", "//cdn.example.com/a.png", "#section", "?q=1", "mailto:a@b.c", "", undefined]) {
  assert.equal(linkFilePath(href, TASK), null, `链接 ${String(href)} 跟工作区无关`);
}

// ── Markdown 地址清理放过哪些：只放本机文件地址，可执行协议照样交给默认清理 ─────────────
// （放过之后 `[x](file:///…)` 才到得了 linkFilePath，审查第 1 轮 F2）
for (const url of ["file:///Users/a/x.md", "FILE:///tmp/a.md", "C:\\work\\a.md", "d:/work/a.md"]) {
  assert.equal(isLocalFileHref(url), true, `本机文件地址要原样留着：${url}`);
}
for (const url of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "https://example.com/a.md", "docs/a.md", "/Users/a/x.md"]) {
  assert.equal(isLocalFileHref(url), false, `不归这条放行：${url}`);
}

console.log("✓ file link target: 行内代码按工作区根、链接按文档目录摆正；行列号去掉；命令/网址/越界一条不送去问");
