// 门禁红了之后那条「交给谁去修」的路：自动交接、手动再交、交接状态的落盘。
//
// 从 accept-gate.ts 拆出来（第 8 轮审查 F4：那个文件被这一轮顶到 702 行，超了根 CLAUDE.md
// 的 700 行上限）。编排本体（判 / 跑 / 收）仍在那边，这里只管「红了之后找谁、怎么说」。
//
// 这一段的硬约束：**交出去的那副面孔、时间线上那句话、卡片上的提示，三处必须一致**（第 7
// 轮审查 N2）。免修那一档明确不许 agent 改代码，时间线若还写「修完重新点验收」就是两句
// 相反的话。三副面孔各自的授权判据在 accept-gate-messages.ts。
import { eq } from "drizzle-orm";
import { ACCEPT_GATE_STATUS_LABELS, summarizeAcceptGate,
  type AcceptGateStatus, type AcceptGateView } from "@ash/shared/accept-gate";
import type { AcceptBy } from "@ash/shared/workflow-policy";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import { gateFailurePrompt } from "./accept-gate-messages.js";
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

export async function handOffGateFailure(row: GateRow, view: AcceptGateView, again = false): Promise<void> {
  const authority = !again ? parseChoices(row.acceptOptions).reviewAuthority : undefined;
  const task = (await db.select().from(tasks).where(eq(tasks.id, row.taskId))).at(0);
  const project = (await db.select().from(projects).where(eq(projects.id, row.projectId))).at(0);
  const sourceCwd = task && project ? await existingTaskWorkspacePath(task, project.repoPath) ?? project.repoPath : row.cwd;
  const prompt = gateFailurePrompt({
    command: row.command, summary: summarizeAcceptGate(view), logPath: row.logPath,
    failure: view.failure, diagnosis: view.diagnosis ?? null, missAttribution: view.missAttribution ?? null,
    tail: view.logTail, cwd: row.cwd, sourceCwd, executionNotice: view.executionNotice,
  });
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
  // 这条时间线是用户刷新之后唯一找得回「这次交回去是让它干什么」的地方，所以它必须跟交出去
  // 的那副面孔一致（第 7 轮审查 N2）：免修那一档明确不许它改代码，这儿若还写「修完重新点
  // 验收」就是两句相反的话。三副面孔的授权判据见 accept-gate-messages.ts。
  const next = row.failure !== "command_missing"
    ? "修完重新点验收即可，验收会自动再跑一遍。"
    : row.missAttribution === "not-mine"
      ? "结论说这不是这次改动的事，它不会为此改代码，会把出路转述给你 —— 出路（合目标分支 / 这次跳过）都要你自己定。"
      : row.missAttribution === "mine"
        ? "结论指向是这次改动把这条命令弄没的，它会去改回来，之后重新点验收。"
        : "它要先核是不是这次改动把这条命令弄没的，再决定去改还是把出路转述给你。";
  await appendTaskTimeline(
    row.taskId,
    `门禁交接：已叫醒该任务去看这条命令${row.failure === "command_missing" ? "为什么没跑起来" : "为什么红"}`
      + `（日志 ${row.logPath}）。${again ? "这是你在验收台上手动再交一次。" : ""}${next}`,
  );
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

