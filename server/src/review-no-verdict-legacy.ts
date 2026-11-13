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
// 模型 API 的类型照旧只认执行器归一层给的，不在诊断原文里另找状态码（为什么见 review-no-verdict.ts
// 文件头）。两样事实各有各的时刻，取的地方也不同：
//   · 这一轮的执行故障：结算时手上那条 —— 把原始事件按 codex 执行器当时的同一套归一重放一遍
//     （主线程 / 子智能体线程的归属也照当场那样分，见 `replayCodexEvents`）；
//   · 看门狗熔断时说原因用的类型：**熔断那一刻**冻结的那条（见 `trippedModel`），之后才到的错误不算。
// 读不到事件，就照实说「执行器异常退出（exit N）」，带上原话。一样都读不到的轮次给 null，页面照老样子。
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
import { readableRunPath, runTracePaths, sessionTracePath } from "./transcript.js";
import { readStallJournal } from "./turn-stall-journal.js";
import { isStallWarningText } from "./turn-stall-text.js";
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
  /** 会话行上的 CLI 会话 id（codex 是主线程 id）：认主线程时原始事件开头读不出来才用它。 */
  cliSessionId: string | null;
};

const TAIL = 256 * 1024;
const HEAD = 64 * 1024;

/** 原始事件读一头一尾：主线程身份在开头（起线程那一问的应答），回合最后那几条错误在末尾。 */
function readEdge(path: string, edge: "head" | "tail"): string {
  const budget = edge === "head" ? HEAD : TAIL;
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= budget) return readFileSync(path, "utf8");
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(budget);
    const got = readSync(fd, buf, 0, budget, edge === "head" ? 0 : size - budget);
    const text = buf.subarray(0, got).toString("utf8");
    // 截断处切在半行中间：那半行不要。
    return edge === "head" ? text.slice(0, text.lastIndexOf("\n") + 1) : text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* 关不上就算了 */ }
  }
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const parseLines = (text: string): Record<string, unknown>[] => text.split("\n").flatMap((line) => {
  if (!line.trim()) return [];
  try {
    return [recordOf(JSON.parse(line))];
  } catch {
    return [];
  }
});

const messageOf = (value: unknown): string | null => {
  const record = recordOf(value);
  const error = recordOf(record.error);
  const raw = record.message ?? error.message ?? record.error ?? record.detail;
  return typeof raw === "string" && raw.trim() ? raw : null;
};

/**
 * 这一回合的主线程是哪一条：执行器起线程（start / resume / fork）那一问的应答里的线程 id ——
 * 它排在任何子线程之前（查子线程模型的 `thread/read` 应答也带线程 id，但只会在后面）。文件开头
 * 读不出来时退回会话行上记的 CLI 会话 id。两样都没有就是不知道。
 */
function mainThreadOf(eventsPath: string, cliSessionId: string | null): string | null {
  for (const line of parseLines(readEdge(eventsPath, "head"))) {
    const id = recordOf(recordOf(line.result).thread).id;
    if (typeof id === "string" && id) return id;
  }
  return cliSessionId;
}

/**
 * 按执行器自己的归一重放这一回合的原始事件，取回收尾那一刻手上的执行故障（别的执行器没有这份
 * 文件就没有）。原始文件里主线程和子智能体线程的通知混在一起，归属照 codex-app-server.ts 当场
 * 那样分：`threadId` 不是主线程的是子线程的，子线程失败不是父回合失败，整行不看；主线程的（以及
 * exec 那种不分线程的）按 `codexErrorEvent` / `codexTurnError` 归一。跟单飞收尾一样只认重试完了
 * 还是错的那些（App Server 的 `error` 通知、失败的 `turn/completed`，exec 的 `error` / `turn.failed`）。
 * 挑法也一样：带模型类型的那条不被后面没类型的盖掉。分不出主线程（不知道主线程是哪条）的带线程行
 * 同样不看：来源不明的不替它升格成这一轮的故障。
 *
 * 熔断用的类型**不从这里取**：原始行没有时刻，分不出哪条在熔断之前（见 `trippedModel`）。
 */
function replayCodexEvents(eventsPath: string, cliSessionId: string | null): ExecutionError | null {
  const main = mainThreadOf(eventsPath, cliSessionId);
  let picked: ExecutionError | null = null;
  const seen = (event: ExecutionError) => {
    if (!picked?.model || event.model) picked = event;
  };
  for (const ev of parseLines(readEdge(eventsPath, "tail"))) {
    const method = typeof ev.method === "string" ? ev.method : null;
    const params = recordOf(ev.params);
    const thread = typeof params.threadId === "string" && params.threadId ? params.threadId : null;
    if (method && thread && thread !== main) continue;
    if (method === "error") {
      const reported = codexErrorEvent(params);
      if (reported?.counted && reported.event.kind === "error") seen(reported.event);
    } else if (method === "turn/completed") {
      const turn = recordOf(params.turn);
      const message = turn.status === "failed" ? messageOf(turn) : null;
      if (message) seen(codexTurnError(message));
    } else if (ev.type === "turn.failed" || ev.type === "error") {
      const message = messageOf(ev);
      if (message) seen(codexTurnError(message));
    }
  }
  return picked;
}

/**
 * 看门狗熔断这一回合时说原因用的那个模型 API 类型。在线那一路是**熔断那一刻**把 `lastModel`
 * 冻进判决的（turn-stall.ts 的 `markStallFailure`）：之后才到的错误 —— 杀进程那段时间里主线程
 * 又报的一条重试、子线程晚到的失败 —— 改不了它。所以事后也只认判决时刻之前的事实：
 *   1. 判决日志里这个回合的那条判决（销账了、还没压缩掉的也在）：它记的就是冻结的那一份。带
 *      类型那一格之前写的旧记录说不出来，往下找。
 *   2. 这一回合的执行过程（会话 trace）：它按消费顺序记下了看门狗看到的那些事件，熔断那句红字
 *      （以判决原文开头）也落在里面。只看红字之前的，照 `lastModel` 的取法认最后一条错误 ——
 *      穿过子智能体包装、重试中的也算；看门狗自己说的警告不是它观察到的，拣出去。
 *   3. 都找不到（日志压缩了、红字没落下来）：认不出，给 null，那半句照实说「类型不明」。
 */
function trippedModel(taskId: string, turn: ReviewerTurn, stallReason: string): ModelFailure | null {
  const record = readStallJournal().verdicts
    .filter((verdict) => verdict.sessionId === turn.sessionId && verdict.turnStartedAt === turn.startedAt && verdict.model !== undefined)
    .at(-1);
  if (record) return record.model ?? null;
  let text = "";
  try {
    text = readFileSync(readableRunPath(sessionTracePath(taskId, turn.sessionId)), "utf8");
  } catch {
    return null;
  }
  let model: ModelFailure | null = null;
  for (const entry of parseLines(text)) {
    if (entry.turnStartedAt !== turn.startedAt) continue;
    const event = recordOf(entry.event) as unknown as AgentEvent;
    if (event.kind === "error" && typeof event.message === "string") {
      if (event.message.startsWith(stallReason)) return model;
      if (isStallWarningText(event.message)) continue;
    }
    const facts = errorFacts(event);
    if (facts) model = facts.model;
  }
  return null;
}

/** 这一任务名下每个审查回合：回合行为主，没有回合行的老会话按会话行上记的最后一回合补一条。 */
async function reviewerTurns(taskId: string): Promise<ReviewerTurn[]> {
  const sessionRows = await db.select({
    id: sessions.id, turnStartedAt: sessions.turnStartedAt, startedAt: sessions.startedAt, endedAt: sessions.endedAt,
    exitStatus: sessions.exitStatus, stoppedAs: sessions.stoppedAs, cliSessionId: sessions.cliSessionId,
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
    return {
      ...turn, exitStatus: last?.exitStatus ?? null, stoppedAs: last?.stoppedAs ?? null,
      cliSessionId: bySession.get(turn.sessionId)?.cliSessionId ?? null,
    };
  });
  for (const row of sessionRows) {
    const startedAt = row.turnStartedAt ?? row.startedAt;
    if (out.some((turn) => turn.sessionId === row.id && turn.startedAt === startedAt)) continue;
    out.push({
      sessionId: row.id, startedAt, endedAt: row.endedAt, outcome: null, stallReason: null,
      exitStatus: row.exitStatus, stoppedAs: row.stoppedAs, cliSessionId: row.cliSessionId,
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
  const facts = failed
    ? interruptionOf({
      exitStatus: exitStatus ?? 0,
      verdict: turn.stallReason ? { kind: "tripped", reason: turn.stallReason, model: trippedModel(taskId, turn, turn.stallReason) } : null,
      error: replayCodexEvents(readableRunPath(runTracePaths(join(RUNS_DIR, taskId), turn.sessionId, turn.startedAt).eventsPath), turn.cliSessionId),
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
