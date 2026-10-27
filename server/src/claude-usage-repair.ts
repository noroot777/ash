// claude 账本的一次性历史回填。
//
// 起因见 usage.ts 的文件头：claude 的 `result` 其实是**整条 CLI 线程的累计快照**，而
// v1~v3 的账本按「本轮增量」逐轮相加，于是 resume 第 N 回合把前 N 回合的总和又加了
// 一遍。这里从每条会话落盘的 trace 把原始 `result` 序列读回来，按线程求差重算
// `sessions.usage_*`，并把 trace 里那几条 usage 事件一并改写成真实增量（见
// claude-usage-trace.ts：不改写的话气泡上的「本轮」永远是累计值）。
//
// **跟 usage-repair.ts 的两点不同，都是故意的**：
// ① 那一份挂在启动流程上、靠 app_settings 的 key 保证只跑一次；这一份**只能手工跑**
//    （scripts/repair-claude-usage.ts），默认 dry-run，apply 还要显式指定库文件。改几亿
//    token 的账是不可逆的，必须先在拷贝上看前后对照。
// ② 那一份只重算 codex；这一份反过来只动 claude，codex 一行不碰。
//
// 为什么读 trace 而不读 `data/runs/**/*.agent-out.jsonl`：原始 stdout 由 run-logs-gc.ts
// 默认 24 小时回收（实测 498 条 claude 会话只剩 21 条还有 agent-out），而 trace 是耐久
// 记录，且逐字保存了同一批 `result` 数字（两条样本会话 46/46、16/16 完全吻合）。
//
// ── 判口径的两条规矩（第 1 轮审查打回后重写）──────────────────────────────────
// ① **「哪些条目是旧账」只看逐条的 `accounting` 标记，不按时间切。** 上一版用
//    `usage_cumulative_snapshots.updated_at` 的最小值当分界，而那一列每回合都被覆盖：
//    重启续聊之后分界会往后漂，已经归一的新记录被塞回旧记录堆里，整条线程于是被判成
//    「本来就是逐轮增量」而原样留着虚高的账（审查实测 108,648,684 vs 正确的 28,486,599）。
//    现在改口径之后写下的每条 usage 都带 delta / snapshot 标记（见 shared 的
//    UsageAccountingMark），旧账天然没有这两种标记，分界因此是逐条的、不可变的。
// ② **旧账本身的口径要两个独立信号一致才敢改，不一致就明确跳过。** 形状（整串不降）
//    单独不算证据：累计序列中途重置也会出现下降，而真·增量序列偶然全升也会被误判成
//    累计（n=2 时实测 6/45）。所以形状必须和日期界（CLI_CUMULATIVE_SINCE）对上。
import { and, eq, isNotNull, like } from "drizzle-orm";
import type { TokenUsage, UsageAccountingMark } from "@ash/shared";
import { addUsage } from "@ash/shared/usage";
import { db } from "./db/index.js";
import { appSettings, sessions, usageCumulativeSnapshots } from "./db/schema.js";
import {
  type SessionTraceRewrite,
  type TraceRewriteResult,
  applyTraceRewrites,
  isLegacyMark,
  readUsageTrace,
} from "./claude-usage-trace.js";
import { cumulativeUsageDelta, sessionUsage } from "./usage.js";

export const CLAUDE_REPAIR_MARKER = "internal.claude-usage-cumulative-repair";

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;

/**
 * claude CLI 把 `result` 从「本次进程内的用量」改成「整条线程的累计」的那次升级。
 *
 * **这是个常量而不是从库里推的量**，因为它是外部工具的版本史，过去就不会再变 ——
 * 上一版从库里推分界，结果推的是一列会被覆盖的时间戳，分界会随续聊往后漂。
 *
 * 实测（用户正式库，2026-10-27）：最后一条逐轮增量的多轮会话起于
 * 2026-09-27T23:27:34.156Z，最早一条线程累计的起于 2026-09-28T07:27:22.458Z，中间没有
 * 交错；210 条「形状足够强」的会话里，形状判定与这条日期界**零分歧**。取两者之间。
 *
 * 别的机器上那次升级可能落在别的时刻（例如那台 Windows 真机），所以 CLI 留了
 * `--boundary <iso>` 可以覆盖；覆盖之后下面那条交叉核对照样会报出分歧。
 */
export const CLI_CUMULATIVE_SINCE = "2026-09-28T00:00:00.000Z";

/** 判「形状足够强」的下限：4 条 = 3 次相邻比较。 */
const STRONG_EVIDENCE_TURNS = 4;

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 };

export type SessionRegime = "cumulative" | "incremental" | "uncertain" | "unreadable";
export type RegimeEvidence =
  /** 形状和日期界一致，且旧账够 4 条。 */
  | "strong"
  /** 两个信号一致，但旧账只有 2~3 条。 */
  | "weak-agreed"
  /** 旧账只有一条：两种口径同值，无须判。 */
  | "single-turn"
  /** 一条旧账都没有：这条线程的条目全是修好之后结算过的。 */
  | "settled"
  | "none";

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
  regime: SessionRegime;
  evidence: RegimeEvidence;
  /** 这条线程既有旧账条目、也有改口径之后结算过的条目。 */
  straddlesCutoff: boolean;
  /**
   * 改口径之后那条线程的第一回合把整份累计值记成了增量（当时快照还没建起来，落盘标记
   * 是 `snapshot`），这次顺手补掉。按推荐顺序（先停服务、先回填、再重启）则一条都不会有。
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
  /** 判「旧账」用的日期界（CLI 升级时刻）。 */
  boundary: string;
  /** 从库里反推的分界，只用来跟 boundary 交叉核对。 */
  observed: { lastIncremental: string | null; firstCumulative: string | null };
  sessions: ClaudeSessionPlan[];
  snapshots: ClaudeSnapshotPlan[];
  /** trace 里要改写成真实增量的那些 usage 条目。 */
  traces: SessionTraceRewrite[];
  warnings: string[];
};

const nonDecreasing = (previous: TokenUsage, current: TokenUsage) =>
  TOKEN_KEYS.every((key) => current[key] >= previous[key]);

/** 整串都不下降 —— 累计快照的特征。 */
export function monotonicUsage(series: readonly TokenUsage[]): boolean {
  return series.every((usage, index) => index === 0 || nonDecreasing(series[index - 1]!, usage));
}

/**
 * 形状这一路的读数。**它只有三种结果，第三种是「说不出」** —— 上一版只有两种（不降
 * 就是累计、否则就是增量），于是一条中途重置过计数器的累计线程被当成铁证判成增量，
 * 账原样留着虚高（审查实测 67,418,690 vs 正确的 34,528,914）。
 *
 * - 一次都不降 → 累计的形状（增量序列要恰好一路不降才会这样，n 越大越不可能）。
 * - 相邻比较里**一半以上**在降 → 增量的形状（累计序列只在重置那一下降，不可能隔一轮降一次）。
 * - 中间那一带（降过但没降到一半）→ **说不出**：既可能是中途重置过的累计，也可能是
 *   碰巧大多在升的增量，还可能是会话中途换过线程。
 */
export function shapeRegime(series: readonly TokenUsage[]): "cumulative" | "incremental" | null {
  if (series.length < 2) return null;
  const comparisons = series.length - 1;
  let drops = 0;
  for (let index = 1; index < series.length; index += 1) {
    if (!nonDecreasing(series[index - 1]!, series[index]!)) drops += 1;
  }
  if (drops === 0) return "cumulative";
  return drops >= Math.ceil(comparisons / 2) ? "incremental" : null;
}

type Candidate = {
  sessionId: string;
  taskId: string;
  cliSessionId: string | null;
  startedAt: string;
  turns: number;
  before: TokenUsage | null;
  entries: ReturnType<typeof readUsageTrace>;
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

export async function planClaudeUsageRepair(options: {
  /** 覆盖 CLI 升级时刻（别的机器上升级得早或晚）。 */
  boundary?: string;
} = {}): Promise<ClaudeUsageRepairPlan> {
  const boundary = options.boundary ?? CLI_CUMULATIVE_SINCE;
  const candidates = await loadCandidates();
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

  const sessionPlans: ClaudeSessionPlan[] = [];
  const snapshots: ClaudeSnapshotPlan[] = [];
  const traces: SessionTraceRewrite[] = [];
  const warnings: string[] = [];
  const observedIncremental: string[] = [];
  const observedCumulative: string[] = [];

  for (const [cliSessionId, members] of groups) {
    const sourceId = `claude:${cliSessionId}`;
    const startedAt = members.map((member) => member.startedAt).sort()[0]!;
    const complete = members.every((member) => member.entries && member.entries.length === member.turns);
    const entries = members.flatMap((member) => member.entries ?? [])
      .sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
    const legacy = entries.filter((entry) => isLegacyMark(entry.mark));
    const settled = entries.length - legacy.length;
    const base = { cliSessionId, straddlesCutoff: legacy.length > 0 && settled > 0 };

    // ── 这条线程的历史重算不了：trace 对不上库里的回合数，或者读不到 ────────────
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
          regime: "unreadable",
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

    // ── 判旧账的口径：形状和日期界必须对上 ──────────────────────────────────────
    const series = legacy.map((entry) => entry.usage);
    const shape = shapeRegime(series);
    const byDate = startedAt >= boundary ? "cumulative" : "incremental";
    let regime: SessionRegime;
    let evidence: RegimeEvidence;
    let undecided: string | null = null;
    if (legacy.length === 0) {
      // 整条线程都是修好之后结算过的条目，没有旧账要判。
      regime = "cumulative";
      evidence = "settled";
    } else if (legacy.length === 1) {
      // 一条就是一条：累计口径下它是线程的第一份快照，增量口径下它是本轮用量，数值相同。
      regime = "cumulative";
      evidence = "single-turn";
    } else if (shape === null) {
      regime = "uncertain";
      evidence = "none";
      undecided = `${legacy.length} 条旧账里有下降但不到一半，形状判不出是「中途重置过的累计」`
        + `还是「碰巧多在上升的增量」，也可能是会话中途换过线程；日期界指向 ${byDate}，`
        + "单凭一个信号不改账";
    } else if (shape !== byDate) {
      regime = "uncertain";
      evidence = "none";
      undecided = `形状指向 ${shape}、日期界（${boundary}，本线程起于 ${startedAt}）指向 ${byDate}，`
        + "两个信号不一致，不改账";
    } else {
      regime = shape;
      evidence = legacy.length >= STRONG_EVIDENCE_TURNS ? "strong" : "weak-agreed";
      if (evidence === "strong") (shape === "cumulative" ? observedCumulative : observedIncremental).push(startedAt);
    }

    // ── 重算 ────────────────────────────────────────────────────────────────────
    const booked = new Map<string, TokenUsage>();
    const add = (sessionId: string, usage: TokenUsage) => {
      booked.set(sessionId, booked.has(sessionId) ? addUsage(booked.get(sessionId)!, usage) : usage);
    };
    const edits = new Map<string, SessionTraceRewrite>();
    const edit = (entry: (typeof entries)[number], usage: TokenUsage, mark: UsageAccountingMark) => {
      const member = members.find((item) => item.sessionId === entry.sessionId)!;
      const key = entry.sessionId;
      const rewrite = edits.get(key)
        ?? { taskId: member.taskId, sessionId: key, cliSessionId, edits: [] };
      rewrite.edits.push({ index: entry.index, usage, accounting: mark });
      edits.set(key, rewrite);
    };

    let rebased = false;
    if (regime === "uncertain" || regime === "incremental") {
      // 不动账：旧账在增量口径下本来就是逐轮相加（跟库里现在的数一致），不确定的更不该动。
      for (const entry of entries) add(entry.sessionId, { ...entry.usage, turns: 1 });
    } else {
      let previous: TokenUsage | null = null;
      for (const entry of entries) {
        if (isLegacyMark(entry.mark)) {
          const delta = cumulativeUsageDelta(entry.usage, previous);
          add(entry.sessionId, delta);
          // trace 里存的是累计值，改写成这一轮真实的增量（气泡上的「本轮」直接读它）。
          edit(entry, delta, "delta");
          previous = entry.usage;
          continue;
        }
        if (entry.mark === "snapshot" && previous) {
          // **「先重启、后回填」留下的那一轮**：改口径之后这条线程的第一回合还没有基线，
          // 运行期把整份累计值当增量记了一次。认它凭的是**落盘标记**（只有「累计口径 +
          // 没有基线」才会写 snapshot），不是数值大小 —— 上一版拿「五项全不降」当判据，
          // 会把一个真·大增量（已经归一过的 delta）又减一次，把对的账改错。
          const delta = cumulativeUsageDelta(entry.usage, previous);
          add(entry.sessionId, delta);
          edit(entry, delta, "delta");
          previous = entry.usage;
          rebased = true;
          continue;
        }
        // delta：运行期已按累计口径结算过，原样计入；snapshot 但前面没有旧账 = 真·新线程
        // 的第一轮，整份就是它该记的那一份。
        add(entry.sessionId, { ...entry.usage, turns: 1 });
      }
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
        rebasedFirstTurnAfterCutoff: rebased,
        skipped: undecided,
      });
    }
    traces.push(...edits.values());

    if (existingSnapshots.has(sourceId) || settled > 0) continue; // 这条线程的快照归运行期维护
    if (regime === "cumulative" && series.length > 0) {
      snapshots.push({
        sourceId,
        usage: series.at(-1)!,
        baselineReady: true,
        reason: "续聊这条线程时按这份累计快照求差",
      });
    } else {
      snapshots.push({
        sourceId,
        usage: null,
        baselineReady: false,
        reason: regime === "uncertain"
          ? "口径判不出，拼不出可信的累计基线；留待建基线，免得续聊时整条线程再加一遍"
          : "这条线程的历史数字是逐轮增量，拼不出累计基线；今天续聊它的新 CLI 报的是累计值，"
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
      regime: "unreadable",
      evidence: "none",
      straddlesCutoff: false,
      rebasedFirstTurnAfterCutoff: false,
      skipped: "会话行没有 cli_session_id，归不到线程，求差会把别人的账算进来",
    });
  }

  // 交叉核对：常量边界跟这个库里实际观察到的强证据有没有矛盾。只报不改 —— 常量是实测
  // 出来的事实，真对不上也该是人来看一眼，不是代码自己挪分界。
  const lastIncremental = observedIncremental.sort().at(-1) ?? null;
  const firstCumulative = observedCumulative.sort().at(0) ?? null;
  if (lastIncremental && lastIncremental >= boundary) {
    warnings.push(`有强证据判成「逐轮增量」的线程起于 ${lastIncremental}，已经在日期界 ${boundary} 之后；`
      + "要么这台机器的 CLI 升级时刻不同（用 --boundary 指定），要么那条线程的形状判错了。");
  }
  if (firstCumulative && firstCumulative < boundary) {
    warnings.push(`有强证据判成「线程累计」的线程起于 ${firstCumulative}，早于日期界 ${boundary}；`
      + "同上，先用 --boundary 校准再回填。");
  }

  sessionPlans.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return {
    boundary,
    observed: { lastIncremental, firstCumulative },
    sessions: sessionPlans,
    snapshots,
    traces,
    warnings,
  };
}

function sameUsage(before: TokenUsage | null, after: TokenUsage): boolean {
  if (!before) return false;
  return TOKEN_KEYS.every((key) => before[key] === Math.round(after[key]))
    && before.turns === Math.max(1, Math.round(after.turns))
    && (before.costUsd ?? null) === (after.costUsd ?? null);
}

/**
 * 落地。**顺序是「先改 trace，再按线程整组落账」**，不能反过来：
 *
 * 账和 trace 必须一起对。先落账再改 trace，万一某份 trace 改不了，就留下「账已经是真实
 * 增量、trace 里还是累计值」的半成品 —— 下一次回填会把那半截累计值重新求一遍差（它的
 * 上一份基线已经没了），越修越歪；启动迁移 v3 当年那条 claude 分支也会按累计值重新求和
 * 把账吹回去。所以这里让 trace 当**闸**：哪条 CLI 线程的 trace 没全改成，那条线程的账
 * 这一轮就不动，如实报出来，人看过再重跑。
 */
export async function applyClaudeUsageRepair(
  plan: ClaudeUsageRepairPlan,
  options: { rewriteTraces?: boolean } = {},
): Promise<{ sessions: number; snapshots: number; traces: TraceRewriteResult }> {
  const traces = options.rewriteTraces === false
    ? { files: 0, entries: 0, failures: [], failedThreads: new Set<string>() }
    : applyTraceRewrites(plan.traces);
  const changes = plan.sessions.filter((item) =>
    item.after && !(item.cliSessionId && traces.failedThreads.has(item.cliSessionId)));
  const now = new Date().toISOString();
  const summary = {
    repairedAt: now,
    boundary: plan.boundary,
    sessions: changes.length,
    snapshots: plan.snapshots.length,
    traces: traces.files,
  };
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
    await tx.insert(appSettings).values({ key: CLAUDE_REPAIR_MARKER, value: JSON.stringify(summary) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(summary) } });
  });
  return { sessions: changes.length, snapshots: plan.snapshots.length, traces };
}
