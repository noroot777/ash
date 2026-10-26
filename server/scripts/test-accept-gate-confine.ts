import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// 源码隔离的收口:**项目自己的包必须解析到快照里那份冻结的源码**。
//
// 这一组全部来自 2026-10-26 独立审查的实测反例,每一条在修复前都是「快照自带新代码、执行却跑旧
// 代码,而且测试开始后改工作区还能改变结果,自证全程为真」。它们共同打掉的是三个曾经被当成证明用
// 的东西:
//   ① 「依赖根已经克隆进快照」不证明源码隔离——快照里压根没有依赖树时,node 会向上找到项目主检
//      出那一份,顺着 workspace 链读到活的工作区源码;
//   ② 「声明展开出了包名」不证明覆盖完整——npm 接受的 glob 比展开器多(brace 就是),展开不出来时
//      旧实现直接当成「没有 workspace 包」;
//   ③ 「路径后缀 + package.json.name 相同」不证明来源相同——两个同名包是合法的,把第三方那份换成
//      项目自己那份等于换掉被测代码。
//
// 快照必须落在 fixture 项目**内部**(ASH_RUNS_DIR),否则向上查找那一条根本走不到。RUNS_DIR 在模块
// 加载时就固定了,所以这组用例必须独占一个进程、在 import 之前设好环境变量。
const root = mkdtempSync(join(tmpdir(), "ash-gate-confine-"));
process.env.ASH_RUNS_DIR = join(root, "host", "data", "runs");
const { readGateSource, createGateSnapshot, verifyGateSnapshot, gateSnapshotPath } =
  await import(pathToFileURL(join(import.meta.dirname, "..", "src", "accept-gate-source.ts")).href);
const { workspacePackages } =
  await import(pathToFileURL(join(import.meta.dirname, "..", "src", "accept-gate-deps.ts")).href);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const save = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const linkDir = (target: string, path: string) =>
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
const run = (path: string) => execFileSync(process.execPath, [path], { encoding: "utf8" }).trim();
// Windows 上 npm 是 npm.cmd,execFileSync 直接起它会 ENOENT(审查者在真机上踩过),必须过 cmd.exe。
const npmInstall = (cwd: string) => execFileSync(
  process.platform === "win32" ? "cmd.exe" : "npm",
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npm install --offline --ignore-scripts --no-audit --no-fund"]
    : ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let sequence = 0;
const snapshotOf = async (cwd: string) => {
  const source = await readGateSource(cwd);
  const target = gateSnapshotPath("confine", `case${++sequence}`);
  await createGateSnapshot(cwd, target, source);
  return { source, target };
};
const project = (name: string, workspaces: string[], value: string) => {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.name", "gate");
  git(directory, "config", "user.email", "gate@example.test");
  git(directory, "config", "core.hooksPath", "/dev/null");
  save(join(directory, ".gitignore"), "node_modules\ndata\n.worktrees\n");
  save(join(directory, "package.json"),
    JSON.stringify({ name: `fixture-${name}`, version: "1.0.0", private: true, workspaces }));
  save(join(directory, "packages", "lib", "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(directory, "packages", "lib", "index.mjs"), `export const value = ${JSON.stringify(value)};\n`);
  save(join(directory, "probe.mjs"), 'import { value } from "@demo/lib"; console.log(value);\n');
  git(directory, "add", "-A");
  git(directory, "commit", "-qm", "fixture");
  return directory;
};

try {
  // ── 1. 工作区**没有**装依赖(worktree 的常态)。快照里没有依赖树,前面每一条检查都「通过」,而
  // node 往上一级就找到主检出那份 node_modules,顺着 workspace 链读到活的工作区源码。
  const host = project("host", ["packages/*"], "MAIN_OLD");
  npmInstall(host);
  git(host, "add", "-A");
  git(host, "commit", "-qm", "install");
  const task = join(host, ".worktrees", "task");
  git(host, "worktree", "add", "--detach", task, "HEAD");
  save(join(task, "packages", "lib", "index.mjs"), 'export const value = "TASK_NEW";\n');
  git(task, "add", "-A");
  git(task, "commit", "-qm", "task");

  const ambient = await snapshotOf(task);
  assert.deepEqual(ambient.source.dependencies, [], "前提:任务工作区没有任何已安装的依赖根");
  assert.equal(run(join(ambient.target, "probe.mjs")), "TASK_NEW",
    "工作区没装依赖时,快照跑的必须是快照自己那份源码,不是 node 向上找到的那个检出");
  save(join(host, "packages", "lib", "index.mjs"), 'export const value = "MAIN_LIVE";\n');
  assert.equal(run(join(ambient.target, "probe.mjs")), "TASK_NEW",
    "门禁开跑之后改工作区,已经建好的快照跑出来的结果不许跟着变");
  assert.equal(await verifyGateSnapshot(ambient.target, ambient.source), true);
  git(host, "restore", "packages/lib/index.mjs");

  // ── 2. 声明是 npm 认、展开器不认的写法(brace),而且依赖根借自另一个检出。隔离**不许**依赖
  // 「声明展开出了多少包名」:展开器永远落后于 npm 支持的语法,而展开不出来在旧实现里直接等于
  // 「这个项目没有 workspace 包」。
  const brace = project("brace", ["packages/{lib,other}"], "MAIN_OLD");
  npmInstall(brace);
  git(brace, "add", "-A");
  git(brace, "commit", "-qm", "install");
  const braceTask = join(brace, ".worktrees", "task");
  git(brace, "worktree", "add", "--detach", braceTask, "HEAD");
  save(join(braceTask, "packages", "lib", "index.mjs"), 'export const value = "TASK_NEW";\n');
  git(braceTask, "add", "-A");
  git(braceTask, "commit", "-qm", "task");
  linkDir(join(brace, "node_modules"), join(braceTask, "node_modules"));

  const declaration = await workspacePackages(braceTask);
  assert.equal(declaration.declared, true, "package.json 里有 workspaces 字段就算声明过");
  assert.deepEqual(declaration.dirs, [],
    "前提:brace 写法展开器认不出来——这正是本用例要证明「隔离不靠展开结果」的地方");
  const braceSnapshot = await snapshotOf(braceTask);
  assert.equal(run(join(braceSnapshot.target, "probe.mjs")), "TASK_NEW",
    "声明展开不出包名时,隔离仍然必须成立(归属由安装记录给出,不由 glob 给出)");
  save(join(brace, "packages", "lib", "index.mjs"), 'export const value = "MAIN_LIVE";\n');
  assert.equal(run(join(braceSnapshot.target, "probe.mjs")), "TASK_NEW", "同样不许跟着工作区变");
  assert.equal(await verifyGateSnapshot(braceSnapshot.target, braceSnapshot.source), true);

  // ── 3. 两个同名包。根项目自有 packages/lib 叫 @demo/lib@1.0.0;另一个独立目录也叫 @demo/lib,
  // 版本 9.0.0,以 `file:` 装成逻辑依赖。路径后缀同、包名同,但它们是**两个包**——把被测代码换成
  // 另一份还报绿,比漏判严重得多。
  const named = project("same-name", ["packages/*"], "CERTIFIED");
  const foreign = join(root, "foreign", "packages", "lib");
  save(join(foreign, "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "9.0.0", type: "module", main: "index.mjs" }));
  save(join(foreign, "index.mjs"), 'export const value = "FOREIGN_V9";\n');
  const manifest = JSON.parse(readFileSync(join(named, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.dependencies = { foreign: `file:${foreign}` };
  save(join(named, "package.json"), JSON.stringify(manifest));
  npmInstall(named);
  save(join(named, "foreign-probe.mjs"), 'import { value } from "foreign"; console.log(value);\n');
  git(named, "add", "-A");
  git(named, "commit", "-qm", "foreign dependency");

  assert.equal(run(join(named, "foreign-probe.mjs")), "FOREIGN_V9", "前提:工作区里用的是那份外部包");
  const namedSnapshot = await snapshotOf(named);
  assert.equal(run(join(namedSnapshot.target, "foreign-probe.mjs")), "FOREIGN_V9",
    "同名的第三方包不许被换成项目自己那份:名字相同不等于来源相同");
  assert.equal(realpathSync(join(namedSnapshot.target, "node_modules", "foreign")), realpathSync(foreign),
    "它仍然指向原来那个外部包");
  assert.equal(run(join(namedSnapshot.target, "probe.mjs")), "CERTIFIED",
    "而项目自己那个同名包照旧解析到快照里的源码");

  // ── 4. 原生路径语义:这两条本地都读得通,搬迁时自己解释字符就会把它们弄坏(门禁在一个合法项目
  // 上直接不可用,一个测试都开始不了)。落点只能由原生调用给出。
  if (process.platform !== "win32") {
    const native = project("native", ["packages/*"], "CERTIFIED");
    npmInstall(native);
    git(native, "add", "-A");
    git(native, "commit", "-qm", "install");
    // POSIX 上 `\` 是**普通字符**:以它结尾的文件名不是「带分隔符的目录」。
    const literal = join(root, "literal\\");
    save(literal, "VALID_NATIVE_FILE");
    symlinkSync(literal, join(native, "node_modules", "literal"));
    // 原生先穿过 bridge 再回上一级,读到 store/entry.mjs;词法消掉 `bridge/..` 得到的是另一个文件。
    mkdirSync(join(root, "store", "deep"), { recursive: true });
    linkDir(join(root, "store", "deep"), join(root, "bridge"));
    save(join(root, "store", "entry.mjs"), "NATIVE_CONTENT");
    save(join(root, "entry.mjs"), "LEXICAL_CONTENT");
    // 原文**必须**是字面字符串:path.join 自己就会把 `bridge/..` 词法消掉,那正是本用例要抓的错。
    symlinkSync("../../bridge/../entry.mjs", join(native, "node_modules", "native"));

    assert.equal(readFileSync(join(native, "node_modules", "literal"), "utf8"), "VALID_NATIVE_FILE");
    assert.equal(readFileSync(join(native, "node_modules", "native"), "utf8"), "NATIVE_CONTENT");
    const nativeSnapshot = await snapshotOf(native);
    assert.equal(readFileSync(join(nativeSnapshot.target, "node_modules", "literal"), "utf8"),
      "VALID_NATIVE_FILE", "以字面反斜杠结尾的文件名在副本里必须仍然读得到同样的内容");
    assert.equal(readFileSync(join(nativeSnapshot.target, "node_modules", "native"), "utf8"),
      "NATIVE_CONTENT", "穿链之后的 `..` 必须按原生顺序解析,不能先被词法消掉");
  }

  console.log("accept-gate-confine: ambient resolution, declaration-independent isolation, "
    + "same-name provenance and native link semantics passed");
} finally { rmSync(root, { recursive: true, force: true }); }
