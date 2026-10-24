import { and, eq, ne } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns } from "./db/schema.js";
import { forgetGateProcess } from "./accept-gate-ownership.js";
import { abandonGateSupervision } from "./accept-gate-launch.js";
import { appendGateLog } from "./accept-gate-process.js";
import { gateView } from "./accept-gate-state.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export async function releaseGateOwnership(taskId: string, runId: string) {
  const row = (await db.select().from(acceptGateRuns).where(and(eq(acceptGateRuns.id, runId), eq(acceptGateRuns.taskId, taskId)))).at(0);
  if (!row) return { ok: false as const, error: "这个任务名下没有这一次执行记录" };
  if (row.failure === "ownership_waived" && !row.processPending) {
    abandonGateSupervision(row.logPath);
    return { ok: true as const, gate: gateView(row) };
  }
  if (row.status === "running" || !row.processPending) return { ok: false as const, error: "请先取消这次运行；只有已结算但停止证据缺失的记录才能确认风险并强制释放" };
  const released = (await db.update(acceptGateRuns).set({ status: "interrupted", failure: "ownership_waived",
    processPending: false, finishedAt: now(), sourceFingerprint: null, acceptOptions: null })
    .where(and(eq(acceptGateRuns.id, runId), eq(acceptGateRuns.taskId, taskId), ne(acceptGateRuns.status, "running"),
      eq(acceptGateRuns.processPending, true))).returning()).at(0);
  if (!released) return { ok: false as const, error: "运行状态已变化，请刷新后重新确认" };
  abandonGateSupervision(row.logPath);
  forgetGateProcess(runId);
  const message = `已显式确认风险并强制释放验收前置命令 ${runId} 的停止占用。未取得整次退出证据，` +
    "不代表进程已停止或测试通过；残留进程仍可能写入文件，合并、删除或接力可能与它竞争。若有独立快照，不会自动清理，请检查残留。";
  appendGateLog(row.logPath, `\n[ash] ${now()} ${message}\n`);
  await appendTaskTimeline(taskId, message);
  return { ok: true as const, gate: gateView(released) };
}
