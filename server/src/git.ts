import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, isAbsolute, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, statSync, existsSync, readFileSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import type { ProjectHealth } from "@ash/shared";
import { DATA_DIR } from "./paths.js";
import { IS_WINDOWS, windowsLongPathHint } from "./platform.js";
import { assertNotPreviewInstance } from "./preview-instance.js";
import { withRepoLock } from "./repo-lock.js";

const exec = promisify(execFile);

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

const isFile = (p: string) => {
  try { return statSync(p).isFile(); } catch { return false; }
};

// Users type `~/code/foo`, but Node's fs/git APIs don't understand `~` (only
// shells do) — so expand a leading `~` to the home dir before any filesystem
// use. Applied at every repoPath boundary below so `~` works system-wide.
// Windows 上用户会写成 `~\code\foo`，反斜杠是那边的正规分隔符，一并认。
export function expandHome(p: string | null | undefined): string {
  if (!p) return "";
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (IS_WINDOWS && p.startsWith("~\\"))) return join(homedir(), p.slice(2));
  return p;
}

// Canonicalize a repoPath for *storage*: trim, drop trailing slashes, but keep
// `~` intact so the value stays portable/readable in the UI. `/Users/x/foo/`
// and `/Users/x/foo` collapse to the same stored form.
export function tidyRepoPath(p: string | null | undefined): string {
  const t = (p ?? "").trim();
  if (!t) return "";
  if (IS_WINDOWS) {
    // 两种分隔符都要剥，否则 `C:\code\foo\` 和 `C:\code\foo` 会存成两个项目。
    // 唯独盘符根后面那个不能剥：`C:` 在 Windows 上是「C 盘的当前目录」，
    // 跟 `C:\`(C 盘根)是两个完全不同的位置。
    const stripped = t.replace(/[\\/]+$/, "");
    if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
    return stripped || "\\";
  }
  const stripped = t.replace(/\/+$/, "");
  return stripped || "/"; // a path of only slashes is root
}

/**
 * 这条路径在磁盘上的**物理身份**：软链跟到底、大小写按磁盘上的写法。
 *
 * 不存在的路径 `realpath` 会直接抛，所以从最深的那个存在的祖先开始解析，再把剩下的
 * 段接回去。要的是「目录建出来的前后，键不会突然换一个」：仓库还没克隆下来时算出
 * `/tmp/x`、克隆完变成 `/private/tmp/x`，等于同一个仓库前后拿了两把不同的锁。
 */
function physicalPath(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs; // 一路到根都不存在：只能按字面值算
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * 比较两个 repoPath 是不是**同一个仓库**时用的键。空值仍是空：没有仓库路径的项目
 * 不跟任何人合并。
 *
 * 判据必须是**物理身份**，不是字符串长得像不像：`~/code/foo`、`/Users/me/code/foo/`、
 * `/Users/me/code/foo/.`、经由软链的另一条等价路径，指的都是同一个 `.git`。只做
 * 「展开 `~` + 去掉尾斜杠」的话，随便换一种合法写法就能绕过所有按仓库归一的东西——
 * 项目去重会放出一个重复项目，`withRepoLock` 会给同一个仓库开两条队列（并行的验收
 * 撞 index.lock），SCM 门禁则看不见别名项目里正在跑的任务，无 force 的丢弃直接穿透
 * （第 2 轮审查用公共 API 复现）。
 *
 * 所以顺序是：展开 `~` → 去尾斜杠 → 消 `.`/`..` → 跟软链到物理路径。
 *
 * **相对路径也要接 `process.cwd()`**，不能只做词法归一。理由不是「相对路径有意义」，
 * 而是**别处已经这么解释它了**：`POST/PATCH /api/projects` 收得下相对 `repoPath`，而
 * 真正干活的 `git -C <repoPath>` 和 fs 调用都跑在 server 进程里，按的正是 server 的
 * cwd。同一个仓库一个用绝对路径、一个用相对路径登记，落的是同一个物理目录，键却不同
 * ——运行态门禁看不见对面那个在跑的任务，无 force 的丢弃直接穿透（本轮审查用隔离实例
 * 复现）。键从不落库、全是运行时现算，所以「换个 cwd 算出不同键」不会跨进程串味：一个
 * 进程内 cwd 是常量，而键的唯一用途就是在这一个进程里两两比较。
 */
export function repoKey(p: string | null | undefined): string {
  const tidy = tidyRepoPath(expandHome(p));
  if (!tidy) return "";
  return tidyRepoPath(physicalPath(resolve(tidy)));
}

// Guarantee an existing working directory for a run. Prefer the project's
// repoPath; if it is empty/missing — e.g. a pure-discussion duet, or a project
// whose path was never created — fall back to a per-task scratch dir. This keeps
// read-only phases (discussion, repo-less tasks) alive instead of dying with a
// misleading `spawn ENOENT` on a non-existent cwd. Only the write/implement
// phase needs a real git repo (see prepareWorkspace).
export function ensureWorkdir(repoPath: string | null | undefined, taskId: string): string {
  const p = expandHome(repoPath);
  if (p && isDir(p)) return p;
  const scratch = join(DATA_DIR, "scratch", taskId);
  mkdirSync(scratch, { recursive: true });
  return scratch;
}

/**
 * 这个工作目录**属于哪个仓库**：linked worktree 回主仓，主工作树回它自己。不是 git
 * 目录（或 git 跑不起来）时返回 null。
 *
 * 为什么不能拿项目登记的 `repoPath` 顶替：任务实际在哪干活是**会话 cwd 说了算**
 * （`taskFileRoot` 的第一优先级，跟 orchestrator 起跑时的取值一致），而项目的
 * `repoPath` 是随时可以被 PATCH 改掉的一个登记值。两者一分家，「按仓库串行」的写型
 * git 操作就会拿着新仓库的键去锁，实际却在旧仓库里跑 —— 等于没锁（本轮审查复现）。
 *
 * `--git-common-dir` 正是「refs 和 worktree 注册表住在哪」的答案，也就是 `repo-lock.ts`
 * 那条队真正要保护的东西；主工作树里它回相对的 `.git`，所以要接着 dir 解一次。
 */
export async function owningRepoOf(dir: string): Promise<string | null> {
  const p = expandHome(dir);
  try {
    const { stdout } = await exec("git", ["-C", p, "rev-parse", "--git-common-dir"]);
    const common = resolve(p, stdout.trim());
    return basename(common) === ".git" ? dirname(common) : common;
  } catch {
    return null;
  }
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const p = expandHome(repoPath);
  try {
    const { stdout } = await exec("git", ["-C", p, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** 某个工作目录此刻的 HEAD commit；目录不存在/不是 git 目录返回 null。纯只读。 */
export async function headCommit(path: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", expandHome(path), "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** 工作目录是否有未提交改动（含未跟踪文件）；取不到返回 null（调用方按未知处理，不当干净）。
 *  两类未跟踪条目**不算这个项目的改动**，滤掉：
 *  - ash 自己的 `.worktrees/`：本工具放任务 worktree 的惯例位置（不滤的话，项目根跑过
 *    任何 worktree 任务后 dirty 永远 true）。
 *  - 依赖目录 `node_modules`：worktree 里没有它，agent 为了跑 typecheck/build 普遍用
 *    `ln -s` 借主仓那份。而 `.gitignore` 里几乎都写成带尾斜杠的 `node_modules/`——那条
 *    **只匹配目录，匹配不上软链**（git 把软链当文件），于是 `git status` 稳定报 `?? node_modules`，
 *    工作区永远脏。后果不是「多一行提示」：自由工作流据此把刚出炉的审查结论判成过期，
 *    「按意见修复」入口消失、按钮改口「审查新改动」，用户看到的是一次纯误判。 */
export async function workspaceDirty(path: string): Promise<boolean | null> {
  try {
    const { stdout } = await exec("git", ["-C", expandHome(path), "status", "--porcelain"]);
    return stdout.split("\n").some((line) => {
      if (!line.trim()) return false;
      const file = line.slice(3);
      if (file === ".worktrees" || file.startsWith(".worktrees/")) return false;
      // 只放过**未跟踪**的依赖路径；已跟踪文件里真出现 node_modules 变更仍照常算脏。
      if (line.startsWith("??") && file.replace(/\/$/, "").split("/").includes("node_modules")) return false;
      return true;
    });
  } catch {
    return null;
  }
}

// Cheap, synchronous health for a repoPath — exists + is-it-a-git-repo. Drives
// the at-a-glance health dot everywhere a project is listed; no git spawn.
// `.git` is a *file* in worktrees/submodules, so existsSync (not isDir).
export function projectHealthLight(repoPath: string | null | undefined): ProjectHealth {
  const p = expandHome(repoPath);
  const exists = !!p && isDir(p);
  const gitPath = join(p, ".git");
  const isRepo = exists && existsSync(gitPath);
  // A linked worktree (`git worktree add`) keeps `.git` as a FILE pointing back to
  // the main repo; the main working tree keeps `.git` as a DIR. Surface it so the
  // UI can show when a project's working dir is itself a user-managed worktree.
  const isWorktree = isRepo && isFile(gitPath);
  return { exists, isRepo, isWorktree };
}

// Full health — adds current branch + dirty state. Only spawns git when it's
// actually a repo (so a bogus path like /tmp/demo returns instantly).
export async function projectHealthFull(repoPath: string | null | undefined): Promise<ProjectHealth> {
  const light = projectHealthLight(repoPath);
  if (!light.isRepo) return light;
  const p = expandHome(repoPath);
  let branch: string | null = null;
  try {
    const { stdout } = await exec("git", ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"]);
    branch = stdout.trim() || null; // "HEAD" when detached
  } catch { /* leave null */ }
  // 脏判定跟自由工作流走同一口径（见 workspaceDirty）：这颗健康点不该被 ash 自己的
  // `.worktrees/` 和借来的 node_modules 软链点亮。
  const dirty = (await workspaceDirty(p)) ?? false;
  return { ...light, branch, dirty };
}

export interface Workspace {
  path: string;
  branch: string | null;
  isWorktree: boolean;
  // True only when THIS call created an empty worktree on a brand-new branch —
  // i.e. the task's previous work is gone (dir and branch both deleted). Callers
  // that resume an agent's CLI session must break its memory of the old files
  // (see WORKSPACE_RESET in orchestrator.ts): the conversation survives outside
  // the worktree (~/.claude/projects/<escaped cwd>/), so a resumed agent would
  // otherwise keep building on files that no longer exist.
  fresh?: boolean;
  // 请求的 base ref 已经不存在。典型现场：任务验收合并后目标分支被删，几天后用户又在
  // 这个任务里发了一句话 —— 老做法是 `git worktree add` 直接抛 "invalid reference"，
  // 整轮起不来，用户侧只看到「显示已发送，然后没反应」。
  // 调用方拿它写一条持久可见的说明，别让分支基线被悄悄换掉。
  //
  // 这里存的是**三件互相独立的事实**，别再压成一个布尔：曾经用一个 `rebuilt` 同时表示
  // 「新建了工作目录」和「按 used 新建的」，撞上「同名 tag 还在、旧目录没了」时它是 false，
  // 于是同一条时间线先说「已重建为空目录」又说「沿用原有的工作目录」，用户刷新后根本判断
  // 不出这轮到底发生了什么（审查实测）。措辞怎么读这三件事见 run-prompts.ts。
  //   · workspaceRebuilt —— 这一轮新建了工作目录（等价于 `fresh`），而不是复用/接回原有的
  //   · builtFromRequested —— 新建时仍从 requested 起（名字还解析得出提交，比如同名 tag）
  //   · persisted —— 降级结果已由 task-workspace.ts 写回任务登记值；只有落了库，后面的
  //     diff / 验收才会跟着走同一个目标，给用户的说明也才敢那么写
  baseFallback?: {
    requested: string;
    used: string;
    workspaceRebuilt: boolean;
    builtFromRequested: boolean;
    persisted?: boolean;
  };
}

// Resolve where a run executes — and REPORT its git context, never creating
// anything. This is the path for tasks that DIDN'T opt into a worktree. A run
// happens directly in the project's repoPath (or a per-task scratch dir when
// there's no usable git repo — a repo-less discussion or a missing path). We just
// record the current branch and whether that dir is itself a user-managed linked
// worktree, so the UI can surface it. Tasks with `useWorktree=true` go through
// `prepareWorktree` instead — see below.
export async function resolveWorkspace(repoPath: string, taskId: string): Promise<Workspace> {
  const p = expandHome(repoPath);
  if (await isGitRepo(p)) {
    return { path: p, branch: await currentBranch(p), isWorktree: isFile(join(p, ".git")) };
  }
  return { path: ensureWorkdir(repoPath, taskId), branch: null, isWorktree: false };
}

// ── Opt-in per-task worktree (§4) ────────────────────────────────────────────
// The global factory default is ON; creation callers may explicitly override it.
// When ON, runTask materializes
// `<repoPath>/.worktrees/<taskId>` on branch `ash/<id8>` branched off the
// user-picked `base` (null = current HEAD) BEFORE handing the cwd to the agent.
// ash creates worktrees but never removes them on its own — cleanup is a
// one-click UI action.

// Stable derived branch name. taskId is opaque to users but unique; the first
// 8 chars are enough entropy in practice and keep the ref short/legible.
export function worktreeBranchName(taskId: string): string {
  return `ash/${taskId.slice(0, 8)}`;
}

function legacyWorktreeBranchName(taskId: string): string {
  return `harness/${taskId.slice(0, 8)}`;
}

export async function resolveWorktreeBranchName(repoPath: string, taskId: string): Promise<string> {
  const repo = expandHome(repoPath);
  const current = worktreeBranchName(taskId);
  if (await localBranchExists(repo, current)) return current;
  const legacy = legacyWorktreeBranchName(taskId);
  return await localBranchExists(repo, legacy) ? legacy : current;
}

// Conventional location for ash-managed worktrees: a dotfile dir at the repo
// root so it sits next to .git and stays out of the way. Each task gets its own
// subdir keyed by taskId so re-runs of the same task land on the same worktree.
export function worktreePathFor(repoPath: string, taskId: string): string {
  return join(expandHome(repoPath), ".worktrees", taskId);
}

// 半删除的 worktree 残骸。`git worktree remove` 的收尾是「删注册项 → 递归删目录内容 →
// rmdir 顶层」，而它**不删被 .gitignore 掉的东西**（node_modules/dist/日志）：顶层于是
// 撞上 "Directory not empty" 失败，留下一个没有 `.git`、git 也不再认识的空壳。
// 这个空壳是两桩事故的同一个根因：
//   · 验收清理每次重试都撞 "is not a working tree"，任务永远卡在 merged 验收不掉；
//   · prepareWorktree 看见目录还在就当成活 worktree 复用，agent 在里面跑 git，
//     命令一路上溯到主仓 —— 提交和切分支直接打在主仓上。
// 判据只认两条，宁可漏判也不误删：必须在 ash 自己的 `<repo>/.worktrees/` 底下，
// 而且连 `.git` 都没有 —— 还挂着 `.git` 的目录是活工作树（或别人的仓库），不归这里管。
function worktreeLeftoverAt(repoPath: string, path: string): boolean {
  if (!isDir(path) || existsSync(join(path, ".git"))) return false;
  return resolve(dirname(path)) === resolve(join(expandHome(repoPath), ".worktrees"));
}

// 抹掉残骸，顺带 prune 掉 git 那边可能还留着的陈旧注册项。
async function discardWorktreeLeftover(repo: string, path: string): Promise<void> {
  rmSync(path, { recursive: true, force: true });
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
}

// 「这个任务留下的 worktree/分支还在不在」搬到了 ./workspace-cleanup.ts
// (detectTaskWorkspace):删除任务时要连分支一起问,光看目录在不在已经不够。

// List the commits a worktree task produced. The agent's
// commits live on the task's branch since it forked from `base`, so `base..HEAD`
// is exactly them. base = the user-picked ref, else the main repo's current
// branch. Empty when we can't isolate (no worktree / unknown base) — honest, not
// noisy. Capped at 50.
export async function taskCommits(
  worktreePath: string | null | undefined,
  repoPath: string,
  base: string | null | undefined,
): Promise<{ branch: string | null; commits: { sha: string; subject: string; at: string }[] }> {
  const wt = expandHome(worktreePath);
  if (!wt || !isDir(wt)) return { branch: null, commits: [] };
  try {
    const branch = (await currentBranch(wt)) ?? null;
    let baseRef = (base ?? "").trim();
    if (!baseRef) baseRef = (await currentBranch(expandHome(repoPath))) ?? "";
    if (!baseRef || baseRef === branch) return { branch, commits: [] };
    const { stdout } = await exec("git", ["-C", wt, "log", "--format=%H%x1f%s%x1f%cI", "-n", "50", `${baseRef}..HEAD`]);
    const commits = stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, at] = l.split("\x1f");
        return { sha, subject, at };
      });
    return { branch, commits };
  } catch {
    return { branch: null, commits: [] };
  }
}

// Materialize (or reuse) the worktree for this task. Idempotent, and graded by
// how much of the previous work survives:
//   • dir exists         → return as-is (re-run, retry, continue)
//   • dir gone, branch on → RESTORE: `git worktree add <path> <branch>` puts the
//                           agent's files and commits back exactly as they were
//   • dir + branch gone  → `git worktree add -b <branch> <path> [<base>]`, an
//                           EMPTY worktree; flagged `fresh` so resuming callers
//                           can tell the agent its old files are gone
// A dir deleted with plain `rm -rf` leaves a stale registration behind (git still
// lists it, and holds the branch), so prune first — that turns the common
// "I deleted the folder by hand" case back into a clean restore.
// Failures (bad base, .worktrees taken by a non-worktree dir, git permissions)
// throw — the caller (runTask) lets the task settle as failed so the user sees it
// rather than silently falling back to repoPath. `base` is the user-picked ref;
// empty string / null defers to git's default (current HEAD of repoPath).
// ash 把任务 worktree 建在 `<repo>/.worktrees/` —— 那是**用户仓库里的一个目录**，
// 不登记忽略的话 `git status --porcelain` 就永远不空，于是验收的原地合并一律被
// `target_dirty` 挡掉：这个项目从此再也验收不成功。写进 `.git/info/exclude` 而不是
// `.gitignore`：忽略是 ash 自己的实现细节，不该往用户仓库里塞一个待提交的改动。
// 幂等（已有同样一行就不再写），失败只警告——它不该拦住任务开工。
async function ensureWorktreesIgnored(repo: string): Promise<void> {
  const entry = ".worktrees/";
  try {
    // worktree 里的 .git 是文件而不是目录，exclude 只存在于 common dir。
    const commonDir = (await exec("git", ["-C", repo, "rev-parse", "--git-common-dir"])).stdout.trim();
    const gitDir = isAbsolute(commonDir) ? commonDir : join(repo, commonDir);
    const excludePath = join(gitDir, "info", "exclude");
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === entry)) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    writeFileSync(
      excludePath,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}# ash 任务 worktree（本地忽略，不入库）\n${entry}\n`,
    );
  } catch (err) {
    console.warn("[ash] 无法把 .worktrees/ 写进 .git/info/exclude：", err instanceof Error ? err.message : err);
  }
}

/**
 * 「任务登记的那个 base 现在还能当**验收目标**吗」。之所以单独拎出来，是因为它跟「这一次
 * 拿什么建工作目录」是两件事：复用 / 恢复现成 worktree 的路径压根用不到 base —— 可它同时
 * 还是合并目标（diff 与验收各自拿 `tasks.worktreeBase` 再解析一次），只在「建新分支」那条
 * 路上报降级的话，「worktree 还在、base 被删」的任务会一路正常跑，直到用户点验收才撞墙
 * （审查实测：worktree 复用成功，`taskBranchDiff` 仍是 target_branch_missing）。
 *
 * 判据必须是**本地分支还在不在**，跟下游 `git-diff.ts` / `task-accept.ts` 的真实要求对齐，
 * 不能问「还解析得出一个 commit 吗」：仓库里留着一个同名 tag 就会把分支已删这件事整个遮
 * 住 —— `rev-parse feat/x^{commit}` 照样成功，于是这里判定「没过期」，而 diff 和验收查的是
 * `refs/heads/feat/x`，继续 target_branch_missing（审查实测）。「能不能拿它建目录」是另一个
 * 判据（`commitExists`），在 prepareWorktreeLocked 里单独问。
 */
export async function staleBaseFallback(
  repoPath: string,
  base: string | null | undefined,
  // 「这一轮的工作目录是怎么来的」由调用方告诉它 —— 本函数只回答基线还在不在，一个字都
  // 推断不出工作目录的事。默认取「什么都没重建」，因为大多数调用方（refreshTaskBase、
  // 复用/恢复路径）确实没动过目录。
  workspace: Pick<
    NonNullable<Workspace["baseFallback"]>,
    "workspaceRebuilt" | "builtFromRequested"
  > = { workspaceRebuilt: false, builtFromRequested: false },
): Promise<Workspace["baseFallback"]> {
  const repo = expandHome(repoPath);
  const requested = (base ?? "").trim();
  if (!requested) return undefined;
  if (!(await isGitRepo(repo))) return undefined;
  // `refs/heads/main` 这种写法下游会先 normalize 掉前缀再查，这里跟着剥，免得把一个其实
  // 好好的基线判成没了。
  if (await localBranchExists(repo, normalizeBranchName(requested))) return undefined;
  return { requested, used: (await currentBranch(repo)) ?? "HEAD", ...workspace };
}

// 仓库级串行(见 repo-lock.ts):prune/add 改的是全仓共用的 worktree 注册表,
// 两个任务同时起跑就会互相看见对方半成品的注册状态。
export async function prepareWorktree(
  repoPath: string,
  taskId: string,
  base: string | null | undefined,
): Promise<Workspace> {
  return withRepoLock(repoPath, () => prepareWorktreeLocked(repoPath, taskId, base));
}

async function prepareWorktreeLocked(
  repoPath: string,
  taskId: string,
  base: string | null | undefined,
): Promise<Workspace> {
  const repo = expandHome(repoPath);
  if (!(await isGitRepo(repo))) {
    throw new Error(`项目 ${repoPath} 不是 git 仓库，无法创建 worktree`);
  }
  const path = worktreePathFor(repoPath, taskId);
  const branch = await resolveWorktreeBranchName(repo, taskId);
  // 上一次清理留下的空壳（见 worktreeLeftoverAt）先抹掉再说：直接复用它等于让 agent 在
  // 一个不是 worktree 的目录里干活，它的 git 命令会上溯到主仓。清掉之后走下面的恢复
  // 路径，分支还在就把工作原样接回来。
  if (worktreeLeftoverAt(repo, path)) await discardWorktreeLeftover(repo, path);
  // base 的死活先问一遍，再分路：三条路径（复用 / 恢复 / 新建）都要如实报出来，只有
  // 「这一轮的工作目录是怎么来的」各不相同 —— 复用和恢复都没新建目录，用默认值即可。
  const stale = await staleBaseFallback(repo, base);
  if (isDir(path)) {
    // Re-use: read whatever branch the existing worktree is actually on (might
    // differ if the user manipulated it manually). isWorktree=true so callers
    // know it's a linked worktree.
    return {
      path, branch: (await currentBranch(path)) ?? branch, isWorktree: true,
      ...(stale ? { baseFallback: stale } : {}),
    };
  }
  // Drop registrations whose directory is gone. Without this, git still considers
  // the branch "checked out" at the missing path and refuses to touch it.
  await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
  // Ensure parent `<repo>/.worktrees/` exists; git itself won't auto-create it.
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
  await ensureWorktreesIgnored(repo);
  const restore = await branchExists(repo, branch);
  const args = ["-C", repo, "worktree", "add"];
  // 这一轮的工作目录到底是**从 base 起的**，还是退回了仓库当前 HEAD。措辞要照它说话。
  let builtFromBase = false;
  if (restore) {
    // 恢复：工作原样接回任务分支，跟 base 是谁无关（base 只在建分支那一刻用得上）。
    args.push(path, branch);
  } else {
    args.push("-b", branch, path);
    const trimmedBase = (base ?? "").trim();
    // 建目录问的是另一个问题：这个名字还解析得出一个提交吗（`worktree add <base>` 会不会
    // 当场报 "invalid reference"）。它跟上面那个「还能不能当合并目标」不是一回事 —— 同名
    // tag 遮住已删分支时，工作目录照样能从它起，要修的只是验收目标。
    //
    // 一个已经没了的 base 拿去 add 只会换来 "invalid reference" 并让整轮起不来，而这一轮
    // 想做的事（在这个任务里接着说句话）跟 base 是谁其实无关。解析不出来就退回仓库当前
    // HEAD —— 失败关闭在这里是错的方向：用户要的是能接着干活，不是一个精确但起不来的 base。
    builtFromBase = !!trimmedBase && await commitExists(repo, trimmedBase);
    if (builtFromBase) args.push(trimmedBase);
  }
  try {
    await exec("git", args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    // Windows 上这里最常见的失败是撞 MAX_PATH,而 git 只会回一句 "Filename too long",
    // 不说该去开哪两个开关 —— 补上,否则用户只能对着这句干瞪眼(见 platform.ts)。
    const hint = windowsLongPathHint(path, stderr);
    throw new Error(`git worktree add 失败：${stderr}${hint ? `\n${hint}` : ""}`);
  }
  return {
    path, branch, isWorktree: true, fresh: !restore,
    // 走到这里一定新建了工作目录（`fresh`），但「按谁建的」是另一回事：恢复回来的目录跟
    // base 无关，从一个仍解析得出的同名 tag 建出来的也不是「按 used 重建」。两件事各报各的，
    // 别再合并成一个布尔 —— 合并过一次，结果同一回合的时间线自相矛盾（见 baseFallback 注释）。
    ...(stale
      ? { baseFallback: { ...stale, workspaceRebuilt: !restore, builtFromRequested: builtFromBase } }
      : {}),
  };
}

// `git worktree remove [--force] <path>` — wired to the one-click cleanup button
// in the delete-task confirmation. Returns nothing on success; throws with the
// raw git stderr so the UI can surface "dirty, use --force" etc.
export async function removeWorktree(repoPath: string, path: string, force: boolean): Promise<void> {
  // 预览实例上一律拒绝：快照里的任务行指的是**真** worktree，删掉不可逆（见 preview-instance.ts）。
  assertNotPreviewInstance("删 worktree");
  return withRepoLock(repoPath, async () => {
    const repo = expandHome(repoPath);
    // 上一次删到一半留下的残骸：git 已经不认这个目录，再 remove 一次只会回一句
    // "is not a working tree"，重试多少遍都撞同一堵墙。抹掉空壳正是调用方要的结果。
    if (worktreeLeftoverAt(repo, path)) {
      await discardWorktreeLeftover(repo, path);
      return;
    }
    const args = ["-C", repo, "worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    try {
      await exec("git", args);
    } catch (err) {
      // 这次失败是哪一种，看状态而不是报错文本：`.git` 已经没了 = git 那侧删干净了、
      // 只剩 ignored 文件残渣撑着顶层目录，补一刀，别把半删除状态留给下一次；`.git`
      // 还在 = 「工作区脏」这类真拒绝，原样抛上去让用户看见 git 原话再自己决定。
      if (worktreeLeftoverAt(repo, path)) {
        await discardWorktreeLeftover(repo, path);
        return;
      }
      const stderr = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
      throw new Error(stderr);
    }
    // git 报成功、目录却还杵在那儿：同样是 ignored 残渣，顺手抹平。
    if (worktreeLeftoverAt(repo, path)) await discardWorktreeLeftover(repo, path);
  });
}

// ── 分支与合并目标：验收链（git-accept.ts）与 diff/清理都要用的那几句 ─────────

export function gitError(error: unknown): string {
  return ((error as { stderr?: string }).stderr || (error as Error).message || String(error)).trim();
}

export function porcelainFiles(output: string): string[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * 某个工作区里挡路的东西（未提交改动 + 未跟踪文件）。
 *
 * 用在**报错路径**上：删 worktree 被 git 拒时，它只回一句 "contains modified or untracked
 * files"，不说是哪个文件——障碍又不会自己消失，于是用户每重试一次都撞同一堵墙、还是同一句
 * 看不出所以然的话。所以拒绝的同时把清单查出来一起报。查不动就当没有：这已经是报错路径，
 * 再抛一次只会把「worktree 删不掉」换成一句更没头绪的话。
 */
export async function dirtyFilesAt(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "status", "--porcelain"]);
    return porcelainFiles(stdout).sort();
  } catch {
    return [];
  }
}

/** 报错文案里的文件清单：够用来认出是哪几个，又不至于把一屏刷满（全量留在结构化字段里）。 */
export function listFiles(files: string[], limit = 8): string {
  const head = files.slice(0, limit).join("、");
  return files.length > limit ? `${head} 等 ${files.length} 个` : head;
}

export async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** 当前检出的分支名（detached 时 null）。git-accept 判「目标分支在不在项目目录上」要用。 */
export async function symbolicBranch(repo: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function normalizeBranchName(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, "");
}

export async function resolveTaskMergeTarget(
  repoPath: string,
  requested: string | null | undefined,
): Promise<string | null> {
  const explicit = normalizeBranchName(requested ?? "");
  return explicit || symbolicBranch(expandHome(repoPath));
}

// List the project's local branch names (for the new-task form's base picker),
// plus the current branch so the UI can default-select it. Quietly returns
// empty when the path isn't a git repo — the picker degrades to a plain text
// field client-side.
export async function listBranches(repoPath: string): Promise<{ branches: string[]; current: string | null }> {
  const p = expandHome(repoPath);
  if (!(await isGitRepo(p))) return { branches: [], current: null };
  let branches: string[] = [];
  try {
    const { stdout } = await exec("git", ["-C", p, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    branches = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* leave [] */ }
  const current = await currentBranch(p);
  return { branches, current };
}

// Does this local branch exist? Decides restore-vs-create in prepareWorktree.
async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// 这个名字现在还能解析成一个提交吗？分支、tag、远程分支、裸 SHA 一视同仁 —— 问的就是
// `worktree add <base>` 会不会当场报 "invalid reference"。
async function commitExists(repo: string, ref: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// Current branch of a working dir ("HEAD" when detached); null if git can't tell.
async function currentBranch(p: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
