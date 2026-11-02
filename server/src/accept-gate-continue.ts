// 门禁出了结论之后系统欠用户的那一步：绿了把用户点的那一次验收接着做完，红了交回任务去修。
// 从 accept-gate.ts 拆出来；结算当场（accept-gate-settle.ts）和重启补办（accept-gate-recover.ts）
// 都走 followUpGate。
import { eq } from "drizzle-orm";
import type { AcceptGateView } from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, tasks } from "./db/schema.js";
import { handOffGateFailure, parseChoices } from "./accept-gate-handoff.js";
import { latestRun } from "./accept-gate-state.js";
import { appendTaskTimeline } from "./task-timeline.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

// 正在办的 runId。红了那一笔要等到投递落定才算办完，比 followUpGate 返回得晚，所以记号一直
// 挂到那时；同一进程里再进来一次（重复恢复、结算与补办撞上）直接让开，不会交两遍、合两遍。
const following = new Set<string>();

const clearOwed = (runId: string) =>
  db.update(acceptGateRuns).set({ settlement: null }).where(eq(acceptGateRuns.id, runId));

/**
 * 办掉一次结论欠下的那一步。结算当场（accept-gate-settle.ts）和重启补办（accept-gate-recover.ts）
 * 共用这一份，`resumeNote` 只在补办时给：真的要动手了才往时间线上说一句。
 *
 * **销账只认办完的证明**（第 2 轮审查）。settlement 记号是重启后唯一的线索，清早了就再也补不上：
 *  · 绿：任务已经 accepted（最终阶段）。merged、验收凭据已写这些都是 acceptTask 走到一半的
 *    中间态 —— 合并落了、清理和最终验收还没做 —— 它们照样进 acceptTask，由它自己的 merged
 *    续做路径收完；
 *  · 红：修复输入已经落进会话（continueWhenIdle 的 onDelivered），或者带审查权限那条已经持久
 *    入队，或者交接失败已经可见地记了账（同没重启过时那一次失败一样，用户手里有「再交一次」）。
 *    handoff_at 只说明「发起过」，不说明送到了，所以不拿它当证明；
 *  · 都不欠了：任务没了，或者这一次已经不是它最近的那一次（后来的那一次说了算）。
 * 判之前的读库失败、续办自己抛出来的异常一律**不销账**：记号留着，下次启动再补。
 */
export async function followUpGate(row: GateRow, view: AcceptGateView, resumeNote?: string): Promise<void> {
  if (following.has(row.id)) return;
  following.add(row.id);
  let handedOff = false;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, row.taskId))).at(0);
    const owed = !!task && (await latestRun(row.taskId))?.id === row.id
      && (row.status === "passed" ? task.stage !== "accepted" : row.status === "failed");
    if (!owed) { await clearOwed(row.id); return; }
    if (resumeNote) await appendTaskTimeline(row.taskId, resumeNote);
    if (row.status === "passed") {
      await continueAcceptance(row);
      await clearOwed(row.id);
      return;
    }
    // 交接自己在投递落定时销账（accept-gate-handoff.ts），这里只把「正在办」的记号交给它收。
    handedOff = true;
    await handOffGateFailure(row, view, false, () => following.delete(row.id));
  } catch (error) {
    handedOff = false;
    throw error;
  } finally {
    if (!handedOff) following.delete(row.id);
  }
}

/**
 * 绿了：把用户那一下点的验收接着做完。
 *
 * 必须带上当初的选择（commit / confirmUnverified）——他在确认框里选的是什么，这一次就
 * 该发生什么；也必须带上 `passedRunId`，否则非 git 项目定不出 HEAD，会再触发一次门禁。
 */
async function continueAcceptance(row: GateRow): Promise<void> {
  const choices = parseChoices(row.acceptOptions);
  const { acceptTask } = await import("./task-accept.js");
  const result = await acceptTask(row.taskId, choices.by, {
    commit: choices.commit,
    confirmUnverified: choices.confirmUnverified,
    acceptGatePassedRunId: row.id,
    reviewAuthority: choices.reviewAuthority,
  }).catch((error) => ({ accepted: false as const, error: error instanceof Error ? error.message : String(error) }));
  if (!result.accepted) {
    const reason = "reason" in result ? result.reason : null;
    // 「又要跑一遍门禁」不是失败：它跑着的这十几分钟里树又动了（或者命令被换了一条），
    // 于是这一按按新的那一份重跑。说清这件事，别让用户以为验收砸了。
    if (reason === "accept_gate_required" || reason === "accept_gate_running") {
      await appendTaskTimeline(
        row.taskId,
        `验收前置命令通过了，但它验的已经不是现在这一份（命令跑的那十几分钟里工作区又有了新提交，`
          + `或者这条命令被改过）。所以没有直接合并，而是按**现在**这一份重新跑一遍；绿了仍会自动接着合。`,
      );
      return;
    }
    // acceptTask 自己已经把失败原因写进时间线了，这里只补一句「这是门禁之后自动续的那一次」，
    // 否则用户只看见一条没头没尾的验收失败，不知道是谁点的。
    await appendTaskTimeline(
      row.taskId,
      `验收前置命令通过后自动继续验收，但没能完成：${"error" in result ? result.error : "未知原因"}。处理完上面那条原因后再点一次验收即可。`,
    );
  }
}
