// 没存过原因的那几轮「没给出结论」，按盘上还在的事实**现算**出同一份原因（`ReviewNoVerdict`）。
//
// 原因原本只在审查回合收尾那一刻写进轮次（review-channel-gap.ts → `free_review_rounds.no_verdict`），
// 那份代码上线之前断掉的轮次一样都没有，页面上就只剩「第 1 轮异常」，看不出出了什么错（任务
// EhQtqns9fnG2：用户第三次问同一件事）。可那一回合的事实大多还在：
//   · 回合行（`session_turns`）：哪条审查会话、哪一刻开的、结局是 failed 还是 completed、看门狗判过熔断没有；
//   · 会话行的退出码（只对那条会话的**最后一回合**作数）；
//   · codex 落的那份诊断（退出码、退出信号、执行器原话）；
//   · 会话 trace：消费链当场落下的这一回合的事件（执行器报的错、看门狗的红字）；
//   · 熔断判决日志（turn-stall-journal.ts，销账后压缩之前都还在）；
//   · 报告文件在不在（跟页面读报告同一个入口）。
//
// 判法跟回合收尾那一刻是**同一份**（`interruptionOf` / `noVerdictCause`），只是事实换成从盘上读。
// 两样关于模型 API 的事实只认**在线确实消费过**的，类型只认当时挂上的，不另外重新归一：
//   · 这一轮的执行故障：结算时手上那条 —— 会话 trace 里这一回合那一段就是消费链当场落下的事件，
//     照单飞收尾同一条挑法重放（见 `executionErrorOf`）。执行器原始事件文件不用：那里还有执行器
//     收尾之后才到、没进消费链的行，也分不出哪些是它自己后来补的汇总；
//   · 看门狗熔断时说原因用的类型：**熔断那一刻**冻结的那条（见 `trippedModel`）。
// trace 里的事件没挂类型（挂类型那一版之前落的，或者当场就认不出），就是类型不明：照实说
// 「执行器异常退出（exit N）」，原话摆出来 —— 不从原话里另找状态码（为什么见 review-no-verdict.ts
// 文件头）。一样都读不到的轮次给 null，页面照老样子。
//
// 为什么现算、不一次性补写进库：这份结构这一版刚多了原话，上一版写进库的那些也缺这一格，补写得
// 两头都补；而现算的输入（结束了的回合、盘上的文件）不会再变，按回合身份记一份就只读一次盘。
import { readFileSync } from "node:fs";
import type { AgentEvent, ModelFailure } from "@ash/shared";
import type { ReviewNoVerdict } from "@ash/shared/timeline-notice";
import { producesWork } from "@ash/shared/waiting";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, sessions, sessionTurns } from "./db/schema.js";
import { interruptionOf, noVerdictCause, readTurnDiagnostics, reviewReportWritten, type Interruption } from "./review-no-verdict.js";
import { isExecutionNotice, isSessionScopeNotice } from "./session-notice.js";
import { readableRunPath, sessionTracePath } from "./transcript.js";
import { readStallJournal, type StallVerdictRecord } from "./turn-stall-journal.js";
import { isWatchdogText } from "./turn-stall-text.js";
import { errorFacts } from "./turn-stall.js";

type RoundRow = typeof freeReviewRounds.$inferSelect;
type ExecutionError = Extract<AgentEvent, { kind: "error" }>;

/** 一个审查回合在库里留下的那几样。`outcome` null = 不知道（老行、或者只有会话行）。 */
type ReviewerTurn = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  stallReason: string | null;
  /** 只在这一回合是那条会话最后一回合时有：会话行上的退出码 / 被停的口径记的是最后一次。 */
  exitStatus: number | null;
  stoppedAs: string | null;
};

/** 一次请求里要读的盘：同一条会话的 trace、判决日志都只读一遍。 */
type Disk = { trace(sessionId: string): string; verdicts(): StallVerdictRecord[] };

function diskFor(taskId: string): Disk {
  const traces = new Map<string, string>();
  let verdicts: StallVerdictRecord[] | null = null;
  return {
    trace(sessionId) {
      if (!traces.has(sessionId)) {
        let text = "";
        try {
          text = readFileSync(readableRunPath(sessionTracePath(taskId, sessionId)), "utf8");
        } catch { /* 没有 trace 就是什么都没消费过可读 */ }
        traces.set(sessionId, text);
      }
      return traces.get(sessionId)!;
    },
    verdicts: () => (verdicts ??= readStallJournal().verdicts),
  };
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 这一回合在线消费过的事件：会话 trace 里 `turnStartedAt` 是它的那一段，按落盘顺序。 */
function consumedEvents(trace: string, turnStartedAt: string): AgentEvent[] {
  return trace.split("\n").flatMap((line) => {
    // 一条会话的 trace 装着它的每一回合：先按回合身份粗筛，别的回合那些行不必解析。
    if (!line.includes(turnStartedAt)) return [];
    try {
      const entry = recordOf(JSON.parse(line));
      const event = recordOf(entry.event);
      return entry.turnStartedAt === turnStartedAt && typeof event.kind === "string" ? [event as unknown as AgentEvent] : [];
    } catch {
      return [];
    }
  });
}

/** ash 自己说的那几句（熔断红字、警告、接管说明）：落在执行过程里，却不是执行器报的错。 */
const ashOwn = (event: AgentEvent): boolean => event.kind === "error" && isWatchdogText(event.message);

/**
 * 这一轮的执行故障，照单飞收尾（single-run.ts 里 `lastExecutionError` 那一处）同一条挑法：不是过程
 * 提示（`isExecutionNotice`）、算这一轮成败（`affectsTurn` 不是 false）的 error；带模型类型的那条不被
 * 后面没类型的盖掉。会话级的那种当场就没进这里（也没进 trace），老 trace 里有也不算。子智能体线程的
 * 失败在 trace 里是包成子智能体活动的那一条（`kind:"tool"`），当场就不算父回合的故障，这里也不算。
 */
function executionErrorOf(events: readonly AgentEvent[]): ExecutionError | null {
  let picked: ExecutionError | null = null;
  for (const event of events) {
    if (event.kind !== "error" || ashOwn(event) || isExecutionNotice(event) || isSessionScopeNotice(event) || event.affectsTurn === false) continue;
    if (!picked?.model || event.model) picked = event;
  }
  return picked;
}

/**
 * 看门狗熔断这一回合时说原因用的那个模型 API 类型。在线那一路是**熔断那一刻**把 `lastModel`（这一段
 * 停滞里最后收到的那条错误的类型）冻进判决的（turn-stall.ts 的 `markStallFailure`），之后到的改不了它。
 *   1. 判决日志里这个回合的那条判决（销账了、还没压缩掉的也在）：它记的就是冻结的那一份。带类型那
 *      一格之前写的旧记录说不出来，往下找。
 *   2. 执行过程里认得出**它只可能是哪个**：trace 的落盘顺序不等于消费顺序 —— 正在处理的那条事件
 *      触发了熔断时，红字先落、那条事件后落；红字之后也可能是熔断以后才到的。所以不按位置挑「最后
 *      一条」，而是把可能是它的那些都算上：红字之前最后一次进展（它结束了上一段停滞）以后的错误，
 *      加上红字之后的全部。它们类型都一样（含都没类型），答案就是它；不一样就说不清。找不到红字
 *      （日志里压缩掉了、或者是接管那一路的说法）就不划进展那条线，整个回合的错误都算上。
 *   3. 一条都没有：认不出，给 null，那半句照实说「类型不明」。
 */
function trippedModel(disk: Disk, turn: ReviewerTurn, stallReason: string): ModelFailure | null {
  const record = disk.verdicts()
    .filter((verdict) => verdict.sessionId === turn.sessionId && verdict.turnStartedAt === turn.startedAt && verdict.model !== undefined)
    .at(-1);
  if (record) return record.model ?? null;
  const events = consumedEvents(disk.trace(turn.sessionId), turn.startedAt);
  const trip = events.findIndex((event) => event.kind === "error" && event.message.startsWith(stallReason));
  const candidates = new Map<string, ModelFailure | null>();
  events.forEach((event, i) => {
    if (ashOwn(event)) return;
    if (i < trip && producesWork(event)) {
      candidates.clear();
      return;
    }
    const facts = errorFacts(event);
    if (facts) candidates.set(JSON.stringify(facts.model), facts.model);
  });
  return candidates.size === 1 ? [...candidates.values()][0]! : null;
}

/** 这一任务名下每个审查回合：回合行为主，没有回合行的老会话按会话行上记的最后一回合补一条。 */
async function reviewerTurns(taskId: string): Promise<ReviewerTurn[]> {
  const sessionRows = await db.select({
    id: sessions.id, turnStartedAt: sessions.turnStartedAt, startedAt: sessions.startedAt, endedAt: sessions.endedAt,
    exitStatus: sessions.exitStatus, stoppedAs: sessions.stoppedAs,
  }).from(sessions).where(and(eq(sessions.taskId, taskId), eq(sessions.role, "reviewer")));
  if (!sessionRows.length) return [];
  const turnRows = await db.select({
    sessionId: sessionTurns.sessionId, startedAt: sessionTurns.startedAt, endedAt: sessionTurns.endedAt,
    outcome: sessionTurns.outcome, stallReason: sessionTurns.stallReason,
  }).from(sessionTurns).innerJoin(sessions, eq(sessions.id, sessionTurns.sessionId))
    .where(and(eq(sessionTurns.taskId, taskId), eq(sessions.role, "reviewer")));
  const bySession = new Map(sessionRows.map((row) => [row.id, row] as const));
  const lastOf = (sessionId: string, startedAt: string) => {
    const row = bySession.get(sessionId);
    return row && (row.turnStartedAt ?? row.startedAt) === startedAt ? row : null;
  };
  const out: ReviewerTurn[] = turnRows.map((turn) => {
    const last = lastOf(turn.sessionId, turn.startedAt);
    return { ...turn, exitStatus: last?.exitStatus ?? null, stoppedAs: last?.stoppedAs ?? null };
  });
  for (const row of sessionRows) {
    const startedAt = row.turnStartedAt ?? row.startedAt;
    if (out.some((turn) => turn.sessionId === row.id && turn.startedAt === startedAt)) continue;
    out.push({
      sessionId: row.id, startedAt, endedAt: row.endedAt, outcome: null, stallReason: null,
      exitStatus: row.exitStatus, stoppedAs: row.stoppedAs,
    });
  }
  return out;
}

/** 收这一轮的那个回合：开在这一轮的时间窗口里、最晚的那个（「继续本轮审查」续的是同一轮）。 */
function closingTurn(turns: readonly ReviewerTurn[], round: RoundRow): ReviewerTurn | null {
  const from = Date.parse(round.startedAt);
  const to = round.endedAt ? Date.parse(round.endedAt) : Number.POSITIVE_INFINITY;
  return turns
    .filter((turn) => {
      const at = Date.parse(turn.startedAt);
      return Number.isFinite(at) && at >= from && at <= to;
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1) ?? null;
}

/** 回合身份 → 它怎么断的（null = 没断：正常收尾）。只记收了口的回合：它们的事实不会再变。 */
const turnFacts = new Map<string, Interruption | null>();
const FACTS_LIMIT = 500;

/** 这一回合怎么断的。`undefined` = 说不清（被停、什么都不知道），这一轮就不补原因。 */
function interruptionOfTurn(taskId: string, disk: Disk, turn: ReviewerTurn): Interruption | null | undefined {
  const key = `${taskId}\u0000${turn.sessionId}\u0000${turn.startedAt}`;
  if (turnFacts.has(key)) return turnFacts.get(key)!;
  // 你停的、被引导截断的：回合结局 / 会话行上的停止口径是结算时落的业务事实。诊断里的
  // `stopRequested` 不算 —— 看门狗熔断同样是向执行器发停止请求，那一轮却是按失败结算的。
  if (turn.outcome === "stopped" || turn.stoppedAs) return undefined;
  const diagnostics = readTurnDiagnostics(taskId, turn.sessionId, turn.startedAt);
  const exitStatus = typeof diagnostics?.exitStatus === "number" ? diagnostics.exitStatus : turn.exitStatus;
  const failed = turn.outcome === "failed" || (turn.outcome !== "completed" && exitStatus != null && exitStatus !== 0);
  const completed = turn.outcome === "completed" || (turn.outcome == null && exitStatus === 0);
  if (!failed && !completed) return undefined;
  const facts = failed
    ? interruptionOf({
      exitStatus: exitStatus ?? 0,
      verdict: turn.stallReason ? { kind: "tripped", reason: turn.stallReason, model: trippedModel(disk, turn, turn.stallReason) } : null,
      error: executionErrorOf(consumedEvents(disk.trace(turn.sessionId), turn.startedAt)),
    }, diagnostics)
    : null;
  if (turn.endedAt) {
    if (turnFacts.size >= FACTS_LIMIT) turnFacts.clear();
    turnFacts.set(key, facts);
  }
  return facts;
}

/**
 * 这几轮（都是 error 且没结论）给页面的原因：存过的照用；存过、但缺原话的（这一格出现之前写的）
 * 从盘上把原话补上；没存过的按盘上的事实现算。算不出来的不在返回里。
 */
export async function noVerdictCauses(taskId: string, rounds: readonly RoundRow[]): Promise<Map<string, ReviewNoVerdict>> {
  const out = new Map<string, ReviewNoVerdict>();
  const needDisk = rounds.filter((round) => !round.noVerdict || (round.noVerdict.kind === "interrupted" && !round.noVerdict.said));
  const turns = needDisk.length ? await reviewerTurns(taskId) : [];
  const disk = diskFor(taskId);
  for (const round of rounds) {
    const stored = round.noVerdict;
    const derived = (() => {
      if (!needDisk.includes(round)) return null;
      const turn = closingTurn(turns, round);
      const facts = turn ? interruptionOfTurn(taskId, disk, turn) : undefined;
      return facts === undefined ? null : noVerdictCause(facts, reviewReportWritten(taskId, round.runId, round.round));
    })();
    if (!stored) {
      if (derived) out.set(round.id, derived);
      continue;
    }
    // 存过的原因是那一刻手上事实最全的判法（内存里的执行故障、看门狗判决），类别和那半句以它为准；
    // 盘上补的只是原话，以及那半句是不是同一句笼统话。
    const enrich = derived?.kind === "interrupted" && stored.kind === "interrupted" && !stored.said ? derived : null;
    out.set(round.id, enrich ? {
      ...stored,
      ...(enrich.said ? { said: enrich.said } : {}),
      ...(enrich.vague && enrich.reason === stored.reason ? { vague: true as const } : {}),
    } : stored);
  }
  return out;
}
