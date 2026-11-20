// 派出去的任务**建出来那一刻**就带着审查预约（为什么、几种选法见 shared/src/review-on-create.ts）。
//
// 只做两件事，都由 createTasks（task-store.ts）在建任务那一笔里调：
//   · `resolveCreateReviews`：落库之前把每一条的选择定成一位具体的审查者 —— 「默认」按**这条任务的归属人**
//     认（智能体替用户派活时，新任务归的就是那条来源任务的归属人），指定的那位也只在归属人名下找。指定了却
//     找不到就整批不建（`ReviewOnCreateError`），不悄悄当成不审；没设默认就不带，跟以前一样。
//   · 预约槽跟任务行同一笔落库（`reservationRows`），提交之后补那句「已预约审查」和广播（`announceCreateReviews`）。
//
// 解析要做两遍：进门一遍是为了早点退回（指错了人，分支计划都不用算）；**落库那笔事务里再一遍才作数** —— 两遍之间
// 隔着执行器快照、repo 锁、分支计划好几个 await，那位审查者可能已经被删（删除那一侧整笔在事务里，reviewer-profiles.ts），
// 「刚才查到过」证明不了落库时它还在。第二遍里指定的那位没了照样整批不建，「默认」按那一刻的默认重新认。
//
// 带上的就是一条普通的手动预约（来源记 `user`）：结算、自动复审、驳回裁定、取消、改预约全走现有那一套，这里
// 不另起一条。预约本来就不适用的任务（团队执行者、审查任务、非自由工作流、归档的 —— 门跟 free-workflow.ts
// `reserveFreeReview` 是同一道）照旧不带，也不因此让创建失败。
import { inArray, isNull, or } from "drizzle-orm";
import {
  CREATE_REVIEW_CHECK_MODE, CREATE_REVIEW_RETRY_LIMIT, type CreateReviewChoice,
} from "@navi/shared/review-on-create";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeWorkflowStates, reviewerProfiles } from "./db/schema.js";
import { reservationNotice } from "./free-review-input.js";
import { appendTaskTimeline } from "./task-timeline.js";

/** 指定的审查者在归属人名下找不到（或名字对上了好几位）。调用方回 400。 */
export class ReviewOnCreateError extends Error {}

type Candidate = {
  id: string;
  mode?: string | null;
  parentId?: string | null;
  reviewOf?: string | null;
  workflowMode?: string | null;
  archived?: boolean | null;
  ownerUserId?: string | null;
  review?: CreateReviewChoice;
};

export type CreateReviewSlot = { taskId: string; reviewerId: string; reviewerName: string };

/** 跟手动预约同一道门（free-workflow.ts `reserveFreeReview`）。 */
const reservable = (row: Candidate) =>
  (row.mode ?? "single") === "single" && !row.parentId && !row.reviewOf && row.workflowMode === "free" && !row.archived;

/** 读审查者表用的那一头：缺省根 `db`，落库那一遍传事务（见顶部）。 */
type Reader = Pick<typeof db, "select">;

export async function resolveCreateReviews(rows: Candidate[], reader: Reader = db): Promise<CreateReviewSlot[]> {
  const wanted = rows.filter((row) => row.review && row.review !== "none" && reservable(row));
  if (!wanted.length) return [];
  const owners = [...new Set(wanted.map((row) => row.ownerUserId ?? null))];
  const named = owners.filter((owner): owner is string => owner !== null);
  const profiles = await reader.select().from(reviewerProfiles).where(or(
    ...(owners.includes(null) ? [isNull(reviewerProfiles.ownerUserId)] : []),
    ...(named.length ? [inArray(reviewerProfiles.ownerUserId, named)] : []),
  ));
  const slots: CreateReviewSlot[] = [];
  for (const row of wanted) {
    const mine = profiles.filter((profile) => (profile.ownerUserId ?? null) === (row.ownerUserId ?? null));
    const choice = row.review!;
    let picked: (typeof mine)[number] | undefined;
    if (choice === "default") picked = mine.find((profile) => profile.isDefault);
    else if (choice !== "none") {
      const byName = mine.filter((profile) => profile.name === choice.reviewer);
      picked = mine.find((profile) => profile.id === choice.reviewer) ?? (byName.length === 1 ? byName[0] : undefined);
      if (!picked) {
        throw new ReviewOnCreateError(byName.length > 1
          ? `叫「${choice.reviewer}」的审查者不止一位，请用审查者 id 指定`
          : `审查者「${choice.reviewer}」不存在`);
      }
    }
    if (picked) slots.push({ taskId: row.id, reviewerId: picked.id, reviewerName: picked.name });
  }
  return slots;
}

/**
 * 摆单那一刻就把指定的那位核一遍、名字换成 id（挂在回复框顶上的活：智能体按名字指了一位，那一行要画得出是谁）。找不到当场
 * 退回给智能体（`ReviewOnCreateError`），不等用户按「派出去」才失败。默认、不审原样交回。
 */
export async function pinReviewChoice(choice: CreateReviewChoice | undefined, owner: string | null): Promise<CreateReviewChoice | undefined> {
  if (!choice || typeof choice === "string") return choice;
  const [slot] = await resolveCreateReviews([{ id: "pin", workflowMode: "free", ownerUserId: owner, review: choice }]);
  return { reviewer: slot!.reviewerId };
}

/** 跟任务行同一笔落库的预约槽（新任务没有旧槽，直接插）。 */
export function reservationRows(slots: CreateReviewSlot[], at: string): (typeof freeWorkflowStates.$inferInsert)[] {
  return slots.map((slot) => ({
    taskId: slot.taskId,
    selectedReviewerId: slot.reviewerId,
    reviewArmed: true,
    reviewCheckMode: CREATE_REVIEW_CHECK_MODE,
    reviewRetryLimit: CREATE_REVIEW_RETRY_LIMIT,
    reviewNote: null,
    reviewRunId: null,
    reviewSource: "user" as const,
    reviewAgentType: null,
    reviewExecutorId: null,
    reviewModel: null,
    reviewReasoningEffort: null,
    reviewHeldToken: null,
    updatedAt: at,
  }));
}

/** 提交之后：时间线上那句「已预约审查」（跟手动预约同一句）、让开着的页面重读预约。各条各自兜底。 */
export async function announceCreateReviews(slots: CreateReviewSlot[]): Promise<void> {
  for (const slot of slots) {
    try {
      await appendTaskTimeline(slot.taskId, reservationNotice({
        reviewer: slot.reviewerName, override: null, mode: CREATE_REVIEW_CHECK_MODE, retries: CREATE_REVIEW_RETRY_LIMIT, note: null, updated: false,
      }));
    } catch (error) {
      console.error(`[navi] 建任务带的审查预约已落库，写时间线出错 ${slot.taskId}:`, error);
    }
    bus.publish({ type: "task.review", taskId: slot.taskId });
  }
}
