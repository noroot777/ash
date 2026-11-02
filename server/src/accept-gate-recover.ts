// ash 重启后的门禁收拾。从 accept-gate.ts 拆出来；判据与可信条件在 accept-gate-exit.ts，
// 结算引擎在 accept-gate-settle.ts。
import { eq, isNotNull, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns } from "./db/schema.js";
import { appendGateLog } from "./accept-gate-process.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { gateView } from "./accept-gate-state.js";
import { gateStoppedSummary } from "./accept-gate-messages.js";
import { attachGateProcess, claimGateProcess, stopGateRun } from "./accept-gate-ownership.js";
import { readGateLaunch } from "./accept-gate-launch.js";
import { gateExitOutcome, gateRecoveryFate, watchGateExit } from "./accept-gate-exit.js";
import { appendGateNote } from "./accept-gate-diagnosis.js";
import { followUpGate } from "./accept-gate-continue.js";
import { announceGate, cleanupGateSnapshot, gateSettled, live, parseGateSettlement, settleGate, superviseGate,
  trackGateFollowUp, type GateSettlement } from "./accept-gate-settle.js";
import { now } from "./util.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

/** 启动时已知结论却没写进库的那几条，多久再试一次。 */
const SETTLE_RETRY_MS = 5_000;

/**
 * ash 重启后的收拾。顺序就是可信度的顺序：
 *
 *  · 结算已经认领过结论（settlement 非空）、还停在 running → 照那一份**续完**结算：结论是
 *    当时亲眼观察到的，收尾到一半被重启不该把它改判成别的；
 *  · 已经是终态、续验收 / 交修还没办完 → **补办**（幂等，见 accept-gate-continue.ts）；
 *  · 其余 running 行问一句「它其实怎么样了」（accept-gate-exit.ts）：
 *      命令还在跑、身份核得上 → **接管**：重挂看门的、接着等它退出，结论跟没重启过一样；
 *      命令已经退了、留下了退出档 → 按真实 rc（连同用时）**结算**；
 *      拿不到真实结果 → 落成「被打断」，并把那个 pid 的进程树收掉 —— 留一行刷新后看得见的
 *      「上次没跑完」，比留一个永远转圈的幽灵、或者编一个结论都诚实。
 *  · 已经不是 running、只是还欠着停止责任（processPending）的行，照旧只核对停止。
 *
 * 结算与补办都**不等**「跑完之后那一步」：那是一次完整的验收，不该压在启动路径上。计数只认
 * 落了库的结论，不认「结算调用返回了」（第 1 轮审查 N2）；没落成的留重试负责者（settleDurably）。
 */
export async function recoverAcceptGates(): Promise<{ interrupted: number; resumed: number; settled: number }> {
  const rows = await db.select().from(acceptGateRuns).where(or(
    eq(acceptGateRuns.status, "running"), eq(acceptGateRuns.processPending, true), isNotNull(acceptGateRuns.settlement),
  ));
  const owning = rows.filter(row => row.status === "running" || row.processPending);
  for (const row of owning) {
    claimGateProcess(row.id, row.taskId, row.logPath);
    attachGateProcess(row.id, row.pid, row.pidStartedAt, true);
  }
  const tally = { interrupted: 0, resumed: 0, settled: 0 };
  for (const row of rows) {
    if (row.status !== "running" && !row.processPending) { await followUpOwed(row); continue; }
    const claimed = row.status === "running" ? parseGateSettlement(row.settlement) : null;
    if (claimed) {
      appendGateLog(row.logPath, `\n[ash] ash 重启时这一次正在收尾，结论已经认领（${claimed.status}），接着收完。\n`);
      await appendTaskTimeline(row.taskId, `ash 重启时验收前置命令 \`${row.command}\` 正在收尾，结论已经落库，按那一份接着收完。`);
      if (await settleDurably(row.id, claimed)) tally.settled++;
      continue;
    }
    const fate = row.status === "running" ? gateRecoveryFate(row) : { kind: "lost" as const };
    if (fate.kind === "running") { await resumeGate(row); tally.resumed++; continue; }
    if (fate.kind === "exited") {
      appendGateLog(row.logPath, `\n[ash] ash 重启后读到命令自己留下的退出结果（rc=${fate.exit.code}），按它结算。\n`);
      await appendTaskTimeline(row.taskId, `ash 重启时验收前置命令 \`${row.command}\` 已经跑完（rc=${fate.exit.code}），`
        + "结果由它的启动器留在了磁盘上，按它照常结算。");
      if (await settleDurably(row.id, gateExitOutcome(fate.exit))) tally.settled++;
      continue;
    }
    // 跨重启**必须先核身份**：ash 停了几小时再起来，那个 pid 多半已经是别的进程了，
    // 盲发信号打死的是无辜的人（第 1 轮审查）。核不出来就不发，并在日志里说清。
    // 先把行落成「被打断」再动刀（同超时那条路）：这个收拾动作在同一个进程里也可能撞上
    // 那条命令自己的退出回调，而那个回调会把它收成一条**红**并交给 agent 去修 —— 被打断
    // 不是红，它根本没有结论。
    if (row.status === "running") {
      await db.update(acceptGateRuns)
        .set({ status: "interrupted", failure: "server_restarted", finishedAt: now(), processPending: true })
        .where(eq(acceptGateRuns.id, row.id));
      tally.interrupted++;
    }
    const stopped = await stopGateRun(row.id);
    if (stopped) await cleanupGateSnapshot(row.taskId, row.id);
    const stoppedSummary = gateStoppedSummary(row.executionMode);
    appendGateLog(row.logPath, `\n[ash] ash 重启后核对进程，执行状态为 ${row.status === "running" ? "interrupted" : row.status}（${
      stopped ? stoppedSummary : "残留进程尚未确认退出，工作区仍被占用"}）。\n`);
    await appendTaskTimeline(
      row.taskId,
      (row.status === "running"
        ? `验收前置命令被打断：ash 重启时它还在跑（\`${row.command}\`），已按未完成收尾。`
        : `ash 重启后继续核对验收前置命令 \`${row.command}\` 的停止责任（原状态 ${row.status}）。`)
      + (stopped ? `${stoppedSummary}，工作区占用已释放。` : "尚未确认进程退出，合并和清理仍被阻止。"),
    );
    announceGate(row.taskId);
  }
  return tally;
}

/** 结论已经落库、续验收 / 交修没办完就重启了：补上（还欠不欠由 followUpGate 判）。 */
async function followUpOwed(row: GateRow): Promise<void> {
  const note = `ash 重启前验收前置命令 \`${row.command}\` 已经${row.status === "passed" ? "通过" : "红了"}，`
    + `但随后的${row.status === "passed" ? "自动验收" : "交回修复"}还没办完，现在补上。`;
  trackGateFollowUp(row.id, followUpGate(row, gateView(row), note).catch((error) => {
    console.error(`[ash] 验收前置命令补办失败（${row.id}），记号保留，下次启动再补:`, error);
  }));
}

/**
 * 按已知结论结算，没落成库（写库临时失败）就留一个重试负责者，直到它落成、或者别人先收了它
 * （取消、删任务）。接管那条路由等待者自己重交（watchGateExit），这两条路没有等待者，所以在
 * 这里补上（第 2 轮审查 N2 残余）。
 */
async function settleDurably(runId: string, outcome: GateSettlement): Promise<boolean> {
  await settleGate(runId, outcome, false);
  if (await gateSettled(runId)) return true;
  let busy = false;
  const retry = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
      if (row?.status !== "running") { clearInterval(retry); return; }
      await settleGate(runId, outcome, false);
    })().catch(() => {}).finally(() => { busy = false; });
  }, SETTLE_RETRY_MS);
  retry.unref?.();
  return false;
}

/**
 * 接管一条还在跑的门禁：把起跑时那一套（退出回调 + 看门的）接回来。退出回调随旧 ash 没了，
 * 换成盯退出档的等待者；它等到启动器没留档就消失时，拿不到真实结果，按「被打断」收。
 *
 * 这一段**不往门禁日志里写**：命令还在写它，看门的靠「日志只有命令一个写入者」算产出和
 * 静默（accept-gate-watch.ts 边界 ②）。接管这件事记在旁边的 .notes 和时间线上。
 */
async function resumeGate(row: GateRow): Promise<void> {
  const pid = row.pid!;
  const pidStartedAt = row.pidStartedAt!;
  live.get(row.taskId)?.watch.stop();
  // 它在跑，不是在停：取消、超时、删任务照常能收它，验收照常按「正在跑」拦住。
  attachGateProcess(row.id, pid, pidStartedAt);
  const exit = watchGateExit({ logPath: row.logPath, pid, startedAt: pidStartedAt,
    onExit: async (result) => {
      await settleGate(row.id, result ? gateExitOutcome(result)
        : { status: "interrupted", exitCode: null, failure: "server_restarted" }, false);
      return gateSettled(row.id);
    },
    onResumeFailed: (error) => void (async () => {
      const why = `macOS 兼容监督的持续观察没能接回来（${error instanceof Error ? error.message : String(error)}）：`
        + "接管之后新起、又清掉了继承标记的后代可能认不出，收尾时可能漏掉它们；退出等待和超时看护不受影响。";
      appendGateNote(row.logPath, `[ash] ${now()} ${why}`);
      await appendTaskTimeline(row.taskId, `验收前置命令接管降级：${why}`);
    })() });
  // 时限从启动器起来那一刻算（启动记录里记着），旧记录没有就退到这一行的开跑时刻。
  const launchedAt = Date.parse(readGateLaunch(row.logPath)?.launchedAt ?? row.startedAt);
  superviseGate(row.taskId, row.id, row.logPath, pid, pidStartedAt,
    { elapsedMs: Number.isFinite(launchedAt) ? Math.max(0, Date.now() - launchedAt) : 0, exit });
  appendGateNote(row.logPath, `[ash] ${now()} ash 重启，新实例接管了这条仍在跑的命令，接着等它退出。`);
  await appendTaskTimeline(row.taskId, `ash 重启时验收前置命令 \`${row.command}\` 还在跑，新实例已经接管：`
    + "继续等它跑完并按真实结果结算（绿了照常自动合并，红了照常交回这个任务去修），超时仍从开跑那一刻算。");
  announceGate(row.taskId);
}
