// 任务接力——导出侧的**盘点与打包**:会话文件在哪、能不能搬,runs 产物有哪些,
// git 状态怎么打成一个尽量薄的 bundle。从 handoff.ts 拆出来,那边只留流程编排
// (停任务 → 打包 → 推送 → 落标记),业务背景见 handoff.ts 顶部注释。
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, freeWorkflowEvents, freeWorkflowStates, reviewerProfiles } from "./db/schema.js";
import type { sessions, tasks } from "./db/schema.js";
import { execFileText } from "./exec.js";
import { expandHome, isGitRepo, localBranchExists, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { DATA_DIR, RUNS_DIR } from "./paths.js";
import { codexHome, findRollout } from "./executors/codex-rollout.js";
import { sessionCliConfigDir } from "./auth/run-env.js";
import { HandoffError, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, MB } from "./handoff-types.js";
import type {
  HandoffFilePayload, HandoffFreeReviewRound, HandoffFreeWorkflowPayload, HandoffManifest,
} from "./handoff-types.js";

type TaskRow = typeof tasks.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

const exec = execFileText;

/**
 * claude CLI 存会话的项目目录名:cwd 中所有非字母数字字符替换成 `-`。
 * 实测样例:/Users/fjh/code/ash/.worktrees/KJN0ESTe5uBw
 *   → -Users-fjh-code-ash--worktrees-KJN0ESTe5uBw
 * claude 代码里没有公开这个函数,格式一旦变化,后果只是对端找不到会话文件 →
 * 干净退化成全新起跑,不会出错误状态。
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * claude 存这个 cwd 的会话的目录。`configDir` 是**这条任务的归属人**那一份
 * `CLAUDE_CONFIG_DIR`(`auth/run-env.ts` 的 cliConfigDirForOwner);它设了就**整个取代**
 * `~/.claude`,不回落,所以这里也不能回落——否则找的和 CLI 用的不是同一个目录。
 */
export function claudeProjectDir(cwd: string, configDir?: string | null): string {
  return join(configDir?.trim() || join(homedir(), ".claude"), "projects", claudeProjectSlug(cwd));
}

export function claudeSessionFilePath(
  cwd: string,
  cliSessionId: string,
  configDir?: string | null,
): string {
  return join(claudeProjectDir(cwd, configDir), `${cliSessionId}.jsonl`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 32 * MB });
  return stdout.trim();
}

export async function repoRefTips(repoPath: string): Promise<{ name: string; commit: string }[]> {
  const repo = expandHome(repoPath);
  const refs: { name: string; commit: string }[] = [];
  try {
    const head = await git(repo, ["rev-parse", "HEAD"]);
    if (head) refs.push({ name: "HEAD", commit: head });
  } catch { /* 空仓库等,忽略 */ }
  try {
    const out = await git(repo, ["for-each-ref", "--format=%(refname:short)\x1f%(objectname)", "refs/heads"]);
    for (const line of out.split("\n").filter(Boolean).slice(0, 200)) {
      const [name, commit] = line.split("\x1f");
      if (name && commit) refs.push({ name, commit });
    }
  } catch { /* 非 git 仓库,返回已有的 */ }
  return refs;
}


/**
 * 会话文件盘点:每条会话的文件在哪、能不能搬。dryRun 时不读内容（preflight 用）。
 *
 * 目录**逐条会话解析**,不是整批一个:多人模式下 `sessions.cli_config_dir` 记着
 * 「这条会话的 transcript 当初写进了哪个 CLI 配置目录」,共享项目里 B 回复 A 的任务时
 * 它是 B 的目录(`orchestrator.ts` 的 `runOwner = actingUserId ?? task.ownerUserId`)。
 * 按任务归属人一刀切会在 A 的目录下扑空,报「本机找不到 CLI 会话文件」,最新那段上下文
 * 就此不随任务走。
 *
 * 读**记下来的目录**而不是「按归属人现算」:同一个人的目录会随实例的「CLI 额度」设置
 * 整体挪位置(§八之二),现算给出的是「现在会去哪」,而搬文件要的是「当初写在哪」。
 * 老行没有这一列时按**当时**那条规则解释(见 `sessionCliConfigDir`),不问任务归属人
 * —— 存量任务在自用转多人时会被整体划给管理员,那个字段对「当初写在哪」没有证明力。
 */
export async function collectSessionFiles(
  rows: SessionRow[],
  fallbackCwd: string | null,
  dryRun: boolean,
): Promise<{ files: HandoffFilePayload[]; found: Set<string>; notes: string[] }> {
  const files: HandoffFilePayload[] = [];
  const found = new Set<string>();
  const notes: string[] = [];
  for (const s of rows) {
    if (!s.cliSessionId) continue;
    let abs: string | null = null;
    let rel = "";
    let kind: HandoffFilePayload["kind"];
    if (s.agentType === "claude") {
      kind = "claude-session";
      rel = `${s.cliSessionId}.jsonl`;
      const claudeConfigDir = await sessionCliConfigDir(s, "claude");
      for (const cwd of [s.cwd, s.worktreePath, fallbackCwd]) {
        if (!cwd) continue;
        const candidate = claudeSessionFilePath(cwd, s.cliSessionId, claudeConfigDir);
        if (existsSync(candidate)) { abs = candidate; break; }
      }
    } else if (s.agentType === "codex") {
      kind = "codex-rollout";
      const codexConfigDir = await sessionCliConfigDir(s, "codex");
      abs = await findRollout(s.cliSessionId, codexConfigDir);
      // 协议里 rel 一律 `/` 分隔:Windows 上 relative 产出反斜杠,POSIX 导入侧会把
      // 整串当成一个文件名落错地方(codex 按目录深度扫描,从此找不到这份会话)。
      if (abs) rel = relative(join(codexHome(codexConfigDir), "sessions"), abs).split(sep).join("/");
    } else {
      notes.push(`会话 ${s.id}（${s.agentType}）:该执行器的会话文件迁移暂不支持,对端只能全新起跑`);
      continue;
    }
    if (!abs) {
      notes.push(`会话 ${s.id}（${s.agentType}）:本机找不到 CLI 会话文件,对端只能全新起跑`);
      continue;
    }
    const size = statSync(abs).size;
    if (size > MAX_FILE_BYTES) {
      notes.push(`会话 ${s.id}:会话文件 ${Math.round(size / MB)}MB 超限,跳过`);
      continue;
    }
    found.add(s.id);
    if (!dryRun) {
      files.push({ kind, rel, dataBase64: (await readFile(abs)).toString("base64") });
    }
  }
  return { files, found, notes };
}

export async function collectRunArtifacts(taskId: string, notes: string[]): Promise<HandoffFilePayload[]> {
  const root = join(RUNS_DIR, taskId);
  if (!existsSync(root)) return [];
  const out: HandoffFilePayload[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(abs); continue; }
      if (!entry.isFile()) continue;
      const size = statSync(abs).size;
      if (size > MAX_FILE_BYTES) {
        notes.push(`会话产物 ${entry.name} ${Math.round(size / MB)}MB 超限,跳过`);
        continue;
      }
      out.push({ kind: "run-artifact", rel: relative(root, abs).split(sep).join("/"), dataBase64: (await readFile(abs)).toString("base64") });
    }
  };
  await walk(root);
  return out;
}

/**
 * git 状态打包。只在任务开了 worktree 时有货,尖从哪儿来分三档（见 packSource）:
 * 活着的 worktree → 未提交改动先做 WIP 提交（进的是任务自己的分支,不碰用户分支）;
 * worktree 没了但分支还在 → 按分支现状打;两者都没了但**本机验收过** → 带走那次验收的
 * 合并提交。拿到尖之后统一跟对端仓库的分支尖协商公共前置提交,打一个尽量薄的 bundle;
 * 协商不出就整条历史全量打包。
 */
export async function packGitState(
  task: TaskRow,
  repoPath: string,
  remoteRefs: { name: string; commit: string }[],
  notes: string[],
): Promise<HandoffManifest["git"]> {
  if (!task.useWorktree) {
    notes.push("任务不在独立 worktree 中运行,代码不随任务迁移——对端仓库以它本地的状态为准");
    return null;
  }
  const repo = expandHome(repoPath);
  const wt = worktreePathFor(repoPath, task.id);
  const live = existsSync(wt) && (await isGitRepo(wt));
  return withRepoLock(repoPath, async () => {
    const source = live
      ? await packSourceFromWorktree(wt, notes)
      : await packSourceFromRepo(repo, task, notes);
    if (!source) return null;
    const { branch, head, acceptedMerge, borrowedRef } = source;
    try {
      // 前置提交协商:对端已有的提交（且是本分支祖先）不用重复打包。
      const prereqs: string[] = [];
      for (const ref of remoteRefs.slice(0, 100)) {
        if (prereqs.includes(ref.commit)) continue;
        try {
          await git(repo, ["cat-file", "-e", `${ref.commit}^{commit}`]);
          await git(repo, ["merge-base", "--is-ancestor", ref.commit, head]);
          prereqs.push(ref.commit);
        } catch { /* 对端这个提交本机没有,或不在本分支历史上 */ }
      }
      // 对端已有分支尖本身(重复接力/仓库已完全同步):`git bundle create ^HEAD HEAD`
      // 会以 "Refusing to create empty bundle" 拒绝——用空 bundleBase64 表示「提交都在,
      // 只需对齐分支指向」,导入侧不做 verify/fetch。
      if (prereqs.includes(head)) {
        notes.push("对端仓库已有本分支全部提交,git 数据无需传输");
        return { branch, head, full: false, prereqs, bundleBase64: "", ...(acceptedMerge ? { acceptedMerge } : {}) };
      }
      const tmpDir = join(DATA_DIR, "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const bundlePath = join(tmpDir, `handoff-${task.id}-${Date.now()}.bundle`);
      try {
        const revArgs = prereqs.slice(0, 50).map((sha) => `^${sha}`);
        await git(repo, ["bundle", "create", bundlePath, ...revArgs, branch]);
        const size = statSync(bundlePath).size;
        if (size > MAX_BUNDLE_BYTES) {
          throw new HandoffError(
            `git bundle ${Math.round(size / MB)}MB 超限——两边仓库差距太大。先在目标机器上把仓库 fetch/pull 到较新状态,再重试接力`,
          );
        }
        if (!prereqs.length) {
          notes.push(`对端仓库没有和本分支重合的提交,bundle 打包了整条历史（${Math.round(size / MB)}MB）`);
        }
        return {
          branch,
          head,
          full: prereqs.length === 0,
          prereqs,
          bundleBase64: readFileSync(bundlePath).toString("base64"),
          ...(acceptedMerge ? { acceptedMerge } : {}),
        };
      } finally {
        rmSync(bundlePath, { force: true });
      }
    } finally {
      // 借来的名字用完就还。`git bundle create` 只认 ref,而验收合并提交没有自己的分支,
      // 只能临时借任务分支这个名字站一下 —— 借完必须原样还回去:留一个指向合并提交的
      // `ash/<id8>`,会让本机下一次 detectTaskWorkspace/验收都以为这个任务还有活分支。
      if (borrowedRef) {
        const restore = borrowedRef.previous === null
          ? ["update-ref", "-d", `refs/heads/${branch}`, head]
          : ["update-ref", `refs/heads/${branch}`, borrowedRef.previous, head];
        await git(repo, restore).catch(() => notes.push(
          borrowedRef.previous === null
            ? `打包借用的临时分支 ${branch} 没能撤掉,本机可手动 git branch -D 删除`
            : `打包时临时移动过的分支 ${branch} 没能还回 ${borrowedRef.previous.slice(0, 8)},本机需手动复位`,
        ));
      }
    }
  });
}

type PackSource = {
  branch: string;
  head: string;
  acceptedMerge: boolean;
  /** 非 null = 打包期间借用/挪动过 `refs/heads/<branch>`,打完包要还回 `previous`(null 表示原本不存在,还法是删掉)。 */
  borrowedRef: { previous: string | null } | null;
};

/**
 * 预检用的**只读**探测:这个任务现在还有没有可迁移的代码状态。三档判据跟
 * `packSourceFromRepo` 一一对应(worktree / 任务分支 / 已落地的验收合并提交),分开写是因为
 * 那边会真的立 ref、做 WIP 提交,而预检说好了「只读,不停任务不动文件」。
 */
export async function hasPackableGitState(task: TaskRow, repoPath: string): Promise<boolean> {
  if (!task.useWorktree) return false;
  const repo = expandHome(repoPath);
  if (existsSync(worktreePathFor(repoPath, task.id))) return true;
  if (!(await isGitRepo(repo))) return false;
  if (await localBranchExists(repo, await resolveWorktreeBranchName(repo, task.id))) return true;
  const merge = task.acceptedMergeCommit?.trim();
  const target = task.acceptedTargetBranch?.trim();
  if (!merge || !target) return false;
  return git(repo, ["merge-base", "--is-ancestor", merge, target]).then(() => true).catch(() => false);
}

/** 活着的 worktree:未提交改动先落一个 WIP 提交,再按它当前的分支尖打包。 */
async function packSourceFromWorktree(wt: string, notes: string[]): Promise<PackSource | null> {
  const branch = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    notes.push("worktree 处于 detached HEAD,无法按分支打包,代码不随任务迁移");
    return null;
  }
  // WIP 提交:porcelain 非空才提交;身份缺失时补一个 ash 落款,别让接力卡在
  // 一台没配 git identity 的机器上。
  if (await git(wt, ["status", "--porcelain"])) {
    await git(wt, ["add", "-A"]);
    try {
      await git(wt, ["commit", "-m", "chore(handoff): 接力前自动保存未提交改动"]);
    } catch {
      await git(wt, [
        "-c", "user.name=ash", "-c", "user.email=ash@localhost",
        "commit", "-m", "chore(handoff): 接力前自动保存未提交改动",
      ]);
    }
    notes.push("未提交改动已在任务分支上做了一个 WIP 提交随包带走");
  }
  return { branch, head: await git(wt, ["rev-parse", "HEAD"]), acceptedMerge: false, borrowedRef: null };
}

/**
 * worktree 已经不在了。以前这里一律返回 null 并说一句「还没跑过」—— 而最常撞上这条路的
 * 根本不是没跑过的任务,是**已经验收完的**任务:验收会把任务分支合进目标分支,再按计划
 * 删掉 worktree、删掉分支(git-accept.ts)。于是「在别的机器上干完、验收完、再移回来」
 * 这条最顺理成章的路,回来的是一个空壳 worktree —— 代码留在那台机器的主线上，本机既看不见
 * 也没得合(用户 2026-09-01 报的正是这个)。
 *
 * 两个候选尖:任务分支(可能还留着,验收清理档位写「只清 worktree」时就是这样)和那次验收
 * 的合并提交。**取更靠后的那个**,别只看谁存在:
 *   · 分支尖是合并提交的祖先(含相等)→ 合并提交是超集,带它;
 *   · 否则分支上有合并之后的新活 → 那才是最新的,带分支。
 * 只按「分支在不在」二选一的话,一条被上一次接力重新落地成空壳的旧分支就会盖住真正的
 * 验收成果 —— 任务在两台机器之间来回走一圈,代码就丢了。
 *
 * 合并提交只认**仍能从记录的目标分支到达**的:够不着说明目标分支后来被回退或改写过,
 * 那份快照已经不描述仓库现状,宁可如实说「没有可带的代码」,也不打包一个悬空提交冒充
 * 验收成果。
 */
async function packSourceFromRepo(repo: string, task: TaskRow, notes: string[]): Promise<PackSource | null> {
  const branch = await resolveWorktreeBranchName(repo, task.id);
  const branchTip = (await localBranchExists(repo, branch))
    ? await git(repo, ["rev-parse", branch]).catch(() => "")
    : "";
  const merge = task.acceptedMergeCommit?.trim();
  const target = task.acceptedTargetBranch?.trim();
  const landed = !!merge && !!target && await isAncestorIn(repo, merge, target);
  // 分支被别的 worktree 检出着就别去动它的 ref:那会让那个检出的 HEAD 与索引对不上。
  // 这种情况下老老实实按分支现状打包,如实说一句。
  const branchBusy = branchTip ? await branchCheckedOut(repo, branch) : false;

  if (landed && (!branchTip || await isAncestorIn(repo, branchTip, merge!)) && !branchBusy) {
    // 借任务分支这个名字站一下（`git bundle create` 只认 ref），打完包在 packGitState 的
    // finally 里还回去 —— 整段都在仓库锁里,外面看不到中间态。
    await git(repo, ["update-ref", `refs/heads/${branch}`, merge!, ...(branchTip ? [branchTip] : [])]);
    notes.push(
      `任务已在本机验收并合并进 ${target}、worktree ${branchTip ? "已清理" : "和分支都已清理"};`
        + `改带走那次验收的合并提交 ${merge!.slice(0, 8)}`,
    );
    return { branch, head: merge!, acceptedMerge: true, borrowedRef: { previous: branchTip || null } };
  }
  if (branchTip) {
    notes.push(
      branchBusy && landed
        ? `任务 worktree 已不在,而分支 ${branch} 正被别的工作区检出、不能改指向;按它当前的提交打包`
        : `任务 worktree 已不在(多半是验收时清理掉了),按任务分支 ${branch} 当前的提交打包`,
    );
    return { branch, head: branchTip, acceptedMerge: false, borrowedRef: null };
  }
  notes.push(
    merge
      ? "任务 worktree 和分支都已清理,记录的验收合并提交在本机目标分支上也够不着了,没有可迁移的代码状态"
      : "任务 worktree 尚未创建(还没跑过)或已被清理,没有可迁移的代码状态",
  );
  return null;
}

const isAncestorIn = (repo: string, ancestor: string, descendant: string) =>
  git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).then(() => true).catch(() => false);

/** 这个分支正被某个 worktree 检出着吗(检出中的分支不能随便改指向)。 */
async function branchCheckedOut(repo: string, branch: string): Promise<boolean> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]).catch(() => "");
  return out.split("\n").some((line) => line.trim() === `branch refs/heads/${branch}`);
}

/**
 * 自由工作流的审查历史(free_workflow_states + free_review_runs + free_review_rounds
 * + free_workflow_events)。协议形状与「为什么不带机器本地外键」见 handoff-types.ts。
 *
 * 证据文件(report.md/截图)不在这里收:它们躺在 data/runs/<taskId>/free-review/ 下,
 * 已经被 collectRunArtifacts 整棵搬走——所以 run id 必须原样带走,换了就对不上。
 */
export async function collectFreeWorkflow(taskId: string): Promise<HandoffFreeWorkflowPayload | null> {
  const [stateRow] = await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId));
  const runRows = await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId));
  const eventRows = await db.select().from(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, taskId));
  if (!stateRow && !runRows.length && !eventRows.length) return null;

  const roundRows = runRows.length
    ? await db.select().from(freeReviewRounds).where(inArray(freeReviewRounds.runId, runRows.map((r) => r.id)))
    : [];
  const byRun = new Map<string, HandoffFreeReviewRound[]>();
  for (const r of roundRows) {
    const list = byRun.get(r.runId) ?? [];
    list.push({
      round: r.round, status: r.status, conclusion: r.conclusion,
      reviewedCommit: r.reviewedCommit, startedAt: r.startedAt, endedAt: r.endedAt,
    });
    byRun.set(r.runId, list);
  }

  // 审查者 profile id 换成名字:对端按名字重新解析,解析不到就只用于展示。
  const reviewerNames = new Map<string, string>();
  if (stateRow?.selectedReviewerId) {
    const [profile] = await db.select().from(reviewerProfiles)
      .where(eq(reviewerProfiles.id, stateRow.selectedReviewerId));
    if (profile) reviewerNames.set(profile.id, profile.name);
  }

  return {
    state: stateRow
      ? {
          selectedReviewerName: stateRow.selectedReviewerId
            ? reviewerNames.get(stateRow.selectedReviewerId) ?? null
            : null,
          reviewArmed: stateRow.reviewArmed,
          reviewCheckMode: stateRow.reviewCheckMode,
          reviewRetryLimit: stateRow.reviewRetryLimit,
          reviewNote: stateRow.reviewNote,
          reviewAgentType: stateRow.reviewAgentType,
          reviewModel: stateRow.reviewModel,
          reviewReasoningEffort: stateRow.reviewReasoningEffort,
          reviewRunId: stateRow.reviewRunId,
          updatedAt: stateRow.updatedAt,
        }
      : null,
    runs: runRows
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({
        id: r.id,
        reviewerName: r.reviewerName,
        agentType: r.agentType,
        model: r.model,
        reasoningEffort: r.reasoningEffort,
        checkMode: r.checkMode,
        note: r.note,
        targetKind: r.targetKind,
        targetBranch: r.targetBranch,
        targetBaseCommit: r.targetBaseCommit,
        targetCommit: r.targetCommit,
        retryLimit: r.retryLimit,
        currentRound: r.currentRound,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        finishedAt: r.finishedAt,
        rounds: (byRun.get(r.id) ?? []).sort((a, b) => a.round - b.round),
      })),
    events: eventRows
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      .map((e) => ({ kind: e.kind, source: e.source, detail: e.detail, occurredAt: e.occurredAt })),
  };
}
