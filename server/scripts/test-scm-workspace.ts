// 工作区 SCM 面板回归测试：porcelain v2 的解析和四个写操作，全部跑在临时仓库里。
//
// 钉住的是几条「看代码看不出来、错了又很安静」的行为：
//   • 重命名记录的原路径是**下一个 NUL 段**，顺序消费错一次，后面所有条目全错位
//   • 同一个文件 `MM` 时必须同时出现在 staged 和 unstaged，合并成一条就再也看不出
//     「暂存之后又改了什么」
//   • 文件名里的 `*` `[` `]` 不能被当成 glob——丢弃是不可逆的，误伤没有找回的路
//   • 空仓库（还没有任何提交）取消暂存要能走通，那条路上没有 HEAD 可以 restore
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatusV2, readScmFileDiff, readScmStatus } from "../src/git-status.js";
import {
  assertRepoRelative,
  commitWorkspace,
  discardPaths,
  ScmOperationError,
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

// ── 6. 路径校验：越界一律拒绝 ───────────────────────────────────────────────
for (const bad of ["", "  ", "/etc/passwd", "../outside.txt", "sub/../../escape.txt", "C:/Windows/x"]) {
  assert.throws(() => assertRepoRelative([bad]), ScmOperationError, `应拒绝越界路径：${JSON.stringify(bad)}`);
}
assert.deepEqual(assertRepoRelative(["sub\\win.txt", " ok.txt "]), ["sub/win.txt", "ok.txt"]);
assert.throws(() => assertRepoRelative([]), ScmOperationError, "空清单应拒绝");

// ── 7. 截断标记 ─────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: 2100 }, (_, i) => `? f${i}.txt`).join("\0");
  const parsed = parseStatusV2(`# branch.head main\0${many}\0`);
  assert.equal(parsed.truncated, true, "超过上限必须报截断，面板要说清楚没列全");
  assert.equal(parsed.untracked.length, 2000);
}

rmSync(root, { recursive: true, force: true });
console.log("scm ok");
