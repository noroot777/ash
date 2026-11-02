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

/**
 * 办掉一次结论欠下的那一步，办完（不论成败）清掉 settlement 记号。**幂等**：重启补办时上一次
 * 可能已经办了一半 —— 合并已经落了、交接已经发了 —— 所以先核「还欠不欠」：
 *  · 绿：任务还没验收、凭据不是这一次、它仍是这个任务最近的一次（后来又跑过的，以后来的为准）；
 *  · 红：这一行还没有交接记录（交接一发起就先落 handoff_at，见 accept-gate-handoff.ts）。
 * 进程中途被杀的话记号还在，下次启动再补；办完才清，所以不会补两遍。
 */
export async function followUpGate(row: GateRow, view: AcceptGateView): Promise<void> {
  try {
    if (row.status === "passed") {
      const task = (await db.select().from(tasks).where(eq(tasks.id, row.taskId))).at(0);
      if (task && task.stage !== "accepted" && task.stage !== "merged" && task.acceptedGateRunId !== row.id
        && (await latestRun(row.taskId))?.id === row.id) await continueAcceptance(row);
    } else if (row.status === "failed") {
      const current = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id))).at(0);
      if (current && !current.handoffAt) await handOffGateFailure(row, view);
    }
  } finally {
    await db.update(acceptGateRuns).set({ settlement: null }).where(eq(acceptGateRuns.id, row.id));
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
