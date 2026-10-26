import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { execFileText } from "./exec.js";
import { RUNS_DIR } from "./paths.js";
import { commitAt } from "./task-branch-plan.js";
import { physicalPath } from "./git-worktree-state.js";
import { DEPENDENCY_DIRS, freezesAsSource, gateTreeDigest, insideTree as inside } from "./accept-gate-tree.js";

type SourceInput = { path: string; directory: boolean };
export type GateSource = { commit: string | null; fingerprint: string; dependencies: string[]; inputs?: SourceInput[] };
const sourceHash = () => createHash("sha256").update("gate-snapshot-v3\0");
const git = async (cwd: string, args: string[]) =>
  (await execFileText("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout;

async function nonGitFiles(cwd: string): Promise<string[]> {
  return (await readdir(cwd)).filter(name => name !== ".git").sort();
}

const runtimePath = (cwd: string, path: string) => inside(physicalPath(cwd), physicalPath(RUNS_DIR))
  && inside(physicalPath(RUNS_DIR), physicalPath(path));

async function listInputs(cwd: string): Promise<SourceInput[]> {
  const inputs: SourceInput[] = [];
  const walk = async (path: string, ancestors: Set<string>) => {
    if (runtimePath(cwd, join(cwd, path))) return;
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(join(cwd, path)); }
    catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    // 会被原样重建的软链登记成叶子:既不跟随也不递归进去(跟随的话目录软链会被当目录整棵拷成
    // 真文件,正是本模块要修的 bug)。判定与 gateTreeDigest 同源,两边必须一致,否则副本里是
    // 真文件、清单里却按链登记,摘要立刻对不上。按源码冻结的外链沿用跟随语义——副本里它就是
    // 一份真文件/真目录,所以环的防护也只在这条路上需要。
    if (info.isSymbolicLink() && !await freezesAsSource(cwd, join(cwd, path))) {
      inputs.push({ path, directory: false });
      return;
    }
    let canonical: string;
    try { canonical = await realpath(join(cwd, path)); }
    catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    if (ancestors.has(canonical)) return;
    const followed = await stat(join(cwd, path));
    if (!followed.isDirectory() && !followed.isFile()) throw new Error(`测试输入不是普通文件或目录：${path}`);
    inputs.push({ path, directory: followed.isDirectory() });
    if (followed.isDirectory()) for (const name of (await readdir(join(cwd, path))).sort()) {
      await walk(join(path, name), new Set(ancestors).add(canonical));
    }
  };
  for (const name of await nonGitFiles(cwd)) await walk(name, new Set());
  return inputs;
}

async function digestInputs(cwd: string, inputs: SourceInput[]): Promise<string> {
  const hash = sourceHash();
  for (const input of inputs) {
    if (!inside(resolve(cwd), resolve(cwd, input.path))) throw new Error("源码输入路径不在快照内");
    hash.update(input.path);
    if (input.directory) {
      if (!(await stat(join(cwd, input.path))).isDirectory()) throw new Error("源码输入目录已变化");
      hash.update("directory\0");
    } else {
      const tree = await gateTreeDigest(join(cwd, input.path), { root: cwd, dependency: false });
      hash.update(tree?.digest ?? "omitted-link");
    }
  }
  return hash.digest("hex");
}

export async function readGateSource(cwd: string): Promise<GateSource> {
  if (physicalPath(cwd) === physicalPath(RUNS_DIR)) throw new Error("项目目录不能与 ash 运行产物目录相同");
  const commit = await commitAt(cwd, "HEAD");
  const hash = sourceHash();
  const dependencies: string[] = [];
  if (commit) {
    const entries = (await git(cwd, ["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean);
    const paths = entries.map(entry => entry.slice(entry.indexOf("\t") + 1));
    if (paths.includes(".gitmodules") || entries.some(entry => entry.startsWith("160000 "))) {
      throw new Error("验收快照暂不支持 Git 子模块；请使用完整源码检出或明确跳过本次门禁");
    }
    hash.update(commit);
    const manifests = /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/;
    const packageDirs = new Set([".", ...paths.filter(path => manifests.test(path)).map(path => dirname(path))]);
    const registered: string[] = [];
    for (const directory of [...packageDirs].sort()) {
      for (const name of DEPENDENCY_DIRS) {
        const dep = join(directory, name);
        try { await lstat(join(cwd, dep)); } catch { continue; }
        registered.push(dep);
      }
    }
    const tracked = new Set(paths);
    const trackedDirs = new Set<string>();
    for (const path of paths) for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) trackedDirs.add(dir);
    // 复制计划 = 登记的依赖目录 + 为了让保留下来的软链在副本里解析得通而必须一起冻结的路径。
    // 消重必须在**最终计划**这一层成立,不能只在最初登记的那一批上成立(嵌套包 + vendor 只是其中
    // 一种形状,闭包补进来的父子路径是另一种):软链重建不像 copyFile 那样幂等,计划里同时有父目录
    // 和它的子路径时,第二遍 symlink 同一个目的地直接 EEXIST,整次快照在任何断言之前就废掉。所以
    // plan 在每一次增删之后都维持「没有任何条目落在另一条之内」,而不是去忽略某一次 EEXIST。
    const plan: string[] = [];
    const digests = new Map<string, string>();
    const addPath = (candidate: string): boolean => {
      if (plan.some(other => inside(join(cwd, other), join(cwd, candidate)))) return false;
      for (const other of plan.filter(other => inside(join(cwd, candidate), join(cwd, other)))) {
        plan.splice(plan.indexOf(other), 1);
        digests.delete(other); // 被父目录吞掉的条目要连摘要一起作废,由父目录那一遍重新算
      }
      plan.push(candidate);
      return true;
    };
    for (const dep of registered) addPath(dep);
    // 「落点在 cwd 之下」不等于「这份内容会出现在快照里」,而且「Git 跟踪着这个**目录**」更不等于
    // 覆盖:
    //  · node_modules -> .local-deps:落点既没被跟踪也不在任何登记的依赖里,照抄链接只会在副本里
    //    留一条断链,命令当场不存在;
    //  · node_modules -> .store,而 .store 里只有 README.md 被提交、真正的安装内容在被忽略的
    //    .store/cache/ 下:Git 只检出 README.md,副本里命令照样不存在,改了安装内容指纹还纹丝不动。
    // 所以覆盖只认两件事:落点正好是一个被跟踪的**文件**(检出即冻结),或者它已经在复制计划里。
    // 落点是被跟踪的目录时,只补「Git 不会检出的那部分」——它下面被忽略的条目;未跟踪条目不在这里
    // 放行,继续由下面的脏树检查拦住。要补的不止落点:原样保留的相对链还需要原文路上的中间链
    // (gateTreeDigest 的 requires 两类都给),否则副本里链断在中途。悬空链不会进来(没有落点)。
    const ignoredUnder = async (path: string): Promise<string[]> =>
      (await git(cwd, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory", "--", path]))
        .split("\0").filter(Boolean)
        .map(entry => (entry.endsWith("/") ? entry.slice(0, -1) : entry).split("/").join(sep));
    for (let index = 0; index < plan.length; index += 1) {
      const dep = plan[index];
      if (digests.has(dep)) continue;
      const tree = await gateTreeDigest(join(cwd, dep), { root: cwd, dependency: true });
      if (!tree) {
        plan.splice(index, 1);
        index -= 1;
        continue;
      }
      digests.set(dep, tree.digest);
      for (const required of tree.requires) {
        if (required === "" || tracked.has(required)) continue;
        if (plan.length >= 512) throw new Error("依赖软链的落点过多，无法冻结测试输入；请检查项目内的软链是否成环");
        const uncovered = trackedDirs.has(required) ? await ignoredUnder(required) : [required.split("/").join(sep)];
        // 计划一旦变动就从头再扫:被吞掉的条目要重新摘要,新进来的条目要补摘要。
        if (uncovered.map(entry => addPath(entry)).some(Boolean)) index = -1;
      }
    }
    dependencies.push(...plan.sort());
    const dirty = (await git(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]))
      .split("\0").filter(Boolean).some(row => row.slice(0, 2) !== "??"
        || !dependencies.some(dep => {
          const portable = dep.split(sep).join("/");
          return row.slice(3) === portable || row.slice(3).startsWith(`${portable}/`);
        }));
    if (dirty) throw new Error("任务工作区含未提交或未跟踪文件；请先提交或移走它们，再运行验收前置命令");
    for (const dep of dependencies) hash.update(dep).update(digests.get(dep) ?? "");
  } else {
    const inputs = await listInputs(cwd);
    return { commit, fingerprint: await digestInputs(cwd, inputs), dependencies, inputs };
  }
  return { commit, fingerprint: hash.digest("hex"), dependencies };
}

export const gateSnapshotPath = (taskId: string, runId: string) => join(RUNS_DIR, taskId, `accept-gate-${runId}.source`);

export async function createGateSnapshot(cwd: string, target: string, source: GateSource): Promise<void> {
  await mkdir(target, { recursive: true });
  try {
    let copiedFingerprint: string | null = null;
    if (source.commit) {
      await execFileText("git", ["clone", "--no-hardlinks", "--dissociate", "--no-checkout", "--", cwd, target]);
      await git(target, ["config", "core.hooksPath", join(target, ".git", "ash-no-hooks")]);
      await git(target, ["checkout", "--detach", source.commit]);
      await git(target, ["remote", "remove", "origin"]);
      const paths = (await git(target, ["ls-tree", "-r", "--name-only", "-z", source.commit])).split("\0").filter(Boolean);
      for (const path of paths) {
        if (!(await lstat(join(target, path))).isSymbolicLink()) continue;
        if (!inside(resolve(target), await realpath(join(target, path)))) throw new Error(`源码符号链接指向快照外：${path}`);
      }
      for (const dep of source.dependencies) {
        await mkdir(dirname(join(target, dep)), { recursive: true });
        await gateTreeDigest(join(cwd, dep), { root: cwd, destinationRoot: target, dependency: true });
      }
      // 对账要读**真实副本**。拿源树那一遍遍历的结果对账只能证明「计划照着做了」,证明不了
      // 「副本里这些输入真的解析得通」——缺了中间链或缺了安装内容的坏副本,源侧算出来的指纹
      // 一模一样,照样能交出去。重新遍历副本则会当场发现那条链在副本里落到了别处或解析不到。
      const copiedHash = sourceHash().update(source.commit);
      for (const dep of source.dependencies) {
        const tree = await gateTreeDigest(join(target, dep), { root: target, dependency: true });
        copiedHash.update(dep).update(tree?.digest ?? "");
      }
      copiedFingerprint = copiedHash.digest("hex");
    } else {
      for (const name of await nonGitFiles(cwd)) {
        await gateTreeDigest(join(cwd, name),
          { root: cwd, destinationRoot: target, dependency: false, filter: path => !runtimePath(cwd, path) });
      }
    }
    if ((await readGateSource(cwd)).fingerprint !== source.fingerprint) {
      throw new Error("复制测试快照期间源码或依赖已变化，请重新验收");
    }
    if ((copiedFingerprint ?? (await readGateSource(target)).fingerprint) !== source.fingerprint) {
      throw new Error("测试快照没能按原样复现测试输入（副本里有软链解析不到它在源树里的目标），请重新验收");
    }
    if (source.inputs) await writeFile(`${target}.inputs.json`, JSON.stringify(source.inputs), { flag: "wx" });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function removeGateSnapshot(taskId: string, runId: string): Promise<void> {
  const path = gateSnapshotPath(taskId, runId);
  await rm(path, { recursive: true, force: true });
  await rm(`${path}.inputs.json`, { force: true });
}

export async function verifyGateSnapshot(cwd: string, source: GateSource): Promise<boolean> {
  try {
    if (!source.commit) {
      const inputs = source.inputs ?? JSON.parse(await readFile(`${cwd}.inputs.json`, "utf8")) as SourceInput[];
      return await digestInputs(cwd, inputs) === source.fingerprint;
    }
    if (await commitAt(cwd, "HEAD") !== source.commit) return false;
    await git(cwd, ["diff", "--no-ext-diff", "--exit-code", "HEAD", "--"]);
    return true;
  } catch { return false; }
}

export function gateSourceMatches(row: { sourceFingerprint?: string | null; sourceCommit: string | null }, source: GateSource | null): boolean {
  return !!source && !!row.sourceFingerprint && row.sourceFingerprint === source.fingerprint && row.sourceCommit === source.commit;
}
