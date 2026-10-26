import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-gate-source-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
// 目录链:Windows 上普通软链要 SeCreateSymbolicLinkPrivilege,包管理器(pnpm 等)改用 junction,
// 而 junction 只认绝对路径、node 又把它同样报成 isSymbolicLink()。文件链在那台机器上没开发者
// 模式就建不出来,所以文件链的用例探测一次再决定跑不跑,目录链的用例三个平台都跑。
const linkDir = (target: string, path: string) => (process.platform === "win32"
  ? symlinkSync(resolve(dirname(path), target), path, "junction")
  : symlinkSync(target, path));
const fileLinks = (() => {
  if (process.platform !== "win32") return true;
  try {
    writeFileSync(join(root, "probe-target"), "probe");
    symlinkSync(join(root, "probe-target"), join(root, "probe-link"), "file");
    return true;
  } catch { return false; }
})();
if (!fileLinks) console.log("accept-gate-source: 本机建不出文件软链(Windows 未开开发者模式),文件链用例跳过,目录 junction 用例仍跑");
try {
  const { createGateSnapshot, gateSourceMatches, readGateSource, verifyGateSnapshot } = await import("../src/accept-gate-source.js");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Gate Source Test");
  git(repo, "config", "user.email", "source@example.test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\nignored.env\n");
  writeFileSync(join(repo, "value.txt"), "broken");
  writeFileSync(join(repo, "package.json"), '{}');
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "broken source");
  writeFileSync(join(repo, "value.txt"), "fixed");
  await assert.rejects(readGateSource(repo), /未提交/);
  git(repo, "add", "value.txt");
  await assert.rejects(readGateSource(repo), /未提交/);
  git(repo, "reset", "--hard", "HEAD");
  writeFileSync(join(repo, "untracked.txt"), "fixed");
  await assert.rejects(readGateSource(repo), /未跟踪/);
  rmSync(join(repo, "untracked.txt"));
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "dependency v1");
  for (const dependency of [".venv", "vendor", "target"]) {
    mkdirSync(join(repo, dependency));
    writeFileSync(join(repo, dependency, "dependency.txt"), `${dependency} independent input`);
  }
  writeFileSync(join(repo, "ignored.env"), "not supplied to tests");
  const source = await readGateSource(repo);
  const snapshot = join(root, "snapshot");
  await createGateSnapshot(repo, snapshot, source);
  assert.equal(git(snapshot, "rev-parse", "HEAD"), source.commit);
  assert.equal(git(snapshot, "remote"), "");
  assert.equal(existsSync(join(snapshot, "ignored.env")), false);
  assert.equal(readFileSync(join(snapshot, "value.txt"), "utf8"), "broken");
  for (const dependency of [".venv", "vendor", "target"]) {
    assert.equal(readFileSync(join(snapshot, dependency, "dependency.txt"), "utf8"), `${dependency} independent input`);
    writeFileSync(join(snapshot, dependency, "dependency.txt"), "test output");
    assert.equal(readFileSync(join(repo, dependency, "dependency.txt"), "utf8"), `${dependency} independent input`);
  }
  writeFileSync(join(repo, "value.txt"), "fixed");
  assert.equal(readFileSync(join(snapshot, "value.txt"), "utf8"), "broken", "live workspace changes cannot change tested source");
  assert.equal(await verifyGateSnapshot(snapshot, source), true);
  writeFileSync(join(snapshot, "generated.txt"), "test output");
  assert.equal(await verifyGateSnapshot(snapshot, source), true, "untracked test output stays in the disposable snapshot");
  writeFileSync(join(snapshot, "value.txt"), "fixed");
  assert.equal(await verifyGateSnapshot(snapshot, source), false, "test-modified source cannot certify the original commit");
  writeFileSync(join(snapshot, "node_modules", "dep", "index.js"), "test changed dependency");
  assert.equal(readFileSync(join(repo, "node_modules", "dep", "index.js"), "utf8"), "dependency v1");
  git(repo, "restore", "value.txt");
  assert.equal(gateSourceMatches({ sourceCommit: source.commit, sourceFingerprint: source.fingerprint }, await readGateSource(repo)), true);
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "dependency v2");
  assert.equal(gateSourceMatches({ sourceCommit: source.commit, sourceFingerprint: source.fingerprint }, await readGateSource(repo)), false);
  assert.equal(gateSourceMatches({ sourceCommit: source.commit }, source), false, "legacy HEAD-only passes are stale");
  await assert.rejects(createGateSnapshot(repo, join(root, "drift"), source), /已变化/);
  mkdirSync(join(repo, "packages", "app", "node_modules", "nested"), { recursive: true });
  writeFileSync(join(repo, "packages", "app", "package.json"), '{}');
  writeFileSync(join(repo, "packages", "app", "node_modules", "nested", "index.js"), "nested dependency");
  writeFileSync(join(repo, ".gitignore"), "ignored.env\n");
  git(repo, "add", ".gitignore", "packages/app/package.json");
  git(repo, "commit", "-m", "declare nested package inputs");
  const nestedSource = await readGateSource(repo);
  const nestedSnapshot = join(root, "nested-snapshot");
  await createGateSnapshot(repo, nestedSnapshot, nestedSource);
  assert.equal(readFileSync(join(nestedSnapshot, "packages", "app", "node_modules", "nested", "index.js"), "utf8"), "nested dependency");

  // 依赖树里的软链一律原样重建:拍平成真文件会让「靠自身所在位置做相对解析」的运行时在快照里
  // 一启动就死——tsx 的 .bin 链找不到同胞 package-*.mjs、venv 的解释器链 @executable_path
  // 落到快照里没有的 ../lib。语义与取舍写在 src/accept-gate-tree.ts 的软链分支注释里。
  rmSync(join(repo, "node_modules"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "store", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "store", "pkg", "index.js"), "store copy");
  linkDir(join("store", "pkg"), join(repo, "node_modules", "linked-pkg"));
  const external = join(root, "external-runtime");
  mkdirSync(external);
  writeFileSync(join(external, "runtime.mjs"), 'console.log("external runtime");\n');
  if (fileLinks) {
    // ① tsx 那个形状:.bin 下的链指向包里的 cli,cli 再按自身 realpath 找同胞模块
    mkdirSync(join(repo, "node_modules", ".bin"));
    mkdirSync(join(repo, "node_modules", "pkg", "dist"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "dist", "sibling.mjs"), 'export const mark = "sibling";\n');
    writeFileSync(join(repo, "node_modules", "pkg", "dist", "cli.mjs"), 'import { mark } from "./sibling.mjs";\nconsole.log(mark);\n');
    symlinkSync(join("..", "pkg", "dist", "cli.mjs"), join(repo, "node_modules", ".bin", "cli.mjs"));
    // ② .venv/bin/python3 -> python -> /opt/homebrew/... 那个形状:多级链,末端落在树外
    symlinkSync(join(external, "runtime.mjs"), join(repo, ".venv", "runtime.mjs"));
    symlinkSync("runtime.mjs", join(repo, ".venv", "alias.mjs"));
    // ③ 悬空链在 node_modules 里很常见,不能崩掉整次快照
    symlinkSync(join(root, "missing-dependency"), join(repo, "node_modules", "dangling"));
    // 指向树内却写成绝对路径:必须改写到副本,否则测试会被拉回活动工作区
    symlinkSync(join(repo, "node_modules", "pkg", "dist", "sibling.mjs"), join(repo, "node_modules", "absolute.mjs"));
  }
  const linkSource = await readGateSource(repo);
  assert.equal((await readGateSource(repo)).fingerprint, linkSource.fingerprint, "④ 同一棵树两次摘要必须稳定");
  const linkSnapshot = join(root, "link-snapshot");
  await createGateSnapshot(repo, linkSnapshot, linkSource);
  const linkedPkg = join(linkSnapshot, "node_modules", "linked-pkg");
  assert.equal(lstatSync(linkedPkg).isSymbolicLink(), true, "目录软链/junction 不能被整棵拷成真目录");
  assert.equal(readFileSync(join(linkedPkg, "index.js"), "utf8"), "store copy");
  assert.equal(realpathSync(linkedPkg), realpathSync(join(linkSnapshot, "node_modules", "store", "pkg")),
    "指向树内的目录链在副本里指向副本自己那份,不能回指活动工作区");
  assert.equal((await readGateSource(linkSnapshot)).fingerprint, linkSource.fingerprint,
    "④ 源树与拷贝树必须算出同一个摘要");
  if (fileLinks) {
    const bin = join(linkSnapshot, "node_modules", ".bin", "cli.mjs");
    assert.equal(lstatSync(bin).isSymbolicLink(), true, "依赖树里的软链不能被拍平成真文件");
    assert.equal(readlinkSync(bin), join("..", "pkg", "dist", "cli.mjs"), "指向树内的相对链原文照抄");
    assert.equal(execFileSync(process.execPath, [bin], { encoding: "utf8" }).trim(), "sibling",
      "① 原样重建之后,按自身 realpath 解析同胞模块的 cli 才能在快照里真跑起来");
    assert.equal(readlinkSync(join(linkSnapshot, ".venv", "alias.mjs")), "runtime.mjs");
    assert.equal(readlinkSync(join(linkSnapshot, ".venv", "runtime.mjs")), join(external, "runtime.mjs"),
      "② 落在树外的末端链保留绝对落点");
    assert.equal(execFileSync(process.execPath, [join(linkSnapshot, ".venv", "alias.mjs")], { encoding: "utf8" }).trim(),
      "external runtime", "② 多级链逐级重建后整条仍可执行");
    assert.equal(readlinkSync(join(linkSnapshot, "node_modules", "absolute.mjs")),
      join(linkSnapshot, "node_modules", "pkg", "dist", "sibling.mjs"), "指向树内的绝对链改写到副本自己那份");
    assert.equal(lstatSync(join(linkSnapshot, "node_modules", "dangling")).isSymbolicLink(), true);
    assert.equal(existsSync(join(linkSnapshot, "node_modules", "dangling")), false, "③ 悬空链原样保留,且不崩掉整次快照");
  }

  // 依赖根自己就是软链(worktree 借主仓 node_modules 的形状):相对原文照抄会因为快照与项目目录
  // 深度不同而指错地方,所以改写成绝对落点。
  rmSync(join(repo, "node_modules"), { recursive: true });
  const borrowed = join(root, "borrowed-dependencies");
  mkdirSync(borrowed);
  writeFileSync(join(borrowed, "dep.js"), "borrowed v1");
  linkDir(borrowed, join(borrowed, "self"));
  linkDir(join("..", "borrowed-dependencies"), join(repo, "node_modules"));
  const borrowedSource = await readGateSource(repo);
  const copy = join(root, "borrowed-snapshot");
  await createGateSnapshot(repo, copy, borrowedSource);
  assert.equal(lstatSync(join(copy, "node_modules")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(copy, "node_modules")), realpathSync(borrowed), "指向树外的相对链改写成绝对落点");
  assert.equal(existsSync(join(copy, "node_modules", "self")), true, "不再跟随软链,自指环既不会递归也不需要剪除");
  assert.equal((await readGateSource(copy)).fingerprint, borrowedSource.fingerprint);
  writeFileSync(join(borrowed, "dep.js"), "borrowed v2");
  assert.equal(readFileSync(join(copy, "node_modules", "dep.js"), "utf8"), "borrowed v2",
    "依赖根指向树外时快照不再冻住它:改成整棵拷贝会把里面的链拍平(pnpm/.bin/venv 全废),这个取舍是有意的");

  const loose = join(root, "non-git");
  mkdirSync(loose);
  writeFileSync(join(loose, "source.txt"), "non-git source");
  mkdirSync(join(loose, "deep"));
  writeFileSync(join(loose, "deep", "nested.txt"), "nested");
  linkDir("deep", join(loose, "deep-link"));
  const looseSource = await readGateSource(loose);
  const looseSnapshot = join(root, "loose-snapshot");
  await createGateSnapshot(loose, looseSnapshot, looseSource);
  assert.equal(lstatSync(join(looseSnapshot, "deep-link")).isSymbolicLink(), true, "非 Git 项目的软链同样原样重建");
  assert.equal(realpathSync(join(looseSnapshot, "deep-link")), realpathSync(join(looseSnapshot, "deep")),
    "非 Git 项目里指向树内的链也必须落在副本自己那份上");
  mkdirSync(join(looseSnapshot, "build"));
  writeFileSync(join(looseSnapshot, "build", "output.txt"), "generated output");
  assert.equal(await verifyGateSnapshot(looseSnapshot, looseSource), true);
  writeFileSync(join(looseSnapshot, "source.txt"), "changed by test");
  assert.equal(await verifyGateSnapshot(looseSnapshot, looseSource), false);
  assert.equal(readFileSync(join(loose, "source.txt"), "utf8"), "non-git source");
  const beforeGitlink = git(repo, "rev-parse", "HEAD");
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${beforeGitlink},nested-submodule`);
  git(repo, "commit", "-m", "gitlink without gitmodules");
  await assert.rejects(readGateSource(repo), /子模块/, "缺少 .gitmodules 的 gitlink 同样不能悄悄作为完整源码运行");
  git(repo, "reset", "--hard", beforeGitlink);
  if (fileLinks) {
    symlinkSync(join(root, "non-git", "source.txt"), join(repo, "external-link"));
    git(repo, "add", "external-link");
    git(repo, "commit", "-m", "external link");
    await assert.rejects(createGateSnapshot(repo, join(root, "unsafe-link"), await readGateSource(repo)), /快照外/);
  }
  console.log("accept-gate-source: isolated commits, dirty/index/untracked rejection, dependencies, symlinks, outputs and non-Git identity passed");
} finally { rmSync(root, { recursive: true, force: true }); }
