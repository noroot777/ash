// v1 把每条 usage 都当成单轮增量；Codex 实际报的是线程累计快照，于是续聊会重复
// 计费。这里在升级启动时用已经落盘的逐轮 trace 重建一次：Codex 对同一 CLI 线程
// 求差，Claude 继续逐轮相加。只有 trace 条数与数据库轮数完全吻合才动原账。
import { readFileSync } from "node:fs";
import { eq, isNotNull } from "drizzle-orm";
import type { TokenUsage } from "@ash/shared";
import { addUsage, sumUsage } from "@ash/shared/usage";
import { db } from "./db/index.js";
import { appSettings, sessions, usageCumulativeSnapshots } from "./db/schema.js";
import { readableRunPath, parseSessionTrace, sessionTracePath } from "./transcript.js";
import { cumulativeUsageDelta } from "./usage.js";

// v3 在 v2 的正确历史重算之外，还给“不完整、无法重算”的 Codex 线程写待建基线。
// 换 key 是为了已经跑过 v2 的实例也会执行这次补救。
const REPAIR_KEY = "internal.usage-accounting-v3";

type UsageEntry = { at: string; usage: TokenUsage };
type Candidate = {
  id: string;
  taskId: string;
  agentType: string;
  cliSessionId: string | null;
  expectedTurns: number;
  entries: UsageEntry[] | null;
};

const sourceId = (cliSessionId: string) => `codex:${cliSessionId}`;

function readUsageEntries(taskId: string, sessionId: string): UsageEntry[] | null {
  try {
    const raw = readFileSync(readableRunPath(sessionTracePath(taskId, sessionId)), "utf8");
    return parseSessionTrace(raw)
      .filter((entry) => entry.event.kind === "usage")
      .map((entry) => ({ at: entry.at, usage: (entry.event as { kind: "usage"; usage: TokenUsage }).usage }));
  } catch {
    return null;
  }
}

export async function repairLegacyUsageAccounting(): Promise<{
  alreadyApplied: boolean;
  repairedCodexSessions: number;
  repairedClaudeSessions: number;
  skippedSessions: number;
}> {
  const marker = await db.select({ value: appSettings.value }).from(appSettings)
    .where(eq(appSettings.key, REPAIR_KEY)).get();
  if (marker) {
    return { alreadyApplied: true, repairedCodexSessions: 0, repairedClaudeSessions: 0, skippedSessions: 0 };
  }

  const rows = await db.select({
    id: sessions.id,
    taskId: sessions.taskId,
    agentType: sessions.agentType,
    cliSessionId: sessions.cliSessionId,
    usageTurns: sessions.usageTurns,
  }).from(sessions).where(isNotNull(sessions.usageTurns));
  const candidates: Candidate[] = rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    agentType: row.agentType,
    cliSessionId: row.cliSessionId,
    expectedTurns: row.usageTurns ?? 0,
    entries: readUsageEntries(row.taskId, row.id),
  }));

  const totals = new Map<string, TokenUsage>();
  const finalSnapshots = new Map<string, TokenUsage>();
  const pendingSnapshots = new Set<string>();
  const repaired = new Set<string>();

  for (const row of candidates.filter((item) => item.agentType === "claude")) {
    if (!row.entries || row.entries.length !== row.expectedTurns) continue;
    const total = sumUsage(row.entries.map((entry) => entry.usage));
    if (!total) continue;
    totals.set(row.id, total);
    repaired.add(row.id);
  }

  const codexGroups = new Map<string, Candidate[]>();
  for (const row of candidates.filter((item) => item.agentType === "codex" && item.cliSessionId)) {
    const key = sourceId(row.cliSessionId!);
    codexGroups.set(key, [...(codexGroups.get(key) ?? []), row]);
  }
  for (const [key, group] of codexGroups) {
    if (group.some((row) => !row.entries || row.entries.length !== row.expectedTurns)) {
      pendingSnapshots.add(key);
      continue;
    }
    const events = group.flatMap((row) => row.entries!.map((entry) => ({ ...entry, rowId: row.id })))
      .sort((a, b) => a.at.localeCompare(b.at));
    let previous: TokenUsage | null = null;
    for (const event of events) {
      const delta = cumulativeUsageDelta(event.usage, previous);
      totals.set(event.rowId, totals.has(event.rowId) ? addUsage(totals.get(event.rowId)!, delta) : delta);
      previous = event.usage;
      repaired.add(event.rowId);
    }
    if (previous) finalSnapshots.set(key, previous);
  }

  await db.transaction(async (tx) => {
    for (const [sessionId, usage] of totals) {
      await tx.update(sessions).set({
        usageInput: Math.round(usage.input),
        usageOutput: Math.round(usage.output),
        usageCacheRead: Math.round(usage.cacheRead),
        usageCacheWrite: Math.round(usage.cacheWrite),
        usageReasoning: Math.round(usage.reasoning),
        usageCostUsd: usage.costUsd,
        usageTurns: Math.max(1, Math.round(usage.turns)),
      }).where(eq(sessions.id, sessionId));
    }
    for (const [key, usage] of finalSnapshots) {
      const values = {
        input: Math.round(usage.input),
        output: Math.round(usage.output),
        cacheRead: Math.round(usage.cacheRead),
        cacheWrite: Math.round(usage.cacheWrite),
        reasoning: Math.round(usage.reasoning),
        costUsd: usage.costUsd,
        baselineReady: true,
        updatedAt: new Date().toISOString(),
      };
      await tx.insert(usageCumulativeSnapshots).values({ sourceId: key, ...values }).onConflictDoUpdate({
        target: usageCumulativeSnapshots.sourceId,
        set: values,
      });
    }
    for (const key of pendingSnapshots) {
      await tx.insert(usageCumulativeSnapshots).values({
        sourceId: key,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        costUsd: null,
        baselineReady: false,
        updatedAt: new Date().toISOString(),
      }).onConflictDoNothing();
    }
    await tx.insert(appSettings).values({
      key: REPAIR_KEY,
      value: JSON.stringify({ repairedAt: new Date().toISOString(), sessions: repaired.size }),
    }).onConflictDoNothing();
  });

  return {
    alreadyApplied: false,
    repairedCodexSessions: candidates.filter((row) => row.agentType === "codex" && repaired.has(row.id)).length,
    repairedClaudeSessions: candidates.filter((row) => row.agentType === "claude" && repaired.has(row.id)).length,
    skippedSessions: candidates.length - repaired.size,
  };
}
