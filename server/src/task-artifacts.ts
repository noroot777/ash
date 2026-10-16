import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import type { WorkspaceRoot } from "./file-browser.js";
import { readFileGitStatus } from "./file-git-status.js";
import { taskBranchChangedPaths } from "./git-diff.js";
import { kindOf, scanIgnoredArtifacts, type ArtifactKind } from "./task-artifact-scan.js";
import { committedInWindows, resolveArtifactScope, withinWindows } from "./task-artifact-scope.js";

// 「这个任务做出来的、值得看一眼的东西」——图片、网页、音视频、PDF。
//
// 跟文件树、改动面板刻意不是同一个问题：那两个回答「工作目录里现在有什么」和「代码
// 改了哪几行」，而这里回答「跑完这一趟，产出了什么可以直接看的东西」。所以判据是两条
// 叠加：**这个文件是这个任务弄出来的**，而且**它是拿来看的、不是拿来读 diff 的**。
//
// 「是这个任务弄出来的」有三个互不重叠的证据来源，缺一不可：
//   • working   —— 还在工作目录里没提交（git status 的未跟踪/已修改/已暂存）；
//   • committed —— 已经提交（有任务分支时按那条分支相对合入目标的那一段；共享主仓的任务
//     没有自己的分支，退回「落在运行区间里的提交」）。仓库约定是改完立即提交，所以**绝
//     大多数产物落在这一档**，只看 git status 会几乎全漏；
//   • ignored   —— 被 .gitignore 挡着（output/、dist/…）。git 两条线都看不见它，只能扫
//     文件系统。
//
// **归属强弱分两档，决定了要不要再问时间**（判据本体在 `task-artifact-scope.ts`）：
//   • 目录独占（任务自己或它跟随的那个任务的 worktree）—— 目录就是归属证据，三档都不问
//     时间。这一档必须不设上限：哨兵起的后台渲染可以在回合收尾二十分钟后才落盘，拿「回合
//     结束 + 宽限」去卡它，真做出来的东西反而消失（第 1 轮审查 F3）。
//   • 共享工作区（`useWorktree=false`，直接在项目主仓干活）—— 唯一的线索是时间，于是
//     working 和 ignored 两档都要求文件落在「它在写这个目录」的那几段里。**committed 不
//     再问 mtime**：那一档的路径本来就是按提交时刻挑出来的，再拿 mtime 卡一遍只会把后来
//     被别的分支 checkout 刷过时间的文件漏掉。
//
// mtime 这条判据永远**只对共享工作区**成立，别往独占目录推：建 worktree 是一次检出，所有
// 被跟踪的文件 mtime 都等于任务开跑那一刻，拿 mtime 去问「是不是这次生成的」会把整个仓库
// 都答成「是」。
//
// 没有任何归属证据时（共享目录 + 一次都没跑过）**三档一律空**：那时 git status 报的改动
// 是同一个目录里别人留下的，把它们当成这个任务的产物，就是原需求抱怨的那件事
// （第 1 轮审查 F2）。

export type { ArtifactKind };
/** 这份产物是从哪条线索认出来的，界面上要分组说清楚。 */
export type ArtifactOrigin = "working" | "committed" | "ignored";
/** 归属是怎么成立的：独占目录=确定；共享目录=按运行区间认出来的**候选**。 */
export type ArtifactScopeKind = "exclusive" | "shared";

export interface TaskArtifact {
  /** 相对工作区根、posix 分隔符——跟文件树、文件查看器用的是同一个主键。 */
  path: string;
  name: string;
  dir: string;
  kind: ArtifactKind;
  size: number;
  mtime: string | null;
  origin: ArtifactOrigin;
}

export interface TaskArtifactsResult {
  artifacts: TaskArtifact[];
  /** 撞上条数上限，后面还有没列出来的。 */
  truncated: boolean;
  /** 任务第一次开跑的时刻。null = 没跑过。 */
  since: string | null;
  /** 归属强弱。界面据此说明「这是候选还是确定」。 */
  scope: ArtifactScopeKind;
  /**
   * 清单**可能不全**的原因（扫描预算用满、目录读不动、提交额度不够…）。
   * 跟 `error` 刻意分开：那个是「某一路线索读失败了」，这个是「读成了但没读完」——后者
   * 在界面上长得跟「它什么都没做出来」一模一样，所以必须照实说出来（第 1 轮审查 F4）。
   */
  incomplete: string[];
  /** 某一路线索读失败了（git 不可用之类）。不致命，只是那一档可能缺东西。 */
  error: string | null;
}

const MAX_ARTIFACTS = 400;

/**
 * 三路线索合成一份产物清单。
 *
 * 任何一路读失败都只记一句 `error` 继续走完剩下的：git 不在、分支被删、目录只读，都不该
 * 让整块面板变成一条红字——另外两路通常还能给出东西来。
 */
export async function readTaskArtifacts(
  taskId: string,
  root: WorkspaceRoot,
): Promise<TaskArtifactsResult> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const problems: string[] = [];
  const incomplete: string[] = [];
  // 同一个文件可能同时是「已提交」和「又改了」。origin 取最靠近当下的那一档，
  // 所以按 working → committed → ignored 的顺序写入，先写的不被后面覆盖。
  //
  // git 两档不过扫描护栏（`skipsDirPath` 那张表）：那是**扫文件系统时**的护栏（依赖树、
  // 构建缓存、别人的 worktree 里本来就塞满图片），而 git 认识的路径已经自带归属证据——
  // 一份真被提交进 `coverage/` 的报告该列出来，不该被护栏误伤。
  const origins = new Map<string, ArtifactOrigin>();
  const remember = (path: string, origin: ArtifactOrigin) => {
    if (path && kindOf(path) && !origins.has(path)) origins.set(path, origin);
  };

  const scope = task ? await resolveArtifactScope(task, root) : null;
  const exclusive = scope?.exclusive ?? false;
  const windows = scope?.windows ?? [];
  problems.push(...(scope?.problems ?? []));
  // 有没有「这个文件归它」的证据可用：目录独占算一种，跑过（有区间）算另一种。按时间认的
  // 那几档都要过这道门槛；任务分支的 diff 不用，它自己就是证据（见下）。
  const hasEvidence = exclusive || windows.length > 0;

  if (root.gitRepo) {
    // 工作区里还没提交的改动：在共享目录上这**不是**归属证明（谁动的都显示在同一份
    // `git status` 里），所以要先有证据才读。
    if (hasEvidence) {
      const status = await readFileGitStatus(root.path);
      if (status.error) problems.push(`读工作区改动失败：${status.error}`);
      for (const change of status.changes) {
        if (change.kind !== "deleted") remember(change.path, "working");
      }
    }

    // 已提交那一档：路径出自仓库根，而工作区根可能是仓库的某个子目录，得换算一次。
    const project = task
      ? (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0)
      : undefined;
    if (task && project?.repoPath) {
      let prefix = "";
      try {
        prefix = (await exec("git", ["-C", root.path, "rev-parse", "--show-prefix"])).stdout.replace(/\r?\n$/, "");
      } catch {
        prefix = "";
      }
      const relocate = (path: string) => {
        if (prefix && !path.startsWith(prefix)) return null;
        return prefix ? path.slice(prefix.length) : path;
      };
      const committed = await taskBranchChangedPaths(
        project.repoPath,
        task.id,
        task.mergeTargetBranch || task.worktreeBase,
        task.worktreeStartCommit,
      );
      if (committed.available) {
        // 分支 diff **自带归属**：分支名由 taskId 派生，`merge-base..分支` 里的每个提交都是
        // 它做的，跟它在哪个目录跑过、有没有留下运行区间都无关。worktree 事后被删、面板降级
        // 到主仓展示时，这是唯一还拿得出来的证据，不能被上面那道时间门槛一起挡掉。
        for (const path of committed.paths) {
          const rel = relocate(path);
          if (rel) remember(rel, "committed");
        }
      } else if (windows.length) {
        // 没有属于它的分支（共享工作区）/ 目标分支被删：退回运行区间里的提交。这一档本身
        // 就是按时间认的，没有区间就无从认起。
        try {
          const byTime = await committedInWindows(root.path, windows);
          for (const path of byTime.paths) {
            const rel = relocate(path);
            if (rel) remember(rel, "committed");
          }
          if (byTime.truncated) {
            incomplete.push("它跑过的某一段里提交太多，已提交那一档只回看了最近的一批");
          }
          if (byTime.skippedWindows > 0) {
            incomplete.push(`它跑过的区间太多，已提交那一档只查了最近的几段（跳过 ${byTime.skippedWindows} 段）`);
          }
        } catch (error) {
          problems.push(`读运行期间的提交失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // 被忽略 / 根本不在 git 管辖里的那一档。
  const scanned = new Set<string>();
  if (hasEvidence) {
    try {
      const scan = await scanIgnoredArtifacts(root.path, root.gitRepo, windows);
      for (const path of scan.paths) scanned.add(path);
      incomplete.push(...scan.incomplete);
    } catch (error) {
      problems.push(`读被忽略的文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const candidates = new Map<string, ArtifactOrigin>(origins);
  for (const path of scanned) if (!candidates.has(path)) candidates.set(path, "ignored");

  // 并发 stat：候选可能有上千个，一个个串着问，面板每 8 秒就白等一轮。
  const stated = await Promise.all([...candidates].map(async ([path, origin]) => {
    const info = await stat(join(root.path, path)).catch(() => null);
    return { path, origin, info };
  }));

  const artifacts: TaskArtifact[] = [];
  for (const { path, origin, info } of stated) {
    if (!info || !info.isFile()) continue; // 已删除 / 已改名的旧路径
    const mtimeMs = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
    // 共享工作区里，时间是唯一的归属线索；独占目录和 committed 那一档各自已有更强的证据。
    if (!exclusive && origin !== "committed" && !withinWindows(mtimeMs, windows)) continue;
    artifacts.push({
      path,
      name: basename(path),
      dir: path.split("/").slice(0, -1).join("/"),
      kind: kindOf(path)!,
      size: info.size,
      mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      origin,
    });
  }

  // 新的排前面：面板要回答的是「它刚刚做出了什么」。
  artifacts.sort((a, b) => (Date.parse(b.mtime ?? "") || 0) - (Date.parse(a.mtime ?? "") || 0)
    || a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));

  return {
    artifacts: artifacts.slice(0, MAX_ARTIFACTS),
    truncated: artifacts.length > MAX_ARTIFACTS,
    since: scope?.firstRunAt ?? null,
    scope: exclusive ? "exclusive" : "shared",
    incomplete,
    error: problems.join("；") || null,
  };
}
