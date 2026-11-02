// 门禁绿了之后系统欠用户的那一步：把用户点的那一次验收接着做完。从 accept-gate.ts 拆出来；
// 起跑时的退出回调、ash 重启后按退出档结算或接管后等到的退出，绿了都走到这里。
import { acceptGateRuns } from "./db/schema.js";
import { parseChoices } from "./accept-gate-handoff.js";
import { appendTaskTimeline } from "./task-timeline.js";

/**
 * 绿了：把用户那一下点的验收接着做完。
 *
 * 必须带上当初的选择（commit / confirmUnverified）——他在确认框里选的是什么，这一次就
 * 该发生什么；也必须带上 `passedRunId`，否则非 git 项目定不出 HEAD，会再触发一次门禁。
 */
export async function continueAcceptance(row: typeof acceptGateRuns.$inferSelect): Promise<void> {
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
