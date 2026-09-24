// 用户裁定「把越界的那几条转成独立任务」时，真正把那个任务建出来的地方。
//
// 为什么单独一个文件：`free-review-dispute.ts` 讲的是**一条驳回的状态机**（谁能提、
// 什么时候停、用户怎么裁），这里讲的是**派生任务长什么样**（开工起点、body 里带什么、
// 回链挂在哪）。两件事各有各的判据，挤在一处会让那份状态机注释被建任务的细节淹掉。
//
// 形状照 `post-merge-review.ts` 的 `createPostMergeRepairTask`：同样是「一轮审查未通过
// → 建一个 backlog 派生任务承接」，同样用 `createTasks`、同样 `originTaskId` 回链、
// 同样在 run/round 上记下 taskId 做幂等。差别只在**开工起点怎么选**，见下面 baseOf。
import type { Task } from "@ash/shared";
import { and, eq, isNull } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir, freeReviewReportPath } from "./free-review-files.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { createTasks, enrichTasks } from "./task-store.js";
import { id, now } from "./util.js";
import type { ReviewRoundRow, ReviewRunRow } from "./free-review-dispute.js";

type TaskRow = typeof tasks.$inferSelect;

/** 标题里给原任务留的长度：派生任务在列表里要一眼看出它承接的是谁。 */
const TITLE_SOURCE_LEN = 40;

/**
 * 派生任务的开工起点：**被审查的那一版代码的 commit**（`round.reviewedCommit`）。
 *
 * 三个候选里为什么是它：
 * - 分支名 `ash/xxxxxxxx`：原任务一旦验收，worktree 会被删、分支被 `git branch -d`。
 *   这个任务是 backlog、可能几周后才起跑，那时 base 已经悬空。
 * - 缺省（跟随目标分支最新）：这几条意见是对着**那一版**代码提的，从别处开工连复现
 *   都做不到，接手的人第一件事就是怀疑报告写错了。
 * - `reviewedCommit`：不可变；原任务验收合并后它仍在目标分支的历史里可达。
 *
 * 取不到（老数据没有锚点）时退回缺省而不是猜一个：猜错的 base 比没有 base 更难查。
 * `mergeTargetBranch` 另外继承原任务的最终目标，所以「从哪开工」和「往哪合」是两件
 * 独立的事，冻结前者不会把后者也钉死在旧分支上。
 */
function baseOf(round: ReviewRoundRow): string | null {
  return round.reviewedCommit ?? null;
}

function titleOf(source: TaskRow, round: number): string {
  const name = source.title.length > TITLE_SOURCE_LEN
    ? `${source.title.slice(0, TITLE_SOURCE_LEN)}…`
    : source.title;
  return `承接第 ${round} 轮审查的越界意见：${name}`;
}

function bodyOf(source: TaskRow, run: ReviewRunRow, round: ReviewRoundRow, deferReason: string): string {
  const report = freeReviewReportPath(source.id, run.id, round.round);
  const dir = freeReviewEvidenceDir(source.id, run.id, round.round);
  return `承接任务「${source.title}」第 ${round.round} 轮审查里的几条意见。\n\n` +
    `这些意见**审查者说得对、依据也可复现**，只是它们超出了原任务的边界（多半是那一轮\n` +
    `修复自己引入的衍生问题），所以用户裁定把它们从原任务挪出来单独做，而不是让原任务\n` +
    `继续「改→引入→再被打回」。原任务不需要你动，也不要重新打开它。\n\n` +
    `原任务：${source.id}\n审查链：${run.id} · 第 ${round.round} 轮（审查者：${run.reviewerName}）\n` +
    `审查报告：[report.md](${report})\n证据目录：${dir}\n` +
    (round.reviewedCommit ? `被审查的那一版：${round.reviewedCommit}\n` : "") +
    `\n执行者逐条给出的「为什么它属于本任务之外」：\n\n${deferReason}\n\n` +
    "请完整读取报告，**只处理上面列出的那几条**；报告里其余部分要么原任务已经改掉、" +
    "要么被用户裁定作废，不在本任务范围内。";
}

/**
 * 把一条「等着裁定、且执行者提了转出」的驳回落成 `deferred` + 一个 backlog 派生任务。
 *
 * 顺序是**先占裁定、再建任务、建失败就把裁定退回去**，而不是 upheld 那种「裁定先落账、
 * 副作用失败只记一笔」：upheld 的副作用（发修复消息）在面板上有第二个入口能补，这里
 * 没有——留下一条写着「已转独立任务」却没有任务的记录，比让用户重点一次糟得多。
 *
 * 先占裁定而不是先建任务，是为了并发：占住之后再建，最坏结果是「裁定被退回、没有任务」；
 * 反过来先建再占，CAS 输掉的那一路会留下一个没人回链的孤儿任务。
 */
export async function deferOpenDispute(
  source: TaskRow,
  open: { run: ReviewRunRow; round: ReviewRoundRow },
): Promise<Task> {
  const { run, round } = open;
  // 规矩③：执行者没有逐条写明越界依据，就没有这个出口。凭空的 deferred 裁定等于
  // 把「转独立任务」变成一条谁都能按的免修按钮。
  const deferReason = round.disputeDeferReason?.trim();
  if (!deferReason) {
    throw new Error(
      "执行者没有提出「这几条超出本任务边界」，不能转成独立任务；" +
      "要让它不改就用「采纳执行者说法」，要让它照改就用「维持审查意见」",
    );
  }
  if (!tryAcquireFreeWorkflowAction(source.id)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    // 幂等：重复裁定（用户手点两下、响应丢了重来）回到同一个任务，不建第二个。
    const existingId = (await db.select({ taskId: freeReviewRounds.disputeDeferredTaskId })
      .from(freeReviewRounds).where(eq(freeReviewRounds.id, round.id))).at(0)?.taskId;
    if (existingId) {
      const existing = (await db.select().from(tasks).where(eq(tasks.id, existingId))).at(0);
      if (existing) return (await enrichTasks([existing]))[0]!;
    }

    const at = now();
    const claimed = await db.update(freeReviewRounds)
      .set({ disputeResolution: "deferred", disputeResolvedAt: at })
      .where(and(eq(freeReviewRounds.id, round.id), isNull(freeReviewRounds.disputeResolution)))
      .returning({ id: freeReviewRounds.id });
    if (!claimed.length) throw new Error("这一轮驳回已经被裁定过了");

    let created: Task;
    try {
      const rows = await createTasks([{
        id: id(),
        projectId: source.projectId,
        groupId: source.groupId,
        parentId: null,
        title: titleOf(source, round.round),
        body: bodyOf(source, run, round, deferReason),
        mode: "single",
        // backlog 且不起跑：这是一条**计划**，起不起、什么时候起由用户决定。裁定的
        // 意思是「这几条不在本任务里修」，不是「现在立刻开一个新回合去修」。
        status: "backlog",
        labels: source.labels,
        dependsOn: "[]",
        resumeDependsOn: "[]",
        agentType: source.agentType,
        executorId: source.executorId,
        ownerUserId: source.ownerUserId, // 派生任务继承源任务的归属(§八)
        model: source.model,
        reasoningEffort: source.reasoningEffort,
        autoTitle: false,
        createdAt: at,
        updatedAt: at,
        useWorktree: source.useWorktree,
        worktreeBase: baseOf(round),
        mergeTargetBranch: source.mergeTargetBranch,
        originTaskId: source.id,
        // 仍是 free：这条出路本身就是 free 链缺的那个终止条件，换 workflowMode 解决
        // 不了什么——而且 backlog 任务身上一条审查链都没有，审查只在用户显式派审时才
        // 开始，所以它不会自己转起来。preset 更不行：那需要一份工作流步骤配置，硬塞
        // 过去只会建出一个跑不起来的任务。
        workflowMode: "free",
      }]);
      created = rows[0]!;
      if (!created) throw new Error("派生任务创建失败");
    } catch (error) {
      await db.update(freeReviewRounds)
        .set({ disputeResolution: null, disputeResolvedAt: null })
        .where(eq(freeReviewRounds.id, round.id));
      throw error;
    }

    await db.update(freeReviewRounds)
      .set({ disputeDeferredTaskId: created.id })
      .where(eq(freeReviewRounds.id, round.id));
    await appendTaskTimeline(source.id,
      `你裁定把第 ${run.currentRound} 轮里超出本任务边界的那几条意见转成独立任务：` +
      `${created.title}（${created.id}，待办、未起跑）。` +
      "这一轮不再要求本任务照它修复；审查报告与证据原样保留，审查结论本身不改写。");
    bus.publish({ type: "task.review", taskId: source.id });
    return created;
  } finally {
    releaseFreeWorkflowAction(source.id);
  }
}
