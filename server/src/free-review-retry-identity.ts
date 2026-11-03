// 「继续本轮审查」认的是**哪一轮审查的哪一次**,不是「整个任务最新的那条会话」。
//
// 为什么要单独一份身份(下一次自由审查第 1 轮 R1,已实测):这颗按钮从前借用「重跑上一回合」
// 那套判据 —— 先找全任务最新的会话,它是审查者才走审查档。可审查停在「等你拿主意」时,用户
// 照样可以发 `/compact` 这类原生命令:它生成一条更新的普通旁路会话,却不结束那一轮审查。于是
// 页面上按钮消失、刷新也回不来,拿着审查会话去点 409「不是最新一次」,拿最新会话去点 409「不是
// 异常结束」—— 那一轮审查明明还在等用户,入口却被一件不相干的事挤掉了。
//
// 所以审查档的恢复对象与权限只按审查链自己的状态定:最近一条链、它的当前轮次、这一轮此刻的
// 代次(`regression_evidence.generation`,每次重跑都会换)。服务端在状态里把这份身份发给前端
// (`FreeReviewRound.retry`),前端原样带回来;对不上 = 页面是旧的(中间被重跑过、换了一轮),
// 拒绝而不是照跑。能不能继续仍是 `freeReviewRetryBlocker` 那一句,这里不另起一套判据。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { freeReviewRetryBlocker, reviewAwaitsInputDecision, type ReviewRunRow } from "./free-review-round.js";

type TaskRow = typeof tasks.$inferSelect;
type ReviewRoundRow = typeof freeReviewRounds.$inferSelect;

/** 前端带回来的那一份:哪条链、第几轮、这一轮的哪一代次。 */
export type ReviewRetryIdentity = { runId: string; round: number; generation: string | null };

async function generationOf(taskId: string, run: ReviewRunRow, round: number): Promise<string | null> {
  return (await db.select({ generation: regressionEvidence.generation }).from(regressionEvidence)
    .where(eq(regressionEvidence.directory, freeReviewEvidenceDir(taskId, run.id, round)))).at(0)?.generation ?? null;
}

/** 这一轮能「继续本轮审查」就给出它此刻的代次,不能就是 null。`run` 必须是最近那条链。 */
export async function reviewRetryGeneration(
  task: TaskRow, run: ReviewRunRow | null, round: ReviewRoundRow | null,
): Promise<{ generation: string | null } | null> {
  if (!run || !round || round.round !== run.currentRound) return null;
  if (freeReviewRetryBlocker(run, round, await reviewAwaitsInputDecision(task, run, round))) return null;
  return { generation: await generationOf(task.id, run, round.round) };
}

/** 页面带回来的身份还是不是**此刻**那一轮那一次。不是就给出拒绝理由。 */
export async function reviewRetryIdentityMismatch(
  taskId: string, run: ReviewRunRow, wanted: ReviewRetryIdentity,
): Promise<string | null> {
  const same = run.id === wanted.runId && run.currentRound === wanted.round
    && await generationOf(taskId, run, run.currentRound) === wanted.generation;
  return same ? null : "页面上的这一轮审查已经变了（被重跑过或换了一轮），刷新后再试";
}
