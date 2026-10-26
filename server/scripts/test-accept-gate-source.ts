import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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
  // 发现 5:目标暂时不存在的**目录**链。stat 解析不开不等于「原链接指向文件」——按文件链重建
  // 在 Windows 上要提权,没开发者模式就整次快照失败,而它本来是免权限的 junction。
  linkDir(join(root, "missing-dependency-dir"), join(repo, "node_modules", "dangling-dir"));
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
  const danglingDir = join(linkSnapshot, "node_modules", "dangling-dir");
  assert.equal(lstatSync(danglingDir).isSymbolicLink(), true, "悬空目录链仍是链,不会拖垮整次快照");
  // 悬空链只保证「还是链 + 落点原样」。种类保不住:node 不暴露 reparse tag,Windows 上 junction、
  // 目录软链、文件软链三种悬空链的 lstat/stat/readlink 完全一致(192.168.1.187 真机实测,见
  // accept-gate-tree.ts linkTarget 上方注释),所以悬空的 junction 在开发者模式下会按文件链重建。
  assert.equal(readlinkSync(danglingDir), join(realpathSync(root), "missing-dependency-dir"),
    "发现5: 悬空链的落点必须原样保留,不能被改写或丢掉");
  if (fileLinks) {
    const bin = join(linkSnapshot, "node_modules", ".bin", "cli.mjs");
    assert.equal(lstatSync(bin).isSymbolicLink(), true, "依赖树里的软链不能被拍平成真文件");
    assert.equal(readlinkSync(bin), join("..", "pkg", "dist", "cli.mjs"), "指向树内的相对链原文照抄");
    assert.equal(execFileSync(process.execPath, [bin], { encoding: "utf8" }).trim(), "sibling",
      "① 原样重建之后,按自身 realpath 解析同胞模块的 cli 才能在快照里真跑起来");
    assert.equal(readlinkSync(join(linkSnapshot, ".venv", "alias.mjs")), "runtime.mjs");
    assert.equal(readlinkSync(join(linkSnapshot, ".venv", "runtime.mjs")), join(realpathSync(external), "runtime.mjs"),
      "② 落在树外的末端链保留绝对落点(按文件系统语义解析,不是词法拼接)");
    assert.equal(execFileSync(process.execPath, [join(linkSnapshot, ".venv", "alias.mjs")], { encoding: "utf8" }).trim(),
      "external runtime", "② 多级链逐级重建后整条仍可执行");
    assert.equal(readlinkSync(join(linkSnapshot, "node_modules", "absolute.mjs")),
      join(linkSnapshot, "node_modules", "pkg", "dist", "sibling.mjs"), "指向树内的绝对链改写到副本自己那份");
    assert.equal(lstatSync(join(linkSnapshot, "node_modules", "dangling")).isSymbolicLink(), true);
    assert.equal(existsSync(join(linkSnapshot, "node_modules", "dangling")), false, "③ 悬空链原样保留,且不崩掉整次快照");
  }

  // 发现 1:链接身份不能用词法规范化证明。中间段是目录软链时,「先跟随链接再解释 ..」与「先消掉
  // ..」落在两个不同的文件上,于是 path.resolve 会把两条行为不同的链算成同一个身份(换了实际执行
  // 的脚本仍沿用上次通过),也会把树外链的重定位指到另一个文件上。
  rmSync(join(repo, "node_modules"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "store", "deep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "entry.mjs"), 'console.log("SIBLING");\n');
  writeFileSync(join(repo, "node_modules", "store", "entry.mjs"), 'console.log("THROUGH-BRIDGE");\n');
  linkDir(join("store", "deep"), join(repo, "node_modules", "bridge"));
  // 这一段只在 POSIX 上跑:Win32 的路径解析器在碰文件系统之前就把 `..` 词法消掉了(这正是
  // `\\?\` 前缀存在的理由),所以那边两条链真的落在同一个文件上,摘要相同是对的。本模块把落点
  // 交给 realpath 判,于是两种平台各自拿到自己那套语义,不必分叉。
  if (fileLinks && process.platform !== "win32") {
    const cli = join(repo, "node_modules", "cli.mjs");
    symlinkSync(["bridge", "..", "entry.mjs"].join(sep), cli);
    const throughBridge = await readGateSource(repo);
    // 用 readFileSync 走真正的 open 系统调用:node 的模块加载器会先把 `..` 词法消掉,
    // 拿它当探针会把这条缺陷掩盖过去。
    assert.equal(readFileSync(cli, "utf8").includes("THROUGH-BRIDGE"), true);
    unlinkSync(cli);
    symlinkSync("entry.mjs", cli);
    const direct = await readGateSource(repo);
    assert.equal(readFileSync(cli, "utf8").includes("SIBLING"), true);
    assert.notEqual(direct.fingerprint, throughBridge.fingerprint, "发现1: 落点不同的两条链不能算出同一个身份");
    assert.equal(gateSourceMatches({ sourceCommit: throughBridge.commit, sourceFingerprint: throughBridge.fingerprint }, direct),
      false, "发现1: 换掉实际执行的脚本之后不能再沿用上次通过");
    unlinkSync(cli);
    symlinkSync(["bridge", "..", "entry.mjs"].join(sep), cli);
    // 树外链 + 经过目录链的 ..:词法消 .. 会落在 <root>/right.mjs(WRONG),真正的落点是
    // <outside>/right.mjs(RIGHT)。副本必须读出和源树一样的内容。
    const outside = join(root, "outside");
    mkdirSync(join(outside, "deep"), { recursive: true });
    writeFileSync(join(root, "right.mjs"), "WRONG\n");
    writeFileSync(join(outside, "right.mjs"), "RIGHT\n");
    linkDir(join(outside, "deep"), join(root, "bridge"));
    const escape = join(repo, "node_modules", "escape.mjs");
    symlinkSync(["..", "..", "bridge", "..", "right.mjs"].join(sep), escape);
    const escapeSource = await readGateSource(repo);
    const escapeSnapshot = join(root, "escape-snapshot");
    await createGateSnapshot(repo, escapeSnapshot, escapeSource);
    assert.equal(readFileSync(escape, "utf8").trim(), "RIGHT");
    assert.equal(readFileSync(join(escapeSnapshot, "node_modules", "escape.mjs"), "utf8").trim(), "RIGHT",
      "发现1: 树外链的重定位必须落在真正的目标上,不能被词法规范化改写到另一个文件");
    assert.equal((await readGateSource(escapeSnapshot)).fingerprint, escapeSource.fingerprint);
  }

  // 发现 2:「落点在项目目录之下」不等于「这份内容会出现在快照里」。项目把依赖装在别处再软链
  // 过来时,落点既没被 Git 跟踪也不在任何登记的依赖里,照抄链接只会在快照里留一条断链,命令当场
  // 不存在;落点内容变了也看不见。所以要按落点求闭包,把缺的落点补登记成输入。
  rmSync(join(repo, "node_modules"), { recursive: true });
  mkdirSync(join(repo, ".local-deps", "pkg"), { recursive: true });
  writeFileSync(join(repo, ".local-deps", "pkg", "cli.mjs"), 'console.log("INSTALLED");\n');
  linkDir(".local-deps", join(repo, "node_modules"));
  const closureSource = await readGateSource(repo);
  assert.equal(closureSource.dependencies.includes(".local-deps"), true, "发现2: 链接落点要补登记成快照输入");
  const closureSnapshot = join(root, "closure-snapshot");
  await createGateSnapshot(repo, closureSnapshot, closureSource);
  assert.equal(lstatSync(join(closureSnapshot, "node_modules")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(closureSnapshot, "node_modules", "pkg", "cli.mjs"), "utf8"), 'console.log("INSTALLED");\n',
    "发现2: 项目内装在别处的依赖必须跟着进快照,否则快照里只有一条断链");
  assert.equal((await readGateSource(closureSnapshot)).fingerprint, closureSource.fingerprint,
    "补登记的落点在源树与拷贝树上要算出同一个摘要");
  writeFileSync(join(repo, ".local-deps", "pkg", "cli.mjs"), 'console.log("CHANGED");\n');
  assert.equal(gateSourceMatches({ sourceCommit: closureSource.commit, sourceFingerprint: closureSource.fingerprint },
    await readGateSource(repo)), false, "发现2: 落点内容变了不能再沿用上次通过");
  writeFileSync(join(closureSnapshot, "node_modules", "pkg", "cli.mjs"), "test output");
  assert.equal(readFileSync(join(repo, ".local-deps", "pkg", "cli.mjs"), "utf8"), 'console.log("CHANGED");\n',
    "发现2: 补登记的落点同样是冻住的,测试写快照碰不到活动工作区");

  // 发现 3:嵌套包的依赖目录已经被外层依赖整棵拷过一遍,再单独拷一遍会在同一路径上第二次
  // symlink → EEXIST,整次快照在任何断言之前就废掉(软链重建不像 copyFile 那样幂等)。
  rmSync(join(repo, "node_modules"), { recursive: true });
  rmSync(join(repo, ".local-deps"), { recursive: true });
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
  assert.equal(readFileSync(join(overlapSnapshot, "vendor", "package", "node_modules", "cli.mjs"), "utf8"),
    'console.log("NESTED");\n', "发现3: 重叠输入去重之后,嵌套依赖照样完整进快照");
  assert.equal(lstatSync(join(overlapSnapshot, "vendor", "package", "node_modules", ".bin", "linked")).isSymbolicLink(), true);
  git(repo, "rm", "-q", "--cached", "vendor/package/package.json");
  git(repo, "commit", "-m", "drop nested manifest");
  rmSync(join(repo, "vendor", "package"), { recursive: true });

  // 第 2 轮发现 1:realpath 失败之后**不能**退回 path.resolve 的词法结果——那正是上面整段否掉
  // 的判据。词法归一会把「原本能跑的链」和「改成跑不了的链」算成同一个身份,于是一条已经 ENOENT
  // 的命令照样沿用上次通过。未解析的链只能以原文为身份,而且不算树内输入(不知道落在哪,也没有
  // 内容可冻)。
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "entry.mjs"), 'console.log("WORKS");\n');
  if (fileLinks) {
    const cli = join(repo, "node_modules", "cli.mjs");
    symlinkSync("entry.mjs", cli);
    const working = await readGateSource(repo);
    unlinkSync(cli);
    // 中间整段都不存在:两个平台都解析不出落点。
    symlinkSync(join("missing-dir", "entry.mjs"), cli);
    const unresolved = await readGateSource(repo);
    assert.notEqual(working.fingerprint, unresolved.fingerprint, "第2轮发现1: 解析不到的链不能和解析得到的链同一身份");
    assert.equal(gateSourceMatches({ sourceCommit: working.commit, sourceFingerprint: working.fingerprint }, unresolved),
      false, "第2轮发现1: 命令已经坏掉,不能沿用上次通过");
    const unresolvedSnapshot = join(root, "unresolved-snapshot");
    await createGateSnapshot(repo, unresolvedSnapshot, unresolved);
    assert.equal(readlinkSync(join(unresolvedSnapshot, "node_modules", "cli.mjs")), join("missing-dir", "entry.mjs"),
      "第2轮发现1: 解析不到的链按原文照抄重建,不猜它该指哪");
    unlinkSync(cli);
    // `..` 那种写法只在 POSIX 上是坏链:Win32 的路径解析器先按字面消掉 `..`,那边它真的能读到
    // 同级 entry.mjs,摘要跟着解析结果走才是对的。
    if (process.platform !== "win32") {
      symlinkSync(["missing-dir", "..", "entry.mjs"].join(sep), cli);
      assert.throws(() => readFileSync(cli), { code: "ENOENT" }, "POSIX 下中间段不存在就真的读不到");
      assert.notEqual((await readGateSource(repo)).fingerprint, working.fingerprint,
        "第2轮发现1: 词法消掉 .. 之后看着一样的链,身份必须不同");
      unlinkSync(cli);
    }
  }

  // 第 2 轮发现 2A:「Git 跟踪着这个**目录**」不等于「它的内容都会出现在快照里」。被忽略的安装
  // 内容 Git 根本不会检出,副本里命令照样不存在,改了它指纹也纹丝不动。覆盖只能由复制计划证明。
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules\nignored.env\n.store/cache/\nbridge\n.actual/\n.cache/\n");
  mkdirSync(join(repo, ".store"));
  writeFileSync(join(repo, ".store", "README.md"), "tracked manifest");
  git(repo, "add", ".gitignore", ".store/README.md");
  git(repo, "commit", "-m", "tracked manifest with an ignored install payload");
  mkdirSync(join(repo, ".store", "cache"));
  writeFileSync(join(repo, ".store", "cache", "cli.mjs"), 'console.log("INSTALLED");\n');
  linkDir(".store", join(repo, "node_modules"));
  const payloadSource = await readGateSource(repo);
  assert.equal(payloadSource.dependencies.includes(join(".store", "cache")), true,
    "第2轮发现2A: 跟踪目录里被忽略的那部分要补登记成输入");
  const payloadSnapshot = join(root, "payload-snapshot");
  await createGateSnapshot(repo, payloadSnapshot, payloadSource);
  assert.equal(readFileSync(join(payloadSnapshot, "node_modules", "cache", "cli.mjs"), "utf8"), 'console.log("INSTALLED");\n',
    "第2轮发现2A: 被忽略的安装内容必须跟着进快照,否则副本里命令不存在");
  assert.equal(readFileSync(join(payloadSnapshot, ".store", "README.md"), "utf8"), "tracked manifest",
    "跟踪的那部分仍然由 Git 检出提供");
  writeFileSync(join(repo, ".store", "cache", "cli.mjs"), 'console.log("CHANGED");\n');
  assert.equal(gateSourceMatches({ sourceCommit: payloadSource.commit, sourceFingerprint: payloadSource.fingerprint },
    await readGateSource(repo)), false, "第2轮发现2A: 改了安装内容不能再沿用上次通过");

  // 第 2 轮发现 2B:原样保留的相对链在副本里还需要**原文路上的中间链**。只把最终落点拷进来,
  // 副本里的 ../bridge/cli.mjs 依然断在中途(borrow 式本地安装布局就是这个形状)。
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  if (fileLinks) {
    mkdirSync(join(repo, "node_modules"));
    mkdirSync(join(repo, ".actual"));
    writeFileSync(join(repo, ".actual", "cli.mjs"), 'console.log("BORROWED");\n');
    linkDir(".actual", join(repo, "bridge"));
    symlinkSync(join("..", "bridge", "cli.mjs"), join(repo, "node_modules", "cli.mjs"));
    const routeSource = await readGateSource(repo);
    assert.equal(routeSource.dependencies.includes("bridge"), true, "第2轮发现2B: 原文路上的中间链要一起冻结");
    const routeSnapshot = join(root, "route-snapshot");
    await createGateSnapshot(repo, routeSnapshot, routeSource);
    assert.equal(readFileSync(join(routeSnapshot, "node_modules", "cli.mjs"), "utf8"), 'console.log("BORROWED");\n',
      "第2轮发现2B: 副本里这条命令必须解析得到");
    assert.equal(realpathSync(join(routeSnapshot, "node_modules", "cli.mjs")), realpathSync(join(routeSnapshot, ".actual", "cli.mjs")),
      "第2轮发现2B: 而且要落在副本自己那份上");
    rmSync(join(repo, "bridge"));
    rmSync(join(repo, ".actual"), { recursive: true });
  }

  // 第 2 轮发现 3:消重必须在**最终**复制计划上成立。闭包先补进来一个子路径、随后补进来它的
  // 父目录时,第二遍 symlink 同一个目的地直接 EEXIST,整次快照在任何断言之前就废掉。
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
  rmSync(join(repo, ".venv"), { recursive: true, force: true });
  mkdirSync(join(repo, "node_modules"));
  mkdirSync(join(repo, ".venv"));
  mkdirSync(join(repo, ".cache", "sub"), { recursive: true });
  mkdirSync(join(repo, ".cache", "real"));
  writeFileSync(join(repo, ".cache", "real", "payload.txt"), "payload");
  linkDir(join("..", "real"), join(repo, ".cache", "sub", "tool"));
  linkDir(join("..", ".cache", "sub", "tool"), join(repo, "node_modules", "a"));
  linkDir(join("..", ".cache"), join(repo, ".venv", "payload"));
  const closureOverlap = await readGateSource(repo);
  assert.equal(closureOverlap.dependencies.includes(".cache"), true, "第2轮发现3: 父目录进了计划");
  assert.equal(closureOverlap.dependencies.includes(join(".cache", "sub", "tool")), false,
    "第2轮发现3: 被父目录包住的子路径不能同时留在计划里(软链重建不是幂等的)");
  const closureOverlapSnapshot = join(root, "closure-overlap-snapshot");
  await createGateSnapshot(repo, closureOverlapSnapshot, closureOverlap);
  assert.equal(readFileSync(join(closureOverlapSnapshot, "node_modules", "a", "payload.txt"), "utf8"), "payload",
    "第2轮发现3: 去重之后两条链在副本里都解析得到");
  assert.equal(existsSync(join(closureOverlapSnapshot, ".venv", "payload", "sub", "tool", "payload.txt")), true);
  rmSync(join(repo, ".venv", "payload"));
  rmSync(join(repo, ".cache"), { recursive: true });

  // 依赖根自己就是软链(worktree 借主仓 node_modules 的形状):相对原文照抄会因为快照与项目目录
  // 深度不同而指错地方,所以改写成绝对落点。
  rmSync(join(repo, "node_modules"), { recursive: true, force: true });
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
  }
  // 第 2 轮发现 4:冻结一份项目外的源码**目录**时,它里面的依赖链不能被顺手拍平——登记、摘要和
  // 复制必须对每一个逻辑输入选同一种语义。否则顶层一致、子项被拍平,副本重新登记得到的是真目录
  // 而不是同一条叶子链,来源与副本指纹必然不等,快照在什么也没改的情况下就被判「已变化」。
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
    assert.equal(lstatSync(join(looseSnapshot, ".venv", "bin", "runtime.py")).isSymbolicLink(), true,
      "依赖目录内的外链仍按依赖策略原样保留");
  }
  assert.equal(lstatSync(join(looseSnapshot, "src")).isSymbolicLink(), false,
    "第2轮发现4: 指向项目外的源码目录整份冻进副本");
  assert.equal(readFileSync(join(looseSnapshot, "src", "main.py"), "utf8"), "print('v1')\n");
  assert.equal(lstatSync(join(looseSnapshot, "src", "node_modules", "pkg")).isSymbolicLink(), true,
    "第2轮发现4: 冻结的源码目录里的依赖链仍按链保留,不能因为递归入口不同就被拍平");
  assert.equal(readFileSync(join(looseSnapshot, "src", "node_modules", "pkg", "index.js"), "utf8"), "shared dependency");
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
  // ── 第 3 轮审查的 4 条。各用独立的小仓:它们要自带 .gitignore 和提交历史,挤进上面那个共用
  // repo 会互相污染(根落点那一条会把共用 repo 里**全部**被忽略的条目都拉进复制计划)。
  const freshRepo = (name: string, ignore: string) => {
    const cwd = join(root, name);
    mkdirSync(cwd);
    execFileSync("git", ["init", "-b", "main", cwd]);
    git(cwd, "config", "user.name", "Gate Source Test");
    git(cwd, "config", "user.email", "source@example.test");
    writeFileSync(join(cwd, ".gitignore"), ignore);
    writeFileSync(join(cwd, "package.json"), "{}");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-m", `${name} fixture`);
    return cwd;
  };

  // 第 3 轮发现 1A:落点正好是项目根(node_modules/<自己> -> .. 这种自链)。检出只覆盖**被跟踪的**
  // 那部分,根下面被忽略的安装内容在工作区里经这条链读得到、副本里却没有,而且改了它指纹纹丝不动
  // ——上一张绿结果会被直接复用。所以根落点与「落点是被跟踪的目录」走同一条路:补齐它下面被忽略
  // 的条目。代价是自链会把根下**全部**被忽略的内容(连 ignored.env)带进快照:自链本来就把整个项目
  // 暴露给了测试,要么这样忠实冻住,要么留一份测试读得到、指纹盖不住的内容——后者正是本条要修的。
  const rootLink = freshRepo("root-link", "node_modules/\n.cache/\nignored.env\n");
  mkdirSync(join(rootLink, "node_modules"));
  mkdirSync(join(rootLink, ".cache"));
  writeFileSync(join(rootLink, ".cache", "tool.txt"), "v1");
  writeFileSync(join(rootLink, "ignored.env"), "exposed by the self link");
  linkDir("..", join(rootLink, "node_modules", "project"));
  const rootSource = await readGateSource(rootLink);
  assert.deepEqual(rootSource.dependencies, [".cache", "ignored.env", "node_modules"],
    "第3轮发现1A: 根落点下被忽略的内容要补登记成输入,不能当成「检出已经覆盖」跳过");
  const rootSnapshot = join(root, "root-link-snapshot");
  await createGateSnapshot(rootLink, rootSnapshot, rootSource);
  assert.equal(lstatSync(join(rootSnapshot, "node_modules", "project")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(rootSnapshot, "node_modules", "project", ".cache", "tool.txt"), "utf8"), "v1",
    "第3轮发现1A: 工作区经这条链读得到的内容,副本里也要读得到");
  writeFileSync(join(rootLink, ".cache", "tool.txt"), "v2");
  const rootChanged = await readGateSource(rootLink);
  assert.equal(gateSourceMatches({ sourceCommit: rootSource.commit, sourceFingerprint: rootSource.fingerprint }, rootChanged),
    false, "第3轮发现1A: 改了这份内容不能再沿用上次通过");

  // 第 3 轮发现 1B:没装的可选依赖(node_modules/optional -> ../.cache/not-installed:父目录在、
  // 叶子不在)。node_modules 里的断链是常态,它绝不能把整次快照判成「没能按原样复现」。两侧身份
  // 靠「已解析前缀 + 余下原文」对齐:源侧解析到 .cache,副侧(计划里没有它、也没什么可拷)只解析到
  // 快照根,拼出来仍是同一个 .cache/not-installed。
  const danglingRepo = freshRepo("dangling-parent", "node_modules/\n.cache/\n");
  mkdirSync(join(danglingRepo, "node_modules"));
  mkdirSync(join(danglingRepo, ".cache"));
  writeFileSync(join(danglingRepo, ".cache", "installed.txt"), "installed");
  if (fileLinks) {
    symlinkSync(join("..", ".cache", "not-installed"), join(danglingRepo, "node_modules", "optional"));
    const danglingSource = await readGateSource(danglingRepo);
    assert.equal(danglingSource.dependencies.includes(join(".cache", "not-installed")), false,
      "第3轮发现1B: 不存在的落点没有内容可冻,不该留在复制计划里");
    const danglingSnapshot = join(root, "dangling-snapshot");
    await createGateSnapshot(danglingRepo, danglingSnapshot, danglingSource);
    assert.equal(lstatSync(join(danglingSnapshot, "node_modules", "optional")).isSymbolicLink(), true,
      "第3轮发现1B: 无害的悬空可选依赖不能拖垮整次快照");
    assert.equal(existsSync(join(danglingSnapshot, "node_modules", "optional")), false, "而且在副本里照旧是断的");
  }

  // 第 3 轮发现 2:被提交的 vendor 软链。Git 检出已经把它写到目的地了,依赖目录的复制再写一遍
  // 同一个目的地就是 EEXIST——两个写入方撞在一起,与计划内部的重叠无关,所以靠计划去重拦不住。
  // 目的地已经是同一条链就复用,是别的东西才换掉(不能无条件忽略 EEXIST)。
  // 只在 POSIX 上跑:Windows 的 git 在 core.symlinks=false 下把被跟踪的软链检出成装着目标路径的
  // 普通文件,两个写入方从一开始就不会撞上。
  if (process.platform !== "win32") {
    const vendored = freshRepo("tracked-vendor", "node_modules/\n");
    mkdirSync(join(vendored, "vendor", "pkg"), { recursive: true });
    writeFileSync(join(vendored, "vendor", "pkg", "payload.txt"), "vendored source");
    symlinkSync("payload.txt", join(vendored, "vendor", "pkg", "alias.txt"));
    git(vendored, "add", "vendor");
    git(vendored, "commit", "-m", "tracked vendored symlink");
    const vendorSource = await readGateSource(vendored);
    const vendorSnapshot = join(root, "tracked-vendor-snapshot");
    await createGateSnapshot(vendored, vendorSnapshot, vendorSource);
    assert.equal(lstatSync(join(vendorSnapshot, "vendor", "pkg", "alias.txt")).isSymbolicLink(), true,
      "第3轮发现2: 被检出过的目的地要复用,而且仍然是链");
    assert.equal(readFileSync(join(vendorSnapshot, "vendor", "pkg", "alias.txt"), "utf8"), "vendored source");
  }

  // 第 3 轮发现 3:按源码冻结的外部目录会被**搬迁**到快照里的另一个位置,它里面指回项目内的相对
  // 链不能再照抄原文——原文会从新位置重新解析,落到另一个路径上(external/back.py ->
  // ../loose/inside/data.py 冻进 <快照>/src 之后,原文落到 <快照>/loose/inside/data.py,而副本里
  // 那份其实在 <快照>/inside/data.py),于是什么也没改的快照被判「没能按原样复现」。
  if (fileLinks) {
    const frozen = join(root, "frozen-context");
    const frozenExternal = join(root, "frozen-external");
    mkdirSync(join(frozen, "inside"), { recursive: true });
    mkdirSync(frozenExternal);
    writeFileSync(join(frozen, "inside", "data.py"), "print('works')\n");
    symlinkSync(join("..", "frozen-context", "inside", "data.py"), join(frozenExternal, "back.py"));
    linkDir(frozenExternal, join(frozen, "src"));
    const frozenSource = await readGateSource(frozen);
    const frozenSnapshot = join(root, "frozen-context-snapshot");
    await createGateSnapshot(frozen, frozenSnapshot, frozenSource);
    assert.equal(lstatSync(join(frozenSnapshot, "src", "back.py")).isSymbolicLink(), true,
      "第3轮发现3: 冻结目录里的链仍按链保留");
    assert.equal(readFileSync(join(frozenSnapshot, "src", "back.py"), "utf8"), "print('works')\n",
      "第3轮发现3: 搬迁之后那条相对链要按副本里的实际落点重定位");
    assert.equal(realpathSync(join(frozenSnapshot, "src", "back.py")), realpathSync(join(frozenSnapshot, "inside", "data.py")),
      "第3轮发现3: 而且落在副本自己那份上,不能被拉回活动工作区");
  }

  // 第 3 轮发现 4:闭包规模的预算要卡在**消重之后**,而且只计真正追加进来的条目。拿计划总长去卡
  // 会把初始输入的规模误判成成环:登记的依赖目录本身就超过上限时,第一条**已被覆盖**的树内链就会
  // 报「落点过多…是否成环」,而那一条一个条目都没加。
  const wide = freshRepo("wide-plan", "node_modules/\n.venv/\nvendor/\ntarget/\n");
  for (let index = 0; index < 130; index += 1) {
    const pkg = join(wide, `pkg-${index}`);
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), "{}");
    for (const dependency of ["node_modules", ".venv", "vendor", "target"]) mkdirSync(join(pkg, dependency));
    writeFileSync(join(pkg, "node_modules", "dep.txt"), `dep ${index}`);
  }
  git(wide, "add", "-A");
  git(wide, "commit", "-m", "many package directories");
  mkdirSync(join(wide, "node_modules"));
  linkDir(join("..", "pkg-0", "node_modules"), join(wide, "node_modules", "covered"));
  const wideSource = await readGateSource(wide);
  assert.equal(wideSource.dependencies.length > 512, true, "第3轮发现4: 这个夹具的初始输入本身就超过上限");
  assert.equal(wideSource.dependencies.includes(join("pkg-0", "node_modules")), true,
    "第3轮发现4: 已被覆盖的落点不该让规模预算报错");

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
  console.log("accept-gate-source: isolated commits, dirty/index/untracked rejection, dependencies, symlinks, outputs and non-Git identity passed");
} finally { rmSync(root, { recursive: true, force: true }); }
