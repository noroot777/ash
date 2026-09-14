// `@` 引用文件的候选来源（server/src/file-search.ts）。
//
// 这一条的价值全在**排序**上：候选只显示十来行，排错了等于没这个功能。所以钉死五件事，
// 任何一件退化都会让用户「敲了半天找不到那个文件」：
//   1. .gitignore 挡住的（构建产物、本地数据）**搜得到但排在最后** —— 只有 node_modules
//      这种量级失控的目录才是真的不枚举
//   2. 文件名命中排在路径中段命中前面（`api` 要先给 api.ts，不是 src/api/x.css）
//   3. 子序列能捞出深处的文件（`ftr` → FileTreeInspector.tsx）
//   4. 目录也是候选（git 只吐文件，目录得自己补）
//   5. 子目录里另有 `.git` 的是别人家的仓库，不跟进（否则同一份源码出现好几遍）
// 跑：npm -w server run test:file-search
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "ash-file-search-"));
const repo = join(stage, "repo");
const plain = join(stage, "plain");

const paths = (hits: { path: string }[]) => hits.map((hit) => hit.path);

try {
  for (const dir of ["src/lib", "src/files", "node_modules/junk", "dist"]) {
    mkdirSync(join(repo, dir), { recursive: true });
  }
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(join(repo, "README.md"), "# 门面\n");
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, "src", "api.ts"), "export const api = 1;\n");
  writeFileSync(join(repo, "src", "lib", "apiClient.ts"), "export const client = 1;\n");
  writeFileSync(join(repo, "src", "files", "FileTreeInspector.tsx"), "export const x = 1;\n");
  writeFileSync(join(repo, "node_modules", "junk", "api.ts"), "不该出现\n");
  writeFileSync(join(repo, "dist", "api.js"), "被忽略，但要搜得到\n");
  // 工作区里顺手 clone 的另一个仓库：它的文件归它自己那个根管。
  mkdirSync(join(repo, "vendor-repo"), { recursive: true });
  writeFileSync(join(repo, "vendor-repo", "borrowed.ts"), "别人家的\n");
  execFileSync("git", ["-C", join(repo, "vendor-repo"), "init", "-q"]);

  execFileSync("git", ["-C", repo, "init", "-q"]);

  const { searchWorkspaceFiles, forgetFileListing } = await import("../src/file-search.js");

  // ── 1. 被 gitignore 挡住的搜得到，但一律排在未忽略的后面 ───────────────────
  const api = await searchWorkspaceFiles(repo, { query: "api" });
  assert.ok(paths(api.hits).length > 0, "总得搜出点东西");
  for (const path of paths(api.hits)) {
    assert.ok(!path.startsWith("node_modules/"), `node_modules 量级失控，永远不该枚举：${path}`);
  }
  assert.ok(paths(api.hits).includes("dist/api.js"), "构建产物被忽略但仍要搜得到");
  assert.ok(
    api.hits.find((hit) => hit.path === "dist/api.js")?.ignored === true,
    "忽略的要自报家门，界面上才好标出来",
  );
  const lastLive = api.hits.findLastIndex((hit) => !hit.ignored);
  const firstIgnored = api.hits.findIndex((hit) => hit.ignored);
  assert.ok(firstIgnored > lastLive, "任何忽略项都得排在所有未忽略项之后");

  // ── 1b. 别人家的仓库不跟进 ────────────────────────────────────────────────
  const nested = await searchWorkspaceFiles(repo, { query: "borrowed" });
  assert.deepEqual(paths(nested.hits), [], "子仓库（子模块 / 别的 worktree）的文件不归这个根管");

  // ── 2. 文件名命中排在路径中段命中前面 ──────────────────────────────────────
  assert.equal(paths(api.hits)[0], "src/api.ts", "敲 api 第一条就该是 api.ts 本身");
  const clientAt = paths(api.hits).indexOf("src/lib/apiClient.ts");
  assert.ok(clientAt > 0, "同样在文件名上命中的排在后面，但要在");

  // ── 3. 子序列能捞出深处文件 ────────────────────────────────────────────────
  const fuzzy = await searchWorkspaceFiles(repo, { query: "ftr" });
  assert.ok(
    paths(fuzzy.hits).includes("src/files/FileTreeInspector.tsx"),
    "首字母缩写要能捞出对应文件",
  );

  // ── 4. 目录也是候选；带 `/` 的查询按路径判 ─────────────────────────────────
  const dirs = await searchWorkspaceFiles(repo, { query: "lib" });
  assert.ok(
    dirs.hits.some((hit) => hit.kind === "dir" && hit.path === "src/lib"),
    "目录必须能被 @ 到（git 只吐文件，目录靠派生）",
  );
  const bySegment = await searchWorkspaceFiles(repo, { query: "src/lib/apiclient.ts" });
  assert.equal(paths(bySegment.hits)[0], "src/lib/apiClient.ts", "整段路径要能直接命中（大小写无关）");

  // ── 5. 没敲字时给浅层的一把 ────────────────────────────────────────────────
  const empty = await searchWorkspaceFiles(repo, { query: "" });
  assert.ok(paths(empty.hits).includes("README.md"), "空查询先给仓库门面那几个文件");
  assert.ok(
    !empty.hits.some((hit) => hit.ignored),
    "还没敲字时不给忽略项：没有查询词，它们只会把门面挤掉",
  );
  assert.ok(
    paths(empty.hits).indexOf("README.md") < paths(empty.hits).indexOf("src/lib/apiClient.ts"),
    "空查询按层级浅的排前面",
  );

  // ── 6. 非 git 目录走自己那条，并且照样跳过 node_modules ────────────────────
  mkdirSync(join(plain, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(plain, "notes"), { recursive: true });
  writeFileSync(join(plain, "notes", "plan.md"), "计划\n");
  writeFileSync(join(plain, "node_modules", "junk", "plan.md"), "不该出现\n");
  const walked = await searchWorkspaceFiles(plain, { gitRepo: false, query: "plan" });
  assert.deepEqual(paths(walked.hits), ["notes/plan.md"], "非 git 目录同样不该把 node_modules 列出来");
  assert.ok(!walked.hits.some((hit) => hit.ignored), "没有 git 就谈不上「被忽略」");

  // ── 6b. 条数上限要如实说「还有更多」 ──────────────────────────────────────
  const capped = await searchWorkspaceFiles(repo, { query: "a", limit: 1 });
  assert.equal(capped.hits.length, 1, "limit 说一条就给一条");
  assert.equal(capped.more, true, "截掉了就得承认，界面才好提示继续输入");

  // ── 7. 缓存有寿命，但显式作废要立刻生效 ────────────────────────────────────
  writeFileSync(join(plain, "notes", "later.md"), "后加的\n");
  forgetFileListing(plain);
  const after = await searchWorkspaceFiles(plain, { gitRepo: false, query: "later" });
  assert.deepEqual(paths(after.hits), ["notes/later.md"], "作废缓存后要看得见新文件");

  console.log("file-search: ok");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
