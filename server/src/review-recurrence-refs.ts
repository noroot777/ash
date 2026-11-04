// 「此前报过的发现」清单里每一条的**编号**：`<链序>.<轮>.<条>`，例如 `2.3.1` = 这个任务的第 2 条
// 审查链、第 3 轮报告里抽出的第 1 条现象行。
//
// 为什么是这三段、而不是「清单里第几行」：清单每一轮都重新取样（`review-history.ts` 的 `allocate`），
// 同一条发现这轮排第 5、下轮排第 3；第 2 轮起审查者又复用同一条会话，手上同时有好几份旧清单。
// 按行号编，它照着旧清单填的编号会精确命中**另一条**发现 —— 一条假承接，比没填更坏。
// 这三段只取决于这条发现本身住在哪（链按创建先后排、轮次、报告里的顺序），跟哪一轮渲染无关。
//
// 「第几条」与审查者交卷时数的「本轮第几条」是同一个口径：都是 `extractReportFindings` 抽出来的
// 顺序。所以这一轮的第 N 条，到了下一轮的清单里编号就是 `<链序>.<本轮>.<N>`。
import { asc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRuns } from "./db/schema.js";

/** 任务名下每条审查链的序号（从 1 起，按创建先后；同一时刻按 id 定序，保证逐次读取一致）。 */
export async function chainSequence(taskId: string): Promise<Map<string, number>> {
  const runs = await db.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
    .where(eq(freeReviewRuns.taskId, taskId))
    .orderBy(asc(freeReviewRuns.createdAt), asc(freeReviewRuns.id));
  return new Map(runs.map((run, index) => [run.id, index + 1]));
}

/** 某一轮条目编号的前缀；第 i 条（从 1 起）是 `${前缀}.${i}`。 */
export function findingRefBase(chain: number, round: number): string {
  return `${chain}.${round}`;
}
