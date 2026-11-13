// 没存过原因的那几轮「没给出结论」，按盘上还在的事实**现算**出同一份原因（`ReviewNoVerdict`）。
//
// 原因原本只在审查回合收尾那一刻写进轮次（review-channel-gap.ts → `free_review_rounds.no_verdict`），
// 那份代码上线之前断掉的轮次一样都没有，页面上就只剩「第 1 轮异常」，看不出出了什么错（任务
// EhQtqns9fnG2：用户第三次问同一件事）。可那一回合的事实大多还在：
//   · 回合行（`session_turns`）：哪条审查会话、哪一刻开的、结局是 failed 还是 completed、看门狗判过熔断没有；
//   · 会话行的退出码（只对那条会话的**最后一回合**作数）；
//   · codex 落的那份诊断（退出码、退出信号、执行器原话）和原始事件；
//   · 报告文件在不在（跟页面读报告同一个入口）。
//
// 判法跟回合收尾那一刻是**同一份**（`interruptionOf` / `noVerdictCause`），只是事实换成从盘上读：
// 模型 API 的类型照旧只认执行器归一层给的 —— 把那一回合的原始事件按 codex 执行器当时的同一套
// 归一（`codexErrorEvent` / `codexTurnError`）重放一遍，取它当时会挂上的那条错误；不在诊断原文里
// 另找状态码（为什么见 review-no-verdict.ts 文件头）。读不到事件，就照实说「执行器异常退出（exit N）」，
// 带上原话。一样都读不到的轮次给 null，页面照老样子。
//
// 为什么现算、不一次性补写进库：这份结构这一版刚多了原话，上一版写进库的那些也缺这一格，补写得
// 两头都补；而现算的输入（结束了的回合、盘上的文件）不会再变，按回合身份记一份就只读一次盘。
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ModelFailure } from "@ash/shared";
import type { ReviewNoVerdict } from "@ash/shared/timeline-notice";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, sessions, sessionTurns } from "./db/schema.js";
import { codexErrorEvent } from "./executors/codex-error-event.js";
import { codexTurnError } from "./executors/model-failure.js";
import { RUNS_DIR } from "./paths.js";
import { interruptionOf, noVerdictCause, readTurnDiagnostics, reviewReportWritten, type Interruption } from "./review-no-verdict.js";
import { readableRunPath, runTracePaths } from "./transcript.js";

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

const TAIL = 256 * 1024;

/** 原始事件只读尾巴：回合最后那条错误一定在末尾，而这份文件常有几百 KB。 */
function readTail(path: string): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= TAIL) return readFileSync(path, "utf8");
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(TAIL);
    const got = readSync(fd, buf, 0, TAIL, size - TAIL);
    const text = buf.subarray(0, got).toString("utf8");
    return text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* 关不上就算了 */ }
  }
}

const messageOf = (value: unknown): string | null => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const raw = record.message ?? error.message ?? record.error ?? record.detail;
  return typeof raw === "string" && raw.trim() ? raw : null;
};

/**
 * 按执行器自己的归一重放这一回合的原始事件（App Server 的 `error` 通知 / `turn/completed` 失败，
 * exec 的 `error` / `turn.failed`），取回收尾那一刻手上的两样事实，别的执行器没有这份文件就都没有：
 *   · `error`：这一轮的执行故障 —— 只算重试完了还是错的那些（`counted`），挑法跟单飞收尾一样：
 *     带模型类型的那条不被后面没类型的盖掉；
 *   · `stallModel`：看门狗熔断时据以说原因的那个类型 —— 它每收一条错误（重试中的也算）就把类型
 *     换成那一条的（turn-stall.ts 的 `lastModel`），所以这里同样只认**最后那条**错误，没类型就是没有。
 *     重试通知不升格成执行故障，它的类型也不丢。
 */
function replayCodexEvents(eventsPath: string): { error: ExecutionError | null; stallModel: ModelFailure | null } {
  let picked: ExecutionError | null = null;
  let stallModel: ModelFailure | null = null;
  const take = (event: ExecutionError) => {
    stallModel = event.model ?? null;
    if (!picked?.model || event.model) picked = event;
  };
  for (const line of readTail(eventsPath).split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const params = ev.params && typeof ev.params === "object" ? ev.params as Record<string, unknown> : null;
    if (ev.method === "error" && params) {
      const reported = codexErrorEvent(params);
      if (reported?.counted) take(reported.event);
      else if (reported) stallModel = reported.event.model ?? null;
    } else if (ev.method === "turn/completed" && params) {
      const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : {};
      const message = turn.status === "failed" ? messageOf(turn) : null;
      if (message) take(codexTurnError(message));
    } else if (ev.type === "turn.failed" || ev.type === "error") {
      const message = messageOf(ev);
      if (message) take(codexTurnError(message));
    }
  }
  return { error: picked, stallModel };
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
function interruptionOfTurn(taskId: string, turn: ReviewerTurn): Interruption | null | undefined {
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
  const replay = failed
    ? replayCodexEvents(readableRunPath(runTracePaths(join(RUNS_DIR, taskId), turn.sessionId, turn.startedAt).eventsPath))
    : null;
  const facts = replay
    ? interruptionOf({
      exitStatus: exitStatus ?? 0,
      verdict: turn.stallReason ? { kind: "tripped", reason: turn.stallReason, model: replay.stallModel } : null,
      error: replay.error,
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
  for (const round of rounds) {
    const stored = round.noVerdict;
    const derived = (() => {
      if (!needDisk.includes(round)) return null;
      const turn = closingTurn(turns, round);
      const facts = turn ? interruptionOfTurn(taskId, turn) : undefined;
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
