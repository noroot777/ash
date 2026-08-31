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
import { expandHome, isGitRepo, worktreePathFor } from "./git.js";
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
 * git 状态打包。只在任务开了 worktree 且 worktree/分支真实存在时有货:
 * 未提交改动先做 WIP 提交（进的是任务自己的分支,不碰用户分支）,然后跟对端仓库的
 * 分支尖协商公共前置提交,打一个尽量薄的 bundle;协商不出就整条历史全量打包。
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
  if (!existsSync(wt) || !(await isGitRepo(wt))) {
    notes.push("任务 worktree 尚未创建（还没跑过）,没有可迁移的代码状态");
    return null;
  }
  return withRepoLock(repoPath, async () => {
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
    const head = await git(wt, ["rev-parse", "HEAD"]);
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
      return { branch, head, full: false, prereqs, bundleBase64: "" };
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
      };
    } finally {
      rmSync(bundlePath, { force: true });
    }
  });
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
