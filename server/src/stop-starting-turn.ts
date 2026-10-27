import { freezeStartingTurn, waitForTurnIdle, whenTurnIdle } from "./turn-lock.js";
import { turnReclaimStatus } from "./turn-lock-reclaim.js";
import { noteSystemNotice, noteUserActionOutcome } from "./user-action-rejection.js";

const watching = new Set<string>();

export async function stopStartingTurn(taskId: string, timeoutMs = 3_000): Promise<{
  stopped: true; note: string; strandedTurn: boolean;
}> {
  const before = turnReclaimStatus(taskId);
  freezeStartingTurn(taskId, "canceled");
  await waitForTurnIdle(taskId, timeoutMs);
  const current = turnReclaimStatus(taskId);
  if (current.kind === "absent") {
    return {
      stopped: true, strandedTurn: false,
      note: "没有存活的 agent 进程，已标记为 canceled；回合占位当前已空闲，现在可以重新运行",
    };
  }
  if (before.kind === "absent" || before.turn.seq !== current.turn.seq) {
    return {
      stopped: true, strandedTurn: false,
      note: "停止时等待的那次回合占位已结束，目前已有另一轮接手；请以当前任务状态为准",
    };
  }
  const nextStep = current.kind === "eligible"
    ? "当前满足手动放开的判据，页面提供「放开回合占位」开关；放开前请确认并行修改工作区的风险"
    : `当前不提供手动放开：${current.reason}。请等待这一轮自行结束`;
  const note = `任务已标记为 canceled；本次停止等待结束时，回合占位仍被持有，点运行仍会被挡回。${nextStep}`;
  const persisted = noteUserActionOutcome(taskId, "停止", "incomplete", note);
  const key = `${taskId}:${current.turn.claimedAt}:${current.turn.seq}`;
  if (!watching.has(key)) {
    watching.add(key);
    whenTurnIdle(taskId, () => {
      watching.delete(key);
      void persisted.then(() => noteSystemNotice(
        taskId, `stop-released:${key}`, "停止后的回合占位已释放",
        "停止请求等待的那次回合占位已经释放；先前“仍被持有”的状态已结束。若又开始了新回合，请以当前任务状态为准。",
      )).catch((error) => console.warn(`[ash] 停止后的占位释放留痕失败 task=${taskId}:`, error));
    });
  }
  await persisted;
  return { stopped: true, note, strandedTurn: true };
}
