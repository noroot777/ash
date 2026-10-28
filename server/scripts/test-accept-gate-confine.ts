import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// 造一个**真实的** npm 包:手铺目录证明不了「它是装进来的」,而这几条用例要钉的正是「正式装进来
// 的第三方包」与「本项目自己的源码」的区别,所以走 npm pack + npm install 的真实路径。
const packTarball = (name: string, body: string) => {
  const directory = join(root, `pack-${name}`);
  save(join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(directory, "index.mjs"), body);
  const file = execFileSync(
    process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm pack --offline --ignore-scripts --silent"]
      : ["pack", "--offline", "--ignore-scripts", "--silent"],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/).pop()!;
  return join(directory, file);
};
const dependOn = (directory: string, dependencies: Record<string, string>) => {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.dependencies = { ...(manifest.dependencies as object ?? {}), ...dependencies };
  save(join(directory, "package.json"), JSON.stringify(manifest));
};

let sequence = 0;
// 快照必须落在**被测项目自己**内部,否则 node 的向上查找走不到它那棵依赖树:gateSnapshotPath 用的
// ASH_RUNS_DIR 在模块加载时就固定在 host 项目里,只对前面那些以 host 为被测项目的用例成立。
const targetIn = (directory: string) => join(directory, "data", "runs", `case${++sequence}.source`);
const snapshotOf = async (cwd: string) => {
  const target = gateSnapshotPath("confine", `case${++sequence}`);
  const source = await readGateSource(cwd, target);
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

  // ── 5. 别名依赖:`"aliased": "file:./packages/lib"` 建出的目录项名(aliased)与包名(@demo/lib)
  // 毫无关系,而且项目**没有** workspaces 声明。放法的判据因此不能是声明:借出去之后那条路径穿回
  // 工作区,快照跑的是活的源码,改一行当场跟着变而自证仍为真。
  const alias = join(root, "alias");
  mkdirSync(alias, { recursive: true });
  git(alias, "init", "-b", "main");
  git(alias, "config", "user.name", "gate");
  git(alias, "config", "user.email", "gate@example.test");
  git(alias, "config", "core.hooksPath", "/dev/null");
  save(join(alias, ".gitignore"), "node_modules\ndata\n");
  save(join(alias, "package.json"),
    JSON.stringify({ name: "alias-root", version: "1.0.0", private: true, dependencies: { aliased: "file:./packages/lib" } }));
  save(join(alias, "packages", "lib", "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(alias, "packages", "lib", "index.mjs"), 'export const value = "COMMITTED_V1";\n');
  save(join(alias, "probe.mjs"), 'import { value } from "aliased"; console.log(value);\n');
  git(alias, "add", "-A");
  git(alias, "commit", "-qm", "alias fixture");
  npmInstall(alias);
  git(alias, "add", "-A");
  git(alias, "commit", "-qm", "install");

  assert.equal((await workspacePackages(alias)).declared, false, "前提:这个项目没有 workspaces 声明");
  const aliasSnapshot = await snapshotOf(alias);
  assert.equal(lstatSync(join(aliasSnapshot.target, "node_modules")).isSymbolicLink(), false,
    "依赖树里有链指回源码时不能整条借出去——判据是落点,不是有没有 workspaces 声明");
  assert.equal(run(join(aliasSnapshot.target, "probe.mjs")), "COMMITTED_V1");
  save(join(alias, "packages", "lib", "index.mjs"), 'export const value = "LIVE_WORKSPACE_EDIT";\n');
  assert.equal(run(join(aliasSnapshot.target, "probe.mjs")), "COMMITTED_V1",
    "快照建好之后改工作区源码,同一份快照的执行输出不许跟着变");
  assert.equal(await verifyGateSnapshot(aliasSnapshot.target, aliasSnapshot.source), true);
  git(alias, "restore", "packages/lib/index.mjs");

  // ── 6. 工作区装着一个第三方包,项目源码里另有一份**同名**的副本(补丁副本/样例/vendor 进来的
  // 一份)。按名字认归属会把装好的那个删掉换成项目里那份——改坏用户的工作区,而且这类项目的门禁
  // 一次也过不去。第三方包解析到工作区的依赖树本来就是正常的(依赖按安装声明计身份)。
  const twin = project("twin", ["packages/*"], "CERTIFIED");
  save(join(twin, "patches", "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "0.0.0", type: "module", main: "index.mjs" }));
  save(join(twin, "patches", "left-pad", "index.mjs"), 'export const value = "PATCH_COPY";\n');
  mkdirSync(join(twin, "node_modules", "left-pad"), { recursive: true });
  save(join(twin, "node_modules", "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "1.3.0", type: "module", main: "index.mjs" }));
  save(join(twin, "node_modules", "left-pad", "index.mjs"), 'export const value = "REGISTRY_1_3_0";\n');
  save(join(twin, "node_modules", ".package-lock.json"),
    JSON.stringify({ packages: { "node_modules/left-pad": { version: "1.3.0" } } }));
  save(join(twin, "twin-probe.mjs"), 'import { value } from "left-pad"; console.log(value);\n');
  git(twin, "add", "-A");
  git(twin, "commit", "-qm", "same-name copy in source");

  assert.equal(run(join(twin, "twin-probe.mjs")), "REGISTRY_1_3_0", "前提:工作区用的是装下来那一份");
  const twinSnapshot = await snapshotOf(twin);
  assert.equal(lstatSync(join(twin, "node_modules", "left-pad")).isDirectory(), true,
    "用户工作区里装好的那个包必须原样留着——门禁不许动它");
  assert.equal(run(join(twin, "twin-probe.mjs")), "REGISTRY_1_3_0", "工作区解析到的还是装下来那一份");
  assert.equal(await verifyGateSnapshot(twinSnapshot.target, twinSnapshot.source), true,
    "源码里有一份同名副本不该让门禁过不去");

  // ── 7. 收口的写入方向。它要往「快照自己的 node_modules」里重新绑定条目,而那个路径可能是一条
  // **借用链**——落在用户工作区上。往那里写就是改用户的工作区:同名的第三方包会被换成项目自己那
  // 份,`file:` 来的外部依赖会被改写到快照里,用户下次跑自己的东西才发现被动过,且改动不可逆。
  //
  // 这一条**直接调收口函数**,因为端到端路径上这个组合很难凑出来:放法那一侧(安装记录认下自有包
  // 就克隆、认不下再扫落点)已经把「主干是借用链、同时快照里有自有包要绑」这个组合基本挡掉了。
  // 直接调是为了把那道闸本身钉住——放法那侧哪天放宽,结果必须是「拒绝」而不是「静默改坏工作区」。
  const { confineOwnPackages } = await import(
    pathToFileURL(join(import.meta.dirname, "..", "src", "accept-gate-confine.ts")).href);
  const live = join(root, "live");
  save(join(live, "package.json"),
    JSON.stringify({ name: "live-root", version: "1.0.0", private: true, workspaces: ["packages/*"] }));
  save(join(live, "packages", "lib", "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(live, "packages", "lib", "index.mjs"), 'export const value = "LIVE_WORKSPACE";\n');
  mkdirSync(join(live, "node_modules", "@demo"), { recursive: true });
  linkDir(join("..", "..", "packages", "lib"), join(live, "node_modules", "@demo", "lib"));
  save(join(live, "node_modules", "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "1.3.0", type: "module", main: "index.mjs" }));
  save(join(live, "node_modules", "left-pad", "index.mjs"), 'export const value = "REGISTRY_1_3_0";\n');
  // 安装记录认下 @demo/lib 来自 packages/lib。**这一条是本用例的前提**:收口只对「安装记录证明
  // 得了来源」的入口做绑定,没有记录时它在更早一步就以「来源无从证明」拒绝(那条路钉在用例 13)。
  // 补上它,这里要钉的才是「要写的位置落在快照外 → 不许往那头写」那道闸本身。
  save(join(live, "node_modules", ".package-lock.json"), JSON.stringify({
    packages: { "node_modules/@demo/lib": { link: true, resolved: "packages/lib" } },
  }));

  const frozen = join(root, "frozen");
  save(join(frozen, "packages", "lib", "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(frozen, "packages", "lib", "index.mjs"), 'export const value = "FROZEN";\n');
  linkDir(join("..", "live", "node_modules"), join(frozen, "node_modules"));

  const refused = await confineOwnPackages(frozen, live);
  assert.match(String(refused), /快照之外.*不会往快照之外写/s,
    "快照的依赖树是一条借到工作区的链时,收口必须拒绝,不许往那头写");
  assert.equal(realpathSync(join(live, "node_modules", "@demo", "lib")), realpathSync(join(live, "packages", "lib")),
    "工作区里的本地包还得指着工作区自己的源码");
  assert.equal(JSON.parse(readFileSync(join(live, "node_modules", "left-pad", "package.json"), "utf8")).version,
    "1.3.0", "工作区里装好的第三方包必须一个字节都没动");

  // ── 8. **部分安装**:任务自己装了依赖(树在快照里就有),但缺掉本项目某个自有包的条目。
  // node 不是「先选一棵树、再在树里找所有包」,而是**按每个包名分别**一级级往上找 `node_modules/
  // <name>`:缺掉的那个会继续往祖先找,落在主检出的活源码上。上一版的收口找到第一棵树、树在快照内
  // 就认为隔离完成,于是这条路一个字都没拦——2026-10-27 独立审查在 macOS 与 Windows 两台机器上实测
  // 到的就是它:快照自带 TASK_NEW、执行输出 MAIN_OLD,随后改主检出的源码,同一份快照跟着变成
  // MAIN_LIVE,而快照自证与工作区新鲜度全程为真。
  const partial = join(host, ".worktrees", "partial");
  git(host, "worktree", "add", "--detach", partial, "HEAD");
  save(join(partial, "packages", "lib", "index.mjs"), 'export const value = "PARTIAL_NEW";\n');
  git(partial, "add", "-A");
  git(partial, "commit", "-qm", "partial task");
  // 只装了一个工具包:树存在,但没有 @demo/lib 这个条目。这是部分安装的常态形状,不是伪造。
  save(join(partial, "node_modules", "tool", "package.json"),
    JSON.stringify({ name: "tool", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(partial, "node_modules", "tool", "index.mjs"), 'export const tool = 1;\n');
  save(join(partial, "node_modules", ".package-lock.json"),
    JSON.stringify({ packages: { "node_modules/tool": { version: "1.0.0" } } }));

  const partialSnapshot = await snapshotOf(partial);
  assert.deepEqual(partialSnapshot.source.dependencies, ["node_modules"], "前提:任务自己有一棵依赖树");
  assert.equal(run(join(partialSnapshot.target, "probe.mjs")), "PARTIAL_NEW",
    "树在快照里**不等于**树里装齐了本项目的包:缺掉的那个不许继续往祖先找到活源码");
  save(join(host, "packages", "lib", "index.mjs"), 'export const value = "MAIN_LIVE";\n');
  assert.equal(run(join(partialSnapshot.target, "probe.mjs")), "PARTIAL_NEW",
    "快照建好之后改主检出的源码,同一份快照的执行输出不许跟着变");
  assert.equal(await verifyGateSnapshot(partialSnapshot.target, partialSnapshot.source), true);
  git(host, "restore", "packages/lib/index.mjs");

  // ── 9. 包在任务里**搬了位置**:主检出是 `packages/lib`,任务重构成 `libs/lib`,任务没装依赖。
  // 「自有包有哪些、在哪」只能从**快照自己的源码**读——它就是本次被认证的那一份。上一版从主检出
  // 那棵树的条目反推相对路径、再把同一个相对路径套到快照上,于是快照的 `packages/lib` 上没有包,
  // 门禁在开跑前就失败:一个合法的重构让验收不可用。
  const moved = join(host, ".worktrees", "moved");
  git(host, "worktree", "add", "--detach", moved, "HEAD");
  mkdirSync(join(moved, "libs"), { recursive: true }); // git mv 不会替你建目标父目录
  git(moved, "mv", join("packages", "lib"), join("libs", "lib"));
  save(join(moved, "libs", "lib", "index.mjs"), 'export const value = "MOVED_NEW";\n');
  save(join(moved, "package.json"),
    JSON.stringify({ name: "fixture-host", version: "1.0.0", private: true, workspaces: ["libs/*"] }));
  git(moved, "add", "-A");
  git(moved, "commit", "-qm", "move the package");

  const movedSnapshot = await snapshotOf(moved);
  assert.equal(run(join(movedSnapshot.target, "probe.mjs")), "MOVED_NEW",
    "包搬了位置,收口要从快照自己的源码找到它,不能拿主检出的旧相对路径去套");

  // ── 10. 任务的依赖根是一条**悬空链**,而祖先那棵树里有本项目的包。收口要绑定,但主干解析不通:
  // 往那里 mkdir 会在断链的落点上把目录造出来,而那个落点在用户工作区里。上一版只判「落点在快照
  // 外」,解析不出落点时直接放过,随后穿着断链写——用户看到的是裸 ENOTDIR/ENOENT。
  const dangling = join(host, ".worktrees", "dangling");
  git(host, "worktree", "add", "--detach", dangling, "HEAD");
  save(join(dangling, "packages", "lib", "index.mjs"), 'export const value = "DANGLING_NEW";\n');
  git(dangling, "add", "-A");
  git(dangling, "commit", "-qm", "dangling task");
  linkDir(join(dangling, "never-installed"), join(dangling, "node_modules"));

  const danglingSource = await readGateSource(dangling);
  const danglingTarget = gateSnapshotPath("confine", `case${++sequence}`);
  await assert.rejects(createGateSnapshot(dangling, danglingTarget, danglingSource), /解析不通|拒绝/,
    "主干是一条解析不通的链时必须明确拒绝,不许穿着断链往用户工作区写");


  // ── 11. **写入所有权**:scope 目录是一条指向另一处安装存储的链。项目声明 workspace(整棵克隆),
  // 安装记录认下自有包 @demo/lib,所以收口确实要把它绑回快照里那份源码——而要写的那个位置
  // `node_modules/@demo` 落在快照之外。
  //
  // 上一版只验 `<快照>/node_modules` 这个根(真目录,通过),随后 `rm(<快照>/node_modules/@demo/lib)`
  // 穿过 scope 链,把用户原安装存储里那个包目录**整个删掉**,再在原存储上建链。2026-10-27 第二轮
  // 独立审查两台机器实测:macOS 上最后那道写后核对报错(相对链在外部 scope 下解析不通),破坏已经
  // 发生且不可逆;Windows 的 junction 用绝对落点,写后核对照样解析进快照,**连错都不报**。
  // 字面路径在快照内、根主干在快照内,都证明不了实际写入目的地在快照内——只有逐段验父链能证明。
  const scoped = project("scoped", ["packages/*"], "LOCAL_SOURCE");
  const store = join(root, "scope-store");
  save(join(store, "lib", "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "9.0.0", type: "module", main: "index.mjs" }));
  save(join(store, "lib", "index.mjs"), 'export const value = "INSTALLED_REGISTRY";\n');
  save(join(store, "lib", "installed-payload.txt"), "USER_INSTALLED_FILE\n");
  mkdirSync(join(scoped, "node_modules"), { recursive: true });
  linkDir(store, join(scoped, "node_modules", "@demo"));
  save(join(scoped, "node_modules", ".package-lock.json"), JSON.stringify({
    packages: { "node_modules/@demo/lib": { link: true, resolved: "packages/lib" } },
  }));
  // 依赖树在 .gitignore 里,所以上面这几步不产生新提交——project() 那一次就是本次被认证的源码。

  const scopedSource = await readGateSource(scoped);
  const scopedTarget = gateSnapshotPath("confine", `case${++sequence}`);
  await assert.rejects(createGateSnapshot(scoped, scopedTarget, scopedSource),
    /快照之外.*不会往快照之外写/s,
    "要写的位置的父链落在快照外时必须拒绝,不许穿着 scope 链删掉用户装好的包");
  assert.equal(readFileSync(join(store, "lib", "installed-payload.txt"), "utf8"), "USER_INSTALLED_FILE\n",
    "用户原安装存储里的文件必须一个字节都没动");
  assert.equal(lstatSync(join(store, "lib")).isDirectory(), true,
    "原安装条目必须还是目录,没被换成一条指回快照的链");
  assert.match(readFileSync(join(store, "lib", "index.mjs"), "utf8"), /INSTALLED_REGISTRY/,
    "原安装的那份代码必须原样留着");

  // ── 12. **来源身份**:项目正式依赖一个第三方包、从**祖先**安装目录解析,仓库里另存了一份同名
  // 的补丁目录(patches/left-pad 这种形状很常见)。
  //
  // 上一版扫快照源码里的 package.json.name 当来源身份,于是补丁副本被算成自有包、在快照里建了一条
  // 更近的绑定,**遮蔽了项目实际使用的正式包**。两台机器实测输出一致:工作区 REGISTRY_1_3_0、快照
  // PATCH_COPY,而快照自证为真——换掉被测代码还报绿。名字从来不是来源,同名两个包是合法的。
  const ancestor = join(root, "ancestor");
  save(join(ancestor, "node_modules", "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "1.3.0", type: "module", main: "index.mjs" }));
  save(join(ancestor, "node_modules", "left-pad", "index.mjs"), 'export const value = "REGISTRY_1_3_0";\n');
  save(join(ancestor, "node_modules", ".package-lock.json"),
    JSON.stringify({ packages: { "node_modules/left-pad": { version: "1.3.0" } } }));
  const patched = join(ancestor, "task");
  mkdirSync(patched, { recursive: true });
  git(patched, "init", "-b", "main");
  git(patched, "config", "user.name", "gate");
  git(patched, "config", "user.email", "gate@example.test");
  git(patched, "config", "core.hooksPath", "/dev/null");
  save(join(patched, ".gitignore"), "node_modules\ndata\n");
  save(join(patched, "package.json"),
    JSON.stringify({ name: "patched-app", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }));
  save(join(patched, "patches", "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "0.0.0", type: "module", main: "index.mjs" }));
  save(join(patched, "patches", "left-pad", "index.mjs"), 'export const value = "PATCH_COPY";\n');
  save(join(patched, "probe.mjs"), 'import { value } from "left-pad"; console.log(value);\n');
  git(patched, "add", "-A");
  git(patched, "commit", "-qm", "patched copy in source");

  assert.equal(run(join(patched, "probe.mjs")), "REGISTRY_1_3_0", "前提:工作区用的是祖先装下来那一份");
  // 快照必须落在 ancestor **内部**,否则向上查找根本走不到那棵祖先树(RUNS_DIR 固定在 host 下)。
  const patchedTarget = join(ancestor, "data", "runs", "patched.source");
  const patchedSource = await readGateSource(patched, patchedTarget);
  await createGateSnapshot(patched, patchedTarget, patchedSource);
  assert.equal(run(join(patchedTarget, "probe.mjs")), "REGISTRY_1_3_0",
    "仓库里有一份同名的补丁目录,不许据此遮蔽项目实际使用的正式包");
  assert.equal(existsSync(join(patchedTarget, "node_modules", "left-pad")), false,
    "也不许为它在快照里建任何绑定条目");
  assert.equal(await verifyGateSnapshot(patchedTarget, patchedSource), true);

  // 13~15 共用:`.bin/<命令>` 是一条相对链,落点穿过包入口那条链之后落在活源码上。
  // Windows 没开发者模式时文件软链要提权(审查者在真机上踩到 EPERM),退成指向包目录的 junction
  // ——入口形状变成 `.bin/<命令>/cli.mjs`,但「落点在快照之外的活源码」这件事一样,要钉的不变量照样
  // 走到。返回入口相对依赖树根的路径。
  const binEntry = (tree: string, command: string, packageDir: string): string => {
    const path = join(tree, ".bin", command);
    mkdirSync(dirname(path), { recursive: true });
    try {
      symlinkSync(join("..", "@demo", "lib", "cli.mjs"), path, "file");
      return join(".bin", command);
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      linkDir(packageDir, path);
      return join(".bin", command, "cli.mjs");
    }
  };
  const cliProject = (name: string, value: string) => {
    const directory = project(name, ["packages/*"], value);
    save(join(directory, "packages", "lib", "cli.mjs"), `console.log(${JSON.stringify(value)});\n`);
    git(directory, "add", "-A");
    git(directory, "commit", "-qm", "cli entry");
    const tree = join(directory, "node_modules");
    mkdirSync(join(tree, "@demo"), { recursive: true });
    linkDir(join("..", "..", "packages", "lib"), join(tree, "@demo", "lib"));
    return { directory, tree, entry: binEntry(tree, "demo-cli", join(directory, "packages", "lib")) };
  };
  const taskOf = (directory: string, value: string) => {
    const task = join(directory, ".worktrees", "task");
    git(directory, "worktree", "add", "--detach", task, "HEAD");
    save(join(task, "packages", "lib", "index.mjs"), `export const value = ${JSON.stringify(value)};\n`);
    save(join(task, "packages", "lib", "cli.mjs"), `console.log(${JSON.stringify(value)});\n`);
    git(task, "add", "-A");
    git(task, "commit", "-qm", "task");
    return task;
  };

  // ── 13. **运行入口闭包 · 来源证明不了**:任务借用主检出的依赖树,树里有 workspace 链和
  // `.bin/demo-cli -> ../@demo/lib/cli.mjs`,但**没有** npm 的隐藏安装记录(手铺的、非 npm 装的、
  // 记录被删掉的都是这个形状)。
  //
  // 上一版把 CLI 落点当成「未知外部路径」原样保留成主检出的绝对地址。两台机器实测:根 import 已经
  // 是 TASK_NEW,同一份快照里那个 CLI 跑出来是 MAIN_OLD,随后改主检出的源码它跟着变成 MAIN_LIVE,
  // 而快照自证与工作区新鲜度全程为真——「根 import 修好了」和「命令实际跑的是本次提交」可以同时
  // 一真一假。元数据缺失只说明**来源尚未证明**,不是跳过证明的理由:绝不静默保留一个指向活动主检出
  // 的入口,所以这里必须拒绝。
  const bare = cliProject("bare-cli", "MAIN_OLD");
  const bareTask = taskOf(bare.directory, "TASK_NEW");
  linkDir(bare.tree, join(bareTask, "node_modules"));
  const bareTarget = join(bare.directory, "data", "runs", "bare.source");
  const bareSource = await readGateSource(bareTask, bareTarget);
  await assert.rejects(
    createGateSnapshot(bareTask, bareTarget, bareSource),
    /没有 npm 的安装记录/,
    "依赖树没有安装记录时,运行入口的来源无从证明,必须拒绝而不是保留指向主检出的那条入口");
  assert.match(readFileSync(join(bare.directory, "packages", "lib", "cli.mjs"), "utf8"), /MAIN_OLD/,
    "拒绝的那条路上,主检出的源码一个字节都没动");
  assert.equal(realpathSync(join(bare.tree, bare.entry)),
    realpathSync(join(bare.directory, "packages", "lib", "cli.mjs")),
    "工作区那条 CLI 入口也必须原样指着工作区自己的源码");

  // ── 14. **运行入口闭包 · 证明得了就得绑**:同一个布局,依赖树**有** npm 的安装记录,而任务自己
  // 没装依赖(worktree 的常态)。此时「这个入口是本项目自己的包」证明得了,于是 CLI 入口必须和包入口
  // 一样被绑回快照里那份源码——不是「根 import 修好就算隔离成立」。
  //
  // 这条是 F3 真正修好的正面证明:`.bin/demo-cli` 的入口路径和包名毫无关系(`.bin/demo-cli` ≠
  // `@demo/lib`),身份只能由「落点落在哪个自有包**内部**」给出,而绑定要连包内那一段相对路径一起带
  // 过去,否则 CLI 入口会指着一个目录。
  const owned = cliProject("owned-cli", "MAIN_OLD");
  save(join(owned.tree, ".package-lock.json"), JSON.stringify({
    packages: { "node_modules/@demo/lib": { link: true, resolved: "packages/lib" } },
  }));
  const ownedTask = taskOf(owned.directory, "TASK_NEW");
  const ownedTarget = join(owned.directory, "data", "runs", "owned.source");
  const ownedSource = await readGateSource(ownedTask, ownedTarget);
  assert.deepEqual(ownedSource.dependencies, [], "前提:任务自己没装依赖,快照里压根没有依赖树");
  await createGateSnapshot(ownedTask, ownedTarget, ownedSource);
  assert.equal(run(join(ownedTarget, "probe.mjs")), "TASK_NEW", "包入口要解析到快照自己那份源码");
  assert.equal(run(join(ownedTarget, "node_modules", owned.entry)), "TASK_NEW",
    "CLI 入口同样要解析到快照自己那份源码,不许还跑着主检出的旧代码");
  save(join(owned.directory, "packages", "lib", "cli.mjs"), 'console.log("MAIN_LIVE");\n');
  assert.equal(run(join(ownedTarget, "node_modules", owned.entry)), "TASK_NEW",
    "快照建好之后改主检出的源码,同一份快照里那个 CLI 的输出不许跟着变");
  assert.equal(await verifyGateSnapshot(ownedTarget, ownedSource), true);
  git(owned.directory, "restore", "packages/lib/cli.mjs");

  // ── 15. 同样有安装记录,但任务**借了**主检出那棵树(本仓 worktree 借主仓依赖的日常形状)。放法
  // 那一侧会整棵克隆,克隆时就按安装记录把包入口和 CLI 入口一起改写进快照;收口这时无事可做。
  // 钉它是为了防止哪天改动把克隆那一侧的 CLI 改写弄丢,而收口因为「落点已在快照内」也不再过问。
  const borrowed = cliProject("borrowed-cli", "MAIN_OLD");
  save(join(borrowed.tree, ".package-lock.json"), JSON.stringify({
    packages: { "node_modules/@demo/lib": { link: true, resolved: "packages/lib" } },
  }));
  const borrowedTask = taskOf(borrowed.directory, "TASK_NEW");
  linkDir(borrowed.tree, join(borrowedTask, "node_modules"));
  const borrowedTarget = join(borrowed.directory, "data", "runs", "borrowed.source");
  const borrowedSource = await readGateSource(borrowedTask, borrowedTarget);
  assert.deepEqual(borrowedSource.dependencies, ["node_modules"], "前提:任务借了主检出那棵树");
  await createGateSnapshot(borrowedTask, borrowedTarget, borrowedSource);
  assert.equal(run(join(borrowedTarget, "node_modules", borrowed.entry)), "TASK_NEW",
    "借用布局下 CLI 入口也必须落在快照里那份源码上");
  save(join(borrowed.directory, "packages", "lib", "cli.mjs"), 'console.log("MAIN_LIVE");\n');
  assert.equal(run(join(borrowedTarget, "node_modules", borrowed.entry)), "TASK_NEW",
    "改主检出之后同一份快照的 CLI 输出不许跟着变");
  assert.equal(await verifyGateSnapshot(borrowedTarget, borrowedSource), true);

  // ── 16. **消费者那一侧的解析边**。祖先树里正式装着一个第三方包,它传递导入本项目的包;任务
  // worktree 没装依赖。往 `<快照>/node_modules/@demo/lib` 补一条绑定只对「从快照根出发」的解析
  // 有效,而那个第三方包是从**它自己在祖先树里的位置**向上解析的,先命中祖先树里的原入口。
  // 2026-10-27 第三轮独立审查在两台机器上实测:同一份快照里直接 import 得到 TASK_NEW、经那个第
  // 三方包间接 import 得到 MAIN_OLD,随后改主检出的源码它跟着变成 MAIN_LIVE,而快照自证与工作区
  // 新鲜度全程为真。判据是**可证事实**:那棵树上除了本项目自己的包之外还有没有别的入口。
  const consumed = project("consumed", ["packages/*"], "MAIN_OLD");
  dependOn(consumed, { "plain-consumer": `file:${packTarball("plain-consumer", 'export { value } from "@demo/lib";\n')}` });
  npmInstall(consumed);
  save(join(consumed, "transitive.mjs"), 'import { value } from "plain-consumer"; console.log(value);\n');
  git(consumed, "add", "-A");
  git(consumed, "commit", "-qm", "install a third-party consumer");
  const consumedTask = join(consumed, ".worktrees", "task");
  git(consumed, "worktree", "add", "--detach", consumedTask, "HEAD");
  save(join(consumedTask, "packages", "lib", "index.mjs"), 'export const value = "TASK_NEW";\n');
  git(consumedTask, "add", "-A");
  git(consumedTask, "commit", "-qm", "task");

  const consumedTarget = targetIn(consumed);
  const consumedSource = await readGateSource(consumedTask, consumedTarget);
  assert.deepEqual(consumedSource.dependencies, [], "前提:任务工作区没有任何已安装的依赖根");
  await assert.rejects(createGateSnapshot(consumedTask, consumedTarget, consumedSource),
    /既摆着本项目自己的包、又摆着 plain-consumer 这样不属于本项目的入口/,
    "祖先树里有第三方消费者时,根上的绑定证明不了闭包,必须拒绝");
  assert.equal(existsSync(consumedTarget), false, "拒绝的那条路上快照整个丢掉");
  assert.equal(run(join(consumed, "transitive.mjs")), "MAIN_OLD",
    "用户工作区的解析结果一个字节都没被动过");

  // ── 17. 原目录在本次提交里被**删掉**,仓库里另留着一份同名副本。安装记录证明了「这个入口是
  // 自有包」,但它证明不了「提交里那个同名目录就是它搬过去的新位置」——`examples/`、`patches/`
  // 里留一份同名副本是常见布局,绑过去等于把被测代码换成另一份还报绿(第三轮审查按代码指出)。
  // 真正的搬迁一定同步改过声明(用例 9 就是那条正例),所以候选必须由本次提交的声明指向。
  const deleted = project("deleted", ["packages/*"], "CERTIFIED");
  save(join(deleted, "examples", "lib", "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "0.0.0", type: "module", main: "index.mjs" }));
  save(join(deleted, "examples", "lib", "index.mjs"), 'export const value = "UNRELATED_SAMPLE";\n');
  npmInstall(deleted);
  git(deleted, "add", "-A");
  git(deleted, "commit", "-qm", "a same-name sample lives in the repo");
  const deletedTask = join(deleted, ".worktrees", "task");
  git(deleted, "worktree", "add", "--detach", deletedTask, "HEAD");
  git(deletedTask, "rm", "-r", "-q", join("packages", "lib"));
  git(deletedTask, "commit", "-qm", "drop the package, keep the sample");

  const deletedTarget = targetIn(deleted);
  const deletedSource = await readGateSource(deletedTask, deletedTarget);
  await assert.rejects(createGateSnapshot(deletedTask, deletedTarget, deletedSource),
    /没有「声明过、而且同名唯一」的替代位置/,
    "包被删掉、仓库里剩一份同名副本时必须拒绝,不许把安装入口绑到那份无关副本上");

  // ── 18. **已知外部来源**。项目正常 `npm install` 一个住在另一个独立 Git 仓库里的 `file:` 包:
  // 安装记录明确记下它装自项目外,那是一个**已知来源**,不是「来源不明」。第三轮独立审查两平台
  // 实测:只保留「自有包 / 未知」两格时,这种合法布局会被当成未隔离的源码拒掉,门禁报「安装记录
  // 里没有这个入口、请重新安装依赖」,而重装只会得到同一份合法记录——项目永久过不去。外部包由
  // 不由 Git 管理,不改变它是明确外部来源这个事实。
  const vendorRepo = join(root, "vendor-repo");
  mkdirSync(vendorRepo, { recursive: true });
  git(vendorRepo, "init", "-b", "main");
  git(vendorRepo, "config", "user.name", "gate");
  git(vendorRepo, "config", "user.email", "gate@example.test");
  git(vendorRepo, "config", "core.hooksPath", "/dev/null");
  save(join(vendorRepo, "package.json"),
    JSON.stringify({ name: "external-tool", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(vendorRepo, "index.mjs"), 'export const value = "EXTERNAL_OK";\n');
  git(vendorRepo, "add", "-A");
  git(vendorRepo, "commit", "-qm", "external package");

  const consumer = project("consumer", ["packages/*"], "CERTIFIED");
  dependOn(consumer, { "external-tool": "file:../vendor-repo" });
  npmInstall(consumer);
  save(join(consumer, "external-probe.mjs"), 'import { value } from "external-tool"; console.log(value);\n');
  git(consumer, "add", "-A");
  git(consumer, "commit", "-qm", "depend on the external package");

  assert.equal(run(join(consumer, "external-probe.mjs")), "EXTERNAL_OK", "前提:工作区本来就跑得通");
  const consumerTarget = targetIn(consumer);
  const consumerSource = await readGateSource(consumer, consumerTarget);
  const consumerSnapshot = { source: consumerSource, target: consumerTarget };
  await createGateSnapshot(consumer, consumerSnapshot.target, consumerSource);
  assert.equal(run(join(consumerSnapshot.target, "external-probe.mjs")), "EXTERNAL_OK",
    "记录认下的外部 file 包照既定外链策略原样留着,不是「来源不明」");
  assert.equal(run(join(consumerSnapshot.target, "probe.mjs")), "CERTIFIED",
    "同一棵树上本项目自己的包照旧解析到快照里的源码");
  assert.equal(await verifyGateSnapshot(consumerSnapshot.target, consumerSnapshot.source), true);

  console.log("accept-gate-confine: ambient resolution, declaration-independent isolation, "
    + "aliased local packages, same-name third-party provenance, refusal to write through a "
    + "borrowed tree, partial installs, relocated packages, dangling trunks, native link semantics, "
    + "scope-link write ownership, ancestor-install provenance, CLI entry closure, consumer "
    + "resolution edges, deleted-package same-name samples and known external file sources passed");
} finally { rmSync(root, { recursive: true, force: true }); }
