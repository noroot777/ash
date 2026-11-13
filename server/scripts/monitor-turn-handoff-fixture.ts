// test-monitor-turn-handoff.ts 与 test-monitor-merge-window.ts 共用的台子:一条正在跑的执行回合、
// 排在托盘里的哨兵结果、生产路由,以及站进「读完、还没写」那条缝的注入。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { appendMonitorWake } from "@ash/shared/monitor-wake";
import { db, makeTask, monitors, now, pending, root, runs, scheduledMessages, sessions, tasks } from "./monitors-fixture.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";
import { mountTaskRunRoutes } from "../src/task-run-routes.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "../src/transcript.js";
import { id } from "../src/util.js";

export type Row = typeof scheduledMessages.$inferSelect;
export const log = join(root, "turn-handoff-input.log");
process.env.PATH = `${installFakeClaude(root)}${delimiter}${process.env.PATH ?? ""}`;
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = log;

export const api = new Hono();
mountTaskRunRoutes(api);
/** 默认按 ash 的 MCP 那样声明「我会确认」(`monitorAck`);要演不声明的调用方就显式传 false。 */
export const post = (path: string, token: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  api.request(path, {
    method: "POST", headers: { "content-type": "application/json", "x-ash-turn-token": token, ...headers },
    body: JSON.stringify({ monitorAck: true, ...body }),
  });
/**
 * 在生产代码某一次 `db.select(<投影>).from(<表>)` 出结果之后先做一件事(可以抛错、可以改库),
 * 用来站进「读完、还没写」那条缝里。`pick` 按投影认是哪一次;返回撤掉这层的函数。
 */
export function onSelect(
  table: unknown, pick: (projection: Record<string, unknown> | undefined) => boolean,
  act: (rows: unknown[]) => Promise<unknown[]>,
): () => void {
  const original = db.select.bind(db);
  (db as { select: unknown }).select = (...args: unknown[]) => {
    const query = (original as (...a: unknown[]) => { from: (t: unknown) => unknown })(...args);
    const from = query.from.bind(query);
    query.from = (t: unknown) => {
      const builder = from(t) as { then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise<unknown> };
      if (t !== table || !pick(args[0] as Record<string, unknown> | undefined)) return builder;
      const then = builder.then.bind(builder);
      builder.then = (ok, ko) => then((rows) => act(rows as unknown[])).then(ok, ko);
      return builder;
    };
    return query;
  };
  return () => { (db as { select: unknown }).select = original; };
}
export const rowOf = async (messageId: string) =>
  (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, messageId))).at(0)!;
export const taskOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一条正在跑的执行回合:回合锁 + 令牌落库并绑上 + 一条会话(时间线落在它上面)。 */
export async function liveTurn(opts: {
  role?: string; review?: { run: string; round: number }; agentType?: string; token?: string;
} = {}) {
  const taskId = await makeTask();
  const owner = runs.claimOwnTurn(taskId, opts.role ?? "single", opts.review ?? null);
  assert.ok(owner, "占得到回合");
  const token = opts.token ?? `turn-${id()}`;
  await db.update(tasks).set({ activeTurnToken: token }).where(eq(tasks.id, taskId));
  runs.bindTurnToken(taskId, token);
  const sessionId = `s-${id()}`;
  await db.insert(sessions).values({
    id: sessionId, taskId, role: "single", agentType: opts.agentType ?? "claude", executor: opts.agentType ?? "claude",
    cwd: root, startedAt: now(), turnStartedAt: now(),
  });
  return { taskId, token, owner: owner!, sessionId };
}

/** 一条哨兵 + 它排在托盘里的一条结果(形状跟 `mergeOrEnqueueMonitorEvent` 新建那一支一致)。 */
export async function queuedResult(taskId: string, text: string, opts: {
  kind?: "output" | "ended"; reviewer?: { run: string; round: number };
} = {}): Promise<Row & { monitorId: string }> {
  const monitorId = id();
  await db.insert(monitors).values({
    id: monitorId, taskId, command: "fixture", description: `desc-${text}`, cwd: root, status: "exited",
    logPath: join(root, `${monitorId}.log`), startedAt: now(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    sourceRole: opts.reviewer ? "reviewer" : "single",
    sourceReviewRun: opts.reviewer?.run ?? null, sourceReviewRound: opts.reviewer?.round ?? null,
  });
  const message = pending.pendingMessageRow({
    taskId, text, origin: `monitor:${monitorId}`,
    turnSource: opts.reviewer ? { role: "reviewer", review: opts.reviewer } : { role: "single" },
    monitorWake: appendMonitorWake(null, { kind: opts.kind ?? "ended", monitorId, source: `desc-${text}`, body: text }),
  });
  await db.insert(scheduledMessages).values(message);
  return { ...message, monitorId };
}

/** 会话转录里认得出来的那几条带类型的旁注。 */
export function notices(taskId: string, sessionId: string): Array<{ kind: string; [key: string]: unknown }> {
  const path = sessionTranscriptPath(taskId, sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith(TURN_SENTINEL))
    .map((line) => JSON.parse(line.slice(TURN_SENTINEL.length)) as { notice?: { kind: string } })
    .flatMap((turn) => turn.notice ? [turn.notice] : []);
}
