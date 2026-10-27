import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  const frozen = join(root, "frozen");
  save(join(frozen, "packages", "lib", "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(frozen, "packages", "lib", "index.mjs"), 'export const value = "FROZEN";\n');
  linkDir(join("..", "live", "node_modules"), join(frozen, "node_modules"));

  const refused = await confineOwnPackages(frozen);
  assert.match(String(refused), /快照之外.*拒绝/s,
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

  console.log("accept-gate-confine: ambient resolution, declaration-independent isolation, "
    + "aliased local packages, same-name third-party provenance, refusal to write through a "
    + "borrowed tree, partial installs, relocated packages, dangling trunks "
    + "and native link semantics passed");
} finally { rmSync(root, { recursive: true, force: true }); }
