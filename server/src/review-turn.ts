// 「此刻在跑的是**审查/验证旁路回合**吗」——一个判据，四处共用：起预览放行、开跑不收
// 预览、状态快照、预览工作区门禁。四处各写一份的时候必然漂：后端放行了、按钮还灰着，
// 或者按钮能点、请求照吃 409。
//
// 这类回合的约定是**只读**：读工作区、跑验证、写报告、给结论，不产出新一版代码。所以
// 「任务在跑 = 代码改到一半，预览没有意义」（`stopPreviewOnRerun` 与各处 running 门禁的
// 由来）对它不成立——恰恰相反，审查那十几分钟正是用户最想自己打开页面看一眼的时候，
// 审查者中途提问时更是要照着页面才答得上来。
//
// 判据是 turn 的**运行时身份**，不是「库里有没有 reviewing run」：派审请求可能插在一个
// 普通回合 claimTurn 之后才写进 run 行（free-workflow.ts 里那条 TOCTOU），按库猜会把一个
// 正在改代码的普通回合认成审查回合，预览就起在了 agent 脚下。role 由 claimTurn /
// reclaimTurn 落下，服务重启后 reattach 按原 role 复原，report_stage 认的也是它。
import { turnRole } from "./runs.js";

/**
 * 审查/验证旁路回合正在跑：预览照常开，已经开着的也不收。
 *
 * - `reviewer` = 自由工作流的审查旁路回合（free-review-round.ts）
 * - `side`     = 线上的就地验证轮（orchestrator 的 `reclaimTurn(taskId, "side")`）
 *
 * `native`（`/compact` 这类 CLI 本地命令）不在其列：它压根不碰工作区，也就没有为它开门的
 * 场合，而多认一个身份就多一条「这一刻到底在干什么」判错的路。
 */
export function reviewTurnInFlight(taskId: string): boolean {
  const role = turnRole(taskId);
  return role === "reviewer" || role === "side";
}
