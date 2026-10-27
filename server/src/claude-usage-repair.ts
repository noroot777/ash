// claude 账本的一次性历史回填。
//
// 起因见 usage.ts 的文件头：claude 的 `result` 其实是**整条 CLI 线程的累计快照**，而
// v1~v3 的账本按「本轮增量」逐轮相加，于是 resume 第 N 回合把前 N 回合的总和又加了
// 一遍。这里从每条会话落盘的 trace 把原始 `result` 序列读回来，按线程求差重算
// `sessions.usage_*`。
//
// **跟 usage-repair.ts 的两点不同，都是故意的**：
// ① 那一份挂在启动流程上、靠 app_settings 的 key 保证只跑一次；这一份**只能手工跑**
//    （scripts/repair-claude-usage.ts），默认 dry-run，apply 还要显式指定库文件。改几亿
//    token 的账是不可逆的，必须先在拷贝上看前后对照。
// ② 那一份把 claude 当增量、只重算 codex；这一份反过来只动 claude，codex 一行不碰。
//
// 为什么读 trace 而不读 `data/runs/**/*.agent-out.jsonl`：原始 stdout 由 run-logs-gc.ts
// 默认 24 小时回收（实测 498 条 claude 会话只剩 21 条还有 agent-out），而 trace 是耐久
// 记录，且逐字保存了同一批 `result` 数字（两条样本会话 46/46、16/16 完全吻合）。
import { readFileSync } from "node:fs";
import { and, eq, isNotNull, like } from "drizzle-orm";
import type { TokenUsage } from "@ash/shared";
import { addUsage } from "@ash/shared/usage";
import { db } from "./db/index.js";
import { appSettings, sessions, usageCumulativeSnapshots } from "./db/schema.js";
import { parseSessionTrace, readableRunPath, sessionTracePath } from "./transcript.js";
import { cumulativeUsageDelta, sessionUsage } from "./usage.js";

export const CLAUDE_REPAIR_MARKER = "internal.claude-usage-cumulative-repair";

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
/** 判「强证据」的下限：4 条 = 3 次相邻比较。实测 210 条多轮会话里，3 次比较全不降的
 *  序列无一例是逐轮增量，而把真实增量序列换算回去也只有 n=2 会偶然全升（6/45）。 */
const STRONG_EVIDENCE_TURNS = 4;

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 };

export type UsageTraceEntry = { at: string; sessionId: string; usage: TokenUsage };

/** 这一条会话的账要不要改、改成什么、凭什么。 */
export type ClaudeSessionPlan = {
  sessionId: string;
  taskId: string;
  cliSessionId: string | null;
  startedAt: string;
  /** 库里记的回合数。 */
  turns: number;
  before: TokenUsage | null;
  /** 重算结果；null = 这条不动。 */
  after: TokenUsage | null;
  regime: "cumulative" | "incremental" | "unknown";
  evidence: "strong" | "weak-date" | "weak-monotonic" | "single-turn" | "none";
  /** 这条会话的 trace 跨了「改口径」那一刻：前半截是旧口径、后半截已经是增量。 */
  straddlesCutoff: boolean;
  /**
   * 改口径之后那条线程的第一回合把整份累计值记成了增量（快照还没建起来），这次顺手补掉。
   * 它是「先重启、后回填」留下的痕迹；按推荐顺序（先停服务、先回填、再重启）则一条都不会有。
   */
  rebasedFirstTurnAfterCutoff: boolean;
  skipped: string | null;
};

export type ClaudeSnapshotPlan = {
  sourceId: string;
  usage: TokenUsage | null;
  baselineReady: boolean;
  reason: string;
};

export type ClaudeUsageRepairPlan = {
  /** 这一刻之后的 trace 条目已由修好的代码归一成增量，不能再求差。null = 还没有。 */
  cutoff: string | null;
  boundary: { lastIncremental: string | null; firstCumulative: string | null; clean: boolean };
  sessions: ClaudeSessionPlan[];
  snapshots: ClaudeSnapshotPlan[];
  warnings: string[];
};

const nonDecreasing = (previous: TokenUsage, current: TokenUsage) =>
  TOKEN_KEYS.every((key) => current[key] >= previous[key]);

/** 整串都不下降 —— 累计快照的特征。逐轮增量会上下起伏。 */
export function monotonicUsage(series: readonly TokenUsage[]): boolean {
  return series.every((usage, index) => index === 0 || nonDecreasing(series[index - 1]!, usage));
}

/**
 * 从一条会话的 trace 里把 usage 事件按顺序取回来。**读不到文件返回 null（≠ 空数组）**：
 * 「这条会话一轮都没报账」和「它的 trace 丢了」必须分开，后者不能被当成可重算的完整历史。
 */
export function readUsageTrace(taskId: string, sessionId: string): UsageTraceEntry[] | null {
  let text: string;
  try {
    text = readFileSync(readableRunPath(sessionTracePath(taskId, sessionId)), "utf8");
  } catch {
    return null;
  }
  return parseSessionTrace(text)
    .filter((entry) => entry.event.kind === "usage")
    .map((entry) => ({
      at: entry.at,
      sessionId,
      usage: (entry.event as { kind: "usage"; usage: TokenUsage }).usage,
    }));
}

type Candidate = {
  sessionId: string;
  taskId: string;
  cliSessionId: string | null;
  startedAt: string;
  turns: number;
  before: TokenUsage | null;
  entries: UsageTraceEntry[] | null;
};

async function loadCandidates(): Promise<Candidate[]> {
  const rows = await db.select().from(sessions)
    .where(and(eq(sessions.agentType, "claude"), isNotNull(sessions.usageTurns)));
  return rows.map((row) => ({
    sessionId: row.id,
    taskId: row.taskId,
    cliSessionId: row.cliSessionId,
    startedAt: row.startedAt,
    turns: row.usageTurns ?? 0,
    before: sessionUsage(row),
    entries: readUsageTrace(row.taskId, row.id),
  }));
}

/** 已经被修好的代码记过账的 claude 线程里，最早那一次落库的时刻。 */
async function liveCutoff(): Promise<string | null> {
  const rows = await db.select({ updatedAt: usageCumulativeSnapshots.updatedAt })
    .from(usageCumulativeSnapshots).where(like(usageCumulativeSnapshots.sourceId, "claude:%"));
  return rows.reduce<string | null>(
    (earliest, row) => (!earliest || row.updatedAt < earliest ? row.updatedAt : earliest),
    null,
  );
}

export async function planClaudeUsageRepair(options: {
  cutoff?: string | null;
} = {}): Promise<ClaudeUsageRepairPlan> {
  const candidates = await loadCandidates();
  const cutoff = options.cutoff !== undefined ? options.cutoff : await liveCutoff();
  const existingSnapshots = new Set(
    (await db.select({ sourceId: usageCumulativeSnapshots.sourceId })
      .from(usageCumulativeSnapshots).where(like(usageCumulativeSnapshots.sourceId, "claude:%")))
      .map((row) => row.sourceId),
  );

  const groups = new Map<string, Candidate[]>();
  const orphans: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.cliSessionId) orphans.push(candidate);
    else groups.set(candidate.cliSessionId, [...(groups.get(candidate.cliSessionId) ?? []), candidate]);
  }

  // ── 第一遍：只看强证据组，把「哪天起 CLI 改成累计口径」这条界定出来 ──────────
  const strong: { startedAt: string; cumulative: boolean }[] = [];
  const split = new Map<string, { pre: UsageTraceEntry[]; post: UsageTraceEntry[]; complete: boolean }>();
  for (const [cliSessionId, members] of groups) {
    const complete = members.every((member) => member.entries && member.entries.length === member.turns);
    const entries = members.flatMap((member) => member.entries ?? []).sort((a, b) => a.at.localeCompare(b.at));
    const pre = cutoff === null ? entries : entries.filter((entry) => entry.at < cutoff);
    const post = cutoff === null ? [] : entries.filter((entry) => entry.at >= cutoff);
    split.set(cliSessionId, { pre, post, complete });
    if (!complete || pre.length < STRONG_EVIDENCE_TURNS) continue;
    strong.push({
      startedAt: members.map((member) => member.startedAt).sort()[0]!,
      cumulative: monotonicUsage(pre.map((entry) => entry.usage)),
    });
  }
  const lastIncremental = strong.filter((item) => !item.cumulative)
    .map((item) => item.startedAt).sort().at(-1) ?? null;
  const firstCumulative = strong.filter((item) => item.cumulative)
    .map((item) => item.startedAt).sort().at(0) ?? null;
  const clean = !(lastIncremental && firstCumulative && firstCumulative <= lastIncremental);
  const warnings: string[] = [];
  if (!clean) {
    warnings.push(
      `两种口径的强证据会话在时间上交错（最后一条逐轮增量 ${lastIncremental}，`
      + `最早一条线程累计 ${firstCumulative}），无法界定升级时刻；证据不足的会话一律按单调性判。`,
    );
  }

  // ── 第二遍：逐组重算 ────────────────────────────────────────────────────────
  const sessionPlans: ClaudeSessionPlan[] = [];
  const snapshots: ClaudeSnapshotPlan[] = [];
  for (const [cliSessionId, members] of groups) {
    const { pre, post, complete } = split.get(cliSessionId)!;
    const sourceId = `claude:${cliSessionId}`;
    const base = {
      cliSessionId,
      straddlesCutoff: pre.length > 0 && post.length > 0,
    };
    if (!complete) {
      for (const member of members) {
        sessionPlans.push({
          ...base,
          sessionId: member.sessionId,
          taskId: member.taskId,
          startedAt: member.startedAt,
          turns: member.turns,
          before: member.before,
          after: null,
          regime: "unknown",
          evidence: "none",
          rebasedFirstTurnAfterCutoff: false,
          skipped: member.entries
            ? `trace 里 ${member.entries.length} 条 usage，库里记 ${member.turns} 轮，对不上`
            : "读不到 trace 文件",
        });
      }
      if (!existingSnapshots.has(sourceId)) {
        snapshots.push({
          sourceId,
          usage: null,
          baselineReady: false,
          reason: "历史重算不了，留待建基线：下一轮只记基线不入账，免得整条线程再加一遍",
        });
      }
      continue;
    }

    const series = pre.map((entry) => entry.usage);
    const startedAt = members.map((member) => member.startedAt).sort()[0]!;
    const monotonic = monotonicUsage(series);
    let regime: ClaudeSessionPlan["regime"];
    let evidence: ClaudeSessionPlan["evidence"];
    if (pre.length <= 1) {
      // 一条就是一条：累计口径下它是线程的第一份快照，增量口径下它是本轮用量，数值相同。
      regime = "cumulative";
      evidence = "single-turn";
    } else if (pre.length >= STRONG_EVIDENCE_TURNS) {
      regime = monotonic ? "cumulative" : "incremental";
      evidence = "strong";
    } else if (clean && firstCumulative) {
      regime = startedAt >= firstCumulative ? "cumulative" : "incremental";
      evidence = "weak-date";
    } else {
      regime = monotonic ? "cumulative" : "incremental";
      evidence = "weak-monotonic";
    }

    // 累计口径：pre 按线程求差；post 原则上已经是增量，原样计入。
    const booked = new Map<string, TokenUsage>();
    const add = (sessionId: string, usage: TokenUsage) => {
      booked.set(sessionId, booked.has(sessionId) ? addUsage(booked.get(sessionId)!, usage) : usage);
    };
    let wholeSnapshotAfterCutoff = false;
    if (regime === "cumulative") {
      let previous: TokenUsage | null = null;
      for (const entry of pre) {
        add(entry.sessionId, cumulativeUsageDelta(entry.usage, previous));
        previous = entry.usage;
      }
      // **「先重启、后回填」会留下的那一轮**：改口径之后这条线程的第一回合，快照还没建
      // 起来，修好的代码照样会把整份累计值当成增量记一次（几千万，不是几十万）。它在
      // trace 里就是一份完整累计快照 —— 跟上一份一比，五项全不降就认得出来，顺手补掉。
      //
      // 只可能是 post 的**第一条**：从第二条起快照已经在了，运行期自己就求差了。真·增量
      // 跟那份累计值差着几十倍，比不过这一关，所以不会误伤。
      for (const [index, entry] of post.entries()) {
        const whole = index === 0 && !!previous && nonDecreasing(previous, entry.usage);
        if (whole) wholeSnapshotAfterCutoff = true;
        add(entry.sessionId, whole ? cumulativeUsageDelta(entry.usage, previous) : { ...entry.usage, turns: 1 });
        if (whole) previous = entry.usage;
      }
    } else {
      for (const entry of [...pre, ...post]) add(entry.sessionId, { ...entry.usage, turns: 1 });
    }

    for (const member of members) {
      const after = booked.get(member.sessionId) ?? null;
      sessionPlans.push({
        ...base,
        sessionId: member.sessionId,
        taskId: member.taskId,
        startedAt: member.startedAt,
        turns: member.turns,
        before: member.before,
        after: after && !sameUsage(member.before, after) ? after : null,
        regime,
        evidence,
        rebasedFirstTurnAfterCutoff: wholeSnapshotAfterCutoff,
        skipped: null,
      });
    }

    if (existingSnapshots.has(sourceId) || post.length > 0) continue; // 这条线程的快照归运行期维护
    if (regime === "cumulative") {
      const last = series.at(-1);
      if (last) {
        snapshots.push({
          sourceId,
          usage: last,
          baselineReady: true,
          reason: "续聊这条线程时按这份累计快照求差",
        });
      }
    } else {
      snapshots.push({
        sourceId,
        usage: null,
        baselineReady: false,
        reason: "这条线程的历史数字是逐轮增量，拼不出累计基线；今天续聊它的新 CLI 报的是累计值，"
          + "所以留待建基线而不是猜一个",
      });
    }
  }

  for (const orphan of orphans) {
    sessionPlans.push({
      sessionId: orphan.sessionId,
      taskId: orphan.taskId,
      cliSessionId: null,
      startedAt: orphan.startedAt,
      turns: orphan.turns,
      before: orphan.before,
      after: null,
      regime: "unknown",
      evidence: "none",
      straddlesCutoff: false,
      rebasedFirstTurnAfterCutoff: false,
      skipped: "会话行没有 cli_session_id，归不到线程，求差会把别人的账算进来",
    });
  }

  sessionPlans.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { cutoff, boundary: { lastIncremental, firstCumulative, clean }, sessions: sessionPlans, snapshots, warnings };
}

function sameUsage(before: TokenUsage | null, after: TokenUsage): boolean {
  if (!before) return false;
  return TOKEN_KEYS.every((key) => before[key] === Math.round(after[key]))
    && before.turns === Math.max(1, Math.round(after.turns))
    && (before.costUsd ?? null) === (after.costUsd ?? null);
}

export async function applyClaudeUsageRepair(
  plan: ClaudeUsageRepairPlan,
): Promise<{ sessions: number; snapshots: number }> {
  const changes = plan.sessions.filter((item) => item.after);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const item of changes) {
      const usage = item.after!;
      await tx.update(sessions).set({
        usageInput: Math.round(usage.input),
        usageOutput: Math.round(usage.output),
        usageCacheRead: Math.round(usage.cacheRead),
        usageCacheWrite: Math.round(usage.cacheWrite),
        usageReasoning: Math.round(usage.reasoning),
        usageCostUsd: usage.costUsd,
        usageTurns: Math.max(1, Math.round(usage.turns)),
      }).where(eq(sessions.id, item.sessionId));
    }
    for (const snapshot of plan.snapshots) {
      const usage = snapshot.usage ?? ZERO;
      // onConflictDoNothing：运行期已经建过快照的线程归运行期，这里绝不覆盖。
      await tx.insert(usageCumulativeSnapshots).values({
        sourceId: snapshot.sourceId,
        input: Math.round(usage.input),
        output: Math.round(usage.output),
        cacheRead: Math.round(usage.cacheRead),
        cacheWrite: Math.round(usage.cacheWrite),
        reasoning: Math.round(usage.reasoning),
        costUsd: snapshot.usage ? usage.costUsd : null,
        baselineReady: snapshot.baselineReady,
        updatedAt: now,
      }).onConflictDoNothing();
    }
    await tx.insert(appSettings).values({
      key: CLAUDE_REPAIR_MARKER,
      value: JSON.stringify({
        repairedAt: now,
        cutoff: plan.cutoff,
        sessions: changes.length,
        snapshots: plan.snapshots.length,
      }),
    }).onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: JSON.stringify({
          repairedAt: now,
          cutoff: plan.cutoff,
          sessions: changes.length,
          snapshots: plan.snapshots.length,
        }),
      },
    });
  });
  return { sessions: changes.length, snapshots: plan.snapshots.length };
}
