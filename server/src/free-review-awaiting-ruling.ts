import { and, eq, isNull, sql } from "drizzle-orm";
import { freeReviewRounds, freeReviewRuns } from "./db/schema.js";

// 「这一轮挂着一条等用户裁定的驳回」的 SQL 判据。单独一个文件、只依赖表定义：裁定那一路
// （free-review-dispute.ts）和任务投影（task-store.ts 的 `disputeOpen`）都从这里取，后者不必为了
// 一个条件去引整条裁定链路。

/**
 * 同 `hasDispute` 的 SQL 版：查询与 CAS 都用它，不各写一份 `IS NOT NULL`。两边口径一偏（老数据
 * 或接力载荷里理由是空串），裁定闸按 SQL 认定「有驳回、等裁定」挡住预约，界面按
 * `hasDispute` 认定「没驳回」不给卡——用户看得见「等裁定」，却找不到能裁的那一条。
 */
export const disputeWritten = sql`(coalesce(${freeReviewRounds.disputeReason}, '') <> '' or coalesce(${freeReviewRounds.disputeDeferReason}, '') <> '')`;

/**
 * 「等着用户裁定」的那组条件（不含任务过滤）：驳回已写下、没裁定、没被用户新派的审查取代、
 * 是工作区审查。按任务查（`unresolvedDisputes`）、跨任务查（`openDisputeTargets`）和任务列表
 * 那一格（`disputeOpen`）共用这一份，各写一遍的话，飞书推出去的卡、审查面板上的卡和侧栏那颗点
 * 迟早不是同一批。
 */
export const awaitingRuling = and(
  eq(freeReviewRuns.targetKind, "workspace"),
  disputeWritten,
  isNull(freeReviewRounds.disputeResolution),
  isNull(freeReviewRounds.disputeSupersededAt),
);
