// 哨兵回归的共用台子：一份临时库、真模块、几个小工具。
//
// 为什么单独一份：哨兵的回归已经分成两份——「这个功能本身对不对」(test-monitors.ts)
// 和「终态与投递抢同一条命的那几个窗口」(test-monitor-races.ts)。台子只能有一份，
// 两边各抄一遍迟早漂移（漂的那一刻两份测试对「任务一开始是什么状态」的理解就分家了）。
//
// **导入它就等于把台子搭起来**：`ASH_DB` / `ASH_RUNS_DIR` 在模块顶层就落定，所以它必须
// 排在任何 `src/` 模块之前被导入——下面那串动态 import 就是为此。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const root = mkdtempSync(join(tmpdir(), "ash-monitors-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitors");

export const [
  { db, ensureSchema }, schema, monitorsModule, createModule, monitorEvents, status, { isPidAlive }, pending,
  { continueTask }, runs, taskRoutes, { stopAllMonitorRecovery }, { inspectProcess },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/monitors.js"),
  import("../src/monitor-create.js"),
  import("../src/monitor-events.js"),
  import("../src/status.js"),
  import("../src/platform.js"),
  import("../src/pending-messages.js"),
  import("../src/orchestrator.js"),
  import("../src/runs.js"),
  import("../src/task-routes.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/proc.js"),
]);
export const { mountTaskRoutes } = taskRoutes;
export const { stopMonitor, listMonitors, getMonitor, readMonitorTail, reattachMonitors, detachAllMonitors } =
  monitorsModule;

/**
 * `startMonitor` 的台子版:**来源缺省当「人在界面上点的」**(`external`)。
 *
 * 真入口的 `caller` 是必填的(创建契约要携带可信来源,见 monitor-session.ts),这里给一个
 * 缺省只是为了让几十个不关心来源的用例不必各写一遍。要测来源归属的用例**必须自己显式传**
 * —— 例如 `caller: { kind: "turn" }` 配 `claimTurn(taskId, "reviewer")`(审查回合里挂的),
 * 或 `{ kind: "unverified" }`(回连凭据对不上)。
 */
type StartInput = Parameters<typeof createModule.startMonitor>[0];
export const startMonitor = (input: Omit<StartInput, "caller"> & { caller?: StartInput["caller"] }) =>
  createModule.startMonitor({ ...input, caller: input.caller ?? { kind: "external" } });
export const { monitors, projects, scheduledMessages, sessions, tasks } = schema;

const monitorSession = await import("../src/monitor-session.js");

/**
 * 「这次调用来自本任务当前这一回合」的那一份 caller —— 真入口交上来的就是这种形状:带着
 * **这一轮的身份**(令牌 + 角色 + 它为哪一次审查而起),落库处还会核对一遍它仍然有效
 * (见 monitor-session.ts 的 `VerifiedTurn`)。
 *
 * 用法跟生产对齐,两步:
 *  ① 调用方先占回合 —— `runs.claimTurn(taskId, 角色, 审查来源)`。**审查来源由占位方交代**
 *    (生产里是 free-review-round 的 `reviewSource`):要测 reviewer 来源就得
 *    `reviewInFlight(...)` 摆一次审查,再把 `{ run, round }` 交进 claim。没有审查的
 *    reviewer 回合是**拒**(第 9 轮审查 F1),绑不上审查代次的 reviewer 回合也是拒;
 *  ② 这里把令牌同时落库、绑到那一份回合身份上 —— 跟 orchestrator 写
 *    `active_turn_token` 的同一处调 `bindTurnToken` 一个意思(第 10 轮审查 F1)。
 */
export async function inTurnCaller(taskId: string, token = `turn-${taskId}`) {
  await db.update(tasks).set({ activeTurnToken: token }).where(eq(tasks.id, taskId));
  runs.bindTurnToken(taskId, token);
  return monitorSession.turnCaller(monitorSession.verifiedTurn(taskId, token));
}

await ensureSchema();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(100);
  }
  throw new Error(`等不到：${label}`);
}

export const now = () => new Date().toISOString();
let seq = 0;
/** 给同一个任务里要手写 id 的那几行用（真人排的那条消息），保证不撞。 */
export const uniq = (prefix: string) => `${prefix}-${seq}-${Date.now()}`;

/**
 * 一个真任务。默认是**正在跑的单飞任务**：投递链路对「单飞任务正在跑」的判定是**等**，
 * 于是事件只排队、不会真去 spawn 一个 agent —— 这正是这两份测试要观察的那个现场
 * （忙的时候攒事件）。
 *
 * 团队那条路要显式传 `{ mode: "team", status: "idle" }`：常驻调度台**正在说话时也接得住**
 * （`deliveryVerdict` 对 team 不等空闲），所以它走的是完全另一条投递分支。
 */
export async function makeTask(opts: { mode?: string; status?: string } = {}): Promise<string> {
  const projectId = `proj-${++seq}`;
  const taskId = `task-${seq}`;
  await db.insert(projects).values({ id: projectId, name: "monitors", repoPath: root, createdAt: now() });
  await db.insert(tasks).values({
    id: taskId, projectId, title: `t${seq}`, body: "", status: opts.status ?? "running",
    agentType: "claude", mode: opts.mode ?? "single", createdAt: now(), updatedAt: now(),
  });
  return taskId;
}

/** 一次正在进行的审查（默认第 1 轮）。 */
export async function reviewInFlight(
  taskId: string, runId: string, opts: { round?: number; live?: boolean } = {},
): Promise<void> {
  await db.insert(schema.freeReviewRuns).values({
    id: runId, taskId, reviewerName: "审查者", agentType: "codex", checkMode: "logic",
    status: "reviewing", currentRound: opts.round ?? 1, createdAt: now(), updatedAt: now(),
  });
  if (opts.live !== false) {
    await db.insert(sessions).values({
      id: `s-${runId}`, taskId, role: "reviewer", agentType: "codex", executor: "审查者",
      cwd: root, startedAt: now(), agentPid: process.pid,
      agentStartedAt: inspectProcess(process.pid)?.startedAt ?? null,
    });
  }
}

/**
 * 直接插一条哨兵行。
 *
 * 用在「创建方已经在锁里登记成功」这个时刻上 —— 真正的 `startMonitor` 会去抢同一把
 * `task:<id>` 锁，在测试里拿着锁调它就是自锁，所以这里用一条等价的行站它的位。
 */
export async function insertMonitorRow(
  taskId: string,
  // `unitToken` 要跟那个进程**真的带着的那条记号**一致(生产里它在起进程之前就随意图行落库,
  // 并作为 `ASH_MONITOR_UNIT` 种进环境,见 proc.ts 的 `processUnitEvidence`):给对了就是
  // 「归属已证明」的现场,不给或给错就是「证不出归属」的现场 —— 后者只许记责任、不许下刀。
  // `command` 只进日志和存量行的时间锚核对,**不是归属凭证**。
  opts: {
    reviewRun?: string; round?: number; status?: string; pid?: number; pidStartedAt?: string | null;
    command?: string; unitToken?: string | null;
  } = {},
): Promise<string> {
  const id = uniq("mon");
  await db.insert(monitors).values({
    id, taskId, command: opts.command ?? "sleep 120", description: "站位", cwd: root,
    status: opts.status ?? "running", pid: opts.pid ?? null, pidStartedAt: opts.pidStartedAt ?? null,
    logPath: `${root}/${id}.log`, offset: 0, events: 0, exitCode: null,
    startedAt: now(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    endedAt: null, endedReason: null, ownerUserId: null, kind: "ash",
    nativeId: null, cliSessionId: null, toolUseId: null, sourceRun: null, startLowAt: null,
    sourceRole: "reviewer", sourceReviewRun: opts.reviewRun ?? null,
    sourceReviewRound: opts.round ?? null, sourceLifetime: "bounded", lifetimeEvidence: "self",
    sourcePid: null, sourcePidStartedAt: null, startEvidence: "observed",
    startAnchorWidthMs: 0, timeoutMs: 600_000,
    unitToken: opts.unitToken ?? null,
  });
  return id;
}

export const pendingOf = (taskId: string) =>
  db.select().from(scheduledMessages).where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));

/** 收尾：哨兵全撒手（不杀——它们本来就该活过 ash）、放锁、删临时目录。 */
export async function teardown(): Promise<void> {
  detachAllMonitors();
  // 待恢复账本的退避定时器是 unref 过的（不会拖住进程），但留着会在后续用例里继续重试
  // 刷日志——注入过读写失败的用例必然留下几条账。
  stopAllMonitorRecovery();
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
