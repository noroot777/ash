// 「这个工作区相对 HEAD 变了吗」的判据（server/src/git.ts workspaceDirty）。
//
// 现场：任务 worktree 里没有 node_modules，agent 为了跑 typecheck/build 用 `ln -s` 借主仓
// 那份；而 .gitignore 里几乎都写成带尾斜杠的 `node_modules/`，那条只匹配目录、匹配不上
// 软链，于是 `git status --porcelain` 稳定报 `?? node_modules`。自由工作流据此把刚出炉
// 的审查结论判成「过期」，「按意见修复」入口消失、按钮改口「审查新改动」——纯误判。
//
// 钉住四条：
//   1. 借来的 node_modules 软链（含子包下的）不算脏
//   2. ash 自己的 .worktrees/ 不算脏
//   3. 真实改动（未跟踪的新源文件 / 改过的已跟踪文件）照常算脏
//   4. 读不到的目录返回 null（调用方按「不确定」处理，不当干净）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-workspace-dirty-"));
const repo = join(root, "repo");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Test");
  git(repo, "config", "user.email", "ash@example.test");
  mkdirSync(join(repo, "server"), { recursive: true });
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  // 子包里得有已跟踪文件，git 才会把 server/node_modules 单独报出来而不是折叠成 `?? server/`。
  writeFileSync(join(repo, "server", "index.ts"), "export const server = 1;\n");
  // 真实项目的写法：带尾斜杠，只匹配目录。本用例的重点就是它匹配不上软链。
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");

  const { workspaceDirty } = await import("../src/git.js");

  assert.equal(await workspaceDirty(repo), false, "刚提交完必须是干净的");

  // ── 1. 借来的 node_modules 软链不算脏 ────────────────────────────────────
  const shared = join(root, "shared-node-modules");
  mkdirSync(join(shared, "left-pad"), { recursive: true });
  symlinkSync(shared, join(repo, "node_modules"));
  symlinkSync(shared, join(repo, "server", "node_modules"));
  assert.match(git(repo, "status", "--porcelain"), /\?\? node_modules/,
    "前提校验：带尾斜杠的 .gitignore 确实忽略不掉软链，否则这个用例就失去意义了");
  assert.equal(await workspaceDirty(repo), false,
    "借来的 node_modules 软链是构建脚手架，不是这个任务的代码改动");

  // ── 2. ash 自己的 .worktrees/ 不算脏 ────────────────────────────────────
  mkdirSync(join(repo, ".worktrees", "someTask"), { recursive: true });
  writeFileSync(join(repo, ".worktrees", "someTask", "x.txt"), "x\n");
  assert.equal(await workspaceDirty(repo), false, "ash 放任务 worktree 的目录不算这个项目的改动");

  // ── 3. 真实改动照常算脏 ─────────────────────────────────────────────────
  writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
  assert.equal(await workspaceDirty(repo), true, "未跟踪的新源文件是真实改动，必须算脏");
  rmSync(join(repo, "feature.ts"));
  assert.equal(await workspaceDirty(repo), false);

  writeFileSync(join(repo, "seed.txt"), "seed changed\n");
  assert.equal(await workspaceDirty(repo), true, "已跟踪文件被改动必须算脏");
  git(repo, "checkout", "--", "seed.txt");
  assert.equal(await workspaceDirty(repo), false);

  // 已跟踪路径里真出现 node_modules 也不放过——放过的只有未跟踪条目。
  mkdirSync(join(repo, "fixtures", "node_modules"), { recursive: true });
  writeFileSync(join(repo, "fixtures", "node_modules", "keep.txt"), "tracked\n");
  git(repo, "add", "-f", "fixtures/node_modules/keep.txt");
  git(repo, "commit", "-m", "tracked fixture under node_modules");
  writeFileSync(join(repo, "fixtures", "node_modules", "keep.txt"), "tracked changed\n");
  assert.equal(await workspaceDirty(repo), true,
    "已跟踪文件即使住在 node_modules 下，改了也必须算脏");
  git(repo, "checkout", "--", "fixtures/node_modules/keep.txt");
  assert.equal(await workspaceDirty(repo), false);

  // ── 4. 读不到 → null，绝不谎报干净 ──────────────────────────────────────
  assert.equal(await workspaceDirty(join(root, "not-a-repo-at-all")), null,
    "目录不存在/不是 git 仓库时返回 null，让调用方按「不确定」处理");

  console.log("✓ workspaceDirty：软链依赖与 .worktrees 不算脏，真实改动照常算脏");
} finally {
  rmSync(root, { recursive: true, force: true });
}
