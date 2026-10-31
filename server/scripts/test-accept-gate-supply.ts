import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 「任务 worktree、一个依赖都没装」—— worktree 全局默认开启、node_modules 被 gitignore，所以这是
// **标准路径**。本文件钉住的是它从「隔离证明必然失败」变成「可证隔离且绿」，根因与两条路线的实测
// 对照写在 server/src/accept-gate-supply.ts 顶部。
//
// 改动前的实际行为(2026-10-31 在本仓两例现场上复现,日志在 data/runs/pSOUguRfv-Ie 与
// data/runs/W54czudPJ9Q9):快照自己没有依赖树 → node 按快照所在位置向上找到主检出那棵 →
// 解析根在快照外 → 不变量③(消费者闭包)拒绝,门禁「起不来」,一个测试都没跑。
//
// **这个文件不放宽任何判据**:不变量③原样保留(它那几条拒绝由 test-accept-gate-plan/-confine/-proof
// 继续钉着),这里补的是让标准路径**能被证明**隔离——给快照一棵自己的依赖树。所以断言的重点不是
// 「门禁不再拒绝」,而是「隔离真的成立」:直接 import、经第三方包传递 import、以及改动参考检出之后
// 的输出,三条都必须是本次提交那一份。
//
// RUNS_DIR 在模块 import 时就固化了,所以「runs 在仓库内 / 在仓库外」两种摆法各要一个进程:主进程
// 跑仓库内(生产默认形状),再 spawn 自己一次跑仓库外(路线①的摆法)。后者是为了证明这个修法**不依赖
// 快照恰好落在仓库内**那条偶然的祖先链 —— 那条链一旦移走,旧实现连第三方包都解析不到。
const outside = process.env.GATE_SUPPLY_OUTSIDE === "1";
const root = realpathSync(mkdtempSync(join(tmpdir(), "ash-gate-supply-")));
const runsHome = outside ? realpathSync(mkdtempSync(join(tmpdir(), "ash-gate-supply-runs-"))) : null;

const save = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const npm = (cwd: string, ...args: string[]) => execFileSync(
  process.platform === "win32" ? "cmd.exe" : "npm",
  process.platform === "win32" ? ["/d", "/s", "/c", `npm ${args.map(arg => JSON.stringify(arg.replace(/\\/g, "/"))).join(" ")}`] : args,
  { cwd, encoding: "utf8", windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const install = (cwd: string, ...args: string[]) =>
  npm(cwd, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...args);
const commit = (cwd: string) => { git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "fixture"); };
/** 一个真实的第三方 tarball。传递 import 自有包,正是不变量③当初拒绝的那个形状。 */
const pack = (name: string, body: string, fields: object = {}) => {
  const cwd = join(root, `pack-${name}`);
  save(join(cwd, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.mjs", ...fields }));
  save(join(cwd, "index.mjs"), body);
  return join(cwd, npm(cwd, "pack", "--offline", "--ignore-scripts", "--silent").split(/\r?\n/).pop()!);
};
const project = (name: string, fields: object = {}) => {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Gate Supply Test");
  git(cwd, "config", "user.email", "supply@example.test");
  git(cwd, "config", "core.autocrlf", "false");
  save(join(cwd, ".gitignore"), "node_modules\ndata/\n.worktrees/\n");
  save(join(cwd, "package.json"), JSON.stringify({ name, version: "1.0.0", private: true, ...fields }));
  return cwd;
};
const ownPackage = (cwd: string, directory: string, value: string) => {
  save(join(cwd, directory, "package.json"),
    JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module", main: "index.mjs" }));
  save(join(cwd, directory, "index.mjs"), `export const value = ${JSON.stringify(value)};\n`);
};
/** 从这个目录真的 import 一次,拿到的是哪份源码。隔离成立与否只认它。 */
const probe = (cwd: string, spec: string) => execFileSync(process.execPath,
  ["--input-type=module", "-e", `import(${JSON.stringify(spec)}).then(m=>console.log(m.value))`],
  { cwd, encoding: "utf8" }).trim();

process.env.ASH_RUNS_DIR = join(runsHome ?? join(root, "monorepo"), "data", "runs");
const { createGateSnapshot, gateSnapshotPath, gateSourceMatches, readGateSource, verifyGateSnapshot } =
  await import("../src/accept-gate-source.js");
const { referenceCheckout, dependencySupply } = await import("../src/accept-gate-supply.js");

const where = outside ? "runs 在仓库外" : "runs 在仓库内";
try {
  // ── 主场景:monorepo 主检出装好依赖,任务 worktree 一个包都没装。
  const consumer = pack("plain-consumer", 'export { value } from "@demo/lib";\n');
  const host = project("monorepo", { workspaces: ["packages/*"], dependencies: { "plain-consumer": `file:${consumer}` } });
  ownPackage(host, "packages/lib", "MAIN_OLD");
  save(join(host, "probe.mjs"), 'export { value } from "@demo/lib";\n');
  install(host);
  commit(host);
  // 主检出多装一个本次提交用不到的包:现场里 @babel/code-frame 就是这个角色(拒绝说明点名的
  // 正是它)。门禁不该因为「主检出比本次提交多装了一个包」就拒绝 —— 那是开发者本地的正常状态。
  install(host, `file:${pack("stale-extra", "export const value = 1;\n")}`, "--no-save");

  const task = join(host, ".worktrees", "task");
  git(host, "worktree", "add", "--detach", "-q", task, "HEAD");
  ownPackage(task, "packages/lib", "TASK_NEW");
  commit(task);
  assert.equal(existsSync(join(task, "node_modules")), false, "前提:任务工作区一个依赖都没装");

  // 参考检出认得出来,而且补的是「工作区空着、参考检出装了」的那几个位置。
  assert.equal(await referenceCheckout(task), realpathSync(host), "worktree 任务的参考检出是同仓主工作树");
  assert.equal(await referenceCheckout(host), null, "任务本身就在主工作树里时没有别处可取");

  const source = await readGateSource(task);
  assert.deepEqual(source.dependencies, ["node_modules"], "工作区空着的那棵依赖树被登记进快照计划");
  assert.deepEqual(source.supplied?.map(item => item.path), ["node_modules"], "它的来源记在 supplied 上");
  assert.equal(source.supplied?.[0].from, join(realpathSync(host), "node_modules"), "来源就是参考检出那一份");

  const target = gateSnapshotPath("supply", "r1");
  await createGateSnapshot(task, target, source);

  // ① 快照有**自己**的一棵树:克隆,不是借出去的一条链。借一条链出去等于把解析根放回参考检出。
  assert.equal(lstatSync(join(target, "node_modules")).isSymbolicLink(), false, `${where}:补来的依赖必须克隆,不能是链`);
  assert.ok(realpathSync(join(target, "node_modules")).startsWith(realpathSync(target)),
    `${where}:依赖树的落点必须在快照内,否则解析根还在外面`);

  // ② 直接 import 拿到本次提交。
  assert.equal(probe(target, "./probe.mjs"), "TASK_NEW", `${where}:自有包解析到快照这份源码`);
  // ③ **经第三方包传递 import** 也拿到本次提交 —— 这正是不变量③当初拒绝的那条边(它从自己在树里
  //    的位置向上解析,快照根上补的绑定对它无效)。现在整棵树都在快照里,那条边自然落在快照内。
  assert.equal(probe(target, "plain-consumer"), "TASK_NEW",
    `${where}:第三方包传递 import 也必须落在快照这份源码上(不变量③原本拒绝的那条边)`);

  // ④ 隔离的硬证明:快照建好之后改参考检出的源码,快照的输出**不许**跟着变。
  ownPackage(host, "packages/lib", "MAIN_LIVE");
  assert.equal(probe(target, "./probe.mjs"), "TASK_NEW", `${where}:改了参考检出,快照输出不许跟着变`);
  assert.equal(probe(target, "plain-consumer"), "TASK_NEW", `${where}:传递 import 这条边同样不许跟着变`);
  assert.equal(readFileSync(join(host, "packages", "lib", "index.mjs"), "utf8").includes("MAIN_LIVE"), true,
    "参考检出的工作区本身没被门禁动过");
  ownPackage(host, "packages/lib", "MAIN_OLD");

  // ⑤ 自证照旧成立:补依赖不该让「副本按原样复现了测试输入」这道核验失败。
  assert.equal(await verifyGateSnapshot(target, source), true, `${where}:补来的依赖目录要进收尾豁免范围`);

  // ⑥ 身份绑定:参考检出装/删/升级任何一个包都会让旧的通过记录失效。按工作区位置读身份会落到
  //    「不可达」那一支,两棵内容不同的参考树摘出同一个值 —— 失败方向是报绿。
  const credential = { sourceFingerprint: source.fingerprint, sourceCommit: source.commit, sourceAmbient: source.ambient };
  assert.equal(gateSourceMatches(credential, source), true, "同一份输入上凭据可用");
  install(host, `file:${pack("late-arrival", "export const value = 2;\n")}`, "--no-save");
  const upgraded = await readGateSource(task);
  assert.notEqual(upgraded.fingerprint, source.fingerprint, "参考检出装了新包就不再是同一份输入");
  assert.equal(gateSourceMatches(credential, upgraded), false, "旧的绿结果不许被当成同一份输入沿用");

  // ⑦ 只补**空位**。位置上有东西(这里是一条悬空链)一律不碰:那些形态各有既定处理,补一份进去
  //    等于替用户改布局。
  const occupied = join(host, ".worktrees", "occupied");
  git(host, "worktree", "add", "--detach", "-q", occupied, "HEAD");
  symlinkSync(join(occupied, "never-installed"), join(occupied, "node_modules"));
  assert.deepEqual(await dependencySupply(occupied, ["."], []), [], "位置上有悬空链时不补");

  // ⑧ 参考检出压根没装过依赖时**不编**:补不出来就什么都不补,由隔离证明那一层照旧处理。
  const bare = project("bare", { workspaces: ["packages/*"] });
  ownPackage(bare, "packages/lib", "NEVER_INSTALLED");
  commit(bare);
  const bareTask = join(bare, ".worktrees", "task");
  git(bare, "worktree", "add", "--detach", "-q", bareTask, "HEAD");
  assert.deepEqual(await dependencySupply(bareTask, ["."], []), [], "参考检出没有安装树时不补");
  assert.deepEqual((await readGateSource(bareTask)).supplied, [], "也不会凭空登记一条来源");

  console.log(`accept-gate-supply(${where}): worktree 未装依赖 → 快照自带依赖树、直接与传递 import 均落在本次提交、`
    + `改参考检出不影响、身份绑定、只补空位、无参考安装不编 通过`);
} finally {
  rmSync(root, { recursive: true, force: true });
  if (runsHome) rmSync(runsHome, { recursive: true, force: true });
}

// 仓库外那一遍:换一个进程重跑同一套(RUNS_DIR 在 import 时固化,同进程换不掉)。
if (!outside) {
  // 继承父进程的 loader 参数而不是写死 `--import tsx`:任务 worktree 里没有 node_modules(本测试
  // 要修的正是这件事),那时 tsx 只能按绝对路径传进来,写死就 spawn 不起来。
  const result = execFileSync(process.execPath, [...process.execArgv, new URL(import.meta.url).pathname],
    { env: { ...process.env, GATE_SUPPLY_OUTSIDE: "1" }, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] });
  void result;
}
