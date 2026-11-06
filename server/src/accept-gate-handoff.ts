// 门禁红了之后那条「交给谁去修」的路：自动交接、手动再交、交接状态的落盘。
//
// 从 accept-gate.ts 拆出来（第 8 轮审查 F4：那个文件被这一轮顶到 702 行，超了根 CLAUDE.md
// 的 700 行上限）。编排本体（判 / 跑 / 收）仍在那边，这里只管「红了之后找谁、怎么说」。
//
// 这一段的硬约束：**交出去的那副面孔、时间线上那句话、卡片上的提示，三处必须一致**（第 7
// 轮审查 N2）。交出去的面孔现在只有一副（去定位、去修，或者拿出「跟本次改动无关」的依据），
// 判据在 accept-gate-messages.ts；这两处共用 `gateFailureInputFor` / `gateHandoffTimeline`
// 两个纯函数，所以「三处一致」不再靠人读两遍对齐。
import { existsSync, readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { ACCEPT_GATE_STATUS_LABELS,
  type AcceptGateStatus, type AcceptGateView } from "@ash/shared/accept-gate";
import type { AcceptBy } from "@ash/shared/workflow-policy";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, sessions, tasks } from "./db/schema.js";
import { gateFailureInputFor } from "./accept-gate-messages.js";
import { gateView, latestRun } from "./accept-gate-state.js";
import { parseGateSettlement } from "./accept-gate-exit.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { existingTaskWorkspacePath } from "./task-workspace.js";
import { continueWhenIdle } from "./runs.js";
import { id as newId, now } from "./util.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

/** 用户在确认框里做的那几个选择：门禁绿了之后要**原样**替他接着做完。 */
export type AcceptGateChoices = { by: AcceptBy; commit?: boolean; confirmUnverified?: boolean;
  reviewAuthority?: import("./review-ownership.js").ReviewAuthority;
  /** 他点的是哪一版成果（task-result-version.ts）：门禁跑着时任务又跑完一轮，绿了也不替他验后来那一版。 */
  expectedResultVersion?: string };

export function parseChoices(raw: string | null): AcceptGateChoices {
  try {
    const parsed = JSON.parse(raw ?? "{}") as AcceptGateChoices;
    return { by: parsed.by === "workflow" ? "workflow" : "human", commit: parsed.commit,
      confirmUnverified: parsed.confirmUnverified, reviewAuthority: parsed.reviewAuthority,
      ...(typeof parsed.expectedResultVersion === "string" ? { expectedResultVersion: parsed.expectedResultVersion } : {}) };
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

/**
 * 把一条红交回任务去修。交接落定（投递已落进会话 / 已持久入队 / 失败已记账）时顺带清掉这一行
 * 欠着的后续记号（settlement，见 accept-gate-continue.ts），并叫一声 `onFinal`。
 *
 * 给了 `onFinal` 就是在**办欠账**（结论之后系统欠的那一步，不是用户手动再交）：普通那条路
 * 在拿到回合、真正起跑之前先把「开始投递了」连同这一次的投递凭据记进 settlement（delivering）。
 * 起跑到「原话落盘」回执之间隔着 spawn，进程死在这段里时那句话可能已经送到 —— 重启后不能凭
 * 「记号还在」就再发一遍（第 3 轮审查 F3-C），要先拿证据说话（resolveInterruptedHandoff）。
 */
export async function handOffGateFailure(row: GateRow, view: AcceptGateView, again = false,
  onFinal?: () => void): Promise<void> {
  const settle = async () => {
    try { await db.update(acceptGateRuns).set({ settlement: null }).where(eq(acceptGateRuns.id, row.id)); }
    finally { onFinal?.(); }
  };
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
          // 入队和销账同一个事务：入队即送达（按 key 幂等），两者不会只成一半。
          await transaction.update(acceptGateRuns).set({ handoffAt: now(), handoffError: null, settlement: null })
            .where(eq(acceptGateRuns.id, row.id));
        }, `gate-${row.id}`);
      bus.publish({ type: "task.acceptGate", taskId: row.taskId });
      await appendTaskTimeline(row.taskId, `门禁交接：修复输入已持久入队，按原审查权限等待投递（日志 ${row.logPath}）。`);
      onFinal?.();
      await (await import("./pending-messages.js")).deliverPendingMessages(row.taskId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await markHandoff(row.id, { at: now(), error: reason });
      await appendTaskTimeline(row.taskId, `门禁交接失败：${reason}。日志在 ${row.logPath}，可核对后手动再交。`);
      await settle();
    }
    return;
  }
  // 先把「这一次交接发起了」落盘再投递：投递是异步的，中间用户刷新页面的话，不落盘
  // 那张卡只能说「不知道」。失败由下面的 onError 补写原因（两件事都写同一行）。
  await markHandoff(row.id, { at: now(), error: null });
  await appendTaskTimeline(row.taskId, gateHandoffTimeline(view, row.logPath, again));
  // byBackend：占真人回合，但字是后端写的（同验收冲突交接）。
  // handoff_at 只说明「发起了」：投递在等回合空闲，进程这时候死掉的话话一个字都没送出去。
  // 所以欠着的记号等协议定论（下面三档裁决）或失败记完账才清（第 2 轮审查）。
  // 投递凭据：哪一次运行、哪一种输入、哪一次投递。随这句话落进会话（那条用户回合的 eventKey），
  // 重启后只认它，不认正文 —— 真人追问里也可能贴着同一份日志路径（第 2 轮审查 F3）。
  const deliveryKey = onFinal ? `accept-gate-repair:${row.id}:${newId()}` : undefined;
  let unconfirmed = false;
  continueWhenIdle(row.taskId, prompt, { byBackend: true, deliveryKey }, async (why, failure) => {
    // 我们自己的所有权闸说「不欠了」（别处已经办完）：不是交接失败，什么都不用记。
    if (failure === "superseded") { onFinal?.(); return; }
    try {
      await markHandoff(row.id, { at: now(), error: why });
      await appendTaskTimeline(
        row.taskId,
        `门禁交接失败：没能叫醒该任务（${why}）。日志在 ${row.logPath}，请手动点运行或直接回复它。`,
      );
    } catch (error) {
      // 失败没记上账就不算落定：记号留给下次启动，只把「正在办」放开。
      onFinal?.();
      throw error;
    }
    await settle();
  }, {
    // 「跑完了」不等于「送到了」（turn-idle-delivery.ts 的 `IdleDeliveryVerdict`）：只有协议层收下
    // 才算交接落地。三档都会销账（这一笔不再欠着），区别在交代给用户的那句话；说不清之后还可能
    // 迟到一句定论，后到的那句覆盖前一句，所以每档都幂等地重写同一组字段。
    onAccepted: async () => {
      if (unconfirmed) await markHandoff(row.id, { at: now(), error: null });
      await settle();
    },
    onRefused: async () => {
      const why = "协议层明确拒收，这份修复要求一个字都没送进会话";
      await markHandoff(row.id, { at: now(), error: why });
      await appendTaskTimeline(row.taskId, `门禁交接失败：${why}。在验收台上点「再交一次」即可重新投递（日志 ${row.logPath}）。`);
      await settle();
    },
    // 与 `resolveInterruptedHandoff` 同一口径：说不清就不重发（可能重复执行），如实记一笔交给用户。
    onUnconfirmed: async () => {
      unconfirmed = true;
      const why = "这份修复要求有没有送进会话，协议层没给回执，为免重复没有自动重发";
      await markHandoff(row.id, { at: now(), error: why });
      await appendTaskTimeline(row.taskId, `门禁交接：${why}。看一眼会话里有没有这条修复要求，没有的话在验收台上点「再交一次」（日志 ${row.logPath}）。`);
      await settle();
    },
  }, deliveryKey ? () => claimDelivery(row.id, deliveryKey) : undefined);
}

/** 起跑前把「开始投递了」连同投递凭据记进欠账（比较并交换）；已经不欠了就让这一笔作罢。 */
async function claimDelivery(runId: string, deliveryKey: string): Promise<string | null> {
  const current = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  const owed = parseGateSettlement(current?.settlement);
  if (!current?.settlement || !owed) return "这次交回修复已经办完，不再投递";
  await db.update(acceptGateRuns).set({ settlement: JSON.stringify({ ...owed, delivering: deliveryKey }) })
    .where(and(eq(acceptGateRuns.id, runId), eq(acceptGateRuns.settlement, current.settlement)));
  const claimed = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  return parseGateSettlement(claimed?.settlement)?.delivering === deliveryKey ? null : "这次交回修复已经由别处接手，不再投递";
}

/**
 * 上一个进程**已经开始投递**修复输入、还没等到「原话落盘」回执就死了。那句话可能已经送到，
 * 也可能没有 —— 先看证据：任务会话里有一条**后端代写**、`eventKey` 正好是这一次投递凭据的用户
 * 回合，就是送到了，直接销账。正文里有没有日志路径不算数（真人追问、别的系统输入都可能提到它）。
 * 找不到也**不重发**（spawn 之后、落盘之前死掉的话，agent 手里可能已经有这句话了），如实记一笔
 * 「说不清有没有送到」，出路交给用户手动再交。
 */
export async function resolveInterruptedHandoff(row: GateRow): Promise<void> {
  const key = parseGateSettlement(row.settlement)?.delivering;
  const sessionRows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, row.taskId));
  const delivered = typeof key === "string"
    && sessionRows.some(({ id }) => deliveredIn(sessionTranscriptPath(row.taskId, id), key));
  if (!delivered) {
    const why = "ash 重启时这份修复输入正在投递，说不清有没有送到，为免重复没有自动重发";
    await markHandoff(row.id, { at: now(), error: why });
    await appendTaskTimeline(row.taskId, `门禁交接：${why}。看一眼会话里有没有这条修复要求，没有的话在验收台上点「再交一次」（日志 ${row.logPath}）。`);
  }
  await db.update(acceptGateRuns).set({ settlement: null }).where(eq(acceptGateRuns.id, row.id));
}

function deliveredIn(transcript: string, deliveryKey: string): boolean {
  if (!existsSync(transcript)) return false;
  return readFileSync(transcript, "utf8").split(TURN_SENTINEL).some((chunk) => {
    try {
      const turn = JSON.parse(chunk.split("\n")[0]!) as { t?: string; by?: string; eventKey?: string };
      return turn.t === "user" && turn.by === "system" && turn.eventKey === deliveryKey;
    } catch { return false; }
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
