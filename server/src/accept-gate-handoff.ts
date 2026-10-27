// 门禁红了之后那条「交给谁去修」的路：自动交接、手动再交、交接状态的落盘。
//
// 从 accept-gate.ts 拆出来（第 8 轮审查 F4：那个文件被这一轮顶到 702 行，超了根 CLAUDE.md
// 的 700 行上限）。编排本体（判 / 跑 / 收）仍在那边，这里只管「红了之后找谁、怎么说」。
//
// 这一段的硬约束：**交出去的那副面孔、时间线上那句话、卡片上的提示，三处必须一致**（第 7
// 轮审查 N2）。交出去的面孔现在只有一副（去定位、去修，或者拿出「跟本次改动无关」的依据），
// 判据在 accept-gate-messages.ts；这两处共用 `gateFailureInputFor` / `gateHandoffTimeline`
// 两个纯函数，所以「三处一致」不再靠人读两遍对齐。
import { eq } from "drizzle-orm";
import { ACCEPT_GATE_STATUS_LABELS,
  type AcceptGateStatus, type AcceptGateView } from "@ash/shared/accept-gate";
import type { AcceptBy } from "@ash/shared/workflow-policy";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import { gateFailureInputFor } from "./accept-gate-messages.js";
import { gateView, latestRun } from "./accept-gate-state.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { existingTaskWorkspacePath } from "./task-workspace.js";
import { continueWhenIdle } from "./runs.js";
import { now } from "./util.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

/** 用户在确认框里做的那几个选择：门禁绿了之后要**原样**替他接着做完。 */
export type AcceptGateChoices = { by: AcceptBy; commit?: boolean; confirmUnverified?: boolean;
  reviewAuthority?: import("./review-ownership.js").ReviewAuthority };

export function parseChoices(raw: string | null): AcceptGateChoices {
  try {
    const parsed = JSON.parse(raw ?? "{}") as AcceptGateChoices;
    return { by: parsed.by === "workflow" ? "workflow" : "human", commit: parsed.commit,
      confirmUnverified: parsed.confirmUnverified, reviewAuthority: parsed.reviewAuthority };
  } catch { return { by: "human" }; }
}

/**
 * 交接那一刻写进时间线的那句话。它是用户刷新之后唯一找得回「这次交回去是让它干什么」的
 * 地方，所以**必须跟交出去的那份正式输入同解**（第 7 轮审查 N2）。交出去的面孔现在只有
 * 一副（去定位、去修，或者拿出无关的依据，见 accept-gate-messages.ts），所以这儿只按归因
 * 补一句「它第一步会先看什么」。
 *
 * **读的必须是 `view`，不是 `row`**（第 9 轮审查 N1）：自动交接传进来的 row 是**结算前**
 * 读出来的那一行，failure / missAttribution 还空着，照它分叉会跟正式输入对不上。手动再交
 * 那条路本来就传终态行投影出来的 view，两条路因此同解。
 *
 * 末尾那一句管旧判据那一代的结论（`legacyDiagnosis`）：时间线是 append-only 的，那段旧话
 * 还在上面躺着，不说破失效，用户刷新回来就会把它当这次的依据（第 2 轮审查 F1）。
 */
export function gateHandoffTimeline(view: AcceptGateView, logPath: string, again: boolean): string {
  const attribution = view.missAttribution ?? null;
  const next = attribution === "mine"
    ? "结论指向是这次改动把这条命令弄没的，它会先核这件事；修完重新点验收即可。"
    : attribution === "unknown"
      ? "结论说这条命令起跑前就解析不出来（但证明不了它一行都没跑到），它会先核这件事；修完重新点验收即可。"
      : "修完重新点验收即可，验收会自动再跑一遍。";
  const stale = view.legacyDiagnosis ? "这一次名下那段旧版本的结论已失效，不作为依据。" : "";
  return `门禁交接：已叫醒该任务去看这条命令为什么红（日志 ${logPath}）。`
    + `${again ? "这是你在验收台上手动再交一次。" : ""}${next}${stale}`;
}

export async function handOffGateFailure(row: GateRow, view: AcceptGateView, again = false): Promise<void> {
  const authority = !again ? parseChoices(row.acceptOptions).reviewAuthority : undefined;
  const task = (await db.select().from(tasks).where(eq(tasks.id, row.taskId))).at(0);
  const project = (await db.select().from(projects).where(eq(projects.id, row.projectId))).at(0);
  const sourceCwd = task && project ? await existingTaskWorkspacePath(task, project.repoPath) ?? project.repoPath : row.cwd;
  const prompt = gateFailureInputFor(view, sourceCwd);
  if (authority) {
    try {
      const { enqueueFinalizationRepair } = await import("./regression-finalization.js");
      await enqueueFinalizationRepair(authority.directory, authority.generation, row.taskId, prompt, authority.target!,
        async (transaction) => {
          await transaction.update(acceptGateRuns).set({ handoffAt: now(), handoffError: null }).where(eq(acceptGateRuns.id, row.id));
        }, `gate-${row.id}`);
      bus.publish({ type: "task.acceptGate", taskId: row.taskId });
      await appendTaskTimeline(row.taskId, `门禁交接：修复输入已持久入队，按原审查权限等待投递（日志 ${row.logPath}）。`);
      await (await import("./pending-messages.js")).deliverPendingMessages(row.taskId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await markHandoff(row.id, { at: now(), error: reason });
      await appendTaskTimeline(row.taskId, `门禁交接失败：${reason}。日志在 ${row.logPath}，可核对后手动再交。`);
    }
    return;
  }
  // 先把「这一次交接发起了」落盘再投递：投递是异步的，中间用户刷新页面的话，不落盘
  // 那张卡只能说「不知道」。失败由下面的 onError 补写原因（两件事都写同一行）。
  await markHandoff(row.id, { at: now(), error: null });
  await appendTaskTimeline(row.taskId, gateHandoffTimeline(view, row.logPath, again));
  // byBackend：占真人回合，但字是后端写的（同验收冲突交接）。
  continueWhenIdle(row.taskId, prompt, { byBackend: true }, async (why) => {
    await markHandoff(row.id, { at: now(), error: why });
    await appendTaskTimeline(
      row.taskId,
      `门禁交接失败：没能叫醒该任务（${why}）。日志在 ${row.logPath}，请手动点运行或直接回复它。`,
    );
  });
}

async function markHandoff(runId: string, value: { at: string; error: string | null }): Promise<void> {
  await db.update(acceptGateRuns)
    .set({ handoffAt: value.at, handoffError: value.error })
    .where(eq(acceptGateRuns.id, runId));
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  if (row) bus.publish({ type: "task.acceptGate", taskId: row.taskId });
}

/**
 * 「再交给智能体去修」：红了之后那次自动交接没落地（回合被抢占、任务当时归档着），或者
 * agent 那一轮跑完了还没修好，用户在验收台上再推一次。
 *
 * 只对**没通过的最近一次**有效：通过了没什么可修的，正在跑的还没有结论。取消/被打断
 * 同样没有结论——那两种的出路是重新点验收，不是把一份不存在的红交给 agent。
 */
export async function rehandOffAcceptGate(taskId: string): Promise<
  { ok: true; gate: AcceptGateView } | { ok: false; error: string }
> {
  const row = await latestRun(taskId);
  if (!row) return { ok: false, error: "这个任务还没跑过验收前置命令" };
  if (row.status === "running") return { ok: false, error: "命令还在跑，等它出结论再说" };
  if (row.status !== "failed") {
    return { ok: false, error: `最近一次是「${ACCEPT_GATE_STATUS_LABELS[row.status as AcceptGateStatus]}」，没有红可以交给智能体修` };
  }
  await handOffGateFailure(row, gateView(row), true);
  const fresh = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id))).at(0);
  return { ok: true, gate: gateView(fresh ?? row) };
}
