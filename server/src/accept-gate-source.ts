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
    // 被另一条依赖包住的目录不再单独登记(嵌套包 + vendor 就是这个形状)。重复拷贝在旧实现里
    // 只是重复 copyFile(覆盖,无害),软链重建却不是幂等的:第二遍 symlink 同一路径直接 EEXIST,
    // 整次快照在任何断言之前就废掉。所以要在**复制计划**这一层消重,而不是去忽略某一次 EEXIST。
    dependencies.push(...registered.filter(dep =>
      !registered.some(other => other !== dep && inside(join(cwd, other), join(cwd, dep)))));
    const trackedDirs = new Set<string>();
    for (const path of paths) for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) trackedDirs.add(dir);
    const tracked = new Set(paths);
    const digests = new Map<string, string>();
    // 「落点在 cwd 之下」不等于「这份内容会出现在快照里」:项目把依赖装在别处再软链过来时
    // (node_modules -> .local-deps),落点既没被 Git 跟踪也不在任何登记的依赖里,照抄链接只会在
    // 快照里留一条断链,命令当场不存在。所以这里按落点求闭包:缺的落点补登记成输入,跟着一起
    // 摘要和复制,链接重建后自然指向副本自己那份。本来就悬空的链接不会进来(lstat 就没过)。
    for (let index = 0; index < dependencies.length; index += 1) {
      const dep = dependencies[index];
      const tree = await gateTreeDigest(join(cwd, dep), { root: cwd, dependency: true });
      if (!tree) {
        dependencies.splice(index, 1);
        index -= 1;
        continue;
      }
      digests.set(dep, tree.digest);
      for (const landing of tree.landings) {
        const covered = landing === "" || tracked.has(landing) || trackedDirs.has(landing)
          || dependencies.some(other => inside(join(cwd, other), join(cwd, landing)));
        if (covered) continue;
        if (dependencies.length >= 512) throw new Error("依赖软链的落点过多，无法冻结测试输入；请检查项目内的软链是否成环");
        dependencies.push(landing.split("/").join(sep));
      }
    }
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
      const copiedHash = sourceHash().update(source.commit);
      for (const dep of source.dependencies) {
        await mkdir(dirname(join(target, dep)), { recursive: true });
        const tree = await gateTreeDigest(join(cwd, dep), { root: cwd, destinationRoot: target, dependency: true });
        if (tree) copiedHash.update(dep).update(tree.digest);
      }
      copiedFingerprint = copiedHash.digest("hex");
    } else {
      for (const name of await nonGitFiles(cwd)) {
        await gateTreeDigest(join(cwd, name),
          { root: cwd, destinationRoot: target, dependency: false, filter: path => !runtimePath(cwd, path) });
      }
    }
    if ((await readGateSource(cwd)).fingerprint !== source.fingerprint
      || (copiedFingerprint ?? (await readGateSource(target)).fingerprint) !== source.fingerprint) {
      throw new Error("复制测试快照期间源码或依赖已变化，请重新验收");
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
