import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileText } from "./exec.js";
import { RUNS_DIR } from "./paths.js";
import { commitAt } from "./task-branch-plan.js";
import { physicalPath } from "./git-worktree-state.js";
import { freezesAsSource, gateTreeDigest, insideTree as inside } from "./accept-gate-tree.js";
import { copyTree, DEPENDENCY_DIRS, dependencyDigest, dependencyMismatch, needsIsolation,
  provideDependency, workspacePackages, type DependencyMode } from "./accept-gate-deps.js";

type SourceInput = { path: string; directory: boolean; dependency?: boolean };
export type GateSource = { commit: string | null; fingerprint: string; dependencies: string[]; inputs?: SourceInput[] };
const sourceHash = () => createHash("sha256").update("gate-snapshot-v3\0");
const git = async (cwd: string, args: string[]) =>
  (await execFileText("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout;

async function nonGitFiles(cwd: string): Promise<string[]> {
  return (await readdir(cwd)).filter(name => name !== ".git").sort();
}

// 运行目录(ash 的 runs)落在项目内时,它既不是测试输入、也不能跟着进副本——快照自己就住在那
// 里面,复制它等于让快照把自己复制进自己。但排除**只在源侧做**不行:clone/checkout 会把运行目录
// 里被跟踪的文件照样写进副本,副本回算再不过滤就必然看到源摘要里没有的输入,项目什么也没改也会
// 被判「没能按原样复现」。所以排除项按**相对路径**记一次,源摘要、复制、副本回算各按自己的根
// 解释同一份计划;**不能**把「在源 RUNS_DIR 之下」这个物理 predicate 生搬到副本上——副本自己就
// 住在源的 RUNS_DIR 里,那个 predicate 在副本一侧永远为假,于是只有源侧被过滤掉。
const excludedInputs = (root: string): string[] => {
  const runs = physicalPath(RUNS_DIR);
  return inside(physicalPath(root), runs) ? [relative(physicalPath(root), runs)] : [];
};
const planFilter = (root: string, excluded: string[]) => (path: string) =>
  !excluded.some(rel => inside(join(root, rel), path));

async function listInputs(cwd: string): Promise<SourceInput[]> {
  const inputs: SourceInput[] = [];
  const included = planFilter(cwd, excludedInputs(cwd));
  const walk = async (path: string, ancestors: Set<string>) => {
    if (!included(join(cwd, path))) return;
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(join(cwd, path)); }
    catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    // 依赖目录按**产物**登记:只记它自己、不递归进去,身份取安装声明(见 accept-gate-deps)。
    // 放在软链判定**之前**:node_modules -> .store 这种把整个依赖目录做成一条链的布局,按依赖
    // 借用才是这一层的意图,按链登记会让它继续走「原样重建 + 落点要在副本里」那条老路。非 Git
    // 项目一视同仁,否则这一层的收益只有 Git 项目拿得到。
    if (DEPENDENCY_DIRS.includes(basename(path))
      && (await stat(join(cwd, path)).catch(() => null))?.isDirectory()) {
      inputs.push({ path, directory: true, dependency: true });
      return;
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
    if (input.dependency) {
      hash.update("dependency\0").update(await dependencyDigest(cwd, input.path));
    } else if (input.directory) {
      if (!(await stat(join(cwd, input.path))).isDirectory()) throw new Error("源码输入目录已变化");
      hash.update("directory\0");
    } else {
      hash.update(await gateTreeDigest(join(cwd, input.path), { root: cwd }) ?? "omitted-link");
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
    // 登记要借用的依赖目录。嵌套包各自那一份也登记，但被**已登记项包住**的要去掉：借用是在快照
    // 里建一条链，父目录一旦换成链，子路径就落到工作区那一份里去了，再往那个位置建第二条链毫无
    // 意义（也会 EEXIST）。"." 排在最前，所以父目录总是先登记。
    const registered: string[] = [];
    for (const directory of [...packageDirs].sort()) {
      for (const name of DEPENDENCY_DIRS) {
        const dep = join(directory, name);
        try { await lstat(join(cwd, dep)); } catch { continue; }
        if (registered.some(other => inside(join(cwd, other), join(cwd, dep)))) continue;
        registered.push(dep);
      }
    }
    dependencies.push(...registered.sort());
    // 未跟踪内容只在**登记的依赖目录之内**被放过。这里有一处相对旧口径的**收窄**:以前靠闭包
    // 把「node_modules -> .local-deps」那种落点补登记成输入,于是一个未跟踪、也没进 .gitignore
    // 的目录被默许;现在它和任何未跟踪文件一样被拒。这是有意的——依赖是产物,产物本来就该在
    // .gitignore 里;放过它等于让门禁在一个谁也没声明过的目录上运行,既不冻结也不登记它的内容。
    // 钉在 test-accept-gate-borrow.ts「依赖根自己就是一条链」的第三种落点上。
    const dirty = (await git(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]))
      .split("\0").filter(Boolean).some(row => row.slice(0, 2) !== "??"
        || !dependencies.some(dep => {
          const portable = dep.split(sep).join("/");
          return row.slice(3) === portable || row.slice(3).startsWith(`${portable}/`);
        }));
    if (dirty) throw new Error("任务工作区含未提交或未跟踪文件；请先提交或移走它们，再运行验收前置命令");
    // 依赖的身份取**安装声明**，不取 4.5 万个文件的字节——口径、检得出什么、漏检什么，全写在
    // accept-gate-deps 的 dependencyDigest 上方。这里一并换掉的是曾经那一整套为了「把依赖拷进
    // 快照之后、它里面的链还解析得通」而存在的闭包机器：落点补齐、中间链收集、规模预算、父子
    // 消重。依赖改成借用、根本不拷进来之后，它们一条理由都不剩了。
    for (const dep of dependencies) hash.update(dep).update(await dependencyDigest(cwd, dep));
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
    // 依赖怎么放由项目**声明**的 workspace 包决定（判据和理由见 accept-gate-deps 顶部）：声明了
    // 就整棵克隆进快照，没声明才借一条链。
    const workspace = await workspacePackages(cwd);
    const provided = new Map<string, DependencyMode>();
    // 依赖这边的复制遍历与源码那边共用同一份排除计划:运行产物目录是可配的,它落在依赖目录内时,
    // 不过滤就会把正在建的快照自己拷进来(见 copyTree 的「目标不进入输入闭包」)。深拷退路同样要
    // 带上它——否则 fallback 一走就把刚挡住的东西放回来了。
    // 排除项按**相对路径**记一次,但谓词要能认两种根:源码那一侧的遍历从调用方给的 cwd 出发,依赖
    // 克隆却是从 realpath 过的树根出发(根自己可能就是一条链)。只按未解析的 cwd 拼前缀,在任何
    // 路径祖先里有软链的机器上都对不上——macOS 的 /var -> /private/var 必然命中,于是运行产物在
    // 依赖那一侧完全没被排除,遍历直接走进正在建的快照自己。
    const excluded = excludedInputs(cwd);
    const includedAsGiven = planFilter(cwd, excluded);
    const includedPhysical = planFilter(await realpath(cwd).catch(() => cwd), excluded);
    const included = (path: string) => includedAsGiven(path) && includedPhysical(path);
    const snapshotRoot = await realpath(target).catch(() => target);
    const provide = async (dep: string): Promise<void> => {
      const mode = await provideDependency(cwd, target, dep, needsIsolation(dep, workspace), workspace,
        path => !included(path));
      if (mode === false) {
        await copyTree(join(cwd, dep), join(target, dep), { skip: path => !included(path), snapshotRoot });
      } else provided.set(dep, mode);
    };
    let copiedFingerprint: string | null = null;
    if (source.commit) {
      await execFileText("git", ["clone", "--no-hardlinks", "--dissociate", "--no-checkout", "--", cwd, target]);
      await git(target, ["config", "core.hooksPath", join(target, ".git", "ash-no-hooks")]);
      await git(target, ["checkout", "--detach", source.commit]);
      await git(target, ["remote", "remove", "origin"]);
      const paths = (await git(target, ["ls-tree", "-r", "--name-only", "-z", source.commit])).split("\0").filter(Boolean);
      // 比较基准也必须规范化:落点是 realpath 出来的,拿没规范化的快照路径去比,只要路径祖先里有
      // 一条软链(macOS 的 /var -> /private/var、用户把 repo 放在软链目录下都是),每一条合法的
      // 跟踪软链都会被误判成「指向快照外」,整个门禁对带软链的仓库直接不可用。规则本身不变。
      const snapshotRoot = await realpath(target);
      for (const path of paths) {
        if (!(await lstat(join(target, path))).isSymbolicLink()) continue;
        if (!inside(snapshotRoot, await realpath(join(target, path)))) throw new Error(`源码符号链接指向快照外：${path}`);
      }
      // ── 依赖:上面那条「源码软链不许指向快照外」的**明确例外**,就写在它旁边。
      // 借用形态下 node_modules 这类目录是一条**故意**落在快照外的链(指向工作区那一份)。两者
      // 判据不同,所以这是例外而不是漏洞:上面那条管的是**被 Git 跟踪的源码**——源码指到快照外
      // 就意味着「改了项目外的文件却能复用上次通过」,那正是门禁要拦的;依赖是 lockfile 的产物,
      // 身份由安装声明给出(dependencyDigest),不靠「冻住字节」来保证。
      // **顺序不能换**:那条检查必须在放依赖之前跑完。借用之后 join(target, path) 会穿过链看到
      // 工作区那一份,vendor/ 里被提交的软链就会被误判成「指向快照外」,而它其实没有问题。
      for (const dep of source.dependencies) {
        // 被跟踪的依赖目录(Go 的 vendor 常被提交)checkout 已经写出来了,放依赖要把它换掉:测试
        // 真正会用的是工作区那一份,而两者内容一致由上面的 dirty 检查保证(工作树必须干净)。
        await rm(join(target, dep), { recursive: true, force: true });
        await provide(dep);
      }
      const copiedHash = sourceHash().update(source.commit);
      for (const dep of source.dependencies) copiedHash.update(dep).update(await dependencyDigest(target, dep));
      copiedFingerprint = copiedHash.digest("hex");
    } else {
      // 非 Git 项目:依赖同样按声明放,源码逐条拷(软链按链重建)。源码那一遍必须避开依赖的位置
      // ——inside 对目录自身也成立,所以依赖目录本身和它下面的一切都归 provide 负责。
      const dependencies = (source.inputs ?? []).filter(input => input.dependency).map(input => input.path);
      for (const dep of dependencies) await provide(dep);
      for (const name of await nonGitFiles(cwd)) {
        await gateTreeDigest(join(cwd, name), {
          root: cwd,
          destinationRoot: target,
          filter: path => included(path) && !dependencies.some(dep => inside(join(cwd, dep), path)),
        });
      }
    }
    // 依赖这一侧的对账排在这里,而不是紧跟各自的构造:**源码和依赖都落盘之后**才有东西可对。
    // 克隆形态要解析快照里的 workspace 包,那条路径由源码提供——非 Git 分支曾经在拷源码之前对
    // 账,于是任何 monorepo 都在门禁开跑前就失败。对的是落点不是摘要(摘要在借用形态下恒等,
    // 证明不了任何事);三种形态各自要对的那件事写在 dependencyMismatch 上方。
    for (const [dep, mode] of provided) {
      const problem = await dependencyMismatch(cwd, target, dep, mode, workspace);
      if (problem) throw new Error(`测试快照里的依赖没放对：${problem}`);
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
