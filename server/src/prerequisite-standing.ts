// 「一条前置站稳了没有」—— **唯一的判定**。起跑的闸、等齐之后的放行、页面上那句「在等谁、它到哪一步了」
// 都问这里，不各自拼一套。
//
// 站稳 = 下游此刻从它那里拿到的代码，就是它最终要交出去的那一版：
//   ① 已经验收合入的，当然算（不再看审查，那一版已经盖过章）。
//   ② 执行者确认完成（done），而且此刻没有回合在跑 —— 续聊里又在改的不算（续聊时 status 是 running；
//      回合锁已经占上、状态还没写成 running 的那一小段也算在跑）。
//   ③ 没预约过审查、也没审过的：完成即站稳。
//   ④ 预约了、正在审、打回在修、没过停在等用户决定：都不算。
//   ⑤ 审过的：最近那条审查链通过了，或者被用户裁定收场（「这一轮不用改了」「转为独立任务」），
//      **并且审过的就是现在的代码**。新鲜度判据只认 shared 的 `reviewAnchorMatches` 那一份 —— 审查面板
//      判「结论过期」用的也是它，两边说法不会对不上。
//   ⑥ 工作区里有没提交的改动的不算：下游只能从提交拿代码，那些改动带不过去，等于没给全。不用 worktree 的
//      前置同样如此（它的工作区就是项目目录，交出的是那里检出的提交）—— 它是代码前置，不是排先后的队列。
//
// **证明不了就不算**：工作区在、却读不出它此刻的提交或干不干净（`unreadable`），不能当成「没变」放行。
// 工作区已经不在（被清理，代码只剩分支）时，审过的那一版只能拿审查锚定的提交去对分支头，对不上就是审查后又动过。
// 取工作区快照一律用 verify（每个文件重读字节）：这份结果是拿去授权下游开工的，不能信只供显示的 stat 缓存。
//
// 站稳的同时交出**这一次判定核实过的那一版提交**（`commit`）：起点就用它，不再另读一次分支头 —— 判定和取代码
// 之间隔着锁等待与 git 读取，前置在这段时间里又开一轮、提交了新代码，再读分支头拿到的就是没审过的那一版。
//
// 失败、取消、归档的也不算 —— 下游要的是它的代码，跳过它往下走就是拿着残缺的底子开工。
//
// 合并结果审查（`accepted_merge`）是验收之后的独立只读链，不参与：走到那一步的前置已经在 ① 里了。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { isAcceptedStage, type TaskStage } from "@ash/shared";
import type { PrerequisiteStep } from "@ash/shared/prerequisites";
import { reviewAnchorMatches } from "@ash/shared/free-workflow";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, freeWorkflowStates, projects, tasks } from "./db/schema.js";
import { resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { isTurnClaimed } from "./runs.js";
import { acceptedHeadRef, commitAt } from "./task-branch-plan.js";
import { workspaceSnapshot, type WorkspaceSnapshot } from "./workspace-fingerprint.js";

type TaskRow = typeof tasks.$inferSelect;

/** `commit`：站稳时这次判定核实过、下游该拿的那一版；已验收的（交给目标分支判）为 null。 */
export type PrerequisiteStanding = { step: PrerequisiteStep; round: number | null; commit: string | null };

const at = (step: PrerequisiteStep, round: number | null = null, commit: string | null = null): PrerequisiteStanding =>
  ({ step, round, commit });

/** 最近那条工作区审查链与它的当前轮（run 已结束时就是最后出结论的那一轮）。 */
async function latestReview(taskId: string) {
  const run = (await db.select().from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.targetKind, "workspace")))
    .orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0);
  if (!run) return null;
  const round = (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0) ?? null;
  return { run, round };
}

/**
 * 一条任务交出来的那一版，**此刻在仓库里读得到的**：分支头；分支没了取验收时存下的成果（私有 ref、成果提交）；
 * 那些也读不到（换过克隆，`refs/ash/*` 和压缩前的源提交都不在了）就取验收合入的那个提交 —— 它在目标分支上，
 * 内容里一定有这份成果。都读不到返回 null。
 *
 * **「已验收」本身不是证据**：它只说明某一版进过它自己的目标分支，不说明下游手里有。所以这里只交出读得到的
 * 提交，有没有、要不要合，交给调用方按 `versionDelivery` 对着下游的目标判（prerequisite-start-point.ts）。
 */
export async function deliveredCommit(repo: string, task: TaskRow): Promise<string | null> {
  const readable = (commit: string | null) => commit ? commitAt(repo, commit) : Promise.resolve(null);
  const merged = task.acceptedMergeCommit && task.acceptedMergeCommit !== task.acceptedBaseCommit ? task.acceptedMergeCommit : null;
  return await commitAt(repo, await resolveWorktreeBranchName(repo, task.id))
    ?? await commitAt(repo, acceptedHeadRef(task.id))
    ?? await readable(task.acceptedSourceCommit)
    ?? await readable(merged);
}

/**
 * 它干活的那个目录此刻是什么样：`live` = 目录在、读得出（快照里 head 与 dirty 都有值）；`gone` = 用 worktree、
 * 目录已经不在，只剩分支上的提交；`unreadable` = 目录在却读不出来。
 */
type WorkspaceProof =
  | { kind: "live"; snapshot: WorkspaceSnapshot }
  | { kind: "gone"; commit: string | null }
  | { kind: "unreadable" };

async function workspaceProof(task: TaskRow): Promise<WorkspaceProof> {
  const repo = (await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, task.projectId))).at(0)?.repoPath;
  if (!repo) return { kind: "unreadable" };
  const path = task.useWorktree ? worktreePathFor(repo, task.id) : repo;
  // 目录在、却没有 `.git` 的是清理留下的空壳（git.ts worktreeLeftoverAt）：在里面读快照会上溯到主仓，读到的是主仓的提交。
  if (task.useWorktree && !existsSync(join(path, ".git"))) return { kind: "gone", commit: await deliveredCommit(repo, task) };
  const snapshot = await workspaceSnapshot(path, { verify: true });
  return snapshot.head && snapshot.dirty !== null ? { kind: "live", snapshot } : { kind: "unreadable" };
}

export async function prerequisiteStanding(task: TaskRow): Promise<PrerequisiteStanding> {
  if (isAcceptedStage(task.stage as TaskStage | null)) return at("settled");
  if (task.archived) return at("archived");
  const [review, armed] = await Promise.all([
    latestReview(task.id),
    db.select({ armed: freeWorkflowStates.reviewArmed }).from(freeWorkflowStates)
      .where(eq(freeWorkflowStates.taskId, task.id)).then((rows) => !!rows.at(0)?.armed),
  ]);
  const round = review?.run.currentRound ?? null;
  const reviewing = review?.run.status === "reviewing";
  switch (task.status) {
    case "running":
    case "queued":
    case "awaiting_review":
      if (reviewing) return at("reviewing", round);
      // 上一轮没过、自动复审挂着：这一回合就是在按意见修。
      return review && review.run.status !== "passed" && review.round?.status !== "passed" && armed
        ? at("repairing", round) : at("running");
    case "paused": return task.question ? at("question") : reviewing ? at("reviewing", round) : at("paused");
    case "backlog": return at("not_started");
    case "failed": return at("failed");
    case "canceled": return at("canceled");
    case "done": break;
    default: return at("running");
  }
  if (reviewing) return at("reviewing", round);
  // 回合锁已经占上、状态还没写成 running：一轮正要开始，它的代码马上会变。
  if (isTurnClaimed(task.id)) return at("running");
  if (armed) return at("review_reserved");
  const { unresolvedDisputes } = await import("./free-review-dispute.js");
  if ((await unresolvedDisputes(task.id)).length) return at("review_disputed", round);
  const closed = !review?.round || review.run.status === "passed"
    || review.round.disputeResolution === "withdrawn" || review.round.disputeResolution === "deferred";
  if (!closed) return at("review_failed", round);
  const proof = await workspaceProof(task);
  if (proof.kind === "unreadable") return at("unreadable");
  const reviewed = review?.round ?? null;
  if (proof.kind === "gone") {
    // 目录没了没有「没提交的改动」这回事；审过的要拿审查锚定的提交对分支头。
    if (reviewed && (!reviewed.reviewedCommit || reviewed.reviewedCommit !== proof.commit)) return at("review_stale", round);
    return at("settled", null, proof.commit);
  }
  const { snapshot } = proof;
  if (reviewed && reviewAnchorMatches(reviewed, snapshot) !== true) return at("review_stale", round);
  // 不用 worktree 的也一样：它交出的就是项目目录此刻检出的那个提交，没提交的改动带不过去。那些改动
  // 是不是它的分不出来 —— 分不出来就是证明不了，等它们提交或清掉。
  if (snapshot.dirty) return at("dirty");
  return at("settled", null, snapshot.head);
}

/** 一批前置一次判完；查不到的（被删了）不在结果里。 */
export async function prerequisiteStandings(ids: string[]): Promise<Map<string, { task: TaskRow; standing: PrerequisiteStanding }>> {
  const out = new Map<string, { task: TaskRow; standing: PrerequisiteStanding }>();
  if (!ids.length) return out;
  const rows = await db.select().from(tasks).where(inArray(tasks.id, [...new Set(ids)]));
  await Promise.all(rows.map(async (task) => { out.set(task.id, { task, standing: await prerequisiteStanding(task) }); }));
  return out;
}
