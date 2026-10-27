import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// 这一份专收「各用一个独立小仓」的链接/输入计划用例 —— 它们要自带 .gitignore、提交历史,甚至自带
// 一个装在项目内部的运行目录,挤进 test-accept-gate-source.ts 那个共用 repo 会互相污染(根落点那条
// 会把共用 repo 里全部被忽略的条目都拉进复制计划)。共用 fixture 的那批仍在那边。
const root = mkdtempSync(join(tmpdir(), "ash-gate-links-"));
// 运行目录故意放进 runtime-filter 夹具仓库内部:「源侧过滤、副本回算不过滤」只有在「ash 的 runs
// 目录就在项目里」时才复现,而 RUNS_DIR 在模块 import 时就定下来了。其它夹具仓库都不包含它,排除
// 计划对它们是空的。
process.env.ASH_RUNS_DIR = join(root, "runtime-filter", "data", "runs");
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
if (!fileLinks) console.log("accept-gate-links: 本机建不出文件软链(Windows 未开开发者模式),文件链用例跳过,目录 junction 用例仍跑");
// 链接身份与重定位必须忠实于**本平台真实的文件访问**,不能由本模块自己解释路径语法(自己切分、
// 逐段 realpath 都会和运行时打开的那个文件分叉,三处实测见 accept-gate-tree.ts linkLanding 上方)。
// 多处用例钉的都是同一个不变量:**原生读到的结果相等 ⟺ 指纹相等**;读失败也算一种结果,所以错误
// 码一并比,但不钉具体是哪个码(平台不同)。
const reads = (path: string) => {
  try { return readFileSync(path, "utf8"); }
  catch (error) { return `ERR:${(error as NodeJS.ErrnoException).code}`; }
};
try {
  const { createGateSnapshot, gateSourceMatches, readGateSource, verifyGateSnapshot } = await import("../src/accept-gate-source.js");
  // ── 用独立的小仓:要自带 .gitignore 和提交历史,挤进别的夹具会互相污染。
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
    symlinkSync(join("..", "frozen-nowhere", "gone.py"), join(frozenExternal, "missing.py"));
    linkDir(frozenExternal, join(frozen, "src"));
    const frozenSource = await readGateSource(frozen);
    const frozenSnapshot = join(root, "frozen-context-snapshot");
    await createGateSnapshot(frozen, frozenSnapshot, frozenSource);
    assert.equal(lstatSync(join(frozenSnapshot, "src", "back.py")).isSymbolicLink(), true,
      "第3轮发现3: 冻结目录里的链仍按链保留");
    // 两个平台一句话钉死:副本里读到什么,必须和源树里读到什么一样。POSIX 上 `..` 穿过那条目录链
    // 落回项目里,源树读得通,于是这一句要求副本重定位到自己那份(不重定位就会读到别的或读不到);
    // Win32 的解析器在碰文件系统前就按字面消掉 `..`,src\..\ 折回项目自己而不是外部目录的父目录,
    // 源树里这条链原生就读不到(真机实测 ERR:ENOENT),于是这一句要求副本照抄原文、同样读不到——
    // 把它改写成一条能读通的路径,交付的副本就和工作区不是同一份行为了。
    assert.equal(reads(join(frozenSnapshot, "src", "back.py")), reads(join(frozen, "src", "back.py")),
      "第3轮发现3: 搬迁之后那条相对链在副本里要和源树读到同一个结果");
    if (reads(join(frozen, "src", "back.py")) === "print('works')\n") {
      assert.equal(realpathSync(join(frozenSnapshot, "src", "back.py")), realpathSync(join(frozenSnapshot, "inside", "data.py")),
        "第3轮发现3: 而且落在副本自己那份上,不能被拉回活动工作区");
    }
    // 第 4 轮:被搬迁的子树里再放一条**两侧都读不到**的链,然后端到端对一次账——副本自己重新登记、
    // 重新摘要之后必须和源树同身份。Win32 上这个夹具里**每一条**链都落到「读不到」那一支(`..` 被
    // 词法消解),macOS 上靠这条悬空链覆盖同一支;读不到的链身份只认原文,原文被改写或位置被掺进
    // 身份都会让什么也没改的快照判不符。
    assert.equal(await verifyGateSnapshot(frozenSnapshot, frozenSource), true,
      "第4轮: 搬迁进来的读不到的链,源树与副本必须算出同一个身份");
  }

  // 第 2 轮审查发现 1:链接身份与重定位必须忠实于本平台真实的文件访问(不变量和三处实测见文件
  // 顶部 reads 上方)。
  // 夹具用**非 Git 项目的源码树**:依赖目录(node_modules/.venv/vendor/target)现在整体借用、不再
  // 逐条遍历,所以链的身份只在源码树这一侧还有判据。原来这几块建在 node_modules 下,照搬过来一条
  // 都测不到东西。
  if (fileLinks) {
    const syntax = join(root, "path-syntax");
    mkdirSync(join(syntax, "lib", "store", "deep"), { recursive: true });
    const syntaxEntry = join(syntax, "lib", "entry.mjs");
    const syntaxCli = join(syntax, "lib", "cli.mjs");
    writeFileSync(syntaxEntry, "SIBLING");
    writeFileSync(join(syntax, "lib", "store", "entry.mjs"), "THROUGH-STORE");
    symlinkSync("entry.mjs", syntaxCli);
    const readable = await readGateSource(syntax);
    assert.equal(reads(syntaxCli), "SIBLING");
    // 末尾的 `/`、`/.` 是有语义的成分,不能当噪声滤掉:自己切分时把空段和 `.` 滤掉,三条写法不同
    // 的链就摘出同一个身份,上一张绿结果被直接复用。**哪一种写法读得通由平台说**:POSIX 上
    // entry.mjs/ 与 entry.mjs/. 都是 ENOTDIR;Win32 真机实测(2026-10-26)落盘成 entry.mjs\ 是
    // ENOENT、entry.mjs\. 照样读到那个文件。所以按设计分两种钉法,两个平台都成立:
    //  · 读得通的链身份认**落点**,读到同一个文件就必须同身份(Win32 上 entry.mjs\. 走这一支);
    //  · 读不通的链身份认**原文**,原文不同必须不同身份,否则「改成另一种读不通的写法」会沿用
    //    上一张绿结果。
    const identities = new Map<string, string>([[`content:${reads(syntaxCli)}`, readable.fingerprint]]);
    const expectIdentity = (raw: string, content: string, fingerprint: string) => {
      const key = content.startsWith("ERR:") ? `raw:${raw}` : `content:${content}`;
      const prior = identities.get(key);
      if (prior !== undefined) {
        assert.equal(fingerprint, prior, `第2轮发现1: ${key} 和之前那条读到的是一回事,身份必须相同`);
        return;
      }
      for (const [other, fingerprinted] of identities) {
        assert.notEqual(fingerprint, fingerprinted, `第2轮发现1: ${key} 与 ${other} 不是一回事,身份不能相同`);
      }
      identities.set(key, fingerprint);
    };
    for (const target of ["entry.mjs/", "entry.mjs/."]) {
      unlinkSync(syntaxCli);
      symlinkSync(target, syntaxCli);
      const content = reads(syntaxCli);
      const broken = await readGateSource(syntax);
      if (content.startsWith("ERR:")) {
        assert.equal(gateSourceMatches({ sourceCommit: readable.commit, sourceFingerprint: readable.fingerprint, sourceAmbient: readable.ambient }, broken),
          false, `第2轮发现1: 改成读不通的 ${target} 之后不能再沿用上次通过`);
      }
      expectIdentity(readlinkSync(syntaxCli), content, broken.fingerprint);
    }
    // 相对原文 + 末尾 `/`:Win32 真机实测(2026-10-26)它落盘成 entry.mjs\、stat 是 ENOENT,而**绝对**
    // 原文那一种反而在创建时就被平台去掉了尾分隔符,所以只有相对这一种钉得住「不许替链规范化
    // 原文」。期望值一律取磁盘上那条链的原文(readlink),不写我们自己拼的字符串——拼出来的那个
    // 又是一个平台假设(`/` 在 Win32 上会落盘成 `\`)。
    unlinkSync(syntaxCli);
    symlinkSync("entry.mjs/", syntaxCli);
    const trailing = await readGateSource(syntax);
    const trailingSnapshot = join(root, "path-syntax-trailing-snapshot");
    await createGateSnapshot(syntax, trailingSnapshot, trailing);
    const trailingCopy = join(trailingSnapshot, "lib", "cli.mjs");
    assert.equal(readlinkSync(trailingCopy), readlinkSync(syntaxCli),
      "第2轮发现1: 副本里的原文要和磁盘上那条逐字一致,尾部分隔符不许替它规范化");
    assert.equal(reads(trailingCopy), reads(syntaxCli),
      "第2轮发现1: 副本读到的必须和源树一样(Win32 上 ENOENT、POSIX 上 ENOTDIR)");
    // 绝对原文 + 末尾 `/`:副本读到的必须和源树读到的一样。POSIX 上源树是 ENOTDIR,副本就不许
    // 读得到——重写掉那个 `/` 等于交付了一份与工作区行为相反的快照(实测过:源树 ENOTDIR、副本
    // 读得通),所以读不到的链一律逐字照抄;Win32 上这条原文原生读得通、落点又在树内,于是它该被
    // 改写到副本自己那份,照抄绝对原文反而会把测试拉回活动工作区。两边都由「读到什么」决定。
    unlinkSync(syntaxCli);
    symlinkSync(`${syntaxEntry}/`, syntaxCli);
    const absoluteBroken = await readGateSource(syntax);
    const syntaxSnapshot = join(root, "path-syntax-snapshot");
    await createGateSnapshot(syntax, syntaxSnapshot, absoluteBroken);
    const syntaxCopy = join(syntaxSnapshot, "lib", "cli.mjs");
    if (reads(syntaxCli).startsWith("ERR:")) {
      assert.equal(readlinkSync(syntaxCopy), readlinkSync(syntaxCli), "第2轮发现1: 读不到的链逐字照抄,末尾那个分隔符也不动");
    } else {
      assert.equal(readlinkSync(syntaxCopy).startsWith(syntaxSnapshot), true,
        "第2轮发现1: 读得通的绝对原文要改写到副本自己那份,不能把测试拉回活动工作区");
    }
    assert.equal(reads(syntaxCopy), reads(syntaxCli),
      "第2轮发现1: 副本必须读出和源树一样的结果(包括一样的失败)");
    // Win32 的路径解析器在碰文件系统之前就按字面消 `..`:bridge 是指向 store/deep 的 junction 时,
    // bridge/../entry.mjs 原生读到的是**同级** entry.mjs(192.168.1.187 真机实测);POSIX 下同一条链
    // 穿过 junction 读到 store/entry.mjs。两个平台各自正确,所以钉不变量而不是钉某一边的落点。
    linkDir(join("store", "deep"), join(syntax, "lib", "bridge"));
    unlinkSync(syntaxCli);
    symlinkSync("bridge/../entry.mjs", syntaxCli);
    const viaBridge = { content: reads(syntaxCli), gate: await readGateSource(syntax) };
    unlinkSync(syntaxCli);
    symlinkSync("store/entry.mjs", syntaxCli);
    const viaStore = { content: reads(syntaxCli), gate: await readGateSource(syntax) };
    assert.equal(viaBridge.gate.fingerprint === viaStore.gate.fingerprint, viaBridge.content === viaStore.content,
      "第2轮发现1: 身份必须跟着本平台真实读到的内容走(Win32 按字面消 .. 读同级, POSIX 穿过链读 store)");
  }

  // 第 2 轮发现 1 的另一侧:POSIX 上的 `\` 是**普通字符**,literal\file.txt 和 literal/file.txt 是
  // 两个不同的文件。拿 `\` 当分隔符会让它们同身份:切了链接、原生内容从 LITERAL 变成 NESTED,指纹
  // 却纹丝不动。Windows 上 `\` 真的是分隔符,这个夹具在那边不成立,所以只在 POSIX 跑。
  if (fileLinks && process.platform !== "win32") {
    const literal = join(root, "literal-backslash");
    mkdirSync(join(literal, "lib", "literal"), { recursive: true });
    writeFileSync(join(literal, "lib", "literal\\file.txt"), "LITERAL");
    writeFileSync(join(literal, "lib", "literal", "file.txt"), "NESTED");
    const alias = join(literal, "lib", "alias");
    symlinkSync("literal\\file.txt", alias);
    const literalSource = await readGateSource(literal);
    assert.equal(reads(alias), "LITERAL");
    unlinkSync(alias);
    symlinkSync("literal/file.txt", alias);
    assert.equal(reads(alias), "NESTED");
    const nestedSource = await readGateSource(literal);
    assert.equal(gateSourceMatches({ sourceCommit: literalSource.commit, sourceFingerprint: literalSource.fingerprint,
      sourceAmbient: literalSource.ambient }, nestedSource), false, "第2轮发现1: POSIX 上切到另一个真实文件,身份必须跟着变");
  }

  // 第 2 轮发现 2:项目把 ash 的运行目录装在自己里面时,排除项只在源侧生效不行——clone/checkout 会
  // 把运行目录里**被跟踪的**文件照样写进副本,副本回算再不过滤就必然看到源摘要里没有的输入,项目
  // 什么也没改也会被判「没能按原样复现」。源摘要、复制、副本回算必须解释同一份排除计划。
  const filtered = freshRepo("runtime-filter", "node_modules/\ndata/\n");
  mkdirSync(join(filtered, "data", "runs"), { recursive: true });
  writeFileSync(join(filtered, "data", "runs", "keep.txt"), "tracked runtime directory placeholder");
  writeFileSync(join(filtered, "data", "payload.txt"), "ignored sibling of the runtime directory");
  git(filtered, "add", "-f", join("data", "runs", "keep.txt"));
  git(filtered, "commit", "-m", "tracked placeholder under the configured runtime directory");
  const filteredSource = await readGateSource(filtered);
  const filteredSnapshot = join(filtered, "data", "runs", "snapshot");
  await createGateSnapshot(filtered, filteredSnapshot, filteredSource);
  assert.equal(readFileSync(join(filteredSnapshot, "data", "runs", "keep.txt"), "utf8"),
    "tracked runtime directory placeholder", "checkout 给的被跟踪文件留在副本里(它属于那个提交)");
  assert.equal(existsSync(join(filteredSnapshot, "data", "payload.txt")), false,
    "被忽略的非依赖内容照旧不进快照");
  assert.equal(existsSync(join(filteredSnapshot, "data", "runs", "snapshot")), false,
    "运行目录本身不进复制计划:快照就住在那里面,复制它等于让快照把自己复制进自己");

  console.log("accept-gate-links: link identity, native path semantics, frozen relocation, dangling-link tolerance"
    + " and runtime-directory exclusion passed");
} finally { rmSync(root, { recursive: true, force: true }); }
