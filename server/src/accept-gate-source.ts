import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileText } from "./exec.js";
import { RUNS_DIR } from "./paths.js";
import { commitAt } from "./task-branch-plan.js";
import { physicalPath } from "./git-worktree-state.js";

type SourceInput = { path: string; directory: boolean };
export type GateSource = { commit: string | null; fingerprint: string; dependencies: string[]; inputs?: SourceInput[] };
const sourceHash = () => createHash("sha256").update("gate-snapshot-v2\0");
const git = async (cwd: string, args: string[]) =>
  (await execFileText("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

async function digestTree(path: string, hash: ReturnType<typeof createHash>, ancestors = new Set<string>()): Promise<void> {
  const canonical = await realpath(path);
  if (ancestors.has(canonical)) throw new Error(`测试输入含循环符号链接：${path}`);
  const info = await stat(path);
  if (info.isFile()) {
    hash.update(`file:${info.mode & 0o111}:`);
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } else if (info.isDirectory()) {
    const next = new Set(ancestors).add(canonical);
    hash.update("directory:");
    for (const name of (await readdir(path)).sort()) {
      hash.update(JSON.stringify(name));
      await digestTree(join(path, name), hash, next);
    }
  } else throw new Error(`测试输入不是普通文件或目录：${path}`);
  hash.update("\0");
}

async function nonGitFiles(cwd: string): Promise<string[]> {
  return (await readdir(cwd)).filter(name => name !== ".git").sort();
}

const runtimePath = (cwd: string, path: string) => inside(physicalPath(cwd), physicalPath(RUNS_DIR))
  && inside(physicalPath(RUNS_DIR), physicalPath(path));

async function listInputs(cwd: string): Promise<SourceInput[]> {
  const inputs: SourceInput[] = [];
  const walk = async (path: string, ancestors: Set<string>) => {
    if (runtimePath(cwd, join(cwd, path))) return;
    const canonical = await realpath(join(cwd, path));
    if (ancestors.has(canonical)) throw new Error(`测试输入含循环符号链接：${path}`);
    const info = await stat(join(cwd, path));
    if (!info.isDirectory() && !info.isFile()) throw new Error(`测试输入不是普通文件或目录：${path}`);
    inputs.push({ path, directory: info.isDirectory() });
    if (info.isDirectory()) for (const name of (await readdir(join(cwd, path))).sort()) {
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
    } else await digestTree(join(cwd, input.path), hash);
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
    const packageDirs = new Set([".", ...paths.filter(path => path.endsWith("package.json")).map(path => dirname(path))]);
    for (const directory of [...packageDirs].sort()) {
      const dep = join(directory, "node_modules");
      try { await lstat(join(cwd, dep)); } catch { continue; }
      dependencies.push(dep);
    }
    const dirty = (await git(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]))
      .split("\0").filter(Boolean).some(row => row.slice(0, 2) !== "??"
        || !dependencies.some(dep => {
          const portable = dep.split(sep).join("/");
          return row.slice(3) === portable || row.slice(3).startsWith(`${portable}/`);
        }));
    if (dirty) throw new Error("任务工作区含未提交或未跟踪文件；请先提交或移走它们，再运行验收前置命令");
    for (const dep of dependencies) {
      hash.update(dep);
      await digestTree(join(cwd, dep), hash);
    }
  } else {
    const inputs = await listInputs(cwd);
    return { commit, fingerprint: await digestInputs(cwd, inputs), dependencies, inputs };
  }
  return { commit, fingerprint: hash.digest("hex"), dependencies };
}

export const gateSnapshotPath = (taskId: string, runId: string) => join(RUNS_DIR, taskId, `accept-gate-${runId}.source`);

export async function createGateSnapshot(cwd: string, target: string, source: GateSource): Promise<void> {
  if ((await readGateSource(cwd)).fingerprint !== source.fingerprint) throw new Error("测试起跑前源码或依赖已变化，请重新验收");
  await mkdir(target, { recursive: true });
  try {
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
        await cp(join(cwd, dep), join(target, dep), { recursive: true, dereference: true });
      }
    } else {
      for (const name of await nonGitFiles(cwd)) {
        await cp(join(cwd, name), join(target, name), { recursive: true, dereference: true,
          filter: path => !runtimePath(cwd, path) });
      }
    }
    if ((await readGateSource(cwd)).fingerprint !== source.fingerprint
      || (await readGateSource(target)).fingerprint !== source.fingerprint) {
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
