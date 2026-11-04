import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import type { WorkspaceRoot } from "./file-browser.js";
import { readFileGitStatus } from "./file-git-status.js";
import { taskBranchChangedPaths } from "./git-diff.js";
import { directEvidence, type DirectEvidence, type DirectVerdict } from "./task-artifact-direct.js";
import { pathLens } from "./task-artifact-paths.js";
import { concurrentRivals, type Rivals } from "./task-artifact-rivals.js";
import { kindOf, scanIgnoredArtifacts, type ArtifactKind } from "./task-artifact-scan.js";
import { committedInWindows, resolveArtifactScope, type CommitEvidence } from "./task-artifact-scope.js";
import { checkBranchVersions, checkCommitVersions, type CommitVersionCheck } from "./task-artifact-version.js";
import { windowHit } from "./task-artifact-windows.js";

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
// **归属强弱：什么能算「确定」**（判据本体在 `task-artifact-scope.ts`）：
//   • 目录独占（任务自己或它跟随的那个任务的 worktree）—— 目录就是归属证据，三档都不问
//     时间。这一档必须不设上限：哨兵起的后台渲染可以在回合收尾二十分钟后才落盘，拿「回合
//     结束 + 宽限」去卡它，真做出来的东西反而消失（第 1 轮审查 F3）。
//   • 共享工作区（`useWorktree=false`、非 git 目录、跟着领队目录的执行者）上，**只有直接证据
//     才算确定**：
//       - 写文件工具亲手写下、磁盘上这份一字未变（`task-artifact-direct.ts`）；
//       - 任务分支上的提交动过它、而且磁盘上这份就是分支那一版（`task-artifact-version.ts`）；
//       - 按时间认的（区间里的提交、未提交的改动、被忽略的文件）：落在精确区间里，**而且那一刻
//         没有别的任务在跑**——不管它在哪个目录跑，命令的输出落在哪儿是记不下来的
//         （`task-artifact-rivals.ts`）。
//     其余一律是候选，逐条说明为什么拿不准（`ArtifactDoubt`）。**推断只能让一条变成候选，不能
//     让它变成确定，也不能把它从清单里拿掉**——唯一会拿掉的是「现在这份正是别的任务亲手写下的」，
//     那是直接证据。曾经按「谁在附近写过东西」猜作者，每一种猜法都有反例，猜错就是把别人的东西
//     标成确定、或者把自己的藏起来。
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
/**
 * **这一条**的归属有多硬。
 *
 * `exact` = 有直接证据（见文件顶部那几条）。`approx` = 候选，原因见 `doubt`。
 *
 * 为什么要逐条给：只在页脚汇总一句「有 N 个拿不准」时，用户看得见数目、看不出**是哪几个**，
 * 于是整张清单一起贬值（第 5 轮审查）。这一列**不参与归属判定**，只是把算出来的强弱带到界面。
 */
export type ArtifactConfidence = "exact" | "approx";
/**
 * 候选**为什么**拿不准，面板逐条说：
 *   - `estimated`  只落在估出来的区间里（会话寿命、没收尾的回合）；
 *   - `concurrent` 那一刻还有别的任务在跑（是谁见 `alongside`）；
 *   - `unchecked`  没能核对那一刻还有谁在跑（核对失败、在跑的太多没核全）；
 *   - `version`    它确实动过这条路径，但磁盘上现在这份不是它那一版（后来被改过）；
 *   - `contested`  它和别的任务亲手写下过一模一样的内容，谁也证明不了。
 */
export type ArtifactDoubt = "estimated" | "concurrent" | "unchecked" | "version" | "contested";

export interface TaskArtifact {
  /** 相对工作区根、posix 分隔符——跟文件树、文件查看器用的是同一个主键。 */
  path: string;
  name: string;
  dir: string;
  kind: ArtifactKind;
  size: number;
  mtime: string | null;
  origin: ArtifactOrigin;
  /** 这一条是确定的还是候选（见 `ArtifactConfidence`）。 */
  confidence: ArtifactConfidence;
  /** 候选为什么拿不准；确定的没有这一项。 */
  doubt?: ArtifactDoubt;
  /** `doubt=concurrent` 时，那一刻也在跑的任务标题。 */
  alongside?: string[];
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

/** 核对「那一刻还有谁在场」失败时：谁也不能被当成「没人在场」，只靠时间认的都按候选列。 */
const UNCHECKED: Rivals = {
  at: () => [],
  titles: new Map(),
  incomplete: "没能核对同一时间还有哪些任务在跑，只靠时间认的都按候选列",
};

/** 这几条里哪些被 .gitignore 挡着（问不出来就当没挡着）。 */
async function ignoredAmong(rootPath: string, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  try {
    const { stdout } = await exec("git", ["-C", rootPath, "check-ignore", "-z", "--stdin"], {
      input: paths.map((path) => `${path}\0`).join(""),
    });
    return new Set(stdout.split("\0").filter(Boolean));
  } catch {
    // 一条都没被挡着时 check-ignore 以 1 退出，也落在这里。
    return new Set();
  }
}

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
  /**
   * 每条路径**攒下它的全部证据**，不是先到先得。
   *
   * 原来这里是「第一个来源赢，后面的丢掉」：`git status` 先跑，于是一条**自己已经提交过**
   * 的产物只要现在又有别人的未提交改动，就只剩 `working` 这一个来源；而 `working` 是按
   * mtime 筛的，别人那次改动的时间当然不在自己的运行区间里——整条路径于是从面板上消失，
   * 文件明明还在（第 2 轮审查 F3）。弱证据不能把已经成立的强证据盖掉：攒齐再判。
   */
  const evidence = new Map<string, Set<ArtifactOrigin>>();
  /**
   * 任务分支差异列出来的路径——分支名由 taskId 派生，上面每个提交都是它做的，不吃时间。还要
   * 核一遍磁盘上这份是不是分支那一版才算确定（`checkBranchVersions`）。
   *
   * 跟 `evidence` 分开记,因为那张表记的是「它现在是什么状态」（工作区改动 / 已提交 /
   * 被忽略），答不了「这条归属有多硬」——而面板要说的恰恰是后者（第 4 轮审查 N2）。
   */
  const proven = new Set<string>();
  /**
   * 按时间在运行区间里找到的提交动过的路径 → 那几次提交。共享仓库里的提交不自带归属：要先核出
   * 磁盘上这份是其中哪一次落下的，再拿那一刻去问「是不是只有它在场」。
   */
  const timeCommitted = new Map<string, CommitEvidence[]>();
  const remember = (path: string, origin: ArtifactOrigin) => {
    if (!path || !kindOf(path)) return;
    const seen = evidence.get(path);
    if (seen) seen.add(origin);
    else evidence.set(path, new Set([origin]));
  };

  const scope = task ? await resolveArtifactScope(task, root) : null;
  const exclusive = scope?.exclusive ?? false;
  const windows = scope?.windows ?? [];
  problems.push(...(scope?.problems ?? []));
  // 回合记录缺了哪几段：面板必须说出来。缺记录既不能当成「这段时间它一直在跑」（串台），
  // 也不能当成「它没跑过」（漏报），只能当成「这段算不准」并明说（第 2 轮审查 F1）。
  incomplete.push(...(scope?.gaps ?? []));
  // 有没有「这个文件归它」的证据可用：目录独占算一种，跑过（有区间）算另一种。按时间认的
  // 那几档都要过这道门槛；任务分支的 diff 不用，它自己就是证据（见下）。
  const hasEvidence = exclusive || windows.length > 0;
  const lens = pathLens();
  // 共享目录上的两样东西：亲手写下的直接证据、那一刻还有哪些任务在跑。读失败都不致命，但都
  // 不能当成「没别人」：在跑的核不出来（`UNCHECKED`）、亲手写下的读不出来（那个文件可能正是别人
  // 亲手写下的），只靠时间认的一律当候选。
  const direct: DirectEvidence | null = task && scope && !exclusive
    ? await directEvidence(root, scope.owners.map((owner) => owner.id), lens).catch((error) => {
      problems.push(`读任务亲手写下的文件失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    })
    : null;
  const rivals: Rivals | null = task && scope && !exclusive
    ? await concurrentRivals(task, scope, root, lens).catch((error) => {
      problems.push(`读同一时间在跑的任务失败：${error instanceof Error ? error.message : String(error)}`);
      return UNCHECKED;
    })
    : null;
  if (rivals?.incomplete) incomplete.push(rivals.incomplete);
  /** 任务分支名与工作区根在仓库里的位置——分支证明要拿去跟磁盘上现在这份比内容。 */
  let branchSource: string | null = null;
  let prefix = "";

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
        branchSource = committed.sourceBranch ?? null;
        // 分支 diff **自带归属**：分支名由 taskId 派生，`merge-base..分支` 里的每个提交都是
        // 它做的，跟它在哪个目录跑过、有没有留下运行区间都无关。worktree 事后被删、面板降级
        // 到主仓展示时，这是唯一还拿得出来的证据，不能被上面那道时间门槛一起挡掉。
        for (const path of committed.paths) {
          const rel = relocate(path);
          if (rel) { remember(rel, "committed"); proven.add(rel); }
        }
      } else if (windows.length) {
        // 没有属于它的分支（共享工作区）/ 目标分支被删：退回运行区间里的提交。这一档本身
        // 就是按时间认的，没有区间就无从认起。
        try {
          const byTime = await committedInWindows(root.path, windows);
          // 精确区间里的提交是实测证据；估出来的区间里的只是候选，分开记，别让它冒充确定
          // （第 4 轮审查 N2）。
          for (const [path, commits] of byTime.commits) {
            const rel = relocate(path);
            if (!rel) continue;
            remember(rel, "committed");
            timeCommitted.set(rel, commits);
          }
          if (byTime.truncated) {
            incomplete.push("它跑过的某一段里提交太多，已提交那一档只回看了最近的一批");
          }
          if (byTime.dateWalk) {
            incomplete.push("这台机器的 git 偏老，已提交那一档按提交日期截断遍历，历史日期乱序时可能漏掉几条");
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
      const scan = await scanIgnoredArtifacts(root.path, root.gitRepo, windows, direct?.focus ?? []);
      for (const path of scan.paths) scanned.add(path);
      incomplete.push(...scan.incomplete);
    } catch (error) {
      problems.push(`读被忽略的文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const path of scanned) remember(path, "ignored");
  // 亲手写下的那些不靠扫描找：扫描有预算、按时间筛，而这条证据两样都不吃。git 仓库里它不在上面
  // 三路里，要么被忽略了（扫描没扫到），要么是早就提交、之后没再动的。
  const unseen = (direct?.ownPaths ?? []).filter((path) => !evidence.has(path));
  const unseenIgnored = root.gitRepo ? await ignoredAmong(root.path, unseen) : new Set(unseen);
  for (const path of unseen) remember(path, unseenIgnored.has(path) ? "ignored" : "committed");

  // 并发 stat：候选可能有上千个，一个个串着问，面板每 8 秒就白等一轮。
  const stated = await Promise.all([...evidence].map(async ([path, origins]) => {
    const info = await stat(join(root.path, path)).catch(() => null);
    return { path, origins, info };
  }));

  // 提交证据只替**它落下的那一版**作保：先核一遍磁盘上这份是不是那一版（task-artifact-version.ts）
  // ——任务分支差异比分支末端，按时间找到的提交比那几次提交各自落下的内容。独占目录里磁盘上这份
  // 就是它的，不用核。有未提交改动的不在这里核：现在这一版就是磁盘上那份未提交的，按它落下的时刻判。
  const clean = stated.filter(({ origins, info }) => !origins.has("working") && info?.isFile()).map(({ path }) => path);
  const [branchVersion, commitVersion, directVerdict] = exclusive
    ? [new Map<string, string>(), new Map<string, CommitVersionCheck>(), new Map<string, DirectVerdict>()]
    : await Promise.all([
      branchSource
        ? checkBranchVersions(root.path, prefix, branchSource, clean.filter((path) => proven.has(path)))
        : new Map<string, string>(),
      checkCommitVersions(root.path, prefix, new Map(clean
        .filter((path) => timeCommitted.has(path))
        .map((path) => [path, timeCommitted.get(path)!]))),
      Promise.all(stated.map(async ({ path }) => [path, await direct?.judge(path) ?? null] as const))
        .then((pairs) => new Map(pairs)),
    ]);
  const ownWritten = new Set(direct?.ownPaths ?? []);

  const artifacts: TaskArtifact[] = [];
  /** 现在这份正是别的任务亲手写下的、没列进来的条数。 */
  let claimed = 0;
  for (const { path, origins, info } of stated) {
    if (!info || !info.isFile()) continue; // 已删除 / 已改名的旧路径
    const mtimeMs = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
    const push = (doubt?: ArtifactDoubt, alongside?: string[]) =>
      artifacts.push(toArtifact(path, origins, info.size, mtimeMs, doubt, alongside));
    if (exclusive) { push(); continue; }

    // 1. 亲手写下的直接证据：不问时间、不问还有谁在场。
    const verdict = directVerdict.get(path) ?? null;
    if (verdict === "theirs") {
      // 只数本来会列进来的（它动过、或者时间对得上）：本来就不沾的，说「没列」只是添乱。
      if (proven.has(path) || timeCommitted.has(path) || windowHit(mtimeMs, windows)) claimed += 1;
      continue;
    }
    if (verdict === "mine") { push(); continue; }
    if (verdict === "contested") { push("contested"); continue; }

    // 2. 提交证据：磁盘上这份就是分支那一版 → 确定；它的提交动过、但现在这份不是那一版 → 候选。
    const working = origins.has("working");
    if (proven.has(path) && !working) {
      if (branchVersion.get(path) === "match") push();
      else push("version");
      continue;
    }
    // 3. 只能按时间认的：现在这一版落下的时刻——区间里核出来的那次提交，否则就是 mtime。
    const matched = !working ? commitVersion.get(path) : undefined;
    if (timeCommitted.has(path) && !working && !(matched && typeof matched === "object")) {
      push("version");
      continue;
    }
    const version = matched && typeof matched === "object"
      ? { at: matched.commit.at, hit: (matched.commit.exact ? "exact" : "approx") as "exact" | "approx" }
      : { at: mtimeMs, hit: windowHit(mtimeMs, windows) };
    // 它确实动过这条路径（分支、提交、亲手写过），可现在这份落在它的区间外面：是后来被谁改过的
    // 版本。不从面板上抹掉（自己做过的东西被顺手改一下就消失），也不冒充确定。
    const prior = proven.has(path) || timeCommitted.has(path) || ownWritten.has(path);
    if (!version.hit) {
      if (prior) push("version");
      continue;
    }
    if (version.hit === "approx") { push("estimated"); continue; }
    const present = rivals?.at(version.at) ?? [];
    if (present.length) {
      push("concurrent", present.map((id) => rivals!.titles.get(id) ?? id));
      continue;
    }
    // 没核全那一刻还有谁在跑、或者读不出亲手写下的记录（它可能正是别人亲手写下的）：都不敢算确定。
    if (rivals?.incomplete || (rivals && !direct)) { push("unchecked"); continue; }
    push();
  }

  // 估出来的时间段是**记录缺口**，跟「清单可能不全」是一类事，单独说一句；其余几种原因是逐条的
  // 判断，标在每张卡片上（「拿不准归属的」那一栏有图例），不在这里笼统汇总——汇总成一句话，
  // 原因就会跟卡片上的对不上。
  const estimated = artifacts.filter((artifact) => artifact.doubt === "estimated").length;
  if (estimated > 0) {
    incomplete.push(`清单里有 ${estimated} 个是按估出来的时间段认的（收在「拿不准归属的」那一栏），可能混进别人做的东西`);
  }
  if (claimed > 0) {
    incomplete.push(`有 ${claimed} 个文件现在这份是别的任务亲手写下的，没列在这里`);
  }

  // 新的排前面：面板要回答的是「它刚刚做出了什么」。超过条数上限时先留确定的——一堆候选不能把
  // 真东西挤出清单——留下来的再按新旧排。
  const newest = (a: TaskArtifact, b: TaskArtifact) => (Date.parse(b.mtime ?? "") || 0) - (Date.parse(a.mtime ?? "") || 0)
    || a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  const kept = [...artifacts]
    .sort((a, b) => Number(a.confidence === "approx") - Number(b.confidence === "approx") || newest(a, b))
    .slice(0, MAX_ARTIFACTS)
    .sort(newest);

  return {
    artifacts: kept,
    truncated: artifacts.length > MAX_ARTIFACTS,
    since: scope?.firstRunAt ?? null,
    scope: exclusive ? "exclusive" : "shared",
    incomplete,
    error: problems.join("；") || null,
  };
}

/** 一条产物。origin 说的是**它现在是什么状态**，跟归属强弱（doubt）无关。 */
function toArtifact(
  path: string,
  origins: Set<ArtifactOrigin>,
  size: number,
  mtimeMs: number | null,
  doubt?: ArtifactDoubt,
  alongside?: string[],
): TaskArtifact {
  // 有未提交的改动就显示工作区改动（哪怕归属是提交证明下来的），否则按最强的那条证据。
  const origin: ArtifactOrigin = origins.has("working")
    ? "working"
    : (origins.has("committed") ? "committed" : "ignored");
  return {
    path,
    name: basename(path),
    dir: path.split("/").slice(0, -1).join("/"),
    kind: kindOf(path)!,
    size,
    mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
    origin,
    confidence: doubt ? "approx" : "exact",
    ...(doubt ? { doubt } : {}),
    ...(alongside?.length ? { alongside } : {}),
  };
}
