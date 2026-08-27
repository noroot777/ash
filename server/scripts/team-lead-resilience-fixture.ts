// 常驻调度台:写库失败 / 事件流被掀翻,都不能让这台调度台留下假状态。
//
// 起因(2026-08-25 第 2、3 轮审查)。团队链的写库全都跑在 consume 的 for-await 里,所以
// 这一带的坏法都不是「一个回合失败」,而是**内存、数据库和落盘产物各说各话**:
//   ① endTurn 的 sessions 更新一抛 → writeTurnEnd / flushSessionNotices / 落 idle /
//      closeLead 全跳过:.md 里没有轮换旁注、任务永远 running、leads 里留着一台没人
//      消费事件的假在线调度台(后续消息照送进去,一个字都不落盘)。
//   ② 新会话凭据写库失败后不重试 → 内存 id 已换、库里还是空的。进程一回收或 server
//      一重启就只能 fresh,刚建立的上下文无提示丢失。
//   ③ 事件流在 poisoned 之后抛错 → 收尾要是写死「用同一条会话接回」,就跟刚落盘的
//      「这条会话已作废」正面矛盾;而且从没收到过 done,却把 exit 0 记进库。
//
// 所以这里不是结构 grep,而是**真的让写库失败 / 真的掀翻事件流**(SQLite 触发器
// RAISE(ABORT)、iterator 抛异常),再从落盘的 .md、库里的行和 leads 在线判定上验。
//
// 跑:npm -w server run test:team-resilience
import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import type { ResidentHandle } from "../src/executors/types.js";

const root = mkdtempSync(join(tmpdir(), "ash-team-resilience-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_TEAM_IDLE_MS = "0"; // 别在测试里挂一个 30 分钟的回收计时
process.env.ASH_TEAM_STATUS_RETRY_MS = "40"; // 状态重试:别让测试干等 5 秒

// 真机 Codex stderr:同一条 thread 已经 poisoned,恢复它只会一次次撞同一堵墙。
const POISON = "ignored world-state patch without a full snapshot";

// env 要在这些模块被求值之前定好(db/paths 在模块顶层就读它们),所以走动态 import。
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { attachLead, haltTeam, sendInbound, teamIsLive } = await import("../src/team/session.js");
const { bus } = await import("../src/bus.js");
const { pendingInbound } = await import("../src/team/inbound-queue.js");
const { SESSION_POISONED_NOTE } = await import("../src/executors/session-lost.js");
const { eq } = await import("drizzle-orm");

const at = "2026-08-25T00:00:00.000Z";
const ok = (m: string) => console.log("   ✓ " + m);

// 让 sessions 的 UPDATE **真的**失败,tasks 照常可写 —— 这样才分得清「哪一行写不进去」
// 和「整个库挂了」,复现的正是审查里那条路径。
const breakSessionWrites = () =>
  dbClient.executeMultiple(
    "CREATE TRIGGER injected_sessions_failure BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'injected sessions failure'); END;",
  );
const healSessionWrites = () => dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_sessions_failure;");
// 只让 tasks 的状态更新失败(sessions 照常可写)—— 复现「回合已经收了、库里还写着 running」。
const breakTaskWrites = () =>
  dbClient.executeMultiple(
    "CREATE TRIGGER injected_tasks_failure BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'injected idle status failure'); END;",
  );
const healTaskWrites = () => dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_tasks_failure;");
// 只让持久待送队列的 INSERT 失败 —— 复现「执行者汇报连排队都排不进去」。
const breakInboundWrites = () =>
  dbClient.executeMultiple(
    "CREATE TRIGGER injected_inbound_failure BEFORE INSERT ON team_inbound BEGIN SELECT RAISE(ABORT, 'injected team_inbound failure'); END;",
  );
const healInboundWrites = () => dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_inbound_failure;");

interface Scenario {
  /** 这台调度台开台时手上那条 CLI 会话 id(同时写进库)。 */
  cliSessionId: string;
  /** 按 consume 的消费节奏一条条放事件;generator 只有在上一条处理完才恢复执行, */
  /** 所以「装/拆故障」写在 yield 之间,天然排在前一条事件处理完之后。 */
  script: () => AsyncGenerator<AgentEvent>;
  /** events 流**还在线**时要断言的事(由 script 自己用 promise 卡住时机)。 */
  whileLive?: (taskId: string) => Promise<void>;
}

/** 组装一台调度台并挂上线。返回它的 handle 计数,方便断言「有没有往进程里塞过话」。 */
async function startLead(opts: {
  taskId: string;
  sessId: string;
  cliSessionId: string;
  events: AsyncGenerator<AgentEvent>;
  /** 复用一条已有的会话行(openLead 的 resuming 分支就是这么干的),而不是新插一行。 */
  reuse?: boolean;
  /** 覆盖 handle 的收件行为:返回 false = 明确拒收,抛错 = 进程已经不可写。缺省全收。 */
  send?: (text: string) => boolean;
}) {
  const row = {
    cliSessionId: opts.cliSessionId || null,
    resumeCommand: opts.cliSessionId ? `codex exec resume ${opts.cliSessionId}` : null,
    turnStartedAt: at,
    endedAt: null,
    exitStatus: null,
  };
  if (opts.reuse) await db.update(sessions).set(row).where(eq(sessions.id, opts.sessId));
  else {
    await db.insert(sessions).values({
      id: opts.sessId,
      taskId: opts.taskId,
      role: "lead",
      agentType: "codex",
      executor: "codex@test",
      cwd: root,
      startedAt: at,
      activeMs: 0,
      ...row,
    });
  }
  const runDir = join(root, "runs", opts.taskId);
  mkdirSync(runDir, { recursive: true });
  let sent = 0;
  let killed = 0;
  attachLead({
    taskId: opts.taskId,
    sessId: opts.sessId,
    cliSessionId: opts.cliSessionId,
    agentType: "codex",
    executorId: null,
    model: null,
    reasoningEffort: null,
    cwd: root,
    handle: {
      sessionId: opts.cliSessionId,
      commandLine: `codex exec resume ${opts.cliSessionId}`,
      events: opts.events,
      send: (text: string) => {
        sent++; // 计的是**尝试**次数,拒收/抛错也算 —— 断言要分得清「没试」和「试了没进去」
        return opts.send ? opts.send(text) : true;
      },
      interrupt: () => {},
      dropSession: () => {},
      close: () => {},
      kill: () => { killed++; },
    },
    out: createWriteStream(join(runDir, `${opts.sessId}.md`), { flags: "a" }),
    busy: true,
    turnStart: at,
    pending: [],
    notices: [],
    pendingCredential: null,
    wantedStatus: null,
    statusTimer: null,
    retired: false,
    idleTimer: null,
    closing: null,
  });
  return {
    runDir,
    sent: () => sent,
    killed: () => killed,
  };
}

/** 建一条 mode:"team" 的任务行(状态 running,回合进行中)。 */
async function seedTeamTask(taskId: string) {
  await db.insert(tasks).values({
    id: taskId,
    projectId: "project",
    title: "调度台",
    body: "带一队人干活",
    mode: "team",
    status: "running", // 回合进行中
    team: JSON.stringify({ lead: "codex", worker: "codex" }),
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: "codex",
    autoTitle: false,
    createdAt: at,
    updatedAt: at,
  });
}

/** 起一台真的调度台,喂完 script 里的事件,等它自己收完台。 */
async function runLead(name: string, s: Scenario) {
  const taskId = `task-${name}`;
  const sessId = `sess-${name}`;
  await seedTeamTask(taskId);
  const { runDir, sent, killed } = await startLead({
    taskId,
    sessId,
    cliSessionId: s.cliSessionId,
    events: s.script(),
  });

  const deadline = Date.now() + 15_000;
  if (s.whileLive) await s.whileLive(taskId);
  while (teamIsLive(taskId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    teamIsLive(taskId),
    false,
    `${name}:收尾没跑完,leads 里还挂着这台调度台 —— 后续消息会被送进一个没人听的 handle`,
  );
  // .md 走 WriteStream,end() 之后才保证落到磁盘;上面等的是 leads 摘牌,这里再等正文。
  const mdPath = join(runDir, `${sessId}.md`);
  const readMd = () => { try { return readFileSync(mdPath, "utf8"); } catch { return ""; } };
  while (!readMd() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));

  return {
    md: readMd(),
    trace: (() => { try { return readFileSync(join(runDir, `${sessId}.trace.jsonl`), "utf8"); } catch { return ""; } })(),
    task: async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!,
    session: async () => (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!,
    sent,
    killed,
  };
}

export {
  POISON,
  root,
  db,
  dbClient,
  ensureSchema,
  projects,
  sessions,
  tasks,
  haltTeam,
  sendInbound,
  teamIsLive,
  bus,
  pendingInbound,
  SESSION_POISONED_NOTE,
  eq,
  at,
  ok,
  breakSessionWrites,
  healSessionWrites,
  breakTaskWrites,
  healTaskWrites,
  breakInboundWrites,
  healInboundWrites,
  startLead,
  seedTeamTask,
  runLead,
};
