import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { execFileText } from "./exec.js";
import { RUNS_DIR } from "./paths.js";
import { commitAt } from "./task-branch-plan.js";
import { physicalPath } from "./git-worktree-state.js";
import { gateTreeDigest, insideTree as inside } from "./accept-gate-tree.js";

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
  const walk = async (path: string) => {
    if (runtimePath(cwd, join(cwd, path))) return;
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(join(cwd, path)); }
    catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    // 软链按「链本身」登记,既不跟随也不递归进去,与 gateTreeDigest 的遍历语义保持一致:
    // 跟随的话目录软链会被当成目录整棵拷成真文件。不跟随之后环也自然消失,无需 realpath 防护。
    if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`测试输入不是普通文件或目录：${path}`);
    }
    const directory = info.isDirectory();
    inputs.push({ path, directory });
    if (directory) for (const name of (await readdir(join(cwd, path))).sort()) await walk(join(path, name));
  };
  for (const name of await nonGitFiles(cwd)) await walk(name);
  return inputs;
}

async function digestInputs(cwd: string, inputs: SourceInput[]): Promise<string> {
  const hash = sourceHash();
  for (const input of inputs) {
    if (!inside(resolve(cwd), resolve(cwd, input.path))) throw new Error("源码输入路径不在快照内");
    hash.update(input.path);
    if (input.directory) {
      if (!(await lstat(join(cwd, input.path))).isDirectory()) throw new Error("源码输入目录已变化");
      hash.update("directory\0");
    } else hash.update(await gateTreeDigest(join(cwd, input.path), { root: cwd }) ?? "omitted-link");
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
    for (const directory of [...packageDirs].sort()) {
      for (const name of ["node_modules", ".venv", "vendor", "target"]) {
        const dep = join(directory, name);
        try { await lstat(join(cwd, dep)); } catch { continue; }
        dependencies.push(dep);
      }
    }
    const dirty = (await git(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]))
      .split("\0").filter(Boolean).some(row => row.slice(0, 2) !== "??"
        || !dependencies.some(dep => {
          const portable = dep.split(sep).join("/");
          return row.slice(3) === portable || row.slice(3).startsWith(`${portable}/`);
        }));
    if (dirty) throw new Error("任务工作区含未提交或未跟踪文件；请先提交或移走它们，再运行验收前置命令");
    for (const dep of [...dependencies]) {
      const digest = await gateTreeDigest(join(cwd, dep), { root: cwd });
      if (digest === null) dependencies.splice(dependencies.indexOf(dep), 1);
      else hash.update(dep).update(digest);
    }
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
        const digest = await gateTreeDigest(join(cwd, dep), { root: cwd, destinationRoot: target });
        if (digest !== null) copiedHash.update(dep).update(digest);
      }
      copiedFingerprint = copiedHash.digest("hex");
    } else {
      for (const name of await nonGitFiles(cwd)) {
        await gateTreeDigest(join(cwd, name), { root: cwd, destinationRoot: target, filter: path => !runtimePath(cwd, path) });
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
