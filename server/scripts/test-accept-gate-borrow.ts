import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// 依赖借用这一层的回归:快照里的依赖目录是**一条指向工作区那一份的链**,不是逐文件拷进来的
// 副本。为什么不拷、换掉了什么检测力、接受了什么代价,全写在 src/accept-gate-deps.ts 顶部。
// 这里钉的是四件必须成立的事:快照里命令真能跑起来、清理绝不碰用户的依赖、换一次安装声明必须
// 被认成「依赖变了」、没装依赖时行为和以前一样。
const root = mkdtempSync(join(tmpdir(), "ash-gate-borrow-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
if (!fileLinks) console.log("accept-gate-borrow: 本机建不出文件软链(Windows 未开开发者模式),文件链用例跳过");

type Entry = { path: string; kind: string; detail: string };
// 清理安全性的判据必须是「一个文件都没少」,所以连链的原文和权限位一起记下来逐项比。
const inventory = (base: string, prefix = ""): Entry[] => {
  // 整个目录被删掉是这条用例最要防的那种失败,所以不让它以裸 ENOENT 冒出来:记成一条 missing,
  // 由下面的 deepEqual 报出「清理把工作区的依赖删了」。
  if (!existsSync(base)) return [{ path: prefix, kind: "missing", detail: base }];
  const list: Entry[] = [];
  for (const name of readdirSync(base).sort()) {
    const path = join(base, name);
    const rel = join(prefix, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) { list.push({ path: rel, kind: "link", detail: readlinkSync(path) }); continue; }
    if (info.isDirectory()) {
      list.push({ path: rel, kind: "dir", detail: "" });
      list.push(...inventory(path, rel));
      continue;
    }
    list.push({ path: rel, kind: "file", detail: `${(info.mode & 0o777).toString(8)}:${readFileSync(path, "utf8")}` });
  }
  return list;
};

const freshRepo = (name: string, ignore: string): string => {
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Gate Borrow Test");
  git(repo, "config", "user.email", "borrow@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), ignore);
  writeFileSync(join(repo, "package.json"), '{}');
  writeFileSync(join(repo, "index.js"), 'require("pkg");');
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `${name} source`);
  return repo;
};

try {
  const { createGateSnapshot, gateSnapshotPath, gateSourceMatches, readGateSource, removeGateSnapshot, verifyGateSnapshot } =
    await import("../src/accept-gate-source.js");
  const { borrowDependency, borrowMismatch, copyTree, dependencyDigest } = await import("../src/accept-gate-deps.js");

  // ── 1. 借用之后,快照里的命令必须真能跑起来。
  // tsx 那个形状:.bin 下的链指向包里的 cli,cli 再按**自身 realpath**找同胞模块。第 1 层(把链
  // 拍平成真文件)就是在这里死的;借用这一层让它原地不动,所以这条命令跑的始终是工作区那一份。
  const repo = freshRepo("launch", "node_modules/\n.venv/\n");
  mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "pkg", "dist"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "package.json"), '{"version":"1.0.0"}');
  writeFileSync(join(repo, "node_modules", "pkg", "dist", "sibling.mjs"), 'export const mark = "sibling";\n');
  writeFileSync(join(repo, "node_modules", "pkg", "dist", "cli.mjs"),
    'import { mark } from "./sibling.mjs";\nconsole.log(mark);\n');
  writeFileSync(join(repo, "node_modules", ".package-lock.json"),
    '{"packages":{"node_modules/pkg":{"version":"1.0.0","integrity":"sha512-aaa"}}}');
  // venv 的解释器形状:多级链,末端落在树外(@executable_path 相对解析就靠这个)。
  mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
  mkdirSync(join(repo, ".venv", "lib", "python3.11", "site-packages", "demo-1.0.dist-info"), { recursive: true });
  const external = join(root, "external-runtime");
  mkdirSync(external);
  writeFileSync(join(external, "runtime.mjs"), 'console.log("external runtime");\n');
  if (fileLinks) {
    symlinkSync(join("..", "pkg", "dist", "cli.mjs"), join(repo, "node_modules", ".bin", "cli.mjs"));
    symlinkSync(join(external, "runtime.mjs"), join(repo, ".venv", "bin", "runtime.mjs"));
    symlinkSync("runtime.mjs", join(repo, ".venv", "bin", "alias.mjs"));
    // 悬空链在 node_modules 里很常见(没装的可选依赖),不能崩掉整次快照。
    symlinkSync(join(root, "missing-dependency"), join(repo, "node_modules", "dangling"));
  }
  mkdirSync(join(repo, "node_modules", "store", "tool"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "store", "tool", "neighbour.mjs"), 'export const mark = "via-junction";\n');
  writeFileSync(join(repo, "node_modules", "store", "tool", "run.mjs"),
    'import { mark } from "./neighbour.mjs";\nconsole.log(mark);\n');
  linkDir(join("store", "tool"), join(repo, "node_modules", "linked-tool"));
  const launchSource = await readGateSource(repo);
  assert.deepEqual(launchSource.dependencies, [".venv", "node_modules"], "两个依赖目录都要登记成借用项");
  // 清单在建快照**之前**取:这样它同时覆盖「建快照」和「清理快照」两个阶段,而不只是后者。
  const beforeGate = [".venv", "node_modules"].map(dep => inventory(join(repo, dep)));
  assert.equal(beforeGate.every(list => list.length > 0), true, "清单不能是空的,否则下面那条比对什么也没比");
  const snapshot = gateSnapshotPath("borrow-task", "run-1");
  await createGateSnapshot(repo, snapshot, launchSource);
  for (const dep of [".venv", "node_modules"]) {
    assert.equal(lstatSync(join(snapshot, dep)).isSymbolicLink(), true, `快照里 ${dep} 是一条借用链`);
    assert.equal(realpathSync(join(snapshot, dep)), realpathSync(join(repo, dep)), `而且落在工作区那一份上:${dep}`);
  }
  assert.equal(lstatSync(join(snapshot, "node_modules", "linked-tool")).isSymbolicLink(), true,
    "依赖目录内的目录链原地不动(借用之后快照读到的就是工作区那一条)");
  assert.equal(execFileSync(process.execPath, [join(snapshot, "node_modules", "linked-tool", "run.mjs")], { encoding: "utf8" }).trim(),
    "via-junction", "穿一条目录链(Win32 是 junction)执行,再按自身 realpath 找同胞模块,从快照里跑得起来");
  if (fileLinks) {
    assert.equal(execFileSync(process.execPath, [join(snapshot, "node_modules", ".bin", "cli.mjs")], { encoding: "utf8" }).trim(),
      "sibling", "借用之后,按自身 realpath 找同胞模块的 cli 从快照里真跑得起来");
    assert.equal(execFileSync(process.execPath, [join(snapshot, ".venv", "bin", "alias.mjs")], { encoding: "utf8" }).trim(),
      "external runtime", "多级链 + 末端落在树外的解释器形状同样跑得起来");
    assert.equal(existsSync(join(snapshot, "node_modules", "dangling")), false, "悬空链原样在那,且没崩掉整次快照");
  }
  assert.equal(await verifyGateSnapshot(snapshot, launchSource), true);

  // ── 2. 清理绝不碰用户的依赖:删的是那条链,不是链指向的东西。
  // 生产清理走 rm(recursive, force)——对目录软链和 Win32 junction 都只摘链(192.168.1.187 真机
  // node 22.20 实测 4/4 USER-DATA-INTACT)。这条用生产的 removeGateSnapshot 走完整路径,判据是
  // 工作区那两个依赖目录「一个文件都没少、链还是链、权限位没变」。
  // 判别力验过:把清理换成「逐条 realpath 之后再删」(跟随链删的典型错法)这条立刻红。只对快照
  // **根**做 realpath 抓不住,因为根本来就不是链——危险在递归到子条目的那一步。
  await removeGateSnapshot("borrow-task", "run-1");
  assert.equal(existsSync(snapshot), false, "快照目录本身被删掉");
  [".venv", "node_modules"].forEach((dep, index) => {
    assert.deepEqual(inventory(join(repo, dep)), beforeGate[index],
      `建快照和清理快照都不能动工作区的依赖:${dep}(删链不删落点)`);
  });
  assert.equal(execFileSync(process.execPath, [join(repo, "node_modules", "pkg", "dist", "cli.mjs")], { encoding: "utf8" }).trim(),
    "sibling", "清理之后工作区的依赖照样可用");

  // ── 3. 换一次安装声明必须被认成「依赖变了」,各生态各自的声明都要认。
  const pinned = { sourceCommit: launchSource.commit, sourceFingerprint: launchSource.fingerprint };
  assert.equal(gateSourceMatches(pinned, await readGateSource(repo)), true, "什么都没动的时候可以沿用上次通过");
  const lock = join(repo, "node_modules", ".package-lock.json");
  const lockBefore = readFileSync(lock, "utf8");
  writeFileSync(lock, '{"packages":{"node_modules/pkg":{"version":"2.0.0","integrity":"sha512-bbb"}}}');
  assert.equal(gateSourceMatches(pinned, await readGateSource(repo)), false, "npm:改了已安装树声明就是依赖变了");
  writeFileSync(lock, lockBefore);
  assert.equal(gateSourceMatches(pinned, await readGateSource(repo)), true, "改回去又能沿用了(身份只取声明)");
  const sitePackages = join(repo, ".venv", "lib", "python3.11", "site-packages");
  mkdirSync(join(sitePackages, "extra-2.1.dist-info"));
  assert.equal(gateSourceMatches(pinned, await readGateSource(repo)), false, "venv:装进一个包就是依赖变了");
  rmSync(join(sitePackages, "extra-2.1.dist-info"), { recursive: true });
  rmSync(join(sitePackages, "demo-1.0.dist-info"), { recursive: true });
  assert.equal(gateSourceMatches(pinned, await readGateSource(repo)), false, "venv:删掉一个包同样是依赖变了");
  mkdirSync(join(sitePackages, "demo-1.0.dist-info"));
  assert.equal(gateSourceMatches(pinned, await readGateSource(repo)), true);
  // 没有任何已知声明的生态(手铺的 vendor、Rust 的 target)退到浅层条目清单:装/删一个条目认得出。
  const bare = join(root, "bare-vendor");
  mkdirSync(join(bare, "github.com"), { recursive: true });
  const bareDigest = await dependencyDigest(root, "bare-vendor");
  mkdirSync(join(bare, "golang.org"));
  assert.notEqual(await dependencyDigest(root, "bare-vendor"), bareDigest, "没有安装声明时,浅层条目的增减仍认得出");

  // ── 4. 没装依赖时行为与以前一样:没有要借用的东西,快照就是纯源码。
  const plain = freshRepo("no-dependencies", "node_modules/\n");
  const plainSource = await readGateSource(plain);
  assert.deepEqual(plainSource.dependencies, [], "一个依赖目录都没装的时候不登记任何借用项");
  const plainSnapshot = join(root, "plain-snapshot");
  await createGateSnapshot(plain, plainSnapshot, plainSource);
  assert.equal(existsSync(join(plainSnapshot, "node_modules")), false, "没装依赖就不该在快照里凭空造一条链");
  assert.equal(readFileSync(join(plainSnapshot, "index.js"), "utf8"), 'require("pkg");');
  assert.equal(await verifyGateSnapshot(plainSnapshot, plainSource), true);

  // ── 5. 依赖根**自己**就是一条链:三种落点,三种结论。
  // (a) 落在树外:worktree 借主仓 node_modules 的形状。借用把它整条转交,快照里解析得到同一份。
  const outward = freshRepo("outward", "node_modules/\n");
  const shared = join(root, "shared-node-modules");
  mkdirSync(join(shared, "pkg"), { recursive: true });
  writeFileSync(join(shared, "pkg", "index.js"), "shared v1");
  linkDir(shared, join(outward, "node_modules"));
  const outwardSource = await readGateSource(outward);
  assert.deepEqual(outwardSource.dependencies, ["node_modules"]);
  const outwardSnapshot = join(root, "outward-snapshot");
  await createGateSnapshot(outward, outwardSnapshot, outwardSource);
  assert.equal(readFileSync(join(outwardSnapshot, "node_modules", "pkg", "index.js"), "utf8"), "shared v1",
    "依赖根指向树外时,快照里照样读得到(借用不在乎落点在哪)");
  assert.equal(realpathSync(join(outwardSnapshot, "node_modules")), realpathSync(shared));

  // (b) 落在树内一个被忽略的目录:pnpm/本地安装布局。借用同样整条转交。
  const inward = freshRepo("inward", "node_modules\n.store/cache/\n");
  mkdirSync(join(inward, ".store", "cache"), { recursive: true });
  writeFileSync(join(inward, ".store", "README.md"), "tracked manifest");
  writeFileSync(join(inward, ".store", "cache", "cli.mjs"), 'console.log("INSTALLED");\n');
  git(inward, "add", ".store/README.md");
  git(inward, "commit", "-m", "tracked manifest with an ignored install payload");
  linkDir(".store", join(inward, "node_modules"));
  const inwardSource = await readGateSource(inward);
  const inwardSnapshot = join(root, "inward-snapshot");
  await createGateSnapshot(inward, inwardSnapshot, inwardSource);
  assert.equal(readFileSync(join(inwardSnapshot, "node_modules", "cache", "cli.mjs"), "utf8"), 'console.log("INSTALLED");\n',
    "被忽略的安装内容靠借用进快照,命令不会凭空不存在");
  assert.equal(readFileSync(join(inwardSnapshot, ".store", "README.md"), "utf8"), "tracked manifest",
    "跟踪的那部分仍然由 Git 检出提供");

  // (c) 落在树内一个**未跟踪也没被忽略**的目录:跟任何未跟踪文件一样拒掉。
  // 这是换口径带来的**收窄**(旧口径靠闭包把落点补登记成输入,于是它被默许)。钉在这里是因为它
  // 是行为变化而不是 bug:依赖是产物,产物本来就该在 .gitignore 里;放过它等于让门禁在一个没人
  // 声明过的目录上运行,而那个目录的内容既不冻结也不登记。
  const loose = freshRepo("loose-landing", "node_modules\n");
  mkdirSync(join(loose, ".local-deps", "pkg"), { recursive: true });
  writeFileSync(join(loose, ".local-deps", "pkg", "cli.mjs"), 'console.log("INSTALLED");\n');
  linkDir(".local-deps", join(loose, "node_modules"));
  await assert.rejects(readGateSource(loose), /未跟踪/,
    "依赖落点是个未跟踪也没忽略的目录:照未跟踪文件拒掉,不再默许");

  // ── 6. 建不出链时的退路:copyTree 按链重建、绝不跟随(跟随会把 .venv 指向的整个解释器拷进来)。
  const fallbackSource = join(root, "fallback-source");
  mkdirSync(join(fallbackSource, "pkg", "dist"), { recursive: true });
  writeFileSync(join(fallbackSource, "pkg", "dist", "sibling.mjs"), 'export const mark = "sibling";\n');
  writeFileSync(join(fallbackSource, "pkg", "dist", "cli.mjs"),
    'import { mark } from "./sibling.mjs";\nconsole.log(mark);\n');
  writeFileSync(join(fallbackSource, "executable.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(join(fallbackSource, "executable.sh"), 0o755); // Windows 没有 chmod 可执行文件,只能走 fs
  linkDir(join("pkg", "dist"), join(fallbackSource, "linked-dist"));
  if (fileLinks) {
    symlinkSync(join("pkg", "dist", "cli.mjs"), join(fallbackSource, "cli.mjs"));
    symlinkSync(join(root, "missing-fallback"), join(fallbackSource, "dangling"));
    symlinkSync(join(external, "runtime.mjs"), join(fallbackSource, "outward.mjs"));
  }
  const fallbackCopy = join(root, "fallback-copy");
  await copyTree(fallbackSource, fallbackCopy);
  assert.equal(lstatSync(join(fallbackCopy, "linked-dist")).isSymbolicLink(), true, "退路里目录链不能被整棵拷成真目录");
  assert.equal(readFileSync(join(fallbackCopy, "linked-dist", "sibling.mjs"), "utf8"), 'export const mark = "sibling";\n');
  if (process.platform !== "win32") {
    assert.equal((lstatSync(join(fallbackCopy, "executable.sh")).mode & 0o777).toString(8), "755", "退路里可执行位要保住");
  }
  if (fileLinks) {
    assert.equal(execFileSync(process.execPath, [join(fallbackCopy, "cli.mjs")], { encoding: "utf8" }).trim(), "sibling",
      "退路里按自身 realpath 找同胞模块的 cli 仍跑得起来");
    assert.equal(lstatSync(join(fallbackCopy, "dangling")).isSymbolicLink(), true, "退路不被悬空链崩掉");
    assert.equal(lstatSync(join(fallbackCopy, "outward.mjs")).isSymbolicLink(), true,
      "退路里树外链仍按链保留:跟随它会把 .venv 指向的整个解释器拷进快照");
    assert.equal(readlinkSync(join(fallbackCopy, "outward.mjs")), join(external, "runtime.mjs"), "落点原文照抄");
  }
  // 借用那一侧的对账只能按**落点**:借用之后两边读的是同一份文件,摘要恒等、证明不了任何事。
  // 这里把 borrowDependency → borrowedLanding 的往返单独钉一遍(生产那条对账在建快照过程中间,
  // 没有可插入的时机去制造「链落在别处」)。
  const roundTrip = join(root, "round-trip");
  mkdirSync(roundTrip);
  assert.equal(await borrowDependency(repo, roundTrip, "node_modules", [".venv", "node_modules"]), "link",
    "没有 workspace 链接时就是一条链,O(1)");
  assert.equal(await borrowMismatch(repo, roundTrip, "node_modules", [".venv", "node_modules"], "link"), null,
    "借用建出来的链,落点就是工作区那一份");
  rmSync(join(roundTrip, "node_modules"));
  await copyTree(join(repo, "node_modules"), join(roundTrip, "node_modules"));
  assert.notEqual(await borrowMismatch(repo, roundTrip, "node_modules", [".venv", "node_modules"], "link"), null,
    "不是链(深拷退路落在这个位置)时对不上账,调用方据此回到老办法");
  // 包管理器随时在改依赖树:读完目录到读条目之间文件被删掉不该崩掉整次快照。
  await copyTree(join(root, "never-existed"), join(root, "never-copied"));
  assert.equal(existsSync(join(root, "never-copied")), false);

  // ── 7. monorepo 的 workspace 链接:快照里跑到的必须是**快照自己**那份源码。
  // 这是借用唯一一处不能整条借出去的落点:node_modules/@scope/pkg -> ../../packages/pkg 指着项目
  // 自己的源码,相对原文按链真实所在的位置解析,所以整条借出去它就落在**活的工作区**上。那样的话
  // 改了 workspace 包的导出会红(看着像门禁在工作),只改实现则静悄悄地绿——monorepo 里最常被改的
  // 那部分恰好没被冻住。实测见 AMEPL4pvlx-S 的两份门禁日志。
  const mono = freshRepo("monorepo", "node_modules\n");
  mkdirSync(join(mono, "packages", "lib"), { recursive: true });
  writeFileSync(join(mono, "packages", "lib", "package.json"), '{"name":"@demo/lib","version":"1.0.0","main":"index.mjs"}');
  writeFileSync(join(mono, "packages", "lib", "index.mjs"), 'export const build = "certified";\n');
  git(mono, "add", "-A");
  git(mono, "commit", "-m", "workspace package");
  mkdirSync(join(mono, "node_modules", "@demo"), { recursive: true });
  linkDir(join("..", "..", "packages", "lib"), join(mono, "node_modules", "@demo", "lib"));
  mkdirSync(join(mono, "node_modules", "plain"), { recursive: true });
  writeFileSync(join(mono, "node_modules", "plain", "package.json"), '{"version":"3.0.0"}');
  writeFileSync(join(mono, "node_modules", ".package-lock.json"), '{"packages":{"node_modules/plain":{"version":"3.0.0"}}}');
  const monoSource = await readGateSource(mono);
  const monoSnapshot = join(root, "monorepo-snapshot");
  await createGateSnapshot(mono, monoSnapshot, monoSource);
  assert.equal(lstatSync(join(monoSnapshot, "node_modules")).isSymbolicLink(), false,
    "有 workspace 链接时依赖目录必须物化成真目录,不能整条借出去");
  assert.equal(realpathSync(join(monoSnapshot, "node_modules", "@demo", "lib")), realpathSync(join(monoSnapshot, "packages", "lib")),
    "workspace 链接重定向到快照自己那份源码");
  assert.equal(realpathSync(join(monoSnapshot, "node_modules", "plain")), realpathSync(join(mono, "node_modules", "plain")),
    "同一棵依赖树里的普通包照旧各借一条链,落在工作区那一份上");
  assert.equal(readFileSync(join(monoSnapshot, "node_modules", ".package-lock.json"), "utf8"),
    '{"packages":{"node_modules/plain":{"version":"3.0.0"}}}', "物化层里的文件(安装声明就在这层)照常拷进来");
  // 这条是全节的判据:改了工作区的 workspace 源码,快照里跑到的还是被认证的那一版。
  writeFileSync(join(mono, "packages", "lib", "index.mjs"), 'export const build = "live-workspace";\n');
  assert.equal(readFileSync(join(monoSnapshot, "node_modules", "@demo", "lib", "index.mjs"), "utf8"),
    'export const build = "certified";\n', "改了工作区的 workspace 源码,快照里读到的仍是冻住那一版");
  writeFileSync(join(monoSnapshot, "probe.mjs"), 'import { build } from "@demo/lib";\nconsole.log(build);\n');
  assert.equal(execFileSync(process.execPath, [join(monoSnapshot, "probe.mjs")], { encoding: "utf8" }).trim(), "certified",
    "node 自己解析 @demo/lib 时也落在快照那一份上(不只是读文件,是真的 import)");
  git(mono, "restore", "packages/lib/index.mjs");
  assert.equal(await verifyGateSnapshot(monoSnapshot, monoSource), true, "物化之后快照照旧能自证");

  console.log("accept-gate-borrow: launch-from-snapshot, cleanup safety, install-declaration identity, no-dependencies parity, link roots, workspace-link redirection and the deep-copy fallback passed");
} finally { rmSync(root, { recursive: true, force: true }); }
