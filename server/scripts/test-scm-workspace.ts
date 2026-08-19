// 工作区 SCM 面板回归测试：porcelain v2 的解析和四个写操作，全部跑在临时仓库里。
//
// 钉住的是几条「看代码看不出来、错了又很安静」的行为：
//   • 重命名记录的原路径是**下一个 NUL 段**，顺序消费错一次，后面所有条目全错位
//   • 重命名取消暂存必须连原路径一起送，否则索引里留下一条没人看见的删除
//   • 同一个文件 `MM` 时必须同时出现在 staged 和 unstaged，合并成一条就再也看不出
//     「暂存之后又改了什么」
//   • 文件名里的 `*` `[` `]` 不能被当成 glob——丢弃是不可逆的，误伤没有找回的路
//   • 目录 pathspec 必须被拒：`:(literal)` 只关 glob，关不掉目录递归
//   • 合法文件名（前后带空格、POSIX 上带反斜杠和反斜杠开头）不能被路径闸改写或拒掉
//   • 仓库外的路径不能被预览读出来
//   • 空仓库（还没有任何提交）取消暂存要能走通，那条路上没有 HEAD 可以 restore
//   • 分批操作跑到一半失败时，不许悄悄留下部分结果——删除整批拦下，索引如实报账
//   • 预暂存成功但 commit 失败，同样要报账：文件已经在索引里，下一次提交会带上它们
//   • 锁内复查（guard）拒绝时一步都不许做——排队等锁的几秒里 agent 可能刚被唤醒
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatusV2, readScmFileDiff, readScmStatus } from "../src/git-status.js";
import { IS_WINDOWS } from "../src/platform.js";
import { assertInsideRoot, assertPathShape, gateScmPaths, ScmOperationError } from "../src/scm-paths.js";
import {
  commitWorkspace,
  discardPaths,
  ScmPartialError,
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
for (const bad of ["", "/etc/passwd", "../outside.txt", "sub/../../escape.txt", "C:/Windows/x", "dir/", "a//b", "."]) {
  assert.throws(() => assertPathShape([bad]), ScmOperationError, `应拒绝非法路径：${JSON.stringify(bad)}`);
}
assert.throws(() => assertPathShape([]), ScmOperationError, "空清单应拒绝");
// 反斜杠是**平台相关**的：Windows 上是分隔符（根路径、`..` 段都要按它拆），POSIX 上是
// 文件名里的普通字符。同一批字符串因此在两个平台上是两种结论——一刀切成「都拒」，
// POSIX 上那些文件就成了面板上看得见、却既不能预览也不能操作的死条目。
for (const backslash of ["\\\\server\\share", "\\leading.txt", "sub\\..\\..\\escape.txt"]) {
  if (IS_WINDOWS) {
    assert.throws(() => assertPathShape([backslash]), ScmOperationError, `Windows 上应拒绝：${backslash}`);
  } else {
    assert.deepEqual(assertPathShape([backslash]), [backslash], `POSIX 上这是合法文件名：${backslash}`);
  }
}
// 形状闸只判断不改写：前后空格和（POSIX 上的）反斜杠都是文件名的一部分，
// 早先那版 trim + 替换分隔符，会把界面上看得见的文件变成一个不存在的路径。
assert.deepEqual(assertPathShape([" spaced.txt ", "a\\b.txt"]), [" spaced.txt ", "a\\b.txt"]);

// ── 6.5 POSIX：以反斜杠开头的文件名要能走完预览 → 暂存全程 ──────────────────
if (!IS_WINDOWS) {
  const repo = makeRepo("backslash");
  write(repo, "\\leading.txt", "hi\n");
  assert.deepEqual(paths((await readScmStatus(repo)).untracked), ["\\leading.txt"]);
  // 预览这条路要过三道闸（形状 → 白名单 → realpath），任何一道把它当绝对路径都会断在这里。
  await gateScmPaths(repo, { paths: ["\\leading.txt"] });
  await assertInsideRoot(repo, "\\leading.txt");
  const diff = await readScmFileDiff(repo, "\\leading.txt", "untracked");
  assert.ok(diff.diff.includes("+hi"), "反斜杠开头的文件要能预览");
  await stagePaths(repo, repo, ["\\leading.txt"]);
  assert.deepEqual(paths((await readScmStatus(repo)).staged), ["\\leading.txt"]);
}

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

// ── 9. 分批跑到一半失败：不许悄悄留下部分结果 ───────────────────────────────
//
// 路径超过 BATCH（200）就得拆成多次 git 调用，而 git 没有跨调用的事务。这两块钉住的
// 是「失败之后用户看到的和实际发生的必须一致」：能提前拦的（删除）一个都不做，拦不住
// 的（索引）如实报出哪些已经生效。
//
// 两块都只在 POSIX 上跑：Windows 的 ACL 不体现在 chmod/access 上，用同一套手法既造不出
// 失败也验不了预检——那正是 `assertRemovable` 注释里说的「尽力预检」的边界。
if (!IS_WINDOWS) {
  // 9a. 未跟踪文件的删除：预检发现有一个删不掉，就一个都不删。
  {
    const repo = makeRepo("clean-guard");
    write(repo, "ok.tmp", "a\n");
    write(repo, "ro/blocked.tmp", "b\n");
    chmodSync(join(repo, "ro"), 0o500);
    await assert.rejects(
      () => discardPaths(repo, repo, [], ["ok.tmp", "ro/blocked.tmp"]),
      (error: unknown) => error instanceof ScmOperationError && /一个都没删/.test(error.message),
      "有文件删不掉时必须在动手之前整批拒绝",
    );
    // 审查复现的原状是：前面的已经永久没了，用户只收到一句失败。现在它必须还在。
    assert.ok(existsSync(join(repo, "ok.tmp")), "预检不通过时，能删的那些也一个都不许删");
    chmodSync(join(repo, "ro"), 0o700);
  }

  // 9b. 索引操作拦不住半途失败，那就如实报账：done 里的路径是真的已经生效了。
  {
    const repo = makeRepo("partial-stage");
    const good = Array.from({ length: 200 }, (_, i) => `f${i}.txt`);
    for (const name of good) write(repo, name, `${name}\n`);
    write(repo, "unreadable.txt", "secret\n");
    chmodSync(join(repo, "unreadable.txt"), 0o000);
    // root 能无视权限位，那样这个用例造不出失败——如实跳过，不假装通过。
    const enforced = await access(join(repo, "unreadable.txt"), constants.R_OK).then(() => false, () => true);
    if (!enforced) {
      console.log("scm: 当前用户可无视权限位，跳过分批报账用例");
    } else {
      await assert.rejects(
        () => stagePaths(repo, repo, [...good, "unreadable.txt"]),
        (error: unknown) => error instanceof ScmPartialError
          && error.done.length === 200 && error.pending.length === 1
          && error.pending[0] === "unreadable.txt",
        "第二批失败时必须报出前一批已经生效",
      );
      assert.equal((await readScmStatus(repo)).staged.length, 200, "报账里说已生效的，索引里就得真有");
    }
    chmodSync(join(repo, "unreadable.txt"), 0o600);
  }
}

// ── 11. 提交失败时，预暂存已经生效这件事必须说出来 ──────────────────────────
//
// 预暂存和 commit 是两步，中间没有回滚：hook 拒绝 / 没得 amend / 签名失败，文件都已经
// 在索引里了。只回一句「提交失败」，用户会以为索引没动，下一次提交就把它们带上了。
// 这里用空仓库 `--amend` 造失败——不依赖 hook 的可执行位和 shell，两个平台上都成立。
{
  const repo = makeRepo("commit-partial");
  write(repo, "a.txt", "a\n");
  await assert.rejects(
    () => commitWorkspace(repo, repo, { message: "无处可 amend", stagePaths: ["a.txt"], amend: true }),
    (error: unknown) => error instanceof ScmPartialError
      && error.done.length === 1 && error.done[0] === "a.txt"
      && /已经暂存进索引/.test(error.message),
    "提交失败但预暂存已生效时，必须报账而不是当成普通失败",
  );
  assert.deepEqual(paths((await readScmStatus(repo)).staged), ["a.txt"], "报账里说进了索引的，索引里就得真有");

  // 没有预暂存的提交失败就是纯失败，不该套上「部分生效」的壳子——那样反而在说谎。
  await assert.rejects(
    () => commitWorkspace(repo, repo, { message: "无处可 amend", amend: true }),
    (error: unknown) => error instanceof ScmOperationError && !(error instanceof ScmPartialError),
    "没动过索引的提交失败必须保持普通失败",
  );
}

// ── 12. 锁内复查：guard 说不行就一步都不做 ──────────────────────────────────
//
// 路由进门时查过「任务在不在飞」，但排 withRepoLock 可能等上几秒，这期间 agent 完全
// 可能被唤醒开跑。判据因此要在锁内复查一次，且必须排在任何 git 写操作之前。
{
  const repo = makeRepo("guard");
  write(repo, "a.txt", "a\n");
  let called = 0;
  await assert.rejects(
    () => stagePaths(repo, repo, ["a.txt"], () => {
      called += 1;
      throw new ScmOperationError("任务开跑了", 409);
    }),
    (error: unknown) => error instanceof ScmOperationError && /任务开跑了/.test(error.message),
    "guard 拒绝时整个操作必须中止",
  );
  assert.equal(called, 1, "guard 必须被调用");
  assert.equal((await readScmStatus(repo)).staged.length, 0, "guard 拒绝之后索引一个字节都不许动");
}

// ── 10. 截断标记 ────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: 2100 }, (_, i) => `? f${i}.txt`).join("\0");
  const parsed = parseStatusV2(`# branch.head main\0${many}\0`);
  assert.equal(parsed.truncated, true, "超过上限必须报截断，面板要说清楚没列全");
  assert.equal(parsed.untracked.length, 2000);
}

rmSync(root, { recursive: true, force: true });
console.log("scm ok");
