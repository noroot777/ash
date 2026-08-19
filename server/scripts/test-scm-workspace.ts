// 工作区 SCM 面板回归测试：porcelain v2 的解析和四个写操作，全部跑在临时仓库里。
//
// 钉住的是几条「看代码看不出来、错了又很安静」的行为：
//   • 重命名记录的原路径是**下一个 NUL 段**，顺序消费错一次，后面所有条目全错位
//   • 重命名取消暂存必须连原路径一起送，否则索引里留下一条没人看见的删除
//   • 同一个文件 `MM` 时必须同时出现在 staged 和 unstaged，合并成一条就再也看不出
//     「暂存之后又改了什么」
//   • 文件名里的 `*` `[` `]` 不能被当成 glob——丢弃是不可逆的，误伤没有找回的路
//   • 目录 pathspec 必须被拒：`:(literal)` 只关 glob，关不掉目录递归
//   • 合法文件名（前后带空格、POSIX 上带反斜杠）不能被路径闸改写掉
//   • 仓库外的路径不能被预览读出来
//   • 空仓库（还没有任何提交）取消暂存要能走通，那条路上没有 HEAD 可以 restore
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatusV2, readScmFileDiff, readScmStatus } from "../src/git-status.js";
import { assertInsideRoot, assertPathShape, gateScmPaths, ScmOperationError } from "../src/scm-paths.js";
import {
  commitWorkspace,
  discardPaths,
  stagePaths,
  unstagePaths,
} from "../src/git-workspace-ops.js";

const root = mkdtempSync(join(tmpdir(), "harness-scm-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness SCM Test");
  git(repo, "config", "user.email", "scm@harness.test");
  return repo;
}

const write = (repo: string, path: string, body: string) => {
  const abs = join(repo, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
};

const paths = (list: { path: string }[]) => list.map((item) => item.path).sort();

// ── 1. 解析：重命名 / MM / 未跟踪 / 冲突 / 分支信息 ──────────────────────────
{
  const repo = makeRepo("parse");
  write(repo, "keep.txt", "a\n");
  write(repo, "we[i]rd*.txt", "x\n");
  write(repo, "sub/ren.txt", "old\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");

  write(repo, "keep.txt", "a\nb\n");
  git(repo, "add", "keep.txt");
  write(repo, "keep.txt", "a\nb\nc\n");          // 暂存后又改 → MM
  git(repo, "mv", "sub/ren.txt", "sub/新名字.txt"); // 重命名，原路径在下一个 token
  write(repo, "untracked.txt", "brand new\n");
  write(repo, "we[i]rd*.txt", "y\n");

  const status = await readScmStatus(repo);
  assert.equal(status.branch.head, "main");
  assert.equal(status.branch.detached, false);
  assert.deepEqual(paths(status.staged), ["keep.txt", "sub/新名字.txt"]);
  assert.deepEqual(paths(status.unstaged), ["keep.txt", "we[i]rd*.txt"]);
  assert.deepEqual(paths(status.untracked), ["untracked.txt"]);
  assert.equal(status.operation, null);

  const renamed = status.staged.find((item) => item.kind === "renamed");
  assert.ok(renamed, "重命名条目必须被识别出来");
  // 这一条是整个解析里最容易错的：原路径来自紧随其后的 NUL 段，不是同一行的字段。
  assert.equal(renamed.origPath, "sub/ren.txt");
  assert.equal(renamed.path, "sub/新名字.txt");
  // 中文路径原样返回（porcelain=v2 -z 不做 core.quotepath 转义）。
  assert.ok(!renamed.path.includes("\\3"), "中文路径不能是八进制转义");

  // MM 的文件必须两边都在，且暂存那份和工作区那份内容不同。
  assert.ok(status.staged.some((item) => item.path === "keep.txt"));
  assert.ok(status.unstaged.some((item) => item.path === "keep.txt"));
  const stagedDiff = await readScmFileDiff(repo, "keep.txt", "staged");
  const unstagedDiff = await readScmFileDiff(repo, "keep.txt", "unstaged");
  assert.ok(stagedDiff.diff.includes("+b"), "暂存 diff 应含已暂存的那一行");
  assert.ok(unstagedDiff.diff.includes("+c"), "未暂存 diff 应含暂存之后新加的那一行");
  const untrackedDiff = await readScmFileDiff(repo, "untracked.txt", "untracked");
  assert.ok(untrackedDiff.diff.includes("+brand new"), "未跟踪文件要能预览成全增 diff");
}

// ── 2. 冲突与中途操作 ───────────────────────────────────────────────────────
{
  const repo = makeRepo("conflict");
  write(repo, "c.txt", "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  git(repo, "checkout", "-q", "-b", "other");
  write(repo, "c.txt", "theirs\n");
  git(repo, "commit", "-qam", "theirs");
  git(repo, "checkout", "-q", "main");
  write(repo, "c.txt", "ours\n");
  git(repo, "commit", "-qam", "ours");
  try {
    git(repo, "merge", "other");
  } catch { /* 冲突是预期结果 */ }

  const status = await readScmStatus(repo);
  assert.deepEqual(paths(status.merge), ["c.txt"]);
  assert.equal(status.merge[0].conflict, "both_modified");
  assert.equal(status.operation, "merge", "合并中途必须报出来——此时提交和丢弃的含义都变了");

  // 冲突文件的丢弃必须在后端就被拒。前端不给按钮只是不显示，直接打 API 也得挡住：
  // `git restore` 对未合并条目的行为取决于给没给 --ours/--theirs，猜错就抹掉已解的一半。
  await assert.rejects(
    () => discardPaths(repo, repo, ["c.txt"], []),
    (error: unknown) => error instanceof ScmOperationError && /冲突/.test(error.message),
    "冲突中的文件不能被丢弃",
  );
  assert.ok(readFileSync(join(repo, "c.txt"), "utf8").includes("<<<<<<<"), "被拒之后冲突标记要原样留着");
}

// ── 3. 暂存 / 取消暂存 / 提交 ───────────────────────────────────────────────
{
  const repo = makeRepo("write");
  write(repo, "a.txt", "1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  write(repo, "a.txt", "2\n");
  write(repo, "b.txt", "new\n");
  writeFileSync(join(repo, "gone.txt"), "x\n");
  git(repo, "add", "gone.txt");
  git(repo, "commit", "-m", "add gone");
  rmSync(join(repo, "gone.txt"));

  await stagePaths(repo, repo, ["a.txt", "b.txt", "gone.txt"]);
  let status = await readScmStatus(repo);
  assert.deepEqual(paths(status.staged), ["a.txt", "b.txt", "gone.txt"]);
  // 删除也必须能暂存上——`git add` 不带 -A 时对已删除文件是无操作。
  assert.equal(status.staged.find((item) => item.path === "gone.txt")?.kind, "deleted");
  assert.equal(status.unstaged.length, 0);

  await unstagePaths(repo, repo, ["b.txt"]);
  status = await readScmStatus(repo);
  assert.deepEqual(paths(status.untracked), ["b.txt"], "取消暂存的新文件应回到未跟踪");

  const commit = await commitWorkspace(repo, repo, { message: "标题\n\n正文带换行与引号 \" '" });
  assert.ok(commit.sha.length >= 7);
  assert.equal(git(repo, "log", "-1", "--format=%s"), "标题");
  assert.equal(git(repo, "log", "-1", "--format=%b").trim(), "正文带换行与引号 \" '");
  status = await readScmStatus(repo);
  assert.equal(status.staged.length, 0, "提交后暂存区应清空");

  await assert.rejects(
    () => commitWorkspace(repo, repo, { message: "   " }),
    (error: unknown) => error instanceof ScmOperationError,
    "空提交信息必须被拒绝",
  );
}

// ── 3.5 重命名的取消暂存必须连原路径一起撤 ──────────────────────────────────
{
  const repo = makeRepo("rename-unstage");
  write(repo, "old.txt", "body\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "mv", "old.txt", "new.txt");

  const staged = (await readScmStatus(repo)).staged;
  assert.equal(staged.length, 1, "重命名在 status 里是合成的一条");
  assert.equal(staged[0].origPath, "old.txt");

  // 前端 pathsOf 对重命名条目送两条路径，这里模拟同一份入参。
  await unstagePaths(repo, repo, ["new.txt", "old.txt"]);
  const after = await readScmStatus(repo);
  // 只送 new.txt 的那一版会留下 staged `D old.txt`——界面报「已取消暂存」，
  // 用户下一次提交却只提交了一个删除。暂存区必须彻底干净。
  assert.equal(after.staged.length, 0, "取消暂存之后索引里不能留下那条删除");
  assert.deepEqual(paths(after.unstaged), ["old.txt"], "old.txt 的删除应退回工作区一侧");
  assert.deepEqual(paths(after.untracked), ["new.txt"], "new.txt 应回到未跟踪");
}

// ── 4. 丢弃：glob 文件名不能误伤旁边的文件 ──────────────────────────────────
{
  const repo = makeRepo("discard");
  write(repo, "a[1].txt", "keep me\n");
  write(repo, "a1.txt", "keep me too\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  write(repo, "a[1].txt", "changed\n");
  write(repo, "a1.txt", "changed\n");
  write(repo, "junk.tmp", "trash\n");

  await discardPaths(repo, repo, ["a[1].txt"], ["junk.tmp"]);
  assert.equal(readFileSync(join(repo, "a[1].txt"), "utf8"), "keep me\n", "点名的文件应还原");
  // 这一条是整个文件的核心：不加 `:(literal)`，`a[1].txt` 会被当成 glob 匹配到 a1.txt。
  assert.equal(readFileSync(join(repo, "a1.txt"), "utf8"), "changed\n", "同名 glob 命中的文件不能被波及");
  assert.ok(!existsSync(join(repo, "junk.tmp")), "点名的未跟踪文件应被删除");

  // 未跟踪文件只有出现在 deleteUntracked 里才删；混在 paths 里传不会误删。
  write(repo, "survivor.tmp", "still here\n");
  await discardPaths(repo, repo, ["a1.txt"], []);
  assert.ok(existsSync(join(repo, "survivor.tmp")), "未点名的未跟踪文件必须留着");
}

// ── 5. 空仓库：还没有 HEAD 时取消暂存 ───────────────────────────────────────
{
  const repo = makeRepo("empty");
  write(repo, "first.txt", "hello\n");
  await stagePaths(repo, repo, ["first.txt"]);
  assert.deepEqual(paths((await readScmStatus(repo)).staged), ["first.txt"]);
  // `git restore --staged` 在没有 HEAD 的仓库上会失败，必须自动退到 `rm --cached`。
  await unstagePaths(repo, repo, ["first.txt"]);
  const status = await readScmStatus(repo);
  assert.equal(status.staged.length, 0);
  assert.deepEqual(paths(status.untracked), ["first.txt"]);
  assert.equal(status.branch.oid, null, "空仓库的 branch.oid 是 (initial)，应归一成 null");
}

// ── 6. 路径校验：越界一律拒绝，合法文件名一律不许改写 ───────────────────────
for (const bad of ["", "/etc/passwd", "\\\\server\\share", "../outside.txt", "sub/../../escape.txt", "C:/Windows/x", "dir/", "a//b", "."]) {
  assert.throws(() => assertPathShape([bad]), ScmOperationError, `应拒绝非法路径：${JSON.stringify(bad)}`);
}
assert.throws(() => assertPathShape([]), ScmOperationError, "空清单应拒绝");
// 形状闸只判断不改写：前后空格和（POSIX 上的）反斜杠都是文件名的一部分，
// 早先那版 trim + 替换分隔符，会把界面上看得见的文件变成一个不存在的路径。
assert.deepEqual(assertPathShape([" spaced.txt ", "a\\b.txt"]), [" spaced.txt ", "a\\b.txt"]);

// ── 7. 白名单闸：目录递归、仓库外路径、合法怪名 ─────────────────────────────
{
  const repo = makeRepo("gate");
  write(repo, "dir/a.txt", "a\n");
  write(repo, "dir/b.txt", "b\n");
  write(repo, " spaced.txt ", "space\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  write(repo, "dir/a.txt", "a2\n");
  write(repo, "dir/b.txt", "b2\n");
  write(repo, " spaced.txt ", "space2\n");

  // 目录 pathspec：`:(literal)` 只关 glob，关不掉目录递归，靠白名单闸挡——
  // 不挡的话一次 API 调用就能不可逆地丢掉整个目录。
  await assert.rejects(
    () => discardPaths(repo, repo, ["dir"], []),
    (error: unknown) => error instanceof ScmOperationError && /不在当前的改动列表里/.test(error.message),
    "目录 pathspec 必须被拒绝",
  );
  assert.equal(readFileSync(join(repo, "dir/a.txt"), "utf8"), "a2\n", "被拒之后目录里的文件必须原样留着");
  assert.equal(readFileSync(join(repo, "dir/b.txt"), "utf8"), "b2\n");

  // 仓库里没有这个文件 → 拒。面板拿着过时状态点下来时走的也是这条。
  await assert.rejects(
    () => stagePaths(repo, repo, ["nope.txt"]),
    (error: unknown) => error instanceof ScmOperationError,
    "不在改动列表里的路径必须被拒绝",
  );

  // 反过来：合法但长得怪的文件名必须能走通全程。
  await stagePaths(repo, repo, [" spaced.txt "]);
  assert.ok(
    (await readScmStatus(repo)).staged.some((item) => item.path === " spaced.txt "),
    "前后带空格的合法文件名必须能暂存",
  );

  // 仓库外的文件不能被未跟踪预览读出来（`git diff --no-index` 是唯一绕开 pathspec 的路）。
  writeFileSync(join(root, "outside-secret.txt"), "SCM_ESCAPE_MARKER\n");
  await assert.rejects(
    () => gateScmPaths(repo, { paths: ["../outside-secret.txt"] }),
    (error: unknown) => error instanceof ScmOperationError,
    "仓库外的路径必须被白名单闸拒绝",
  );
  // 指向仓库外的软链会**原样出现在未跟踪列表里**，白名单闸放行它，只有 realpath 拦得住。
  symlinkSync(join(root, "outside-secret.txt"), join(repo, "escape-link.txt"));
  assert.ok(
    (await readScmStatus(repo)).untracked.some((item) => item.path === "escape-link.txt"),
    "软链本身确实会被 git 列成未跟踪——所以白名单闸单独挡不住它",
  );
  await assert.rejects(
    () => assertInsideRoot(repo, "escape-link.txt"),
    (error: unknown) => error instanceof ScmOperationError && /工作目录/.test(error.message),
    "指向仓库外的软链必须被 realpath 闸拒绝",
  );
}

// ── 8. 截断标记 ─────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: 2100 }, (_, i) => `? f${i}.txt`).join("\0");
  const parsed = parseStatusV2(`# branch.head main\0${many}\0`);
  assert.equal(parsed.truncated, true, "超过上限必须报截断，面板要说清楚没列全");
  assert.equal(parsed.untracked.length, 2000);
}

rmSync(root, { recursive: true, force: true });
console.log("scm ok");
