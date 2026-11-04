// 删掉会话里的某几段（发错的话、跑偏的回复、哨兵的自动输入、答复、系统注记、只剩执行过程
// 的回合…），并保证**之后的回合里没有哪个 agent 读得到它们**。
//
// 难点不在界面：续聊时 agent 读的不是 ash 这份 .md，而是 CLI 自己的会话文件（claude 的
// jsonl、codex 的 rollout），`--resume` 一接就是删之前那份完整上下文 —— 只把气泡藏起来
// 等于没删。所以删除分三处：
//  ① 盘上抹掉。.md 里那一段换成一行带 `deleted:true` 的 sentinel（只留时刻与回合身份，
//     正文一个字不剩），段落序号与回合边界不动，界面排版和 trace 切点照旧对得上；被删
//     回复那段时间里的 trace 正文/思考/工具事件一并去掉。读正文的人（MCP 读转录、同伴拿到
//     的 .md 路径、追问列表、重试取上一条输入、⌘K 搜 .md）从此都读不到。
//  ② 删的是一条答复：任务上的问答历史里那一条也只留墓碑（id、时刻、出自哪一段），否则换个
//     入口（问答卡、get_task）又读回来。认哪一条按答复的身份（段上的 answerIds；老会话由页面
//     指名、服务端核对），不按原文猜 —— 两次都答「可以」原文一模一样。
//  ③ 给**这个任务的每一条**持有 CLI 会话的会话行挂上 `context_rebuild_at`：下一轮不再
//     `--resume` 旧 CLI 会话，而是开一条新的，把删除之后的 .md 重建成历史喂进去
//     （history-reseed.ts）。不只挂被删那一条所在的会话：同任务的另一位智能体、审查会话
//     都可能读过它（同伴会读彼此的 .md），谁存着这条消息和谁的上下文里有过它是两回事。
//     挂着标记的会话不接受要在旧上下文上跑的 CLI 命令（`/fork` 之类，见 turn-session-pick.ts）。
//
// 只在没有回合在跑时做：先占回合锁（占不到就是有回合在跑或正要起跑），新回合在删完之前
// 起不来。回合之外的追加者（时间线旁注等）与这里排同一把逐文件锁；改写先在内存里算完两份
// 新内容，再各自原子替换（run-file-lock.ts），写失败就如实报失败，不会报成删好了。
//
// 一次删除横跨数据库与两份文件，没有跨存储的事务，所以按「哪一步断了都能原样重试」排顺序：
// 只读校验 → ③ 失效标记 → ② 问答墓碑（一笔原子写）→ trace → 正文。正文是最后一步，只要它
// 没换成，用户看到的就还是那一段、删除入口还在；重试时已经写下的墓碑按 `deletedFrom`/`answerIds` 认回
// 同一段（shared/questions.ts `pairAnswerMessages`），不会再清一条别的记录，也不会被当成
// 「内容变了」拒掉。
//
// 没覆盖的：`<会话>-<回合>.agent-out.jsonl` / `.codex-events.jsonl` 这类逐回合的原始执行日志
// 不改（哨兵对账要逐字节读它们，改了会把那条链读坏）；它们不进任何 prompt。
import { existsSync, readFileSync } from "node:fs";
import { and, eq, isNotNull } from "drizzle-orm";
import type { QuestionRecord } from "@ash/shared/questions";
import {
  parseSessionSpans, segmentFingerprint, traceKeptOnDelete, traceSpanFingerprint, type ConvSeg,
} from "@ash/shared/session-output";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { replaceFileAtomically, withRunFileLock } from "./run-file-lock.js";
import { claimNonTurn, isRunning } from "./runs.js";
import { publishTaskUpdated } from "./task-store.js";
import { parseSessionTrace, sessionTracePath, sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";
import { now } from "./util.js";

/** 正文里的一段（序号 + 指纹），或一段只有执行过程的 trace（时间段 + 指纹）。 */
export type RedactTarget =
  // answerId：页面上这段答复对的是哪条问答记录。只给没有 answerIds 的老会话用，服务端核对过才认。
  | { index: number; fingerprint: string; answerId?: string }
  | { trace: { from: string; to: string; fingerprint: string } };

/** 删除请求被拒或没做成（4xx：此刻不能删或页面上那份正文旧了；500：写盘失败，原样未动）。 */
export class RedactRefusal extends Error {
  constructor(message: string, readonly status: 404 | 409 | 400 | 500) {
    super(message);
  }
}

const STALE = "会话内容已经变化，请刷新后再删除";

/** 从 trace 里摘掉的时间段：(after, until]。 */
type Window = { after: number; until: number };

const time = (at: string | undefined): number => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** 删掉之后留在原位的那一行：只剩回合身份（谁、哪一刻、是不是旁注），正文与哨兵载荷全部去掉。 */
function deletedLine(seg: ConvSeg, original: string): string {
  if (seg.kind === "agent") return `${TURN_SENTINEL}${JSON.stringify({ t: "agent", deleted: true })}`;
  let meta: Record<string, unknown> = {};
  if (original.startsWith(TURN_SENTINEL)) {
    try { meta = JSON.parse(original.slice(TURN_SENTINEL.length)) as Record<string, unknown>; } catch { /* 老格式 */ }
  }
  const { text: _text, monitorWake: _wake, ...identity } = meta;
  return `${TURN_SENTINEL}${JSON.stringify({ ...identity, t: seg.kind, ...(seg.at ? { at: seg.at } : {}), deleted: true })}`;
}

/**
 * 纯函数：把指名的几段在正文里抹掉，返回新正文、被删回复的时间窗、被删的真人插话（拿去
 * 对问答历史）。指名对不上（序号越界、指纹不符、已经删过）就整批拒绝 —— 宁可让用户刷新再点
 * 一次，也不删错一段。
 */
export function redactTranscript(raw: string, targets: readonly { index: number; fingerprint: string }[]): {
  text: string; windows: Window[]; users: { index: number; seg: Extract<ConvSeg, { kind: "user" }> }[];
} {
  const spans = parseSessionSpans(raw);
  const lines = raw.split("\n");
  const chosen = new Set<number>();
  for (const target of targets) {
    const span = spans[target.index];
    if (!span || span.seg.deleted || segmentFingerprint(span.seg) !== target.fingerprint) throw new RedactRefusal(STALE, 409);
    chosen.add(target.index);
  }
  const windows: Window[] = [];
  const users: { index: number; seg: Extract<ConvSeg, { kind: "user" }> }[] = [];
  // 从后往前换：前面的行号不受后面替换的影响。
  for (const index of [...chosen].sort((left, right) => right - left)) {
    const { seg, first, last } = spans[index]!;
    if (seg.kind === "user") users.push({ index, seg });
    if (seg.kind === "agent") {
      // 窗口从前面最近的一处边界（插话时刻，或上一段正文的收口时刻）开始。
      const after = Math.max(Number.NEGATIVE_INFINITY, ...spans.slice(0, index)
        .map(({ seg: prev }) => time(prev.kind === "agent" ? prev.endedAt : prev.at))
        .filter(Number.isFinite));
      const next = spans[index + 1]?.seg;
      // 正文的 trace 要等下一条非正文事件或回合收口才落盘，落盘时刻常常晚于 agentEnd ——
      // 所以窗口一直开到下一段插话；后面紧跟的是另一段正文（中间没插话）时才收在 agentEnd。
      const until = next && next.kind !== "agent" ? time(next.at) : next ? time(seg.endedAt) : Number.NaN;
      windows.push({ after, until: Number.isFinite(until) ? until : Number.POSITIVE_INFINITY });
    }
    lines.splice(first, last - first + 1, deletedLine(seg, lines[first] ?? ""));
  }
  return { text: lines.join("\n"), windows, users };
}

/**
 * 纯函数：一段只有执行过程的气泡 → trace 里的时间窗。按 [from, to] 重算指纹，对不上就拒绝。
 * 时刻是整毫秒，所以闭区间 [from, to] 写成 (from - 1, to]。
 */
export function traceSpanWindow(traceRaw: string | null, span: { from: string; to: string; fingerprint: string }): Window {
  const from = time(span.from);
  const to = time(span.to);
  if (traceRaw === null || !Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new RedactRefusal(STALE, 409);
  const inside = parseSessionTrace(traceRaw).filter((entry) => time(entry.at) >= from && time(entry.at) <= to);
  if (!inside.some((entry) => !traceKeptOnDelete(entry.event.kind)) || traceSpanFingerprint(inside) !== span.fingerprint) {
    throw new RedactRefusal(STALE, 409);
  }
  return { after: from - 1, until: to };
}

/** 纯函数：从 trace 里摘掉落在时间窗里的执行事件（回合身份 run 与用量 usage 留着记账）。 */
export function redactTrace(raw: string, windows: readonly Window[]): string {
  if (!windows.length) return raw;
  return raw.split("\n").filter((line) => {
    if (!line.trim()) return true;
    let entry: { at?: string; event?: { kind?: string } };
    try { entry = JSON.parse(line); } catch { return true; }
    if (traceKeptOnDelete(entry.event?.kind ?? "")) return true;
    const at = time(entry.at);
    return !windows.some((window) => at > window.after && at <= window.until);
  }).join("\n");
}

type PickedUser = { index: number; seg: Extract<ConvSeg, { kind: "user" }>; answerId?: string };

/**
 * 这一段删掉时要清哪几条问答记录（纯函数，判据与问答卡同一份 `pairAnswerMessages` 的三档）：
 * 段上写着 answerIds 就只认它；已有墓碑记着出自这一段 = 上次删到一半，这次什么都不用再清；
 * 老会话按页面指名的那条，核对它的答复原文就是这一段；页面没指名时同文记录唯一才认。
 */
export function answerIdsToClear(history: readonly QuestionRecord[], sessionId: string, pick: PickedUser): string[] {
  if (pick.seg.answerIds?.length) return pick.seg.answerIds;
  if (history.some((record) => record.deletedFrom?.sessionId === sessionId && record.deletedFrom.index === pick.index)) return [];
  if (pick.answerId) {
    const named = history.find((record) => record.id === pick.answerId);
    if (!named || named.deleted || named.reply !== pick.seg.text) throw new RedactRefusal(STALE, 409);
    return [named.id];
  }
  const same = history.filter((record) => !record.deleted && record.reply === pick.seg.text);
  if (same.length > 1) throw new RedactRefusal("有几条答复原文完全相同，认不出这一段是哪一条问答，请刷新页面后再删", 409);
  return same.map((record) => record.id);
}

/** 被删的答复在问答历史里只留墓碑（连同它出自哪一段）。普通插话对不上任何记录，不动。 */
async function tombstoneAnswers(taskId: string, sessionId: string, picks: readonly PickedUser[]): Promise<boolean> {
  if (!picks.length) return false;
  // 并发的 /answer 会在同一列上追加记录：比对着旧值写，被抢先就重读再来。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = (await db.select({ history: tasks.questionHistory }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    const history: QuestionRecord[] = row?.history ? JSON.parse(row.history) : [];
    const owner = new Map<string, number>();
    for (const pick of picks) for (const answerId of answerIdsToClear(history, sessionId, pick)) owner.set(answerId, pick.index);
    let touched = false;
    const next = history.map((record): QuestionRecord => {
      const index = owner.get(record.id);
      if (index === undefined || record.deleted) return record;
      touched = true;
      return {
        id: record.id, answeredAt: record.answeredAt, question: null, answer: "", reply: "", deleted: true,
        deletedFrom: { sessionId, index },
      };
    });
    if (!touched) return false;
    const written = await db.update(tasks).set({ questionHistory: JSON.stringify(next) })
      .where(and(eq(tasks.id, taskId), eq(tasks.questionHistory, row!.history!))).returning({ id: tasks.id });
    if (written.length) return true;
  }
  throw new RedactRefusal("问答记录正在更新，删除没有完成，消息还在，请稍后再删一次", 409);
}

/** 锁里同步读出这两份文件，按指名算出新内容（指名对不上就整批拒绝）。 */
function planRewrite(mdPath: string, tracePath: string, targets: readonly RedactTarget[]) {
  const raw = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : null;
  const traceRaw = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : null;
  const segmentTargets = targets.flatMap((target) => "index" in target ? [target] : []);
  if (raw === null && segmentTargets.length) throw new RedactRefusal(STALE, 409);
  const redacted = raw === null ? null : redactTranscript(raw, segmentTargets);
  const windows = [
    ...redacted?.windows ?? [],
    ...targets.flatMap((target) => "trace" in target ? [traceSpanWindow(traceRaw, target.trace)] : []),
  ];
  const named = new Map(segmentTargets.map((target) => [target.index, target.answerId]));
  return {
    raw, traceRaw, redacted,
    traceNext: traceRaw === null ? null : redactTrace(traceRaw, windows),
    users: (redacted?.users ?? []).map((user): PickedUser => ({ ...user, answerId: named.get(user.index) })),
  };
}

const unfinished = (error: unknown) => error instanceof RedactRefusal ? error
  : new RedactRefusal(`删除没有完成，消息还在，可以重试（${error instanceof Error ? error.message : String(error)}）`, 500);

export async function deleteConversationSegments(sessionId: string, targets: readonly RedactTarget[]): Promise<{ deleted: number }> {
  if (!targets.length) throw new RedactRefusal("没有要删除的消息", 400);
  const session = (await db.select().from(sessions).where(eq(sessions.id, sessionId))).at(0);
  if (!session) throw new RedactRefusal("会话不存在", 404);
  const task = (await db.select().from(tasks).where(eq(tasks.id, session.taskId))).at(0);
  if (!task) throw new RedactRefusal("任务不存在", 404);
  // 团队调度台是常驻进程、duet 有自己的起跑链路，都还没接「下一轮重建上下文」：只删界面
  // 不清上下文就是假删除，宁可明说不支持。
  if (task.mode !== "single") throw new RedactRefusal("目前只有单个智能体的任务支持删除消息", 409);
  const busy = "智能体正在运行，请先停止再删除消息";
  if (task.status === "running" || task.status === "queued" || isRunning(task.id)) throw new RedactRefusal(busy, 409);
  const release = claimNonTurn(task.id, "conversation-redact");
  if (!release) throw new RedactRefusal(busy, 409);
  let answersTouched = false;
  try {
    const mdPath = sessionTranscriptPath(task.id, sessionId);
    const tracePath = sessionTracePath(task.id, sessionId);
    // 先校验、认出被删的答复（只读）：指名对不上（页面旧了）就到此为止，什么都不动 —— 包括下面
    // 那道全任务的失效标记，否则一次 409 就白白让每条会话都丢掉旧上下文。
    const { users } = await withRunFileLock([mdPath, tracePath], () => planRewrite(mdPath, tracePath, targets))
      .catch((error) => { throw unfinished(error); });
    // **挂上「下一轮重建上下文」再动任何存储**：反过来的话，抹完正文、这一笔没写成，下一轮就
    // 照旧 --resume 那条还记得原话的 CLI 会话。先挂后抹最坏是白重建一次。
    await db.update(sessions).set({ contextRebuildAt: now() })
      .where(and(eq(sessions.taskId, task.id), isNotNull(sessions.cliSessionId)));
    answersTouched = await tombstoneAnswers(task.id, sessionId, users).catch((error) => { throw unfinished(error); });
    await withRunFileLock([mdPath, tracePath], () => {
      // 锁里从读到换名全是同步的：同进程的同步追加插不进来，异步追加都在排这把锁。两次进锁
      // 之间有旁注追加也无妨 —— 这里按同样的指名重算一遍，对不上就拒绝（墓碑已在，重试认得回）。
      const { raw, traceRaw, redacted, traceNext } = planRewrite(mdPath, tracePath, targets);
      try {
        // 先 trace 后正文：正文没换成，用户看到的就还是原样，重试时会按同样的窗口再摘一遍。
        if (traceNext !== null && traceNext !== traceRaw) replaceFileAtomically(tracePath, traceNext);
        if (redacted && redacted.text !== raw) replaceFileAtomically(mdPath, redacted.text);
      } catch (error) {
        console.warn(`[ash] 删除消息写盘失败 session=${sessionId}:`, error);
        throw unfinished(error);
      }
    });
  } finally {
    release();
    // 问答墓碑写成了就要让开着的页面知道，哪怕后面换文件失败（页面据此不再把它当成未删）。
    if (answersTouched) await publishTaskUpdated(task.id).catch((error) => console.warn(`[ash] 删除消息后推送任务失败 ${task.id}:`, error));
  }
  bus.publish({ type: "conversation.redacted", taskId: task.id, sessionId });
  return { deleted: targets.length };
}
