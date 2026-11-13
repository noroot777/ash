// 门禁的**结算引擎**：在跑的那条由谁看着、结论怎么落、落完之后欠用户的那一步怎么办。
// 从 accept-gate.ts 拆出来，起跑（accept-gate.ts）、取消/超时、重启恢复（accept-gate-recover.ts）
// 共用这一份 —— 「第一个到的说了算」只有一个实现才说得算。
import { and, eq, isNull } from "drizzle-orm";
import { ACCEPT_GATE_TIMEOUT_MS, summarizeAcceptGate } from "@ash/shared/accept-gate";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { acceptGateRuns } from "./db/schema.js";
import { acceptGateLogPath, appendGateLog } from "./accept-gate-process.js";
import { appendTaskTimeline, alertLine, receiptLine } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { gateView } from "./accept-gate-state.js";
import { startGateWatch, type GateWatch } from "./accept-gate-watch.js";
import { gateSnapshotPath, removeGateSnapshot, verifyGateSnapshot } from "./accept-gate-source.js";
import { forgetGateProcess, stopGateRun } from "./accept-gate-ownership.js";
import { readGateLaunch } from "./accept-gate-launch.js";
import { gateScopeNotice } from "./accept-gate-confinement.js";
import { followUpGate } from "./accept-gate-continue.js";
import { gateExitOutcome, parseGateSettlement, readGateExit, type GateSettlement } from "./accept-gate-exit.js";
import { freezeGateScene } from "./accept-gate-diagnosis.js";
import { now } from "./util.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

export { parseGateSettlement, type GateSettlement } from "./accept-gate-exit.js";

const readRun = async (runId: string): Promise<GateRow | undefined> =>
  (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);

// 正在跑的那条：看门的（超时 + 静默）只活在内存里（重启后由 recoverAcceptGates 接管或收拾）。
export const live = new Map<string, { runId: string; watch: GateWatch; pid: number; pidStartedAt: string | null }>();
// runId → 这一次「跑完 + 跑完之后那一步（自动续验收 / 回流）」都做完了。只给回归用。
const settlements = new Map<string, Promise<void>>();
const outcomeWrites = new Map<string, Promise<void>>();
// 正在收尾的 runId。进程退出、取消、超时三条路可能同时到，而「读行 → 改行」之间有 await：
// 只靠库里那个 running 判据会让两条路都认为自己是第一个（于是自动续验收跑两遍）。
const settling = new Set<string>();

export async function cleanupGateSnapshot(taskId: string, runId: string): Promise<void> {
  const logPath = acceptGateLogPath(taskId, runId);
  const launch = readGateLaunch(logPath);
  if (launch?.confinementEnrolled && gateScopeNotice(launch.confinementId)) {
    appendGateLog(logPath, `\n[ash] macOS 兼容监督已收尾；独立测试快照保留到任务验收、归档或删除：${gateSnapshotPath(taskId, runId)}\n`);
    return;
  }
  await removeGateSnapshot(taskId, runId);
}

/**
 * 门禁状态变了，**两条都要发**。
 *
 * `task.acceptGate` 只有验收台那张卡在听；而「这个任务此刻有条命令在跑」还要进到任务
 * 本身（`Task.acceptGateRunning` 由 enrichTasks 现查），侧栏那颗圆点和会话页输入框上方
 * 那条才看得见。少了后面这一条，门禁跑的那十几分钟里任务在列表上和平时一模一样。
 */
export function announceGate(taskId: string): void {
  bus.publish({ type: "task.acceptGate", taskId });
  void publishTaskUpdated(taskId).catch((error) => {
    console.error(`[ash] 门禁状态广播失败（${taskId}）:`, error);
  });
}

/**
 * 给一条在跑的门禁挂上看门的。起跑和跨重启接管共用这一份：接管时 `resumed.elapsedMs` 带上
 * 重启前已经跑掉的时长（90 分钟那条线照旧从开跑那一刻算），`resumed.exit` 是替代退出回调的
 * 那个等待者，跟看门的一起停。
 */
export function superviseGate(taskId: string, runId: string, logPath: string, pid: number, pidStartedAt: string | null,
  resumed?: { elapsedMs: number; exit: GateWatch }): void {
  // 看门的只管一件事：撞上限时交出一段「现场」（停在哪一行、静了多久、产出节奏）。只写
  // 一句「超时」的话，事后分不出是某一步卡住还是整台机器在爬，而这两种的处置完全相反。
  // 它**不自己写日志**：现场必须排在所有人后面写，否则会被停止期的清理输出顶出尾巴
  // （第 1 轮审查 F2）。它也不拿静默去掐命令，理由见 ACCEPT_GATE_SILENCE_MS。
  const watch = startGateWatch({ logPath, elapsedMs: resumed?.elapsedMs, onVerdict: (verdict) => void (async () => {
    // 撞上时限那一刻命令可能刚好已经退了、退出回调还没轮到：结论按退出档里的用时判，不按谁先
    // 被处理（同一张表，见 accept-gate-exit.ts）。期限内退的就照它的 rc 收。
    const recorded = readGateExit(logPath, pid);
    const exited = recorded ? gateExitOutcome(recorded) : null;
    if (exited && exited.failure !== "timeout") { await settleGate(runId, exited); return; }
    appendGateLog(logPath, `\n[ash] 超过 ${Math.round(ACCEPT_GATE_TIMEOUT_MS / 60_000)} 分钟，按超时处理，正在收掉它。\n`);
    // **先认领终态、再动刀**（同取消那条路）：反过来的话，刀落下去触发的退出回调会先把
    // 这一次收成「命令被外人杀了」，连带把日志当成一条红交给 agent 去修 —— 而它其实是
    // 超时。占用不会因此漏空：stopAcceptGate 从进场就立起「还没确认退出」那条记号。
    await settleGate(runId, { status: "failed", exitCode: null, failure: "timeout",
      note: verdict.note, scene: verdict.scene });
  })() });
  const both = resumed ? { stop: () => { watch.stop(); resumed.exit.stop(); } } : watch;
  live.set(taskId, { runId, watch: both, pid, pidStartedAt });
}

/** 停不掉就**如实说**：工作区仍被占着，用户刷新后也看得见这句（根 AGENTS.md 那条）。 */
export async function noteIfStillAlive(taskId: string, logPath: string, stopped: boolean): Promise<void> {
  if (stopped) return;
  appendGateLog(logPath, `\n[ash] 尚未取得整棵进程树退出的证据；身份未核实时不会盲发信号。\n`);
  await appendTaskTimeline(
    taskId,
    alertLine("验收前置命令尚未确认整棵进程树退出：可能是进程身份或归属暂时读不出，也可能仍有进程存活。"
      + "**这个工作区仍按被占用处理**，合并与清理继续阻止；再次取消、验收或清理时会重新核对。"),
  );
}

/**
 * 一次门禁的终点。三条路（命令自己退了 / 取消 / 超时）都走这里，**第一个到的说了算**，
 * 后到的原样丢掉 —— 否则「自动把验收接着做完」会跑两遍。
 *
 * 「第一个」是**落了库的那一个**（settlement 列）：认领下来的结论在动刀、清理之前就写进库，
 * 绿了要做的续验收、红了要做的交修办完才清掉。中间任何一步 ash 被重启，新实例照这一份续完，
 * 不会把一个已经观察到的结论改判成「被打断」，也不会让一个已经亮出来的绿永远等不到合并
 * （第 1 轮审查 F2/F3）。
 */
export async function settleGate(
  runId: string,
  outcome: GateSettlement,
  waitForContinuation = true,
): Promise<void> {
  if (settling.has(runId)) return waitForContinuation ? settlements.get(runId) : outcomeWrites.get(runId);
  settling.add(runId);
  let finishOutcome!: () => void;
  const written = new Promise<void>(resolve => { finishOutcome = resolve; });
  outcomeWrites.set(runId, written);
  let rowForFailure: GateRow | undefined;
  let outcomeSaved = false;
  const settle = (async () => {
    let row = await readRun(runId);
    rowForFailure = row;
    if (!row || row.status !== "running") return;
    // 先认领、再落库、再动刀：状态闸 + 「还没人认领」两道条件，跨进程也只有一份能写进去。
    if (!row.settlement) {
      await db.update(acceptGateRuns).set({ settlement: JSON.stringify(outcome) })
        .where(and(eq(acceptGateRuns.id, runId), eq(acceptGateRuns.status, "running"), isNull(acceptGateRuns.settlement)));
      row = await readRun(runId);
      if (!row || row.status !== "running") return;
    }
    outcome = parseGateSettlement(row.settlement) ?? outcome;
    // 现场**排在所有可能失败的事情前面**存盘（第 3 轮审查 F1）。两条理由，缺一条都不够：
    //  · 下面任何一步抛出来（快照删不掉的 EACCES/EPERM 是实测发生过的）都会把这个 async
    //    甩进 catch，而那时这一行已经写成 failed、processPending=false，recoverAcceptGates
    //    不会再选中它 —— 只存在内存里的那份现场就**永久**没了；
    //  · 它必须早于终态落库：结果一旦可见，用户下一步就是来找这段说明。
    // 到这一句为止我们已经独占了这次结算（settling + 上面那句 running 核对），所以存下来的
    // 现场不会是某个没赢的判定留下的。
    const sceneFailure = outcome.scene ? freezeGateScene(row.logPath, outcome.scene) : null;
    if (sceneFailure) appendGateLog(row.logPath, `\n[ash] ${sceneFailure}\n${outcome.scene}\n`);
    const stopped = await stopGateRun(runId, false);
    await noteIfStillAlive(row.taskId, row.logPath, stopped);
    if (outcome.status === "passed" && !stopped) outcome = { status: "failed", exitCode: outcome.exitCode, failure: "process_unconfirmed" };
    if (outcome.status === "passed" && !await verifyGateSnapshot(row.cwd, {
      // ambient 不参与收尾核验:那一项问的是「依赖输入还新不新鲜」(复用判据),这里问的是
      // 「这份副本还是不是当初那一份」。原样带上 DB 里记的那一份，不另算一次。
      // 合并预览档的快照 HEAD 是那次预演合并，不是任务分支的提交（见 createGateSnapshot）。
      commit: row.previewCommit ?? row.sourceCommit, fingerprint: row.sourceFingerprint ?? "", dependencies: [],
      ambient: row.sourceAmbient ?? "",
    })) outcome = { status: "failed", exitCode: outcome.exitCode, failure: "source_changed" };
    const watching = live.get(row.taskId);
    const finishedAt = now();
    // 进程收干净了的 passed/failed 还欠一件事（续验收 / 交修），记号留着，办完才清。
    const owed = stopped && (outcome.status === "passed" || outcome.status === "failed");
    await db.update(acceptGateRuns)
      .set({ status: outcome.status, exitCode: outcome.exitCode, failure: outcome.failure, finishedAt, processPending: !stopped,
        settlement: owed ? JSON.stringify({ ...outcome, scene: undefined }) : null })
      // 状态闸：上面那句读到的 running 和这一句之间隔着 await，只有真的还 running 才翻。
      .where(and(eq(acceptGateRuns.id, runId), eq(acceptGateRuns.status, "running")));
    outcomeSaved = true;
    if (stopped) forgetGateProcess(runId);
    // 删不掉快照是磁盘上的事（EACCES/EPERM 实测会发生），不该把一条已经判完的门禁连同
    // 它的结论、时间线、交接一起甩进 catch（第 3 轮审查 F1）。
    if (stopped) await cleanupGateSnapshot(row.taskId, runId).catch((error) => appendGateLog(row.logPath,
      `\n[ash] 快照没能删掉，它还留在 ${gateSnapshotPath(row.taskId, runId)}：${String(error)}\n`));
    if (watching?.runId === runId) { watching.watch.stop(); live.delete(row.taskId); }
    const settled = { ...row, ...outcome, finishedAt };
    const view = gateView(settled);
    // 入口那句话（accept-gate-entry.ts）跟摘要放在同一行：核得准的那一档它就是「为什么没起跑」，
    // 核不准的那一档它是起跑前看到的事实，原始输出就在日志里它的上面。
    const entry = view.entryNote ? ` ${view.entryNote}` : "";
    appendGateLog(row.logPath, `\n[ash] ${finishedAt} ${summarizeAcceptGate(view)}${entry}\n`);
    await appendTaskTimeline(row.taskId,
      (view.status === "passed" ? receiptLine : alertLine)(`${summarizeAcceptGate(view)}。${entry}${outcome.note ? ` ${outcome.note}` : ""}${sceneFailure ? ` ${sceneFailure}` : ""}`));
    announceGate(row.taskId);
    finishOutcome();
    if (owed) await followUpGate({ ...settled, settlement: null }, view);
  })().catch((error) => {
    if (rowForFailure && !outcomeSaved) appendGateLog(rowForFailure.logPath,
      `\n[ash] 终态写入失败，本次尚未结算；请重试取消，工作区仍受保护：${String(error)}\n`);
    console.error(`[ash] 验收前置命令收尾失败（${runId}）:`, error);
  }).finally(() => { finishOutcome(); settling.delete(runId); });
  settlements.set(runId, settle);
  // 内存账本只给「等这一次收完」用，留着历史没有意义，满了就把最老的挤掉。**两个账本
  // 一起裁**：从前只裁 settlements，settling 这个 Set 只 add 不删，每跑一轮就永久多存
  // 一个 run id（第 1 轮审查不拦项 4）。幂等不受影响 —— 被挤掉的那些早就收完了。
  while (settlements.size > 100) {
    const oldest = settlements.keys().next().value!;
    settlements.delete(oldest);
    outcomeWrites.delete(oldest);
    settling.delete(oldest);
  }
  await (waitForContinuation ? settle : written);
}

/** 只给回归用：等这一次门禁连同「跑完之后那一步」全部做完。 */
export function whenAcceptGateSettled(runId: string): Promise<void> {
  return settlements.get(runId) ?? Promise.resolve();
}

/** 重启补办的续验收 / 交修也登记进来，回归照样能等它办完。 */
export function trackGateFollowUp(runId: string, work: Promise<void>): void {
  settlements.set(runId, work);
}

/** 结论落库了没有（不再是 running）。启动计数、接管等待者都只认这一句，不认「结算调用返回了」。 */
export async function gateSettled(runId: string): Promise<boolean> {
  const row = await readRun(runId);
  return !!row && row.status !== "running";
}
