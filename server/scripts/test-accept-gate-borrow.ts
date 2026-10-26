import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// 依赖这一层的回归。依赖**不**逐文件深拷,放法有两种,判据是项目有没有声明 workspace 包:没声明
// 就借一条指向工作区那一份的链(O(1)),声明了就整棵克隆进快照(数据块共享)。为什么这么分、换掉了
// 什么检测力、接受了什么代价,全写在 src/accept-gate-deps.ts 顶部。这里钉的是:快照里命令真能跑
// 起来、清理绝不碰用户的依赖、换一次安装声明必须被认成「依赖变了」、没装依赖时行为和以前一样、
// 依赖根自己是链的三种落点、深拷退路,以及 monorepo 的**三个运行时入口**都必须落在快照自己那份
// 源码上(直接 import / 被借包的传递导入 / .bin 里的 CLI shim),和「依赖根不可达时不许拖垮快照」。
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

const freshRepo = (name: string, ignore: string, pkg = "{}"): string => {
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Gate Borrow Test");
  git(repo, "config", "user.email", "borrow@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), ignore);
  writeFileSync(join(repo, "package.json"), pkg);
  writeFileSync(join(repo, "index.js"), 'require("pkg");');
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `${name} source`);
  return repo;
};

try {
  const { createGateSnapshot, gateSnapshotPath, gateSourceMatches, readGateSource, removeGateSnapshot, verifyGateSnapshot } =
    await import("../src/accept-gate-source.js");
  const { copyTree, dependencyDigest, dependencyMismatch, needsIsolation, provideDependency, workspacePackages } =
    await import("../src/accept-gate-deps.js");

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
  // 对账只能按**落点**:借用之后两边读的是同一份文件,摘要恒等、证明不了任何事。这里把
  // provideDependency → dependencyMismatch 的往返单独钉一遍(生产那条对账在建快照过程中间,
  // 没有可插入的时机去制造「链落在别处」)。
  const roundTrip = join(root, "round-trip");
  mkdirSync(roundTrip);
  const noWorkspace = await workspacePackages(repo);
  assert.deepEqual(noWorkspace.names, [], "package.json 里没有 workspaces 就是没声明");
  assert.equal(noWorkspace.declared, false, "没有 workspaces 字段才算没声明");
  assert.equal(needsIsolation("node_modules", noWorkspace), false, "没声明 workspace 包就不必独立成一份");
  assert.equal(await provideDependency(repo, roundTrip, "node_modules", false), "link",
    "没声明 workspace 包时就是一条链,O(1)");
  assert.equal(await dependencyMismatch(repo, roundTrip, "node_modules", "link", noWorkspace), null,
    "借用建出来的链,落点就是工作区那一份");
  rmSync(join(roundTrip, "node_modules"));
  await copyTree(join(repo, "node_modules"), join(roundTrip, "node_modules"));
  assert.notEqual(await dependencyMismatch(repo, roundTrip, "node_modules", "link", noWorkspace), null,
    "不是链(深拷退路落在这个位置)时对不上账,调用方据此回到老办法");
  // 包管理器随时在改依赖树:读完目录到读条目之间文件被删掉不该崩掉整次快照。
  await copyTree(join(root, "never-existed"), join(root, "never-copied"));
  assert.equal(existsSync(join(root, "never-copied")), false);

  // ── 7. monorepo:三个运行时入口都必须落在**快照自己**那份源码上。
  // 这一节是 2026-10-26 独立审查打回来的。借用整条 node_modules 时,这三条路全都解析回活的工作区
  // (理由见 accept-gate-deps 顶部:node 的模块解析走 realpath,链那一侧的解析全发生在工作区),于是
  // 改 workspace 包的导出会红、只改实现则静悄悄地绿。所以声明了 workspace 包的项目整棵克隆。
  const monoPkg = '{"private":true,"workspaces":["packages/*"]}';
  const monoSource7 = (repo: string, value: string): void => {
    mkdirSync(join(repo, "packages", "lib"), { recursive: true });
    writeFileSync(join(repo, "packages", "lib", "package.json"),
      '{"name":"@demo/lib","version":"1.0.0","type":"module","main":"index.mjs","bin":{"demo-cli":"cli.mjs"}}');
    writeFileSync(join(repo, "packages", "lib", "index.mjs"), `export const build = ${JSON.stringify(value)};\n`);
    writeFileSync(join(repo, "packages", "lib", "cli.mjs"),
      'import { build } from "./index.mjs";\nconsole.log(build);\n');
    writeFileSync(join(repo, "probe.mjs"), 'import { build } from "@demo/lib";\nconsole.log(build);\n');
    writeFileSync(join(repo, "transitive.mjs"), 'import { build } from "plain";\nconsole.log(build);\n');
  };
  // npm 装出来的形状:workspace 包连成链、普通包是真目录、普通包里**传递导入**那个 workspace 包。
  const monoInstall = (repo: string): void => {
    mkdirSync(join(repo, "node_modules", "@demo"), { recursive: true });
    linkDir(join("..", "..", "packages", "lib"), join(repo, "node_modules", "@demo", "lib"));
    mkdirSync(join(repo, "node_modules", "plain"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "plain", "package.json"),
      '{"name":"plain","version":"3.0.0","type":"module","main":"index.mjs"}');
    writeFileSync(join(repo, "node_modules", "plain", "index.mjs"), 'export { build } from "@demo/lib";\n');
    // 真实 npm 写下的形状:workspace 包记成 link + resolved(**项目内相对路径**),普通包记版本。
    // resolved 是归属的唯一证据——同名同形状的第三方包(`file:` 依赖)的 resolved 指向项目外,门禁
    // 据此区分「该接回快照自己那份」和「不许动」。手铺一份不含 link 条目的记录等于没有证据,那时
    // 门禁一条链都不改写,跨检出借用会被对账当场判失败(本用例第④个入口就是那个形状)。
    writeFileSync(join(repo, "node_modules", ".package-lock.json"), JSON.stringify({
      packages: {
        "node_modules/@demo/lib": { resolved: "packages/lib", link: true },
        "node_modules/plain": { version: "3.0.0" },
        "packages/lib": { name: "@demo/lib", version: "1.0.0" },
      },
    }));
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    if (fileLinks) symlinkSync(join("..", "@demo", "lib", "cli.mjs"), join(repo, "node_modules", ".bin", "demo-cli"));
  };
  const mono = freshRepo("monorepo", "node_modules\n", monoPkg);
  monoSource7(mono, "certified");
  git(mono, "add", "-A");
  git(mono, "commit", "-m", "workspace package");
  monoInstall(mono);
  assert.deepEqual((await workspacePackages(mono)).names, ["@demo/lib"], "glob 展开后要认出声明的包名");
  assert.equal(needsIsolation("node_modules", await workspacePackages(mono)), true);
  const monoSnapshot = join(root, "monorepo-snapshot");
  const monoGateSource = await readGateSource(mono);
  await createGateSnapshot(mono, monoSnapshot, monoGateSource);
  assert.equal(lstatSync(join(monoSnapshot, "node_modules")).isSymbolicLink(), false,
    "声明了 workspace 包时依赖树必须在快照里独立成一份,不能整条借出去");
  assert.equal(realpathSync(join(monoSnapshot, "node_modules", "@demo", "lib")),
    realpathSync(join(monoSnapshot, "packages", "lib")), "workspace 链接在快照里解析到快照自己那份源码");
  assert.equal(realpathSync(join(monoSnapshot, "node_modules", "plain")).startsWith(realpathSync(monoSnapshot)), true,
    "普通包也在快照内:它的 realpath 决定了它的传递导入按谁的包映射解析");
  assert.equal(readFileSync(join(monoSnapshot, "node_modules", ".package-lock.json"), "utf8"),
    readFileSync(join(mono, "node_modules", ".package-lock.json"), "utf8"),
    "安装声明照常原样在副本里:依赖身份取它,改写归属的证据也取它");
  // 全节判据:改掉工作区的 workspace 源码,**三个入口**跑出来的都还是被认证那一版。
  writeFileSync(join(mono, "packages", "lib", "index.mjs"), 'export const build = "live-workspace";\n');
  const runIn = (path: string) => execFileSync(process.execPath, [path], { encoding: "utf8" }).trim();
  assert.equal(runIn(join(monoSnapshot, "probe.mjs")), "certified", "入口①直接 import workspace 包");
  assert.equal(runIn(join(monoSnapshot, "transitive.mjs")), "certified",
    "入口②被借包的传递导入:plain 的 realpath 若还在工作区,它会按工作区的包映射解析到活的源码");
  if (fileLinks) {
    assert.equal(runIn(join(monoSnapshot, "node_modules", ".bin", "demo-cli")), "certified",
      "入口③.bin 里的 CLI shim:workspace 包声明 bin 是最普通的形状");
  }
  git(mono, "restore", "packages/lib/index.mjs");
  assert.equal(await verifyGateSnapshot(monoSnapshot, monoGateSource), true, "克隆之后快照照旧能自证");
  // 入口④:整个依赖根指向**另一个检出**(worktree 借主仓那份,本仓就是这个形状)。主仓的 workspace
  // 链接落在主仓源码上,所以借用会让快照跑**主仓的旧代码**,而任务自己的源码明明已经 checkout 在
  // 快照里了。这一条不需要任何并发修改就会把错的代码判成通过。
  const mainRepo = freshRepo("mono-main", "node_modules\n", monoPkg);
  monoSource7(mainRepo, "old-main");
  git(mainRepo, "add", "-A");
  git(mainRepo, "commit", "-m", "main checkout");
  monoInstall(mainRepo);
  // 被借检出里的 workspace 链接用**绝对**原文:Windows 的 npm 建的就是绝对 junction,而这条链指着
  // **那个检出**的源码目录——它不在本项目内,所以「绝对原文落在项目内才改写」这条判据会把它照抄,
  // 快照于是接回别人的源码。这个组合 2026-10-26 在真机上红过一次,macOS 侧必须也走到它。
  rmSync(join(mainRepo, "node_modules", "@demo", "lib"), { recursive: true, force: true });
  linkDir(join(mainRepo, "packages", "lib"), join(mainRepo, "node_modules", "@demo", "lib"));
  const taskRepo = freshRepo("mono-task", "node_modules\n", monoPkg);
  monoSource7(taskRepo, "new-task");
  git(taskRepo, "add", "-A");
  git(taskRepo, "commit", "-m", "task checkout");
  linkDir(join(mainRepo, "node_modules"), join(taskRepo, "node_modules"));
  const taskGateSource = await readGateSource(taskRepo);
  const taskSnapshot = join(root, "mono-task-snapshot");
  await createGateSnapshot(taskRepo, taskSnapshot, taskGateSource);
  assert.equal(runIn(join(taskSnapshot, "probe.mjs")), "new-task",
    "依赖根借的是另一个检出时,快照里跑到的必须是**本任务**的源码,不是那个检出的");
  assert.equal(runIn(join(taskSnapshot, "transitive.mjs")), "new-task", "传递导入同理");
  assert.equal(await verifyGateSnapshot(taskSnapshot, taskGateSource), true);

  // 绝对原文:Windows 的 npm 给 workspace 包建的是**绝对 junction**,照抄会让快照里的包解析回活动
  // 工作区。所以克隆时绝对原文指着项目内就改写到快照内对应位置,指着项目外(.venv/bin/python ->
  // /opt/homebrew/…、/usr/local/bin 下的工具)照抄——那是系统的东西,不是这次要冻的源码。两条都在
  // 这里显式建成绝对路径,否则 macOS 这一侧只会走到「照抄」那一支,改写分支要等上真机才第一次执行。
  const absolute = freshRepo("monorepo-absolute", "node_modules\n", monoPkg);
  monoSource7(absolute, "absolute-certified");
  git(absolute, "add", "-A");
  git(absolute, "commit", "-m", "workspace package");
  mkdirSync(join(absolute, "node_modules", "@demo"), { recursive: true });
  linkDir(join(absolute, "packages", "lib"), join(absolute, "node_modules", "@demo", "lib"));
  const outsideTool = join(root, "outside-tool");
  mkdirSync(outsideTool, { recursive: true });
  writeFileSync(join(outsideTool, "runtime.mjs"), 'console.log("system tool");\n');
  linkDir(outsideTool, join(absolute, "node_modules", "outside"));
  const absoluteSource = await readGateSource(absolute);
  const absoluteSnapshot = join(root, "monorepo-absolute-snapshot");
  await createGateSnapshot(absolute, absoluteSnapshot, absoluteSource);
  assert.equal(realpathSync(join(absoluteSnapshot, "node_modules", "@demo", "lib")),
    realpathSync(join(absoluteSnapshot, "packages", "lib")), "绝对原文指着项目内:改写到快照里对应的位置");
  assert.equal(realpathSync(join(absoluteSnapshot, "node_modules", "outside")), realpathSync(outsideTool),
    "绝对原文指着项目外:照抄,不跟着搬进快照");
  writeFileSync(join(absolute, "packages", "lib", "index.mjs"), 'export const build = "live-workspace";\n');
  assert.equal(runIn(join(absoluteSnapshot, "probe.mjs")), "absolute-certified",
    "改了工作区的 workspace 源码,快照里跑到的还是被认证那一版");
  git(absolute, "restore", "packages/lib/index.mjs");

  // ── 8. 依赖根不可达:没装的可选依赖、指向还没建起来的目录的悬空链、环。
  // 登记它的条件只是 lstat 成功(悬空链也成立),所以这几种状态**会**进到依赖列表里。对账要求
  // 「两边都解析得出来」就会把它们全判成复制失败,于是一个没装的可选依赖足以拖垮整次验收——而
  // 那条命令可能根本不碰它。四个依赖目录逐个钉,防止只在 node_modules 上修掉。
  for (const dep of ["node_modules", ".venv", "vendor", "target"]) {
    const dangling = freshRepo(`dangling-${dep}`, `${dep}\n`);
    linkDir(join(root, `never-installed-${dep}`), join(dangling, dep));
    const danglingSource = await readGateSource(dangling);
    assert.deepEqual(danglingSource.dependencies, [dep], `${dep} 悬空时照旧登记成依赖输入`);
    const danglingSnapshot = join(root, `dangling-snapshot-${dep}`);
    await createGateSnapshot(dangling, danglingSnapshot, danglingSource);
    assert.equal(lstatSync(join(danglingSnapshot, dep)).isSymbolicLink(), true,
      `${dep} 在快照里照原样重建成一条同样解析不通的链`);
    assert.equal(existsSync(join(danglingSnapshot, dep)), false, "原样就是原样:它在副本里同样不可达");
    assert.equal(readFileSync(join(danglingSnapshot, "index.js"), "utf8"), 'require("pkg");',
      "源码照旧落盘:一个没装的依赖不该拖垮整次快照");
    assert.equal(await verifyGateSnapshot(danglingSnapshot, danglingSource), true, "不可达也有稳定身份,自证照旧通过");
  }

  // ── 9. 非 Git 的 monorepo:对账必须排在**源码落盘之后**。
  // 非 Git 分支的构造顺序是「先放依赖、再拷源码」,所以对账一旦紧跟依赖那一步,快照里的
  // packages/lib 还不存在,任何声明了 workspace 包的非 Git 项目都会在门禁开跑前就失败。
  const looseMono = join(root, "looseMono-monorepo");
  mkdirSync(looseMono, { recursive: true });
  writeFileSync(join(looseMono, "package.json"), monoPkg);
  monoSource7(looseMono, "looseMono-certified");
  mkdirSync(join(looseMono, "node_modules", "@demo"), { recursive: true });
  linkDir(join("..", "..", "packages", "lib"), join(looseMono, "node_modules", "@demo", "lib"));
  const looseMonoGate = await readGateSource(looseMono);
  const looseMonoSnap = join(root, "looseMono-monorepo-snapshot");
  await createGateSnapshot(looseMono, looseMonoSnap, looseMonoGate);
  assert.equal(realpathSync(join(looseMonoSnap, "node_modules", "@demo", "lib")),
    realpathSync(join(looseMonoSnap, "packages", "lib")), "非 Git 项目同样解析到快照自己那份源码");
  assert.equal(runIn(join(looseMonoSnap, "probe.mjs")), "looseMono-certified");

  console.log("accept-gate-borrow: launch-from-snapshot, cleanup safety, install-declaration identity, no-dependencies parity, link roots, workspace isolation across all four runtime entries, unreachable roots and the deep-copy fallback passed");
} finally { rmSync(root, { recursive: true, force: true }); }
