// 派出去的任务在**建出来那一刻**就带着审查预约：执行回合正常结束后自动开审，不靠用户事后手动派审。
//
// 为什么非得在创建时带上：前置的站稳判据（server/src/prerequisite-standing.ts）里，「完成时既没预约、也从没审过」
// 是完成即站稳的 —— 做完再手动派审，下游早就从没审过的那一版开工了，审查之后的修复它拿不到。
//
// 一条建任务的请求怎么说审查（`CreateReviewChoice`）：
//   · "default" = 交给这条任务归属人在「设置 → 审查者」里设的默认那位；没设默认就不带（跟以前一样）；
//   · "none"    = 明确不审；
//   · { reviewer } = 指定一位（id，智能体那一侧也可以写名字）。
// 字段缺省 = 不带：新建面板、系统切出来的任务、老客户端都走这一档，行为不变。派出去的那几处入口（MCP 建任务、
// 派活单、可以派出去的活、回复框「派出去」）由各自那一侧把缺省落成 "default"。
//
// 带上的就是一条普通的预约（free_workflow_states），跟审查面板里手动保存的那条是同一个东西：结算、自动复审、
// 驳回裁定、取消、改预约全走现有那一套。轮数和检查类型跟默认走（下面那两个数），要改的人建出来之后在预约框里改。
import type { FreeReviewCheckMode, ReviewerProfile } from "./free-workflow.ts";

export type CreateReviewChoice = "default" | "none" | { reviewer: string };

/** 派出去时带的那套预约：失败后自动复审 3 轮、逻辑检查（用户 2026-11-18 定）。 */
export const CREATE_REVIEW_CHECK_MODE: FreeReviewCheckMode = "logic";
export const CREATE_REVIEW_RETRY_LIMIT = 3;

/** 请求体里那一格读成选择；读不懂给 error。缺省（undefined）原样交回 undefined = 不带。 */
export function parseCreateReviewChoice(raw: unknown, where = "review"): CreateReviewChoice | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (raw === "default" || raw === "none") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const reviewer = (raw as { reviewer?: unknown }).reviewer;
    if (typeof reviewer === "string" && reviewer.trim()) return { reviewer: reviewer.trim() };
  }
  return { error: `${where} 只能是 "default"、"none" 或 { reviewer: "<审查者 id 或名字>" }` };
}

/** 一张审查者清单里，这个选择落到哪一位（id 优先，名字只认唯一的那一位）；不审、没设默认、找不到都给 null。 */
export function reviewerOfChoice(choice: CreateReviewChoice | undefined, reviewers: readonly ReviewerProfile[]): ReviewerProfile | null {
  if (!choice || choice === "none") return null;
  if (choice === "default") return reviewers.find((reviewer) => reviewer.isDefault) ?? null;
  const byId = reviewers.find((reviewer) => reviewer.id === choice.reviewer);
  if (byId) return byId;
  const byName = reviewers.filter((reviewer) => reviewer.name === choice.reviewer);
  return byName.length === 1 ? byName[0]! : null;
}

/**
 * 派出去那一下交给 navi 的那一份：照此刻画面上那一格的样子落成明确的一位或「不审」，不让服务端再替你挑一次
 * （按下之前你看到的默认就是派出去用的那位）。
 *
 * 清单还没读到（null：还在读，或者读失败了）时只有「不审」定得下来，其余给 null = **还不能派** —— 画面上
 * 看不出交给谁，就不能拿这个选择派出去（服务端会照样按默认带上预约，用户却没确认过是谁）。调用方据此拦住派出。
 */
export function concreteReviewChoice(choice: CreateReviewChoice, reviewers: readonly ReviewerProfile[] | null): CreateReviewChoice | null {
  if (choice === "none") return "none";
  if (!reviewers) return null;
  const reviewer = reviewerOfChoice(choice, reviewers);
  return reviewer ? { reviewer: reviewer.id } : "none";
}
