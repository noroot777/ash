import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// 声明解析与链接搬迁的反例。全部来自 2026-10-26 的独立审查实测,每一条都曾经「快照自证通过、实际
// 跑的是错的东西」——所以这里钉的不是「有没有报错」,而是**执行等价性**:同一条链在工作区和在快照里
// 必须落在对应的那一份上,可达的仍可达、不可达的仍不可达、第三方仍是那个第三方。
const root = mkdtempSync(join(tmpdir(), "ash-gate-relocate-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const linkDir = (target: string, path: string) => (process.platform === "win32"
  ? symlinkSync(resolve(dirname(path), target), path, "junction")
  : symlinkSync(target, path));
const read = (path: string) => { try { return readFileSync(path, "utf8").trim(); }
  catch (error) { return `ERR:${(error as NodeJS.ErrnoException).code}`; } };
const runIn = (path: string) => { try { return execFileSync(process.execPath, [path], { encoding: "utf8" }).trim(); }
  catch (error) { return `ERR:${(error as { message: string }).message.split("\n")[0].slice(0, 60)}`; } };

const project = (name: string, declaration: string, packageDir: string, value: string): string => {
  const repo = join(root, name);
  mkdirSync(join(repo, packageDir), { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Gate Relocate Test");
  git(repo, "config", "user.email", "relocate@example.test");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "package.json"), declaration);
  writeFileSync(join(repo, packageDir, "package.json"),
    '{"name":"@demo/lib","version":"1.0.0","type":"module","main":"index.mjs"}');
  writeFileSync(join(repo, packageDir, "index.mjs"), `export const build = ${JSON.stringify(value)};\n`);
  writeFileSync(join(repo, "probe.mjs"), 'import { build } from "@demo/lib";\nconsole.log(build);\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `${name} source`);
  mkdirSync(join(repo, "node_modules", "@demo"), { recursive: true });
  linkDir(join(repo, packageDir), join(repo, "node_modules", "@demo", "lib"));
  writeFileSync(join(repo, "node_modules", ".package-lock.json"), '{"packages":{}}');
  return repo;
};

try {
  const { createGateSnapshot, gateSnapshotPath, readGateSource, verifyGateSnapshot } =
    await import("../src/accept-gate-source.js");
  const { declaresWorkspace, workspacePackages } = await import("../src/accept-gate-deps.js");
  let snapshots = 0;
  const snapshotOf = async (repo: string): Promise<string> => {
    const source = await readGateSource(repo);
    const target = gateSnapshotPath("relocate", `r${++snapshots}`);
    await createGateSnapshot(repo, target, source);
    assert.equal(await verifyGateSnapshot(target, source), true, "快照自证");
    return target;
  };

  // ── 1. 声明解析不完整不等于「没有 workspace」。
  // npm 认 `packages/*​/core` 这种中段带通配的声明并照常装出 workspace 链(审查用真实 npm 离线安装
  // 实测过);上一版的展开只处理末段通配,于是包名为空 → 判成没有 workspace → 整条借用 → 快照跑的
  // 是活的工作区源码(快照文件是 FROZEN,执行输出却是 LIVE,而且验后自证照旧通过)。
  const nested = project("nested-glob", '{"private":true,"workspaces":["packages/*/core"]}',
    join("packages", "team", "core"), "certified");
  const nestedDeclared = await workspacePackages(nested);
  assert.deepEqual(nestedDeclared.dirs, [join("packages", "team", "core")], "中段通配要能展开");
  assert.deepEqual(nestedDeclared.names, ["@demo/lib"]);
  assert.equal(declaresWorkspace("node_modules", nestedDeclared), true);
  const nestedSnapshot = await snapshotOf(nested);
  writeFileSync(join(nested, "packages", "team", "core", "index.mjs"), 'export const build = "live";\n');
  assert.equal(runIn(join(nestedSnapshot, "probe.mjs")), "certified",
    "中段通配声明的 workspace 包,快照里跑到的必须是冻住那一版");
  git(nested, "restore", join("packages", "team", "core", "index.mjs"));

  // 展开不出来也绝不能降级成借用:三态里「声明坏了」要往隔离那一侧倒。
  const broken = join(root, "broken-declaration");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "package.json"), '{"private":true,"workspaces":[');
  const brokenDeclared = await workspacePackages(broken);
  assert.deepEqual(brokenDeclared.names, [], "坏掉的声明展开不出包名");
  assert.equal(brokenDeclared.declared, true, "但它仍然算声明过");
  assert.equal(declaresWorkspace("node_modules", brokenDeclared), true, "展开不出包名时往隔离那一侧倒");
  const empty = join(root, "no-declaration");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, "package.json"), '{"private":true}');
  assert.equal(declaresWorkspace("node_modules", await workspacePackages(empty)), false,
    "真的没声明才借用——否则每个单包项目都要白克隆一遍依赖树");

  // pnpm 的行内列表也要认(同一类「解析不全」,只影响 dirs 完整度,不影响隔离决策)。
  const inline = join(root, "pnpm-inline");
  mkdirSync(join(inline, "libs", "one"), { recursive: true });
  writeFileSync(join(inline, "package.json"), "{}");
  writeFileSync(join(inline, "pnpm-workspace.yaml"), 'packages: ["libs/*"]\n');
  writeFileSync(join(inline, "libs", "one", "package.json"), '{"name":"one","version":"1.0.0"}');
  const inlineDeclared = await workspacePackages(inline);
  assert.deepEqual(inlineDeclared.names, ["one"], "行内列表要解析出来");
  assert.equal(inlineDeclared.declared, true);

  // ── 2. 后缀相同不是包身份。
  // 一个第三方依赖恰好装在 packages/lib,只按路径后缀猜就会把它改写成项目自己声明的那个包:
  // 审查实测 before=FOREIGN → after=CERTIFIED,被测代码被换掉了而快照自证照旧通过。
  const foreignHome = join(root, "foreign-home");
  mkdirSync(join(foreignHome, "packages", "lib"), { recursive: true });
  writeFileSync(join(foreignHome, "packages", "lib", "package.json"),
    '{"name":"unrelated-third-party","version":"9.0.0","type":"module","main":"index.mjs"}');
  writeFileSync(join(foreignHome, "packages", "lib", "index.mjs"), 'export const build = "foreign";\n');
  const suffix = project("suffix-identity", '{"private":true,"workspaces":["packages/*"]}',
    join("packages", "lib"), "certified");
  linkDir(join(foreignHome, "packages", "lib"), join(suffix, "node_modules", "foreign"));
  writeFileSync(join(suffix, "node_modules", "foreign-probe.mjs"),
    'import { build } from "./foreign/index.mjs";\nconsole.log(build);\n');
  const suffixSnapshot = await snapshotOf(suffix);
  assert.equal(realpathSync(join(suffixSnapshot, "node_modules", "foreign")),
    realpathSync(join(foreignHome, "packages", "lib")),
    "后缀撞上声明的包目录、但 package.json.name 不是那个包:它仍是那个第三方,不许被换掉");
  assert.equal(runIn(join(suffixSnapshot, "node_modules", "foreign-probe.mjs")), "foreign");
  assert.equal(realpathSync(join(suffixSnapshot, "node_modules", "@demo", "lib")),
    realpathSync(join(suffixSnapshot, "packages", "lib")), "身份对得上的那条照旧重定向到快照自己那份");

  // ── 3. 相对外链搬到不同深度后必须仍然可达。
  // 原文照抄是上一版的做法:快照与项目的深度不同,于是本地能读的外部包在门禁里变成 ENOENT——
  // 本地跑得通的测试在验收里找不到文件。
  const outside = join(root, "outside-pkg");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "package.json"), '{"name":"outside","version":"1.0.0","type":"module","main":"index.mjs"}');
  writeFileSync(join(outside, "index.mjs"), 'export const build = "external";\n');
  const external = project("relative-external", '{"private":true,"workspaces":["packages/*"]}',
    join("packages", "lib"), "certified");
  symlinkSync(join("..", "..", "outside-pkg"), join(external, "node_modules", "outside"));
  assert.equal(read(join(external, "node_modules", "outside", "index.mjs")), 'export const build = "external";',
    "前提:工作区里这条相对外链本来读得通");
  const externalSnapshot = await snapshotOf(external);
  assert.equal(read(join(externalSnapshot, "node_modules", "outside", "index.mjs")),
    'export const build = "external";', "搬到不同深度之后,这条相对外链必须仍指向同一个外部包");
  assert.equal(realpathSync(join(externalSnapshot, "node_modules", "outside")), realpathSync(outside));

  // ── 4. 原生语义不能被路径拼接抹掉:带尾部分隔符的原文指向普通文件时,原生读是 ENOTDIR。
  // dirname/basename/join 会把那个分隔符吃掉,于是副本里反而读得通——本地失败的用例到门禁里成功,
  // 比反过来更难发现。Windows 原生允许本例的尾部分隔符,所以那一侧不构成反例(审查已核实)。
  if (process.platform !== "win32") {
    const trailing = project("trailing-separator", '{"private":true,"workspaces":["packages/*"]}',
      join("packages", "lib"), "certified");
    const file = join(trailing, "packages", "lib", "index.mjs");
    symlinkSync(`${file}${sep}`, join(trailing, "node_modules", "trailing"));
    assert.equal(read(join(trailing, "node_modules", "trailing")), "ERR:ENOTDIR",
      "前提:工作区里这条链原生读是 ENOTDIR");
    const trailingSnapshot = await snapshotOf(trailing);
    assert.equal(read(join(trailingSnapshot, "node_modules", "trailing")), "ERR:ENOTDIR",
      "副本里也必须是 ENOTDIR:把尾部分隔符抹掉会让本地失败的用例在门禁里成功");
    assert.equal(existsSync(join(trailingSnapshot, "packages", "lib", "index.mjs")), true, "源码本身照旧在");
  }

  // ── 5. 指回自己所在目录的链(`node_modules/.bin/.bin -> …/.bin`,npm 真的会建出来)。
  // relative() 对「落点就是目的地的父目录」给出空串,而 symlink("") 建出来的链解析不到任何东西:
  // 源端活着、副本里死掉,随后对账报「副本里却落在 解析不出来」,整次门禁拒绝一个合法项目。
  if (process.platform !== "win32") {
    const { copyTree, linkMismatch } = await import("../src/accept-gate-relocate.js");
    const tree = join(root, "selfref", "node_modules");
    mkdirSync(join(tree, ".bin"), { recursive: true });
    writeFileSync(join(tree, ".bin", "tool"), "#!/bin/sh\nexit 0\n");
    symlinkSync(join(tree, ".bin"), join(tree, ".bin", ".bin"));
    const copy = join(root, "selfref-copy", "node_modules");
    const relocation = { treeRoot: realpathSync(tree), treeDest: copy, target: join(root, "selfref-copy"),
      realRoot: realpathSync(join(root, "selfref")), owned: [] };
    await copyTree(relocation.treeRoot, copy, { clone: true, relocate: relocation, snapshotRoot: dirname(copy) });
    assert.equal(realpathSync(join(copy, ".bin", ".bin")), realpathSync(join(copy, ".bin")),
      "自指链在副本里必须仍指向它所在的那个目录");
    assert.equal(await linkMismatch(relocation), null, "自指链要过链闭包对账");
  }

  // ── 6. 克隆形态真的在共享数据块。这一条钉的是**代价**而不是行为,但它曾经静默烂掉一整次:
  // node 的 `COPYFILE_FICLONE` 在 macOS 上整块复制(FICLONE_FORCE 直接 ENOSYS),于是「实测 16 MB」
  // 的注释和文档全都失效,门禁每建一份快照实打实占 1034 MB 而没有任何报错 —— 行为测试全绿。
  // 判据只能是磁盘:写一份随机数据(不可压缩、不是稀疏文件),克隆一遍,看可用空间掉了多少。
  //
  // 两步走,因为「这台机器做不做数据块共享」和「copyTree 有没有去做」是两件事:ext4 没有 reflink、
  // 容器里的 overlayfs 也没有,`--reflink=auto` 在那里静默退回整块复制 —— 直接断言磁盘就等于把
  // 文件系统能力当成代码缺陷,在那种机器上门禁自测必红。所以先用**平台自己的克隆命令**探一次能力,
  // 探得通才问 copyTree。探针绝不能走 copyTree:否则「copyTree 根本没克隆」会被它自己判成「这台
  // 机器不支持」,这条测试就白写了。
  if (process.platform !== "win32") {
    const { copyTree } = await import("../src/accept-gate-relocate.js");
    const megabytes = 128;
    const bulk = join(root, "bulk");
    mkdirSync(bulk, { recursive: true });
    // 自己写而不是调 dd:GNU coreutils 的 dd 不接受 `bs=1m`(只认 `1M` 或字节数),那一支会在还没
    // 走到克隆之前就退出 1。随机内容是必须的 —— 可压缩或稀疏的负载在两种实现下都不占块,这一条
    // 就恒绿。分块写是为了别一次性占 128 MB 内存。
    const payload = join(bulk, "payload.bin");
    const chunk = randomBytes(4 * 1024 * 1024);
    const sink = openSync(payload, "w");
    try { for (let left = megabytes / 4; left > 0; left -= 1) writeSync(sink, chunk); }
    finally { closeSync(sink); }
    const free = () => Number(execFileSync("df", ["-k", root], { encoding: "utf8" })
      .trim().split("\n")[1].split(/\s+/)[3]);
    // 阈值取一半:共享时实占接近 0(本仓实测 128 MB 的负载花 0~2 MB),不共享时就是整整 128 MB。
    // 中间这么大的空档留给 df 自己的噪声(可清除空间、本地快照),所以它不会因为抖动而红。
    const shared = async (work: () => Promise<void> | void) => {
      const before = free();
      await work();
      return (before - free()) / 1024 < megabytes / 2;
    };
    // 两个判据都要:macOS 的 `cp -c` 在不支持的文件系统上**静默**退回 copyfile(2)(退出码 0 却整块
    // 复制),所以必须看磁盘;而 Linux 这里用 `always` 而不是 `auto`,不支持时它直接报错、一个字节
    // 都不写 —— 只看磁盘的话「花了 0 MB」会被当成「共享得很好」(2026-10-31 在 node:24 容器的
    // overlayfs 上实测就是这个结果),于是跳过判据失效、下面那一问在非 CoW 文件系统上必红。
    let probed = false;
    const economicalProbe = await shared(() => {
      const argv = process.platform === "darwin" ? ["-c"] : ["--reflink=always"];
      probed = spawnSync("cp", [...argv, "--", payload, join(root, "capability.bin")]).status === 0;
    });
    if (!probed || !economicalProbe) {
      console.log("accept-gate-relocate: 这台机器的文件系统不做数据块共享,跳过克隆磁盘账这一条"
        + "(门禁在这种机器上每份快照按整块复制计价,见 docs/accept-gate.md)");
    } else {
      const economical = await shared(() => copyTree(bulk, join(root, "bulk-clone"), { clone: true }));
      assert.equal(readFileSync(join(root, "bulk-clone", "payload.bin")).length, megabytes * 1024 * 1024,
        "副本内容必须完整");
      assert.ok(economical, `克隆形态必须共享数据块:同一台机器上平台命令只花了不到 ${megabytes / 2} MB,`
        + `copyTree 却把这 ${megabytes} MB 整块拷了一遍`);
    }
  }

  console.log("accept-gate-relocate: declaration three-state, nested globs, package identity, relative external links, native trailing-separator semantics, self-referential links and block-sharing clones passed");
} finally { rmSync(root, { recursive: true, force: true }); }
