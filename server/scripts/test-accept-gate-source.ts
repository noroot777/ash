import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
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
  // 依赖目录是**借用**来的:快照里那是一条指向工作区那一份的链,不是逐文件拷进来的副本
  // (为什么不拷、代价是什么,见 src/accept-gate-deps.ts 顶部)。
  for (const dependency of [".venv", "vendor", "target", "node_modules"]) {
    assert.equal(lstatSync(join(snapshot, dependency)).isSymbolicLink(), true,
      `依赖目录在快照里必须是一条借用链:${dependency}`);
    assert.equal(realpathSync(join(snapshot, dependency)), realpathSync(join(repo, dependency)),
      `而且落在工作区那一份上:${dependency}`);
  }
  for (const dependency of [".venv", "vendor", "target"]) {
    assert.equal(readFileSync(join(snapshot, dependency, "dependency.txt"), "utf8"), `${dependency} independent input`);
  }
  // **写入外溢**是借用形态明确接受的代价(只读做不到,见 provideDependency 上方):门禁跑测试时写进
  // 依赖目录的东西会落到用户的工作区里。钉成显式契约——哪天有人把它改回「独立副本」,这条立刻
  // 红,而不是让下一个人以为隔离还在。
  writeFileSync(join(snapshot, "target", "dependency.txt"), "test output");
  assert.equal(readFileSync(join(repo, "target", "dependency.txt"), "utf8"), "test output",
    "借用的依赖目录:测试写进去的东西会落到工作区那一份上");
  writeFileSync(join(repo, "target", "dependency.txt"), "target independent input");
  writeFileSync(join(repo, "value.txt"), "fixed");
  assert.equal(readFileSync(join(snapshot, "value.txt"), "utf8"), "broken", "live workspace changes cannot change tested source");
  assert.equal(await verifyGateSnapshot(snapshot, source), true);
  writeFileSync(join(snapshot, "generated.txt"), "test output");
  assert.equal(await verifyGateSnapshot(snapshot, source), true, "untracked test output stays in the disposable snapshot");
  writeFileSync(join(snapshot, "value.txt"), "fixed");
  assert.equal(await verifyGateSnapshot(snapshot, source), false, "test-modified source cannot certify the original commit");
  git(repo, "restore", "value.txt");
  assert.equal(gateSourceMatches({ sourceCommit: source.commit, sourceFingerprint: source.fingerprint }, await readGateSource(repo)), true);
  // 依赖的身份取**安装声明**:装/删/升级任何一个包都会改到它,所以换一次就必须被认成「依赖变了」。
  const installed = join(repo, "node_modules", ".package-lock.json");
  writeFileSync(installed, '{"packages":{"node_modules/dep":{"version":"2.0.0"}}}');
  assert.equal(gateSourceMatches({ sourceCommit: source.commit, sourceFingerprint: source.fingerprint }, await readGateSource(repo)), false,
    "改了安装声明就是依赖变了");
  // 建快照期间源码或依赖变了必须拒绝(拿安装声明制造漂移:它才是依赖的身份)。
  await assert.rejects(createGateSnapshot(repo, join(root, "drift"), source), /已变化/);
  rmSync(installed);
  // **已知漏检面**:手改依赖目录里的文件却没重装(patch-package 打完没提交、npm link 指到本地
  // 检出、进去改一行热修),安装声明和包清单都不动,于是依赖实际变了却会沿用上一张绿结果。这是
  // 换口径换来的检测力下降,钉在这里是为了让它成为**写明的设计**而不是意外;哪天要收回这个代价,
  // 从这一条开始。注意借用之后快照跑的就是工作区那一份,所以后果不是「副本和工作区不一致」。
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "dependency v2");
  assert.equal(gateSourceMatches({ sourceCommit: source.commit, sourceFingerprint: source.fingerprint }, await readGateSource(repo)), true,
    "手改包内文件不动安装声明:已知漏检,不是 bug");
  assert.equal(gateSourceMatches({ sourceCommit: source.commit }, source), false, "legacy HEAD-only passes are stale");
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

  // 依赖目录**内部**的那些用例(软链原样重建、词法规范化不能当身份、落点闭包、中间链闭包)
  // 整片删掉了,不是放着绕:依赖改成借用之后它们的对象不存在了——快照里那是一条指向工作区的链,
  // 从快照路径读进去读到的就是工作区自己,每一条断言都会变成假绿。被删的能力分两头接住:
  //   · 软链的身份与原样重建语义在**源码树**上仍然成立,已搬进 test-accept-gate-links.ts
  //     (非 Git 源码树下的 path-syntax / literal-backslash / 冻结重定位几块);
  //   · 「快照里的命令真能跑起来」「依赖根自己是一条链」「清理不碰工作区」这些借用之后才有的
  //     契约,在 test-accept-gate-borrow.ts 里重新钉过一遍。
  // 发现 3:嵌套包的依赖目录被外层依赖目录包住时不能重复登记。借用把这条的理由换了但没取消:
  // 父目录一旦在快照里换成一条链,子路径本来就落到工作区那一份里去了,再往那个位置建第二条链
  // 毫无意义,而且 symlink 同一个目的地直接 EEXIST——整次快照在任何断言之前就废掉。
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  mkdirSync(join(repo, "vendor", "package", "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(repo, "vendor", "package", "package.json"), "{}");
  writeFileSync(join(repo, "vendor", "package", "node_modules", "cli.mjs"), 'console.log("NESTED");\n');
  linkDir(join("..", "node_modules"), join(repo, "vendor", "package", "node_modules", ".bin", "linked"));
  git(repo, "add", "vendor/package/package.json");
  git(repo, "commit", "-m", "nested manifest inside a dependency directory");
  const overlapSource = await readGateSource(repo);
  assert.equal(overlapSource.dependencies.includes(join("vendor", "package", "node_modules")), false,
    "发现3: 被外层依赖包住的目录不再单独登记");
  const overlapSnapshot = join(root, "overlap-snapshot");
  await createGateSnapshot(repo, overlapSnapshot, overlapSource);
  assert.equal(lstatSync(join(overlapSnapshot, "vendor")).isSymbolicLink(), true, "发现3: 外层那一份才是借用点");
  assert.equal(readFileSync(join(overlapSnapshot, "vendor", "package", "node_modules", "cli.mjs"), "utf8"),
    'console.log("NESTED");\n', "发现3: 去重之后,嵌套的那一份照样从快照路径读得到(穿外层那条借用链)");
  git(repo, "rm", "-q", "--cached", "vendor/package/package.json");
  git(repo, "commit", "-m", "drop nested manifest");
  rmSync(join(repo, "vendor", "package"), { recursive: true });

  const loose = join(root, "non-git");
  mkdirSync(loose);
  writeFileSync(join(loose, "source.txt"), "non-git source");
  mkdirSync(join(loose, "deep"));
  writeFileSync(join(loose, "deep", "nested.txt"), "nested");
  linkDir("deep", join(loose, "deep-link"));
  const outsideSource = join(root, "outside-source");
  mkdirSync(outsideSource);
  writeFileSync(join(outsideSource, "main.py"), "print('v1')\n");
  if (fileLinks) {
    // 发现 4:非 Git 项目里指向项目外的**源码**链接必须按源码冻结(跟随并把内容拷进快照),否则
    // 改了项目外的源码仍会沿用上次通过、测试写入还会穿到项目外。依赖目录里的外链不走这条:
    // 那里的链本身就是解释器和包入口,冻结等于把它们拍平。
    symlinkSync(join(outsideSource, "main.py"), join(loose, "main.py"));
    mkdirSync(join(loose, ".venv", "bin"), { recursive: true });
    symlinkSync(join(outsideSource, "main.py"), join(loose, ".venv", "bin", "runtime.py"));
  } else mkdirSync(join(loose, ".venv", "bin"), { recursive: true });
  // 第 2 轮发现 4:冻结一份项目外的源码**目录**时,登记、摘要和复制必须对每一个逻辑输入选同一种
  // 语义,否则来源与副本指纹必然不等、快照在什么也没改的情况下就被判「已变化」。借用把这一条的
  // 结论换了一半:那份源码目录照旧整份冻进快照,但它**里面**的依赖目录仍然按依赖对待(借用,不
  // 冻结)——依赖是产物这个判据不因为它住在哪棵树下而改变。
  const sharedDep = join(root, "shared-dependency");
  mkdirSync(join(sharedDep, "pkg"), { recursive: true });
  writeFileSync(join(sharedDep, "pkg", "index.js"), "shared dependency");
  mkdirSync(join(outsideSource, "node_modules"));
  linkDir(join(sharedDep, "pkg"), join(outsideSource, "node_modules", "pkg"));
  linkDir(outsideSource, join(loose, "src"));
  const looseSource = await readGateSource(loose);
  const looseSnapshot = join(root, "loose-snapshot");
  await createGateSnapshot(loose, looseSnapshot, looseSource);
  assert.equal(lstatSync(join(looseSnapshot, "deep-link")).isSymbolicLink(), true, "非 Git 项目的软链同样原样重建");
  assert.equal(realpathSync(join(looseSnapshot, "deep-link")), realpathSync(join(looseSnapshot, "deep")),
    "非 Git 项目里指向树内的链也必须落在副本自己那份上");
  if (fileLinks) {
    assert.equal(lstatSync(join(looseSnapshot, "main.py")).isSymbolicLink(), false,
      "发现4: 非 Git 项目的源码外链在快照里是一份冻住的真文件");
    assert.equal(readFileSync(join(looseSnapshot, "main.py"), "utf8"), "print('v1')\n");
  }
  // 非 Git 项目的依赖目录一视同仁地借用,否则这一层的收益只有 Git 项目拿得到。
  assert.deepEqual((looseSource.inputs ?? []).filter(input => input.dependency).map(input => input.path),
    [".venv", join("src", "node_modules")], "非 Git 项目:依赖目录(含冻结源码目录里的那一份)登记成借用项");
  assert.equal(lstatSync(join(looseSnapshot, ".venv")).isSymbolicLink(), true, "非 Git 项目的依赖目录同样是借用链");
  assert.equal(realpathSync(join(looseSnapshot, ".venv")), realpathSync(join(loose, ".venv")), "落在工作区那一份上");
  assert.equal(lstatSync(join(looseSnapshot, "src")).isSymbolicLink(), false,
    "第2轮发现4: 指向项目外的源码目录整份冻进副本");
  assert.equal(readFileSync(join(looseSnapshot, "src", "main.py"), "utf8"), "print('v1')\n");
  assert.equal(lstatSync(join(looseSnapshot, "src", "node_modules")).isSymbolicLink(), true,
    "第2轮发现4: 冻结的源码目录里的依赖目录仍按依赖借用,不跟着被冻进来");
  assert.equal(realpathSync(join(looseSnapshot, "src", "node_modules")), realpathSync(join(outsideSource, "node_modules")));
  assert.equal(readFileSync(join(looseSnapshot, "src", "node_modules", "pkg", "index.js"), "utf8"), "shared dependency",
    "而且从快照路径照样读得到");
  mkdirSync(join(looseSnapshot, "build"));
  writeFileSync(join(looseSnapshot, "build", "output.txt"), "generated output");
  assert.equal(await verifyGateSnapshot(looseSnapshot, looseSource), true);
  writeFileSync(join(looseSnapshot, "source.txt"), "changed by test");
  assert.equal(await verifyGateSnapshot(looseSnapshot, looseSource), false);
  assert.equal(readFileSync(join(loose, "source.txt"), "utf8"), "non-git source");
  if (fileLinks) {
    writeFileSync(join(outsideSource, "main.py"), "print('v2')\n");
    assert.notEqual((await readGateSource(loose)).fingerprint, looseSource.fingerprint,
      "发现4: 改了项目外的源码,门禁不能再沿用上次通过");
    writeFileSync(join(looseSnapshot, "main.py"), "print('test output')\n");
    assert.equal(readFileSync(join(outsideSource, "main.py"), "utf8"), "print('v2')\n",
      "发现4: 测试写快照不会穿到项目外");
  }
  const beforeGitlink = git(repo, "rev-parse", "HEAD");
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${beforeGitlink},nested-submodule`);
  git(repo, "commit", "-m", "gitlink without gitmodules");
  await assert.rejects(readGateSource(repo), /子模块/, "缺少 .gitmodules 的 gitlink 同样不能悄悄作为完整源码运行");
  git(repo, "reset", "--hard", beforeGitlink);
  // 这一条只在 POSIX 上跑:Windows 的 git 在 core.symlinks=false(克隆时探测到建软链要提权就会
  // 这么设)下把被跟踪的软链 checkout 成装着目标路径的普通文件,那道守卫根本无从触发。
  if (process.platform !== "win32") {
    symlinkSync(join(root, "non-git", "source.txt"), join(repo, "external-link"));
    git(repo, "add", "external-link");
    git(repo, "commit", "-m", "external link");
    await assert.rejects(createGateSnapshot(repo, join(root, "unsafe-link"), await readGateSource(repo)), /快照外/);
  }
  // 依赖目录被 Git 跟踪(Go 的 vendor/ 是官方推荐做法,npm 项目偶尔也提交 node_modules)。它在快
  // 照里被**故意**换成借用链,于是 `git diff HEAD` 看到一整棵「已删除」——命令跑完之后的收尾核验
  // 要认得出那是放法留下的形状,不是测试改了被测源码。不豁免的话,这类项目一次验收也过不去。
  {
    const vendored = join(root, "vendored");
    execFileSync("git", ["init", "-b", "main", vendored]);
    git(vendored, "config", "user.name", "gate");
    git(vendored, "config", "user.email", "gate@example.test");
    git(vendored, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(vendored, "go.mod"), "module example.test/app\n\ngo 1.22\n");
    mkdirSync(join(vendored, "vendor", "example.test", "dep"), { recursive: true });
    writeFileSync(join(vendored, "vendor", "modules.txt"), "# example.test/dep v1.0.0\n");
    writeFileSync(join(vendored, "vendor", "example.test", "dep", "dep.go"), "package dep\n");
    git(vendored, "add", "-A");
    git(vendored, "commit", "-m", "commit the vendor directory");

    const source = await readGateSource(vendored);
    assert.deepEqual(source.dependencies, ["vendor"], "前提:vendor 被登记成依赖目录");
    const target = join(root, "tracked-vendor");
    await createGateSnapshot(vendored, target, source);
    assert.equal(lstatSync(join(target, "vendor")).isSymbolicLink(), true, "前提:它被换成了借用链");
    assert.equal(await verifyGateSnapshot(target, source), true,
      "跟踪着的依赖目录被换成链,收尾核验不许把它判成「测试改了被测源码」");
    // 同一棵树上,源码里的改动仍然要被抓住——豁免的是依赖目录,不是「有依赖目录就整棵不查了」。
    writeFileSync(join(target, "go.mod"), "module example.test/app\n\ngo 1.23\n");
    assert.equal(await verifyGateSnapshot(target, source), false, "源码被改动仍然必须判成不干净");
  }
  // 名字不证明类型:提交一个叫 `vendor`/`target` 的**普通文件**,上一版靠 lstat 成功就把它登记成
  // 依赖目录,随后借用会把它重建成一条指向原文件的链——那份源码不再冻结,往快照这条路径写就写到了
  // 工作区。(2026-10-27 独立审查按代码推断;非 Git 分支一直有这道判断,Git 分支漏了。)
  {
    const named = join(root, "named-file");
    execFileSync("git", ["init", "-b", "main", named]);
    git(named, "config", "user.name", "gate");
    git(named, "config", "user.email", "gate@example.test");
    git(named, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(named, "package.json"), '{"name":"named-file","version":"1.0.0"}');
    writeFileSync(join(named, "vendor"), "这是一个普通文件，不是依赖目录\n");
    writeFileSync(join(named, "target"), "同上\n");
    git(named, "add", "-A");
    git(named, "commit", "-m", "commit files named like dependency directories");

    const source = await readGateSource(named);
    assert.deepEqual(source.dependencies, [], "同名的普通文件不是依赖目录,不许登记成借用项");
    const target = join(root, "named-file-snapshot");
    await createGateSnapshot(named, target, source);
    assert.equal(lstatSync(join(target, "vendor")).isSymbolicLink(), false, "它必须按源码冻进快照");
    assert.equal(readFileSync(join(target, "vendor"), "utf8"), "这是一个普通文件，不是依赖目录\n");
    // 它既然是源码,命令改了它就必须被拦住——这正是上一版会放行的那条路。
    writeFileSync(join(target, "vendor"), "被命令改掉了\n");
    assert.equal(await verifyGateSnapshot(target, source), false, "改掉它必须判成「测试改了被测源码」");
  }
  console.log("accept-gate-source: isolated commits, dirty/index/untracked rejection, borrowed dependencies, outputs non-Git identity, tracked dependency directories and files named like them passed");
} finally { rmSync(root, { recursive: true, force: true }); }
