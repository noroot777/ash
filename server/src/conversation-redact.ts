// 删掉会话里的某几段（发错的话、跑偏的回复、哨兵的自动输入…），并保证**之后的回合里
// agent 读不到它们**。
//
// 难点不在界面：续聊时 agent 读的不是 ash 这份 .md，而是 CLI 自己的会话文件（claude 的
// jsonl、codex 的 rollout），`--resume` 一接就是删之前那份完整上下文 —— 只把气泡藏起来
// 等于没删。所以删除分两半：
//  ① 盘上就地抹掉。.md 里那一段换成一行带 `deleted:true` 的 sentinel（只留时刻与回合
//     身份，正文一个字不剩），段落序号与回合边界不动，界面排版和 trace 切点照旧对得上；
//     被删回复那段时间里的 trace 正文/思考/工具事件一并去掉。读正文的人（MCP 读转录、
//     同伴拿到的 .md 路径、追问列表、重试取上一条输入、⌘K 搜 .md）从此都读不到。
//  ② 给会话行挂上 `context_rebuild_at`：下一轮不再 `--resume` 旧 CLI 会话，而是在同一行上
//     开一条新的 CLI 会话，把删除之后的 .md 重建成历史喂进去（history-reseed.ts）。
//
// 只在没有回合在跑时做：先占回合锁（占不到就是有回合在跑或正要起跑），新回合在删完之前
// 起不来。改写是就地写回同一个 inode，别处以 append 打开的写流不受影响；读到写之间若有人
// 追加了一笔（任务时间线旁注随时可能落），按长度核出来、整次作罢，不会把那一笔覆盖掉。
//
// 没覆盖的：`<会话>-<回合>.agent-out.jsonl` / `.codex-events.jsonl` 这类逐回合的原始执行日志
// 不改（哨兵对账要逐字节读它们，改了会把那条链读坏）；它们不进任何 prompt。
import { open } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { parseSessionSpans, segmentFingerprint, type ConvSeg } from "@ash/shared/session-output";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { claimNonTurn, isRunning } from "./runs.js";
import { sessionTracePath, sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";
import { now } from "./util.js";

export type RedactTarget = { index: number; fingerprint: string };

/** 删除请求被拒的原因（都是 4xx：请求本身没错，只是此刻不能删或页面上那份正文旧了）。 */
export class RedactRefusal extends Error {
  constructor(message: string, readonly status: 404 | 409 | 400) {
    super(message);
  }
}

const STALE = "会话内容已经变化，请刷新后再删除";

/** 被删回复那段时间：(after, until]。只用来从 trace 里摘掉那几条执行事件。 */
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
 * 纯函数：把指名的几段在正文里抹掉，返回新正文与被删回复的时间窗。指名对不上（序号越界、
 * 指纹不符、已经删过）就整批拒绝 —— 宁可让用户刷新再点一次，也不删错一段。
 */
export function redactTranscript(raw: string, targets: readonly RedactTarget[]): { text: string; windows: Window[] } {
  const spans = parseSessionSpans(raw);
  const lines = raw.split("\n");
  const chosen = new Map<number, RedactTarget>();
  for (const target of targets) {
    const span = spans[target.index];
    if (!span || span.seg.deleted || segmentFingerprint(span.seg) !== target.fingerprint) throw new RedactRefusal(STALE, 409);
    chosen.set(target.index, target);
  }
  const windows: Window[] = [];
  // 从后往前换：前面的行号不受后面替换的影响。
  for (const index of [...chosen.keys()].sort((left, right) => right - left)) {
    const { seg, first, last } = spans[index]!;
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
  return { text: lines.join("\n"), windows };
}

/** 纯函数：从 trace 里摘掉落在被删回复时间窗里的执行事件（回合身份 run 与用量 usage 留着记账）。 */
export function redactTrace(raw: string, windows: readonly Window[]): string {
  if (!windows.length) return raw;
  return raw.split("\n").filter((line) => {
    if (!line.trim()) return true;
    let entry: { at?: string; event?: { kind?: string } };
    try { entry = JSON.parse(line); } catch { return true; }
    if (entry.event?.kind === "run" || entry.event?.kind === "usage") return true;
    const at = time(entry.at);
    return !windows.some((window) => at > window.after && at <= window.until);
  }).join("\n");
}

/** 就地改写（同一个 inode）。读到写之间文件长了 = 有人在追加，整次作罢。 */
async function rewriteInPlace(path: string, transform: (raw: string) => string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    const raw = await handle.readFile("utf8");
    const next = transform(raw);
    if (next === raw) return;
    if ((await handle.stat()).size !== Buffer.byteLength(raw, "utf8")) throw new RedactRefusal("会话正在写入，请稍后再删除", 409);
    const bytes = Buffer.from(next, "utf8");
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
  } finally {
    await handle.close();
  }
}

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
  try {
    // **先挂上「下一轮重建上下文」再动正文**：反过来的话，抹完正文、这一笔没写成，下一轮就
    // 照旧 --resume 那条还记得原话的 CLI 会话。先挂后抹最坏是白重建一次。
    await db.update(sessions).set({ contextRebuildAt: now() }).where(eq(sessions.id, sessionId));
    let windows: Window[] = [];
    try {
      await rewriteInPlace(sessionTranscriptPath(task.id, sessionId), (raw) => {
        const redacted = redactTranscript(raw, targets);
        windows = redacted.windows;
        return redacted.text;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RedactRefusal(STALE, 409);
      throw error;
    }
    await rewriteInPlace(sessionTracePath(task.id, sessionId), (raw) => redactTrace(raw, windows)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[ash] 删除消息后清理 trace 失败 session=${sessionId}:`, error);
    });
  } finally {
    release();
  }
  bus.publish({ type: "conversation.redacted", taskId: task.id, sessionId });
  return { deleted: targets.length };
}
